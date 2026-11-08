# -*- coding: utf-8 -*-
"""R38 记忆模块 v2 接入门禁（R36 开发文档 §8；legacy 契约零漂移验证）。

覆盖：引擎可用性/迁移导入/legacy 删除传播/写入门控/扩展注入段零漂移/
软擦除与统计/WAL/容器与 _V12_EXTRA 登记。
"""
import json

import pytest

from backend import paths
from backend.domains.memory.db_service import MemoryDbService


@pytest.fixture()
def mem_env(tmp_path, monkeypatch):
    """隔离环境：memory.json / memory.db 都指向 tmp；返回 (service, json_path)。"""
    json_path = tmp_path / 'memory.json'
    json_path.write_text('[]', encoding='utf-8')
    monkeypatch.setattr(paths, 'MEMORY_PATH', str(json_path))
    monkeypatch.setattr(paths, 'MEMORY_DB_PATH', str(tmp_path / 'memory.db'))
    svc = MemoryDbService()
    return svc, json_path


def _write_legacy(json_path, entries):
    json_path.write_text(json.dumps(entries, ensure_ascii=False), encoding='utf-8')


def test_engine_available_and_wal(mem_env):
    svc, _ = mem_env
    mm = svc._engine()
    assert mm is not None and svc.enabled
    assert svc.stats()['enabled'] is True
    assert svc.stats()['journal'] == 'wal'
    assert svc.stats()['integrity'] is True


def test_migration_import_and_extras_zero_drift(mem_env):
    """legacy 条目进 `legacy:` 命名空间；**不触发扩展注入段**（契约零漂移）。

    R39-D1 断言更新：原断言 `attribute='legacy_note'` 恰 1 条 current——
    钉住的是折叠缺陷（多条 fact 类记忆同 attribute 互相 supersede 只剩最后
    一条，Node/Python 双端实证）。现 attribute 带文本指纹，逐条并存。"""
    svc, jp = mem_env
    _write_legacy(jp, [
        {'text': '以后都先写测试再写实现', 'kind': 'rule', 'ts': '01-01 10:00'},
        {'text': '我喜欢简洁的回复', 'kind': 'preference', 'ts': '01-01 10:01'},
        {'text': '部署脚本在 D:\\deploy\\ship.ps1', 'kind': 'fact', 'ts': '01-01 10:02'},
    ])
    mm = svc.ensure_synced()
    assert mm is not None
    with mm.conn:
        assert mm.conn.execute(
            "SELECT COUNT(*) c FROM profile_kv WHERE key LIKE 'legacy:%'"
        ).fetchone()['c'] == 2
        # 1 条 fact 类 legacy 记忆 → 1 条 current（前缀命名空间）
        assert mm.conn.execute(
            "SELECT COUNT(*) c FROM fact_records WHERE attribute LIKE 'legacy_note:%'"
            " AND is_current=1").fetchone()['c'] == 1
    # 全部是 legacy → 扩展段必须为空（对既有用户 build_system_prompt 零变化）
    assert svc.extras_block('local', 'legacy') == ''


def test_legacy_multi_note_no_supersede(mem_env):
    """R39-D1：多条 fact 类 legacy 记忆迁移后逐条并存（原实现折叠只剩最后一条）。"""
    svc, jp = mem_env
    _write_legacy(jp, [
        {'text': '部署脚本在 D:\\deploy\\ship.ps1', 'kind': 'fact', 'ts': '01-01 10:00'},
        {'text': '数据备份在 E:\\bak', 'kind': 'fact', 'ts': '01-01 10:01'},
        {'text': '发布前先跑 tests/', 'kind': 'fact', 'ts': '01-01 10:02'},
    ])
    svc.ensure_synced()
    entries = svc.list_entries('local')
    facts = [e for e in entries if e['kind'] == 'fact']
    assert len(facts) == 3
    texts = {e['text'] for e in facts}
    assert '部署脚本在 D:\\deploy\\ship.ps1' in texts
    assert all(e['readonly'] for e in facts)      # legacy 条目只读（删除走 legacy 面板）


def test_legacy_delete_propagates(mem_env):
    svc, jp = mem_env
    _write_legacy(jp, [
        {'text': '第一条', 'kind': 'fact', 'ts': '01-01 10:00'},
        {'text': '第二条', 'kind': 'fact', 'ts': '01-01 10:01'},
    ])
    svc.ensure_synced()
    _write_legacy(jp, [{'text': '第一条', 'kind': 'fact', 'ts': '01-01 10:00'}])
    svc.ensure_synced()          # 指纹变化 → 重建
    mm = svc._mm
    with mm.conn:
        assert mm.conn.execute(
            "SELECT COUNT(*) c FROM fact_records WHERE attribute LIKE 'legacy_note:%'"
            " AND is_current=1").fetchone()['c'] == 1


def test_remember_gate_rejects_sensitive(mem_env):
    svc, _ = mem_env
    r = svc.remember('s1', 'local', '我的api_key是 sk-abcdef1234567890abcd')
    assert r['action'] == 'rejected' and r['reason'].startswith('sensitive')


def test_remember_new_memory_enables_extras(mem_env):
    """用户新写入（非 legacy 命名空间）→ 扩展段出现且含结构化事实。"""
    svc, _ = mem_env
    svc.remember('s1', 'local', '用户居住地是北京', attribute='residence')
    out = svc.extras_block('local', 'legacy')
    assert '【长期记忆·扩展】' in out and '[事实:residence]' in out
    # legacy 空时扩展段独立成立（不依赖 legacy 注入段）
    assert '【长期记忆】' not in out    # 不含 legacy 段头（形异不打架）


def test_erase_soft_scrubs_and_stats(mem_env):
    svc, _ = mem_env
    # 注意：手机号会被 v2 写入门控按设计拒收（OWASP 敏感字段拦截）——
    # scrub 用例改用非敏感标记。
    svc.remember('s1', 'local', '备用暗号 BLUE-77', attribute='contact')
    ctx = svc.context('local', 's1')
    assert any('BLUE-77' in str(v) for v in (ctx['current_facts'] or {}).values())
    r = svc.erase('local', attribute='contact', value='BLUE-77')
    assert r['ok'] and not r['hard']
    ctx2 = svc.context('local', 's1')
    assert 'BLUE-77' not in json.dumps(ctx2, ensure_ascii=False)
    # 事实层的 scrub 语义=整键排除（profile/摘要/窗口为字面值 ▇ 替换）
    assert 'contact' not in (ctx2['current_facts'] or {})
    st = svc.stats()
    assert st['enabled'] and st['integrity'] is True


def test_hard_erase_tombstone(mem_env):
    svc, _ = mem_env
    svc.remember('s1', 'local', '用户居住地是上海', attribute='residence')
    counts = svc.erase('local', hard=True)
    assert counts['ok'] and counts['counts']['facts'] >= 1
    st = svc.stats()
    assert st['integrity'] is True        # 墓碑事件不断哈希链


def test_entries_pin_erase_and_extras_priority(mem_env):
    """R39 面板逐条能力：list_entries 视图 / 钉选注入置前 / 单条擦除。"""
    svc, _ = mem_env
    # R40-D2 回归锁：attribute 用反字母序（z/a）——原实现按字母序恰好把
    # backup 排前使断言巧合通过，fact 钉选实际完全无效（键域 fact_id≠attribute）
    svc.remember('s1', 'local', '部署脚本在 D 盘 deploy 目录', attribute='z_deploy')
    svc.remember('s1', 'local', '数据备份在 E 盘 bak 目录', attribute='a_backup')
    entries = svc.list_entries('local')
    facts = [e for e in entries if e['kind'] == 'fact']
    assert len(facts) == 2 and not any(e['pinned'] for e in facts)
    assert all(e['source'] == 'session' for e in facts)
    # 未钉选：注入段按 attribute 字母序 → backup（a_*）在前
    out0 = svc.extras_block('local', 's1')
    assert '【长期记忆·扩展】' in out0
    assert out0.index('备份') < out0.index('部署')
    # 钉选 deploy → 注入段置前（R40-D2 修复生效）+ 视图标位 + 审计不断链
    fid = [e for e in facts if '部署' in e['text']][0]['id']
    assert svc.pin('local', 'fact', fid, True)['ok']
    entries = svc.list_entries('local')
    f = [e for e in entries if e['kind'] == 'fact' and e['id'] == fid][0]
    assert f['pinned'] is True
    out = svc.extras_block('local', 's1')
    assert out.index('部署') < out.index('备份'), out
    assert svc.stats()['integrity'] is True
    # R40-4：full 派生视图（memory_context_build 面）同样钉选置前
    ctx = svc.context('local', 's1')
    keys = list((ctx.get('current_facts') or {}).keys())
    assert keys[0] == 'z_deploy', keys
    # 单条软关闭：视图消失 + 其余保留 + 审计不断链
    assert svc.erase_entry('local', 'fact', fid)['ok']
    entries = svc.list_entries('local')
    assert [e for e in entries if e['kind'] == 'fact' and e['id'] == fid] == []
    assert len([e for e in entries if e['kind'] == 'fact']) == 1
    assert svc.stats()['integrity'] is True
    # profile 擦除 + not_found/bad_kind 边界（preference 句式 → 画像层）
    svc.remember('s1', 'local', '我喜欢简洁的回复')
    prof = [e for e in svc.list_entries('local') if e['kind'] == 'profile']
    assert prof and svc.erase_entry('local', 'profile', prof[0]['id'])['ok']
    assert svc.erase_entry('local', 'profile', prof[0]['id'])['reason'] == 'not_found'
    assert svc.erase_entry('local', 'widget', 'x')['reason'] == 'bad_kind'


def test_api_entries_surface_and_mirror(fresh_home, tmp_path, monkeypatch):
    """R39：Api 面 3 个新 js_api + append_memory 镜像修复（多条 note 不再 supersede）。"""
    from backend import paths
    from backend.api import Api
    monkeypatch.setattr(paths, 'MEMORY_DB_PATH', str(tmp_path / 'memory.db'))
    api = Api()
    # 多条 fact 类 legacy 写入 → 逐条镜像（R39-D1 修复：原实现只留最后一条）
    api.append_memory(json.dumps({'text': '部署脚本在 D 盘'}))
    api.append_memory(json.dumps({'text': '备份在 E 盘'}))
    r = json.loads(api.memory_entries_list())
    assert r['enabled'] is True
    texts = [e['text'] for e in r['entries'] if e['kind'] == 'fact']
    assert any('部署脚本' in t for t in texts), texts
    assert any('备份' in t for t in texts), texts
    facts = [e for e in r['entries'] if e['kind'] == 'fact']
    assert all(e['readonly'] for e in facts)     # legacy 条目只读
    # 用户直写（非 legacy）→ 可钉选可删；legacy/未知 kind 拒绝
    json.loads(api.memory_remember('测试输出目录在 F 盘'))
    mine = [e for e in json.loads(api.memory_entries_list())['entries']
            if e['kind'] == 'fact' and not e['readonly']]
    assert mine, '用户直写条目应存在且可管理'
    fid = mine[0]['id']
    assert json.loads(api.memory_entry_pin('fact', fid, True))['ok']
    assert json.loads(api.memory_entry_erase('fact', fid))['ok']
    r3 = json.loads(api.memory_entries_list())
    assert not [e for e in r3['entries'] if e['id'] == fid]
    bad = json.loads(api.memory_entry_erase('legacy', 'x'))
    assert bad['ok'] is False and bad['error']['code'] == 'BAD_PARAMS'


def test_container_and_v12_registration():
    """容器装配 + API_ALIASES + _V12_EXTRA 登记（get_api_info 隐身铁律）。"""
    from backend.bootstrap.container import ServiceContainer
    c = ServiceContainer.build()
    assert c.memory_db is not None
    assert c.api_aliases().get('_memory_db') is c.memory_db
    c.shutdown()
    from backend.api import _V12_EXTRA
    for m in ('memory_context_build', 'memory_remember', 'memory_erase',
              'memory_stats', 'memory_audit_query',
              'memory_entries_list', 'memory_entry_erase', 'memory_entry_pin'):
        assert m in _V12_EXTRA, m
