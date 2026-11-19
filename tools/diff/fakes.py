# -*- coding: utf-8 -*-
"""差分 harness · Python 侧 fake 基础设施（conftest 风格的独立拷贝，不依赖 pytest）。

设计依据：deliverables/dev-plan/design-2026-10-30-p0-1-diff-harness.md §2.3/§5.2。
- HOME 重定向 + 种子工作区（config.json / ~/.glm-chat 零污染：全部落在临时根）
- fake webview / PIL（无条件安装：backend 的 pick_folder/截图运行期才 import）
- fake windll（忠实内存剪贴板 + MessageBoxW 桩，按 fixture mocks 声明安装）
- fake subprocess.run（读共享 mock-table.json，与 Node 侧 preload-mocks.mjs
  同一张表同一套匹配语义：file=basename（忽略 .exe 大小写）、kind 通道、
  contains 全部命中、stdoutRepeat 展开、timeout 桩、未命中放行真实执行）
- 软件探测 seam（_path_scanner/_app_path_lookup/_uninstall_lookup 注入）
- 工作区树快照 + probeConfigFiles 内容提取

红线遵守：不 import pytest、不修改 tests/conftest.py 与任何生产代码。
"""
import ctypes
import hashlib
import re
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types

_MOCK_TABLE = None
_STDLIB_RUN = subprocess.run
_CURRENT_ROOT = None


def load_mock_table():
    """共享 canned 响应表（双语言唯一事实源）。"""
    global _MOCK_TABLE
    if _MOCK_TABLE is None:
        path = os.environ.get('HARBOR_DIFF_MOCK_TABLE')
        if not path:
            path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                'mock-table.json')
        with open(path, encoding='utf-8') as f:
            _MOCK_TABLE = json.load(f)
    return _MOCK_TABLE


# ---------------------------------------------------------------- 路径与占位符
def paths_of(root):
    """本侧路径表：ROOT=HOME；WS=HOME/Desktop/GLM-Workspace；CFG=HOME/.glm-chat。"""
    home = str(root)
    return {
        'root': home,
        'ws': os.path.join(home, 'Desktop', 'GLM-Workspace'),
        'cfg': os.path.join(home, '.glm-chat'),
        'picked': os.environ.get('GLM_TEST_PICK') or os.path.join(home, 'out', 'report.txt'),
    }


def substitute(value, p):
    """fixture 参数占位符 → 本侧原生路径（递归替换字符串；数值/布尔原样）。"""
    if isinstance(value, str):
        out = value
        for key in ('PICKED', 'WS', 'CFG', 'ROOT'):
            out = out.replace('{%s}' % key, p[key.lower()])
        return out
    if isinstance(value, list):
        return [substitute(v, p) for v in value]
    if isinstance(value, dict):
        return {k: substitute(v, p) for k, v in value.items()}
    return value


# ---------------------------------------------------------------- HOME 与种子
def _write_seed_file(target, spec):
    encoding = str(spec.get('encoding') or 'utf-8')
    content = spec.get('content') if spec.get('content') is not None else ''
    parent = os.path.dirname(target)
    if parent:
        os.makedirs(parent, exist_ok=True)
    if encoding == 'binary-hex':
        with open(target, 'wb') as f:
            f.write(bytes.fromhex(str(content)))
    elif encoding == 'gbk':
        with open(target, 'wb') as f:
            f.write(str(content).encode('gbk'))
    else:
        with open(target, 'w', encoding='utf-8', newline='') as f:
            f.write(str(content))


def setup_home(root, fixture):
    """重定向 HOME 系环境变量 + 建种子工作区与目录。

    backend/paths.py 在 import 期经 expanduser('~') 计算全部路径，
    因此本函数必须先于任何 backend 模块 import 执行。
    """
    global _CURRENT_ROOT
    _CURRENT_ROOT = str(root)
    os.makedirs(str(root), exist_ok=True)
    os.environ['USERPROFILE'] = str(root)
    os.environ['HOME'] = str(root)
    drive, tail = os.path.splitdrive(str(root))
    os.environ['HOMEDRIVE'] = drive or os.path.splitdrive(os.path.abspath(os.sep))[0]
    os.environ['HOMEPATH'] = tail or os.sep

    table = load_mock_table()
    dialog_rel = str((table.get('dialog') or {}).get('relativePath') or 'out/report.txt')
    picked = os.path.join(str(root), *dialog_rel.replace('/', os.sep).split(os.sep))
    os.environ['GLM_TEST_PICK'] = picked
    # 对话框选中路径的父目录必须先在（save_export_file 校验父目录存在）
    os.makedirs(os.path.dirname(picked), exist_ok=True)

    setup = fixture.get('setup') or {}
    for d in setup.get('dirs') or []:
        os.makedirs(os.path.join(str(root), str(d)), exist_ok=True)

    p = paths_of(root)
    os.makedirs(p['ws'], exist_ok=True)
    for spec in setup.get('workspaceFiles') or []:
        rel = str(spec.get('path') or '').lstrip('/\\')
        _write_seed_file(os.path.join(p['ws'], rel), spec)
    return p


# ---------------------------------------------------------------- fake webview / PIL
class _FakeDiffWindow:
    """pywebview 窗口桩：对话框按 GLM_TEST_PICK 返回（与 Node 侧
    HARBOR_TEST_PICKED_PATH seam 对等）。"""

    def __init__(self):
        self.native = None
        self.events = types.SimpleNamespace(loaded=types.SimpleNamespace())

    def create_file_dialog(self, dialog_type, *args, **kwargs):
        return (os.environ.get('GLM_TEST_PICK', ''),)


class _FakeDiffWebview(types.ModuleType):
    FOLDER_DIALOG = 'folder'
    FILE_DIALOG = 'file'
    SAVE_DIALOG = 'save'

    def __init__(self):
        super().__init__('webview')
        self.windows = [_FakeDiffWindow()]
        self._win = _FakeDiffWindow()

    def create_window(self, title, url=None, js_api=None, **kw):
        return self._win

    def start(self):
        pass


def install_fake_webview():
    mod = _FakeDiffWebview()
    sys.modules['webview'] = mod
    return mod


class _FakePilImage:
    size = (320, 200)

    def save(self, target, **kw):
        data = b'FAKEJPEG'
        if hasattr(target, 'write'):
            target.write(data)
        else:
            with open(target, 'wb') as f:
                f.write(data)

    def convert(self, fmt):
        return self


def install_fake_pil():
    pil = types.ModuleType('PIL')
    ig = types.ModuleType('PIL.ImageGrab')
    ig.grab = lambda *a, **kw: _FakePilImage()
    pil.ImageGrab = ig
    sys.modules['PIL'] = pil
    sys.modules['PIL.ImageGrab'] = ig


# ---------------------------------------------------------------- fake windll
_CLIP_STORE = {'text': ''}
_CLIP_ALLOCS = {}
_CLIP_NEXT_HANDLE = [4242]


class _FakeUser32:
    @staticmethod
    def MessageBoxW(*a):
        # fixture env GLM_TEST_MSGBOX 优先（admin approve/deny fixture 按侧注入 6/7），
        # 缺省回落共享 mock 表 msgbox.ret
        env_ret = os.environ.get('GLM_TEST_MSGBOX')
        if env_ret:
            return int(env_ret)
        table = load_mock_table()
        return int((table.get('msgbox') or {}).get('ret', 6))

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
            _CLIP_STORE['text'] = buf.value
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
        buf = _CLIP_ALLOCS.get(h)
        return (len(buf) * 2) if buf is not None else 0

    @staticmethod
    def GlobalFree(h):
        _CLIP_ALLOCS.pop(h, None)
        return 0


class _FakeShell32:
    @staticmethod
    def ShellExecuteW(hwnd=None, lp_operation=None, lp_file=None,
                      lp_parameters=None, lp_directory=None, n_show_cmd=0):
        """admin 提权通道桩（主理人批准的 fakes.py 小改，控制在 mock 语义内）：
        识别 runas+cmd 包装形态，同步真跑临时 bat（_STDLIB_RUN 绕开 subprocess
        桩——bat 内的 echo 重定向需要真实文件副作用供轮询环读到 exit/output）。
        bat 由 Python run_admin_command 在系统临时目录创建并于 finally 清理。"""
        try:
            if str(lp_operation or '').lower() == 'runas' and lp_file in ('cmd', 'cmd.exe'):
                params = str(lp_parameters or '')
                # '/c "C:\\...\\glm_admin_xxx.bat"'
                if params.startswith('/c ') and '"' in params:
                    bat = params.split('"')[1]
                    if os.path.isfile(bat):
                        _STDLIB_RUN(['cmd', '/c', bat], capture_output=True,
                                    timeout=30, creationflags=getattr(
                                        subprocess, 'CREATE_NO_WINDOW', 0))
            return 42
        except Exception:
            return 42


class _FakeWindll:
    user32 = _FakeUser32
    kernel32 = _FakeKernel32
    shell32 = _FakeShell32


def install_fake_windll():
    table = load_mock_table()
    _CLIP_STORE['text'] = str((table.get('clipboard') or {}).get('text') or '')
    ctypes.windll = _FakeWindll


# ---------------------------------------------------------------- fake subprocess.run
def _norm_file(name):
    """可执行名归一：basename + 小写 + 剥 .exe（'PowerShell.EXE' → 'powershell'）。"""
    base = os.path.basename(str(name or '').strip().strip('"'))
    low = base.lower()
    return low[:-4] if low.endswith('.exe') else low


def _strip_chcp(cmd):
    for prefix in ('chcp 65001 >nul & ', 'chcp 65001 >nul&'):
        if cmd.startswith(prefix):
            return cmd[len(prefix):]
    return cmd


def _expand_stdout(entry):
    rep = entry.get('stdoutRepeat')
    if rep:
        return str(rep.get('char') or 'X') * int(rep.get('count') or 0)
    return str(entry.get('stdout') or '')


def _match_entry(entry, norm_file, text):
    """与 Node 侧 preload-mocks.mjs 相同的匹配语义（共享表契约）。"""
    if entry.get('file'):
        if _norm_file(entry.get('file')) != norm_file:
            return False
        return all(str(c) in text for c in entry.get('argvContains') or [])
    kind = entry.get('kind')
    if kind == 'cmd':
        if norm_file not in ('cmd', 'cmd.exe'):
            return False
    elif kind == 'powershell':
        if norm_file not in ('powershell', 'pwsh'):
            return False
    else:
        return False
    return all(str(c) in text for c in entry.get('contains') or [])


def make_fake_subprocess_run(table):
    """按共享 mock 表打桩 subprocess.run；未命中放行真实执行。"""
    exec_entries = table.get('exec') or []

    def fake_run(args, **kw):
        if isinstance(args, (list, tuple)) and args:
            norm_file = _norm_file(args[0])
            text = ' '.join(str(a) for a in args)
        elif isinstance(args, str):
            stripped = _strip_chcp(args.strip())
            norm_file = 'cmd'
            text = stripped
        else:
            norm_file = ''
            text = ''
        for entry in exec_entries:
            if not _match_entry(entry, norm_file, text):
                continue
            if entry.get('timeout'):
                raise subprocess.TimeoutExpired(
                    cmd=args, timeout=kw.get('timeout', 60))
            stdout = _expand_stdout(entry).encode(entry.get('encoding') or 'utf-8')
            stderr = str(entry.get('stderr') or '').encode(entry.get('encoding') or 'utf-8')
            return subprocess.CompletedProcess(
                args, int(entry.get('exitCode') or 0), stdout=stdout, stderr=stderr)
        # 未命中：放行真实子进程（如 prisma/git 等基础设施调用）
        return _STDLIB_RUN(args, **kw)

    return fake_run


def install_subprocess_mock():
    table = load_mock_table()
    subprocess.run = make_fake_subprocess_run(table)


def patch_software_seams(api):
    """software_service 探测 seam 注入（PATH 扫描/winreg 查表 → 共享 mock 表）。"""
    table = load_mock_table()
    which_map = table.get('which') or {}

    def fake_which(name):
        found = which_map.get(str(name or '').lower())
        return found if found else None

    def fake_app_path(name):
        return None

    def fake_uninstall(name):
        return False

    software = getattr(api, '_software', None)
    if software is not None:
        software._path_scanner = fake_which
        software._app_path_lookup = fake_app_path
        software._uninstall_lookup = fake_uninstall


# ---------------------------------------------------------------- 快照
def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(256 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def _sha256_file_normalized(path):
    """P0-1c H1②/③：快照哈希前的环境产物归一（Q4 裁定口径）。

    - 换行归一：运行时文本模式换行翻译（search_replace 的
      atomic_write_text_mode——legacy 钉死行为）是 Windows 平台产物非契约
      语义（macOS 双侧天然一致）；\\r\\n → \\n 后再哈希。
    - worklog 时间戳行掩蔽：_glm_worklog.md 的 '[MM-DD HH:MM]' 前缀是分钟级
      运行时刻，双侧先后执行必差一分钟——行级掩蔽 [TS]。
    - 二进制保护：含 NUL 的文件不归一（字节即语义）。
    """
    with open(path, 'rb') as f:
        raw = f.read()
    if b'\x00' in raw[:8192]:
        return hashlib.sha256(raw).hexdigest()
    data = raw.replace(b'\r\n', b'\n')
    if os.path.basename(path).lower() == '_glm_worklog.md':
        data = re.sub(rb'\[\d{2}-\d{2} \d{2}:\d{2}\]', b'[TS]', data)
    return hashlib.sha256(data).hexdigest()


def snapshot_workspace(ws_dir):
    """工作区树快照：相对路径（'/' 分隔）+ sha256（H1 归一口径），按路径排序。"""
    out = []
    if not os.path.isdir(ws_dir):
        return out
    for base, dirs, files in os.walk(ws_dir):
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(base, name)
            rel = os.path.relpath(full, ws_dir).replace(os.sep, '/')
            out.append({'path': rel, 'sha256': _sha256_file_normalized(full)})
    out.sort(key=lambda x: x['path'])
    return out


def snapshot_probe_files(cfg_dir, fixture):
    """probeConfigFiles：独立配置文件的解析后 JSON（缺失 → None）。"""
    names = ((fixture.get('sideEffects') or {}).get('probeConfigFiles')) or []
    out = {}
    for name in names:
        target = os.path.join(cfg_dir, str(name))
        if not os.path.isfile(target):
            out[str(name)] = None
            continue
        with open(target, encoding='utf-8') as f:
            text = f.read()
        try:
            out[str(name)] = json.loads(text)
        except ValueError:
            out[str(name)] = {'_raw': text}
    return out


def snapshot(root, fixture):
    p = paths_of(root)
    return {
        'workspace': snapshot_workspace(p['ws']),
        'probeFiles': snapshot_probe_files(p['cfg'], fixture),
    }


def cleanup(root):
    """零残留清理：先关日志句柄、把 CWD 移出临时根（Windows 不允许删除进程
    工作目录与被占用文件），再整树删除。"""
    if root and os.environ.get('HARBOR_DIFF_KEEP_TEMP') != '1':
        try:
            import logging
            logging.shutdown()
        except Exception:
            pass
        try:
            os.chdir(tempfile.gettempdir())
        except Exception:
            pass
        shutil.rmtree(str(root), ignore_errors=True)
