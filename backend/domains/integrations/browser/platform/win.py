# -*- coding: utf-8 -*-
"""v1.9.0 M1.4 · Windows 平台服务适配（DPAPI/JobObject/ImageGrab/send2trash/tasklist/toast）。

适配表（设计文档 §A3.2）：全部**直委**既有 service——不重造轮子，行为与既有
路径同源；其中 TrashWin 与 file_service.delete_path(recycle=True) 的 recycle
分支**同逻辑复刻**（设计文档明示：同源不抽公共——防迁移期行为漂移）。

依赖面：send2trash / PIL.ImageGrab 为运行时可选（Harbor.spec hiddenimports
已在位）；缺失走结构化降级（delete+警示 / SCREEN 错误载荷），不抛。
"""
import datetime
import json
import os
import shutil
import subprocess
import threading

from ..... import paths
from .....fio import atomic_write_json
from .....logging_setup import get_logger
from ...mcp.mcp_dpapi import decrypt_value, encrypt_value
from ...mcp.mcp_dpapi import is_available as dpapi_available
from ....workspace.process_service import ProcessService
from ....workspace.sandbox_service import SandboxService, run_in_sandbox
from ....workspace.sandbox_service import SandboxUnavailable
from ....workspace.screenshot_service import ScreenshotService
from ..session_base import BrowserError, BrowserErrorCode
from .base import (Notify, Paths, PlatformServices, Process, Sandbox, Screen,
                   Secrets, Trash)

# subprocess 禁弹窗（与 process_service 同口径）
_NO_WINDOW = 0x08000000


def _utc_now_z():
    """ISO8601 UTC 'Z' 后缀（B8.5 时间口径：新代码统一）。"""
    return datetime.datetime.now(datetime.timezone.utc) \
        .replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def _as_dict(raw):
    """JSON 串 → dict（其余原样；失败 → {}）。"""
    if isinstance(raw, str):
        try:
            d = json.loads(raw)
            return d if isinstance(d, dict) else {}
        except Exception:
            return {}
    return dict(raw) if isinstance(raw, dict) else {}


def _dec(raw):
    """bytes → utf-8 replace；str 原样；None → ''。"""
    if isinstance(raw, (bytes, bytearray)):
        return bytes(raw).decode('utf-8', 'replace')
    return '' if raw is None else str(raw)


class SecretsWin(Secrets):
    """系统钥匙串（Win DPAPI 加密存储；M1.4）。

    清单落 ``~/.glm-chat/platform/secrets.json``（paths.PLATFORM_DIR；T01
    新增常量 + ensure_dirs 建目录）：``{"<svc>|<acct>": {"enc": "<DPAPI
    marker>", "updated_at": iso}}``——键名明文、值均经 mcp_dpapi 加密
    （既有 DPAPI 封装直委）。

    非 Windows / DPAPI 不可用 → 写路径 fail-closed 回
    ``{ok: False, error: 'SECRETS_UNAVAILABLE'}``（禁明文落敏感值）；
    读/删为本地文件操作不设此门（decrypt_value 对解密失败有明文兜底）。
    """

    def __init__(self, path=None):
        self._log = get_logger()
        self._path = path or os.path.join(paths.PLATFORM_DIR, 'secrets.json')
        self._lock = threading.RLock()

    # ---- 内部：清单读写（持锁；原子写防半截文件）----
    def _load(self):
        try:
            with open(self._path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except FileNotFoundError:
            return {}
        except Exception as e:
            self._log.warning('secrets 清单读取失败（按空处理）: %r', e)
            return {}

    def _save(self, data):
        os.makedirs(os.path.dirname(self._path), exist_ok=True)
        atomic_write_json(self._path, data)

    @staticmethod
    def _key(service, account):
        return '%s|%s' % (str(service or ''), str(account or ''))

    def set(self, service, account, secret):
        """写入密钥 → ``{ok}`` | ``{ok: False, error: 'SECRETS_UNAVAILABLE'|'BAD_PARAMS'}``。"""
        if not dpapi_available():
            return {'ok': False, 'error': 'SECRETS_UNAVAILABLE',
                    'message': '当前环境不可用 DPAPI（非 Windows 或 crypt32 缺失）'}
        svc, acct = str(service or ''), str(account or '')
        if not svc or not acct:
            return {'ok': False, 'error': 'BAD_PARAMS',
                    'message': 'service/account 不能为空'}
        marker = encrypt_value(str(secret or ''))
        with self._lock:
            data = self._load()
            data[self._key(svc, acct)] = {'enc': marker,
                                          'updated_at': _utc_now_z()}
            self._save(data)
        return {'ok': True}

    def get(self, service, account):
        """读取密钥 → ``{ok, secret}`` | ``{ok: False, error: 'NOT_FOUND'}``。"""
        with self._lock:
            entry = self._load().get(self._key(service, account))
        if not isinstance(entry, dict) or 'enc' not in entry:
            return {'ok': False, 'error': 'NOT_FOUND',
                    'message': '密钥不存在: %s|%s'
                               % (str(service or ''), str(account or ''))}
        return {'ok': True, 'secret': decrypt_value(entry.get('enc'))}

    def delete(self, service, account):
        """删除密钥 → ``{ok, removed}``（幂等：不存在 removed=False）。"""
        with self._lock:
            data = self._load()
            key = self._key(service, account)
            removed = key in data
            if removed:
                data.pop(key)
                self._save(data)
        return {'ok': True, 'removed': removed}


class SandboxWin(Sandbox):
    """Job Object 沙箱（直委 sandbox_service；fail-closed 不抛）。"""

    def __init__(self, service=None):
        self._svc = service if service is not None else SandboxService()

    def available(self):
        return bool(self._svc.available())

    def limits_for(self, command_class):
        """命令类别 → 限制字典；None = 不沙箱（disabled 或该类别 off）。"""
        return self._svc.limits_for(command_class)

    def run(self, args, shell=False, cwd=None, timeout=60, limits=None):
        """沙箱内执行 → ``{ok, returncode, stdout, stderr, timed_out, sandboxed}``。

        沙箱不可用 → ``{ok: False, error: 'SANDBOX_UNAVAILABLE', message}``
        （禁抛穿透——B8.9）。
        """
        try:
            r = run_in_sandbox(args, shell=shell, cwd=cwd, timeout=timeout,
                               limits=limits)
        except SandboxUnavailable as e:
            return {'ok': False, 'error': 'SANDBOX_UNAVAILABLE',
                    'message': str(e)}
        except Exception as e:
            return {'ok': False, 'error': 'SANDBOX_RUN_FAILED',
                    'message': str(e)}
        return {'ok': True, 'returncode': r.returncode,
                'stdout': _dec(r.stdout), 'stderr': _dec(r.stderr),
                'timed_out': bool(r.timed_out), 'sandboxed': bool(r.sandboxed)}


class ScreenWin(Screen):
    """截屏（直委 screenshot_service.ScreenshotService.take_screenshot）。"""

    def __init__(self, service=None):
        self._svc = service if service is not None else ScreenshotService()

    def capture(self, left=None, top=None, width=None, height=None):
        """截屏（可传区域）→ ``{ok, path, size?}`` | ``{ok: False, error}``。"""
        try:
            payload = _as_dict(self._svc.take_screenshot(left, top, width,
                                                         height))
        except Exception as e:
            return {'ok': False, 'error': 'SCREEN_UNAVAILABLE',
                    'message': str(e)}
        if not payload.get('ok'):
            return {'ok': False, 'error': 'SCREEN_CAPTURE_FAILED',
                    'message': payload.get('error') or '截屏失败'}
        return {'ok': True, 'path': payload.get('path'),
                'size': payload.get('size')}


class TrashWin(Trash):
    """回收站（send2trash 优先；缺失/故障 → 永久删除 + 警示）。

    与 file_service.delete_path(recycle=True) 的 recycle 分支**同逻辑复刻**
    （设计文档 §A3.2 明示：同源不抽公共——防迁移期行为漂移）：
    send2trash 有「先移动成功、后抛错」的实现——以文件是否仍在磁盘为准，
    已消失即回收成功；确在磁盘的才回落永久删除并带醒目警示。
    """

    def trash(self, path):
        """删除路径 → ``{ok, path, mode: 'recycle'|'delete', warning?}``。"""
        p = str(path or '')
        if not p:
            return {'ok': False, 'error': 'BAD_PARAMS',
                    'message': 'path 不能为空'}
        if not os.path.exists(p):
            return {'ok': False, 'error': 'NOT_FOUND',
                    'message': '路径不存在: %s' % p}
        send2trash_unavailable = False
        trash_broken = False
        try:
            from send2trash import send2trash
            send2trash(p)
            return {'ok': True, 'path': p, 'mode': 'recycle'}
        except ImportError:
            send2trash_unavailable = True
        except Exception:
            # 环境性回收站故障（send2trash 实现缺陷 / 回收站被禁用等）：
            # 已消失即回收成功（勿把成功的回收报成失败）
            if not os.path.exists(p):
                return {'ok': True, 'path': p, 'mode': 'recycle'}
            trash_broken = True
        try:
            if os.path.isdir(p):
                shutil.rmtree(p)
            else:
                os.remove(p)
        except Exception as e:
            return {'ok': False, 'error': 'DELETE_FAILED', 'message': str(e)}
        out = {'ok': True, 'path': p, 'mode': 'delete'}
        if send2trash_unavailable:
            out['warning'] = ('send2trash 缺失，未进回收站（永久删除）'
                              '⚠️不可恢复，请谨慎')
        elif trash_broken:
            out['warning'] = ('回收站暂不可用，未进回收站（永久删除）'
                              '⚠️不可恢复，请谨慎')
        return out


class PathsWin(Paths):
    """目录口径（Harbor 单一 ~/.glm-chat；mac 分支 M6.7 对映）。"""

    def config_dir(self):
        return paths.CONFIG_DIR

    def data_dir(self):
        # Harbor 数据与配置同目录（既有口径；sessions/toolcache 等均落此）
        return paths.CONFIG_DIR

    def profiles_dir(self):
        # 浏览器 profile 根（T01 新增常量；与主窗 webview_data 隔离）
        return paths.BROWSER_PROFILE_DIR


class ProcessWin(Process):
    """进程管理（直委 process_service.ProcessService）。"""

    def __init__(self, service=None):
        self._svc = service if service is not None else ProcessService()

    def list(self, keyword=''):
        """进程枚举 → list[str]（直委 list_processes，按 ABC 契约抽取 processes）。

        委托失败/带 error → []（降级不抛，B8.9）。
        """
        payload = _as_dict(self._svc.list_processes(keyword or None))
        if not payload.get('ok') or payload.get('error'):
            return []
        return list(payload.get('processes') or [])

    def kill(self, pid=None, name=None):
        """结束进程 → 委托 kill_process 载荷（含保护名单拒绝语义）。"""
        return _as_dict(self._svc.kill_process(pid=pid, name=name))

    def resolve_name(self, pid):
        """pid → 进程名；查不到/失败 → None。"""
        return self._svc.resolve_name_by_pid(pid)


class NotifyWin(Notify):
    """Windows toast 通知（PowerShell WinRT，best-effort，永不抛）。

    超时 3s、禁阻塞启动；任何失败 → ``{ok: False, error: 'NOTIFY_UNAVAILABLE'}``。
    """

    _TIMEOUT_S = 3

    @staticmethod
    def _ps_literal(text):
        """PowerShell 单引号字面量转义（防脚本注入：单引号翻倍 + 去控制符）。"""
        s = ''.join(ch for ch in str(text or '')
                    if ch >= ' ' or ch in '\t')
        return "'" + s.replace("'", "''") + "'"

    def notify(self, title, message):
        """弹系统通知 → ``{ok}`` | ``{ok: False, error: 'NOTIFY_UNAVAILABLE'}``（永不抛）。"""
        try:
            t = self._ps_literal(title)
            m = self._ps_literal(message)
            script = (
                '$ErrorActionPreference = "Stop";'
                '[Windows.UI.Notifications.ToastNotificationManager, '
                'Windows.UI.Notifications, ContentType=WindowsRuntime] > $null;'
                '$x=[Windows.UI.Notifications.ToastNotificationManager]'
                '::GetTemplateContent('
                '[Windows.UI.Notifications.ToastTemplateType]::ToastText02);'
                '$s=$x.GetElementsByTagName("text");'
                '$s.Item(0).AppendChild($x.CreateTextNode(%s)) > $null;'
                '$s.Item(1).AppendChild($x.CreateTextNode(%s)) > $null;'
                '$toast=[Windows.UI.Notifications.ToastNotification]::new($x);'
                '[Windows.UI.Notifications.ToastNotificationManager]'
                '::CreateToastNotifier("Harbor").Show($toast);' % (t, m))
            subprocess.run(
                ['powershell', '-NoProfile', '-NonInteractive', '-Command',
                 script],
                capture_output=True, timeout=self._TIMEOUT_S,
                creationflags=_NO_WINDOW)
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'error': 'NOTIFY_UNAVAILABLE',
                    'message': str(e)}


class WinPlatformServices(PlatformServices):
    """Windows 七接口聚合（M1.4；进程内复用同一批实例）。"""

    name = 'win'

    def __init__(self):
        self._secrets = SecretsWin()
        self._sandbox = SandboxWin()
        self._screen = ScreenWin()
        self._trash = TrashWin()
        self._paths = PathsWin()
        self._process = ProcessWin()
        self._notify = NotifyWin()

    def secrets(self):
        return self._secrets

    def sandbox(self):
        return self._sandbox

    def screen(self):
        return self._screen

    def trash(self):
        return self._trash

    def paths(self):
        return self._paths

    def process(self):
        return self._process

    def notify(self):
        return self._notify


__all__ = [
    'SecretsWin', 'SandboxWin', 'ScreenWin', 'TrashWin', 'PathsWin',
    'ProcessWin', 'NotifyWin', 'WinPlatformServices', 'BrowserError',
    'BrowserErrorCode',
]
