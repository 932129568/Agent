# -*- coding: utf-8 -*-
"""外部软件调用服务（实现 v1.8.0 S1：software_list / software_probe /
software_call 三 js_api 的后端注册表与分发层）。

模块职责（架构文档 §2.1 后端模块表「软件注册表 software_service」）：
- 注册表：``~/.glm-chat/software.json`` 独立文件（config.json 零污染铁律）。
  内置预设 git/ffmpeg/7z/python/node/notepad（每预设 actions[] 带 risk 分级
  read/mutate/dangerous + arg JSON Schema）+ 用户自定义条目（``save`` CRUD，
  经 api.rpc 通用分发通道暴露，不进 _V12_EXTRA——契约方法面恰为 3 个）；
  文件只持久化用户条目与探测缓存（probe_cache），预设定义始终以代码为准；
- 探测：PATH 扫描（shutil.which）+ winreg 补探测（App Paths 取 exe 路径 /
  卸载键 DisplayName 判安装）+ ``--version`` 验身份（输出含预设
  version_pattern 才算 probed，否则 version_mismatch=IDENTITY_MISMATCH，
  防同名假冒 R5）；
- 调用分发：
    kind=cli → 沙箱执行（sandbox_service.run_in_sandbox，risk→档位映射
      read→standard / mutate→standard+审计 / dangerous→strict；看门狗超时
      清剿进程树后返回 TIMEOUT + 部分 stdout）；
    kind=gui → CreateProcessW 启动 + EnumWindows/GetWindowTextW 标题核验
      ≤10s（超时 GUI_UNCONFIRMED，error 内附 launched:true）；
    kind=uri → os.startfile 协议启动（启动不可逆，执行前停止才有效）；
- 参数校验：arg JSON Schema 硬校验（type/required/enum/范围/pattern）→
  SCHEMA_INVALID 带 violations[{path,expect,got}] + example（Agent 自校正
  ≤2 次的契约核心）；路径参数过工作区门禁 + realpath 归一（防 ../junction
  越界）；
- 响应三形态（cli/gui/uri）照联调规范 §3.2；stdout/stderr 超长截断落
  toolcache（full_ref 协议同 B 域）；exit_code≠0 仍走成功形状 + exit_code
  字段（保住 Agent 判断力），stderr 命中人话映射时附 error_hint；
- 审计：software_call / software_probe 落 audit_log.jsonl（经 GuardService
  单一口径）；decision=ok/block/killed/unconfirmed。

guard 挂点（A 域批次）：action.risk=dangerous → always 强制确认的前置判定位
在本文件以注释标记（_GUARD_HOOK_CLI），S 域批次只留挂点不接线——联调规范
§3.2 GUARD_DENIED 的触发点在 guard_check 前置，属 A 域接线面；面板测试调用
（source=manual_test，Gap-4）视为用户本人操作，不走 Agent guard 确认链但
照常审计。
"""
import ctypes
import datetime
import json
import os
import re
import shutil
import subprocess
import threading
import time

from ... import paths
from ...fio import atomic_write_json
from ...logging_setup import get_logger

# ---------------- 契约常量（联调规范 §3.2 / §5.3） ----------------
SOFTWARE_FILE = os.path.join(paths.CONFIG_DIR, 'software.json')
GUI_VERIFY_TIMEOUT_S = 10          # FindWindowW 标题核验上限（§3.2 GUI 形态）
PROBE_VERSION_TIMEOUT_S = 15       # --version 验身份单次超时
CLI_TIMEOUT_MIN, CLI_TIMEOUT_MAX = 5, 600   # timeout 参数合法域（§3.2 请求表）
# v1.9.0 M2.11（R32 核对）：输出四连洗（回灌主模型上下文前）——ANSI 转义/
# bidi 双向覆盖/零宽不可见字符/C0 控制符。安全语义：bidi 可伪装文本方向
# （钓鱼 UI），零宽可藏不可见指令——进上下文前必须洗净。保 \t \n（表格/
# 换行可读）；禁改中文内容（零宽剔除后中文语义无损）。
_ANSI_RE = re.compile(r'\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*(\x07|\x1b\\)')
_BIDI_RE = re.compile('[\u200e\u200f\u202a-\u202e\u2066-\u2069]')
_ZERO_WIDTH_RE = re.compile('[\u200b-\u200d\u2060\ufeff]')
_CTRL_RE = re.compile('[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')


def sanitize_text(s):
    """四连洗（顺序固定：ANSI→bidi→零宽→C0；保 \t \n）。"""
    s = str(s if s is not None else '')
    s = _ANSI_RE.sub('', s)
    s = _BIDI_RE.sub('', s)
    s = _ZERO_WIDTH_RE.sub('', s)
    s = _CTRL_RE.sub('', s)
    return s

OUTPUT_TRUNCATE_CHARS = 6000       # stdout/stderr 序列化超限 → toolcache 截断
OUTPUT_HEAD_CHARS = 1500           # 截断保留头段（与 cmd_service 同口径）
OUTPUT_TAIL_CHARS = 800            # 截断保留尾段
KINDS = ('cli', 'gui', 'uri')
RISKS = ('read', 'mutate', 'dangerous')
STATUSES = ('probed', 'missing', 'version_mismatch', 'unknown')

# risk → sandbox 档位映射（§3.2 护栏映射铁律：read→session / mutate→session+审计
# / dangerous→always 强制确认；沙箱侧 read/mutate→standard，dangerous→strict）
_RISK_SANDBOX_PROFILE = {'read': 'standard', 'mutate': 'standard',
                         'dangerous': 'strict'}

# stderr 人话映射（§3.2 NONZERO_EXIT：常见模式 → 可操作提示；命中即附
# error_hint，不改变 ok:true——Agent 仍读得到原始退出码）
_STDERR_HINTS = (
    (re.compile(r'not a git repository|不是\s*git\s*仓库|no git repo', re.I),
     '当前目录不是 Git 仓库：请先在目标目录执行 git init，或切换到仓库内再调用。'),
    (re.compile(r'permission denied|拒绝访问|access is denied|权限不足', re.I),
     '权限不足：可检查文件/目录权限，或改用管理员通道执行。'),
    (re.compile(r'conflict|冲突', re.I),
     '存在冲突：请先解决冲突（git status 查看）再继续提交/合并。'),
    (re.compile(r'usage:|unknown option|unrecognized option|未知选项|用法', re.I),
     '命令用法有误：请按 arg_schema 检查参数（可用 violations/example 自校正）。'),
    (re.compile(r'no such file or directory|找不到文件|系统找不到指定的路径|'
                r'cannot find the path', re.I),
     '文件或目录不存在：请检查路径参数（需在工作区内，Harbor 已做 realpath 归一）。'),
    (re.compile(r'command not found|不是内部或外部命令|不是可运行的程序', re.I),
     '命令不存在：请确认软件已安装且所在目录在 PATH 中。'),
    (re.compile(r'already exists|已存在|file exists', re.I),
     '目标已存在：请更换输出路径或先清理旧文件。'),
    (re.compile(r'timed out|超时', re.I),
     '执行超时：可调大 timeout 参数（5-600 秒）后重试。'),
)

# CLI 执行引用（宿主替换 subprocess.run 时退化桩路径——与 cmd_service._exec 同口径）
_STDLIB_RUN = subprocess.run
_NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)

# {name} 占位符（save 侧 arg_schema 声明校验用；与 _build_argv/_fill_template 同口径）
_PLACEHOLDER_RE = re.compile(r'\{([a-zA-Z_][a-zA-Z0-9_]*)\}')


def _utc_now():
    """ISO8601 UTC（§4.3：全库统一 'Z' 后缀；秒级精度）。"""
    return datetime.datetime.now(datetime.timezone.utc) \
        .replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def _as_dict(params):
    """params 归一：dict 原样 / JSON 字符串解析 / 其他 → {}（防御性，不抛）。"""
    if isinstance(params, dict):
        return params
    if isinstance(params, (str, bytes)):
        try:
            d = json.loads(params)
            return d if isinstance(d, dict) else {}
        except Exception:
            return {}
    return {}


def _error(code, message, hint=None, **extra):
    """统一错误载荷（ok=False + error{code,message,hint?} + 额外字段）。"""
    e = {'code': code, 'message': message}
    if hint:
        e['hint'] = hint
    e.update(extra)
    return {'ok': False, 'error': e}


def _clamp_int(value, default, lo, hi):
    """int 夹逼：None/非数字/非整数值 → default；否则夹到 [lo, hi]。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    try:
        n = int(value)
    except (ValueError, OverflowError):
        return default
    if n != value:
        return default
    return min(max(n, lo), hi)


# ================= 内置预设（架构 §3.2：git/ffmpeg/7z/python/node） =================
def _p_schema(props, required=None):
    """arg JSON Schema 简写构造（type/properties/required）。"""
    s = {'type': 'object', 'properties': props}
    if required:
        s['required'] = list(required)
    return s


_STR = {'type': 'string'}
_PATH = {'type': 'string', 'x-workspace-path': True}

PRESETS = {
    'git': {
        'name': 'git', 'kind': 'cli', 'source': 'preset',
        'exec': 'git', 'version_args': ['--version'],
        'version_pattern': r'git version',
        'website': 'https://git-scm.com/downloads',
        'risk_default': 'read',
        'actions': [
            {'name': 'status', 'risk': 'read', 'argv': ['status'],
             'arg_schema': _p_schema({})},
            {'name': 'diff', 'risk': 'read', 'argv': ['diff'],
             'arg_schema': _p_schema({})},
            {'name': 'log', 'risk': 'read',
             'argv': ['log', '--oneline', '-n', '{max_count}'],
             'arg_schema': _p_schema(
                 {'max_count': {'type': 'integer', 'minimum': 1,
                                'maximum': 100, 'default': 10}})},
            {'name': 'add', 'risk': 'mutate', 'argv': ['add', '{paths}'],
             'arg_schema': _p_schema(
                 {'paths': dict(_STR, minLength=1, maxLength=500,
                                description='要暂存的文件/目录（空格分隔多个）')},
                 required=['paths'])},
            {'name': 'commit', 'risk': 'mutate',
             'argv': ['commit', '-m', '{message}'],
             'arg_schema': _p_schema(
                 {'message': dict(_STR, minLength=1, maxLength=200,
                                  example='fix: 描述本次修改')},
                 required=['message'])},
            {'name': 'clone', 'risk': 'mutate', 'argv': ['clone', '{url}'],
             'arg_schema': _p_schema(
                 {'url': dict(_STR, minLength=8, maxLength=500,
                              pattern=r'^https?://',
                              example='https://github.com/org/repo.git')},
                 required=['url'])},
        ],
    },
    'ffmpeg': {
        'name': 'ffmpeg', 'kind': 'cli', 'source': 'preset',
        'exec': 'ffmpeg', 'version_args': ['-version'],
        'version_pattern': r'ffmpeg version',
        'website': 'https://ffmpeg.org/download.html',
        'risk_default': 'read',
        'actions': [
            {'name': 'version', 'risk': 'read', 'argv': ['-version'],
             'arg_schema': _p_schema({})},
            {'name': 'convert', 'risk': 'mutate',
             'argv': ['-y', '-i', '{input}', '{output}'],
             'arg_schema': _p_schema(
                 {'input': dict(_PATH, description='输入媒体文件（工作区内）'),
                  'output': dict(_PATH, description='输出文件（工作区内）')},
                 required=['input', 'output'])},
        ],
    },
    '7z': {
        'name': '7z', 'kind': 'cli', 'source': 'preset',
        'exec': '7z', 'version_args': [],
        'version_pattern': r'7-Zip',
        'website': 'https://www.7-zip.org/download.html',
        'risk_default': 'read',
        'actions': [
            {'name': 'list', 'risk': 'read', 'argv': ['l', '{archive}'],
             'arg_schema': _p_schema(
                 {'archive': dict(_PATH, description='压缩包路径（工作区内）')},
                 required=['archive'])},
            {'name': 'extract', 'risk': 'mutate',
             'argv': ['x', '-y', '-o{output}', '{archive}'],
             'arg_schema': _p_schema(
                 {'archive': dict(_PATH, description='压缩包路径（工作区内）'),
                  'output': dict(_PATH, description='解压目标目录（工作区内）')},
                 required=['archive', 'output'])},
        ],
    },
    'python': {
        'name': 'python', 'kind': 'cli', 'source': 'preset',
        'exec': 'python', 'version_args': ['--version'],
        'version_pattern': r'Python \d',
        'website': 'https://www.python.org/downloads/',
        'risk_default': 'read',
        'actions': [
            {'name': 'version', 'risk': 'read', 'argv': ['--version'],
             'arg_schema': _p_schema({})},
            {'name': 'pip_list', 'risk': 'read', 'argv': ['-m', 'pip', 'list'],
             'arg_schema': _p_schema({})},
            {'name': 'run_script', 'risk': 'dangerous', 'argv': ['{script}'],
             'arg_schema': _p_schema(
                 {'script': dict(_PATH, description='要执行的 .py 脚本（工作区内，'
                                                    '可执行任意代码——高危）')},
                 required=['script'])},
        ],
    },
    'node': {
        'name': 'node', 'kind': 'cli', 'source': 'preset',
        'exec': 'node', 'version_args': ['--version'],
        'version_pattern': r'v\d+\.\d+',
        'website': 'https://nodejs.org/',
        'risk_default': 'read',
        'actions': [
            {'name': 'version', 'risk': 'read', 'argv': ['--version'],
             'arg_schema': _p_schema({})},
            {'name': 'run_script', 'risk': 'dangerous', 'argv': ['{script}'],
             'arg_schema': _p_schema(
                 {'script': dict(_PATH, description='要执行的 .js 脚本（工作区内，'
                                                    '可执行任意代码——高危）')},
                 required=['script'])},
        ],
    },
    'notepad': {
        'name': 'notepad', 'kind': 'gui', 'source': 'preset',
        'exec': 'notepad', 'version_args': [],
        'version_pattern': r'',
        'expected_title': r'Notepad|记事本|无标题',
        'website': 'https://apps.microsoft.com/',
        'risk_default': 'read',
        'actions': [
            {'name': 'open', 'risk': 'read', 'argv': ['{path}'],
             'arg_schema': _p_schema(
                 {'path': dict(_PATH, description='要打开的文本文件（工作区内）')},
                 required=['path'])},
        ],
    },
}


# ================= arg JSON Schema 校验（§3.2 SCHEMA_INVALID 自校正回显） =================
_TYPE_LABELS = {'string': 'string', 'integer': 'integer', 'number': 'number',
                'boolean': 'boolean', 'array': 'array', 'object': 'object'}
_PY_TYPES = {'string': str, 'integer': int, 'number': (int, float),
             'boolean': bool, 'array': list, 'object': dict}


def _summarize(value):
    """violations.got：实际类型或值摘要（人话，≤40 字符）。"""
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'boolean(%s)' % value
    if isinstance(value, (int, float)):
        return '%s(%s)' % (type(value).__name__, value)
    if isinstance(value, str):
        return 'string(%r)' % (value[:24] + ('…' if len(value) > 24 else ''))
    if isinstance(value, list):
        return 'array[%d]' % len(value)
    if isinstance(value, dict):
        return 'object{}'
    return type(value).__name__


def _expect_text(spec):
    """violations.expect：人话期望（类型(必填/范围/枚举)）。"""
    t = _TYPE_LABELS.get(spec.get('type'), spec.get('type') or 'value')
    bits = [t]
    if spec.get('minLength') is not None or spec.get('maxLength') is not None:
        bits.append('长度 %s-%s' % (spec.get('minLength', 0),
                                    spec.get('maxLength', '∞')))
    if spec.get('minimum') is not None or spec.get('maximum') is not None:
        bits.append('范围 %s-%s' % (spec.get('minimum', '-∞'),
                                    spec.get('maximum', '∞')))
    if spec.get('enum'):
        bits.append('合法值 %s' % '/'.join(str(e) for e in spec['enum']))
    return '%s(必填)' % ' '.join(bits) if spec.get('_required') else ' '.join(bits)


def validate_args(schema, args):
    """arg JSON Schema 硬校验（纯函数，可单测）。

    覆盖：type（含 bool≠int 陷阱）/ required / enum / minimum-maximum /
    minLength-maxLength / pattern。返回 violations[{path,expect,got}]；
    空列表 = 通过。路径门禁（x-workspace-path）不在此层——由调用方
    software_call 在工作区归一后执行（需要根路径）。

    畸形 schema 防御（消费端）：schema 非对象 / properties 非对象 /
    required 非数组 / 单个 property 定义非对象 → 回落空集不抛——
    非法定义由 save 侧入拒绝（注册表文件被手改时此处保底不炸管线）。
    """
    violations = []
    schema = schema if isinstance(schema, dict) else {}
    props = schema.get('properties') or {}
    if not isinstance(props, dict):
        props = {}
    required = schema.get('required') or []
    if not isinstance(required, (list, tuple)):
        required = []
    if not isinstance(args, dict):
        return [{'path': '(root)', 'expect': 'object',
                 'got': _summarize(args)}]
    for name in required:
        v = args.get(name)
        if v is None or (isinstance(v, str) and not v.strip()):
            spec = props.get(name) if isinstance(props.get(name), dict) else {}
            spec = dict(spec)
            spec['_required'] = True
            violations.append({'path': name, 'expect': _expect_text(spec),
                               'got': _summarize(v)})
    for name, spec in props.items():
        if not isinstance(spec, dict):
            continue          # 畸形 property 定义：跳过（save 侧已拒）
        if name not in args:
            continue
        v = args[name]
        if v is None:
            continue
        t = spec.get('type')
        if t in _PY_TYPES:
            if t in ('integer', 'number') and isinstance(v, bool):
                violations.append({'path': name, 'expect': _expect_text(spec),
                                   'got': _summarize(v)})
                continue
            if not isinstance(v, _PY_TYPES[t]):
                violations.append({'path': name, 'expect': _expect_text(spec),
                                   'got': _summarize(v)})
                continue
        if t == 'string':
            s = str(v)
            if spec.get('minLength') is not None and len(s) < spec['minLength']:
                violations.append({'path': name,
                                   'expect': _expect_text(spec),
                                   'got': _summarize(v)})
                continue
            if spec.get('maxLength') is not None and len(s) > spec['maxLength']:
                violations.append({'path': name,
                                   'expect': _expect_text(spec),
                                   'got': _summarize(v)})
                continue
            pat = spec.get('pattern')
            if pat:
                try:
                    if not re.search(pat, s):
                        violations.append({'path': name,
                                           'expect': _expect_text(spec),
                                           'got': _summarize(v)})
                        continue
                except re.error:
                    pass
            if spec.get('enum') is not None and s not in [str(e) for e in spec['enum']]:
                violations.append({'path': name, 'expect': _expect_text(spec),
                                   'got': _summarize(v)})
                continue
        if t in ('integer', 'number'):
            if spec.get('minimum') is not None and v < spec['minimum']:
                violations.append({'path': name, 'expect': _expect_text(spec),
                                   'got': _summarize(v)})
                continue
            if spec.get('maximum') is not None and v > spec['maximum']:
                violations.append({'path': name, 'expect': _expect_text(spec),
                                   'got': _summarize(v)})
                continue
            if spec.get('enum') is not None and v not in spec['enum']:
                violations.append({'path': name, 'expect': _expect_text(spec),
                                   'got': _summarize(v)})
                continue
    return violations


def gen_example(schema):
    """按 arg_schema 生成正确示例（必填项填默认值/示例/类型占位——§3.2）。

    畸形 schema 防御（同 validate_args 口径）：非对象 / properties 非对象 /
    单个 property 定义非对象 → 按空处理，不抛（example 只服务于自校正回显，
    坏定义不应把错误路径本身打炸）。
    """
    schema = schema if isinstance(schema, dict) else {}
    props = schema.get('properties') or {}
    if not isinstance(props, dict):
        props = {}
    required = schema.get('required') or []
    if not isinstance(required, (list, tuple)):
        required = []
    out = {}
    for name in required:
        spec = props.get(name)
        spec = spec if isinstance(spec, dict) else {}
        if 'default' in spec:
            out[name] = spec['default']
        elif 'example' in spec:
            out[name] = spec['example']
        elif spec.get('enum'):
            out[name] = spec['enum'][0]
        else:
            t = spec.get('type')
            if t == 'string':
                out[name] = ('工作区内相对路径，如 src/main.py'
                             if spec.get('x-workspace-path') else '文本')
            elif t == 'integer':
                out[name] = int(spec.get('minimum', 0) or 0)
            elif t == 'number':
                out[name] = float(spec.get('minimum', 0) or 0)
            elif t == 'boolean':
                out[name] = False
            elif t == 'array':
                out[name] = []
            elif t == 'object':
                out[name] = {}
            else:
                out[name] = ''
    return out


def stderr_hint(text):
    """stderr 人话映射（§3.2：命中常见模式 → 可操作提示；未命中 None）。"""
    s = str(text or '')
    if not s:
        return None
    for pat, hint in _STDERR_HINTS:
        if pat.search(s):
            return hint
    return None


# ================= Win32 GUI 启动与窗口标题核验（ctypes，纯 Win 路径） =================
def _declare_win32_gui():
    """集中声明 GUI 相关 Win32 签名（C2 纪律：句柄宽度/字符串缓冲显式声明）。"""
    if not hasattr(ctypes, 'windll'):
        return False
    try:
        from ctypes import wintypes
        k32 = ctypes.windll.kernel32
        u32 = ctypes.windll.user32
        k32.CreateProcessW.restype = wintypes.BOOL
        k32.CreateProcessW.argtypes = [
            wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.LPVOID, wintypes.LPVOID,
            wintypes.BOOL, wintypes.DWORD, wintypes.LPVOID, wintypes.LPCWSTR,
            ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p)]
        k32.CloseHandle.restype = wintypes.BOOL
        k32.CloseHandle.argtypes = [wintypes.HANDLE]
        k32.GetLastError.restype = wintypes.DWORD
        k32.GetLastError.argtypes = []
        u32.EnumWindows.restype = wintypes.BOOL
        u32.EnumWindows.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        u32.GetWindowTextW.restype = ctypes.c_int
        u32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR,
                                       ctypes.c_int]
        return True
    except Exception:
        return False


class _STARTUPINFOW(ctypes.Structure):
    _fields_ = [('cb', ctypes.c_ulong), ('lpReserved', ctypes.c_wchar_p),
                ('lpDesktop', ctypes.c_wchar_p), ('lpTitle', ctypes.c_wchar_p),
                ('dwX', ctypes.c_ulong), ('dwY', ctypes.c_ulong),
                ('dwXSize', ctypes.c_ulong), ('dwYSize', ctypes.c_ulong),
                ('dwXCountChars', ctypes.c_ulong),
                ('dwYCountChars', ctypes.c_ulong),
                ('dwFillAttribute', ctypes.c_ulong),
                ('dwFlags', ctypes.c_ulong), ('wShowWindow', ctypes.c_ushort),
                ('cbReserved2', ctypes.c_ushort),
                ('lpReserved2', ctypes.c_void_p),
                ('hStdInput', ctypes.c_void_p),
                ('hStdOutput', ctypes.c_void_p),
                ('hStdError', ctypes.c_void_p)]


class _PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [('hProcess', ctypes.c_void_p),
                ('hThread', ctypes.c_void_p),
                ('dwProcessId', ctypes.c_ulong),
                ('dwThreadId', ctypes.c_ulong)]


# EnumWindows 回调原型（C2 纪律：显式声明，防默认 c_int 截断）
_WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p,
                                  ctypes.c_void_p)


def _find_window_title(pattern):
    """EnumWindows + GetWindowTextW：返回首个匹配 pattern 的顶层窗口标题。"""
    u32 = ctypes.windll.user32
    found = []

    @_WNDENUMPROC
    def _cb(hwnd, _lparam):
        buf = ctypes.create_unicode_buffer(512)
        u32.GetWindowTextW(hwnd, buf, 512)
        title = buf.value or ''
        if title and (pattern is None or pattern.search(title)):
            found.append(title)
            return False      # 命中即停枚举
        return True

    try:
        u32.EnumWindows(_cb, 0)
    except Exception:
        return None
    return found[0] if found else None


def _shell_execute(uri):
    """ShellExecuteW 协议启动（os.startfile 不可用时的回退）。

    取代 ``cmd /c start``：后者把 uri 拼进行命令行，含 ``&``/``|`` 等元字符时
    会执行额外命令（命令行注入面）；ShellExecuteW 按结构化参数交 shell，
    无命令行解析注入面。

    Returns:
        bool：True = 已交 shell 启动。ShellExecuteW 返回 HINSTANCE——≤32 为
        SE_ERR_* 错误码，>32 为实例句柄；restype 显式声明 HINSTANCE 防默认
        c_int 截断把 64 位句柄误判成错误码（同 _declare_win32_gui 口径）。
    """
    if not hasattr(ctypes, 'windll'):
        return False
    try:
        from ctypes import wintypes
        shell32 = ctypes.windll.shell32
        shell32.ShellExecuteW.restype = wintypes.HINSTANCE
        shell32.ShellExecuteW.argtypes = [wintypes.HWND, wintypes.LPCWSTR,
                                          wintypes.LPCWSTR, wintypes.LPCWSTR,
                                          wintypes.LPCWSTR, wintypes.INT]
        rc = shell32.ShellExecuteW(None, 'open', str(uri), None, None, 1)
        return int(rc) > 32
    except Exception:
        return False


def default_gui_launcher(exe, argv, expected_title, timeout=GUI_VERIFY_TIMEOUT_S,
                         clock=None):
    """GUI 启动 + 标题核验（默认实现；测试可注入替身）。

    Returns:
        dict: ``{launched, window_verified, window_title?}`` 或
        ``{launched: False, error}``（非 Windows / CreateProcessW 失败）。
    """
    clock = clock or time.time
    if not hasattr(ctypes, 'windll'):
        return {'launched': False, 'error': '非 Windows 平台，GUI 启动不可用'}
    if not _declare_win32_gui():
        return {'launched': False, 'error': 'Win32 签名声明失败'}
    k32 = ctypes.windll.kernel32
    app = str(exe or '')
    # list2cmdline：含空格/引号的参数按 Windows 命令行规则补引号——裸 join 会把
    # "C:\My Dir\a.txt" 拆成两个参数（参数错位 + 经 GUI 动作注入额外参数）
    cmdline = subprocess.list2cmdline([app] + [str(a) for a in (argv or [])])
    si = _STARTUPINFOW()
    si.cb = ctypes.sizeof(si)
    pi = _PROCESS_INFORMATION()
    cmd_buf = ctypes.create_unicode_buffer(cmdline)
    ok = k32.CreateProcessW(app, cmd_buf, None, None, False, 0, None, None,
                            ctypes.byref(si), ctypes.byref(pi))
    if not ok:
        code = k32.GetLastError()
        return {'launched': False,
                'error': 'CreateProcessW 失败（错误 %d）' % code}
    for h in (pi.hThread, pi.hProcess):
        if h:
            try:
                k32.CloseHandle(h)
            except Exception:
                pass
    pattern = None
    if expected_title:
        try:
            pattern = re.compile(str(expected_title), re.IGNORECASE)
        except re.error:
            pattern = None
    deadline = clock() + max(1, int(timeout or GUI_VERIFY_TIMEOUT_S))
    while clock() < deadline:
        title = _find_window_title(pattern)
        if title:
            return {'launched': True, 'window_verified': True,
                    'window_title': title}
        time.sleep(0.25)
    return {'launched': True, 'window_verified': False}


# ================= winreg 补探测（默认实现；测试可注入替身） =================
def winreg_app_path(exe):
    """App Paths 补探测：HKLM/HKCU App Paths\\<exe>.exe 默认值取 exe 全路径。"""
    if not hasattr(ctypes, 'windll') and os.name != 'nt':
        return None
    try:
        import winreg
    except ImportError:
        return None
    for root in (getattr(winreg, 'HKEY_LOCAL_MACHINE', None),
                 getattr(winreg, 'HKEY_CURRENT_USER', None)):
        if root is None:
            continue
        try:
            key = winreg.OpenKey(
                root, r'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths'
                      r'\%s.exe' % str(exe))
            val, _ = winreg.QueryValueEx(key, '')
            if val and os.path.exists(str(val)):
                return str(val)
        except OSError:
            continue
        except Exception:
            continue
    return None


def winreg_installed_by_name(name):
    """卸载键补探测：DisplayName 含 name → 视为已安装（PATH 外安装场景）。"""
    try:
        import winreg
    except ImportError:
        return False
    needle = str(name or '').strip().lower()
    if not needle:
        return False
    roots = (r'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
             r'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
    for hive in (getattr(winreg, 'HKEY_LOCAL_MACHINE', None),
                 getattr(winreg, 'HKEY_CURRENT_USER', None)):
        if hive is None:
            continue
        for sub in roots:
            try:
                base = winreg.OpenKey(hive, sub)
            except OSError:
                continue
            except Exception:
                continue
            try:
                i = 0
                while True:
                    try:
                        subname = winreg.EnumKey(base, i)
                    except OSError:
                        break
                    i += 1
                    try:
                        k = winreg.OpenKey(base, subname)
                        disp, _ = winreg.QueryValueEx(k, 'DisplayName')
                        if needle in str(disp).lower():
                            return True
                    except OSError:
                        continue
                    except Exception:
                        continue
            finally:
                try:
                    winreg.CloseKey(base)
                except Exception:
                    pass
    return False


class SoftwareService:
    """外部软件调用服务（进程内单例，由 Api 装配；测试可注入全部替身）。

    三方法契约（联调规范 §3.2 S 组）：
    - ``software_list(status)`` → 注册表列表（status 过滤；读取类不落审计）；
    - ``software_probe(name)`` → PATH/winreg 探测 + --version 验身份；
    - ``software_call(software, action, args, timeout)`` → 三形态响应。
    """

    def __init__(self, registry_path=None, toolcache=None, guard=None,
                 sandbox=None, ws_root=None, clock=None, runner=None,
                 gui_launcher=None, path_scanner=None, app_path_lookup=None,
                 uninstall_lookup=None):
        """Args:
            registry_path: software.json 路径（缺省 ``~/.glm-chat/software.json``）。
            toolcache: 截断落盘服务（缺省 ToolcacheService(do_cleanup=False)）。
            guard: 审计写入者（缺省 GuardService()；Api 注入同一实例）。
            sandbox: 沙箱门面（缺省 SandboxService()；limits_for_profile 取档位限制）。
            ws_root: 工作区根（字符串或 callable；路径参数门禁基准）。
            clock: 单调时钟（测试注入假时钟；缺省 time.monotonic）。
            runner: CLI 执行替身 ``fn(argv, cwd, timeout, limits) -> dict``。
            gui_launcher: GUI 启动替身 ``fn(exe, argv, expected_title, timeout)``。
            path_scanner: PATH 扫描替身（缺省 shutil.which）。
            app_path_lookup: winreg App Paths 替身（缺省 winreg_app_path）。
            uninstall_lookup: winreg 卸载键替身（缺省 winreg_installed_by_name）。
        """
        self._log = get_logger()
        self._path = registry_path or SOFTWARE_FILE
        self._lock = threading.RLock()
        if toolcache is None:
            from ..workspace.toolcache_service import ToolcacheService
            toolcache = ToolcacheService(do_cleanup=False)
        self._toolcache = toolcache
        if guard is None:
            from ..security.guard_service import GuardService
            guard = GuardService()
        self._guard = guard
        self._sandbox = sandbox
        self._ws_root = ws_root
        self._clock = clock or time.monotonic
        self._runner = runner or self._run_cli
        self._gui_launcher = gui_launcher or default_gui_launcher
        self._path_scanner = path_scanner or shutil.which
        self._app_path_lookup = app_path_lookup or winreg_app_path
        self._uninstall_lookup = uninstall_lookup or winreg_installed_by_name
        # 注册表内存态：presets（代码为准）⊕ user（文件）⊕ probe_cache（文件）
        self._user = {}
        self._probe_cache = {}
        self._registry = {}
        self._load()

    # ================================================== 注册表读写
    def _load(self):
        """software.json 加载：user 条目 + probe_cache 叠加到内置预设之上。

        文件缺失 → 纯预设（status=unknown）；损坏 → 警告后按纯预设（不静默
        吞数据损坏——与 hybrid.json 的 .corrupt 备份口径一致，此处仅告警，
        由用户显式 save 时重写修复）。
        """
        data = {}
        try:
            with open(self._path, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except FileNotFoundError:
            data = {}
        except Exception as e:
            self._log.warning('软件注册表加载失败，按内置预设处理: %r', e)
            data = {}
        if isinstance(data, dict):
            user = data.get('user')
            if isinstance(user, dict):
                self._user = {str(k): self._normalize(v, source='user')
                              for k, v in user.items() if isinstance(v, dict)}
            cache = data.get('probe_cache')
            if isinstance(cache, dict):
                self._probe_cache = {
                    str(k): v for k, v in cache.items() if isinstance(v, dict)}
        self._rebuild()

    def _rebuild(self):
        """presets ⊕ user ⊕ probe_cache → 内存注册表（preset 可被 user 覆盖）。"""
        reg = {}
        for name, preset in PRESETS.items():
            reg[name] = json.loads(json.dumps(preset))
        for name, entry in self._user.items():
            base = reg.get(name)
            if base is not None:
                merged = json.loads(json.dumps(base))
                merged.update(entry)
                # R37 修复（K7）：user 条目经 _normalize 恒带 actions=[]——只想改
                # exec 的用户会因空列表整键覆盖而清空预设动作面（software_call
                # 全灭）。语义改为：user.actions 非空才覆盖；空 = 继承预设。
                if not entry.get('actions') and base.get('actions'):
                    merged['actions'] = json.loads(json.dumps(base['actions']))
                reg[name] = merged
            else:
                reg[name] = json.loads(json.dumps(entry))
        for name, entry in reg.items():
            entry['name'] = name
            entry['source'] = 'preset' if name in PRESETS and \
                name not in self._user else 'user'
            entry['status'] = 'unknown'
            entry['version'] = None
            entry['probed_at'] = None
            cached = self._probe_cache.get(name)
            if cached:
                st = cached.get('status')
                if st in STATUSES and st != 'unknown':
                    entry['status'] = st
                    ver = cached.get('version')
                    entry['version'] = str(ver) if ver else None
                    try:
                        entry['probed_at'] = float(cached.get('probed_at'))
                    except (TypeError, ValueError):
                        entry['probed_at'] = None
        self._registry = reg

    def _persist(self):
        """落盘 software.json（只写 user + probe_cache；预设定义不入库）。"""
        try:
            os.makedirs(os.path.dirname(self._path), exist_ok=True)
            atomic_write_json(self._path, {'version': 1,
                                           'user': self._user,
                                           'probe_cache': self._probe_cache},
                              indent=2)
            return True
        except Exception as e:
            self._log.warning('软件注册表落盘失败: %r', e)
            return False

    @staticmethod
    def _normalize(raw, source):
        """用户条目归一（缺省补安全默认；kind/risk 非法 → 拒绝由 save 把关）。"""
        e = dict(raw or {})
        e['source'] = source
        e.setdefault('kind', 'cli')
        e.setdefault('risk_default', 'read')
        e.setdefault('actions', [])
        e.setdefault('version_args', [])
        e.setdefault('version_pattern', '')
        e.setdefault('website', '')
        e.setdefault('exec', '')
        e.setdefault('uri_template', '')
        e.setdefault('expected_title', '')
        return e

    def save(self, name, entry):
        """用户自定义条目 CRUD 之写（经 api.rpc 通用通道暴露，非 js_api 契约方法）。

        Args:
            name: 注册名（小写字母数字-_）。
            entry: dict（kind/exec|uri_template/actions/...；action.argv 支持
                ``{arg}`` 占位，arg_schema 为简版 JSON Schema）。

        Returns:
            dict: ``{ok: True, name}`` 或 ``{error: 人话}``（名校验/结构非法）。
        """
        name = str(name or '').strip().lower()
        if not re.match(r'^[a-z0-9][a-z0-9._-]{0,63}$', name):
            return {'error': '软件名需为 1-64 位小写字母/数字/.-_（且以字母数字开头）'}
        if not isinstance(entry, dict):
            return {'error': '条目必须是 JSON 对象'}
        kind = str(entry.get('kind') or 'cli').strip().lower()
        if kind not in KINDS:
            return {'error': 'kind 仅支持 %s' % '/'.join(KINDS)}
        # v1.8.0 §4.4：用户自定义默认 mutate 起步（read 太宽——自定义软件
        # 未经预设审核，保守从 mutate 起，用户可在设置调整）
        risk = str(entry.get('risk_default') or 'mutate').strip().lower()
        if risk not in RISKS:
            return {'error': 'risk_default 仅支持 %s' % '/'.join(RISKS)}
        if kind == 'uri':
            tpl = str(entry.get('uri_template') or '').strip()
            if not tpl:
                return {'error': 'uri 类型需要 uri_template（如 https://{host}/{path}）'}
        else:
            if not str(entry.get('exec') or '').strip():
                return {'error': '%s 类型需要 exec（可执行名或绝对路径）' % kind}
        actions = entry.get('actions')
        if not isinstance(actions, list) or not actions:
            return {'error': '至少需要一个 action'}
        norm_actions = []
        seen = set()
        declared = set()          # 各 action arg_schema.properties 键并集
        for act in actions:
            if not isinstance(act, dict):
                return {'error': 'action 必须是对象'}
            aname = str(act.get('name') or '').strip()
            if not aname or aname in seen:
                return {'error': 'action 名不能为空且不可重复: %r' % aname}
            seen.add(aname)
            arisk = str(act.get('risk') or 'mutate').strip().lower()
            if arisk not in RISKS:
                return {'error': 'action %s 的 risk 仅支持 %s'
                        % (aname, '/'.join(RISKS))}
            schema = act.get('arg_schema') or {'type': 'object',
                                               'properties': {}}
            if not isinstance(schema, dict):
                return {'error': 'action %s 的 arg_schema 必须是对象' % aname}
            sprops = schema.get('properties')
            if sprops is None:
                sprops = {}
            elif not isinstance(sprops, dict):
                return {'error': 'action %s 的 arg_schema.properties '
                        '必须是对象' % aname}
            sreq = schema.get('required')
            if sreq is not None and not isinstance(sreq, (list, tuple)):
                return {'error': 'action %s 的 arg_schema.required '
                        '必须是数组' % aname}
            declared.update(sprops)
            item = {'name': aname, 'risk': arisk, 'arg_schema': schema}
            if kind == 'uri':
                item['uri_template'] = str(act.get('uri_template')
                                           or entry.get('uri_template') or '')
                if not item['uri_template']:
                    return {'error': 'uri action %s 需要 uri_template' % aname}
            else:
                argv = act.get('argv')
                if not isinstance(argv, list) or not argv:
                    return {'error': 'action %s 需要 argv 模板（字符串数组，'
                                     '支持 {arg} 占位）' % aname}
                item['argv'] = [str(a) for a in argv]
                # 占位符必须已在 arg_schema.properties 声明：未声明的 {key}
                # 会绕过 schema 校验直达命令行（_build_argv 缺失即 KeyError
                # 的根源）——缺失即拒，回显动作名与占位符名
                for token in item['argv']:
                    for key in _PLACEHOLDER_RE.findall(token):
                        if key not in sprops:
                            return {'error': 'action %s 的 argv 占位符 '
                                    '{%s} 未在 arg_schema.properties 中声明'
                                    % (aname, key)}
            norm_actions.append(item)
        # version_args 占位符同口径：探测期无参数可填，未声明的 {key} 会原样
        # 漏进命令行——必须已在某 action 的 arg_schema.properties 声明
        for token in [str(a) for a in (entry.get('version_args') or [])]:
            for key in _PLACEHOLDER_RE.findall(token):
                if key not in declared:
                    return {'error': 'version_args 占位符 {%s} 未在 '
                            'arg_schema.properties 中声明' % key}
        with self._lock:
            self._user[name] = self._normalize({
                'name': name, 'kind': kind, 'risk_default': risk,
                'exec': str(entry.get('exec') or '').strip(),
                'uri_template': str(entry.get('uri_template') or '').strip(),
                'version_args': [str(a) for a in (entry.get('version_args')
                                                  or [])],
                'version_pattern': str(entry.get('version_pattern') or ''),
                'expected_title': str(entry.get('expected_title') or ''),
                'website': str(entry.get('website') or '').strip(),
                'actions': norm_actions,
            }, source='user')
            # 定义变更 → 旧探测缓存失效（强制重新验身份）
            self._probe_cache.pop(name, None)
            self._rebuild()
            ok = self._persist()
        return {'ok': True, 'name': name} if ok else \
            {'error': '写入 software.json 失败'}

    def remove(self, name):
        """用户自定义条目 CRUD 之删（预设不可删）。Returns {ok, removed}。"""
        name = str(name or '').strip().lower()
        with self._lock:
            if name not in self._user:
                return {'ok': True, 'removed': False}
            self._user.pop(name, None)
            self._probe_cache.pop(name, None)
            self._rebuild()
            self._persist()
            return {'ok': True, 'removed': True}

    # ================================================== software_list（S1）
    def action_risk(self, software, action):
        """查询 action 的 risk 分级（api 层 guard force_always 判定用）。

        v1.8.0 §4.4：dangerous 动作（git push --force/删除类）强制 always 档，
        与 op 级 session 档正交——本查询供 enforce_exec 置 force_always。
        未注册软件/动作 → ''（调用方按 session 档走）。
        """
        with self._lock:
            entry = self._registry.get(str(software or '').strip().lower())
        if not entry:
            return ''
        for a in entry.get('actions') or []:
            if a.get('name') == action:
                return str(a.get('risk') or '')
        return ''

    def software_list(self, status='all'):
        """实现 v1.8.0 S1：注册表列表（联调规范 §3.2 software_list）。

        Args:
            status: ``all``（缺省，含 unknown）/ ``probed`` / ``missing``
                （missing + version_mismatch——不可用即「缺」）。

        Returns:
            dict: ``{ok, software:[{name, kind, status, version?, source,
            risk_default, actions:[{name, risk, arg_schema}]}]}``。
            读取类不落审计（面板打开/探测后 refresh）。
        """
        st = str(status or 'all').strip().lower()
        if st not in ('all', 'probed', 'missing'):
            st = 'all'
        with self._lock:
            items = []
            for name in sorted(self._registry):
                e = self._registry[name]
                if st == 'probed' and e['status'] != 'probed':
                    continue
                if st == 'missing' and e['status'] not in ('missing',
                                                           'version_mismatch'):
                    continue
                item = {
                    'name': name, 'kind': e['kind'], 'status': e['status'],
                    'source': e['source'], 'risk_default': e['risk_default'],
                    'actions': [{'name': a['name'], 'risk': a['risk'],
                                 'arg_schema': a.get('arg_schema') or {}}
                                for a in e.get('actions') or []],
                }
                if e.get('version'):
                    item['version'] = e['version']
                items.append(item)
        return {'ok': True, 'software': items}

    # ================================================== software_probe（S2）
    def software_probe(self, name=None):
        """实现 v1.8.0 S1：探测（PATH 扫描 + winreg 补探测 + --version 验身份）。

        Args:
            name: 缺省 = 全部；传入时需已注册（未注册 → BAD_PARAMS +
                hint 回显可用名）。

        Returns:
            dict: ``{ok, probed:[{name, status, version?}], elapsed_ms}``；
            审计 op=software_probe（decision=unknown 仅 PATH 扫描失败场景）。
        """
        t0 = self._clock()
        with self._lock:
            if name:
                key = str(name).strip().lower()
                if key not in self._registry:
                    return _error('BAD_PARAMS',
                                  '未注册的软件: %r' % name,
                                  '可用软件: %s' % '/'.join(
                                      sorted(self._registry)))
                targets = [key]
            else:
                targets = sorted(self._registry)
        probed = []
        for key in targets:
            r = self._probe_one(key)
            probed.append(r)
        with self._lock:
            self._persist()
        elapsed = int((self._clock() - t0) * 1000)
        unknown = [p for p in probed if p['status'] == 'unknown']
        self._audit('software_probe',
                    {'names': ','.join(targets)[:200],
                     'probed': sum(1 for p in probed if p['status'] == 'probed'),
                     'missing': sum(1 for p in probed if p['status'] == 'missing'),
                     'mismatch': sum(1 for p in probed
                                     if p['status'] == 'version_mismatch')},
                    'probe', 'unknown' if unknown and len(unknown) == len(probed)
                    else 'ok')
        out = []
        for p in probed:
            item = {'name': p['name'], 'status': p['status']}
            if p.get('version'):
                item['version'] = p['version']
            out.append(item)
        return {'ok': True, 'probed': out, 'elapsed_ms': elapsed}

    def _probe_one(self, name):
        """单软件探测：解析可执行 → --version 验身份 → 更新注册表与缓存。

        三态判定：
        - PATH/winreg 均找不到 → missing（NOT_INSTALLED 的错误源）；
        - 找到且 version_pattern 命中输出 → probed（version 提取）；
        - 找到但输出不含身份特征 → version_mismatch（IDENTITY_MISMATCH
          的错误源，防同名假冒 R5）；
        - GUI 等无 version_args 的条目 → 找到即 probed（version=None）。
        """
        with self._lock:
            entry = self._registry.get(name)
            if entry is None:
                return {'name': name, 'status': 'unknown'}
            entry = json.loads(json.dumps(entry))
        kind = str(entry.get('kind') or 'cli')
        if kind == 'uri':
            # URI 形态无「安装」概念：核验协议是否已注册（HKCR\<scheme>）
            m = re.match(r'^([a-zA-Z][a-zA-Z0-9+.-]*):',
                         str(entry.get('uri_template') or ''))
            scheme = m.group(1).lower() if m else ''
            status = 'probed' if scheme and \
                self._uri_protocol_registered(scheme) else 'missing'
            version = None
            with self._lock:
                cur = self._registry.get(name)
                if cur is not None:
                    cur['status'] = status
                    cur['version'] = None
                    cur['probed_at'] = time.time()
                self._probe_cache[name] = {'status': status, 'version': None,
                                           'probed_at': time.time()}
            return {'name': name, 'status': status, 'version': None}
        exe = self._resolve_executable(entry)
        status, version = 'missing', None
        if exe:
            vargs = entry.get('version_args') or []
            pattern = str(entry.get('version_pattern') or '')
            if vargs and pattern:
                out = self._version_output(exe, vargs)
                try:
                    rx = re.compile(pattern, re.IGNORECASE)
                except re.error:
                    rx = None
                if rx is not None and rx.search(out or ''):
                    status = 'probed'
                    m = re.search(r'(\d+\.\d+(?:\.\d+)*)', out or '')
                    version = m.group(1) if m else None
                else:
                    status = 'version_mismatch'
            elif vargs and not pattern:
                # 有 version_args 无 pattern：跑通即信（退出码 0），提取版本号
                out = self._version_output(exe, vargs)
                status = 'probed'
                m = re.search(r'(\d+\.\d+(?:\.\d+)*)', out or '')
                version = m.group(1) if m else None
            else:
                # 卸载键补判：PATH 外安装（App Paths 已解析到 exe 即已安装）
                status = 'probed'
                version = None
        else:
            # PATH 与 App Paths 都失败时，卸载键 DisplayName 命中仍记 missing
            # （未解析到可执行——software_call 无法执行；UI 提示安装）
            status = 'missing'
        with self._lock:
            cur = self._registry.get(name)
            if cur is not None:
                cur['status'] = status
                cur['version'] = version
                cur['probed_at'] = time.time()
            self._probe_cache[name] = {'status': status,
                                       'version': version,
                                       'probed_at': time.time()}
        return {'name': name, 'status': status, 'version': version}

    def _resolve_executable(self, entry):
        """解析可执行：绝对路径 → PATH 扫描 → winreg App Paths。"""
        exe = str(entry.get('exec') or '').strip()
        if not exe:
            return None
        if os.path.isabs(exe):
            return exe if os.path.exists(exe) else None
        try:
            found = self._path_scanner(exe)
        except Exception:
            found = None
        if found:
            return str(found)
        try:
            found = self._app_path_lookup(exe)
        except Exception:
            found = None
        if found:
            return str(found)
        return None

    @staticmethod
    def _uri_protocol_registered(scheme):
        """URI 协议注册核验（HKCR\\<scheme>；非 Windows 或无法核验 → 按已注册，
        不因核验能力缺失把用户条目误判为不可用）。"""
        try:
            import winreg
        except ImportError:
            return True
        try:
            winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, str(scheme))
            return True
        except OSError:
            return False
        except Exception:
            return True

    def _version_output(self, exe, version_args):
        """跑 version 命令取输出（探测用；stdout+stderr 合并，小超时）。

        探测同样走沙箱（read 档）：version 子进程与调用路径同款限制——
        未沙箱化的探测可被伪装的「已安装软件」利用来执行任意命令
        （find→version 两步都过沙箱，fail-closed 口径一致）。
        """
        try:
            r = self._runner([str(exe)] + [str(a) for a in version_args],
                             None, PROBE_VERSION_TIMEOUT_S,
                             self._sandbox_limits('read'))
        except Exception as e:
            self._log.debug('version 探测执行失败: %r', e)
            return ''
        if not isinstance(r, dict) or r.get('error'):
            return ''
        return self._dec(r.get('stdout')) + '\n' + self._dec(r.get('stderr'))

    # ================================================== software_call（S3）
    def software_call(self, params):
        """实现 v1.8.0 S1：外部软件调用三形态（联调规范 §3.2 software_call）。

        管线：注册表校验（UNKNOWN_SOFTWARE）→ action 校验（BAD_PARAMS +
        hint 回显可用 actions）→ 安装/身份校验（NOT_INSTALLED /
        IDENTITY_MISMATCH；unknown 先按需探测）→ arg JSON Schema 硬校验
        （SCHEMA_INVALID + violations/example）→ 路径门禁 → kind 分发
        （cli 沙箱执行 / gui 标题核验 / uri 协议启动）→ 截断落 toolcache →
        审计（op=software_call）。

        Args:
            params: dict，字段见契约 §3.2（software/action 必填；args 对象
                缺省 {}；timeout 仅 CLI 有效，5-600 夹逼；source=manual_test
                为面板测试调用——不走 Agent guard 确认链但照常审计，Gap-4）。

        Returns:
            dict: 成功三形态载荷 / 错误码（NOT_INSTALLED / IDENTITY_MISMATCH /
                SCHEMA_INVALID / TIMEOUT / GUI_UNCONFIRMED / UNKNOWN_SOFTWARE /
                BAD_PARAMS / GUARD_DENIED 挂点）。
        """
        p = _as_dict(params)
        software = str(p.get('software') or '').strip().lower()
        action = str(p.get('action') or '').strip()
        source = str(p.get('source') or '').strip()
        args = p.get('args')
        if args is None:
            args = {}
        if not isinstance(args, dict):
            return _error('BAD_PARAMS', 'args 必须是 JSON 对象',
                          '例如 {"message": "fix: 描述"}')
        timeout = _clamp_int(p.get('timeout'), 60, CLI_TIMEOUT_MIN,
                             CLI_TIMEOUT_MAX)
        with self._lock:
            entry = self._registry.get(software)
            entry = json.loads(json.dumps(entry)) if entry else None
        if entry is None:
            self._audit('software_call', {'software': software, 'action': action,
                                          'source': source}, 'call', 'block')
            return _error('UNKNOWN_SOFTWARE',
                          '注册表中没有软件: %r' % software,
                          '可用软件: %s' % '/'.join(sorted(self._registry)))
        act = None
        for a in entry.get('actions') or []:
            if a.get('name') == action:
                act = a
                break
        if act is None:
            self._audit('software_call', {'software': software, 'action': action,
                                          'source': source}, 'call', 'block')
            return _error('BAD_PARAMS',
                          '软件 %s 没有动作: %r' % (software, action),
                          '可用动作: %s' % '/'.join(
                              a['name'] for a in entry.get('actions') or []))
        risk = str(act.get('risk') or entry.get('risk_default') or 'read')
        # ---- 安装/身份校验（unknown 先按需探测，避免陈缓存误判）----
        status = entry.get('status')
        if status == 'unknown':
            # 探测可能跑 15s 级 version 子进程：持锁跑会阻塞 software_list /
            # save 等全部注册表操作——锁外探测，persist 再短暂持锁
            status = self._probe_one(software).get('status')
            with self._lock:
                self._persist()
        if status == 'missing':
            self._audit('software_call', {'software': software, 'action': action,
                                          'risk': risk, 'source': source},
                        'call', 'block')
            hint = ('请前往官网下载安装 %s：%s（Harbor 不会自动下载软件，'
                    '防供应链风险）' % (software, entry.get('website') or '官方渠道')
                    if entry.get('website') else
                    '请先安装 %s 后重试（Harbor 不会自动下载软件）' % software)
            return _error('NOT_INSTALLED',
                          '未检测到 %s（PATH/注册表均未找到）' % software, hint)
        if status == 'version_mismatch':
            self._audit('software_call', {'software': software, 'action': action,
                                          'risk': risk, 'source': source},
                        'call', 'block')
            return _error('IDENTITY_MISMATCH',
                          '检测到的 %s 与预期身份不符（可能是同名假冒程序）'
                          % software,
                          '请检查 PATH 环境变量中是否存在同名程序；'
                          '确认无误后可在设置→外部软件中重新探测')

        # ---- arg JSON Schema 硬校验（SCHEMA_INVALID 自校正回显）----
        schema = act.get('arg_schema') or {'type': 'object',
                                           'properties': {}}
        violations = validate_args(schema, args)
        if violations:
            self._audit('software_call', {'software': software, 'action': action,
                                          'risk': risk, 'source': source,
                                          'violations': len(violations)},
                        'call', 'block')
            return _error('SCHEMA_INVALID', '参数校验失败',
                          '请按 example 修正后重试（Agent 自校正 ≤2 次）',
                          violations=violations,
                          example=gen_example(schema))

        # ---- guard 挂点（A 域批次集成；S 域只留标记不接线）----
        # _GUARD_HOOK_CLI: risk == 'dangerous' → always 强制确认前置：
        #   reason = self._guard.enforce_exec('software_call',
        #       {'software': software, 'action': action, 'risk': risk}, token)
        #   if reason: audit(..., 'block'); return _error('GUARD_DENIED', reason)
        # 面板测试调用（source=manual_test）视为用户本人操作，不走 Agent guard
        # 确认链（Gap-4 默认分支）；browser/software 的 GUARD_DENIED 触发点在
        # guard_check 前置，属 A 域接线面。

        # ---- 路径参数门禁（工作区内 + realpath 归一，防 ../junction 越界）----
        props = (schema.get('properties') or {})
        gated = {}
        for pname, spec in props.items():
            if pname in args and isinstance(spec, dict) and \
                    spec.get('x-workspace-path'):
                abs_p, reason = self._gate_workspace_path(args[pname])
                if reason:
                    self._audit('software_call',
                                {'software': software, 'action': action,
                                 'risk': risk, 'source': source,
                                 'violations': 1}, 'call', 'block')
                    return _error('SCHEMA_INVALID', '参数校验失败',
                                  reason,
                                  violations=[{'path': pname,
                                               'expect': '工作区内的路径',
                                               'got': _summarize(args[pname])}],
                                  example=gen_example(schema))
                gated[pname] = abs_p

        kind = str(entry.get('kind') or 'cli')
        if kind == 'cli':
            return self._call_cli(entry, act, args, gated, timeout, risk,
                                  source)
        if kind == 'gui':
            return self._call_gui(entry, act, args, gated, risk, source)
        return self._call_uri(entry, act, args, risk, source)

    def _call_cli(self, entry, act, args, gated, timeout, risk, source):
        """CLI 形态：沙箱执行 → 退出码语义（≠0 仍成功形状）→ 截断 → 审计。"""
        software = entry['name']
        action = act['name']
        try:
            argv = self._build_argv(entry, act, args, gated)
        except KeyError as e:
            return _error('BAD_PARAMS', '参数缺失: %s' % e,
                          '可用参数见 arg_schema')
        cwd = self._workspace_root()
        limits = self._sandbox_limits(risk)
        t0 = self._clock()
        r = self._runner(argv, cwd, timeout, limits)
        duration_ms = int((self._clock() - t0) * 1000)
        if not isinstance(r, dict):
            self._audit('software_call', {'software': software,
                                          'action': action, 'risk': risk,
                                          'source': source}, 'call', 'error')
            return _error('INTERNAL', '执行器返回异常', '请重试或反馈该问题')
        if r.get('error'):
            # fail-closed：沙箱不可用不裸跑（与 run_command 同口径）
            self._audit('software_call', {'software': software,
                                          'action': action, 'risk': risk,
                                          'source': source,
                                          'exit_code': ''}, 'call', 'block')
            return _error('GUARD_DENIED', str(r['error']),
                          '可在设置→命令沙箱中调整档位后重试')
        # v1.9.0 M2.11：回灌前四连洗（ANSI/bidi/零宽/C0——毒输出防注入面）
        stdout = sanitize_text(self._dec(r.get('stdout')))
        stderr = sanitize_text(self._dec(r.get('stderr')))
        if r.get('timed_out'):
            # 看门狗已清剿进程树（Job Object KILL_ON_JOB_CLOSE）；保留部分输出
            self._audit('software_call', {'software': software,
                                          'action': action, 'risk': risk,
                                          'source': source,
                                          'exit_code': 'timeout'}, 'call',
                        'killed')
            return _error('TIMEOUT',
                          '%s %s 执行超时（%ds），进程树已清剿'
                          % (software, action, timeout),
                          '可调大 timeout（5-600 秒）后重试',
                          software=software, action=action, kind='cli',
                          stdout=stdout[:OUTPUT_HEAD_CHARS],
                          stderr=stderr[:OUTPUT_HEAD_CHARS])
        exit_code = r.get('returncode')
        sandboxed = bool(r.get('sandboxed'))
        payload = {
            'ok': True, 'software': software, 'action': action, 'kind': 'cli',
            'exit_code': exit_code if exit_code is not None else -1,
            'stdout': stdout, 'stderr': stderr,
            'duration_ms': duration_ms, 'sandboxed': sandboxed,
        }
        truncated = False
        full_ref = None
        if len(stdout) > OUTPUT_TRUNCATE_CHARS:
            cid = self._toolcache.cache(stdout)
            payload['stdout'] = (
                stdout[:OUTPUT_HEAD_CHARS] +
                ('\n…[输出共 %d 字已截断;id=%s, 用 read_more 分段获取]…\n'
                 % (len(stdout), cid or '?')) +
                stdout[-OUTPUT_TAIL_CHARS:])
            truncated = True
            if cid:
                full_ref = 'toolcache:%s' % cid
        if len(stderr) > OUTPUT_TRUNCATE_CHARS:
            cid = self._toolcache.cache(stderr)
            payload['stderr'] = (
                stderr[:OUTPUT_HEAD_CHARS] +
                ('\n…[错误输出共 %d 字已截断;id=%s, 用 read_more 分段获取]…\n'
                 % (len(stderr), cid or '?')) +
                stderr[-OUTPUT_TAIL_CHARS:])
            truncated = True
        payload['truncated'] = truncated
        if full_ref:
            payload['full_ref'] = full_ref
        hint = None
        if exit_code not in (0, None):
            # exit_code≠0：成功形状 + error_hint（人话映射命中时；不改变 ok）
            hint = stderr_hint(stderr) or stderr_hint(stdout)
        if hint:
            payload['error_hint'] = hint
        # v1.9.0 M2.2：provenance 标注（纯增 untrusted/source 键）——软件输出
        # 属外部内容，source 附 software/action（禁原文 query——本场景无 query）
        try:
            from ..providers.provenance import tag_payload
            payload = tag_payload(payload, source={'software': software,
                                                   'action': action})
        except Exception:
            pass                        # provenance 失败不阻断调用主流程
        # exit_code≠0 仍走成功形状（§3.2 裁决口径：保住 Agent 判断力）——
        # 审计记 ok（调用本身成功，退出码语义随 detail 供事后分析）
        self._audit('software_call', {'software': software, 'action': action,
                                      'risk': risk, 'source': source,
                                      'exit_code': exit_code,
                                      'sandboxed': sandboxed,
                                      'truncated': truncated}, 'call', 'ok')
        return payload

    def _call_gui(self, entry, act, args, gated, risk, source):
        """GUI 形态：CreateProcessW 启动 + FindWindowW 标题核验 ≤10s。"""
        software = entry['name']
        action = act['name']
        try:
            argv = self._build_argv(entry, act, args, gated)
        except KeyError as e:
            return _error('BAD_PARAMS', '参数缺失: %s' % e,
                          '可用参数见 arg_schema')
        exe = self._resolve_executable(entry)
        if not exe:
            self._audit('software_call', {'software': software,
                                          'action': action, 'risk': risk,
                                          'source': source}, 'call', 'block')
            return _error('NOT_INSTALLED',
                          '未检测到 %s（PATH/注册表均未找到）' % software,
                          '请前往官网下载安装：%s' %
                          (entry.get('website') or '官方渠道'))
        t0 = self._clock()
        r = self._gui_launcher(exe, argv, entry.get('expected_title') or '',
                               GUI_VERIFY_TIMEOUT_S)
        duration_ms = int((self._clock() - t0) * 1000)
        if not isinstance(r, dict) or not r.get('launched'):
            self._audit('software_call', {'software': software,
                                          'action': action, 'risk': risk,
                                          'source': source}, 'call', 'error')
            return _error('INTERNAL',
                          'GUI 启动失败: %s' % (r.get('error') if isinstance(r, dict)
                                               else 'launcher 异常'),
                          '请重试或反馈该问题')
        if not r.get('window_verified'):
            self._audit('software_call', {'software': software,
                                          'action': action, 'risk': risk,
                                          'source': source}, 'call',
                        'unconfirmed')
            return _error('GUI_UNCONFIRMED',
                          '已发起启动 %s，但 %ds 内未检测到预期窗口'
                          % (software, GUI_VERIFY_TIMEOUT_S),
                          '可能被 UAC/杀软拦截：请检查屏幕是否有授权弹窗，'
                          '确认后重试；若程序无需窗口（后台运行）可改用 CLI 方式',
                          launched=True, software=software, action=action,
                          kind='gui', duration_ms=duration_ms)
        payload = {'ok': True, 'software': software, 'action': action,
                   'kind': 'gui', 'launched': True, 'window_verified': True,
                   'window_title': r.get('window_title') or '',
                   'duration_ms': duration_ms}
        self._audit('software_call', {'software': software, 'action': action,
                                      'risk': risk, 'source': source,
                                      'window_title': (r.get('window_title')
                                                       or '')[:80]},
                    'call', 'ok')
        return payload

    def _call_uri(self, entry, act, args, risk, source):
        """URI 形态：协议启动（os.startfile；启动不可逆——执行前停止才有效）。"""
        software = entry['name']
        action = act['name']
        tpl = str(act.get('uri_template') or entry.get('uri_template') or '')
        try:
            uri = self._fill_template(tpl, args)
        except KeyError as e:
            self._audit('software_call', {'software': software,
                                          'action': action, 'risk': risk,
                                          'source': source}, 'call', 'block')
            return _error('BAD_PARAMS', '参数缺失: %s' % e,
                          '可用参数见 arg_schema')
        if not re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', uri or ''):
            self._audit('software_call', {'software': software,
                                          'action': action, 'risk': risk,
                                          'source': source}, 'call', 'block')
            return _error('BAD_PARAMS',
                          'uri_template 渲染结果不是合法协议 URI: %r' % uri,
                          '模板需含协议 scheme（如 https://{host}/{path}）')
        t0 = self._clock()
        try:
            os.startfile(uri)
        except Exception:
            # 回退：ShellExecuteW（cmd /c start 有命令行注入面——uri 含 & 等
            # 元字符时会执行额外命令；ShellExecuteW 结构化参数无此面）
            if not _shell_execute(uri):
                self._audit('software_call',
                            {'software': software, 'action': action,
                             'risk': risk, 'source': source}, 'call',
                            'error')
                return _error('INTERNAL',
                              '协议启动失败（startfile/ShellExecuteW 均不可用）',
                              '请检查协议是否已注册（默认程序关联）')
        duration_ms = int((self._clock() - t0) * 1000)
        protocol = uri.split(':', 1)[0].lower()
        self._audit('software_call', {'software': software, 'action': action,
                                      'risk': risk, 'source': source,
                                      'protocol': protocol}, 'call', 'ok')
        return {'ok': True, 'software': software, 'action': action,
                'kind': 'uri', 'protocol': protocol, 'uri': uri,
                'duration_ms': duration_ms}

    # ================================================== 内部工具
    @staticmethod
    def _fill_template(tpl, values):
        """模板填充：``{name}`` 占位 → str(values[name])（缺失即抛 KeyError）。"""
        out = str(tpl or '')
        for k, v in (values or {}).items():
            out = out.replace('{%s}' % k, str(v))
        if re.search(r'\{[a-zA-Z_][a-zA-Z0-9_]*\}', out):
            missing = re.findall(r'\{([a-zA-Z_][a-zA-Z0-9_]*)\}', out)
            raise KeyError(missing[0] if missing else '?')
        return out

    def _build_argv(self, entry, act, args, gated):
        """构造 CLI/GUI argv：exec + action.argv 模板（{arg} 占位填充）。

        路径参数填门禁归一后的绝对路径（gated），其余填原始值。
        """
        argv = [str(entry.get('exec') or '')]
        for token in act.get('argv') or []:
            t = str(token)
            m = re.fullmatch(r'\{([a-zA-Z_][a-zA-Z0-9_]*)\}', t)
            if m:
                key = m.group(1)
                if key in gated:
                    argv.append(gated[key])
                elif key in args:
                    argv.append(str(args[key]))
                else:
                    raise KeyError(key)
            else:
                argv.append(self._fill_template(t, {**args, **gated}))
        return argv

    def _workspace_root(self):
        """工作区根（callable 或字符串；缺省进程 CWD）。"""
        root = self._ws_root
        if callable(root):
            try:
                root = root()
            except Exception:
                root = None
        return str(root or os.getcwd())

    def _gate_workspace_path(self, raw):
        """工作区门禁 + realpath 归一（防 ../ 与 junction 越界）。

        Returns:
            (abs_path, None) 或 (None, 人话原因)。相对路径按工作区根解析。
        """
        s = str(raw if raw is not None else '').strip()
        if not s:
            return None, '路径参数不能为空'
        root = os.path.realpath(os.path.abspath(self._workspace_root()))
        if os.path.isabs(s):
            p = os.path.realpath(os.path.abspath(s))
        else:
            p = os.path.realpath(os.path.abspath(os.path.join(root, s)))
        if p != root and not p.startswith(root + os.sep):
            return None, ('路径 %r 越出工作区（%s）：外部软件调用仅允许操作'
                          '工作区内路径' % (s, root))
        return p, None

    def _sandbox_limits(self, risk):
        """risk → sandbox 档位限制字典（read/mutate→standard，dangerous→strict）。

        沙箱关闭（enabled=False）或档位缺失 → None（不沙箱，与 run_command
        口径一致）。沙箱不可用由 run_in_sandbox fail-closed 拦截。
        """
        profile = _RISK_SANDBOX_PROFILE.get(risk, 'standard')
        if self._sandbox is None:
            return None
        getter = getattr(self._sandbox, 'limits_for_profile', None)
        if getter is None:
            return None
        try:
            return getter(profile)
        except Exception as e:
            self._log.debug('沙箱档位取限制失败: %r', e)
            return None

    def _run_cli(self, argv, cwd, timeout, limits):
        """CLI 执行（默认实现；limits 非空走 Job Object 沙箱，fail-closed）。

        与 cmd_service._exec 同口径：宿主替换过 subprocess.run（测试桩）
        时沙箱请求退化为桩路径；超时不抛异常——返回 timed_out=True +
        部分输出（§3.2 TIMEOUT：看门狗清剿进程树 + 部分 stdout 保留）。
        """
        argv = [str(a) for a in argv]
        if limits is not None and subprocess.run is _STDLIB_RUN:
            from ..workspace import sandbox_service
            try:
                r = sandbox_service.run_in_sandbox(
                    argv, shell=False, cwd=cwd, timeout=timeout, limits=limits)
            except sandbox_service.SandboxUnavailable as e:
                return {'error': '沙箱执行被阻止（fail-closed）：%s' % e}
            return {'returncode': r.returncode, 'stdout': r.stdout,
                    'stderr': r.stderr, 'timed_out': bool(r.timed_out),
                    'sandboxed': True}
        if subprocess.run is not _STDLIB_RUN:
            try:
                r = subprocess.run(argv, capture_output=True, shell=False,
                                   timeout=timeout, cwd=cwd,
                                   creationflags=_NO_WINDOW)
                return {'returncode': r.returncode, 'stdout': r.stdout,
                        'stderr': r.stderr, 'timed_out': False,
                        'sandboxed': False}
            except subprocess.TimeoutExpired as e:
                return {'returncode': None,
                        'stdout': e.stdout or b'', 'stderr': e.stderr or b'',
                        'timed_out': True, 'sandboxed': False}
        proc = subprocess.Popen(argv, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, shell=False, cwd=cwd,
                                creationflags=_NO_WINDOW)
        try:
            out, errout = proc.communicate(timeout=timeout)
            return {'returncode': proc.returncode, 'stdout': out,
                    'stderr': errout, 'timed_out': False, 'sandboxed': False}
        except subprocess.TimeoutExpired:
            _kill_tree(proc.pid)
            out = errout = b''
            try:
                out, errout = proc.communicate(timeout=5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
            return {'returncode': None, 'stdout': out or b'',
                    'stderr': errout or b'', 'timed_out': True,
                    'sandboxed': False}

    @staticmethod
    def _dec(b):
        """bytes → str（UTF-8 优先，GBK 兜底；与 cmd_service._dec 同口径）。"""
        if not b:
            return ''
        if isinstance(b, str):
            return b
        s = b.decode('utf-8', 'replace')
        bad = s.count('\ufffd')
        if bad > max(3, len(s) // 200):
            try:
                s2 = b.decode('gbk', 'replace')
                if s2.count('\ufffd') < bad:
                    s = s2
            except Exception:
                pass
        return s.replace('\r\r\n', '\r\n')

    def _audit(self, op, detail, action, decision):
        """落 audit_log.jsonl（经 GuardService 单一口径 + 10MB 轮转）。"""
        try:
            self._guard.audit(op, detail, action, decision)
        except Exception as e:
            self._log.warning('软件审计写入失败: %r', e)


def _kill_tree(pid):
    """超时清剿进程树（taskkill /T /F；沙箱路径由 Job Object 内核级清剿）。"""
    try:
        subprocess.run(['taskkill', '/T', '/F', '/PID', str(pid)],
                       capture_output=True, timeout=10,
                       creationflags=_NO_WINDOW)
    except Exception:
        pass
