# -*- coding: utf-8 -*-
"""命令沙箱服务（v1.6 安全增强）：Windows Job Object 进程隔离 + 资源限制。

设计依据：deliverables/dev-plan/sandbox-architecture-2026-10-19.md

隔离与限制能力矩阵（诚实边界，勿在文档外夸大）：
- 进程隔离：每次命令执行一个独立 Job，收编整棵进程树（孙进程自动入 job）；
  不设 BREAKAWAY_OK → 子进程 CREATE_BREAKAWAY_FROM_JOB 必败；
  KILL_ON_JOB_CLOSE → job 句柄关闭即全树清剿（防孤儿）。
- 无竞业创建：CreateProcessW(CREATE_SUSPENDED) → AssignProcessToJobObject
  → ResumeThread。**不用「Popen 后 assign」**——那有毫秒级竞态，
  恶意命令可在 assign 前 fork 出 job 外孙进程（逃逸窗口）。
- 资源限制：内存（per-process + per-job commit 双限）、活跃进程数、
  per-job CPU 时间（100ns 单位）。
- UI 限制：basic = DESKTOP|EXITWINDOWS（防切桌面伪造 UAC 提示框 / 防关机重启）；
  strict 追加 GLOBALATOMS|HANDLES（已知可能破坏部分运行时，默认不开）。
- **不覆盖**（详见文档风险矩阵）：网络隔离（零依赖 + 无管理员前提下不可达，
  由 guard 审计与防火墙助手脚本补位）；剪贴板隔离（Job 无此 UI 限制，
  由 guard 三档确认兜底）；提权进程收编（run_admin_command 的中型父进程
  无法 assign 高完整性子进程，admin 通道显式排除沙箱）。

配置：~/.glm-chat/sandbox.json（独立文件，不碰 config.json——契约红线）。
fail-closed 语义：沙箱启用但收编失败 → 阻止执行并明示，不静默降级裸跑
（对齐 v1.3.1 S19 fail-closed 哲学）。
"""
import ctypes
import json
import os
import subprocess
import threading
import time

from ... import paths
from ...fio import atomic_write_json
from ...logging_setup import get_logger

# ---------------- Win32 常量 ----------------
JOB_OBJECT_ALL_ACCESS = 0x1F001F
PROCESS_SET_QUOTA = 0x0100
PROCESS_TERMINATE = 0x0001
PROCESS_QUERY_INFORMATION = 0x0400

CREATE_SUSPENDED = 0x00000004
CREATE_NO_WINDOW = 0x08000000
STARTF_USESTDHANDLES = 0x00000100
STARTF_USESHOWWINDOW = 0x00000001
SW_HIDE = 0
HANDLE_FLAG_INHERIT = 0x00000001
WAIT_TIMEOUT = 0x00000102
WAIT_OBJECT_0 = 0x00000000
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value

# Job 限制位
JOB_OBJECT_LIMIT_PROCESS_TIME = 0x00000002
JOB_OBJECT_LIMIT_JOB_TIME = 0x00000004
JOB_OBJECT_LIMIT_ACTIVE_PROCESS_NUMBER = 0x00000008
JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100
JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000

# Job UI 限制位（winnt.h JOBOBJECT_UILIMIT）
JOB_OBJECT_UILIMIT_DESKTOP = 0x00000001
JOB_OBJECT_UILIMIT_EXITWINDOWS = 0x00000004
JOB_OBJECT_UILIMIT_GLOBALATOMS = 0x00000008
JOB_OBJECT_UILIMIT_HANDLES = 0x00000010

# 信息类
JobObjectBasicAccountingInformation = 1
JobObjectBasicUIRestrictions = 4
JobObjectExtendedLimitInformation = 9

MB = 1024 * 1024
_CPU_TICK = 10 ** 7   # 1 秒 = 10^7 个 100ns 单位

# 进程级统计（status() 上报；模块级而非实例级——执行入口是模块函数）
_STATS_LOCK = threading.Lock()
_STATS = {'jobs_created': 0, 'runs_sandboxed': 0, 'runs_failed_closed': 0}

SANDBOX_FILE = os.path.join(paths.CONFIG_DIR, 'sandbox.json')

# 命令类别 → 默认档位。run_admin_command 恒 off：提权子进程无法被中型
# 父进程 assign 进 job（完整性级别不匹配），强行支持只会制造假安全感。
_COMMAND_CLASSES = ('run_command', 'run_powershell', 'run_admin_command')
_PROFILES = ('off', 'standard', 'strict')

DEFAULT_CONFIG = {
    'enabled': True,
    'command_profiles': {
        'run_command': 'standard',
        'run_powershell': 'standard',
        'run_admin_command': 'off',
    },
    'limits': {
        # max_processes 注意：ActiveProcessLimit 按 job 内进程数计，而某些
        # 环境的 python.exe 是启动器（每次 Popen 实际 2 个进程入 job），
        # 且 npm/msbuild 等构建树本身可开十余个进程——standard 给 16 留头，
        # 进程数限制是纵深防御而非主控（主控是内存/CPU/时间限制 + R4 熔断）。
        'standard': {'memory_mb': 1024, 'max_processes': 16, 'cpu_seconds': 120,
                     'ui_restrict': 'basic'},
        'strict': {'memory_mb': 512, 'max_processes': 8, 'cpu_seconds': 60,
                   'ui_restrict': 'strict'},
    },
}

_UI_LEVELS = {
    'none': 0,
    'basic': JOB_OBJECT_UILIMIT_DESKTOP | JOB_OBJECT_UILIMIT_EXITWINDOWS,
    'strict': (JOB_OBJECT_UILIMIT_DESKTOP | JOB_OBJECT_UILIMIT_EXITWINDOWS
               | JOB_OBJECT_UILIMIT_GLOBALATOMS | JOB_OBJECT_UILIMIT_HANDLES),
    # R23 实测结论（2026-10-21，tests/test_r23_clipboard_flag.py）：
    # JOB_OBJECT_UILIMIT_READCLIPBOARD/WRITECLIPBOARD 在 Win11 交互桌面实测
    # **无效**（子进程 OpenClipboard 全部成功）——strict 档刻意不加剪贴板
    # Flag（加了是安慰剂，还给人「已隔离」的虚假安全感）。剪贴板隔离缺口
    # 由 guard 应用层兜底，记录见 KNOWN_ISSUES §17。
}


class SandboxUnavailable(Exception):
    """沙箱不可用（创建/收编失败）。fail-closed：调用方应阻止执行而非裸跑。"""


# ---------------- ctypes 结构（对齐 MSDN jobapi.h） ----------------
class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ('PerProcessUserTimeLimit', ctypes.c_longlong),
        ('PerJobUserTimeLimit', ctypes.c_longlong),
        ('LimitFlags', ctypes.c_ulong),
        ('MinimumWorkingSetSize', ctypes.c_size_t),
        ('MaximumWorkingSetSize', ctypes.c_size_t),
        ('ActiveProcessLimit', ctypes.c_ulong),
        ('Affinity', ctypes.c_size_t),
        ('PriorityClass', ctypes.c_ulong),
        ('SchedulingClass', ctypes.c_ulong),
    ]


class _IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ('ReadOperationCount', ctypes.c_ulonglong),
        ('WriteOperationCount', ctypes.c_ulonglong),
        ('OtherOperationCount', ctypes.c_ulonglong),
        ('ReadTransferCount', ctypes.c_ulonglong),
        ('WriteTransferCount', ctypes.c_ulonglong),
        ('OtherTransferCount', ctypes.c_ulonglong),
    ]


class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ('BasicLimitInformation', _JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ('IoInfo', _IO_COUNTERS),
        ('ProcessMemoryLimit', ctypes.c_size_t),
        ('JobMemoryLimit', ctypes.c_size_t),
        ('PeakProcessMemoryUsed', ctypes.c_size_t),
        ('PeakJobMemoryUsed', ctypes.c_size_t),
    ]


class _JOBOBJECT_BASIC_UI_RESTRICTIONS(ctypes.Structure):
    _fields_ = [('UIRestrictionsClass', ctypes.c_ulong)]


class _JOBOBJECT_BASIC_ACCOUNTING_INFORMATION(ctypes.Structure):
    _fields_ = [
        ('TotalUserTime', ctypes.c_longlong),
        ('TotalKernelTime', ctypes.c_longlong),
        ('ThisPeriodTotalUserTime', ctypes.c_longlong),
        ('ThisPeriodTotalKernelTime', ctypes.c_longlong),
        ('TotalPageFaultCount', ctypes.c_ulong),
        ('TotalProcesses', ctypes.c_ulong),
        ('ActiveProcesses', ctypes.c_ulong),
        ('TotalTerminatedProcesses', ctypes.c_ulong),
    ]


class _STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ('cb', ctypes.c_ulong),
        ('lpReserved', ctypes.c_wchar_p),
        ('lpDesktop', ctypes.c_wchar_p),
        ('lpTitle', ctypes.c_wchar_p),
        ('dwX', ctypes.c_ulong),
        ('dwY', ctypes.c_ulong),
        ('dwXSize', ctypes.c_ulong),
        ('dwYSize', ctypes.c_ulong),
        ('dwXCountChars', ctypes.c_ulong),
        ('dwYCountChars', ctypes.c_ulong),
        ('dwFillAttribute', ctypes.c_ulong),
        ('dwFlags', ctypes.c_ulong),
        ('wShowWindow', ctypes.c_ushort),
        ('cbReserved2', ctypes.c_ushort),
        ('lpReserved2', ctypes.c_void_p),
        ('hStdInput', ctypes.c_void_p),
        ('hStdOutput', ctypes.c_void_p),
        ('hStdError', ctypes.c_void_p),
    ]


class _PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ('hProcess', ctypes.c_void_p),
        ('hThread', ctypes.c_void_p),
        ('dwProcessId', ctypes.c_ulong),
        ('dwThreadId', ctypes.c_ulong),
    ]


class _SECURITY_ATTRIBUTES(ctypes.Structure):
    _fields_ = [
        ('nLength', ctypes.c_ulong),
        ('lpSecurityDescriptor', ctypes.c_void_p),
        ('bInheritHandle', ctypes.c_int),
    ]


# 管道句柄必须可继承（子进程要拿写端）；读端随后用 SetHandleInformation 单独关继承
_INHERIT_SA = _SECURITY_ATTRIBUTES()
_INHERIT_SA.nLength = ctypes.sizeof(_SECURITY_ATTRIBUTES)
_INHERIT_SA.lpSecurityDescriptor = None
_INHERIT_SA.bInheritHandle = True


def _declare_win32():
    """集中声明 restype/argtypes（项目 C2 教训：默认 c_int 会截断 64 位句柄）。

    幂等可重入；非 Windows 环境静默跳过（模块可 import，调用才报不可用）。
    """
    if not hasattr(ctypes, 'windll'):
        return False
    try:
        from ctypes import wintypes
        k32 = ctypes.windll.kernel32

        k32.CreateJobObjectW.restype = wintypes.HANDLE
        k32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]

        k32.AssignProcessToJobObject.restype = wintypes.BOOL
        k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]

        k32.SetInformationJobObject.restype = wintypes.BOOL
        k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int,
                                                wintypes.LPVOID, wintypes.DWORD]

        k32.QueryInformationJobObject.restype = wintypes.BOOL
        k32.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int,
                                                  wintypes.LPVOID, wintypes.DWORD,
                                                  ctypes.POINTER(wintypes.DWORD)]

        k32.TerminateJobObject.restype = wintypes.BOOL
        k32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]

        k32.CreateProcessW.restype = wintypes.BOOL
        k32.CreateProcessW.argtypes = [
            wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.LPVOID, wintypes.LPVOID,
            wintypes.BOOL, wintypes.DWORD, wintypes.LPVOID, wintypes.LPCWSTR,
            ctypes.POINTER(_STARTUPINFOW), ctypes.POINTER(_PROCESS_INFORMATION),
        ]

        k32.ResumeThread.restype = wintypes.DWORD
        k32.ResumeThread.argtypes = [wintypes.HANDLE]

        k32.WaitForSingleObject.restype = wintypes.DWORD
        k32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]

        k32.GetExitCodeProcess.restype = wintypes.BOOL
        k32.GetExitCodeProcess.argtypes = [wintypes.HANDLE,
                                           ctypes.POINTER(wintypes.DWORD)]

        k32.CreatePipe.restype = wintypes.BOOL
        k32.CreatePipe.argtypes = [ctypes.POINTER(wintypes.HANDLE),
                                   ctypes.POINTER(wintypes.HANDLE),
                                   wintypes.LPVOID, wintypes.DWORD]

        k32.SetHandleInformation.restype = wintypes.BOOL
        k32.SetHandleInformation.argtypes = [wintypes.HANDLE, wintypes.DWORD,
                                             wintypes.DWORD]

        k32.CloseHandle.restype = wintypes.BOOL
        k32.CloseHandle.argtypes = [wintypes.HANDLE]

        k32.ReadFile.restype = wintypes.BOOL
        k32.ReadFile.argtypes = [wintypes.HANDLE, wintypes.LPVOID,
                                 wintypes.DWORD,
                                 ctypes.POINTER(wintypes.DWORD),
                                 wintypes.LPVOID]

        k32.CreateFileW.restype = wintypes.HANDLE
        k32.CreateFileW.argtypes = [
            wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
            wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
        ]

        # 修复 H13（四轮）：收编失败兜底杀进程 / adopt_pid 的句柄声明漏网（C2 纪律一致性）
        k32.TerminateProcess.restype = wintypes.BOOL
        k32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        # 修复 H6（四轮）：GetLastError 直读——windll 未 use_last_error=True 时
        # ctypes.get_last_error() 返回陈旧值（实测恒 0），人话映射永不命中
        k32.GetLastError.restype = wintypes.DWORD
        k32.GetLastError.argtypes = []
        return True
    except Exception:
        return False


class SandboxRunResult:
    """与 subprocess.CompletedProcess 同构的最小结果（returncode/stdout/stderr）。"""

    __slots__ = ('returncode', 'stdout', 'stderr', 'timed_out', 'sandboxed')

    def __init__(self, returncode, stdout=b'', stderr=b'',
                 timed_out=False, sandboxed=True):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.timed_out = timed_out
        self.sandboxed = sandboxed


class SandboxJob:
    """单次命令执行的 Job Object 生命周期。

    用法：create(limits) → spawn 挂起进程 → assign_process(hProcess)
    → resume → 结束 terminate()/close()。KILL_ON_JOB_CLOSE 保证 close 即清剿。
    """

    def __init__(self, job_handle, limits, logger=None):
        self._h = job_handle
        self._limits = limits or {}
        self._log = logger or get_logger()
        self._closed = False
        self._assigned = 0
        self._terminated = False

    @property
    def handle(self):
        return self._h

    def assign_process(self, process_handle):
        """把（挂起态的）进程收编进 job。失败抛 SandboxUnavailable（fail-closed）。"""
        if self._closed:
            raise SandboxUnavailable('job 已关闭，无法收编')
        ok = ctypes.windll.kernel32.AssignProcessToJobObject(self._h, process_handle)
        if not ok:
            code = ctypes.windll.kernel32.GetLastError()   # 修复 H6（四轮）
            # ERROR_ACCESS_DENIED=5：进程已在不可破出的 job（Win7 语义/完整性不匹配）
            raise SandboxUnavailable(
                '进程收编失败（Win32 错误 %d）：目标进程可能已属于其他'
                '不可破出的 Job（如被其他沙箱/宿主收编）' % code)
        self._assigned += 1

    def adopt_pid(self, pid):
        """给已运行进程（subprocess.Popen 路径）补挂 job。

        注意：有毫秒级竞态——目标进程可能在我们 assign 前已 fork 出 job 外
        子孙进程。安全敏感路径请用 run_in_sandbox（挂起态收编，无竞业）。
        MCP stdio 温启等非对抗场景可用本方法。
        """
        k32 = ctypes.windll.kernel32
        h = k32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, int(pid))
        if not h:
            code = ctypes.windll.kernel32.GetLastError()   # 修复 H6（四轮）
            # ERROR_INVALID_PARAMETER=87：进程已退出（句柄按僵尸仍可开的情况除外）
            raise SandboxUnavailable('OpenProcess(%s) 失败（错误 %d）：进程可能已退出'
                                     % (pid, code))
        try:
            self.assign_process(h)
        finally:
            k32.CloseHandle(h)

    def stats(self):
        """查询 job 记账（进程数/终止数/峰值内存）；失败返回 None。"""
        try:
            acct = _JOBOBJECT_BASIC_ACCOUNTING_INFORMATION()
            if not ctypes.windll.kernel32.QueryInformationJobObject(
                    self._h, JobObjectBasicAccountingInformation,
                    ctypes.byref(acct), ctypes.sizeof(acct),
                    ctypes.byref(ctypes.c_ulong(0))):
                return None
            lim = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
            peak = None
            if ctypes.windll.kernel32.QueryInformationJobObject(
                    self._h, JobObjectExtendedLimitInformation,
                    ctypes.byref(lim), ctypes.sizeof(lim),
                    ctypes.byref(ctypes.c_ulong(0))):
                peak = lim.PeakJobMemoryUsed
            return {
                'active_processes': acct.ActiveProcesses,
                'total_processes': acct.TotalProcesses,
                'terminated_processes': acct.TotalTerminatedProcesses,
                'peak_memory_bytes': peak,
            }
        except Exception as e:
            self._log.debug('job stats 查询失败: %r', e)
            return None

    def terminate(self, exit_code=1):
        """清剿整棵树（含所有后代）。幂等。"""
        if self._closed or self._terminated:
            return
        ctypes.windll.kernel32.TerminateJobObject(self._h, exit_code)
        self._terminated = True

    def close(self):
        """关闭 job 句柄。KILL_ON_JOB_CLOSE 在位时残留进程随句柄关闭被清剿。"""
        if self._closed:
            return
        self._closed = True
        try:
            ctypes.windll.kernel32.CloseHandle(self._h)
        except Exception:
            pass
        self._h = None


def create_job(limits, logger=None):
    """按限制字典创建 Job；返回 SandboxJob。任何 Win32 失败都抛 SandboxUnavailable。"""
    if not hasattr(ctypes, 'windll'):
        raise SandboxUnavailable('非 Windows 平台，沙箱不可用')
    _declare_win32()
    k32 = ctypes.windll.kernel32

    h = k32.CreateJobObjectW(None, None)
    if not h:
        raise SandboxUnavailable('CreateJobObjectW 失败（错误 %d）'
                                 % ctypes.windll.kernel32.GetLastError())   # 修复 H6（四轮）
    try:
        limits = limits or {}
        ext = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        basic = ext.BasicLimitInformation
        flags = 0

        mem_mb = int(limits.get('memory_mb') or 0)
        if mem_mb > 0:
            bytes_ = mem_mb * MB
            ext.ProcessMemoryLimit = bytes_
            ext.JobMemoryLimit = bytes_
            flags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY

        max_proc = int(limits.get('max_processes') or 0)
        if max_proc > 0:
            basic.ActiveProcessLimit = max_proc
            flags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS_NUMBER

        cpu_s = float(limits.get('cpu_seconds') or 0)
        if cpu_s > 0:
            basic.PerJobUserTimeLimit = int(cpu_s * _CPU_TICK)
            flags |= JOB_OBJECT_LIMIT_JOB_TIME

        # 孤儿清剿：句柄关闭即全树终止（本服务每次执行完都显式 close）
        flags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        basic.LimitFlags = flags

        if not k32.SetInformationJobObject(h, JobObjectExtendedLimitInformation,
                                           ctypes.byref(ext), ctypes.sizeof(ext)):
            code = ctypes.windll.kernel32.GetLastError()   # 修复 H6（四轮）
            k32.CloseHandle(h)
            raise SandboxUnavailable('设置 Job 限制失败（Win32 错误 %d）：'
                                     '限制参数可能不被当前系统支持' % code)

        ui = _UI_LEVELS.get(limits.get('ui_restrict') or 'none', 0)
        if ui:
            restr = _JOBOBJECT_BASIC_UI_RESTRICTIONS()
            restr.UIRestrictionsClass = ui
            # UI 限制不被某些系统支持时只记日志，不影响主限制（降级可用）
            if not k32.SetInformationJobObject(h, JobObjectBasicUIRestrictions,
                                               ctypes.byref(restr),
                                               ctypes.sizeof(restr)):
                (logger or get_logger()).warning(
                    'Job UI 限制设置失败（错误 %d），继续（无 UI 限制）',
                    ctypes.windll.kernel32.GetLastError())   # 修复 H6（四轮）
        return SandboxJob(h, limits, logger=logger)
    except SandboxUnavailable:
        raise
    except Exception as e:
        try:
            k32.CloseHandle(h)
        except Exception:
            pass
        raise SandboxUnavailable('创建 Job 异常: %r' % e)


def _build_cmdline(args, shell):
    """构造 (lpApplicationName, lpCommandLine)。口径与 CPython subprocess
    shell=True 逐字一致（`comspec /c "args"`，comspec 不加引号——实测
    Lib/subprocess.py `args = '{} /c "{}"'.format(comspec, args)`）。"""
    if shell:
        inner = args if isinstance(args, str) else subprocess.list2cmdline(
            [str(a) for a in args])
        comspec = os.environ.get('COMSPEC') or 'C:\\Windows\\System32\\cmd.exe'
        return comspec, '%s /c "%s"' % (comspec, inner)
    if isinstance(args, str):
        return None, args
    return None, subprocess.list2cmdline([str(a) for a in args])


# R41 修复（N9）：单流保留上限——原 _read_pipe 全量进内存（超大输出直接吃满
# 内存，调用方亦无截断点）。保留头部、继续排空管道（防子进程写端阻塞）丢弃尾部。
SANDBOX_PIPE_RETAIN = 2 * 1024 * 1024
_SANDBOX_PIPE_MARK = ('\n...[sandbox output truncated: exceed %d bytes]'
                      % SANDBOX_PIPE_RETAIN).encode('utf-8')


def _read_pipe(handle, out_list):
    """线程体：同步 ReadFile 管道直至 EOF。纯 ctypes，不碰 fd 混用。"""
    k32 = ctypes.windll.kernel32
    buf = ctypes.create_string_buffer(65536)
    read = ctypes.c_ulong(0)
    kept = 0
    marked = False
    while True:
        if not k32.ReadFile(handle, buf, 65536, ctypes.byref(read), None):
            break
        if read.value == 0:
            break
        if kept < SANDBOX_PIPE_RETAIN:
            chunk = buf.raw[:read.value]
            out_list.append(chunk)
            kept += len(chunk)
        elif not marked:
            out_list.append(_SANDBOX_PIPE_MARK)
            marked = True


def run_in_sandbox(args, shell=False, cwd=None, timeout=60, limits=None,
                   env=None, logger=None):
    """在沙箱内执行命令（无竞业收编路径）。

    流程：CreatePipe×2 → CreateProcessW(CREATE_SUSPENDED|NO_WINDOW)
    → AssignProcessToJobObject → ResumeThread → 关父侧写端 → 读管道
    → WaitForSingleObject(timeout) → 超时则 TerminateJobObject 清剿整树。

    返回 SandboxRunResult。沙箱不可用/创建失败抛 SandboxUnavailable（fail-closed）。
    """
    log = logger or get_logger()
    if not hasattr(ctypes, 'windll'):
        raise SandboxUnavailable('非 Windows 平台，沙箱不可用')
    _declare_win32()
    k32 = ctypes.windll.kernel32

    # 实现 v1.6 T9 复核（QA 观察项）：create_job 失败（限制参数不被系统支持等）也是
    # 一条真实 fail-closed 拒绝路径——原在主 try 外，runs_failed_closed 不递增，
    # T6 面板统计看不到这类拒绝。此处补记后原样上抛（阻断语义不变，纯统计口径）。
    try:
        job = create_job(limits, logger=log)
    except SandboxUnavailable:
        with _STATS_LOCK:
            _STATS['runs_failed_closed'] += 1
        raise
    with _STATS_LOCK:
        _STATS['jobs_created'] += 1
    out_r = err_r = out_w = err_w = None
    in_r = in_w = None
    proc_info = None
    t_out = t_err = None
    try:
        # ---- 管道（stdin 接 NUL：子进程读即 EOF，不挂起）----
        out_r, out_w = _create_pipe()
        err_r, err_w = _create_pipe()
        in_r, in_w = _create_pipe()
        k32.CloseHandle(in_w)   # 父侧不持写端 → 子进程 stdin 立即 EOF
        # 读端设为不可继承（否则父侧读端被孙子继承会导致 EOF 永不到达）
        k32.SetHandleInformation(out_r, HANDLE_FLAG_INHERIT, 0)
        k32.SetHandleInformation(err_r, HANDLE_FLAG_INHERIT, 0)
        # 修复 H2（四轮）：in_r 是要交给子进程当 stdin 的句柄，必须保持可继承——
        # 原对 in_r 去继承，bInheritHandles=True 的 CreateProcessW 不会复制它，
        # 子进程 stdin 句柄值悬空（实测 sys.stdin=None，find/sort 等读管道命令全异常）。
        # EOF 语义由父侧关闭 in_w 保证，无需（也不能）对 in_r 去继承。

        app, cmdline = _build_cmdline(args, shell)
        si = _STARTUPINFOW()
        si.cb = ctypes.sizeof(si)
        si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW
        si.wShowWindow = SW_HIDE
        si.hStdInput = in_r
        si.hStdOutput = out_w
        si.hStdError = err_w
        pi = _PROCESS_INFORMATION()
        cmd_buf = ctypes.create_unicode_buffer(cmdline)

        okp = k32.CreateProcessW(app, cmd_buf, None, None, True,
                                 CREATE_SUSPENDED | CREATE_NO_WINDOW,
                                 env, cwd, ctypes.byref(si), ctypes.byref(pi))
        if not okp:
            # 复核修正：windll 未开 use_last_error，ctypes.get_last_error()
            # 恒 0/陈旧（本文件 H6 修复注释已确认此坑，其余 6 处均用
            # k32.GetLastError()，唯此处漏改）——失败人话映射永远「未知错误」
            code = k32.GetLastError()
            raise SandboxUnavailable('CreateProcessW 失败（错误 %d）：%s'
                                     % (code, _fmt_winerr(code)))
        proc_info = pi
        try:
            job.assign_process(pi.hProcess)
        except SandboxUnavailable:
            # 收编失败（如完整性不匹配）：先杀掉刚起的进程再报错，不留裸进程
            k32.TerminateProcess(pi.hProcess, 1)
            raise
        if k32.ResumeThread(pi.hThread) == ctypes.c_ulong(-1).value:
            # 进程可能在挂起态已退出：取退出码，按已完成处理
            # 修复 H4（四轮）：STILL_ACTIVE(259) 表示进程其实还活着（挂起态未运行），
            # 原样当退出码返回是假成功；且该路径漏计 runs_sandboxed
            code = ctypes.c_ulong(0)
            if k32.GetExitCodeProcess(pi.hProcess, ctypes.byref(code)) and code.value != 259:
                with _STATS_LOCK:
                    _STATS['runs_sandboxed'] += 1
                return SandboxRunResult(code.value, b'', b'', sandboxed=True)
            raise SandboxUnavailable('ResumeThread 失败且进程未退出（exit=%s）'
                                     % (code.value if k32.GetExitCodeProcess(
                                         pi.hProcess, ctypes.byref(code)) else '?'))

        # 父侧写端关闭 → 管道 EOF 只等子进程退出
        k32.CloseHandle(out_w); out_w = None
        k32.CloseHandle(err_w); err_w = None
        k32.CloseHandle(in_r); in_r = None

        out_chunks, err_chunks = [], []
        t_out = threading.Thread(target=_read_pipe, args=(out_r, out_chunks),
                                 daemon=True)
        t_err = threading.Thread(target=_read_pipe, args=(err_r, err_chunks),
                                 daemon=True)
        t_out.start(); t_err.start()

        timeout_ms = int(max(1, float(timeout or 60)) * 1000)
        wait = k32.WaitForSingleObject(pi.hProcess, timeout_ms)
        timed_out = (wait == WAIT_TIMEOUT)
        if timed_out:
            # 清剿整棵树（taskkill /T 的替代：内核级，含孙进程）
            job.terminate(1)
            k32.WaitForSingleObject(pi.hProcess, 5000)
        t_out.join(5); t_err.join(5)
        code = ctypes.c_ulong(0)
        rc = -1
        if k32.GetExitCodeProcess(pi.hProcess, ctypes.byref(code)):
            rc = code.value
        with _STATS_LOCK:
            _STATS['runs_sandboxed'] += 1
        return SandboxRunResult(rc, b''.join(out_chunks), b''.join(err_chunks),
                                timed_out=timed_out, sandboxed=True)
    except SandboxUnavailable:
        with _STATS_LOCK:
            _STATS['runs_failed_closed'] += 1
        raise
    finally:
        # 修复 H5（四轮）：清理次序——先 job.close()（KILL_ON_JOB_CLOSE 清剿整树，
        # 持写端的孙进程被杀 → 管道写端全关 → 读线程 ReadFile 自然 EOF 退出），
        # 再 join 读线程，最后收句柄。原「先关读句柄后关 job」在读线程仍阻塞于
        # ReadFile 时关闭其句柄（Win32 未定义行为，泄漏常驻线程）。
        job.close()
        if t_out is not None:
            t_out.join(2)
        if t_err is not None:
            t_err.join(2)
        # 关管道读端与进程/线程句柄；job.close() 触发 KILL_ON_JOB_CLOSE
        for h in (out_r, err_r, in_r, out_w, err_w):
            if h:
                try:
                    k32.CloseHandle(h)
                except Exception:
                    pass
        if proc_info is not None:
            for h in (proc_info.hThread, proc_info.hProcess):
                if h:
                    try:
                        k32.CloseHandle(h)
                    except Exception:
                        pass


def _create_pipe():
    k32 = ctypes.windll.kernel32
    r = wintypes_h = ctypes.c_void_p()
    w = ctypes.c_void_p()
    if not k32.CreatePipe(ctypes.byref(r), ctypes.byref(w),
                          ctypes.byref(_INHERIT_SA), 65536):
        raise SandboxUnavailable('CreatePipe 失败（错误 %d）'
                                 % ctypes.windll.kernel32.GetLastError())   # 修复 H6（四轮）
    return r.value, w.value


def _fmt_winerr(code):
    """常见错误码人话（不引 FormatMessage，避免 locale 依赖）。"""
    return {
        2: '找不到文件（命令不存在？）',
        3: '找不到路径（cwd 无效？）',
        5: '拒绝访问（权限/完整性级别）',
        1314: '调用进程无特权（完整性不匹配）',
    }.get(code, '未知错误')


class SandboxService:
    """沙箱配置与执行门面（js_api 后端）。

    - 配置独立文件 sandbox.json（不碰 config.json 契约红线）
    - limits_for(command_class)：解析命令类别 → 限制字典；None 表示不沙箱
    - fail-closed：enabled 但沙箱不可用 → 调用方收到 SandboxUnavailable
    """

    def __init__(self, sandbox_path=None, logger=None):
        self._log = logger or get_logger()
        self._path = sandbox_path or SANDBOX_FILE
        self._lock = threading.RLock()
        self._cfg = self._load()

    # ---- 配置 ----
    def _load(self):
        cfg = json.loads(json.dumps(DEFAULT_CONFIG))   # deep copy
        try:
            with open(self._path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict):
                if isinstance(data.get('enabled'), bool):
                    cfg['enabled'] = data['enabled']
                cp = data.get('command_profiles')
                if isinstance(cp, dict):
                    for k in _COMMAND_CLASSES:
                        v = cp.get(k)
                        if v in _PROFILES:
                            cfg['command_profiles'][k] = v
                lim = data.get('limits')
                if isinstance(lim, dict):
                    for pname, plim in lim.items():
                        if pname not in cfg['limits'] or not isinstance(plim, dict):
                            continue
                        for f_ in ('memory_mb', 'max_processes', 'cpu_seconds'):
                            try:
                                v = int(plim.get(f_))
                                if v > 0:
                                    cfg['limits'][pname][f_] = min(v, 100000)
                            except (TypeError, ValueError):
                                pass
                        ur = plim.get('ui_restrict')
                        if ur in _UI_LEVELS:
                            cfg['limits'][pname]['ui_restrict'] = ur
        except FileNotFoundError:
            pass
        except Exception as e:
            self._log.warning('沙箱配置加载失败，按默认处理: %r', e)
        return cfg

    def get_config(self):
        with self._lock:
            return json.dumps(self._cfg, ensure_ascii=False)

    def save_config(self, cfg_json):
        try:
            incoming = json.loads(cfg_json) if isinstance(cfg_json, str) else cfg_json
            if not isinstance(incoming, dict):
                incoming = {}
            with self._lock:
                if isinstance(incoming.get('enabled'), bool):
                    self._cfg['enabled'] = incoming['enabled']
                cp = incoming.get('command_profiles')
                if isinstance(cp, dict):
                    for k in _COMMAND_CLASSES:
                        v = cp.get(k)
                        if v in _PROFILES:
                            self._cfg['command_profiles'][k] = v
                lim = incoming.get('limits')
                if isinstance(lim, dict):
                    for pname, plim in lim.items():
                        if pname not in self._cfg['limits'] or not isinstance(plim, dict):
                            continue
                        for f_ in ('memory_mb', 'max_processes', 'cpu_seconds'):
                            try:
                                v = int(plim.get(f_))
                                if v > 0:
                                    self._cfg['limits'][pname][f_] = min(v, 100000)
                            except (TypeError, ValueError):
                                pass
                        ur = plim.get('ui_restrict')
                        if ur in _UI_LEVELS:
                            self._cfg['limits'][pname]['ui_restrict'] = ur
                # 修复（本轮）：非原子直写改原子写（tmp + fsync + os.replace，
                # 带 WinError32 退避重试）——原 open('w') 截断式直写，写一半
                # 崩溃/断电即半截 JSON，沙箱配置（含 fail-closed 开关）全丢。
                atomic_write_json(self._path, self._cfg, indent=2)
            return '{"ok":true}'
        except Exception as e:
            self._log.exception('沙箱配置保存失败')
            return json.dumps({'error': str(e)}, ensure_ascii=False)

    def limits_for(self, command_class):
        """命令类别 → 限制字典。None = 不沙箱（disabled 或该类别 off）。"""
        with self._lock:
            if not self._cfg.get('enabled'):
                return None
            profile = self._cfg['command_profiles'].get(command_class)
            if profile in (None, 'off'):
                return None
            lim = self._cfg['limits'].get(profile)
            return json.loads(json.dumps(lim)) if lim else None

    def limits_for_profile(self, profile):
        """v1.8.0 S 域：按档位名（standard/strict）直取限制字典。

        software_service 的 risk→档位映射（read/mutate→standard，
        dangerous→strict）经本方法取限制；enabled=False 或档位不存在 →
        None（不沙箱，与 limits_for 口径一致）。纯新增方法，既有行为不变。
        """
        with self._lock:
            if not self._cfg.get('enabled'):
                return None
            lim = self._cfg['limits'].get(str(profile or ''))
            return json.loads(json.dumps(lim)) if lim else None

    def available(self):
        return hasattr(ctypes, 'windll')

    def prompt_notice(self):
        """实现 v1.6 T5①：沙箱边界告知段（供 build_system_prompt 注入；未启用返回 ''）。

        边界必须诚实（架构文档能力矩阵）：进程/资源限制真实存在，但**网络不隔离、
        文件系统仅应用层校验**——防止 Agent 误判「沙箱 = 绝对安全」而放弃与用户
        确认敏感操作。调用方（api.py）在 INTENTIONAL_DELTAS 白名单内注入。"""
        with self._lock:
            if not self._cfg.get('enabled'):
                return ''
            profiles = [p for p in (self._cfg.get('command_profiles') or {}).values()
                        if p not in (None, 'off')]
        if not profiles:
            return ''
        return ('沙箱边界: 命令在受限 Job 内执行(内存/进程数/CPU 上限, 句柄关闭即清剿整棵进程树); '
                '但网络不隔离、文件系统仅应用层校验——勿把沙箱当绝对安全, 敏感操作先与用户确认。')

    def status(self):
        with self._lock:
            enabled = bool(self._cfg.get('enabled'))
            profiles = dict(self._cfg.get('command_profiles') or {})
        with _STATS_LOCK:
            stats = dict(_STATS)
        return json.dumps({
            'available': self.available(),
            'platform': os.name,
            'enabled': enabled,
            'command_profiles': profiles,
            'stats': stats,
        }, ensure_ascii=False)
