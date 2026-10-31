# -*- coding: utf-8 -*-
"""v1.8.0 B 域·搜索窗口通道（实现 v1.8.0 B2：pywebview 次窗 + urllib 兜底双通道）。

v1.9.0 T02 迁移说明：本模块自 ``backend/domains/search_browser.py`` **原样迁入**
browser/ 包（设计文档 §A2.6 迁移映射表）——SearchBrowser 类名/方法/常量/行为
逐字不变（迁移=行为等价）；``_is_public_host`` / ``_decode_html`` 按映射表
**上移** session_base.py（search_browser 内引用删，改从 session_base 导入）。
新增 WinSession(BrowserSession) 适配类（M1.5）：六原语 → SearchBrowser 通道。

模块职责（架构文档 §2.1 后端模块表「窗口通道 search_browser」）：
- 次窗口生命周期：680×520 隐藏备用、``load_url`` 加载、``events.loaded``
  加载事件、8s 看门狗、独立 UserDataFolder（``~/.glm-chat/search_webview``）、
  禁 file:// 等非 http(s) 导航、空闲 60s 回收；
- 注入模式：``set_window(win)``（installer_gui InstallerBridge 同款）——由
  main.py 装配入口注入预先创建的次窗；未注入时按需惰性创建（嵌入/测试环境）；
- ``open_url(url)`` 双通道取数（联调规范 §5.1③ 降级链）：
  次窗路径（load_url → loaded 事件 → evaluate_js 读 DOM）优先，窗口不可用 /
  超时 / evaluate_js 无法泵送（本沙箱环境两次实证的已知限制）时自动回落
  urllib 抓 HTML 兜底（复用 ``mcp_transport_http.urlopen_no_redirect``，
  禁自动重定向），响应以 ``channel`` 标注实际通道（'window'|'urllib'）。

纯 IO 边界：本模块是搜索栈唯一直接触网的模块（urllib），窗口操作经 pywebview；
``import`` 无副作用（webview 延迟导入），可在无 GUI 环境导入与单测。
"""
import json
import os
import re
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from .... import paths
from ....logging_setup import get_logger
from .native_port import UnavailableDispatcher
from ..mcp.mcp_transport_http import urlopen_follow_redirect_safe
from .session_base import (BrowserError, BrowserErrorCode, BrowserSession,
                           SessionState, _decode_html, _is_public_host,
                           build_extract_result, html_title, map_error_code)

# 次窗形态（架构 §2.1：680×520 次窗）
WINDOW_WIDTH = 680
WINDOW_HEIGHT = 520
# 加载看门狗（ux-flows 流程 1 步骤 4：≤8s 轮询等待）
LOAD_TIMEOUT_SECONDS = 8.0
# evaluate_js 读 DOM 的线程 join 上限（沙箱无法泵送时不能挂死调用方）
READ_DOM_TIMEOUT_SECONDS = 5.0
# 空闲回收（架构 §2.1：空闲 60s 回收）
IDLE_RECYCLE_SECONDS = 60.0
_RECYCLE_TICK_SECONDS = 5.0
# urllib 兜底：响应体防 OOM 上限（结果页/文章页 HTML 2MB 足够）
MAX_HTML_BYTES = 2 * 1024 * 1024
# 浏览器 UA（引擎反爬对抗的基础形态，非伪装——Harbor 自报家门）
USER_AGENT = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
              'Harbor/1.8.0 (SearchBrowser; +https://harbor.local)')

# 独立 WebView2 用户数据目录（架构 §2.1：独立 profile，与主窗 webview_data 隔离）
USER_DATA_DIR_NAME = 'search_webview'

# 禁导航协议（R2 纪律：仅 http/https；file:// / javascript: / about: 等一律拒绝）
_ALLOWED_SCHEME = re.compile(r'^https?://', re.IGNORECASE)


class SearchBrowser:
    """搜索次窗通道：``open_url(url)`` → ``{ok, html, channel, error?}``。

    双通道语义（联调规范 §5.1③）：
    - ``channel='window'``：次窗 load_url + loaded 事件 + evaluate_js 读 DOM；
    - ``channel='urllib'``：窗口不可用 / 超时 / 读 DOM 失败时的兜底直连抓取；
    - 双失败 → ``{ok: False, error: 'ENGINE_UNREACHABLE'|'TIMEOUT'|'NAV_BLOCKED'}``。

    Attributes:
        window: 当前次窗引用（注入或惰性创建；空闲回收后为 None）。
    """

    def __init__(self, user_data_dir=None, idle_recycle=True, dispatcher=None):
        """Args:
            user_data_dir: 独立 WebView2 profile 目录（缺省 ``~/.glm-chat/search_webview``）。
            idle_recycle: 是否启用空闲 60s 回收（测试可关，避免回收线程干扰）。
        """
        self._log = get_logger()
        self._dispatcher = dispatcher or UnavailableDispatcher()
        self._win = None
        self._user_data_dir = (user_data_dir
                               or os.path.join(paths.CONFIG_DIR, USER_DATA_DIR_NAME))
        self._last_used = 0.0
        self._lock = threading.RLock()
        self._recycler = None
        self._stop_evt = threading.Event()
        self._idle_recycle = bool(idle_recycle)
        # evaluate_js 可泵送性（首次 join 超时即置 False：后续 open_url 跳过
        # 窗口路径直接走 urllib，不再养僵尸线程——沙箱实证限制）
        self._dom_pumpable = True

    # ---------------- 窗口装配（注入模式，installer_gui InstallerBridge 同款） ----------------

    def set_window(self, win):
        """注入次窗引用（main.py 装配入口调用；替换既有引用并刷新活跃时间）。"""
        with self._lock:
            self._win = win
            self._dispatcher.register(win, 'search')
            self._last_used = time.monotonic()

    @property
    def window(self):
        with self._lock:
            return self._win

    def _ensure_window(self):
        """取当前次窗；无注入时惰性创建（隐藏备用，pywebview 延迟导入）。

        Returns:
            窗口对象或 None（webview 不可用/创建失败——调用方据此走 urllib）。
        """
        with self._lock:
            win = self._win
            if win is not None:
                return win
        try:
            import webview   # 延迟导入：无 webview 环境（测试/嵌入）不炸
        except Exception as e:
            self._log.debug('webview 不可用，搜索走 urllib 兜底: %r', e)
            return None
        try:
            os.makedirs(self._user_data_dir, exist_ok=True)
        except Exception as e:
            self._log.debug('搜索 profile 目录创建失败（回落进程级目录）: %r', e)
        win = None
        # 创建参数阶梯：完整参数（含 hidden/user_data_folder）→ 去 user_data_folder
        # → 最小参数。pywebview 各版本 create_window 签名有差异，全部 try 兜底。
        attempts = (
            {'title': 'Harbor 搜索', 'url': 'about:blank', 'js_api': None,
             'width': WINDOW_WIDTH, 'height': WINDOW_HEIGHT, 'hidden': True,
             'user_data_folder': self._user_data_dir},
            {'title': 'Harbor 搜索', 'url': 'about:blank', 'js_api': None,
             'width': WINDOW_WIDTH, 'height': WINDOW_HEIGHT, 'hidden': True},
            {'title': 'Harbor 搜索', 'url': 'about:blank',
             'width': WINDOW_WIDTH, 'height': WINDOW_HEIGHT},
        )
        for kw in attempts:
            try:
                win = self._dispatcher.create(
                    'search', lambda: webview.create_window(**kw))
                break
            except TypeError:
                continue   # 该版本不支持此参数组合，降级重试
            except Exception as e:
                self._log.warning('搜索次窗创建失败（回落 urllib 兜底）: %r', e)
                return None
        if win is None:
            self._log.warning('搜索次窗创建失败（参数均不被接受，回落 urllib 兜底）')
            return None
        with self._lock:
            self._win = win
            self._last_used = time.monotonic()
        return win

    # ---------------- 取数主入口 ----------------

    def open_url(self, url):
        """打开 URL 取 HTML（双通道：次窗优先，urllib 自动兜底）。

        Args:
            url: 目标 URL（仅 http/https；其他协议直接 NAV_BLOCKED，不导航）。

        Returns:
            dict: 成功 ``{ok: True, html: str, channel: 'window'|'urllib'}``；
            失败 ``{ok: False, error: 错误码, message: 人话, hint?}``。
            错误码：``BAD_PARAMS`` / ``NAV_BLOCKED`` / ``TIMEOUT`` /
            ``ENGINE_UNREACHABLE`` / ``WINDOW_UNAVAILABLE``（内部码，回落前用）。
        """
        u = str(url or '').strip()
        if not u:
            return {'ok': False, 'error': 'BAD_PARAMS', 'message': 'url 不能为空'}
        if not _ALLOWED_SCHEME.match(u):
            # R2 纪律：禁导航在通道层硬拦（窗口与 urllib 之前），file:// 等无机会触达
            return {'ok': False, 'error': 'NAV_BLOCKED',
                    'message': '已阻止非 http(s) 导航: %s' % u[:80],
                    'hint': '浏览器搜索/打开仅支持 http/https 链接'}
        # 内网防护（SSRF）：解析目标 host，私网/环回/链路本地等一律拒绝
        #（DNS 解析失败按拒绝——fail-closed；helper 与 browser/service.py 的
        # browser_open 共用同一口径）
        host = urllib.parse.urlsplit(u).hostname
        if not _is_public_host(host):
            return {'ok': False, 'error': 'NAV_BLOCKED',
                    'message': '已阻止访问内网/环回地址: %s' % u[:80],
                    'hint': '禁止访问内网/环回地址'}
        self._touch()
        self._start_recycler()
        if self._dom_pumpable:
            win = self._ensure_window()
            if win is not None:
                r = self._load_via_window(win, u)
                if r.get('ok'):
                    r['channel'] = 'window'
                    return r
                # 降级链（规范 §5.1③）：窗口超时/不可用/读 DOM 失败 → urllib 兜底。
                # 机制静默（不阻塞主流程），降级事实由响应 channel='urllib' 标注。
                self._log.info('搜索次窗路径失败（%s），回落 urllib: %s',
                               r.get('error'), u[:80])
        r = self._fetch_via_urllib(u)
        r['channel'] = 'urllib'
        return r

    # ---------------- 次窗路径 ----------------

    def _load_via_window(self, win, url):
        """次窗 load_url → 等 loaded 事件（8s 看门狗）→ evaluate_js 读 DOM。

        evaluate_js 经工作线程 join 调用（本沙箱会话无法被消息循环泵送——
        两次实证的已知限制）：join 超时/异常/空结果一律视为窗口路径失败，
        由 open_url 回落 urllib（回落路径必须真跑通）。
        """
        loaded = threading.Event()

        def _on_loaded():
            loaded.set()

        # 先订阅再导航：load_url 之后 loaded 可能同步/极快触发（缓存页/
        # about:blank 跳转），后订阅会漏事件 → 白等 8s 看门狗超时
        events = getattr(win, 'events', None)
        subscribed = False
        if events is not None and getattr(events, 'loaded', None) is not None:
            try:
                events.loaded += _on_loaded
                subscribed = True
            except Exception:
                subscribed = False
        try:
            self._dispatcher.invoke(win, lambda: win.load_url(url),
                                    timeout=LOAD_TIMEOUT_SECONDS, stage='navigate')
        except Exception as e:
            return {'ok': False, 'error': 'WINDOW_UNAVAILABLE',
                    'message': '搜索窗口加载失败: %r' % e}
        try:
            if not loaded.wait(LOAD_TIMEOUT_SECONDS):
                return {'ok': False, 'error': 'TIMEOUT',
                        'message': '搜索窗口加载超时（%ds 看门狗），已切换直连抓取'
                                   % int(LOAD_TIMEOUT_SECONDS),
                        'hint': '可在面板重试或更换搜索引擎'}
            html = self._read_dom(win)
            if html is None or not str(html).strip():
                return {'ok': False, 'error': 'WINDOW_UNAVAILABLE',
                        'message': '无法读取页面内容（evaluate_js 不可用），'
                                   '已切换直连抓取'}
            return {'ok': True, 'html': str(html)}
        finally:
            if subscribed:
                try:
                    events.loaded -= _on_loaded
                except Exception:
                    pass   # 事件槽不支持退订（如测试桩）——忽略，防泄漏由窗口回收兜底

    def _read_dom(self, win):
        """evaluate_js 读 ``document.documentElement.outerHTML``（带 join 上限）。

        Returns:
            str | None：HTML 字符串；None = 不可用（异常/超时/空）。

        首次 join 超时即置 ``_dom_pumpable=False``（本沙箱会话消息循环无法
        泵送 evaluate_js——两次实证的已知限制）：超时的工作线程已成为僵尸
        （join 不回来，daemon 线程只能等进程退出），后续 open_url 跳过窗口
        路径直接走 urllib，不再每请求养一个僵尸线程。
        """
        try:
            return self._dispatcher.evaluate(
                win, 'document.documentElement.outerHTML',
                timeout=READ_DOM_TIMEOUT_SECONDS)
        except Exception as error:
            if getattr(error, 'code', '') == 'NATIVE_UI_TIMEOUT':
                self._dom_pumpable = False
            else:
                self._log.debug('evaluate_js 读取失败: %r', error)
            return None

    # ---------------- urllib 兜底路径 ----------------

    def _fetch_via_urllib(self, url):
        """urllib 直连抓 HTML（禁自动重定向；HTTP 码按规范 §4.1 映射）。

        非 JS 渲染引擎（Bing/DDG/Baidu 的 HTML 端点）可用；JS 渲染引擎
        （Google）可能只得空壳——由调用方结合解析结果数判定（service 层）。
        """
        req = urllib.request.Request(url, headers={
            'User-Agent': USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        })
        try:
            # 复核批：GET 取数改安全跟随重定向（跨 host 剥凭证 + 每跳 SSRF 复检；
            # 引擎 302 区域跳转是常态，原一刀切禁跟随让搜索在代理/区域用户必失败）
            resp = urlopen_follow_redirect_safe(req, timeout=LOAD_TIMEOUT_SECONDS)
        except urllib.error.HTTPError as e:
            hint = '引擎限流，可稍后重试或切换引擎' if e.code == 429 else \
                   '稍后重试或更换搜索引擎' if e.code >= 500 else \
                   '该地址暂时无法访问，可稍后重试'
            return {'ok': False, 'error': 'ENGINE_UNREACHABLE',
                    'http_status': e.code,
                    'message': '目标返回 HTTP %s' % e.code, 'hint': hint}
        except urllib.error.URLError as e:
            reason = getattr(e, 'reason', e)
            if isinstance(reason, (socket.timeout, TimeoutError)) or \
                    'timed out' in str(reason).lower():
                return {'ok': False, 'error': 'TIMEOUT',
                        'message': '连接目标站点超时（%ds）' % int(LOAD_TIMEOUT_SECONDS),
                        'hint': '可重试或更换搜索引擎'}
            return {'ok': False, 'error': 'ENGINE_UNREACHABLE',
                    'message': '无法连接目标站点: %s' % reason,
                    'hint': '请检查网络或稍后重试'}
        except Exception as e:
            return {'ok': False, 'error': 'ENGINE_UNREACHABLE',
                    'message': '抓取失败: %s' % e}
        try:
            raw = resp.read(MAX_HTML_BYTES + 1)
            if len(raw) > MAX_HTML_BYTES:
                raw = raw[:MAX_HTML_BYTES]        # 防 OOM 截断（结果页不可能超）
            try:
                ctype = (resp.headers.get('Content-Type') or '') if resp.headers else ''
            except Exception:
                ctype = ''
        finally:
            try:
                resp.close()
            except Exception:
                pass
        return {'ok': True, 'html': _decode_html(raw, ctype)}

    # ---------------- 窗口可见性（CAPTCHA 接管）与回收 ----------------

    def focus_window(self):
        """CAPTCHA 接管：次窗置顶获焦点（主窗口让位；best-effort 不抛）。

        ux-flows 流程 2 步骤 2：``show()`` + ``focus()``。pywebview Window 无
        跨平台 focus API——Windows 经 ``native.Form.Activate()``（BeginInvoke
        回 UI 线程，main.py 开启右键菜单同款口径）；其余平台 best-effort。
        """
        with self._lock:
            win = self._win
        if win is None:
            return False
        shown = False
        for name in ('show', 'restore'):
            fn = getattr(win, name, None)
            if callable(fn):
                try:
                    self._dispatcher.invoke(win, fn, stage='show')
                    shown = True
                except Exception:
                    pass
                break
        try:
            form = getattr(win, 'native', None)
            if form is not None and hasattr(form, 'BeginInvoke'):
                def _activate():
                    try:
                        form.Activate()
                    except Exception:
                        pass

                self._dispatcher.invoke(win, _activate, stage='activate')
                shown = True
        except Exception:
            pass   # 非 Windows / pythonnet 不可用——show 已尽力
        return shown

    def _touch(self):
        with self._lock:
            self._last_used = time.monotonic()

    def _start_recycler(self):
        """启动空闲回收看护线程（daemon，幂等；测试可 idle_recycle=False 关闭）。"""
        if not self._idle_recycle:
            return
        with self._lock:
            if self._recycler is not None:
                return
            t = threading.Thread(target=self._recycle_loop, daemon=True,
                                 name='search-browser-recycler')
            self._recycler = t
        t.start()

    def _recycle_loop(self):
        """空闲 60s 回收：无引用窗口或超空闲 → destroy 并清引用（防常驻内存）。"""
        while not self._stop_evt.wait(_RECYCLE_TICK_SECONDS):
            try:
                with self._lock:
                    win = self._win
                    idle = time.monotonic() - self._last_used
                if win is None:
                    continue
                if idle < IDLE_RECYCLE_SECONDS:
                    continue
                self._log.info('搜索次窗空闲 %ds，回收', int(idle))
                self._destroy_window(win)
            except Exception as e:
                self._log.debug('次窗回收异常（忽略）: %r', e)

    def _destroy_window(self, win):
        """销毁窗口并清引用（destroy 异常不抛——回收尽力而为）。"""
        with self._lock:
            if self._win is win:
                self._win = None
        try:
            destroy = getattr(win, 'destroy', None)
            if callable(destroy):
                self._dispatcher.destroy(win)
        except Exception as e:
            self._log.debug('次窗销毁失败（忽略）: %r', e)

    def shutdown(self):
        """进程退出：停回收线程 + 销毁次窗（main.py atexit 注册）。"""
        self._stop_evt.set()
        with self._lock:
            win = self._win
        if win is not None:
            self._destroy_window(win)


# ================= M3：click/fill 的 evaluate_js 派发脚本（纯函数构建） =================
# 参数一律经 json.dumps 编码为 JS 字符串字面量再嵌入脚本——target/selector/text
# 里藏 '); malicious(); 的注入载荷只会成为字符串内容，零执行（M3.9 注入防御，
# 测试 test_v19_driver 注入 fixture 锁定）。返回值统一 JSON.stringify 串，
# 会话层 json.loads 解析（evaluate_js 传 str 回来）。
_JS_ERR_MAP = {
    'not_found': (BrowserErrorCode.BAD_PARAMS, '未找到目标元素', '换 selector 或用可见文本'),
    'bad_selector': (BrowserErrorCode.BAD_PARAMS, '选择器语法非法'),
    'not_visible': (BrowserErrorCode.BAD_PARAMS, '目标元素不可见（display:none/零尺寸）',
                    'AI 驱动只点击可见元素'),
    'out_of_viewport': (BrowserErrorCode.BAD_PARAMS, '目标元素在视口外',
                        'AI 驱动拒绝点击视口外元素（防误触）'),
    'sensitive_field': (BrowserErrorCode.BAD_PARAMS, '拒绝操作敏感字段（password/file）',
                        '密码与文件字段不适用 AI 填充'),
    'not_fillable': (BrowserErrorCode.BAD_PARAMS, '目标元素不可填充（非 input/textarea/select）'),
    'click_failed': (BrowserErrorCode.INTERNAL, '元素 click() 调用失败'),
    'js_unavailable': (BrowserErrorCode.INTERNAL, '页面 JS 通道不可用（evaluate_js 无法泵送）',
                       '当前会话环境限制，换 browser_open 读取页面'),
}


def build_click_js(target):
    """点击脚本：selector 优先（querySelector）→ 可见文本 XPath 兜底；
    可见性检查（display/visibility/尺寸）+ 视口外拒点（M3.9）→ scrollIntoView → click()。

    文本查找的 XPath 字面量用**单引号界定 + 目标串 ' 翻倍转义**（XPath 1.0
    无反斜杠转义——JSON 的 \\" 在 XPath 是语法错误；不转义可构造谓词注入）；
    document.evaluate 全程 try/catch（非法谓词归 not_found，不炸整段 IIFE）。"""
    t = json.dumps(str(target or ''), ensure_ascii=False)
    return ('(function(){'
            'var T=%s;'
            'var el=null,how="";'
            'try{el=document.querySelector(T);how="selector";}catch(e){}'
            'if(!el){'
            'var esc=function(s){return String(s).replace(/\'/g,"\'\'");};'
            'var x=null;'
            'try{x=document.evaluate("//*[normalize-space(text())=\'"+esc(T)+"\']",'
            'document,null,9,null).singleNodeValue;}catch(e){}'
            'if(!x){try{x=document.evaluate('
            '"//*[not(*)][contains(normalize-space(.),\'"+esc(T)+"\')]",'
            'document,null,9,null).singleNodeValue;}catch(e){}}'
            'if(x){el=x;how="text";}}'
            'if(!el){return JSON.stringify({error:"not_found"});}'
            'var st=window.getComputedStyle(el);var r=el.getBoundingClientRect();'
            'if(st.display==="none"||st.visibility==="hidden"||r.width<=0||r.height<=0)'
            '{return JSON.stringify({error:"not_visible"});}'
            'if(r.bottom<0||r.right<0||r.top>window.innerHeight||r.left>window.innerWidth)'
            '{return JSON.stringify({error:"out_of_viewport"});}'
            'try{el.scrollIntoView({block:"center"});}catch(e){}'
            'try{el.click();}catch(e){return JSON.stringify({error:"click_failed"});}'
            'return JSON.stringify({ok:true,how:how});'
            '})()' % t)


def build_fill_js(selector, text):
    """填充脚本：敏感字段（password/file）拒填（M3.9）；React 受控组件经
    原型 native setter 赋值 + input/change 事件派发；select 走 value+change。"""
    s = json.dumps(str(selector or ''), ensure_ascii=False)
    t = json.dumps(str(text if text is not None else ''), ensure_ascii=False)
    return ('(function(){'
            'var SEL=%s,TEXT=%s;'
            'var el=null;'
            'try{el=document.querySelector(SEL);}catch(e){return JSON.stringify({error:"bad_selector"});}'
            'if(!el){return JSON.stringify({error:"not_found"});}'
            'var tag=(el.tagName||"").toLowerCase();'
            'var type=(el.getAttribute("type")||"").toLowerCase();'
            'if(type==="password"||type==="file"){return JSON.stringify({error:"sensitive_field"});}'
            'if(tag==="select"){el.value=TEXT;'
            'el.dispatchEvent(new Event("change",{bubbles:true}));'
            'return JSON.stringify({ok:true});}'
            'if(tag!=="input"&&tag!=="textarea"){return JSON.stringify({error:"not_fillable"});}'
            'var proto=tag==="textarea"?window.HTMLTextAreaElement.prototype'
            ':window.HTMLInputElement.prototype;'
            'var d=Object.getOwnPropertyDescriptor(proto,"value");'
            'if(d&&d.set){d.set.call(el,TEXT);}else{el.value=TEXT;}'
            'el.dispatchEvent(new Event("input",{bubbles:true}));'
            'el.dispatchEvent(new Event("change",{bubbles:true}));'
            'return JSON.stringify({ok:true});'
            '})()' % (s, t))


def build_wait_js(selector):
    """等待选择器探测脚本：'1'=命中 / '0'=未命中 / 'e'=选择器非法。"""
    s = json.dumps(str(selector or ''), ensure_ascii=False)
    return ('(function(){try{return document.querySelector(%s)!==null?"1":"0";}'
            'catch(e){return "e";}})()' % s)


def map_js_result(raw):
    """evaluate_js 返回（str JSON 或 None）→ dict；解析失败/None 归一
    {'error': 'js_unavailable'}（不可泵送/空返回统一降级语义）。"""
    if not raw or not isinstance(raw, str):
        return {'error': 'js_unavailable'}
    try:
        d = json.loads(raw)
        return d if isinstance(d, dict) else {'error': 'js_unavailable'}
    except Exception:
        return {'error': 'js_unavailable'}


def _js_error(result):
    """JS 结果 dict → BrowserError（未知 error 码归 INTERNAL）。"""
    key = str((result or {}).get('error') or '')
    code, msg = _JS_ERR_MAP.get(key, (BrowserErrorCode.INTERNAL,
                                      '页面原语执行失败: %s' % key))[:2]
    hint = _JS_ERR_MAP.get(key, ('', '', ''))[2] if key in _JS_ERR_MAP else ''
    return BrowserError(code, msg, hint)


class WinSession(BrowserSession):
    """Windows 渲染后端（pywebview 次窗通道适配六原语；M1.5 骨架 / M3 真实现）。

    适配映射（设计文档 §A2.6 + master-plan §149 M3）：
    - ``navigate`` = SearchBrowser.open_url + 取 title（协议/SSRF 预校验给
      精确 taxonomy 码）+ wait_selector 等待（通道声明 ``supports_wait`` 时透传）；
    - ``extract`` = 对 navigate 所取 HTML 跑 build_extract_result
      （markdown/text/links 三态）；
    - ``click`` / ``fill`` = evaluate_js 派发（M3.2：通道声明 ``eval_js`` 时启用；
      参数经 json.dumps 编码进 JS 字符串字面量——注入防御，毒网页参数零执行）；
      click 附前后态截图审计（best-effort，通道有 ``capture_b64`` 才截）；
      fill 禁回显原文（masked:true 契约）；
    - ``screenshot`` = 通道窗口捕获（``capture_b64``；win32 窗口捕获在通道层）；
    - ``close`` = 通道 shutdown（幂等）。

    通道能力降级：SearchBrowser（搜索次窗）无 eval_js/capture_b64 →
    click/fill/screenshot 抛 PRIMITIVE_UNSUPPORTED（M1.5 迁移期行为保持）；
    DriverWindow（M3 驱动次窗）全能力。

    裁决（设计文档 §A3.3）：WinSession **不实现 open_url**——搜索管线只吃
    SearchBrowser（鸭子类型），六原语走 M3 BrowserService 新管线，与搜索
    管线解耦。
    """

    platform = 'win'

    def __init__(self, channel=None):
        """Args:
            channel: 取数通道（缺省 SearchBrowser()；测试可注入假通道——
                任何有 open_url(url) / shutdown() 的对象均可，鸭子类型；
                可选能力声明：supports_wait / eval_js / capture_b64 /
                set_visible（M3 驱动通道 DriverWindow 全有）。
        """
        super().__init__()
        self._log = get_logger()
        self._channel = channel if channel is not None else SearchBrowser()
        self._html = ''
        self._url = ''

    def navigate(self, url, wait_selector='', timeout=60):
        """导航到目标页面 → ``{ok, title, url, final_url, channel}``。

        状态机（设计文档 §A4.2）：idle → ready **直达**（不经 busy——迁移表
        只认 navigate 成功这一次迁移）；失败保持进入前状态（无迁移即无回滚）。
        ready 态再导航按迁移表拒（SESSION_BUSY）——会话一页一生命周期，
        换页请 close 后新建（M3 BrowserService 管线可扩展）。

        通道层已有 8s 看门狗与 urllib 兜底（SearchBrowser.open_url）；
        M3：wait_selector 经通道 ``supports_wait`` 声明透传（选择器等待 +
        DOM 稳定三保险在 DriverWindow 侧）；SearchBrowser 通道忽略等待参数
        （迁移期行为保持——加载事件即返回）。
        """
        try:
            u = str(url or '').strip()
            if not u:
                raise BrowserError(BrowserErrorCode.BAD_PARAMS, 'url 不能为空')
            # 状态机入口闸：READY/CLOSED 态拒绝重复导航——原依赖末尾 _enter
            # 兜（副作用已发生：页面真实加载、_html/_url 已覆写，语义却是
            # 失败）。会话一页一生命周期，换页须 close 后新建。
            if self._state is not SessionState.IDLE:
                raise BrowserError(
                    BrowserErrorCode.SESSION_BUSY,
                    '会话非空闲态（%s），拒绝重复导航' % self._state.value,
                    '一页一生命周期；换页请 browser_close 后重新导航')
            if not _ALLOWED_SCHEME.match(u):
                raise BrowserError(
                    BrowserErrorCode.NAV_BLOCKED,
                    '已阻止非 http(s) 导航: %s' % u[:80],
                    '浏览器仅支持 http/https 链接')
            if not _is_public_host(urllib.parse.urlsplit(u).hostname):
                raise BrowserError(
                    BrowserErrorCode.SSRF_BLOCKED,
                    '已阻止访问内网/环回地址: %s' % u[:80],
                    '禁止访问内网/环回地址')
            kwargs = {}
            ws = str(wait_selector or '').strip()
            if ws and getattr(self._channel, 'supports_wait', False):
                kwargs = {'wait_selector': ws, 'timeout': timeout}
            try:
                r = self._channel.open_url(u, **kwargs)
            except Exception as e:
                raise BrowserError(BrowserErrorCode.INTERNAL,
                                   '导航失败: %s' % e)
            if not isinstance(r, dict) or not r.get('ok'):
                r = r if isinstance(r, dict) else {}
                extra = {'http_status': r.get('http_status')} \
                    if r.get('http_status') else None
                raise BrowserError(map_error_code(r.get('error')),
                                   r.get('message') or '导航失败',
                                   r.get('hint') or '', extra)
            self._html = r.get('html') or ''
            self._url = u
            self._enter(SessionState.READY)
            return {'ok': True, 'title': html_title(self._html), 'url': u,
                    'final_url': u, 'channel': r.get('channel') or 'window'}
        except BrowserError:
            raise
        except Exception as e:      # 防御：通道层未预期异常不得穿透状态机
            raise BrowserError(BrowserErrorCode.INTERNAL, '导航失败: %s' % e)

    def extract(self, selector='', mode='markdown'):
        """提取 navigate 所取页面 → markdown/text/links 三态（见 build_extract_result）。"""
        self._enter(SessionState.BUSY)
        try:
            return build_extract_result(self._html, selector, mode)
        finally:
            self._settle_ready()

    def click(self, target):
        """M3.2：点击原语——evaluate_js 派发（selector|text）+ 前后态截图审计。

        参数经 json.dumps 编码进 JS 字面量（注入防御）；可见性/视口外拒点
        在页面 JS 内判定（M3.9）；前后态截图 best-effort（通道 capture_b64
        缺失或失败 → 空串，不阻断点击结果）。通道无 eval_js 能力
        （SearchBrowser）→ PRIMITIVE_UNSUPPORTED（M1.5 迁移期行为保持）。
        """
        self._enter(SessionState.BUSY)
        try:
            t = str(target or '').strip()
            if not t:
                raise BrowserError(BrowserErrorCode.BAD_PARAMS, 'target 不能为空')
            self._require_js_channel()
            before = self._capture_best_effort()
            result = map_js_result(self._eval_js(build_click_js(t)))
            if result.get('error'):
                raise _js_error(result)
            after = self._capture_best_effort()
            out = {'ok': True, 'before_b64': before, 'after_b64': after}
            if result.get('how'):
                out['how'] = result['how']
            return out
        finally:
            self._settle_ready()

    def fill(self, selector, text):
        """M3.2：填充原语——evaluate_js 派发；敏感字段（password/file）拒填；
        返回 masked:true（契约禁回显原文）。通道无 eval_js → PRIMITIVE_UNSUPPORTED。"""
        self._enter(SessionState.BUSY)
        try:
            s = str(selector or '').strip()
            if not s:
                raise BrowserError(BrowserErrorCode.BAD_PARAMS, 'selector 不能为空')
            self._require_js_channel()
            result = map_js_result(self._eval_js(build_fill_js(s, text)))
            if result.get('error'):
                raise _js_error(result)
            return {'ok': True, 'masked': True}
        finally:
            self._settle_ready()

    def screenshot(self, full_page=False):
        """M3.3：当前页截图（win32 窗口捕获在通道层 capture_b64）。

        full_page=True 的整页捕获（JS 展开文档高度）为 M8.4 细化项——当前
        返回窗口客户区（point 坐标系，与 macOS 侧同口径约定）。
        """
        self._enter(SessionState.BUSY)
        try:
            cap = getattr(self._channel, 'capture_b64', None)
            if not callable(cap):
                raise BrowserError(
                    BrowserErrorCode.PRIMITIVE_UNSUPPORTED,
                    '当前通道不支持窗口捕获（screenshot 原语需驱动次窗通道）',
                    '全屏截屏可先用 take_screenshot js_api')
            try:
                b64 = cap()
            except Exception as e:
                raise BrowserError(BrowserErrorCode.INTERNAL, '窗口捕获失败: %s' % e)
            if not b64:
                raise BrowserError(
                    BrowserErrorCode.INTERNAL, '窗口捕获返回空（窗口可能已隐藏或不可用）')
            size = getattr(self._channel, 'viewport', None) or (0, 0)
            return {'ok': True, 'b64': b64, 'width': int(size[0]), 'height': int(size[1])}
        finally:
            self._settle_ready()

    # ---------------- M3：JS 派发 / 截图 / 可见性 helper ----------------

    def _require_js_channel(self):
        """通道能力闸：无 eval_js 的通道（SearchBrowser）不支持交互原语——
        PRIMITIVE_UNSUPPORTED（M1.5 迁移期行为保持；驱动原语需 DriverWindow）。"""
        if not callable(getattr(self._channel, 'eval_js', None)):
            raise BrowserError(
                BrowserErrorCode.PRIMITIVE_UNSUPPORTED,
                '当前通道不支持页面交互原语（需浏览器驱动次窗通道）',
                '读取页面内容可经 browser_open')

    def _eval_js(self, code, timeout=None):
        """evaluate_js 统一门：通道声明 eval_js 才派发（否则 js_unavailable
        降级语义）；不抛——异常归 None 由 map_js_result 统一降级。"""
        fn = getattr(self._channel, 'eval_js', None)
        if not callable(fn):
            return None
        try:
            kw = {}
            if timeout is not None:
                kw['timeout'] = timeout
            return fn(code, **kw) if kw else fn(code)
        except Exception as e:
            self._log.debug('evaluate_js 派发失败: %r', e)
            return None

    def _capture_best_effort(self):
        """前后态截图 best-effort：失败/无能力 → ''（审计字段缺省，不阻断原语）。"""
        cap = getattr(self._channel, 'capture_b64', None)
        if not callable(cap):
            return ''
        try:
            return cap() or ''
        except Exception:
            return ''

    def close(self):
        """关闭会话（幂等）：销毁次窗 + 停回收线程。重复调用直接返回 ok。"""
        with self._lock:
            already = self._state is SessionState.CLOSED
        if not already:
            self._enter(SessionState.CLOSED)
            try:
                self._channel.shutdown()
            except Exception as e:
                self._log.debug('WinSession 关闭通道失败（忽略）: %r', e)
        self._html = ''
        self._url = ''
        return {'ok': True}
