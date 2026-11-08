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
    """legacy 条目进 `legacy:` 命名空间；**不触发扩展注入段**（契约零漂移）。"""
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
        assert mm.conn.execute(
            "SELECT COUNT(*) c FROM fact_records WHERE attribute='legacy_note'"
            " AND is_current=1").fetchone()['c'] == 1
    # 全部是 legacy → 扩展段必须为空（对既有用户 build_system_prompt 零变化）
    assert svc.extras_block('local', 'legacy') == ''


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
            "SELECT COUNT(*) c FROM fact_records WHERE attribute='legacy_note'"
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


def test_container_and_v12_registration():
    """容器装配 + API_ALIASES + _V12_EXTRA 登记（get_api_info 隐身铁律）。"""
    from backend.bootstrap.container import ServiceContainer
    c = ServiceContainer.build()
    assert c.memory_db is not None
    assert c.api_aliases().get('_memory_db') is c.memory_db
    c.shutdown()
    from backend.api import _V12_EXTRA
    for m in ('memory_context_build', 'memory_remember', 'memory_erase',
              'memory_stats', 'memory_audit_query'):
        assert m in _V12_EXTRA, m
