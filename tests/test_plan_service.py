# -*- coding: utf-8 -*-
"""v1.8.0 M3 域·plan_service 单测（计划 CRUD / 检查点 / 回滚 / 澄清）。

fixture 驱动：临时目录造假工作区 + 假文件；git 锚点用真实 git init
（环境无 git 时相关用例 skip——本机已装 git，正常路径全绿）。
"""
import json
import os
import subprocess

import pytest

from backend.domains.planning.plan_service import PlanService, CKPT_MAX_FILES


@pytest.fixture
def svc(fresh_home):
    return PlanService()


@pytest.fixture
def ws(tmp_path, monkeypatch):
    # Keep non-git workspace tests isolated when basetemp is inside this repo.
    monkeypatch.setenv('GIT_CEILING_DIRECTORIES', str(tmp_path))
    d = tmp_path / 'ws'
    d.mkdir()
    (d / 'a.txt').write_text('A-original', encoding='utf-8')
    (d / 'sub').mkdir()
    (d / 'sub' / 'b.md').write_text('B-original', encoding='utf-8')
    return str(d)


def _plan_payload():
    return {
        'title': '测试计划',
        'steps': [
            {'text': '读文件', 'risk': ''},
            {'text': '写文件', 'risk': 'l2'},
            {'text': '删除系统路径', 'risk': 'l0'},
        ],
    }


# ---------------- 计划 CRUD ----------------

def test_create_get_update(svc):
    r = svc.create('测试计划', _plan_payload()['steps'])
    assert r['ok'], r
    tid = r['task_id']
    g = svc.get(tid)
    assert g['ok'] and g['plan']['status'] == 'planning'
    assert len(g['plan']['steps']) == 3
    u = svc.update(tid, status='approved')
    assert u['ok'] and u['plan']['status'] == 'approved'
    u2 = svc.update(tid, step_index=1, step_status='done')
    assert u2['ok'] and u2['plan']['steps'][1]['status'] == 'done'
    bad = svc.update(tid, step_index=99, step_status='done')
    assert not bad['ok'] and '越界' in bad['error']


def test_create_rejects_empty(svc):
    r = svc.create('空', [])
    assert not r['ok']


def test_get_missing(svc):
    r = svc.get('nope')
    assert not r['ok']


def test_list_recent_first(svc):
    svc.create('T1', ['s1'])
    import time
    time.sleep(0.01)
    svc.create('T2', ['s2'])
    lst = svc.list()
    assert lst['ok'] and len(lst['plans']) >= 2
    assert lst['plans'][0]['title'] == 'T2'


def test_steps_accept_plain_strings(svc):
    r = svc.create('简写', ['步骤一', '步骤二'])
    assert r['ok'] and r['plan']['steps'][0]['text'] == '步骤一'


# ---------------- 检查点：非 git 快照 ----------------

def test_checkpoint_snapshot_and_rollback(svc, ws):
    r = svc.create('计划', _plan_payload()['steps'])
    tid = r['task_id']
    c = svc.checkpoint_create(tid, ['a.txt', 'sub/b.md'], ws)
    assert c['ok'] and c['mode'] == 'snapshot' and c['snapshot_count'] == 2, c
    # 改动文件
    with open(os.path.join(ws, 'a.txt'), 'w', encoding='utf-8') as f:
        f.write('A-modified')
    rb = svc.checkpoint_rollback(tid, ws, confirm=True)  # v1.9 ⑤ 确认后端化
    assert rb['ok'] and rb['mode'] == 'snapshot'
    assert set(rb['restored']) == {'a.txt', 'sub/b.md'}
    with open(os.path.join(ws, 'a.txt'), encoding='utf-8') as f:
        assert f.read() == 'A-original'
    # 当前版有 .rollback-bak 备份
    assert os.path.exists(os.path.join(ws, 'a.txt.rollback-bak'))


def test_checkpoint_skips_missing_and_outside(svc, ws, tmp_path):
    r = svc.create('计划', ['s'])
    tid = r['task_id']
    c = svc.checkpoint_create(tid, ['a.txt', 'ghost.txt', '../outside.txt'], ws)
    assert c['ok']
    warns = ' '.join(c['warnings'])
    assert 'ghost.txt' in warns and 'outside.txt' in warns


def test_checkpoint_list(svc, ws):
    r = svc.create('计划', ['s'])
    tid = r['task_id']
    svc.checkpoint_create(tid, ['a.txt'], ws)
    lst = svc.checkpoint_list(tid)
    assert lst['ok'] and len(lst['files']) == 1 and lst['files'][0]['path'] == 'a.txt'


def test_checkpoint_max_files_cap(svc, ws):
    # 造 CKPT_MAX_FILES+2 个小文件 → 超限降级（仅记录清单）+ warn
    for i in range(CKPT_MAX_FILES + 2):
        with open(os.path.join(ws, 'f%04d.txt' % i), 'w', encoding='utf-8') as f:
            f.write('x')
    r = svc.create('计划', ['s'])
    tid = r['task_id']
    files = ['f%04d.txt' % i for i in range(CKPT_MAX_FILES + 2)]
    c = svc.checkpoint_create(tid, files, ws)
    assert c['ok'] and c['snapshot_count'] == CKPT_MAX_FILES
    assert any('上限' in w for w in c['warnings'])


# ---------------- 检查点：git 锚点 ----------------

def _git_init(ws):
    subprocess.run(['git', 'init'], cwd=ws, capture_output=True)
    subprocess.run(['git', 'config', 'user.email', 't@t'], cwd=ws, capture_output=True)
    subprocess.run(['git', 'config', 'user.name', 't'], cwd=ws, capture_output=True)
    subprocess.run(['git', 'add', '-A'], cwd=ws, capture_output=True)
    subprocess.run(['git', 'commit', '-m', 'init'], cwd=ws, capture_output=True)


def test_checkpoint_git_head_and_rollback(svc, ws):
    if subprocess.run(['git', '--version'], capture_output=True).returncode != 0:
        pytest.skip('git 不可用')
    _git_init(ws)
    r = svc.create('计划', _plan_payload()['steps'])
    tid = r['task_id']
    c = svc.checkpoint_create(tid, ['a.txt'], ws)
    assert c['ok'] and c['mode'] == 'git' and c['git_head'], c
    with open(os.path.join(ws, 'a.txt'), 'w', encoding='utf-8') as f:
        f.write('A-after-commit')
    rb = svc.checkpoint_rollback(tid, ws, confirm=True)  # v1.9 ⑤ 确认后端化
    assert rb['ok'] and rb['mode'] == 'git'
    with open(os.path.join(ws, 'a.txt'), encoding='utf-8') as f:
        assert f.read() == 'A-original'


def test_checkpoint_git_rollback_tracks_absent_and_preserves_current(svc, ws):
    """回滚后新增修改与新建文件都不能无声丢失：先备份当前版；
    创建时不存在的声明文件应回到“不存在”，未声明文件保持不动。"""
    if subprocess.run(['git', '--version'], capture_output=True).returncode != 0:
        pytest.skip('git 不可用')
    _git_init(ws)
    tid = svc.create('计划', ['s'])['task_id']
    c = svc.checkpoint_create(tid, ['a.txt', 'new.txt'], ws)
    assert c['ok'] and c['mode'] == 'git'
    with open(os.path.join(ws, 'a.txt'), 'w', encoding='utf-8') as f:
        f.write('A-after-commit')
    with open(os.path.join(ws, 'new.txt'), 'w', encoding='utf-8') as f:
        f.write('created-later')
    with open(os.path.join(ws, 'other.txt'), 'w', encoding='utf-8') as f:
        f.write('untouched')
    rb = svc.checkpoint_rollback(tid, ws, confirm=True)
    assert rb['ok'] and rb['mode'] == 'git', rb
    assert open(os.path.join(ws, 'a.txt'), encoding='utf-8').read() == 'A-original'
    assert not os.path.exists(os.path.join(ws, 'new.txt'))
    assert open(os.path.join(ws, 'other.txt'), encoding='utf-8').read() == 'untouched'
    assert open(os.path.join(ws, 'a.txt.rollback-bak'), encoding='utf-8').read() == 'A-after-commit'
    assert open(os.path.join(ws, 'new.txt.rollback-bak'), encoding='utf-8').read() == 'created-later'


def test_checkpoint_git_backup_failure_aborts_restore(svc, ws, monkeypatch):
    """备份失败必须中止该文件恢复，禁止在无法保全当前版时继续 checkout。"""
    if subprocess.run(['git', '--version'], capture_output=True).returncode != 0:
        pytest.skip('git 不可用')
    _git_init(ws)
    tid = svc.create('计划', ['s'])['task_id']
    assert svc.checkpoint_create(tid, ['a.txt'], ws)['ok']
    with open(os.path.join(ws, 'a.txt'), 'w', encoding='utf-8') as f:
        f.write('A-must-survive')
    checkout_calls = []
    real_run = subprocess.run

    def _tracked_run(args, **kw):
        if list(args)[:1] == ['git', 'checkout']:
            checkout_calls.append(args)
        return real_run(args, **kw)

    monkeypatch.setattr(subprocess, 'run', _tracked_run)
    monkeypatch.setattr('backend.domains.planning.checkpoint_service.shutil.copy2',
                        lambda *a, **k: (_ for _ in ()).throw(OSError('backup denied')))
    rb = svc.checkpoint_rollback(tid, ws, confirm=True)
    assert rb['ok'] is False and rb['failed']
    assert checkout_calls == []
    assert open(os.path.join(ws, 'a.txt'), encoding='utf-8').read() == 'A-must-survive'


# ---------------- 澄清 ----------------

def test_clarify_collect_defaults_and_answers(svc):
    qs = [
        {'q': '语言？', 'options': ['中文', '英文'], 'default': 0},
        {'q': '范围？', 'options': ['全部', '部分'], 'default': 1},
    ]
    r = svc.clarify_collect(qs, {})
    assert r['ok']
    assert r['resolved'][0]['answer'] == '中文'   # 默认
    assert r['resolved'][1]['answer'] == '部分'   # 默认
    r2 = svc.clarify_collect(qs, {'0': 1})
    assert r2['resolved'][0]['answer'] == '英文'
    r3 = svc.clarify_collect(qs, {'1': 99})   # 越界回退默认
    assert r3['resolved'][1]['answer'] == '部分'


def test_clarify_plain_string_questions(svc):
    r = svc.clarify_collect(['要我做什么？'], {})
    assert r['ok'] and r['resolved'][0]['q'] == '要我做什么？'


# ---------------- 检查点保留策略（方案 §6.5：保留最近 3 份） ----------------

def test_checkpoint_keeps_latest_three(svc, ws):
    from backend.domains.planning.plan_service import _ckpts_dir
    import time as _t
    for i in range(5):
        r = svc.create('计划%d' % i, ['s'])
        c = svc.checkpoint_create(r['task_id'], ['a.txt'], ws)
        assert c['ok'], c
        _t.sleep(0.02)   # created_at 毫秒级确保排序稳定
    d = _ckpts_dir()
    left = [n for n in os.listdir(d) if os.path.isfile(os.path.join(d, n, 'manifest.json'))]
    assert len(left) == 3, '应保留 3 份，实际 %d' % len(left)


def test_checkpoint_prune_reported(svc, ws):
    import time as _t
    last = None
    for i in range(4):
        r = svc.create('P%d' % i, ['s'])
        last = svc.checkpoint_create(r['task_id'], ['a.txt'], ws)
        _t.sleep(0.02)
    assert last['ok'] and last.get('pruned'), '第 4 份创建应报告轮换清理'
    assert any('轮换清理' in w for w in last['warnings'])


# ---------------- 对抗性复审回归（第六轮） ----------------

def test_rollback_without_ws_dir_uses_manifest_ws(svc, ws, tmp_path, monkeypatch):
    """回滚调用不传 ws_dir（前端 67-plan-card 即如此）→ 必须用 manifest 里
    创建时记录的 ws_dir，不得回落 os.getcwd()（源码运行时 cwd=项目仓库，
    回落会把 git reset --hard / 快照恢复打到应用自身目录）。"""
    r = svc.create('R', ['s'])
    tid = r['task_id']
    c = svc.checkpoint_create(tid, ['a.txt'], ws)
    assert c['ok'], c
    with open(os.path.join(ws, 'a.txt'), 'w', encoding='utf-8') as f:
        f.write('A-modified')
    elsewhere = tmp_path / 'elsewhere'
    elsewhere.mkdir()
    monkeypatch.chdir(str(elsewhere))     # cwd ≠ ws；回归时文件会落这里
    rb = svc.checkpoint_rollback(tid, confirm=True)  # 不传 ws_dir（回落 manifest）
    assert rb['ok'] and rb['mode'] == 'snapshot', rb
    assert set(rb['restored']) == {'a.txt'}, rb
    with open(os.path.join(ws, 'a.txt'), encoding='utf-8') as f:
        assert f.read() == 'A-original'      # 恢复到原工作区
    assert not os.path.exists(os.path.join(str(elsewhere), 'a.txt')), \
        '不得在 cwd 下落恢复文件（manifest ws_dir 优先）'


def test_rollback_git_failure_shape(svc, ws, monkeypatch):
    """git reset 失败 → {ok: False, mode: 'git', restored[], failed[非空]}，
    不得误落 snapshot 分支、不得抛异常（A4 形状，api 层据此透传）。"""
    if subprocess.run(['git', '--version'], capture_output=True).returncode != 0:
        pytest.skip('git 不可用')
    _git_init(ws)
    r = svc.create('G', ['s'])
    tid = r['task_id']
    c = svc.checkpoint_create(tid, ['a.txt'], ws)
    assert c['ok'] and c['mode'] == 'git', c

    class _Fail(object):
        returncode = 128
        stdout = b''
        stderr = b'fatal: unknown revision'

    _orig = subprocess.run

    def _fake(args, **kw):
        # v1.9 ① 差异恢复：git checkout 取代 reset --hard（patch 点随迁）
        if isinstance(args, list) and args[:2] == ['git', 'checkout']:
            return _Fail()
        return _orig(args, **kw)

    monkeypatch.setattr('subprocess.run', _fake)
    try:
        rb = svc.checkpoint_rollback(tid, ws, confirm=True)  # v1.9 ⑤ 确认后端化
    finally:
        monkeypatch.undo()
    assert rb.get('ok') is False and rb.get('mode') == 'git', rb
    assert rb.get('failed') and 'a.txt' in rb['failed'][0], rb
    assert rb.get('restored') == [], rb


def test_api_rollback_git_failure_not_flattened(svc, ws, monkeypatch):
    """api.checkpoint_rollback 对 git 失败形状必须透传 restored/failed——
    原实现 err() 拍平成 {'error': '回滚失败'}，前端只读 failed[] 会把空数组
    误判为「回滚完成」假成功 toast。"""
    from conftest import NewApi
    if subprocess.run(['git', '--version'], capture_output=True).returncode != 0:
        pytest.skip('git 不可用')
    _git_init(ws)
    r = svc.create('AG', ['s'])
    tid = r['task_id']
    c = svc.checkpoint_create(tid, ['a.txt'], ws)
    assert c['ok'] and c['mode'] == 'git', c

    class _Fail(object):
        returncode = 1
        stdout = b''
        stderr = b'fatal: Needed a single revision'

    _orig = subprocess.run

    def _fake(args, **kw):
        # v1.9 ① 差异恢复：git checkout 取代 reset --hard（patch 点随迁）
        if isinstance(args, list) and args[:2] == ['git', 'checkout']:
            return _Fail()
        return _orig(args, **kw)

    monkeypatch.setattr('subprocess.run', _fake)
    monkeypatch.setattr(os, 'startfile', lambda p: None)
    try:
        api = NewApi()
    finally:
        monkeypatch.undo()
    monkeypatch.setattr('subprocess.run', _fake)
    try:
        raw = api.checkpoint_rollback(tid, confirm=True)  # 不传 ws_dir（前端口径）
    finally:
        monkeypatch.undo()
    d = json.loads(raw)
    assert d.get('mode') == 'git', d
    assert d.get('failed') and 'a.txt' in d['failed'][0], d  # v1.9 checkout
    assert d.get('failed'), d   # 富形状不得被拍平成纯 error
