# -*- coding: utf-8 -*-
"""T9 沙箱真机冒烟（v1.6 方案 §3 T9 六步）：真实 Windows Job Object 执行，非 mock。

六步与方案 §3 T9 一一对应：
1. echo 正常：真实 js_api 路径 Api.run_command → sandbox 执行，
   成功退出 + 输出正确 + runs_sandboxed 计数 +1；
2. 超时清剿：短超时跑「父进程起孙进程再长睡」→ 到点被清剿、
   孙进程同剿 + runs_sandboxed/runs_failed_closed 计数正确；
3. fail-closed 拒绝：create_job 测试钩子抛 SandboxUnavailable →
   执行被阻止并返回人话错误（不静默裸跑）+ runs_failed_closed +1；
4. 审计可见：guard_check/guard_audit/后端强制 block 三条路径落
   audit_log.jsonl，条目含 op/action/decision/时间戳；
5. 切档位生效：sandbox_save_config 把 run_command 从 standard 切 strict
   → 新限制真实生效（strict 256MB 档拦 400MB 分配，standard 1024MB 档放行）；
6. 非 Windows 降级：子进程 del ctypes.windll 模拟非 Windows →
   available()=False + 人话报错（代码级）；前端 39-sandbox.js /
   index.template.html 非 Windows 明示分支代码级验证
   （真机无法切 OS，标注「代码级通过，真机待目标机」）。

隔离：conftest 已将 HOME/USERPROFILE 重定向到临时目录，本文件所有
配置/审计副作用只落在临时 HOME 内；测试内快照-恢复 sandbox.json /
guard.json / audit_log.jsonl，不碰真实 ~/.glm-chat。
"""
import ctypes
import json
import os
import subprocess
import sys
import time

import pytest

from backend.domains.workspace import sandbox_service as sb
from helpers.frontend import read_frontend_source

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

pytestmark = pytest.mark.skipif(not hasattr(ctypes, 'windll'),
                                reason='T9 冒烟需要真实 Windows Job Object')

_WAIT_TIMEOUT = 0x00000102
_QUERY_SYNCHRONIZE = 0x0400 | 0x00100000


@pytest.fixture
def api():
    from backend.api import Api
    return Api()


# ---------------- 助手 ----------------
def _stats(api):
    return json.loads(api.sandbox_status())['stats']


def _read_bytes(path):
    try:
        with open(path, 'rb') as f:
            return f.read()
    except OSError:
        return None


def _restore(path, data):
    """按快照恢复文件；快照为 None（原本不存在）则删除。"""
    if data is None:
        try:
            os.remove(path)
        except OSError:
            pass
    else:
        with open(path, 'wb') as f:
            f.write(data)


def _proc_dead(pid, timeout=8):
    """等待进程退出；已不存在/已退出返回 True。"""
    k32 = ctypes.windll.kernel32
    h = k32.OpenProcess(_QUERY_SYNCHRONIZE, False, int(pid))
    if not h:
        return True
    try:
        return k32.WaitForSingleObject(h, int(timeout * 1000)) != _WAIT_TIMEOUT
    finally:
        k32.CloseHandle(h)


def _alloc_cmd(mb, tag):
    """分配 mb MB 内存的命令（tag 用于去重键区分，stdout 打标）。"""
    code = ("import sys; c = bytearray(%d * 1024 * 1024); "
            "print('ALLOC_OK-%s')" % (mb, tag))
    return 'python -c "%s"' % code


def _stdout_part(r):
    """cmd_service 把 stderr 并入 output（'\\n[stderr] ' 前缀）；
    MemoryError 回溯会回显源码行，判定分配成功只能看 stdout 段。"""
    return (r.get('output') or '').split('[stderr]')[0]


# ---------------- 步骤 1：echo 正常 ----------------
def test_step1_echo_normal(api):
    st0 = _stats(api)
    marker = 't9-smoke-ok-%d' % int(time.time() * 1000)
    r = json.loads(api.run_command('echo %s' % marker))
    assert 'error' not in r, r
    assert marker in r.get('output', ''), r
    assert r.get('exit_code') == 0, r
    st1 = _stats(api)
    assert st1['runs_sandboxed'] == st0['runs_sandboxed'] + 1, (st0, st1)
    assert st1['runs_failed_closed'] == st0['runs_failed_closed'], (st0, st1)
    assert st1['jobs_created'] == st0['jobs_created'] + 1, (st0, st1)


# ---------------- 步骤 2：超时清剿（含孙进程） ----------------
def test_step2_timeout_kills_whole_tree(api):
    st0 = _stats(api)
    pid_file = os.path.join(os.environ.get('TEMP', '.'),
                            't9_grandchild_%d.pid' % os.getpid())
    parent = ("import subprocess, time; "
              "p = subprocess.Popen(['python', '-c', "
              "'import time; time.sleep(300)']); "
              "open(r'%s', 'w').write(str(p.pid)); time.sleep(300)" % pid_file)
    try:
        r = json.loads(api.run_command('python -c "%s"' % parent, timeout=5))
        assert 'error' in r, r
        assert '超时' in r['error'], r
        assert 'should-not-run' not in r.get('output', '')
        # 孙进程必须同剿（TerminateJobObject 内核级清剿整树）
        try:
            with open(pid_file, encoding='utf-8') as f:
                gpid = int(f.read().strip())
        except OSError:
            gpid = None
        assert gpid, '孙进程 pid 文件未生成（父进程未按预期启动）'
        assert _proc_dead(gpid, 8), '孙进程在超时清剿后仍存活（逃逸）'
        st1 = _stats(api)
        assert st1['runs_sandboxed'] == st0['runs_sandboxed'] + 1, (st0, st1)
        assert st1['runs_failed_closed'] == st0['runs_failed_closed'], (st0, st1)
    finally:
        try:
            os.remove(pid_file)
        except OSError:
            pass


# ---------------- 步骤 3：fail-closed 拒绝路径 ----------------
def test_step3_fail_closed_rejection(api, monkeypatch):
    st0 = _stats(api)

    def boom(limits, logger=None):
        # 用 sb.SandboxUnavailable 属性查找（调用时求值）而非模块级 import——
        # test_sandbox.py 末测试 importlib.reload(sb) 会重绑定类对象，
        # 旧类实例不被 reload 后的 except 子句匹配（顺序依赖坑）。
        raise sb.SandboxUnavailable('T9 模拟收编失败（测试钩子）')

    monkeypatch.setattr(sb, 'create_job', boom)
    r = json.loads(api.run_command('echo t9-should-not-run-%d'
                                   % int(time.time() * 1000)))
    assert 'error' in r, r
    assert '沙箱' in r['error'] and 'fail-closed' in r['error'], r
    assert 'should-not-run' not in json.dumps(r, ensure_ascii=False), r
    st1 = _stats(api)
    # 工程师已按本观察项修复（sandbox_service.py:514-519）：create_job 失败
    # 现在也计入 runs_failed_closed（原在主 try 外不递增，T6 面板统计缺口）；
    # 阻断语义不变——此处同时锁定修复后的统计口径。
    assert st1['runs_failed_closed'] == st0['runs_failed_closed'] + 1, (st0, st1)
    assert st1['runs_sandboxed'] == st0['runs_sandboxed'], (st0, st1)


# ---------------- 步骤 4：审计可见 ----------------
def test_step4_audit_visible(api):
    from backend import paths
    audit_path = os.path.join(paths.CONFIG_DIR, 'audit_log.jsonl')
    guard_path = os.path.join(paths.CONFIG_DIR, 'guard.json')
    snap_audit = _read_bytes(audit_path)
    snap_guard = _read_bytes(guard_path)

    def _entries(blob):
        return [json.loads(ln) for ln in
                (blob or b'').decode('utf-8', 'replace').splitlines() if ln.strip()]

    try:
        # 4a 判定可见：guard_check allow 条目（ok() 仅序列化 payload，无 ok 键）
        r = json.loads(api.guard_check(
            'run_command', json.dumps({'cmd': 'T9-AUDIT-CHECK'})))
        assert r.get('action') == 'allow', r
        # 4b 用户决策可见：guard_audit decision 条目
        api.guard_audit('run_command',
                        json.dumps({'cmd': 'T9-AUDIT-DECISION'}), 'allow')
        # 4c 后端强制阻断可见：always 档 + 武装 + 无 token → block 条目
        api._guard.save_config(json.dumps({'tiers': {'run_command': 'always'}}))
        api._guard.arm()
        r2 = json.loads(api.run_command('echo t9-audit-block-%d'
                                        % int(time.time() * 1000)))
        assert 'error' in r2, r2
        assert '确认' in r2['error'], r2

        new_entries = _entries(_read_bytes(audit_path))[len(_entries(snap_audit)):]
        assert len(new_entries) >= 3, new_entries
        for e in new_entries:
            assert e.get('ts') and e.get('op') == 'run_command', e
        actions = [e.get('action') for e in new_entries]
        assert 'allow' in actions, new_entries
        assert 'decision' in actions, new_entries
        assert 'block' in actions, new_entries
        block = [e for e in new_entries if e.get('action') == 'block']
        assert block[0].get('decision') == 'backend-enforced', block
        assert 't9-audit-block' in json.dumps(block[0], ensure_ascii=False), block
    finally:
        _restore(audit_path, snap_audit)
        _restore(guard_path, snap_guard)


# ---------------- 步骤 5：切档位生效 ----------------
def test_step5_profile_switch_takes_effect(api):
    base = {
        'command_profiles': {'run_command': 'standard',
                             'run_powershell': 'standard',
                             'run_admin_command': 'off'},
        'limits': {
            'standard': {'memory_mb': 1024, 'max_processes': 16,
                         'cpu_seconds': 120, 'ui_restrict': 'basic'},
            'strict': {'memory_mb': 256, 'max_processes': 8,
                       'cpu_seconds': 60, 'ui_restrict': 'strict'},
        },
    }
    # 5a standard（1024MB）：400MB 分配放行
    assert json.loads(api.sandbox_save_config(json.dumps(base))) == {'ok': True}
    got = json.loads(api.sandbox_get_config())
    assert got['command_profiles']['run_command'] == 'standard'
    assert got['limits']['standard']['memory_mb'] == 1024
    r = json.loads(api.run_command(_alloc_cmd(400, 'std')))
    assert 'error' not in r, r
    assert r.get('exit_code') == 0, r
    assert 'ALLOC_OK-std' in _stdout_part(r), r
    # 5b 切 strict（256MB）：同一 400MB 分配被拦（新限制真实生效）
    switched = json.loads(json.dumps(base))
    switched['command_profiles']['run_command'] = 'strict'
    assert json.loads(api.sandbox_save_config(json.dumps(switched))) == {'ok': True}
    got2 = json.loads(api.sandbox_get_config())
    assert got2['command_profiles']['run_command'] == 'strict'
    assert got2['limits']['strict']['memory_mb'] == 256
    lim = api._sandbox.limits_for('run_command')
    assert lim and lim['memory_mb'] == 256
    r2 = json.loads(api.run_command(_alloc_cmd(400, 'strict')))
    assert 'ALLOC_OK-strict' not in _stdout_part(r2), r2
    assert r2.get('exit_code') != 0, r2
    assert 'MemoryError' in r2.get('output', ''), r2


# ---------------- 步骤 6a：非 Windows 降级（代码级，子进程模拟） ----------------
def test_step6a_non_windows_degradation_code_path():
    code = (
        "import ctypes, json, sys\n"
        "sys.path.insert(0, %r)\n"
        "del ctypes.windll\n"
        "from backend.domains.workspace import sandbox_service as sb\n"
        "out = {}\n"
        "out['available'] = sb.SandboxService().available()\n"
        "try:\n"
        "    sb.create_job({'memory_mb': 64})\n"
        "    out['create_job'] = 'NO-RAISE'\n"
        "except sb.SandboxUnavailable as e:\n"
        "    out['create_job'] = str(e)\n"
        "try:\n"
        "    sb.run_in_sandbox(['echo', 'x'], limits={'memory_mb': 64})\n"
        "    out['run_in_sandbox'] = 'NO-RAISE'\n"
        "except sb.SandboxUnavailable as e:\n"
        "    out['run_in_sandbox'] = str(e)\n"
        "print('T9RESULT:' + json.dumps(out, ensure_ascii=False))\n"
    ) % PROJECT_ROOT
    r = subprocess.run([sys.executable, '-c', code], capture_output=True,
                       timeout=120)
    lines = [ln for ln in r.stdout.decode('utf-8', 'replace').splitlines()
             if ln.startswith('T9RESULT:')]
    assert lines, (r.stdout, r.stderr)
    out = json.loads(lines[-1][len('T9RESULT:'):])
    assert out['available'] is False, out
    assert out['create_job'] != 'NO-RAISE', out
    assert '非 Windows' in out['create_job'], out
    assert out['run_in_sandbox'] != 'NO-RAISE', out
    assert '非 Windows' in out['run_in_sandbox'], out


# ---------------- 步骤 6b：前端非 Windows 明示（代码级） ----------------
def test_step6b_frontend_non_windows_notice():
    src = read_frontend_source(PROJECT_ROOT, '39-sandbox.js')
    # 非 Windows：明示不可用而非空白（status.available=false 分支）
    assert 'st.available' in src
    assert '不支持 Job Object 沙箱' in src
    assert 'sandboxUnavailable' in src
    # UI→js_api 通路
    for m in ('sandbox_get_config', 'sandbox_save_config', 'sandbox_status'):
        assert ("callApi('%s'" % m) in src or ('callApi("%s"' % m) in src, m
    # 后端三个 js_api 在 _V12_EXTRA 隐身清单（契约零漂移）
    with open(os.path.join(PROJECT_ROOT, 'backend', 'api.py'),
              encoding='utf-8') as f:
        api_src = f.read()
    for m in ('sandbox_get_config', 'sandbox_save_config', 'sandbox_status'):
        assert ("'%s'" % m) in api_src, m
    # 模板不可用提示块与文案
    with open(os.path.join(PROJECT_ROOT, 'frontend', 'index.template.html'),
              encoding='utf-8') as f:
        tpl = f.read()
    assert 'id="sandboxUnavailable"' in tpl
    assert '不支持 Job Object' in tpl
