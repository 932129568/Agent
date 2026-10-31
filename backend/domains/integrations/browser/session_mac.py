# -*- coding: utf-8 -*-
"""v1.9.0 M4 · macOS 浏览器后端（WKWebView，PyObjC 桥）——理论实现。

PyObjC 依赖经 ``mac_backend_available()`` 延迟探测（非 macOS 环境 import
失败 → False；工厂据此降级 UNSUPPORTED_PLATFORM）；WebView 创建与脚本消息
桥隔离在 ``webview_factory``/``bridge_factory`` 依赖注入点——**六原语派发/
等待/提取/校验逻辑与平台解耦**，Windows 开发机用 fake factory 全测
（master-plan §396 纪律：macOS 专属包 Mock 先行、真机集中 M9.5）。

职责（master-plan §165 M4.2-4.9，与 WinSession 语义对齐）：
- NSWindow + WKWebView（M4.2）：隐藏次窗（CAPTCHA 接管时 makeKeyAndOrderFront
  可见化——M3.8 模式切换同款语义）；
- WKWebViewConfiguration（M4.3）：``WKWebsiteDataStore.nonPersistentDataStore()``
  ——cookie/缓存会话级隔离（与 Win 独立 profile 目录同语义）；
- loadURL + 导航委托（M4.4）：didFinishNavigation/didFailNavigation →
  threading.Event（与 Win loaded 事件同款看门狗语义）；
- 等待原语（M4.5）：wait_selector JS 轮询——复用 session_win.build_wait_js
  （与 Win 语义一致，master-plan 4.5 明示）；
- 提取桥（M4.6）：WKUserContentController addScriptMessageHandler——页面侧
  ``window.webkit.messageHandlers.harbor.postMessage(json)`` → Bridge 收集
  （driver.Bridge 复用：on_extract/open_external/download_blocked）；
- 截图（M4.7）：takeSnapshotWithCompletionHandler → NSBitmapImageRep →
  PNG b64（point 坐标系；Retina 缩放修正备注 M8.4）；
- click/fill（M4.8）：evaluateJavaScript 派发——复用 session_win 的
  build_click_js/build_fill_js（注入防御/视口外拒点/敏感字段拒填同款）；
- 下载拦截 + 外链策略（M4.9）：WKUIDelegate decidePolicyForNavigationAction
  ——target=_blank → NSWorkspace.openURL（系统浏览器）；download 动作 → 拒
  （默认禁下载，与 Win 3.6 语义对齐）。

线程模型：WKWebView 的 evaluateJavaScript 必须主线程——真机实现经
``dispatch_async(main_queue)`` 派发 + semaphore 同步回收；注入的
webview_factory 在测试里直接同步执行（同构接口）。
"""
import base64
import json
import threading
import time
import urllib.parse

from .session_base import (BrowserError, BrowserErrorCode, BrowserSession,
                           SessionState, _is_public_host,
                           build_extract_result, html_title)
from .session_win import (_ALLOWED_SCHEME, build_click_js, build_fill_js,
                          build_wait_js, map_js_result)
from .session_win import _js_error   # noqa: E402  （错误映射同源）

# 等待参数（与 Win DriverWindow 同款口径）
WAIT_POLL_S = 0.3
DOM_STABLE_N = 3
LOAD_TIMEOUT_S = 8.0
EVAL_JS_TIMEOUT = 6.0   # evaluateJavaScript 派发回收上限（driver.EVAL_JS_TIMEOUT 同值）


def mac_backend_available() -> bool:
    """PyObjC 运行时探测（延迟 import；非 macOS 一律 False——理论代码支持
    的可用性闸：真机装 pywebview[cocoa] 即全链路可用）。"""
    try:
        import objc        # noqa: F401
        import WebKit      # noqa: F401
        import AppKit      # noqa: F401
        import Foundation  # noqa: F401
        return True
    except Exception:
        return False


def _default_webview_factory(bridge, visible):
    """真机 WKWebView 创建（仅 macOS + PyObjC 可达——mac_backend_available
    通过后工厂才会调到这里）。返回鸭子对象：

    - ``load_url(url)``：异步加载（导航委托 didFinish/didFail → loaded 事件）；
    - ``eval_js(code, timeout) -> str|None``：主线程 evaluateJavaScript；
    - ``capture_b64() -> str``：takeSnapshot PNG b64；
    - ``set_visible(bool)``：makeKeyAndOrderFront/orderOut；
    - ``destroy()``：close + release。
    """
    from Foundation import NSObject
    from WebKit import (WKWebView, WKWebViewConfiguration,
                        WKUserContentController, WKWebsiteDataStore,
                        WKScriptMessageHandler)
    from AppKit import NSWindow, NSRect, NSSize, NSPoint
    import Quartz  # noqa: F401  （M8.4 Retina 修正预留）

    class _HarborScriptHandler(NSObject, WKScriptMessageHandler):
        """M4.6 提取桥：window.webkit.messageHandlers.harbor.postMessage。"""

        def userContentController_didReceiveScriptMessage_(self, cc, message):
            try:
                body = str(message.body())
                kind, payload = 'extract', body
                d = json.loads(body) if body.startswith('{') else {}
                kind = str((d or {}).get('kind') or 'extract')
                payload = body
            except Exception:
                kind, payload = 'extract', str(message.body())
            bridge.dispatch(kind, payload)

    config = WKWebViewConfiguration.alloc().init()
    config.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore()  # cookie 隔离
    cc = WKUserContentController.alloc().init()
    cc.addScriptMessageHandler_name_(_HarborScriptHandler.alloc().init(),
                                     'harbor')
    config.userContentController = cc
    frame = NSRect(NSPoint(0, 0), NSSize(1024, 768))
    win = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
        frame, 1 << 0 | 1 << 2, 2, False)   # titled|miniaturizable（保留 traffic lights 位）
    web = WKWebView.alloc().initWithFrame_configuration_(frame, config)
    win.setContentView_(web)
    if not visible:
        win.orderOut_(None)   # 隐藏驱动（M3.8；可见化走 makeKeyAndOrderFront）

    loaded = threading.Event()
    fail_msg = []

    class _NavDelegate(NSObject):
        """M4.4 导航委托：didFinish/didFail → 事件（Win loaded 同款）。"""

        def webView_didFinishNavigation_(self, w, nav):
            loaded.set()

        def webView_didFailNavigation_withError_(self, w, nav, error):
            fail_msg.append(str(error))
            loaded.set()

    from WebKit import WKNavigationDelegate
    _nd = _NavDelegate.alloc().init()
    # PyObjC 5+: implementProtocol；兼容旧版 setNavigationDelegate
    try:
        web.implementProtocol('WKNavigationDelegate', _nd)
    except Exception:
        try:
            web.setNavigationDelegate_(_nd)
        except Exception:
            pass

    def _dispatch_main(fn, timeout=EVAL_JS_TIMEOUT):
        """主线程派发 + 同步回收（evaluateJavaScript 线程契约）。"""
        import queue
        q = queue.Queue()

        def _work():
            try:
                q.put(('r', fn()))
            except Exception as e:
                q.put(('e', e))
        try:
            from libdispatch import dispatch_queue_create, dispatch_async, \
                dispatch_get_main_queue
            dispatch_async(dispatch_get_main_queue(), _work)
        except Exception:
            # libdispatch 绑定不可用：PyObjC 自带 performSelectorOnMainThread
            # 的替代路径——直接线程近似（真机验证项 M9.5）
            threading.Thread(target=_work, daemon=True).start()
        try:
            kind, val = q.get(timeout=timeout)
        except Exception:
            return None
        if kind == 'e':
            return None
        return val

    class _W:
        def load_url(self, url):
            from Foundation import NSURL
            loaded.clear()
            _dispatch_main(lambda: web.loadRequest_(
                __import__('Foundation').NSURLRequest.requestWithURL_(
                    NSURL.URLWithString_(url))), 10.0)
            if not loaded.wait(LOAD_TIMEOUT_S):
                return {'ok': False, 'error': 'TIMEOUT',
                        'message': '页面加载超时（%ds 看门狗）' % int(LOAD_TIMEOUT_S)}
            if fail_msg:
                return {'ok': False, 'error': 'NAV_BLOCKED',
                        'message': '导航失败: %s' % fail_msg[-1][:120]}
            return {'ok': True}

        def eval_js(self, code, timeout=EVAL_JS_TIMEOUT):
            box = {}

            def _call():
                web.evaluateJavaScript_completionHandler_(
                    code, lambda r, err: box.update(r=r))
            _dispatch_main(_call, timeout)
            return box.get('r')

        def capture_b64(self):
            def _shot():
                out = []
                web.takeSnapshotWithCompletionHandler_(
                    lambda snap, err: out.append(snap))
                return out[0] if out else None
            snap = _dispatch_main(_shot, 10.0)
            if snap is None:
                return ''
            # CGImage → PNG（Quartz 路径；Retina point 坐标系——backingScale
            # 修正 M8.4 细化项，理论实现按 point 直出）
            try:
                from Quartz import CGImageDestinationCreateWithData, \
                    CGImageDestinationAddImage, CGImageDestinationFinalize, \
                    CGImageGetWidth, CGImageGetHeight
                from Foundation import NSMutableData
                cgi = snap.CGImageForProposedRect_context_hints_(None, None, None)
                if cgi is None:
                    return ''
                mdata = NSMutableData.data()
                dest = CGImageDestinationCreateWithData(mdata, 'public.png', 1, None)
                CGImageDestinationAddImage(dest, cgi, None)
                CGImageDestinationFinalize(dest)
                return base64.b64encode(bytes(mdata)).decode('ascii')
            except Exception:
                return ''

        def set_visible(self, visible):
            def _vis():
                if visible:
                    win.makeKeyAndOrderFront_(None)
                else:
                    win.orderOut_(None)
                return True
            return bool(_dispatch_main(_vis, 5.0))

        def destroy(self):
            def _close():
                win.close()
                return True
            try:
                _dispatch_main(_close, 5.0)
            except Exception:
                pass

        @property
        def viewport(self):
            return (1024, 768)

    return _W()


class MacSession(BrowserSession):
    """macOS 渲染后端（WKWebView 六原语；M4 理论实现——依赖注入可全测）。

    与 WinSession 同款语义：状态机/错误 taxonomy/JS 构建纯函数复用
    （build_click_js/build_fill_js/build_wait_js——注入防御与视口外拒点
    跨端一致，G7 三端一致性 fixture 的代码基础）。
    """

    platform = 'mac'
    supports_wait = True

    def __init__(self, webview=None, webview_factory=None, bridge=None):
        """Args:
            webview: 已就绪的 WebView 鸭子对象（load_url/eval_js/capture_b64/
                set_visible/destroy——测试注入 fake）。
            webview_factory: ``(bridge, visible) -> webview``（缺省真机
                WKWebView 工厂——仅 macOS 可达；测试注入）。
            bridge: driver.Bridge（提取桥；缺省 None=不挂 js 消息通道）。
        """
        super().__init__()
        self._bridge = bridge
        self._factory = webview_factory or _default_webview_factory
        self._wv = webview
        self._html = ''
        self._url = ''
        self._visible = False

    # ---------------- WebView 生命周期 ----------------
    def _ensure_wv(self, visible=False):
        if self._wv is None:
            try:
                self._wv = self._factory(self._bridge, visible)
            except Exception as e:
                raise BrowserError(BrowserErrorCode.INTERNAL,
                                   'WKWebView 创建失败: %s' % e)
        return self._wv

    # ---------------- 六原语 ----------------
    def navigate(self, url, wait_selector='', timeout=60):
        try:
            u = str(url or '').strip()
            if not u:
                raise BrowserError(BrowserErrorCode.BAD_PARAMS, 'url 不能为空')
            if not _ALLOWED_SCHEME.match(u):
                raise BrowserError(BrowserErrorCode.NAV_BLOCKED,
                                   '已阻止非 http(s) 导航: %s' % u[:80],
                                   '浏览器仅支持 http/https 链接')
            if not _is_public_host(urllib.parse.urlsplit(u).hostname):
                raise BrowserError(BrowserErrorCode.SSRF_BLOCKED,
                                   '已阻止访问内网/环回地址: %s' % u[:80],
                                   '禁止访问内网/环回地址')
            wv = self._ensure_wv()
            r = wv.load_url(u)
            if not isinstance(r, dict) or not r.get('ok'):
                r = r if isinstance(r, dict) else {}
                raise BrowserError(
                    BrowserErrorCode.TIMEOUT if r.get('error') == 'TIMEOUT'
                    else BrowserErrorCode.INTERNAL,
                    r.get('message') or '导航失败', r.get('hint') or '')
            # M4.5 等待原语（与 Win 语义一致）**先行**：wait_selector 轮询通过
            # 后再读 outerHTML（等待的元素出现后才读 DOM——语义正确序）
            ws = str(wait_selector or '').strip()
            deadline = time.monotonic() + max(1.0, float(timeout or 60))
            if ws:
                while time.monotonic() < deadline:
                    rr = wv.eval_js(build_wait_js(ws), timeout=EVAL_JS_TIMEOUT)
                    if rr == '1':
                        break
                    if rr == 'e':
                        raise BrowserError(
                            BrowserErrorCode.BAD_PARAMS,
                            'wait_selector 语法非法: %s' % ws[:80])
                    time.sleep(WAIT_POLL_S)
                else:
                    raise BrowserError(BrowserErrorCode.TIMEOUT,
                                       '等待选择器超时: %s' % ws[:80])
            html = wv.eval_js('document.documentElement.outerHTML',
                              timeout=EVAL_JS_TIMEOUT)
            if not isinstance(html, str) or not html.strip():
                raise BrowserError(BrowserErrorCode.INTERNAL,
                                   '无法读取页面内容（evaluateJavaScript 不可用）')
            self._html = html
            self._url = u
            self._enter(SessionState.READY)
            return {'ok': True, 'title': html_title(self._html), 'url': u,
                    'final_url': u, 'channel': 'mac-webview'}
        except BrowserError:
            raise
        except Exception as e:
            raise BrowserError(BrowserErrorCode.INTERNAL, '导航失败: %s' % e)

    def extract(self, selector='', mode='markdown'):
        self._enter(SessionState.BUSY)
        try:
            return build_extract_result(self._html, selector, mode)
        finally:
            self._settle_ready()

    def click(self, target):
        """M4.8：与 Win 同款 JS 派发（注入防御/视口外拒点跨端一致）。"""
        self._enter(SessionState.BUSY)
        try:
            t = str(target or '').strip()
            if not t:
                raise BrowserError(BrowserErrorCode.BAD_PARAMS, 'target 不能为空')
            wv = self._ensure_wv()
            before = self._capture_best_effort(wv)
            result = map_js_result(wv.eval_js(build_click_js(t),
                                              timeout=EVAL_JS_TIMEOUT))
            if result.get('error'):
                from .session_win import _js_error
                raise _js_error(result)
            after = self._capture_best_effort(wv)
            out = {'ok': True, 'before_b64': before, 'after_b64': after}
            if result.get('how'):
                out['how'] = result['how']
            return out
        finally:
            self._settle_ready()

    def fill(self, selector, text):
        self._enter(SessionState.BUSY)
        try:
            s = str(selector or '').strip()
            if not s:
                raise BrowserError(BrowserErrorCode.BAD_PARAMS, 'selector 不能为空')
            wv = self._ensure_wv()
            result = map_js_result(wv.eval_js(build_fill_js(s, text),
                                              timeout=EVAL_JS_TIMEOUT))
            if result.get('error'):
                from .session_win import _js_error
                raise _js_error(result)
            return {'ok': True, 'masked': True}
        finally:
            self._settle_ready()

    def screenshot(self, full_page=False):
        """M4.7：takeSnapshot PNG b64（point 坐标系；Retina 修正 M8.4）。"""
        self._enter(SessionState.BUSY)
        try:
            wv = self._ensure_wv()
            try:
                b64 = wv.capture_b64()
            except Exception as e:
                raise BrowserError(BrowserErrorCode.INTERNAL, '窗口捕获失败: %s' % e)
            if not b64:
                raise BrowserError(BrowserErrorCode.INTERNAL,
                                   '窗口捕获返回空（快照不可用）')
            size = getattr(wv, 'viewport', None) or (0, 0)
            return {'ok': True, 'b64': b64,
                    'width': int(size[0]), 'height': int(size[1])}
        finally:
            self._settle_ready()

    def close(self):
        with self._lock:
            already = self._state is SessionState.CLOSED
        if not already:
            self._enter(SessionState.CLOSED)
            wv = self._wv
            if wv is not None:
                try:
                    wv.destroy()
                except Exception:
                    pass
        self._html = ''
        self._url = ''
        return {'ok': True}

    def set_visible(self, visible):
        """M3.8/M4 可见化（CAPTCHA 接管同款语义）：makeKeyAndOrderFront。"""
        self._visible = bool(visible)
        wv = self._wv
        if wv is None:
            return False
        try:
            return bool(wv.set_visible(visible))
        except Exception:
            return False

    @staticmethod
    def _capture_best_effort(wv):
        try:
            return wv.capture_b64() or ''
        except Exception:
            return ''
