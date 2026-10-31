# -*- coding: utf-8 -*-
"""v1.9.0 M1.11 · 无头浏览器后端骨架（urllib 直连；CI/无显示环境/降级链终点）。

模块职责（设计文档 §A3.2 session_headless.py 骨架）：
- ``HeadlessSession(BrowserSession)``：六原语中的 navigate/extract/close 落地
  （click/fill/screenshot → PRIMITIVE_UNSUPPORTED——无渲染后端）；
- navigate：协议校验（NAV_BLOCKED）→ SSRF 校验（SSRF_BLOCKED）→
  ``urlopen_no_redirect``（UA 复用 session_win.USER_AGENT，2MB 上限）→
  存 ``_html`` / ``_url`` → ``{ok, title, url, final_url, channel: 'headless'}``；
- extract：对 ``_html`` 跑 session_base.build_extract_result
  （DEFAULT_MAX_CHARS=8000）→ markdown/text/links 三态；
- close：清 ``_html``（幂等）。

复用面（设计文档明示）：session_base._is_public_host / _decode_html /
build_extract_result、mcp_transport_http.urlopen_no_redirect、
browser/extract.extract_main_content（经 session_base 间接）、
browser/adapters 纯函数（经 session_base 间接）。
"""
import socket
import urllib.error
import urllib.parse
import urllib.request

from ..mcp.mcp_transport_http import urlopen_follow_redirect_safe
from .session_base import (BrowserError, BrowserErrorCode, BrowserSession,
                           SessionState, _decode_html, _is_public_host,
                           build_extract_result, html_title)
from .session_win import _ALLOWED_SCHEME, MAX_HTML_BYTES, USER_AGENT


class HeadlessSession(BrowserSession):
    """urllib 无头后端（CI/无显示环境/降级链终点）。

    通道标注 ``channel='headless'``；非 JS 渲染引擎页面可用，JS 渲染引擎
    可能只得空壳（由调用方结合提取结果判定）。
    """

    platform = 'headless'

    def __init__(self):
        super().__init__()
        self._html = ''
        self._url = ''

    def navigate(self, url, wait_selector='', timeout=60):
        """协议校验 → SSRF 校验 → urlopen_no_redirect → 存 HTML → ok 载荷。

        状态机（设计文档 §A4.2）：idle → ready **直达**（不经 busy；失败保持
        进入前状态——迁移表只认 navigate 成功这一次迁移）。

        错误码照搬 search_browser 映射口径：协议 → NAV_BLOCKED；内网 →
        SSRF_BLOCKED；超时 → TIMEOUT；其余网络/HTTP 失败 → INTERNAL
        （http_status 经 extra 携带，不丢上下文）。

        Args:
            url: 目标 URL（仅 http/https）。
            wait_selector: 六原语契约参数（无头后端无渲染，忽略）。
            timeout: 抓取超时秒数（缺省 60）。
        """
        try:
            u = str(url or '').strip()
            if not u:
                raise BrowserError(BrowserErrorCode.BAD_PARAMS, 'url 不能为空')
            if not _ALLOWED_SCHEME.match(u):
                raise BrowserError(
                    BrowserErrorCode.NAV_BLOCKED,
                    '已阻止非 http(s) 导航: %s' % u[:80],
                    '无头后端仅支持 http/https 链接')
            if not _is_public_host(urllib.parse.urlsplit(u).hostname):
                raise BrowserError(
                    BrowserErrorCode.SSRF_BLOCKED,
                    '已阻止访问内网/环回地址: %s' % u[:80],
                    '禁止访问内网/环回地址')
            req = urllib.request.Request(u, headers={
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            })
            try:
                # 复核批：GET 取数改安全跟随重定向（session_win 同口径）
                resp = urlopen_follow_redirect_safe(req, timeout=timeout)
            except urllib.error.HTTPError as e:
                raise BrowserError(
                    BrowserErrorCode.INTERNAL,
                    '目标返回 HTTP %s' % e.code,
                    '稍后重试或更换地址', {'http_status': e.code})
            except urllib.error.URLError as e:
                reason = getattr(e, 'reason', e)
                if isinstance(reason, (socket.timeout, TimeoutError)) or \
                        'timed out' in str(reason).lower():
                    raise BrowserError(
                        BrowserErrorCode.TIMEOUT,
                        '连接目标站点超时（%ss）' % timeout,
                        '可重试或更换地址')
                raise BrowserError(
                    BrowserErrorCode.INTERNAL,
                    '无法连接目标站点: %s' % reason,
                    '请检查网络或稍后重试')
            except Exception as e:
                raise BrowserError(BrowserErrorCode.INTERNAL, '抓取失败: %s' % e)
            try:
                raw = resp.read(MAX_HTML_BYTES + 1)
                if len(raw) > MAX_HTML_BYTES:
                    raw = raw[:MAX_HTML_BYTES]        # 防 OOM 截断
                try:
                    ctype = (resp.headers.get('Content-Type') or '') \
                        if resp.headers else ''
                except Exception:
                    ctype = ''
            finally:
                try:
                    resp.close()
                except Exception:
                    pass
            self._html = _decode_html(raw, ctype)
            self._url = u
            self._enter(SessionState.READY)
            return {'ok': True, 'title': html_title(self._html), 'url': u,
                    'final_url': u, 'channel': 'headless'}
        except BrowserError:
            raise
        except Exception as e:      # 防御：未预期异常不得穿透状态机
            raise BrowserError(BrowserErrorCode.INTERNAL, '导航失败: %s' % e)

    def extract(self, selector='', mode='markdown'):
        """对 navigate 所取 HTML 跑 build_extract_result（markdown/text/links）。"""
        self._enter(SessionState.BUSY)
        try:
            return build_extract_result(self._html, selector, mode)
        finally:
            self._settle_ready()

    def click(self, target):
        """无头后端无渲染能力——点击原语不支持。"""
        self._enter(SessionState.BUSY)
        try:
            raise BrowserError(
                BrowserErrorCode.PRIMITIVE_UNSUPPORTED,
                '无头后端不支持 click 原语（需 Win/Mac 渲染后端）')
        finally:
            self._settle_ready()

    def fill(self, selector, text):
        """无头后端无渲染能力——表单填充原语不支持。"""
        self._enter(SessionState.BUSY)
        try:
            raise BrowserError(
                BrowserErrorCode.PRIMITIVE_UNSUPPORTED,
                '无头后端不支持 fill 原语（需 Win/Mac 渲染后端）')
        finally:
            self._settle_ready()

    def screenshot(self, full_page=False):
        """无头后端无渲染能力——截屏原语不支持。"""
        self._enter(SessionState.BUSY)
        try:
            raise BrowserError(
                BrowserErrorCode.PRIMITIVE_UNSUPPORTED,
                '无头后端不支持 screenshot 原语（需 Win/Mac 渲染后端）')
        finally:
            self._settle_ready()

    def close(self):
        """关闭会话（幂等）：清 HTML（无头后端无进程/窗口可销毁）。"""
        with self._lock:
            already = self._state is SessionState.CLOSED
        if not already:
            self._enter(SessionState.CLOSED)
        self._html = ''
        self._url = ''
        return {'ok': True}

    def _settle_ready(self):
        """原语出口回落 READY（失败也回——不残留忙态；close 强制路径除外）。"""
        try:
            self._enter(SessionState.READY)
        except BrowserError:
            pass
