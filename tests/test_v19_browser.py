# -*- coding: utf-8 -*-
"""v1.9.0 M1/T02 浏览器平台抽象包验收测试。

锁定（deliverables/dev-plan/v19-m1m2-design.md §B7 T02 测试点）：
- test_detect_platform_*：工厂平台探测（win32→win；darwin→mac→UNSUPPORTED；
  linux→headless；未知平台 → BAD_PARAMS）；
- test_session_state_machine_*：四态迁移表 + 非法迁移抛码
  （CLOSED→任意 SESSION_CLOSED；BUSY 重入 SESSION_BUSY）；
- test_error_taxonomy_*：BrowserErrorCode 10 码逐字 + BrowserError.to_payload
  与 search_service._error 同形状；
- test_navigate_blocks_*：非 http(s) → NAV_BLOCKED；内网/环回字面 IP →
  SSRF_BLOCKED（ hermetic ：字面 IP 不触 DNS）；
- test_win_session_migration_equivalence：SearchBrowser 类名/模块落点 +
  WinSession 六原语行为（navigate→READY、失败回落、click/fill/screenshot →
  PRIMITIVE_UNSUPPORTED 且失败也回 READY、close 幂等）；
- test_headless_navigate_and_extract：urllib 通道导航 + markdown/text/links
  三态提取（fake 响应，零网络）；
- test_headless_click_unsupported：PRIMITIVE_UNSUPPORTED；
- test_platform_win_secrets_roundtrip：DPAPI 加解密往返 + 文件格式 +
  delete 幂等（DPAPI 不可用 skip）；
- test_platform_win_trash_fallback / recycle：send2trash 缺失 → delete+
  警示；注入假库 → recycle；
- test_platform_notify_never_raises：成功/失败两路均结构化返回、禁抛；
- test_platform_factory_*：get_platform_services('win') 七接口聚合；
  非 win → UNSUPPORTED_PLATFORM；
- test_search_migration_regression：SearchService 自 browser.service 导入，
  既有五方法（browser_search/browser_open/search_status/search_cache_stats/
  browser_takeover）经新路径全绿——迁移=行为等价铁律；
- test_api_import_paths_updated：api.py 走 browser.service；旧路径
  backend.services.search_service 不可导入（删干净）；get_api_info 五方法在册。

铁律：除 DPAPI 往返（真实 crypt32，Windows 环境）外全部 hermetic——
零网络/零窗口（conftest fake webview 吸收）；fixture 即契约
（tests/fixtures/v18/ 落盘文件）。
"""
import io
import json
import os
import subprocess
import sys
import types

import pytest

from conftest import HOME, fresh_home  # noqa: F401  （fresh_home：autouse 隔离 HOME）

from backend.domains.integrations.browser import create_session, detect_platform
from backend.domains.integrations.browser import session_base
from backend.domains.integrations.browser import session_headless, session_win
from backend.domains.integrations.browser.platform import get_platform_services
from backend.domains.integrations.browser.platform import win as win_mod
from backend.domains.integrations.browser.session_base import (BrowserError,
                                                    BrowserErrorCode,
                                                    BrowserSession,
                                                    SessionState)


# ---- 沙箱 DNS 劫持处置（2026-10-23 实测）----
# 本机（WorkBuddy 沙箱）DNS 将全部域名解析到 198.18.0.x（benchmark 保留段，
# ipaddress 判 private）——session_win 的 SSRF 策略按设计拦截（行为正确），
# 但令域名 URL 的功能测试（WinSession navigate/browser_open 等）全数误挂。
# QA 同日早段同测试全绿（彼时 DNS 正常）——环境时段性变化，非代码回归。
# 处置：autouse fixture 对**非 SSRF 专测**绕过 host 公网判定（SSRF 的 6 类
# 字面 IP 拦截测试不触 DNS、不受影响，不绕过）；SSRF 语义由字面 IP 测试锁定。
@pytest.fixture(autouse=True)
def _bypass_sandbox_dns_hijack(request, monkeypatch):
    if 'ssrf' in request.node.name.lower() or 'navigate_blocks' in request.node.name.lower():
        return                      # SSRF 专测：不绕过
    monkeypatch.setattr(session_base, '_is_public_host', lambda host: True)
    if hasattr(session_win, '_is_public_host'):
        monkeypatch.setattr(session_win, '_is_public_host', lambda host: True)
    # service 模块也 from .session_base import 了同名引用（browser_open 走它）
    try:
        import backend.domains.integrations.browser.service as _svc_mod
        monkeypatch.setattr(_svc_mod, '_is_public_host', lambda host: True)
    except Exception:
        pass

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           'fixtures', 'v18')

# ============================================================ 测试替身


class _DummySession(BrowserSession):
    """最小六原语实现（状态机行为验证用；原语本身只做状态进出）。"""

    platform = 'dummy'

    def navigate(self, url, wait_selector='', timeout=60):
        # 设计 §A4.2：navigate 是 idle → ready 直达（不经 busy；失败无迁移）
        try:
            self._enter(SessionState.READY)
            return {'ok': True, 'url': str(url or '')}
        except BrowserError:
            raise

    def extract(self, selector='', mode='markdown'):
        self._enter(SessionState.BUSY)
        try:
            return {'ok': True}
        finally:
            try:
                self._enter(SessionState.READY)
            except BrowserError:
                pass        # close() 强制路径已接管（BUSY→CLOSED）

    def click(self, target):
        self._enter(SessionState.BUSY)
        try:
            raise BrowserError(BrowserErrorCode.PRIMITIVE_UNSUPPORTED,
                               'dummy 不支持 click')
        finally:
            try:
                self._enter(SessionState.READY)
            except BrowserError:
                pass

    def fill(self, selector, text):
        self._enter(SessionState.BUSY)
        try:
            raise BrowserError(BrowserErrorCode.PRIMITIVE_UNSUPPORTED,
                               'dummy 不支持 fill')
        finally:
            try:
                self._enter(SessionState.READY)
            except BrowserError:
                pass

    def screenshot(self, full_page=False):
        self._enter(SessionState.BUSY)
        try:
            raise BrowserError(BrowserErrorCode.PRIMITIVE_UNSUPPORTED,
                               'dummy 不支持 screenshot')
        finally:
            try:
                self._enter(SessionState.READY)
            except BrowserError:
                pass

    def close(self):
        if self.state is not SessionState.CLOSED:
            self._enter(SessionState.CLOSED)
        return {'ok': True}


class _FakeChannel:
    """WinSession 注入替身：open_url 返回带标题的固定 HTML；shutdown 记账。"""

    def __init__(self, html=None, result=None):
        self._html = html if html is not None else (
            '<html><head><title>通道标题</title></head>'
            '<body><article><h1>正文大标题</h1>'
            '<p>第一段正文内容，足够长度以通过密度提取。</p>'
            '<p>第二段正文内容，继续补充字数使正文稳定被选中。</p>'
            '<a href="https://example.com/a">链接甲</a>'
            '<a href="https://example.org/b">链接乙</a>'
            '</article></body></html>')
        self._result = result
        self.opened = []
        self.shutdown_called = False

    def open_url(self, url):
        self.opened.append(url)
        if self._result is not None:
            return self._result
        return {'ok': True, 'html': self._html, 'channel': 'window'}

    def shutdown(self):
        self.shutdown_called = True


class _FakeResp:
    """urlopen_no_redirect 替身响应（read/headers/close）。"""

    def __init__(self, data, ctype='text/html; charset=utf-8'):
        self._data = data if isinstance(data, bytes) else data.encode('utf-8')
        self.headers = {'Content-Type': ctype}
        self.closed = False

    def read(self, n=None):
        return self._data[:n] if n else self._data

    def close(self):
        self.closed = True


class _FxBrowser:
    """SearchService 注入替身通道（固定 HTML；open_url 记账）。"""

    def __init__(self, html):
        self._html = html
        self.calls = []

    def open_url(self, url):
        self.calls.append(url)
        return {'ok': True, 'html': self._html, 'channel': 'urllib'}


class _FakeClock:
    """可控单调时钟（缓存 TTL/elapsed 断言用）。"""

    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t


def _fx(name):
    """读 fixture（utf-8）——fixture 即契约，测试只认落盘结构。"""
    with io.open(os.path.join(FIXTURE_DIR, name), encoding='utf-8') as f:
        return f.read()


# ============================================================ 平台探测与工厂


class TestPlatformFactory:
    def test_detect_platform_win32(self, monkeypatch):
        monkeypatch.setattr(sys, 'platform', 'win32')
        assert detect_platform() == 'win'
        s = create_session('win')
        assert isinstance(s, session_win.WinSession)
        assert s.platform == 'win'

    def test_detect_platform_darwin_raises(self, monkeypatch):
        """macOS：detect 返回 'mac'；create_session('mac') 抛
        UNSUPPORTED_PLATFORM（M4 前 mac 分支禁静默回落——禁假能力）。"""
        monkeypatch.setattr(sys, 'platform', 'darwin')
        assert detect_platform() == 'mac'
        with pytest.raises(BrowserError) as ei:
            create_session('mac')
        assert ei.value.code is BrowserErrorCode.UNSUPPORTED_PLATFORM

    def test_detect_platform_linux_headless(self, monkeypatch):
        monkeypatch.setattr(sys, 'platform', 'linux')
        assert detect_platform() == 'headless'
        s = create_session()          # 缺省 = 探测值
        assert isinstance(s, session_headless.HeadlessSession)
        assert s.platform == 'headless'

    def test_create_session_unknown_platform(self):
        with pytest.raises(BrowserError) as ei:
            create_session('solaris')
        assert ei.value.code is BrowserErrorCode.BAD_PARAMS


# ============================================================ 错误 taxonomy


class TestErrorTaxonomy:
    _EXPECTED = {'BAD_PARAMS', 'NAV_BLOCKED', 'SSRF_BLOCKED', 'TIMEOUT',
                 'SESSION_CLOSED', 'SESSION_BUSY', 'PRIMITIVE_UNSUPPORTED',
                 'UNSUPPORTED_PLATFORM', 'EXTRACT_EMPTY', 'INTERNAL'}

    def test_error_taxonomy_enum_complete(self):
        """10 码逐字在位（设计文档 §A3.2 taxonomy）。"""
        got = {c.name for c in BrowserErrorCode}
        assert got == self._EXPECTED
        for c in BrowserErrorCode:
            assert c.value == c.name          # error.code 与枚举逐字对应
            assert BrowserErrorCode(c.value) is c

    def test_map_error_code_unknown_to_internal(self):
        from backend.domains.integrations.browser.session_base import map_error_code
        assert map_error_code('NAV_BLOCKED') is BrowserErrorCode.NAV_BLOCKED
        assert map_error_code('bad_params') is BrowserErrorCode.BAD_PARAMS
        # search 栈通道码无会话层对映 → INTERNAL（不炸）
        assert map_error_code('ENGINE_UNREACHABLE') is BrowserErrorCode.INTERNAL
        assert map_error_code('') is BrowserErrorCode.INTERNAL

    def test_to_payload_shape_matches_service_error(self):
        """载荷 {ok: False, error: {code, message, hint?}}——与
        search_service._error 同形状（契约 §3.1）。"""
        e = BrowserError(BrowserErrorCode.BAD_PARAMS, 'url 不能为空',
                         '仅支持 http/https')
        p = e.to_payload()
        assert p == {'ok': False,
                     'error': {'code': 'BAD_PARAMS', 'message': 'url 不能为空',
                               'hint': '仅支持 http/https'}}
        # hint 缺省不出现；extra 键合并
        e2 = BrowserError(BrowserErrorCode.TIMEOUT, '超时')
        assert e2.to_payload() == {'ok': False,
                                   'error': {'code': 'TIMEOUT',
                                             'message': '超时'}}
        e3 = BrowserError(BrowserErrorCode.INTERNAL, 'HTTP 429', '重试',
                          {'http_status': 429})
        assert e3.to_payload()['error']['http_status'] == 429


# ============================================================ 会话状态机


class TestSessionStateMachine:
    def test_session_state_machine_transitions(self):
        """idle→ready→busy→ready→closed 全链 + 失败也回 ready。"""
        s = _DummySession()
        assert s.state is SessionState.IDLE
        # idle → busy 非法（未导航即调原语）
        with pytest.raises(BrowserError) as ei:
            s.extract()
        assert ei.value.code is BrowserErrorCode.SESSION_BUSY
        assert s.state is SessionState.IDLE
        # navigate 成功：idle → ready
        assert s.navigate('https://example.com/')['ok'] is True
        assert s.state is SessionState.READY
        # 原语进入/返回：ready → busy → ready
        assert s.extract()['ok'] is True
        assert s.state is SessionState.READY
        # 原语失败也回 ready（click 抛 PRIMITIVE_UNSUPPORTED）
        with pytest.raises(BrowserError) as ei:
            s.click('#btn')
        assert ei.value.code is BrowserErrorCode.PRIMITIVE_UNSUPPORTED
        assert s.state is SessionState.READY
        # BUSY 重入 → SESSION_BUSY（白盒直调 _enter 模拟在途）
        s._enter(SessionState.BUSY)
        with pytest.raises(BrowserError) as ei:
            s.extract()
        assert ei.value.code is BrowserErrorCode.SESSION_BUSY
        s._enter(SessionState.READY)
        # BUSY → CLOSED 强制路径（close 在途可关）
        s._enter(SessionState.BUSY)
        assert s.close()['ok'] is True
        assert s.state is SessionState.CLOSED
        # close 幂等
        assert s.close()['ok'] is True

    def test_session_state_illegal_raises(self):
        """CLOSED 终态：任意原语 → SESSION_CLOSED。"""
        s = _DummySession()
        s.navigate('https://example.com/')
        s.close()
        for call in (lambda: s.navigate('https://x/'),
                     lambda: s.extract(),
                     lambda: s.click('b'),
                     lambda: s.fill('#i', 'v'),
                     lambda: s.screenshot()):
            with pytest.raises(BrowserError) as ei:
                call()
            assert ei.value.code is BrowserErrorCode.SESSION_CLOSED


# ============================================================ WinSession（迁移等价 + 六原语）


class TestWinSession:
    def test_win_session_migration_equivalence(self):
        """SearchBrowser 类名/模块落点（迁移映射表 §A2.6）+ WinSession 适配行为。"""
        # SearchBrowser 类名与模块路径（迁移=行为等价锚）
        assert session_win.SearchBrowser.__name__ == 'SearchBrowser'
        assert session_win.SearchBrowser.__module__ == \
            'backend.domains.integrations.browser.session_win'
        ch = _FakeChannel()
        s = session_win.WinSession(channel=ch)
        assert s.platform == 'win'
        assert s.state is SessionState.IDLE
        r = s.navigate('https://www.bing.com/search?q=x')
        assert r['ok'] is True
        assert r['title'] == '通道标题'
        assert r['url'] == 'https://www.bing.com/search?q=x'
        assert r['final_url'] == r['url']
        assert r['channel'] == 'window'
        assert ch.opened == ['https://www.bing.com/search?q=x']
        assert s.state is SessionState.READY
        # extract 三态
        md = s.extract(mode='markdown')
        assert md['ok'] is True and '正文' in md['markdown']
        assert md['truncated'] is False and md['char_count'] > 0
        tx = s.extract(mode='text')
        assert tx['ok'] is True and 'text' in tx
        lk = s.extract(mode='links')
        assert lk['ok'] is True and len(lk['links']) == 2
        assert lk['links'][0] == {'text': '链接甲',
                                  'href': 'https://example.com/a'}
        # 未知模式 → BAD_PARAMS
        with pytest.raises(BrowserError) as ei:
            s.extract(mode='html')
        assert ei.value.code is BrowserErrorCode.BAD_PARAMS
        assert s.state is SessionState.READY

    def test_win_session_click_fill_screenshot_unsupported(self):
        """M3 前 Win 渲染后端的 click/fill/screenshot → PRIMITIVE_UNSUPPORTED，
        且失败也回 READY（不残留忙态）。"""
        s = session_win.WinSession(channel=_FakeChannel())
        s.navigate('https://example.com/')
        for call in (lambda: s.click('#btn'),
                     lambda: s.fill('#kw', '关键词'),
                     lambda: s.screenshot()):
            with pytest.raises(BrowserError) as ei:
                call()
            assert ei.value.code is BrowserErrorCode.PRIMITIVE_UNSUPPORTED
            assert s.state is SessionState.READY

    def test_navigate_blocks_non_http(self):
        """file:// 等非 http(s) → NAV_BLOCKED（通道层无机会触达）。"""
        for s in (session_win.WinSession(channel=_FakeChannel()),
                  session_headless.HeadlessSession()):
            with pytest.raises(BrowserError) as ei:
                s.navigate('file:///etc/passwd')
            assert ei.value.code is BrowserErrorCode.NAV_BLOCKED
            with pytest.raises(BrowserError) as ei:
                s.navigate('javascript:alert(1)')
            assert ei.value.code is BrowserErrorCode.NAV_BLOCKED
            with pytest.raises(BrowserError) as ei:
                s.navigate('about:blank')
            assert ei.value.code is BrowserErrorCode.NAV_BLOCKED

    def test_navigate_blocks_ssrf(self):
        """内网/环回/链路本地字面 IP → SSRF_BLOCKED（hermetic：不触 DNS）。"""
        targets = ('http://127.0.0.1:8080/x', 'http://localhost/x',
                   'http://169.254.169.254/latest/meta-data',
                   'http://10.0.0.8/admin', 'http://192.168.1.1/',
                   'http://[::1]/x')
        for t in targets:
            for s in (session_win.WinSession(channel=_FakeChannel()),
                      session_headless.HeadlessSession()):
                with pytest.raises(BrowserError) as ei:
                    s.navigate(t)
                assert ei.value.code is BrowserErrorCode.SSRF_BLOCKED, t

    def test_ssrf_fakeip_benchmark_allowed(self, monkeypatch):
        """复核批修正回归：198.18.0.0/15（RFC 2544 基准段 = Clash/Surge
        fake-ip 标准地址池）按公网放行；真实私网/元数据照拦。"""
        from backend.domains.integrations.browser.session_base import _is_public_host
        assert _is_public_host('198.18.5.5') is True          # fake-ip 字面 IP
        assert _is_public_host('198.19.255.1') is True        # /15 上半段
        assert _is_public_host('169.254.169.254') is False    # 云元数据照拦
        assert _is_public_host('10.0.0.1') is False
        assert _is_public_host('192.168.1.1') is False
        assert _is_public_host('127.0.0.1') is False
        # 解析路径：全部落 fake-ip 段的域名放行；落真实私网/元数据照拒
        import socket as _socket
        monkeypatch.setattr(_socket, 'getaddrinfo',
                            lambda h, *a, **k: [(2, 0, 0, '', ('198.18.0.7', 0))])
        assert _is_public_host('example.com') is True
        monkeypatch.setattr(_socket, 'getaddrinfo',
                            lambda h, *a, **k: [(2, 0, 0, '', ('169.254.169.254', 0))])
        assert _is_public_host('evil.example') is False
        monkeypatch.setattr(_socket, 'getaddrinfo',
                            lambda h, *a, **k: [(2, 0, 0, '', ('192.168.1.9', 0))])
        assert _is_public_host('intranet.example') is False

    def test_win_session_navigate_channel_error_maps_taxonomy(self):
        """通道层失败 → taxonomy 码映射（open_url 只回 NAV_BLOCKED，
        WinSession 预校验已先行；此处验 INTERNAL 兜底 + http_status 保留）。"""
        ch = _FakeChannel(result={'ok': False, 'error': 'ENGINE_UNREACHABLE',
                                  'http_status': 503, 'message': '目标返回 HTTP 503',
                                  'hint': '稍后重试'})
        s = session_win.WinSession(channel=ch)
        with pytest.raises(BrowserError) as ei:
            s.navigate('https://example.com/')
        assert ei.value.code is BrowserErrorCode.INTERNAL
        assert ei.value.to_payload()['error'].get('http_status') == 503
        assert s.state is SessionState.IDLE     # 失败回退进入前状态

    def test_win_session_close_idempotent_and_shuts_channel(self):
        ch = _FakeChannel()
        s = session_win.WinSession(channel=ch)
        s.navigate('https://example.com/')
        assert s.close()['ok'] is True
        assert ch.shutdown_called is True
        assert s.state is SessionState.CLOSED
        assert s.close()['ok'] is True        # 幂等（不再触发 shutdown）
        assert ch.shutdown_called is True

    def test_win_session_no_open_url_method(self):
        """裁决 §A3.3：WinSession 不实现 open_url（鸭子类型只依赖通道）。"""
        s = session_win.WinSession(channel=_FakeChannel())
        assert not hasattr(s, 'open_url')


# ============================================================ HeadlessSession


class TestHeadlessSession:
    def test_headless_navigate_and_extract(self, monkeypatch):
        """urllib 通道导航（fake 响应零网络）+ markdown/text/links 三态。"""
        html = _fx('bing_results.html')
        seen = {}

        def _fake_urlopen(req, timeout=None):
            seen['url'] = req.full_url
            seen['timeout'] = timeout
            return _FakeResp(html)

        monkeypatch.setattr(session_headless, 'urlopen_follow_redirect_safe',
                            _fake_urlopen)
        # hermetic：域名解析放行（SSRF 路径由字面 IP 用例覆盖）
        monkeypatch.setattr(session_headless, '_is_public_host',
                            lambda host: True)
        s = session_headless.HeadlessSession()
        r = s.navigate('https://www.bing.com/search?q=test', timeout=30)
        assert r['ok'] is True
        assert r['channel'] == 'headless'
        assert r['url'] == 'https://www.bing.com/search?q=test'
        assert seen['url'] == 'https://www.bing.com/search?q=test'
        assert seen['timeout'] == 30
        assert s.state is SessionState.READY
        # markdown/text 档（bing fixture 有 b_caption p 摘要段）
        md = s.extract(mode='markdown')
        assert md['ok'] is True and md['markdown']
        assert md['truncated'] is False
        # links 档（fixture 含 http(s) 结果锚点）
        lk = s.extract(mode='links')
        assert lk['ok'] is True and lk['links']
        # 正文上限截断（DEFAULT_MAX_CHARS=8000）
        ex = session_base.build_extract_result(html, max_chars=10)
        assert ex['truncated'] is True and len(ex['markdown']) == 10

    def test_headless_click_unsupported(self, monkeypatch):
        """无头后端 click → PRIMITIVE_UNSUPPORTED（需先到 READY——
        状态机守卫优先：idle 下调原语先拒 SESSION_BUSY）。"""
        monkeypatch.setattr(session_headless, 'urlopen_follow_redirect_safe',
                            lambda req, timeout=None: _FakeResp('<html>x</html>'))
        monkeypatch.setattr(session_headless, '_is_public_host',
                            lambda host: True)
        s = session_headless.HeadlessSession()
        s.navigate('https://example.com/')
        with pytest.raises(BrowserError) as ei:
            s.click('#btn')
        assert ei.value.code is BrowserErrorCode.PRIMITIVE_UNSUPPORTED
        assert s.state is SessionState.READY      # 失败也回 ready

    def test_headless_extract_before_navigate_empty(self):
        """未导航即 extract → EXTRACT_EMPTY（idle 下 _enter(BUSY) 先拒）。"""
        s = session_headless.HeadlessSession()
        with pytest.raises(BrowserError) as ei:
            s.extract()
        assert ei.value.code is BrowserErrorCode.SESSION_BUSY

    def test_headless_timeout_maps_taxonomy(self, monkeypatch):
        """抓取超时 → TIMEOUT（照搬 search_browser 映射口径）。"""
        import urllib.error

        def _raise_timeout(req, timeout=None):
            raise urllib.error.URLError(socket_timeout())

        monkeypatch.setattr(session_headless, 'urlopen_follow_redirect_safe',
                            _raise_timeout)
        monkeypatch.setattr(session_headless, '_is_public_host',
                            lambda host: True)
        s = session_headless.HeadlessSession()
        with pytest.raises(BrowserError) as ei:
            s.navigate('https://example.com/')
        assert ei.value.code is BrowserErrorCode.TIMEOUT
        assert s.state is SessionState.IDLE

    def test_headless_close_idempotent(self):
        s = session_headless.HeadlessSession()
        assert s.close()['ok'] is True
        assert s.close()['ok'] is True


def socket_timeout():
    """当前平台 socket 超时异常类（ hermetic 替身用）。"""
    import socket
    return socket.timeout('timed out')


# ============================================================ 平台服务（Windows 适配）


class TestPlatformServices:
    def test_platform_factory_win(self):
        svcs = get_platform_services('win')
        assert svcs.name == 'win'
        assert svcs.secrets() is svcs.secrets()      # 实例复用
        for accessor in ('secrets', 'sandbox', 'screen', 'trash', 'paths',
                         'process', 'notify'):
            assert getattr(svcs, accessor)() is not None, accessor

    def test_platform_factory_non_win_raises(self):
        # v1.9.0 M6 转正更新：mac 已交付理论实现（MacPlatformServices）——
        # 工厂不再对 mac 抛 UNSUPPORTED；headless/linux 仍拒
        from backend.domains.integrations.browser.platform.mac import MacPlatformServices
        assert isinstance(get_platform_services('mac'), MacPlatformServices)
        for p in ('headless', 'linux'):
            with pytest.raises(BrowserError) as ei:
                get_platform_services(p)
            assert ei.value.code is BrowserErrorCode.UNSUPPORTED_PLATFORM

    def test_platform_win_paths(self):
        from backend import paths
        p = win_mod.PathsWin()
        assert p.config_dir() == paths.CONFIG_DIR
        assert p.data_dir() == paths.CONFIG_DIR
        assert p.profiles_dir() == paths.BROWSER_PROFILE_DIR   # T01 常量

    def test_platform_win_secrets_roundtrip(self):
        """DPAPI 加解密往返 + 落盘格式 + delete 幂等。"""
        from backend.domains.integrations.mcp import mcp_dpapi
        if not mcp_dpapi.is_available():
            pytest.skip('DPAPI 不可用（非 Windows 或 crypt32 缺失）')
        svc = win_mod.SecretsWin()
        assert svc.set('mcp', 'acc-1', 's3cret-值')['ok'] is True
        g = svc.get('mcp', 'acc-1')
        assert g['ok'] is True and g['secret'] == 's3cret-值'
        # 落盘格式：键 '<svc>|<acct>'，值 enc + updated_at（config.json 零污染）
        with io.open(os.path.join(paths_platform_dir(), 'secrets.json'),
                     encoding='utf-8') as f:
            data = json.load(f)
        entry = data['mcp|acc-1']
        assert entry['enc'].startswith('dpapi:') and entry['updated_at']
        # 未命中 → NOT_FOUND
        miss = svc.get('mcp', 'nope')
        assert miss['ok'] is False and miss['error'] == 'NOT_FOUND'
        # delete 幂等
        d1 = svc.delete('mcp', 'acc-1')
        assert d1['ok'] is True and d1['removed'] is True
        d2 = svc.delete('mcp', 'acc-1')
        assert d2['ok'] is True and d2['removed'] is False

    def test_platform_win_secrets_unavailable_fail_closed(self, monkeypatch):
        """DPAPI 不可用 → 写路径 fail-closed（禁明文落敏感值）。"""
        monkeypatch.setattr(win_mod, 'dpapi_available', lambda: False)
        svc = win_mod.SecretsWin()
        r = svc.set('svc', 'acc', 'plain')
        assert r['ok'] is False and r['error'] == 'SECRETS_UNAVAILABLE'

    def test_platform_win_trash_fallback(self, monkeypatch):
        """send2trash 缺失 → 永久删除 + mode='delete' + warning（醒目）。"""
        monkeypatch.setitem(sys.modules, 'send2trash', None)
        svc = win_mod.TrashWin()
        p = os.path.join(HOME, 'trash_me.txt')
        with io.open(p, 'w', encoding='utf-8') as f:
            f.write('x')
        r = svc.trash(p)
        assert r['ok'] is True and r['mode'] == 'delete'
        assert 'warning' in r and '不可恢复' in r['warning']
        assert not os.path.exists(p)
        # 不存在路径 → NOT_FOUND（不抛）
        r2 = svc.trash(p)
        assert r2['ok'] is False and r2['error'] == 'NOT_FOUND'
        # 空路径 → BAD_PARAMS
        assert svc.trash('')['error'] == 'BAD_PARAMS'

    def test_platform_win_trash_recycle(self, monkeypatch):
        """注入假 send2trash → mode='recycle'（同 file_service 口径）。"""
        fake = types.ModuleType('send2trash')
        seen = []
        fake.send2trash = lambda path: seen.append(path)
        monkeypatch.setitem(sys.modules, 'send2trash', fake)
        svc = win_mod.TrashWin()
        p = os.path.join(HOME, 'recycle_me.txt')
        with io.open(p, 'w', encoding='utf-8') as f:
            f.write('x')
        r = svc.trash(p)
        assert r['ok'] is True and r['mode'] == 'recycle'
        assert seen == [p]
        assert os.path.exists(p)      # 假库不动磁盘

    def test_platform_notify_never_raises(self, monkeypatch):
        """成功/失败两路均结构化返回；禁异常穿透（B8.9）。"""
        svc = win_mod.NotifyWin()
        monkeypatch.setattr(
            win_mod.subprocess, 'run',
            lambda *a, **kw: subprocess.CompletedProcess(a, 0, stdout=b'',
                                                         stderr=b''))
        assert svc.notify('标题', '内容') == {'ok': True}

        def _boom(*a, **kw):
            raise OSError('powershell 不可用')

        monkeypatch.setattr(win_mod.subprocess, 'run', _boom)
        r = svc.notify('标题', '内容')
        assert r['ok'] is False and r['error'] == 'NOTIFY_UNAVAILABLE'


def paths_platform_dir():
    """paths.PLATFORM_DIR（T01 常量；secrets.json 落点）。"""
    from backend import paths
    return paths.PLATFORM_DIR


# ============================================================ 迁移回归（搜索五方法）


class TestSearchMigrationRegression:
    """T02 铁律：迁移=行为等价——SearchService 自 browser.service 导入，
    既有五方法经新路径全绿（fixture 即契约）。"""

    def _mk_service(self, html):
        from backend.domains.integrations.browser.service import SearchService
        from backend.domains.security.guard_service import GuardService
        from backend.domains.workspace.toolcache_service import ToolcacheService
        return SearchService(
            browser=_FxBrowser(html),
            toolcache=ToolcacheService(do_cleanup=False),
            guard=GuardService(),
            cache_dir=os.path.join(HOME, '.glm-chat', 'search_cache'),
            clock=_FakeClock())

    def test_browser_search_live_and_cache(self):
        svc = self._mk_service(_fx('bing_results.html'))
        r = svc.browser_search({'query': 'python'})
        assert r['ok'] is True and r['source'] == 'live'
        assert r['results'] and r['cached'] is False
        # 同键二次请求 → 缓存命中（source='cache'，fetched_at 为原抓取时间）
        r2 = svc.browser_search({'query': 'python'})
        assert r2['ok'] is True and r2['source'] == 'cache'
        assert r2['cached'] is True and r2['fetched_at'] == r['fetched_at']

    def test_browser_open_extract(self):
        svc = self._mk_service(_fx('article_page.html'))
        o = svc.browser_open({'url': 'https://example.com/article'})
        assert o['ok'] is True
        assert o['content'] and o['title']
        assert o['extractor'] in ('readability', 'selector')
        # 非 http(s) → NAV_BLOCKED
        bad = svc.browser_open({'url': 'file:///etc/passwd'})
        assert bad['ok'] is False and bad['error']['code'] == 'NAV_BLOCKED'

    def test_search_status_and_cache_stats(self):
        svc = self._mk_service(_fx('bing_results.html'))
        svc.browser_search({'query': 'python'})
        st = svc.search_status()
        assert st['ok'] is True and st['active'] is False
        stats = svc.search_cache_stats()
        assert stats['ok'] is True and stats['entries'] >= 1
        assert stats['ttl_minutes'] == 60   # R30：30→60（分级 TTL general 档）

    def test_browser_takeover_not_found(self):
        """takeover 注册表随迁移保留：未知 id → TAKEOVER_NOT_FOUND。"""
        svc = self._mk_service(_fx('bing_results.html'))
        r = svc.browser_takeover('tk_nonexistent', 'continue')
        assert r['ok'] is False and r['error']['code'] == 'TAKEOVER_NOT_FOUND'
        r2 = svc.browser_takeover('', 'continue')
        assert r2['ok'] is False and r2['error']['code'] == 'BAD_PARAMS'


class TestApiImportPaths:
    def test_api_import_paths_updated(self, fresh_home):
        """Api 容器走 browser.service；旧 search_service 路径已删干净。"""
        import importlib.util

        import backend.api as api_mod
        from backend.domains.integrations.browser import service as browser_service
        api = api_mod.Api()
        assert api._search.__class__ is browser_service.SearchService
        # 旧模块路径不可导入（四文件删除的镜像断言）
        assert importlib.util.find_spec('backend.services.search_service') \
            is None
        assert importlib.util.find_spec('backend.services.search_browser') \
            is None

    def test_api_assembly_and_get_api_info(self, fresh_home):
        """Api 装配后 _search 为 browser.service.SearchService；五方法在册。

        口径（契约）：browser_* 五方法属 _V12_EXTRA——对 get_api_info 自省面
        **隐身**（get_api_info 与 legacy 逐字节一致由 test_api_contract 差分
        负责），此处只验在册 + Api 实例可调。
        """
        from backend.api import Api, _V12_EXTRA
        from backend.domains.integrations.browser.service import SearchService
        api = Api()
        assert type(api._search) is SearchService
        for m in ('browser_search', 'browser_open', 'search_cache_stats',
                  'search_status', 'browser_takeover'):
            assert m in _V12_EXTRA, m
            assert callable(getattr(api, m)), m
