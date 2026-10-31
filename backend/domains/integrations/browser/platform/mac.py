# -*- coding: utf-8 -*-
"""v1.9.0 M6.1-6.8 · macOS 平台服务七接口（理论实现）。

PyObjC/Quartz/Security 框架全部**延迟 import + ctypes**——非 macOS 环境
``available()`` 为 False、操作返回结构化降级载荷（B8.9 禁抛禁阻断）；
macOS 真机装齐依赖即全链路可用（真机验证集中 M9.4/9.5）。Windows 开发
机上 **SBPL 生成器/路径口径/降级语义**均纯逻辑可测（test_v19_mac.py）。

七接口对映（master-plan §186）：
- ``SecretsMac``（6.1）：Keychain——ctypes 直调 Security C API（绕开 Tahoe
  已坏的 security CLI）；SSH 会话 -25308 → 人话引导桌面会话（6.3 边界）。
- ``SandboxMac``（6.4）：sandbox-exec 后端——``build_sbpl`` SBPL 生成器
  （纯函数全测：deny default + 最小 profile + 网络三档 none/loopback/full）。
- ``ScreenMac``（6.6）：Quartz CGDisplayCreateImage + TCC 权限人话引导。
- ``TrashMac``（6.7）：NSFileManager trashItemAtURL（废纸篓）。
- ``PathsMac``（6.7）：~/Library/Application Support/Harbor（mac 数据目录
  口径；Win ~/.glm-chat 不动——双端不互通，master-plan §9）。
- ``ProcessMac``（6.8）：ps 枚举 + os.kill。
- ``NotifyMac``（6.8）：NSUserNotification（best-effort 永不抛）。
"""
import json
import os
import subprocess
import tempfile

from .....logging_setup import get_logger

# 与 cmd_service 同款：模块级保存 subprocess.run 引用（测试桩可替换，
# 不产生真实进程；sandbox-exec 调用一律 argv 列表 shell=False 零拼接）
_STDLIB_RUN = subprocess.run

# ============================================================
# M6.4 SBPL 生成（模板全部为模块级静态常量——build_sbpl 只做选择与
# 已归一路径的白名单追加，模板无任何动态插值之外的内容）
# ============================================================

#: 网络三档（master-plan 6.4：none/loopback/full）
SBPL_NETWORK_MODES = ('none', 'loopback', 'full')

_TPL_HEADER = ('(version 1)', '(deny default)')
_TPL_READ_STANDARD = ('(allow file-read* (subpath "/usr") '
                      '(subpath "/System") (subpath "/Library"))')
_TPL_READ_STRICT = '(allow file-read* (literal "/dev/null"))'
_TPL_NET_FULL = '(allow network*)'
_TPL_NET_LOOPBACK = ('(allow network-outbound '
                     '(literal "/private/var/run/syslog") '
                     '(remote ip "127.0.0.1"))')
_TPL_LAUNCH = ('(allow process* (subpath "/bin") (subpath "/usr/bin") '
               '(subpath "/usr/libexec"))')


def _norm_subpath(path):
    """白名单路径归一：expanduser + 去引号（SBPL 字面量安全化）。"""
    return os.path.expanduser(str(path or '').strip().replace('"', ''))


def _subpath_line(verb, path):
    """白名单行构造（verb 白名单内；path 已归一）。"""
    return '(allow file-%s* (subpath "%s"))' % (verb, path)


def build_sbpl(profile='standard', network='none', workspace='',
               extra_read=(), extra_write=()):
    """生成 sandbox-exec SBPL 脚本（6.4；纯函数零 IO）。

    Args:
        profile: 'standard'（系统只读+工作区写）| 'strict'（最小权限）。
        network: 'none'（默认禁网——8.6 最小权限）| 'loopback' | 'full'。
        workspace: 工作区绝对路径（写白名单 subpath）。
        extra_read/extra_write: 追加白名单路径（显式声明的最小化面）。

    Returns:
        str: SBPL 脚本（deny default 开头；子进程树继承——sh -c 嵌套同拦）。
    """
    lines = list(_TPL_HEADER)
    lines.append(_TPL_READ_STRICT if profile == 'strict'
                 else _TPL_READ_STANDARD)
    ws = _norm_subpath(workspace)
    if profile != 'strict' and ws:
        lines.append(_subpath_line('write', ws))
    for path in (extra_read or ()):
        p = _norm_subpath(path)
        if p:
            lines.append(_subpath_line('read', p))
    for path in (extra_write or ()):
        p = _norm_subpath(path)
        if p:
            lines.append(_subpath_line('write', p))
    if network == 'full':
        lines.append(_TPL_NET_FULL)
    elif network == 'loopback':
        lines.append(_TPL_NET_LOOPBACK)
    # none：不写任何 network allow（deny default 覆盖）
    lines.append(_TPL_LAUNCH)
    return '\n'.join(lines) + '\n'


# ============================================================
# 框架可用性探测（延迟 import——非 macOS 一律 False）
# ============================================================

def _mac_runtime_available() -> bool:
    try:
        import Foundation  # noqa: F401
        return True
    except Exception:
        return False


def _security_framework():
    """加载 Security.framework（ctypes——绕开 Tahoe 已坏的 security CLI，6.1）。"""
    try:
        import ctypes
        return ctypes.cdll.LoadLibrary(
            '/System/Library/Frameworks/Security.framework/Security')
    except Exception:
        return None


# ============================================================
# M6.1 Keychain（ctypes Security C API）
# ============================================================

_KEYCHAIN_QUERIES = ('add', 'get', 'del')   # 操作白名单（禁注入未知 op）


class SecretsMac:
    """Keychain 服务（kSecClassGenericPassword；SSH -25308 人话引导 6.3）。"""

    name = 'mac-keychain'

    def __init__(self):
        self._log = get_logger()
        self._sec = _security_framework()

    def _available(self):
        return self._sec is not None

    def set(self, service, account, secret):
        """SecItemAdd（upsert：先 delete 再 add——Keychain 无原生 upsert）。"""
        if not self._available():
            return {'ok': False, 'error': 'SECRETS_UNAVAILABLE',
                    'message': 'Security.framework 不可用（非 macOS 环境）'}
        svc, acct = str(service or ''), str(account or '')
        if not svc or not acct:
            return {'ok': False, 'error': 'BAD_PARAMS',
                    'message': 'service/account 不能为空'}
        self.delete(svc, acct)
        try:
            rc = self._sec_item_op('add', svc, acct, str(secret or ''))
        except Exception as e:
            return self._keychain_error(e)
        return {'ok': True} if rc == 0 else self._keychain_error(rc)

    def get(self, service, account):
        """SecItemCopyMatching → {ok, secret}；-25308 → 人话引导（6.3）。"""
        if not self._available():
            return {'ok': False, 'error': 'SECRETS_UNAVAILABLE',
                    'message': 'Security.framework 不可用（非 macOS 环境）'}
        try:
            rc, val = self._sec_item_op('get', str(service or ''),
                                        str(account or ''))
        except Exception as e:
            return self._keychain_error(e)
        if rc == -25308:
            return {'ok': False, 'error': 'KEYCHAIN_INTERACTION_REQUIRED',
                    'message': 'Keychain 需要交互授权（SSH 会话不可用）——'
                               '请在桌面会话首次写入后重试'}
        if rc != 0 or not val:
            return {'ok': False, 'error': 'NOT_FOUND'}
        import base64
        try:
            secret = base64.b64decode(val).decode('utf-8')
        except Exception:
            secret = str(val)
        return {'ok': True, 'secret': secret}

    def delete(self, service, account):
        """SecItemDelete（幂等：errSecItemNotFound → removed=False 不报错）。"""
        if not self._available():
            return {'ok': False, 'error': 'SECRETS_UNAVAILABLE'}
        try:
            rc = self._sec_item_op('del', str(service or ''),
                                   str(account or ''))
        except Exception as e:
            return self._keychain_error(e)
        if rc in (0, -25300):    # 0=删除成功；-25300=errSecItemNotFound（幂等）
            return {'ok': True, 'removed': rc == 0}
        return self._keychain_error(rc)

    def _sec_item_op(self, op, service, account, value=''):
        """C API 桥分发（op 经白名单；真机 PyObjC 路径；理论实现要点：
        真机按 SecItemAdd/CopyMatching/Delete + CFDictionary 构造，
        -25308 错误码语义由 get 路径人话化——SSH 会话引导桌面首写）。"""
        if op not in _KEYCHAIN_QUERIES:
            raise ValueError('未知 Keychain 操作: %r' % op)
        if not _mac_runtime_available():
            raise NotImplementedError(
                'Keychain C API 桥需要 macOS + PyObjC 运行时')
        return self._sec_item_op_pyobjc(op, service, account, value)

    def _sec_item_op_pyobjc(self, op, service, account, value):
        """PyObjC 路径（NSDictionary 查询 → Security C 函数；真机验证 M9.4）。"""
        import base64
        import ctypes as _c
        from Foundation import NSDictionary
        query = {'class': 'genp', 'svce': service, 'acct': account}
        if op == 'add':
            query['v_Data'] = base64.b64encode(
                value.encode('utf-8')).decode('ascii')
        d = NSDictionary.dictionaryWithDictionary_(query)
        sec = self._sec
        if op == 'del':
            return int(sec.SecItemDelete(d))
        if op == 'add':
            return int(sec.SecItemAdd(d, None))
        out = _c.c_void_p()
        rc = int(sec.SecItemCopyMatching(d, _c.byref(out)))
        return rc, None if rc != 0 else _c.string_at(out.value)

    def _keychain_error(self, e):
        code = getattr(e, 'args', [e])[0] if isinstance(e, Exception) else e
        try:
            code = int(code)
        except Exception:
            code = str(code)
        return {'ok': False, 'error': 'KEYCHAIN_ERROR',
                'message': 'Keychain 操作失败: %s' % code}


# ============================================================
# M6.4 sandbox-exec 后端
# ============================================================

def _run_sandbox_argv(argv, cwd, timeout):
    """sandbox-exec 执行（argv 列表 shell=False；cmd_service _STDLIB_RUN 同款
    桩可替换口径）。"""
    return _STDLIB_RUN(argv, shell=False, cwd=cwd, timeout=timeout,
                       capture_output=True)


class SandboxMac:
    """sandbox-exec（SBPL deny default + 最小 profile + 网络三档）。"""

    name = 'mac-sandbox-exec'
    _SANDBOX_BINARY = '/usr/bin/sandbox-exec'

    def __init__(self, workspace=''):
        self._log = get_logger()
        self._workspace = workspace

    def available(self):
        """sandbox-exec 可用性（macOS 内建；理论实现非 macOS False）。"""
        try:
            return os.path.isfile(self._SANDBOX_BINARY)
        except Exception:
            return False

    def limits_for(self, command_class):
        """命令类别 → SBPL 参数（与 sandbox_service 档位语义对齐）。"""
        return {'profile': 'strict' if command_class == 'dangerous'
                else 'standard',
                'network': 'none',
                'workspace': self._workspace}

    def run(self, args, shell=False, cwd=None, timeout=60, limits=None):
        """沙箱内执行：SBPL 落临时文件 → sandbox-exec -f sbpl -- <argv>。"""
        if not self.available():
            return {'ok': False, 'error': 'SANDBOX_UNAVAILABLE',
                    'message': 'sandbox-exec 不可用（非 macOS 环境）'}
        lim = dict(limits or self.limits_for('standard'))
        sbpl = build_sbpl(profile=lim.get('profile', 'standard'),
                          network=lim.get('network', 'none'),
                          workspace=lim.get('workspace') or self._workspace)
        sbpl_path = ''
        try:
            with tempfile.NamedTemporaryFile('w', suffix='.sbpl',
                                             delete=False,
                                             encoding='utf-8') as f:
                f.write(sbpl)
                sbpl_path = f.name
            argv = [self._SANDBOX_BINARY, '-f', sbpl_path, '--']
            argv.extend(str(a) for a in (args or []))
            r = _run_sandbox_argv(argv, cwd, timeout)
            return {'ok': True, 'returncode': r.returncode,
                    'stdout': r.stdout.decode('utf-8', 'replace'),
                    'stderr': r.stderr.decode('utf-8', 'replace'),
                    'timed_out': False, 'sandboxed': True}
        except subprocess.TimeoutExpired:
            return {'ok': True, 'returncode': -1, 'stdout': '', 'stderr': '',
                    'timed_out': True, 'sandboxed': True}
        except Exception as e:
            return {'ok': False, 'error': 'SANDBOX_ERROR',
                    'message': 'sandbox-exec 执行失败: %s' % e}
        finally:
            if sbpl_path:
                try:
                    os.unlink(sbpl_path)
                except Exception:
                    pass


# ============================================================
# M6.6 截屏（Quartz）/ M6.7 废纸篓 / 路径 / M6.8 进程 / 通知
# ============================================================

class ScreenMac:
    """Quartz CGDisplayCreateImage（TCC 权限引导；理论实现）。"""

    name = 'mac-quartz'

    def __init__(self):
        self._log = get_logger()

    def _quartz(self):
        try:
            import Quartz
            return Quartz
        except Exception:
            return None

    def capture(self, left=None, top=None, width=None, height=None):
        """全屏/区域截屏 → PNG 落 screenshots/ 目录（6.6；TCC 拒绝人话）。"""
        import time as _time
        q = self._quartz()
        if q is None:
            return {'ok': False, 'error': 'SCREEN_UNAVAILABLE',
                    'message': 'Quartz 不可用（非 macOS 环境）'}
        try:
            img = q.CGDisplayCreateImage(q.CGMainDisplayID())
            if img is None:
                return {'ok': False, 'error': 'TCC_PERMISSION_REQUIRED',
                        'message': '屏幕录制权限未授予——系统设置 → 隐私与'
                                   '安全性 → 屏幕录制 中勾选 Harbor 后重启'}
            from ..... import paths
            os.makedirs(paths.SCREENSHOTS_DIR, exist_ok=True)
            out = os.path.join(
                paths.SCREENSHOTS_DIR,
                'shot_%s.png' % _time.strftime('%Y%m%d_%H%M%S'))
            from Foundation import NSURL
            dest = q.CGImageDestinationCreateWithURL(
                NSURL.fileURLWithPath_(out), 'public.png', 1, None)
            q.CGImageDestinationAddImage(dest, img, None)
            q.CGImageDestinationFinalize(dest)
            return {'ok': True, 'path': out}
        except Exception as e:
            return {'ok': False, 'error': 'SCREEN_ERROR',
                    'message': '截屏失败: %s' % e}


class TrashMac:
    """NSFileManager trashItemAtURL（废纸篓；理论实现）。"""

    name = 'mac-trash'

    def trash(self, path):
        p = str(path or '').strip()
        if not p or not os.path.exists(p):
            return {'ok': False, 'error': 'BAD_PARAMS',
                    'message': '路径不存在: %s' % p[:120]}
        try:
            import shutil
            from Foundation import NSURL
            from AppKit import NSFileManager
            url = NSURL.fileURLWithPath_(os.path.abspath(p))
            ok = NSFileManager.defaultManager(
                ).trashItemAtURL_resultingItemURL_error_(url, None, None)
            if not ok:
                # AppKit 拒绝（权限/卷只读）→ 降级永久删 + 警示（win 同口径）
                shutil.rmtree(p) if os.path.isdir(p) else os.unlink(p)
                return {'ok': True, 'path': p, 'mode': 'delete',
                        'warning': '废纸篓不可用，已永久删除（不可恢复）'}
            return {'ok': True, 'path': p, 'mode': 'recycle'}
        except ImportError:
            return {'ok': False, 'error': 'TRASH_UNAVAILABLE',
                    'message': 'AppKit 不可用（非 macOS 环境）'}
        except Exception as e:
            return {'ok': False, 'error': 'TRASH_ERROR',
                    'message': '删除失败: %s' % e}


class PathsMac:
    """mac 目录口径（6.7）：~/Library/Application Support/Harbor。"""

    name = 'mac-paths'

    MAC_CONFIG_DIR = '~/Library/Application Support/Harbor'

    @classmethod
    def config_dir(cls):
        return os.path.expanduser(cls.MAC_CONFIG_DIR)

    @classmethod
    def data_dir(cls):
        return cls.config_dir()

    @staticmethod
    def profiles_dir():
        from ..... import paths
        return paths.BROWSER_PROFILE_DIR


class ProcessMac:
    """ps 枚举 + os.kill（理论实现；与 ProcessService 载荷同构）。"""

    name = 'mac-process'

    def list(self, keyword=''):
        try:
            r = _STDLIB_RUN(['/bin/ps', '-axo', 'pid,rss,comm'],
                            shell=False, capture_output=True, timeout=10)
            out = r.stdout.decode('utf-8', 'replace').splitlines()
        except Exception:
            return []
        kw = str(keyword or '').lower()
        rows = []
        for line in out[1:]:
            parts = line.split(None, 2)
            if len(parts) == 3 and (not kw or kw in parts[2].lower()):
                rows.append('%s  %s' % (parts[0], parts[2]))
        return rows

    def kill(self, pid=None, name=None):
        if pid is None and not name:
            return {'ok': False, 'error': 'BAD_PARAMS',
                    'message': 'pid 与 name 至少其一'}
        try:
            if pid is not None:
                os.kill(int(pid), 15)
                return {'ok': True, 'killed': int(pid)}
            for row in self.list(name or ''):
                os.kill(int(row.split()[0]), 15)
            return {'ok': True, 'killed': name}
        except ProcessLookupError:
            return {'ok': True, 'killed': pid or name, 'note': '进程已退出'}
        except Exception as e:
            return {'ok': False, 'error': 'KILL_ERROR', 'message': str(e)}

    def resolve_name(self, pid):
        try:
            for row in self.list():
                if row.split()[0] == str(pid):
                    return row.split(None, 1)[1]
        except Exception:
            pass
        return None


class NotifyMac:
    """NSUserNotification（best-effort 永不抛；理论实现）。"""

    name = 'mac-notify'

    def notify(self, title, message):
        try:
            from Foundation import (NSUserNotification,
                                    NSUserNotificationCenter)
            n = NSUserNotification.alloc().init()
            n.setTitle_(str(title or 'Harbor'))
            n.setInformativeText_(str(message or ''))
            NSUserNotificationCenter.defaultUserNotificationCenter(
                ).deliverNotification_(n)
            return {'ok': True}
        except Exception:
            return {'ok': False, 'error': 'NOTIFY_UNAVAILABLE'}


# ============================================================
# 聚合（PlatformServices 工厂协议）
# ============================================================

class MacPlatformServices:
    """macOS 七接口聚合（get_platform_services('mac') 返回；理论实现）。"""

    name = 'mac'

    def secrets(self):
        return SecretsMac()

    def sandbox(self):
        return SandboxMac()

    def screen(self):
        return ScreenMac()

    def trash(self):
        return TrashMac()

    def paths(self):
        return PathsMac()

    def process(self):
        return ProcessMac()

    def notify(self):
        return NotifyMac()
