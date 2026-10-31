# -*- coding: utf-8 -*-
"""契约测试基础设施：在无 webview / PIL 的环境下对 v1.0.0 legacy 与重构后 backend 做差分测试。

手段：
- fake webview 注入 sys.modules（legacy import 即建窗并 webview.start()）
- fake PIL 注入 sys.modules（take_screenshot 的 ImageGrab）
- HOME/USERPROFILE 重定向到临时目录（隔离 ~/.glm-chat 副作用）
- subprocess/ctypes/os.startfile/webbrowser 由各测试自行 monkeypatch
"""
import ctypes
import os
import shutil
import subprocess
import sys
import tempfile
import types

import pytest

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

# ---------------------------------------------------------------- fake webview
class _FakeEventSlot:
    def __init__(self):
        self._cbs = []

    def __iadd__(self, cb):
        self._cbs.append(cb)
        return self


class _FakeEvents:
    def __init__(self):
        self.loaded = _FakeEventSlot()


class _FakeWindow:
    def __init__(self):
        self.native = None
        self.events = _FakeEvents()

    def create_file_dialog(self, dialog_type):
        return os.environ.get('GLM_TEST_PICK', '')


class _FakeWebview(types.ModuleType):
    FOLDER_DIALOG = 'folder'

    def __init__(self):
        super().__init__('webview')
        self.windows = []

    def create_window(self, title, url=None, js_api=None, **kw):
        w = _FakeWindow()
        self.windows.append(w)
        return w

    def start(self):
        pass


# ---------------------------------------------------------------- fake PIL
class _FakeImage:
    size = (320, 200)

    def save(self, target, **kw):
        if hasattr(target, 'write'):
            target.write(b'FAKEJPEG')
        else:
            with open(target, 'wb') as f:
                f.write(b'FAKEJPEG')

    def convert(self, fmt):
        return self


def _fake_imagegrab_grab(bbox=None, all_screens=False, **kw):
    return _FakeImage()


def _install_fake_pil():
    pil = types.ModuleType('PIL')
    ig = types.ModuleType('PIL.ImageGrab')
    ig.grab = _fake_imagegrab_grab
    pil.ImageGrab = ig
    sys.modules['PIL'] = pil
    sys.modules['PIL.ImageGrab'] = ig


# ---------------------------------------------------------------- fake ctypes.windll
# 忠实内存剪贴板（QA 回归期升级）：GlobalAlloc 分配真实 ctypes buffer、句柄表映射、
# SetClipboardData 记录写入内容、GetClipboardData/GlobalLock 回读同一内容——
# 写后回读校验（W6）与 legacy 读回路径在 fake 下语义一致，契约差分两侧输出逐字节相同。
# int 地址与 C2 修复后真实 GlobalLock（restype=c_void_p → Python int）行为对齐。
_CLIP_STORE = {'text': 'clip-content'}
_CLIP_ALLOCS = {}        # handle -> ctypes buffer（真实内存，memmove 直接可写）
_CLIP_NEXT_HANDLE = [4242]


class _FakeUser32:
    @staticmethod
    def MessageBoxW(*a):
        return int(os.environ.get('GLM_TEST_MSGBOX', '6'))

    @staticmethod
    def IsClipboardFormatAvailable(fmt):
        return 1

    @staticmethod
    def OpenClipboard(hwnd):
        return 1

    @staticmethod
    def GetClipboardData(fmt):
        buf = ctypes.create_unicode_buffer(_CLIP_STORE['text'])
        h = _CLIP_NEXT_HANDLE[0]
        _CLIP_NEXT_HANDLE[0] += 1
        _CLIP_ALLOCS[h] = buf
        return h

    @staticmethod
    def CloseClipboard():
        return 1

    @staticmethod
    def EmptyClipboard():
        return 1

    @staticmethod
    def SetClipboardData(fmt, h):
        buf = _CLIP_ALLOCS.get(h)
        if buf is not None:
            _CLIP_STORE['text'] = buf.value   # 忠实记录写入内容（回读校验依赖）
        return 1


class _FakeKernel32:
    @staticmethod
    def GlobalLock(h):
        buf = _CLIP_ALLOCS.get(h)
        return ctypes.addressof(buf) if buf is not None else 0

    @staticmethod
    def GlobalUnlock(h):
        return 1

    @staticmethod
    def GlobalAlloc(flags, size):
        buf = ctypes.create_unicode_buffer(max(1, size // 2))
        h = _CLIP_NEXT_HANDLE[0]
        _CLIP_NEXT_HANDLE[0] += 1
        _CLIP_ALLOCS[h] = buf
        return h

    @staticmethod
    def GlobalSize(h):
        # 修复 W11（二轮）忠实桩：返回句柄对应 buffer 字节数（c_wchar = 2 字节）
        buf = _CLIP_ALLOCS.get(h)
        return (len(buf) * 2) if buf is not None else 0

    @staticmethod
    def GlobalFree(h):
        _CLIP_ALLOCS.pop(h, None)
        return 0


class _FakeShell32:
    @staticmethod
    def ShellExecuteW(*a):
        return 42


class _FakeWindll:
    user32 = _FakeUser32
    kernel32 = _FakeKernel32
    shell32 = _FakeShell32


def install_fake_windll(monkeypatch):
    monkeypatch.setattr(ctypes, 'windll', _FakeWindll)


# ---------------------------------------------------------------- fake subprocess.run
def make_fake_subprocess_run():
    calls = []

    def fake_run(args, **kw):
        calls.append(args)
        if isinstance(args, (list, tuple)) and args and args[0] == 'tasklist':
            csv = (b'"Image Name","PID","Session Name","Session#","Mem Usage"\r\n'
                   b'"notepad.exe","1234","Console","1","10,000 K"\r\n'
                   b'"chrome.exe","5678","Console","1","80,000 K"\r\n')
            return subprocess.CompletedProcess(args, 0, stdout=csv, stderr=b'')
        if isinstance(args, (list, tuple)) and args and args[0] == 'taskkill':
            return subprocess.CompletedProcess(args, 0, stdout=b'\xe6\x88\x90\xe5\x8a\x9f: pid 1234', stderr=b'')
        if isinstance(args, str):
            cmd = args
            for prefix in ('chcp 65001 >nul & ', 'chcp 65001 >nul&'):
                if cmd.startswith(prefix):
                    cmd = cmd[len(prefix):]
                    break
            cmd = cmd.strip()
            if 'raise-timeout' in cmd:
                raise subprocess.TimeoutExpired(cmd=args, timeout=kw.get('timeout', 60))
            if cmd == 'echo hello':
                return subprocess.CompletedProcess(args, 0, stdout=b'hello\r\n', stderr=b'')
            if cmd == 'echo BIG':
                return subprocess.CompletedProcess(args, 0, stdout=b'X' * 8000, stderr=b'')
            return subprocess.CompletedProcess(args, 0, stdout=b'', stderr=b'')
        if isinstance(args, (list, tuple)) and args and args[0] == 'powershell':
            cmd = args[-1]
            if 'raise-timeout' in cmd:
                raise subprocess.TimeoutExpired(cmd=args, timeout=kw.get('timeout', 60))
            if 'Get-Date' in cmd:
                return subprocess.CompletedProcess(args, 0, stdout=b'ps-out', stderr=b'')
            if 'echo PSOUT' in cmd:
                return subprocess.CompletedProcess(args, 0, stdout=b'PS' * 5000, stderr=b'')
            return subprocess.CompletedProcess(args, 0, stdout=b'', stderr=b'')
        return subprocess.CompletedProcess(args, 0, stdout=b'', stderr=b'')

    return fake_run, calls


# ---------------------------------------------------------------- HOME 隔离
def _seed_home(home):
    ws = os.path.join(home, 'Desktop', 'GLM-Workspace')
    os.makedirs(os.path.join(ws, 'sub'), exist_ok=True)
    with open(os.path.join(ws, 'a.txt'), 'w', encoding='utf-8') as f:
        f.write('你好\nsecond line\n')
    with open(os.path.join(ws, 'gbk.txt'), 'wb') as f:
        f.write('中文gbk内容'.encode('gbk'))
    with open(os.path.join(ws, 'bin.dat'), 'wb') as f:
        f.write(b'\x00\x01\x02binary')
    with open(os.path.join(ws, 'big.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join('L%d' % i for i in range(6000)))
    with open(os.path.join(ws, 'sub', 'b.txt'), 'w', encoding='utf-8') as f:
        f.write('x' * 100)
    return ws


HOME = tempfile.mkdtemp(prefix='glm_test_home_')
_seed_home(HOME)
os.environ['USERPROFILE'] = HOME
os.environ['HOME'] = HOME
os.environ['HOMEDRIVE'], os.environ['HOMEPATH'] = os.path.splitdrive(HOME)
os.environ['GLM_TEST_PICK'] = os.path.join(HOME, 'Desktop', 'picked')

sys.modules['webview'] = _FakeWebview()
_install_fake_pil()

# legacy v1.0.0 模块（import 即启动窗口 → fake webview 吸收）
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    'legacy_main', os.path.join(PROJECT_ROOT, 'main_v1.0.0_legacy.py'))
legacy = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(legacy)

from backend.api import Api as NewApi  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_home():
    reset_home()
    _reset_sandbox_stats()
    yield


def _reset_sandbox_stats():
    """实现 v1.6 测试基建（team-lead 路由的隔离缺陷）：sandbox_service._STATS 是
    模块级跨测试累积计数器——T9 真实执行（jobs_created +N）与批次 2 失败注入
    （runs_failed_closed）在同一进程内互相污染，使依赖「测试起步计数」的断言产生
    文件间顺序依赖（test_sandbox 末测试的 importlib.reload 重置只是巧合掩盖）。
    每个测试从干净计数起步；既有断言全部为 st0→st1 增量式，两种起步态下等价。
    取当前模块对象（reload 后为重绑定模块），重置其 _STATS。"""
    try:
        from backend.domains.workspace import sandbox_service as _sb
        with _sb._STATS_LOCK:
            for _k in list(_sb._STATS.keys()):
                _sb._STATS[_k] = 0
    except Exception:
        pass


def reset_home():
    shutil.rmtree(HOME, ignore_errors=True)
    os.makedirs(HOME, exist_ok=True)
    _seed_home(HOME)
    # 假剪贴板是忠实内存实现（SetClipboardData 会记录写入），契约差分两轮 run 之间
    # 必须复位到初始内容，否则 legacy 轮的 set 会污染 new 轮的 get_clipboard
    _CLIP_STORE['text'] = 'clip-content'


def ws():
    return os.path.join(HOME, 'Desktop', 'GLM-Workspace')


# ---------------------------------------------------------------- P1-3（T04）外部环境隔离
# WorkBuddy 会话把 agent 工具调用的 safe-delete bulk guard 上下文随 shell 继承进
# pytest 进程（sitecustomize shim 在解释器启动即打桩 os.remove/os.unlink/os.rmdir/
# shutil.rmtree/Path.unlink）。全量套件在项目内 --basetemp 上的删除不属于 shim 的
# OS 临时目录豁免面，会计入所继承工具调用 id 的删除配额（阈值 50/turn）：超限后
# guard 对每次删除 raise SystemExit(1)——「全量连跑 23 failed、逐项复跑全过」基线
# 的根因（22 项直接 SystemExit + 1 项下载线程清理被 SystemExit 击杀致状态停摆
# 'downloading'。另有 1 项偶发 UnboundLocalError：外部服务代理对搜索域返回
# 空 200 的竞态路径（EXT-2，业务侧 results 未初始化兜底缺失，移交后续修复批）。
# 证据归档 outputs/pytest-tmp/diag-final/{signature-comparison,pollution-map}.json
# 与 guard state.json count=50/threshold=50/scope=turn）。
# 测试进程不是 agent 工具调用：剥离 guard 激活变量使其按自身条件判定不适用
# （_check_bulk_delete_guard 首行即 return）；safe-delete 主体——非豁免路径删除
# 移入回收站——保持原样，不 bypass 安全钩子本体。
# 注：SAFE_DELETE_ENABLED 等 shim 开关在 sitecustomize import 期已捕获，此处
# 不动它们（删除→回收站行为继续生效）；本块只清理「会话/配额归属」变量。
for _var in ('CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR',
             'CODEBUDDY_SAFE_DELETE_BULK_GUARD',
             'CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD',
             'CODEBUDDY_SAFE_DELETE_BULK_REPLAY_FILE',
             'CODEBUDDY_SAFE_DELETE_REPORT_PATH',
             'CODEBUDDY_TOOL_CALL_ID',
             'CODEBUDDY_SANDBOX_BROKER_TOOL_CALL_ID'):
    os.environ.pop(_var, None)


# ---------------------------------------------------------------- P1-3（T04）单例复位 + cwd 恢复
# 追加式治理设施（设计 §7.3 S1/S4）：单例复位集中在 tests/helpers/state_reset.py
# 的复位表；cwd 漂移防御性恢复（成本≈0）。后台线程停机钩子经 Phase 0-2 诊断
# 未发现项目内 S2 泄漏（全量失败根因为外部 safe-delete guard 环境继承，见上方
# 隔离块注释），不预置投机性停机逻辑——由 tools/diag/state_probe.py 复核把关。
_HELPERS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'helpers')
if _HELPERS_DIR not in sys.path:
    sys.path.append(_HELPERS_DIR)

try:
    from state_reset import reset_all as _state_reset_all
except Exception:  # 复位表缺失不阻断测试（诊断报告会暴露缺口）
    _state_reset_all = lambda: None  # noqa: E731


@pytest.fixture(autouse=True)
def _fresh_isolation_state():
    """每个用例：先按集中表复位跨用例单例；结束恢复 cwd（S4）。"""
    _state_reset_all()
    _cwd = os.getcwd()
    yield
    _state_reset_all()
    if os.getcwd() != _cwd:
        try:
            os.chdir(_cwd)
        except OSError:
            pass


# ---------------------------------------------------------------- P1-3（T04）后台线程停机钩子（S2）
# 实证（tools/diag/state_probe.py + 构造实验）：每个用例内构造的 Api() 会留下
# browser-driver-sweeper / mcp-idle-reaper 后台线程（+1/次，跨用例累积；后者
# 经 container.shutdown 后仍可能有残留线程）。治理：经线程对象取回 service
# 实例、置其「既有」stop Event（与 container.shutdown 同一停机机制——不新增
# 任何业务侧停机面，不改业务源码）。harbor-local-cors-proxy 为进程级幂等单例
# （全程仅 1 线程，ensure_running 幂等），不在停机名单。
_BACKGROUND_THREAD_STOPS = {
    'browser-driver-sweeper': ('_stop', 1.0),
    'mcp-idle-reaper': ('_reaper_stop', 1.0),
    # SearchBrowser 空闲回收看护（state_probe 实证：browser_search 用例遗留）
    'search-browser-recycler': ('_stop_evt', 1.0),
    # mcp-client-dispatch：close() 后按 _closed 语义自然收尾（≤0.5s 轮询周期），
    # 诊断探针的 teardown 快照会与末轮 recv 竞态——attr=None 表示仅 join 等待。
    'mcp-client-dispatch': (None, 1.0),
}


def _stop_harbor_background_threads():
    import threading
    for t in threading.enumerate():
        spec = _BACKGROUND_THREAD_STOPS.get(getattr(t, 'name', ''))
        if not spec or t is threading.current_thread():
            continue
        attr, timeout = spec
        try:
            if attr is not None:
                owner = getattr(getattr(t, '_target', None), '__self__', None)
                if owner is not None and hasattr(owner, attr):
                    getattr(owner, attr).set()
            t.join(timeout)
        except Exception:
            pass
    # 测试自建的 HTTP 服务器 serve_forever 线程（state_probe 实证：local_proxy
    # E2E 与 v15 wire 各遗留 1-8 个）：经线程对象取回 server 实例调其**既有**
    # shutdown() API（BaseServer 标准停机面）。本地 CORS 代理线程有专属名
    # （harbor-local-cors-proxy）不会命中 '(serve_forever)' 匹配。
    for t in threading.enumerate():
        name = getattr(t, 'name', '')
        if '(serve_forever)' not in name or t is threading.current_thread():
            continue
        try:
            server = getattr(getattr(t, '_target', None), '__self__', None)
            if server is not None and hasattr(server, 'shutdown'):
                server.shutdown()
                t.join(1.0)
        except Exception:
            pass


def pytest_runtest_teardown(item):
    # plain impl（conftest 后注册先执行）：在 fixture finalizer（fresh_home
    # rmtree/state_reset/cwd 恢复）**之前**停后台线程——避免迟写线程毁掉下一
    # 用例种子；诊断探针（tools/diag/state_probe.py）是 hookwrapper，其快照
    # 在全部 finalizer 之后取——只报告恢复机制处理不掉的残留。
    _stop_harbor_background_threads()
