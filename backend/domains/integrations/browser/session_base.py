# -*- coding: utf-8 -*-
"""v1.9.0 M1.2 · 浏览器会话抽象基座（BrowserSession 六原语 + 状态机 + 错误 taxonomy）。

模块职责（master-plan §6.2 / 设计文档 v19-m1m2-design.md §A3.2）：
- ``BrowserErrorCode``：js_api error.code 全集枚举（前端按码分支）；
- ``BrowserError``：结构化浏览器错误（``to_payload`` 与 search_service._error
  同形状——降级永不阻断，禁异常穿透 js_api，B8.9）；
- ``SessionState``：idle/ready/busy/closed 四态 + ``_TRANSITIONS`` 合法迁移表；
- ``BrowserSession(ABC)``：六原语抽象（navigate/extract/click/fill/screenshot/
  close）+ 状态机守卫 ``_enter``（子类原语入口首调；BUSY→READY 回落见各原语
  finally——失败也回 ready，单会话串行不残留忙态）；
- 公共 helper ``_is_public_host`` / ``_decode_html``：自 search_browser.py
  **原样上移**（session_win / session_headless 的 SSRF 防护与响应解码共用，
  代码零改——迁移=行为等价铁律）；
- 公共 helper ``html_title`` / ``html_links`` / ``build_extract_result``：六原语
  extract 的 markdown/text/links 三态组装（Win/Headless 共用；纯函数零 IO，
  经 adapters/extract 兄弟模块的纯函数实现）。

v1.9.0 T02：本模块是 browser/ 包核心——session_win / session_headless /
platform 均依赖本模块；对 session_base 的依赖方向单向，无循环导入。
"""
import ipaddress
import re
import socket
import threading
from abc import ABC, abstractmethod
from enum import Enum

from .adapters import build_tree, element_text, iter_elements
from .extract import DEFAULT_MAX_CHARS, extract_main_content


class BrowserErrorCode(str, Enum):
    """错误 taxonomy（js_api error.code 与本枚举逐字对应；前端按码分支）。"""
    BAD_PARAMS = 'BAD_PARAMS'                    # 参数非法（空 url/超长/模式未知）
    NAV_BLOCKED = 'NAV_BLOCKED'                  # 非 http(s) 协议拦截
    SSRF_BLOCKED = 'SSRF_BLOCKED'                # 内网/环回/链路本地拦截
    TIMEOUT = 'TIMEOUT'                          # 加载/等待超时
    SESSION_CLOSED = 'SESSION_CLOSED'            # 会话已关闭后调原语
    SESSION_BUSY = 'SESSION_BUSY'                # 忙态重入（单会话串行）
    PRIMITIVE_UNSUPPORTED = 'PRIMITIVE_UNSUPPORTED'  # 该后端不支持此原语（headless click/fill/screenshot；M3 前 win click/fill/screenshot）
    UNSUPPORTED_PLATFORM = 'UNSUPPORTED_PLATFORM'    # macOS 后端 M4 前不可用
    EXTRACT_EMPTY = 'EXTRACT_EMPTY'              # 提取结果为空
    INTERNAL = 'INTERNAL'                        # 未分类内部错误


def map_error_code(code):
    """任意错误码串 → BrowserErrorCode（未知 → INTERNAL）。

    search 栈通道码（BAD_PARAMS/NAV_BLOCKED/TIMEOUT）直接命中；
    ENGINE_UNREACHABLE / WINDOW_UNAVAILABLE 等会话层无对应码 → INTERNAL
    （调用方经 BrowserError.extra 携带 http_status 等上下文，不丢信息）。
    """
    try:
        return BrowserErrorCode(str(code or '').strip().upper())
    except ValueError:
        return BrowserErrorCode.INTERNAL


class BrowserError(Exception):
    """浏览器结构化错误（载荷与 search_service._error 同形状）。

    Attributes:
        code: BrowserErrorCode 枚举成员（error.code 逐字对应）。
        message: 人话描述。
        hint: 可操作提示（可空——空则不出现在载荷里）。
        extra: 附加键（如 http_status；合并进 error dict，缺省不出现）。
    """

    def __init__(self, code, message, hint='', extra=None):
        if isinstance(code, BrowserErrorCode):
            self.code = code
        else:
            self.code = map_error_code(code)
        self.message = str(message or '')
        self.hint = str(hint or '')
        self.extra = dict(extra or {})
        super().__init__(self.message)

    def to_payload(self):
        """→ ``{ok: False, error: {code, message, hint?}}``（与 search_service._error 同形状）。"""
        e = {'code': self.code.value, 'message': self.message}
        if self.hint:
            e['hint'] = self.hint
        for k, v in self.extra.items():
            if v is not None and k not in e:
                e[k] = v
        return {'ok': False, 'error': e}


class SessionState(str, Enum):
    """会话状态机四态（设计文档 §A4.2：idle→ready→busy→ready→closed）。"""
    IDLE = 'idle'      # 已创建未导航
    READY = 'ready'    # 可接受原语
    BUSY = 'busy'      # 原语执行中（单会话串行，重入 → SESSION_BUSY）
    CLOSED = 'closed'  # 终态


class BrowserSession(ABC):
    """六原语抽象（master-plan §6.2 契约为唯一事实源；M3 Win/M4 Mac 实现）。

    合法状态迁移表（类属性；BUSY→CLOSED 仅 close() 强制路径）：

        IDLE  → {READY, CLOSED}     # navigate 成功 / close
        READY → {BUSY, CLOSED}      # 原语进入 / close
        BUSY  → {READY, CLOSED}     # 原语返回（含失败——失败也回 ready）/ close 强制
        CLOSED → {}                 # 终态

    子类原语实现约定（设计文档 §A3.2「状态机守卫」）：
    1. 入口首调 ``self._enter(SessionState.BUSY)``（navigate）/直接执行；
    2. 出口经 ``_enter(READY)`` 回落（finally 里兜底，防异常残留忙态）；
    3. navigate 失败回退到进入前状态（``_revert``——idle 保持 idle）。
    """

    platform = 'abstract'          # 'win' | 'headless' | 'mac'

    # ---- 合法状态迁移表（类属性）----
    _TRANSITIONS = {
        SessionState.IDLE:   {SessionState.READY, SessionState.CLOSED},
        SessionState.READY:  {SessionState.BUSY, SessionState.CLOSED},
        SessionState.BUSY:   {SessionState.READY, SessionState.CLOSED},   # BUSY→CLOSED 仅 close() 强制路径
        SessionState.CLOSED: set(),
    }

    def __init__(self):
        self._lock = threading.RLock()
        self._state = SessionState.IDLE

    # ---------------- 六原语（子类实现；契约见各 docstring） ----------------
    @abstractmethod
    def navigate(self, url, wait_selector='', timeout=60):
        """导航到目标页面 → ``{ok, title, url, final_url, channel}`` 或 BrowserError 载荷。

        Args:
            url: 目标 URL（仅 http/https；其他协议 NAV_BLOCKED）。
            wait_selector: 可选等待选择器（M3 语义；当前后端按加载事件判定）。
            timeout: 超时秒数。
        """

    @abstractmethod
    def extract(self, selector='', mode='markdown'):
        """提取当前页面内容。mode ∈ markdown|text|links →
        ``{ok, markdown?/text?/links?, truncated, char_count}``。"""

    @abstractmethod
    def click(self, target):
        """target = CSS selector 或可见文本 → ``{ok, before_b64, after_b64}``。"""

    @abstractmethod
    def fill(self, selector, text):
        """→ ``{ok, masked: True}``（禁回显原文）。"""

    @abstractmethod
    def screenshot(self, full_page=False):
        """→ ``{ok, b64, width, height}``（point 坐标系）。"""

    @abstractmethod
    def close(self):
        """→ ``{ok}``（幂等：重复调用不抛、不重复销毁）。"""

    # ---------------- 状态机守卫（子类原语入口首调） ----------------
    def _enter(self, next_state):
        """合法迁移校验 + 状态推进（持 ``self._lock``）。

        非法迁移 → BrowserError：
        - CLOSED → 任意：SESSION_CLOSED（终态）；
        - BUSY → BUSY（重入）：SESSION_BUSY（单会话串行）；
        - 其余越表迁移（如 IDLE → BUSY 未导航即调原语）：SESSION_BUSY
          （「当前不接受新原语」——忙态重入与未就绪同属不可用）。

        Args:
            next_state: 目标 SessionState。
        """
        with self._lock:
            cur = self._state
            if cur is SessionState.CLOSED:
                raise BrowserError(BrowserErrorCode.SESSION_CLOSED,
                                   '会话已关闭，不能执行原语')
            if next_state not in self._TRANSITIONS[cur]:
                if next_state is SessionState.BUSY:
                    if cur is SessionState.BUSY:
                        raise BrowserError(
                            BrowserErrorCode.SESSION_BUSY,
                            '会话忙：原语执行中（单会话串行，重入被拒）')
                    raise BrowserError(
                        BrowserErrorCode.SESSION_BUSY,
                        '会话未就绪（state=%s），请先 navigate 到目标页面'
                        % cur.value)
                raise BrowserError(
                    BrowserErrorCode.SESSION_BUSY,
                    '非法状态迁移: %s → %s' % (cur.value, next_state.value))
            self._state = next_state

    def _revert(self, state):
        """异常路径回滚到进入前状态（内部用；调用方保证语义合法）。"""
        with self._lock:
            self._state = state

    def _settle_ready(self):
        """原语出口回落 READY（失败也回——单会话串行不残留忙态）。

        close() 强制路径（BUSY→CLOSED）已接管时不回改（防掩盖终态）。
        v1.9.0 M4 上移基类（Win/Mac 会话共用——原仅 WinSession 持有）。
        """
        try:
            self._enter(SessionState.READY)
        except BrowserError:
            pass

    @property
    def state(self):
        """当前状态（SessionState；持锁读取）。"""
        with self._lock:
            return self._state


# ================= 公共 helper（自 search_browser.py 原样上移，代码零改） =================

# 198.18.0.0/15（RFC 2544 基准段）= Clash/Surge fake-ip 标准地址池——模块级
# 预编译（纯计算零 IO）；按公网放行的依据见 _is_public_host docstring。
_FAKEIP_BENCHMARK_NET = ipaddress.ip_network('198.18.0.0/15')


def _is_fakeip_benchmark(ip):
    """IP 是否落在 fake-ip 基准段（198.18.0.0/15；按公网放行）。"""
    try:
        return ip in _FAKEIP_BENCHMARK_NET
    except Exception:
        return False


def _is_public_host(host):
    """host 是否解析到公网地址（SSRF 防护；ipaddress + getaddrinfo）。

    拒绝 private / loopback / link_local / reserved / multicast / unspecified
    （含 127/8、10/8、192.168/16、169.254/16、::1、fe80::/10、fc00::/7 等）——
    防搜索窗口/直连被抓包成本内网探测代理（browser_open 可被诱导访问
    元数据端点 169.254.169.254 或内网管理口）。

    口径（2026-10-21 修订）：字面 IP 直接判定；域名解析成功且全部落私网段
    → 拒绝；**解析失败放行**——本机 DNS 瞬时不可用时若 fail-closed 会误杀
    全部正常搜索（fetch 会经同一解析器自然失败，拦截无增益），且令调用方
    依赖实时 DNS 产生抖动。已知边界：DNS rebinding（检查时公网、抓取时
    私网）不在此威胁模型内。

    口径（2026-10-24 修订，真机实证）：**198.18.0.0/15（RFC 2544 基准段）
    按公网放行**——该段保留给基准测试，无任何内网服务/云元数据（云元数据
    在 169.254 link-local，照拦），是 Clash/Surge fake-ip 模式的标准地址池；
    代理用户全部域名解析至此段，按私网拒绝等于代理环境下全部浏览被 SSRF
    误杀。其余私网/环回/链路本地语义不变。
    """
    h = str(host or '').strip().lower().rstrip('.')
    if not h:
        return False
    # 字面 IP（v4/v6，可带 zone id）：不触 DNS，直接判定
    try:
        ip = ipaddress.ip_address(h.split('%', 1)[0])
        if _is_fakeip_benchmark(ip):
            return True
        return not (ip.is_private or ip.is_loopback or ip.is_link_local or
                    ip.is_reserved or ip.is_multicast or ip.is_unspecified)
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(h, None)
    except Exception:
        return True        # DNS 失败：放行（fetch 经同一解析器自然失败）
    saw_addr = False
    for info in infos:
        addr = str(info[4][0]).split('%', 1)[0]   # 去 zone id（fe80::1%eth0）
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            return False
        saw_addr = True
        if _is_fakeip_benchmark(ip):
            continue          # fake-ip 基准段：按公网放行（见 docstring）
        if ip.is_private or ip.is_loopback or ip.is_link_local or \
                ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            return False
    return saw_addr


def _decode_html(raw, content_type=''):
    """响应体解码：先按 Content-Type charset，失败回落 utf-8（replace 不抛）。

    Args:
        raw: bytes 响应体。
        content_type: 响应 Content-Type 头（可含 ``charset=xxx``）。

    Returns:
        str: 解码文本（坏字节替换为 U+FFFD，与 adapters 侧解码口径一致）。
    """
    if isinstance(raw, str):
        return raw
    m = re.search(r'charset=([\w-]+)', str(content_type or ''), re.IGNORECASE)
    if m:
        enc = m.group(1)
        try:
            return bytes(raw).decode(enc, 'replace')
        except (LookupError, TypeError):
            pass
    return bytes(raw).decode('utf-8', 'replace')


# ================= 公共 helper（六原语 extract 三态组装；Win/Headless 共用） =================

def html_title(html):
    """取 ``<title>`` 文本（全树查找首个 title 元素；无标题返回 ''）。"""
    try:
        root = build_tree(html)
        for el in iter_elements(root):
            if el.tag == 'title':
                return element_text(el)
    except Exception:
        pass
    return ''


# links 档条数上限（防病态页把载荷撑爆——与 generic 摘要截断同思路）
_LINKS_MAX = 200

# extract 合法模式（契约 §A3.2：markdown|text|links）
_EXTRACT_MODES = ('markdown', 'text', 'links')


def html_links(html, limit=_LINKS_MAX):
    """提取 http(s) 锚点 → ``[{'text', 'href'}]``（文档序去重，上限 limit）。"""
    out = []
    seen = set()
    try:
        root = build_tree(html)
        for el in iter_elements(root):
            if el.tag != 'a':
                continue
            href = (el.attrs.get('href') or '').strip()
            if not href.lower().startswith(('http://', 'https://')):
                continue
            if href in seen:
                continue
            seen.add(href)
            out.append({'text': element_text(el), 'href': href})
            if len(out) >= limit:
                break
    except Exception:
        pass
    return out


def build_extract_result(html, selector='', mode='markdown',
                         max_chars=DEFAULT_MAX_CHARS):
    """六原语 extract 的三态组装（markdown/text/links；纯函数，IO 在会话层）。

    Args:
        html: 当前页面 HTML（会话层 navigate 时存取）。
        selector: 可选 CSS 选择器（非空优先；未命中 → EXTRACT_EMPTY）。
        mode: markdown | text | links。
        max_chars: 正文字数上限（>0 生效；DEFAULT_MAX_CHARS=8000）。

    Returns:
        dict: ``{ok: True, ...}``——markdown 档 ``{markdown, truncated,
        char_count}``；text 档 ``{text, ...}``；links 档
        ``{links, truncated, char_count}``。

    Raises:
        BrowserError: 模式未知（BAD_PARAMS）/ 页面或正文为空（EXTRACT_EMPTY）。
    """
    m = str(mode or 'markdown').strip().lower()
    if m not in _EXTRACT_MODES:
        raise BrowserError(
            BrowserErrorCode.BAD_PARAMS,
            '不支持的提取模式: %r（合法值: %s）'
            % (mode, '/'.join(_EXTRACT_MODES)))
    text = str(html or '')
    if not text.strip():
        raise BrowserError(BrowserErrorCode.EXTRACT_EMPTY,
                           '页面内容为空（请先 navigate 到目标页面）')
    if m == 'links':
        links = html_links(text)
        if not links:
            raise BrowserError(BrowserErrorCode.EXTRACT_EMPTY,
                               '未从页面提取到 http(s) 链接')
        return {'ok': True, 'links': links, 'truncated': False,
                'char_count': 0}
    ex = extract_main_content(text, str(selector or '').strip() or None, 0)
    if ex.get('extractor') == 'selector_miss':
        raise BrowserError(
            BrowserErrorCode.EXTRACT_EMPTY,
            '选择器未命中页面元素: %s' % str(selector or '')[:80],
            '可更换 selector 或省略该参数用密度提取')
    content = ex.get('content') or ''
    if not content.strip():
        raise BrowserError(BrowserErrorCode.EXTRACT_EMPTY,
                           '未能从页面提取到正文内容')
    full_chars = len(content)
    limit = max_chars if isinstance(max_chars, int) and max_chars > 0 \
        else DEFAULT_MAX_CHARS
    truncated = full_chars > limit
    if truncated:
        content = content[:limit]
    key = 'markdown' if m == 'markdown' else 'text'
    return {'ok': True, key: content, 'truncated': truncated,
            'char_count': full_chars}
