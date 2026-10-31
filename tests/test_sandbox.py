# -*- coding: utf-8 -*-
"""沙箱服务测试（v1.6）：真实 Windows Job Object 行为验证。

覆盖：配置/档位解析、无竞业收编执行、退出码、超时清剿整树、KILL_ON_JOB_CLOSE、
内存限制、进程数限制、CPU 时间限制、UI 限制、fail-closed、cmd_service 集成。
非 Windows 环境整体跳过（Job Object 仅 Windows 可用）。
"""
import ctypes
import json
import os
import subprocess
import sys
import time

import pytest

from backend.domains.workspace import sandbox_service as sb
from backend.domains.workspace.cmd_service import CmdService
from backend.domains.workspace.sandbox_service import (
    SandboxService, SandboxUnavailable, create_job, run_in_sandbox)
from backend.domains.workspace.toolcache_service import ToolcacheService

pytestmark = pytest.mark.skipif(not hasattr(ctypes, 'windll'),
                                reason='沙箱仅支持 Windows（Job Object）')

STD = {'memory_mb': 1024, 'max_processes': 8, 'cpu_seconds': 120,
       'ui_restrict': 'basic'}

_SYNCHRONIZE = 0x00100000
_QUERY_INFO = 0x0400


# ---------------- 进程存活探针（无第三方依赖，纯 Win32） ----------------
def _proc_alive(pid):
    k32 = ctypes.windll.kernel32
    h = k32.OpenProcess(_QUERY_INFO | _SYNCHRONIZE, False, int(pid))
    if not h:
        return False
    try:
        return k32.WaitForSingleObject(h, 0) == 0x00000102   # WAIT_TIMEOUT=存活
    finally:
        k32.CloseHandle(h)


def _wait_dead(pid, timeout=5):
    """等待进程退出；返回 True=已死（含进程不存在）。"""
    k32 = ctypes.windll.kernel32
    h = k32.OpenProcess(_QUERY_INFO | _SYNCHRONIZE, False, int(pid))
    if not h:
        return True
    try:
        return k32.WaitForSingleObject(h, int(timeout * 1000)) != 0x00000102
    finally:
        k32.CloseHandle(h)


def _spawn_attached(job, argv):
    """白盒助手：挂起态创建进程 → 收编 job → 恢复。返回 pid。"""
    k32 = ctypes.windll.kernel32
    sb._declare_win32()
    app, cmdline = sb._build_cmdline(argv, shell=False)
    si = sb._STARTUPINFOW()
    si.cb = ctypes.sizeof(si)
    pi = sb._PROCESS_INFORMATION()
    buf = ctypes.create_unicode_buffer(cmdline)
    ok = k32.CreateProcessW(app, buf, None, None, False,
                            sb.CREATE_SUSPENDED | sb.CREATE_NO_WINDOW,
                            None, None, ctypes.byref(si), ctypes.byref(pi))
    assert ok, 'CreateProcessW 失败: %d' % ctypes.get_last_error()
    try:
        job.assign_process(pi.hProcess)
        assert k32.ResumeThread(pi.hThread) != 0xFFFFFFFF
        return pi.dwProcessId
    finally:
        k32.CloseHandle(pi.hThread)
        k32.CloseHandle(pi.hProcess)


# ================= 配置与档位 =================
class TestConfig:
    def test_defaults(self):
        svc = SandboxService()
        cfg = json.loads(svc.get_config())
        assert cfg['enabled'] is True
        assert cfg['command_profiles']['run_command'] == 'standard'
        assert cfg['command_profiles']['run_powershell'] == 'standard'
        assert cfg['command_profiles']['run_admin_command'] == 'off'
        assert cfg['limits']['standard']['memory_mb'] == 1024

    def test_limits_for_profiles(self):
        svc = SandboxService()
        lim = svc.limits_for('run_command')
        assert lim and lim['memory_mb'] == 1024
        assert svc.limits_for('run_admin_command') is None    # admin 恒不沙箱
        assert svc.save_config(json.dumps({'command_profiles': {'run_command': 'off'}}))
        assert svc.limits_for('run_command') is None
        assert svc.save_config(json.dumps({'enabled': False}))
        assert svc.limits_for('run_powershell') is None       # 总开关关闭

    def test_save_roundtrip_and_clamp(self):
        svc = SandboxService()
        assert svc.save_config(json.dumps({
            'limits': {'standard': {'memory_mb': 999999, 'max_processes': 3,
                                    'cpu_seconds': 30, 'ui_restrict': 'strict'}}}))
        lim = svc.limits_for('run_command')
        assert lim['memory_mb'] == 100000     # 上限钳制
        assert lim['max_processes'] == 3
        assert lim['ui_restrict'] == 'strict'
        # 新实例读盘一致（独立文件持久化）
        assert SandboxService().limits_for('run_command')['max_processes'] == 3

    def test_save_rejects_garbage(self):
        svc = SandboxService()
        r = svc.save_config('{不是合法 JSON')
        assert 'error' in json.loads(r)
        # 坏输入不改动既有配置
        assert json.loads(svc.get_config())['enabled'] is True

    def test_status_shape(self):
        st = json.loads(SandboxService().status())
        assert st['available'] is True
        assert st['platform'] == 'nt'
        assert st['enabled'] is True
        assert 'jobs_created' in st['stats']


# ================= 核心执行 =================
class TestRunInSandbox:
    def test_basic_and_exit_code(self):
        r = run_in_sandbox([sys.executable, '-c',
                            'import sys; print("sb-out"); sys.exit(3)'],
                           timeout=30, limits=STD)
        assert r.sandboxed is True
        assert r.returncode == 3
        assert b'sb-out' in r.stdout
        assert r.timed_out is False

    def test_shell_true_cmdline(self):
        r = run_in_sandbox('echo shell-mode-ok & exit /b 0', shell=True,
                           timeout=30, limits=STD)
        assert r.returncode == 0
        assert b'shell-mode-ok' in r.stdout

    def test_cwd_applied(self):
        r = run_in_sandbox([sys.executable, '-c',
                            'import os; print(os.getcwd())'],
                           cwd=os.environ.get('TEMP', '/tmp'), timeout=30,
                           limits=STD)
        assert r.returncode == 0
        assert os.environ.get('TEMP', '/tmp').lower().encode() in r.stdout.lower()

    def test_stderr_captured(self):
        r = run_in_sandbox([sys.executable, '-c',
                            'import sys; sys.stderr.write("sb-err")'],
                           timeout=30, limits=STD)
        assert b'sb-err' in r.stderr

    def test_timeout_kills_whole_tree(self):
        """超时必须清剿整棵树——孙进程不能活（S11 taskkill /T 的内核级替代）。"""
        pid_file = os.path.join(os.environ['TEMP'], 'sb_grandchild_%d.pid' % os.getpid())
        parent = ('import subprocess,sys,time;'
                  'p=subprocess.Popen([sys.executable,"-c","import time; time.sleep(300)"]);'
                  'open(%r,"w").write(str(p.pid));'
                  'time.sleep(300)') % pid_file
        t0 = time.time()
        r = run_in_sandbox([sys.executable, '-c', parent], timeout=2,
                           limits={'memory_mb': 512, 'max_processes': 8,
                                   'cpu_seconds': 600, 'ui_restrict': 'basic'})
        elapsed = time.time() - t0
        assert r.timed_out is True
        assert elapsed < 15, '超时清剿应秒级完成，实际 %.1fs' % elapsed
        try:
            with open(pid_file) as f:
                gpid = int(f.read().strip())
        finally:
            try:
                os.remove(pid_file)
            except OSError:
                pass
        assert _wait_dead(gpid, 5), '孙进程在 job 清剿后仍然存活（逃逸）'

    def test_invalid_command_clear_error(self):
        with pytest.raises(SandboxUnavailable) as ei:
            run_in_sandbox(['sb_no_such_program_xyz.exe'], timeout=10, limits=STD)
        assert 'CreateProcessW' in str(ei.value)


# ================= 隔离与限制机制 =================
class TestJobMechanisms:
    def test_kill_on_job_close(self):
        """job 句柄关闭（不显式 terminate）→ KILL_ON_JOB_CLOSE 清剿残留。"""
        job = create_job({'memory_mb': 256, 'max_processes': 4, 'cpu_seconds': 60,
                          'ui_restrict': 'basic'})
        pid = _spawn_attached(job, [sys.executable, '-c',
                                    'import time; time.sleep(120)'])
        time.sleep(0.5)
        assert _proc_alive(pid)
        job.close()   # 不 terminate——全靠 KILL_ON_JOB_CLOSE
        assert _wait_dead(pid, 5), '关闭 job 句柄未清剿子进程'

    def test_terminate_kills_tree(self):
        job = create_job({'memory_mb': 256, 'max_processes': 4, 'cpu_seconds': 60,
                          'ui_restrict': 'basic'})
        pid = _spawn_attached(job, [sys.executable, '-c',
                                    'import time; time.sleep(120)'])
        time.sleep(0.3)
        job.terminate()
        assert _wait_dead(pid, 5)
        st = job.stats()
        assert st is not None and st['total_processes'] >= 1
        job.close()

    def test_memory_limit_enforced(self):
        """per-process commit 限制：分配超限必须失败（禁止打印 ALLOC_OK）。"""
        child = ('import sys\n'
                 'chunks = []\n'
                 'try:\n'
                 '    for i in range(8):\n'
                 '        chunks.append(bytearray(50 * 1024 * 1024))\n'
                 '    print("ALLOC_OK")\n'
                 'except MemoryError:\n'
                 '    print("ALLOC_BLOCKED")\n')
        r = run_in_sandbox([sys.executable, '-c', child], timeout=60,
                           limits={'memory_mb': 200, 'max_processes': 4,
                                   'cpu_seconds': 60, 'ui_restrict': 'basic'})
        assert b'ALLOC_OK' not in r.stdout, '200MB 限制下竟分配满 400MB'

    def test_process_count_limit(self):
        """活跃进程数上限：超过后 CreateProcess 在沙箱内失败（WinError 1816）。

        自适应断言：不同环境的 python 每次 Popen 入 job 的进程数不同
        （本机 venv python 是启动器，一次 Popen = 2 进程），故不断言
        「第几个失败」，只断言「有成功也有失败」——限制机制生效即可。
        """
        child = ('import subprocess, sys\n'
                 'out = []\n'
                 'for i in range(6):\n'
                 '    try:\n'
                 '        p = subprocess.Popen([sys.executable, "-c",\n'
                 '            "import time; time.sleep(20)"])\n'
                 '        out.append("ok%d" % i)\n'
                 '    except Exception:\n'
                 '        out.append("fail%d" % i)\n'
                 'print(";".join(out))\n')
        r = run_in_sandbox([sys.executable, '-c', child], timeout=30,
                           limits={'memory_mb': 512, 'max_processes': 3,
                                   'cpu_seconds': 60, 'ui_restrict': 'basic'})
        out = r.stdout.decode('utf-8', 'replace')
        assert 'ok0' in out, '限额内应有子进程成功: %r' % out
        assert 'fail' in out, '超限额后应有子进程被拒: %r' % out

    def test_cpu_time_limit(self):
        """per-job CPU 时间：烧 CPU 的死循环到点被清剿。"""
        child = ('import time\n'
                 't = time.time()\n'
                 'x = 0\n'
                 'while time.time() - t < 60:\n'
                 '    x += 1\n')
        t0 = time.time()
        r = run_in_sandbox([sys.executable, '-c', child], timeout=60,
                           limits={'memory_mb': 512, 'max_processes': 4,
                                   'cpu_seconds': 1, 'ui_restrict': 'basic'})
        elapsed = time.time() - t0
        assert elapsed < 15, 'CPU 限制应在 ~1s 生效，实际 %.1fs' % elapsed
        assert r.returncode != 0, '被 CPU 限制清剿的进程不应是 0 退出'

    def test_ui_restrictions_accepted(self):
        """basic/strict UI 限制都能被系统接受（不支持时降级不炸）。"""
        for level in ('basic', 'strict', 'none'):
            job = create_job({'memory_mb': 256, 'max_processes': 4,
                              'cpu_seconds': 30, 'ui_restrict': level})
            pid = _spawn_attached(job, [sys.executable, '-c', 'print(1)'])
            assert _wait_dead(pid, 10)
            job.close()


# ================= fail-closed 与集成 =================
class _WsStub:
    def effective_root(self, sid):
        return os.environ.get('TEMP', os.getcwd())


class TestFailClosedAndIntegration:
    def test_fail_closed_when_job_creation_fails(self, monkeypatch):
        """沙箱启用但 Job 创建失败 → 抛 SandboxUnavailable，绝不裸跑。"""
        def boom(limits, logger=None):
            raise SandboxUnavailable('模拟创建失败')
        monkeypatch.setattr(sb, 'create_job', boom)
        with pytest.raises(SandboxUnavailable):
            run_in_sandbox([sys.executable, '-c', 'print(1)'], limits=STD)

    def test_cmd_service_sandboxed_echo(self):
        cmd = CmdService(_WsStub(), ToolcacheService())
        data = json.loads(cmd.run_command('sid', 'echo cmd-sandbox-ok', sandbox=STD))
        assert 'error' not in data, data
        assert 'cmd-sandbox-ok' in data['output']
        assert data['exit_code'] == 0

    def test_cmd_service_sandbox_fail_closed(self, monkeypatch):
        """集成层 fail-closed：沙箱不可用 → err 返回，命令不执行。"""
        def boom(limits, logger=None):
            raise SandboxUnavailable('模拟收编失败')
        monkeypatch.setattr(sb, 'create_job', boom)
        cmd = CmdService(_WsStub(), ToolcacheService())
        r = json.loads(cmd.run_command('sid', 'echo should-not-run', sandbox=STD))
        assert 'error' in r
        assert '沙箱' in r['error']
        assert 'fail-closed' in r['error']

    def test_cmd_service_sandbox_timeout(self):
        cmd = CmdService(_WsStub(), ToolcacheService())
        r = json.loads(cmd.run_command(
            'sid', 'python -c "import time; time.sleep(30)"', timeout=5,
            sandbox={'memory_mb': 512, 'max_processes': 4, 'cpu_seconds': 600,
                     'ui_restrict': 'basic'}))
        assert 'error' in r and '超时' in r['error']

    def test_cmd_service_no_sandbox_path_unchanged(self):
        """不传 sandbox → 原生 subprocess 路径（Popen+communicate 捕获字节）。"""
        cmd = CmdService(_WsStub(), ToolcacheService())
        r = json.loads(cmd.run_command('sid', 'echo plain-path-ok'))
        assert 'error' not in r, r
        assert 'plain-path-ok' in r['output']

    def test_dedup_still_applies_under_sandbox(self):
        """沙箱不绕过去重（安全层层叠，不互相拆台）。"""
        cmd = CmdService(_WsStub(), ToolcacheService())
        r1 = json.loads(cmd.run_command('sid', 'echo dedup-sb', sandbox=STD))
        r2 = json.loads(cmd.run_command('sid', 'echo dedup-sb', sandbox=STD))
        assert 'dedup-sb' in r1.get('output', '')
        assert r2.get('skipped') is True


# ================= 非 Windows 行为（仅文档性，本机跳过） =================
def test_module_importable_everywhere():
    """模块在任意平台可 import（Windows API 调用时才要求 windll）。"""
    import importlib
    importlib.reload(sb)
    assert sb.DEFAULT_CONFIG['enabled'] is True
