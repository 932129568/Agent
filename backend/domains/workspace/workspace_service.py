# -*- coding: utf-8 -*-
"""Workspace 服务：全局 + 会话双模型工作区、recent 列表、worklog、附件导入。

legacy Api L19-21/L830-977 搬迁；session 映射持有自己的锁（不再借用 _WS_LOCK）；
ws_enabled 收编 RuntimeState；copy_into_ws 补齐 P0 消毒（见 sanitize_name）。
"""
import datetime
import json
import os
import re
import shutil
import threading
import time

from ... import paths
from ...errors import err, ok
from ...fio import atomic_write_json
from ...logging_setup import get_logger


class WorkspaceService:
    def __init__(self, runtime, config_service):
        self._log = get_logger()
        self.runtime = runtime
        self.config = config_service
        self._lock = threading.RLock()
        self._session_ws = {}
        self._load_session_ws()
        self.runtime.load_ws_enabled(self._log)

    # ---- 会话工作区持久化（legacy L28-47）----
    def _load_session_ws(self):
        try:
            with open(paths.SESSION_WS_FILE, 'r', encoding='utf-8') as f:
                d = json.load(f)
            for sid, p in (d or {}).items():
                if isinstance(p, str) and os.path.isdir(p):
                    self._session_ws[sid] = os.path.abspath(p)
        except FileNotFoundError:
            pass
        except Exception as e:
            self._log.warning('会话工作区状态损坏，已备份为 .bad: %r', e)
            try:
                os.replace(paths.SESSION_WS_FILE, paths.SESSION_WS_FILE + '.bad')
            except Exception:
                pass

    def _save_session_ws(self):
        try:
            os.makedirs(paths.CONFIG_DIR, exist_ok=True)
            with self._lock:
                snap = dict(self._session_ws)
            atomic_write_json(paths.SESSION_WS_FILE, snap)   # 修复 S8：原子写
        except Exception as e:
            self._log.warning('会话工作区状态保存失败: %r', e)

    # ---- 生效根目录 / 短路径（legacy L182-186/L209-216）----
    def effective_root(self, sid):
        if sid:
            with self._lock:
                return self._session_ws.get(sid, self.config.cwd)
        return self.config.cwd

    @staticmethod
    def short_path(root, abs_p):
        try:
            rel = os.path.relpath(abs_p, root)
            if not rel.startswith('..'):
                return rel.replace('\\', '/')
        except Exception:
            pass
        return abs_p

    # ---- 会话工作区（legacy L830-845）----
    def set_session_ws(self, sid, path, enabled=True):
        if not sid:
            return ok({'ok': False, 'error': '缺少 sid'})
        with self._lock:
            if (not path) or (not enabled):
                self._session_ws.pop(sid, None)
            else:
                if not os.path.isdir(path):
                    return ok({'ok': False, 'error': f'目录不存在: {path}'})
                self._session_ws[sid] = os.path.abspath(path)
        self._save_session_ws()
        try:
            self.touch_recent_ws(path or self.config.cwd)
        except Exception as e:
            self._log.warning('recent 记录失败: %r', e)
        ws = self._session_ws.get(sid, self.config.cwd)
        return ok({'ok': True, 'sid': sid, 'ws': ws,
                   'bound': bool(self._session_ws.get(sid))})

    def get_session_ws(self, sid):
        with self._lock:
            ws = self._session_ws.get(sid or '', None)
        return ok({'ws': ws or self.config.cwd, 'bound': bool(ws)})

    def get_effective_ws(self, sid):
        ws = self.config.cwd
        src = 'global'
        if sid:
            with self._lock:
                bound = self._session_ws.get(sid)
                if bound:
                    ws = bound
                    src = 'session'
        return ok({'sid': sid, 'ws': ws, 'source': src,
                   'exists': bool(ws and os.path.isdir(ws))})

    def delete_session_ws(self, sid):
        sid = sid or ''
        with self._lock:
            self._session_ws.pop(sid, None)
        self.runtime.pop_ws_enabled(sid)
        self._save_session_ws()
        self.runtime.save_ws_enabled(self._log)
        return '{"ok":true}'

    # ---- ws_enabled 开关（委托 RuntimeState）----
    def set_ws_enabled(self, sid, enabled):
        self.runtime.set_ws_enabled(sid, enabled)
        self.runtime.save_ws_enabled(self._log)
        return ok({'ok': True, 'enabled': bool(enabled)})

    def get_ws_enabled(self, sid):
        v = self.runtime.ws_enabled_for(sid)
        return ok({'enabled': bool(v)})

    def get_ws_state(self, sid):
        with self._lock:
            ws = self._session_ws.get(sid or '', None)
        recent = []
        try:
            with open(paths.RECENT_WS_FILE, 'r', encoding='utf-8') as f:
                recent = json.load(f)
            if not isinstance(recent, list):
                recent = []
        except Exception as e:
            self._log.warning('recent 工作区读取失败: %r', e)
            recent = []
        return ok({'ws': ws or self.config.cwd, 'bound': bool(ws),
                   'enabled': bool(self.runtime.ws_enabled_for(sid)),
                   'recent': recent[:8]})

    # ---- recent 列表（legacy L847-864）----
    def touch_recent_ws(self, path):
        # R40 修复（N15）：读改写包进实例锁——原无锁，并行会话 set_session_ws
        # 交叠时后写覆盖前写（recent 条目丢失）。调用方持锁场景 RLock 可重入。
        with self._lock:
            rec = []
            if os.path.exists(paths.RECENT_WS_FILE):
                with open(paths.RECENT_WS_FILE, 'r', encoding='utf-8') as f:
                    rec = json.load(f)
            rec = [r for r in rec if r.get('path') != path]
            rec.insert(0, {'path': path, 'name': os.path.basename(path) or path, 'ts': time.time()})
            atomic_write_json(paths.RECENT_WS_FILE, rec[:12], indent=1)   # 修复 S8：原子写

    def list_recent_ws(self):
        try:
            with open(paths.RECENT_WS_FILE, 'r', encoding='utf-8') as f:
                return json.dumps(json.load(f), ensure_ascii=False)
        except Exception as e:
            self._log.warning('recent 工作区列表读取失败: %r', e)
            return '[]'

    # ---- 全局目录（legacy L905-912）----
    def set_ws_dir(self, path):
        if not path or not os.path.isdir(path):
            return ok({'ok': False, 'error': '目录不存在'})
        # 修复 建议⑧（二轮）：走 ConfigService.set_cwd（锁内赋值+持久化）——
        # 原锁外直改 cwd 且不落盘，重启丢工作区
        self.config.set_cwd(path)
        try:
            self.touch_recent_ws(self.config.cwd)
        except Exception as e:
            self._log.warning('recent 记录失败: %r', e)
        return ok({'ok': True, 'ws': self.config.cwd})

    # ---- 原生选目录（legacy L923-935；webview 延迟导入，无 GUI 环境可用本服务）----
    def pick_folder(self, sid=None):
        try:
            import webview
            wins = webview.windows
            if not wins:
                return ok({'ok': False, 'err': 'no window'})
            picked = wins[0].create_file_dialog(webview.FOLDER_DIALOG)
            if not picked:
                return ok({'ok': False, 'err': 'cancelled'})
            path = picked if isinstance(picked, str) else picked[0]
            return ok({'ok': True, 'path': path})
        except Exception as e:
            return ok({'ok': False, 'err': f'{type(e).__name__}: {e}'})

    # ---- 附件导入（legacy L937-949 + P0 修复）----
    @staticmethod
    def sanitize_name(name):
        """消毒文件名：非法字符替换（同 save_workspace_file 标准）+ 禁止 .. 穿越。"""
        safe = re.sub(r'[\\/:*?<>|]', '_', str(name or 'attachment'))
        safe = safe.replace('..', '__')
        return safe or 'attachment'

    def copy_into_ws(self, sid, src, name):
        try:
            if not src or not os.path.isfile(src):
                return err(f'文件不存在: {src}')
            root = self.effective_root(sid)
            adir = os.path.join(root, 'attachments')
            os.makedirs(adir, exist_ok=True)
            base = datetime.datetime.now().strftime('%H%M%S_') + self.sanitize_name(name or os.path.basename(src))
            dst = os.path.join(adir, base)
            # 双保险：目标必须仍在 attachments 内
            norm_dst = os.path.normcase(os.path.realpath(dst))
            norm_adir = os.path.normcase(os.path.realpath(adir))
            if norm_dst != norm_adir and not norm_dst.startswith(norm_adir + os.sep):
                return err(f'非法文件名: {name}')
            shutil.copyfile(src, dst)   # 修复 建议④：顶部 import，不再函数级动态 import
            return ok({'ok': True, 'path': dst})
        except Exception as e:
            return err(e)

    # ---- worklog（legacy L951-977）----
    def worklog_path(self, sid):
        root = self.config.cwd
        if sid:
            with self._lock:
                root = self._session_ws.get(sid, self.config.cwd)
        return os.path.join(root, '_glm_worklog.md')

    def get_worklog(self, sid):
        try:
            p = self.worklog_path(sid)
            if os.path.exists(p):
                with open(p, 'r', encoding='utf-8', errors='replace') as f:
                    return f.read()
        except Exception as e:
            self._log.warning('worklog 读取失败: %r', e)
        return ''

    def append_worklog(self, sid, text):
        try:
            p = self.worklog_path(sid)
            ts = datetime.datetime.now().strftime('%m-%d %H:%M')
            line = f'- [{ts}] {str(text)[:500]}\n'
            with open(p, 'a', encoding='utf-8') as f:
                f.write(line)
            return '{"ok":true}'
        except Exception as e:
            return err(e)

    # ---- save_workspace_file（legacy L218-225）----
    def save_workspace_file(self, sid, name, text):
        # 修复 H12（四轮）：① 复用 sanitize_name（含 .. 消毒，原只替换分隔符）；
        # ② 外层异常保护——原 OSError（目录只读/盘满/非法名）穿透 js_api 桥成为裸 reject。
        try:
            root = self.effective_root(sid)
            d = os.path.join(root, 'attachments')
            os.makedirs(d, exist_ok=True)
            safe = self.sanitize_name(name)
            p = os.path.join(d, datetime.datetime.now().strftime('%Y%m%d_%H%M%S_') + safe)
            with open(p, 'w', encoding='utf-8', errors='replace') as f:
                f.write(str(text))
            return p
        except Exception as e:
            self._log.warning('save_workspace_file 失败: %r', e)
            return ''
