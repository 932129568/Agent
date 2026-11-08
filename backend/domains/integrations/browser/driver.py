# -*- coding: utf-8 -*-
"""v1.9.0 M3 · 浏览器驱动服务（六原语会话池 + js_api 提取桥 + 下载拦截）。

与搜索管线解耦（design §A3.3 裁决）：SearchService→SearchBrowser 搜索次窗
不动；本模块为 AI 驱动管线专用——BrowserService（会话池：上限 3/空闲 60s
回收/browser_sessions.json 投影）→ WinSession（六原语状态机）→
DriverWindow（每会话一驱动次窗，js_api=Bridge）。

模块职责（master-plan §149 M3.3-3.8）：
- ``Bridge``（M3.5）：js_api 提取桥——页面 ``window.pywebview.api.on_extract(
  json)`` 回调收集（持锁）；open_external（外链 → 系统浏览器，M3.6 外链
  策略——host 白名单校验 + 审计钩子，毒网页可伪造调用但无提权面）；
  download_blocked（下载拦截记录——默认禁下载，M3.6）。
- ``DriverWindow``（M3.3/M3.6）：每会话一窗（独立 profile 子目录，与搜索
  webview 隔离）；``open_url``（加载事件 + wait_selector 轮询 + DOM 稳定
  三保险，M5.6）；``eval_js``（**加锁单门——pywebview 官方明示 evaluate_js
  线程不安全**）；``capture_b64``（win32 PrintWindow 窗口捕获，失败降级
  ImageGrab 窗口矩形）；``set_visible``（可见/隐藏驱动模式切换，M3.8——
  复用 CAPTCHA 接管同款 show 机制）；策略 JS 注入（外链/下载拦截）。
- ``BrowserService``（M3.7）：会话池（上限 3；满时驱逐最旧空闲会话——
  规格原文「排队」，实现偏差已在注释论证：js_api 无等待语义、LLM 调用方
  无法等待异步 close 事件，驱逐最旧空闲（浏览器 tab discard 同型）+
  空闲 60s 回收线程兜底）；无 id 原语作用于最近 navigate 的游标会话；
  ``browser_sessions.json`` 投影（master-plan §6.1 形状）。

纯 IO 边界：窗口操作经 pywebview 延迟导入；``import`` 无副作用，无 GUI
环境可导入与单测（fake channel 注入）。降级永不阻断（B8.9）：一切
BrowserError 经 ``to_payload`` 结构化返回，禁异常穿透 js_api。
"""
import base64
import json
import os
import shutil
import threading
import time
import urllib.parse

from .... import paths
from ....fio import atomic_write_json
from ....logging_setup import get_logger
from .native_port import UnavailableDispatcher
from . import create_session
from .session_base import BrowserError, BrowserErrorCode, _is_public_host
from .session_win import build_wait_js, map_js_result

# 会话池口径（master-plan §149 3.7：上限 3 / 空闲 60s 回收）
POOL_LIMIT = 3
IDLE_SECONDS = 60.0
_SWEEP_TICK = 5.0
# evaluate_js 派发 join 上限（单次 JS 调用；看门狗——不可泵送会话不挂死调用方）
EVAL_JS_TIMEOUT = 6.0
# wait_selector 轮询参数（M5.6 三保险：选择器轮询 0.3s 步进 + DOM 稳定三连稳）
_WAIT_POLL_S = 0.3
_DOM_STABLE_N = 3

# M3.6 策略 JS：外链 target=_blank → 系统浏览器；download/blob → 拦截记录。
# 幂等（__harbor_policy_installed 标记）；捕获阶段（true）保证先于页面默认行为。
_POLICY_JS = (
    '(function(){'
    'if(window.__harbor_policy_installed){return "ok";}'
    'window.__harbor_policy_installed=true;'
    'document.addEventListener("click",function(e){'
    'var a=e.target&&e.target.closest?e.target.closest("a"):null;'
    'if(!a){return;}'
    'var api=window.pywebview&&window.pywebview.api;'
    'if(!api){return;}'
    'var href=String(a.href||"");'
    'if(a.hasAttribute("download")||href.indexOf("blob:")===0'
    '||href.indexOf("data:")===0){'
    'e.preventDefault();'
    'try{api.download_blocked(href);}catch(_){}'
    'return;}'
    'if(String(a.target||"").toLowerCase()==="_blank"){'
    'e.preventDefault();'
    'try{api.open_external(href);}catch(_){}}'
    '},true);'
    'return "ok";'
    '})()')


class Bridge:
    """M3.5 js_api 提取桥（pywebview 次窗 js_api 对象；页面可调三个方法）。

    安全口径：页面脚本可伪造调用，故 open_external 只接受 http(s) 公网
    URL（_is_public_host 同口径 SSRF 防护），download_blocked/on_extract
    纯记录零副作用——伪造面=灌日志/灌提取队列（容量上限防 OOM），无提权。
    """

    def __init__(self, logger=None, on_external=None, on_blocked=None):
        self._log = logger or get_logger()
        self._lock = threading.Lock()
        self._extracts = []            # on_extract 收集（三重容量上限防 OOM）
        self._extract_bytes = 0
        self._blocked = []             # 下载拦截记录
        self._on_external = on_external   # 外链回调（后端 webbrowser.open + 审计）
        self._on_blocked_cb = on_blocked

    # ---- 页面可调（js_api 表面）----
    # 单条提取载荷字节上限（毒网页灌超大 JSON 防 OOM；64 条计数上限不变，
    # 累计 4MB 封顶——双闸后提取队列内存有界）
    _MAX_EXTRACT_ITEM = 256 * 1024
    _MAX_EXTRACT_TOTAL = 4 * 1024 * 1024

    def on_extract(self, payload_json):
        """页面提取回调：payload_json（JSON 串或 dict）→ 收集（条数 64 +
        单条 256KB + 累计 4MB 三重上限）。"""
        try:
            raw = payload_json if isinstance(payload_json, str) \
                else json.dumps(payload_json, ensure_ascii=False)
            if len(raw) > self._MAX_EXTRACT_ITEM:
                self._log.info('提取载荷超单条上限（%d 字节），已丢弃', len(raw))
                return 'ok'
            d = json.loads(raw) if isinstance(payload_json, str) \
                else payload_json
            if not isinstance(d, dict):
                return 'ok'
        except Exception:
            return 'ok'    # 畸形载荷丢弃（毒网页灌垃圾不炸桥）
        with self._lock:
            if len(self._extracts) < 64 \
                    and self._extract_bytes + len(raw) <= self._MAX_EXTRACT_TOTAL:
                self._extracts.append(d)
                self._extract_bytes += len(raw)
        return 'ok'

    def open_external(self, url):
        """外链策略：target=_blank → 系统浏览器（仅 http(s) 公网；毒网页伪造
        调用无提权——非公网一律拒绝 + 记录）。"""
        u = str(url or '')
        from .session_base import _is_public_host
        from urllib.parse import urlsplit
        ok_url = u.lower().startswith(('http://', 'https://')) and \
            _is_public_host(urlsplit(u).hostname)
        if ok_url and callable(self._on_external):
            try:
                self._on_external(u)
            except Exception:
                pass
        else:
            self._log.info('外链策略拒绝非公网/非 http(s) URL: %s', u[:120])
        return 'ok'

    def download_blocked(self, url):
        """下载拦截（M3.6 默认禁）：记录 + 审计回调（不落盘、不打开）。"""
        u = str(url or '')[:500]
        with self._lock:
            if len(self._blocked) < 64:
                self._blocked.append(u)
        if callable(self._on_blocked_cb):
            try:
                self._on_blocked_cb(u)
            except Exception:
                pass
        self._log.info('已拦截下载请求（默认禁下载）: %s', u[:120])
        return 'ok'

    # ---- 后端读取 ----
    def extracts(self):
        with self._lock:
            return list(self._extracts)

    def blocked(self):
        with self._lock:
            return list(self._blocked)

    def pop_extracts(self):
        with self._lock:
            out = self._extracts
            self._extracts = []
            self._extract_bytes = 0
            return out


class DriverWindow:
    """M3 驱动次窗：每会话一窗（独立 profile 子目录 + js_api=Bridge）。

    与 SearchBrowser 的分工：搜索次窗单例共享（_win 复用），驱动次窗每会话
    独立（会话池上限 3 → 最多 3 窗）；窗口创建参数阶梯复用 SearchBrowser
    的 try 兜底经验。**evaluate_js 全部经 ``_js_lock`` 单门串行**（pywebview
    官方明示线程不安全——M3.5 加锁要求）。
    """

    supports_wait = True
    WINDOW_WIDTH = 1024
    WINDOW_HEIGHT = 768

    def __init__(self, bridge=None, user_data_dir='', visible=False,
                 title='Harbor 浏览器驱动', dispatcher=None):
        self._log = get_logger()
        self._dispatcher = dispatcher or UnavailableDispatcher()
        self._bridge = bridge if bridge is not None else Bridge()
        self._user_data_dir = user_data_dir
        self._visible = bool(visible)
        self._title = title
        self._win = None
        self._js_lock = threading.Lock()
        self._loaded_lock = threading.Lock()
        self._loaded_url = ''
        # evaluate_js 可泵送性（SearchBrowser._dom_pumpable 同款）：首次 join
        # 超时即退役——僵尸 worker 仍阻塞在 win.evaluate_js 内，若继续派发
        # 新 worker 会与僵尸并发（违反「线程不安全→单门串行」前提）且每超时
        # 泄漏一个 daemon 线程
        self._pumpable = True

    # ---- 窗口创建/销毁 ----
    def _ensure_window(self):
        win = self._win
        if win is not None:
            return win
        try:
            import webview   # 延迟导入：无 GUI 环境（测试/嵌入）不炸
        except Exception as e:
            self._log.debug('webview 不可用，驱动原语降级: %r', e)
            return None
        if self._user_data_dir:
            try:
                os.makedirs(self._user_data_dir, exist_ok=True)
            except Exception:
                pass
        # 次窗 url 必须与主窗口同盘符（main.py 2026-10-20 启动崩溃实证：
        # 'about:blank' 被 is_local_url 判 True，与主窗 file:///C:/... 取
        # commonpath 报「Paths don't have the same drive」崩在 webview.start()）
        # ——指向主窗同一 harbor.html（驱动次窗 hidden，用时 load_url 导航）
        try:
            _url = paths.get_html_path()
        except Exception:
            _url = 'about:blank'
        attempts = (
            {'title': self._title, 'url': _url, 'js_api': self._bridge,
             'width': self.WINDOW_WIDTH, 'height': self.WINDOW_HEIGHT,
             'hidden': not self._visible,
             'user_data_folder': self._user_data_dir or None},
            {'title': self._title, 'url': _url, 'js_api': self._bridge,
             'width': self.WINDOW_WIDTH, 'height': self.WINDOW_HEIGHT,
             'hidden': not self._visible},
            {'title': self._title, 'url': _url, 'js_api': self._bridge},
        )
        for kw in attempts:
            try:
                win = self._dispatcher.create(
                    'driver:%d' % id(self), lambda: webview.create_window(**kw))
                break
            except TypeError:
                continue
            except Exception as e:
                self._log.warning('驱动次窗创建失败: %r', e)
                return None
        if win is None:
            return None
        self._win = win
        return win

    def destroy(self):
        win = self._win
        self._win = None
        if win is not None:
            try:
                self._dispatcher.destroy(win)
            except Exception:
                pass

    # ---- 取数（WinSession.open_url 协议）----
    def open_url(self, url, wait_selector='', timeout=60):
        """导航 + 等待三保险（M5.6）：loaded 事件 → wait_selector 轮询 →
        DOM 稳定三连稳 → 硬超时兜底。返回与 SearchBrowser.open_url 同构
        ``{ok, html, channel}``（channel='driver-window'）。"""
        u = str(url or '').strip()
        if not u:
            return {'ok': False, 'error': 'BAD_PARAMS', 'message': 'url 不能为空'}
        win = self._ensure_window()
        if win is None:
            return {'ok': False, 'error': 'WINDOW_UNAVAILABLE',
                    'message': '驱动次窗不可用（无 GUI 环境或创建失败）'}
        loaded = threading.Event()
        on_loaded = lambda: loaded.set()   # noqa: E731
        events = getattr(win, 'events', None)
        subscribed = False
        if events is not None and getattr(events, 'loaded', None) is not None:
            try:
                events.loaded += on_loaded
                subscribed = True
            except Exception:
                subscribed = False
        try:
            try:
                self._dispatcher.invoke(win, lambda: win.load_url(u), timeout=timeout,
                                        stage='navigate')
            except Exception as e:
                return {'ok': False, 'error': 'WINDOW_UNAVAILABLE',
                        'message': '驱动次窗加载失败: %r' % e}
            if not loaded.wait(min(8.0, max(1.0, float(timeout)))):
                return {'ok': False, 'error': 'TIMEOUT',
                        'message': '页面加载超时（loaded 事件 %ss）'
                                   % int(min(8.0, max(1.0, float(timeout))))}
            # 终态 URL 复检（SSRF 纵深防御）：WebView2 通道会跟随 302 重定向、
            # 页内 JS 也可改址——初始 URL 的 _is_public_host 只护入口，loaded
            # 后以 win.url 为准复检；非公网即 SSRF_BLOCKED（session_win 经
            # map_error_code 映射 BrowserError，服务层关会话防内网页面回流）。
            # 同时兜住「loaded 是窗口初始页事件」的竞态：win.url 仍是本地
            # harbor.html（非 http(s)）时短暂等待真实导航落定（≤2s 有界）。
            cur = ''
            for _ in range(10):
                try:
                    cur = str(getattr(win, 'url', '') or '')
                except Exception:
                    cur = ''
                if cur.lower().startswith(('http://', 'https://')):
                    break
                time.sleep(0.2)
            if cur.lower().startswith(('http://', 'https://')) \
                    and not _is_public_host(urllib.parse.urlsplit(cur).hostname):
                return {'ok': False, 'error': 'SSRF_BLOCKED',
                        'message': '导航终态落在内网/环回地址（重定向复检拦截）: %s'
                                   % cur[:120],
                        'hint': '目标站点将本页重定向到了内网地址，已按 SSRF 防护拦截'}
            ws = str(wait_selector or '').strip()
            deadline = time.monotonic() + max(1.0, float(timeout))
            if ws:
                while time.monotonic() < deadline:
                    r = self.eval_js(build_wait_js(ws), timeout=EVAL_JS_TIMEOUT)
                    if isinstance(r, str) and r == '1':
                        break
                    if isinstance(r, str) and r == 'e':
                        return {'ok': False, 'error': 'BAD_PARAMS',
                                'message': 'wait_selector 语法非法: %s' % ws[:80]}
                    time.sleep(_WAIT_POLL_S)
                else:
                    return {'ok': False, 'error': 'TIMEOUT',
                            'message': '等待选择器超时: %s' % ws[:80],
                            'hint': '页面可能未渲染目标元素（SPA 懒加载）'}
            # DOM 稳定三连稳（M5.6）：innerText 指纹连续 N 次一致 → 判稳
            self._wait_dom_stable(deadline)
            self._install_policy(win)
            html = self.eval_js(
                'document.documentElement.outerHTML', timeout=EVAL_JS_TIMEOUT)
            if not isinstance(html, str) or not html.strip():
                return {'ok': False, 'error': 'WINDOW_UNAVAILABLE',
                        'message': '无法读取页面内容（evaluate_js 不可用）'}
            with self._loaded_lock:
                self._loaded_url = u
            return {'ok': True, 'html': html, 'channel': 'driver-window'}
        finally:
            if subscribed:
                try:
                    events.loaded -= on_loaded
                except Exception:
                    pass

    def _wait_dom_stable(self, deadline):
        """DOM 稳定三保险之二：innerText 指纹三连稳（best-effort——不可泵送
        会话 eval_js 返回 None，直接跳过不阻塞）。"""
        last, stable = '', 0
        while time.monotonic() < deadline and stable < _DOM_STABLE_N:
            cur = self.eval_js('document.body?String(document.body.innerText'
                               '.length):"0"', timeout=EVAL_JS_TIMEOUT)
            cur = str(cur) if cur is not None else ''
            if cur == last and cur != '':
                stable += 1
            else:
                stable = 0
                last = cur
            if stable < _DOM_STABLE_N:
                time.sleep(_WAIT_POLL_S)

    def _install_policy(self, win):
        """M3.6：导航后注入外链/下载拦截策略 JS。

        页内 ``__harbor_policy_installed`` 标记保证单文档幂等；Python 侧
        **不设永久标记**——页内二次导航（点击链接等）产生的新文档没有策略
        JS，永久跳过会让下载拦截/外链管控在会话剩余生命周期静默失效。"""
        self.eval_js(_POLICY_JS, timeout=EVAL_JS_TIMEOUT)

    # ---- JS 派发（加锁单门）----
    def eval_js(self, code, timeout=EVAL_JS_TIMEOUT):
        """Dispatch through the window-affine adapter; timeout only quarantines."""
        if not self._pumpable or self._win is None:
            return None
        try:
            return self._dispatcher.evaluate(self._win, code, timeout=timeout)
        except Exception as error:
            if getattr(error, 'code', '') == 'NATIVE_UI_TIMEOUT':
                self._pumpable = False
                self._log.warning('evaluate_js 超时（%ss）——窗口隔离，未宣称底层停止', timeout)
            else:
                self._log.debug('evaluate_js 派发失败: %r', error)
            return None

    # ---- 窗口捕获 / 可见性 ----
    def capture_b64(self):
        """Capture through the same UI dispatcher; no worker reads raw HWND."""
        if self._win is None:
            return ''
        try:
            return self._dispatcher.invoke(
                self._win, lambda: self._capture_on_ui(self._win), stage='capture')
        except Exception as error:
            self._log.debug('窗口捕获失败: %r', error)
            return ''

    @staticmethod
    def _capture_on_ui(win):
        native = getattr(win, 'native', None)
        hwnd = getattr(native, 'Handle', None) if native is not None else None
        if not isinstance(hwnd, int) or not hwnd:
            return ''
        from .win_capture import capture_window_b64
        return capture_window_b64(hwnd)

    @property
    def viewport(self):
        return (self.WINDOW_WIDTH, self.WINDOW_HEIGHT)

    def set_visible(self, visible):
        """M3.8 可见/隐藏驱动模式：visible → show+activate（CAPTCHA 接管
        同款）；hidden → hide。best-effort 不抛。"""
        self._visible = bool(visible)
        win = self._win
        if win is None:
            return False
        try:
            if visible:
                fn = getattr(win, 'show', None)
                if callable(fn):
                    self._dispatcher.invoke(win, fn, stage='show')
            else:
                fn = getattr(win, 'hide', None)
                if callable(fn):
                    self._dispatcher.invoke(win, fn, stage='hide')
                    return True
                return False
            return True
        except Exception:
            return False

    def shutdown(self):
        self.destroy()

    # ---- 供 BrowserService 投影 ----
    @property
    def bridge(self):
        return self._bridge


def _utc_now_iso():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


class BrowserService:
    """M3.7 会话池：六原语 js_api 的后端管线（api.py browser_* 转正的数据源）。

    会话语义：navigate 无 id → 新建会话并成为**游标**（后续无 id 的
    extract/click/fill/screenshot 作用于游标会话）；browser_close('') =
    关闭全部（含空闲回收线程终止的进程退出路径由 shutdown 承担）。
    池满（上限 3）→ 驱逐最旧空闲会话（自动 close 腾槽）——规格原文
    「上限 3 + 排队」，实现取驱逐：js_api 同步调用无等待语义，LLM 调用方
    无法等待异步 close 事件；驱逐最旧空闲（Chrome tab discard 同型）+
    60s 空闲回收线程兜底，语义等价且不阻塞调用方（KNOWN_ISSUES 登记）。
    """

    def __init__(self, session_factory=None, pool_limit=POOL_LIMIT,
                 idle_seconds=IDLE_SECONDS, path=None, clock=None,
                 sweep_tick=_SWEEP_TICK, on_external=None, dispatcher=None):
        """Args:
            session_factory: ``(mode) -> BrowserSession``（测试注入 fake；
                缺省 win 平台 WinSession + DriverWindow 独立 profile 子目录）。
            path: browser_sessions.json 投影路径（缺省 paths.BROWSER_SESSIONS_FILE）。
            clock: time.monotonic 替身（测试注入）。
            sweep_tick: 回收扫描周期秒（测试可调小加速空闲回收验证）。
            on_external: 外链回调（M3.6 外链策略接线——api.py 装配传
                webbrowser.open + 审计；缺省 None 时公网 _blank 拦截后静默）。
        """
        self._log = get_logger()
        self._factory = session_factory or self._default_factory
        self._limit = int(pool_limit) if pool_limit else POOL_LIMIT
        self._idle = float(idle_seconds) if idle_seconds else IDLE_SECONDS
        self._path = path or paths.BROWSER_SESSIONS_FILE
        self._clock = clock or time.monotonic
        self._sweep_tick = float(sweep_tick)
        self._on_external = on_external
        self._dispatcher = dispatcher or UnavailableDispatcher()
        self._profile_seq = 0
        self._lock = threading.RLock()
        self._sessions = {}      # id -> {session, window, mode, created, last_url, last_used}
        self._cursor = ''
        self._seq = 0
        self._stop = threading.Event()
        self._sweeper = threading.Thread(target=self._sweep_loop, daemon=True,
                                         name='browser-driver-sweeper')
        self._sweeper.start()

    # ---- 会话工厂 ----
    def _default_factory(self, mode):
        # 平台分支（M4）：win → WinSession+DriverWindow（独立 profile 子目录）；
        # mac → MacSession（WKWebView，PyObjC 就绪时；理论实现真机验证 M9.5）。
        # profile 目录带自增序号：同毫秒两次导航共享目录会撞 WebView2
        # user-data-folder 锁（_default_factory 持池锁调用，序号递增无竞态）。
        from . import detect_platform
        plat = detect_platform()
        if plat == 'mac':
            from .session_mac import (MacSession, _default_webview_factory,
                                      mac_backend_available)
            if not mac_backend_available():
                raise BrowserError(
                    BrowserErrorCode.UNSUPPORTED_PLATFORM,
                    'macOS 浏览器后端需要 PyObjC 运行时'
                    '（pip install "pywebview[cocoa]"；真机链路验证排期 M9.5）')
            return MacSession(
                webview_factory=_default_webview_factory,
                bridge=Bridge(on_external=self._on_external)), None
        self._profile_seq += 1
        win = DriverWindow(visible=(mode == 'visible'), dispatcher=self._dispatcher,
                           user_data_dir=os.path.join(
                               paths.BROWSER_PROFILE_DIR, 'drv_%d_%d'
                               % (int(self._clock() * 1000), self._profile_seq)))
        return create_session('win', channel=win), win

    # ---- 六原语管线（api.py browser_* 数据源）----
    def navigate(self, url, wait_selector='', timeout=60, mode='hidden'):
        """新建会话并导航 → ``{ok, session_id, title, url, channel}``（会话
        成为游标）；可见模式（mode='visible'）次窗显示（M3.8 驱动模式切换）。"""
        m = str(mode or 'hidden').strip().lower()
        if m not in ('hidden', 'visible'):
            m = 'hidden'
        evicted = []
        with self._lock:
            self._evicted = evicted
            self._evict_if_full()
            # 工厂先行（未入池——失败零残留；BrowserError 结构化收口禁穿透 js_api）
            try:
                session, window = self._factory(m)
            except BrowserError as e:
                self._project()
                return e.to_payload()
            except Exception as e:
                return BrowserError(BrowserErrorCode.UNSUPPORTED_PLATFORM,
                                    '浏览器驱动后端不可用: %s' % e).to_payload()
            self._seq += 1
            sid = 'bs_%d_%s' % (int(self._clock()), os.urandom(3).hex())
            self._sessions[sid] = {
                'session': session, 'window': window, 'mode': m,
                'created': _utc_now_iso(), 'last_url': '', 'last_used': self._clock(),
                'busy': True,      # 导航在途：sweeper/驱逐跳过（防飞行中回收）
            }
            self._cursor = sid
        for e in evicted:          # 锁外关闭被驱逐会话（_drop 已在锁内摘除）
            self._close_entry(e)
        try:
            r = session.navigate(url, wait_selector, timeout)
        except BrowserError as e:
            with self._lock:
                dead = self._drop(sid)
                self._project()
            self._close_entry(dead)
            return e.to_payload()
        except Exception as e:      # 防御：会话层未预期异常禁穿透
            with self._lock:
                dead = self._drop(sid)
                self._project()
            self._close_entry(dead)
            return BrowserError(BrowserErrorCode.INTERNAL,
                                '导航失败: %s' % e).to_payload()
        # 导航期间会话可能已被并发移除（显式 close/shutdown）——禁把已死 id
        # 回填给调用方（否则无 id 原语会作用到另一个会话的页面，内容错配）
        with self._lock:
            entry = self._sessions.get(sid)
            if entry is not None:
                entry['last_url'] = str(url or '')
                entry['last_used'] = self._clock()
                entry['busy'] = False
                self._project()
        if entry is None:
            if isinstance(r, dict):
                r.pop('session_id', None)
            return BrowserError(
                BrowserErrorCode.SESSION_CLOSED,
                '会话在导航期间被关闭，请重试').to_payload()
        if isinstance(r, dict):
            r['session_id'] = sid
            r['mode'] = m
        return r

    def _prim(self, sid, fn):
        """原语分发公共路径：解析会话 → 调原语 → 刷新 last_used + 投影。

        busy 闸：原语执行期间（可达 timeout 上限）sweeper 不得回收——
        原 last_used 只在出口刷新，60s 超时即把在飞会话连窗销毁。"""
        with self._lock:
            entry = self._resolve(sid)
            if entry is None:
                return BrowserError(
                    BrowserErrorCode.BAD_PARAMS,
                    '没有可用浏览器会话（先 browser_navigate）',
                    '会话可能已被回收，请重新导航').to_payload()
            entry['busy'] = True
            session = entry['session']
        try:
            r = fn(session)
        except BrowserError as e:
            r = e.to_payload()
        except Exception as e:
            r = BrowserError(BrowserErrorCode.INTERNAL,
                             '浏览器原语失败: %s' % e).to_payload()
        with self._lock:
            entry['last_used'] = self._clock()
            entry['busy'] = False
            self._project()
        return r

    def extract(self, selector='', mode='markdown', session_id=''):
        return self._prim(session_id,
                          lambda s: s.extract(selector, mode))

    def snapshot(self, selector='', session_id='', max_chars=4000):
        """R43 语义快照原语（role/name/state 修剪树；_prim 走既有游标/忙态门）。"""
        return self._prim(session_id,
                          lambda s: s.snapshot(selector, max_chars))

    def snapshot_guarded(self, selector='', session_id='', max_chars=4000):
        """R43：与 extract_guarded 同口径——先检验证码特征再出树；成功载荷
        provenance 包裹（UNTRUSTED DATA 红线 4：快照含页面文本）。"""
        try:
            from .service import _captcha_signal
            if _captcha_signal(self._last_html(session_id)):
                return {'ok': False,
                        'error': {'code': 'CAPTCHA_REQUIRED',
                                  'message': '页面检出验证码特征——引擎要求人机验证',
                                  'hint': '可用 browser_navigate(mode="visible") 可见模式人工完成验证后重试'}}
        except Exception:
            pass
        r = self.snapshot(selector, session_id, max_chars)
        if isinstance(r, dict) and r.get('ok'):
            try:
                from ...providers.provenance import tag_payload
                r = tag_payload(r, source_url=self._last_url(session_id),
                                channel='driver-window')
            except Exception:
                pass
        return r

    def extract_guarded(self, selector='', mode='markdown', session_id=''):
        """M5.7 反爬检测：**先**检页面验证码特征（提取前——验证码页正文稀疏
        会先抛 EXTRACT_EMPTY 掩盖真因）→ 命中 → 结构化 CAPTCHA_REQUIRED
        （驱动管线提示用户切 mode='visible' 人工处理；搜索管线的
        browser_takeover 接管机制属搜索管线，此处不越界复用）。

        红线 4（M5.9 复核补接）：成功载荷 provenance 包裹（UNTRUSTED DATA
        进模型上下文前）——browser_search/browser_open/software_call 均已
        tag_payload，驱动管线此前漏接。"""
        try:
            from .service import _captcha_signal
            if _captcha_signal(self._last_html(session_id)):
                return {'ok': False,
                        'error': {'code': 'CAPTCHA_REQUIRED',
                                  'message': '页面检出验证码特征——引擎要求人机验证',
                                  'hint': '可用 browser_navigate(mode="visible") 可见模式人工完成验证后重试'}}
        except Exception:
            pass        # 反爬检测 best-effort（B8.9 降级不阻断）
        r = self.extract(selector, mode, session_id)
        if isinstance(r, dict) and r.get('ok'):
            try:
                from ...providers.provenance import tag_payload
                r = tag_payload(r, source_url=self._last_url(session_id),
                                channel='driver-window')
            except Exception:
                pass    # provenance 失败不阻断（B8.9 降级语义）
        return r

    def _last_url(self, session_id=''):
        """游标/指定会话的最近导航 URL（provenance source_url 数据源）。"""
        with self._lock:
            entry = self._resolve(session_id)
            return str((entry or {}).get('last_url', '') or '')

    def _last_html(self, session_id=''):
        with self._lock:
            entry = self._resolve(session_id)
            if entry is None:
                return ''
            s = entry.get('session')
            return getattr(s, '_html', '') or ''

    def click(self, target, session_id=''):
        return self._prim(session_id, lambda s: s.click(target))

    def fill(self, selector, text, session_id=''):
        return self._prim(session_id, lambda s: s.fill(selector, text))

    def screenshot(self, full_page=False, session_id=''):
        return self._prim(session_id, lambda s: s.screenshot(full_page))

    def close(self, session_id=''):
        """关闭会话：指定 id 关一个；''（缺省）关全部。"""
        with self._lock:
            if session_id:
                if session_id not in self._sessions:
                    return {'ok': True, 'closed': [], 'note': '会话不存在或已关闭'}
                entry = self._drop(session_id)
                ids = [session_id]
                self._project()
            else:
                ids = list(self._sessions)
                entries = [self._drop(sid) for sid in ids]
                self._cursor = ''
                self._project()
        # 锁外关闭（窗口 destroy 是跨线程 GUI 调度可能秒级阻塞——禁占池锁，
        # 否则 sweeper 与全部 browser_* js_api 调用被冻结）
        if session_id:
            self._close_entry(entry)
        else:
            for e in entries:
                self._close_entry(e)
        return {'ok': True, 'closed': ids}

    def set_mode(self, mode, session_id=''):
        """M3.8：可见/隐藏驱动模式切换（复用 CAPTCHA 接管同款 show/hide）。"""
        with self._lock:
            entry = self._resolve(session_id)
            if entry is None:
                return BrowserError(BrowserErrorCode.BAD_PARAMS,
                                    '没有可用浏览器会话').to_payload()
            entry['mode'] = 'visible' if mode == 'visible' else 'hidden'
            window = entry.get('window')
            session = entry.get('session')
        ok = False
        # win 侧走 window.set_visible；mac 侧（理论实现）走 session.set_visible
        for obj in (window, session):
            fn = getattr(obj, 'set_visible', None)
            if callable(fn):
                try:
                    ok = bool(fn(mode == 'visible'))
                except Exception:
                    ok = False
                break
        with self._lock:
            self._project()
        return {'ok': True, 'mode': entry['mode'], 'applied': ok}

    def preheat(self):
        """M8.1 会话池预热：首个 navigate 前预建隐藏驱动窗（量化冷启毫秒）。

        best-effort：失败静默（预热失败不阻塞首个 navigate 的正常创建路径）；
        Windows 真机起窗耗时可观测（test fake factory 可测调用次数与打点）。"""
        t0 = self._clock()
        try:
            session, window = self._factory('hidden')
            warm = True
        except Exception:
            session, window, warm = None, None, False
        self._preheat_ms = int((self._clock() - t0) * 1000)
        if not warm:
            return {'ok': False, 'warm': False, 'preheat_ms': self._preheat_ms}
        with self._lock:
            self._seq += 1
            sid = 'bs_%d_%s' % (int(self._clock()), os.urandom(3).hex())
            self._sessions[sid] = {
                'session': session, 'window': window, 'mode': 'hidden',
                'created': _utc_now_iso(), 'last_url': '', 'last_used': self._clock(),
            }
            # 预热会话不夺游标（cursor 保持 ''——首个 navigate 仍新建会话，
            # 预热窗供池满前复用？v1 简化：预热会话仅作冷启摊销基线，navigate
            # 仍走正常创建路径；真机调优见 M9.6）
            self._project()
        return {'ok': True, 'warm': True, 'session_id': sid,
                'preheat_ms': self._preheat_ms}

    def sessions(self):
        """投影视图（browser_sessions.json 同构；面板/前端数据源）。"""
        with self._lock:
            return {'ok': True, 'version': 1, 'sessions': self._snapshot()}

    def shutdown(self):
        """进程退出（main.py atexit）：停回收线程 + 关全部会话。"""
        self._stop.set()
        with self._lock:
            entries = [self._drop(sid) for sid in list(self._sessions)]
            self._cursor = ''
            self._project()
        for e in entries:
            self._close_entry(e)

    # ---- 内部 ----
    def _resolve(self, sid):
        """无 id → 游标会话；有 id → 指定会话；都不在 → None。"""
        if sid:
            return self._sessions.get(str(sid))
        return self._sessions.get(self._cursor)

    def _drop(self, sid):
        """持锁摘除会话条目 + 游标回退（**不做关闭**——窗口销毁是跨线程 GUI
        调度可能秒级阻塞，由调用方在池锁外 _close_entry；本方法返回 entry）。"""
        entry = self._sessions.pop(sid, None)
        if entry is None:
            return None
        if self._cursor == sid:
            # 游标回退：保留剩余会话中最近使用的（无则空）
            rest = sorted(self._sessions.items(),
                          key=lambda kv: kv[1].get('last_used', 0), reverse=True)
            self._cursor = rest[0][0] if rest else ''
        return entry

    @staticmethod
    def _close_entry(entry):
        """锁外关闭会话与窗口（best-effort 不抛）；随后清理由本会话独占的
        WebView2 profile 目录（drv_<ms>_<seq> 唯一归属——不清理则每会话
        遗留数十 MB 磁盘，长运行无界增长；文件被退出中的 WebView2 短暂
        锁定时 ignore_errors 容忍残渣，下一会话用新目录不受影响）。"""
        if entry is None:
            return
        udd = ''
        win_obj = entry.get('window')
        if win_obj is not None:
            udd = str(getattr(win_obj, '_user_data_dir', '') or '')
        for obj in (entry.get('session'), entry.get('window')):
            fn = getattr(obj, 'close', None) or getattr(obj, 'shutdown', None)
            if callable(fn):
                try:
                    fn()
                except Exception:
                    pass
        if udd and os.path.isdir(udd) \
                and os.path.basename(udd).startswith('drv_'):
            try:
                shutil.rmtree(udd, ignore_errors=True)
            except Exception:
                pass

    def _evict_if_full(self):
        """池满驱逐最旧空闲会话（持锁调用；驱逐条目存 _evicted 待调用方锁外关闭）。

        busy 条目跳过（导航/原语在飞——驱逐即飞行中销窗）；全部 busy 时
        放行本次超限（下一步原语结束后 last_used 刷新，下轮再收敛）。"""
        self._evicted = getattr(self, '_evicted', [])
        while len(self._sessions) >= self._limit:
            evictable = [(sid, e) for sid, e in self._sessions.items()
                         if not e.get('busy')]
            if not evictable:
                self._log.info('浏览器会话池满（%d）且全部在执行中，跳过驱逐',
                               self._limit)
                break
            oldest = min(evictable, key=lambda kv: kv[1].get('last_used', 0))
            self._log.info('浏览器会话池满（%d），驱逐最旧空闲会话 %s',
                           self._limit, oldest[0])
            self._evicted.append(self._drop(oldest[0]))

    def _snapshot(self):
        out = []
        for sid, e in self._sessions.items():
            state = 'ready'
            s = e.get('session')
            if s is not None:
                try:
                    state = s.state.value
                except Exception:
                    state = 'ready'
            out.append({'id': sid, 'mode': e.get('mode', 'hidden'),
                        'created': e.get('created', ''),
                        'last_url': e.get('last_url', ''), 'state': state})
        return out

    def _project(self):
        """browser_sessions.json 投影（原子写；失败只 warning 禁阻断——B8.9）。"""
        try:
            data = {'version': 1, 'sessions': self._snapshot()}
            os.makedirs(os.path.dirname(self._path) or '.', exist_ok=True)
            atomic_write_json(self._path, data, indent=2)
        except Exception as e:
            self._log.warning('browser_sessions.json 投影失败: %r', e)

    def _sweep_loop(self):
        """空闲 60s 回收线程（M3.7）：超时会话自动 close + 投影。"""
        while not self._stop.wait(self._sweep_tick):
            try:
                now = self._clock()
                stale_entries = []
                with self._lock:
                    stale = [sid for sid, e in self._sessions.items()
                             if now - e.get('last_used', 0) > self._idle
                             and not e.get('busy')]
                    for sid in stale:
                        self._log.info('浏览器会话 %s 空闲 %ss，自动回收',
                                       sid, int(self._idle))
                        stale_entries.append(self._drop(sid))
                    if stale:
                        self._project()
                for e in stale_entries:      # 锁外关闭（sweeper 线程自身）
                    self._close_entry(e)
            except Exception as e:
                self._log.debug('浏览器会话回收扫描异常: %r', e)
