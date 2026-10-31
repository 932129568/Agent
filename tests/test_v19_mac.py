# -*- coding: utf-8 -*-
"""v1.9.0 M4+M6 · macOS 侧理论实现验收测试（Windows 全测——Mock 先行纪律）。

锁定（master-plan §165/§186 + §396「macOS 专属包在 Windows 开发机上以
Mock/headless 验证，真机项集中 M9」）：
- session_mac：mac_backend_available 探测（非 macOS False）/ create_session
  工厂降级 / MacSession 六原语全链路（fake WebView 注入——派发/等待/提取/
  截图/可见化与 WinSession 语义对齐，G7 三端一致性的代码基础）；
- platform/mac：SBPL 生成器（deny default/网络三档/strict 最小/白名单
  归一）/ 七接口结构化降级（非 macOS available=False + 禁抛）/ PathsMac
  目录口径 / get_platform_services('mac') 工厂；
- api.get_platform_info 转正（os/services 就绪度/browser_backend mac 标注）。

铁律：全部 hermetic（fake/monkeypatch 零真机零框架）。
"""
import json
import os
import sys
import types

import pytest

from conftest import fresh_home  # noqa: F401  （autouse 隔离 HOME）

from backend.domains.integrations.browser import session_base, session_win
from backend.domains.integrations.browser.session_base import BrowserError, BrowserErrorCode


@pytest.fixture(autouse=True)
def _bypass_sandbox_dns_hijack(monkeypatch):
    """沙箱 DNS 劫持处置（test_v19_browser/test_v19_driver 同款；SSRF 字面
    IP 语义由既有专测锁定，此处只测 mac 会话逻辑）。"""
    monkeypatch.setattr(session_base, '_is_public_host', lambda host: True)
    monkeypatch.setattr(session_win, '_is_public_host', lambda host: True)
    from backend.domains.integrations.browser import session_mac
    monkeypatch.setattr(session_mac, '_is_public_host', lambda host: True)

PAGE_HTML = ('<html><head><title>mac 测试页</title></head><body><main>'
             + ('Harbor v1.9 mac 理论实现测试正文。' * 40)
             + '</main></body></html>')


class FakeMacWebView:
    """WKWebView 鸭子 fake（load_url/eval_js/capture_b64/set_visible/destroy）。

    js_results 预置首个 = navigate 的 outerHTML 读取返回（页面 HTML）——
    后续 click/fill 的 JS 结果由各测试显式追加。"""

    def __init__(self, html=PAGE_HTML):
        self.html = html
        self.loaded = []
        self.js_results = [html]     # 首个 = navigate outerHTML
        self.js_calls = []
        self.captures = 0
        self.vis_calls = []
        self.destroyed = False

    def load_url(self, url):
        self.loaded.append(url)
        return {'ok': True}

    def eval_js(self, code, timeout=6):
        self.js_calls.append(code)
        return self.js_results.pop(0) if self.js_results else None

    def capture_b64(self):
        self.captures += 1
        return 'ZmFrZS1wbmc='

    def set_visible(self, visible):
        self.vis_calls.append(bool(visible))
        return True

    def destroy(self):
        self.destroyed = True

    @property
    def viewport(self):
        return (1024, 768)


# ============================================================ session_mac

class TestMacSession:

    def _session(self, html=PAGE_HTML):
        from backend.domains.integrations.browser.session_mac import MacSession
        wv = FakeMacWebView(html)
        return MacSession(webview=wv), wv

    def test_mac_backend_available_false_off_macos(self):
        """非 macOS 环境（本机 Windows）：PyObjC 不可达 → False（降级闸）。"""
        from backend.domains.integrations.browser.session_mac import mac_backend_available
        if sys.platform.startswith('win'):
            assert mac_backend_available() is False

    def test_create_session_mac_unsupported_without_pyobjc(self):
        """Windows：工厂结构化降级 UNSUPPORTED_PLATFORM（禁抛裸异常）。"""
        from backend.domains.integrations.browser import create_session
        if sys.platform.startswith('win'):
            with pytest.raises(BrowserError) as ei:
                create_session('mac')
            assert ei.value.code is BrowserErrorCode.UNSUPPORTED_PLATFORM
            assert 'PyObjC' in ei.value.message or 'M9.5' in ei.value.message

    def test_create_session_mac_with_fake_runtimes(self, monkeypatch):
        """注入 fake PyObjC 模块 → 探测 True → 工厂返回 MacSession
        （理论支持：真机装 pywebview[cocoa] 即此路径）。"""
        from backend.domains.integrations.browser import create_session
        from backend.domains.integrations.browser import session_mac
        for mod in ('objc', 'WebKit', 'AppKit', 'Foundation'):
            monkeypatch.setitem(sys.modules, mod, types.ModuleType(mod))
        assert session_mac.mac_backend_available() is True
        s = create_session('mac')
        assert s.platform == 'mac'

    def test_navigate_extract_roundtrip(self):
        s, wv = self._session()
        r = s.navigate('https://example.com', timeout=5)
        assert r['ok'] is True and r['channel'] == 'mac-webview'
        assert r['title'] == 'mac 测试页'
        assert wv.loaded == ['https://example.com']
        out = s.extract(mode='text')
        assert out['ok'] is True and out.get('text')
    def test_navigate_wait_selector(self):
        """M4.5 等待原语：wait_selector 命中（'1'）即通过。"""
        s, wv = self._session()
        wv.js_results = ['1', PAGE_HTML]   # wait 探测 1 → outerHTML
        r = s.navigate('https://example.com', wait_selector='#main', timeout=5)
        assert r['ok'] is True
        assert any('querySelector' in c for c in wv.js_calls)

    def test_navigate_wait_selector_timeout(self):
        """wait_selector 轮询不命中（'0'）→ 超时 TIMEOUT。"""
        s, wv = self._session()
        wv.js_results = ['0'] * 200
        with pytest.raises(BrowserError) as ei:
            s.navigate('https://example.com', wait_selector='#never',
                       timeout=1)
        assert ei.value.code is BrowserErrorCode.TIMEOUT

    def test_navigate_ssrf_blocked(self, monkeypatch):
        from backend.domains.integrations.browser import session_mac as sm
        monkeypatch.setattr(sm, '_is_public_host', lambda host: False)
        s, _ = self._session()
        with pytest.raises(BrowserError) as ei:
            s.navigate('http://127.0.0.1/x')
        assert ei.value.code is BrowserErrorCode.SSRF_BLOCKED

    def test_click_fill_same_js_semantics_as_win(self):
        """M4.8：click/fill 与 Win 同款 JS（G7 一致性——注入防御/视口外拒点
        /敏感字段拒填的 JS 由 session_win 纯函数共享生成）。"""
        from backend.domains.integrations.browser.session_win import (build_click_js,
                                                          build_fill_js)
        s, wv = self._session()
        s.navigate('https://example.com')
        wv.js_results = ['{"ok":true,"how":"selector"}']
        r = s.click('#go')
        assert r['ok'] is True and r['how'] == 'selector'
        assert build_click_js('#go') in wv.js_calls or \
            any('getBoundingClientRect' in c for c in wv.js_calls)
        wv.js_results = ['{"ok":true}']
        r2 = s.fill('#q', '机密')
        assert r2 == {'ok': True, 'masked': True}
        assert any(build_fill_js('#q', '机密') == c for c in wv.js_calls)

    def test_click_sensitive_rejected(self):
        s, wv = self._session()
        s.navigate('https://example.com')
        wv.js_results = ['{"error":"sensitive_field"}']
        with pytest.raises(BrowserError) as ei:
            s.click('#pw')
        assert ei.value.code is BrowserErrorCode.BAD_PARAMS

    def test_screenshot(self):
        s, wv = self._session()
        s.navigate('https://example.com')
        r = s.screenshot()
        assert r['ok'] is True and r['b64'] == 'ZmFrZS1wbmc='
        assert (r['width'], r['height']) == (1024, 768)

    def test_set_visible_and_close(self):
        s, wv = self._session()
        s.navigate('https://example.com')
        assert s.set_visible(True) is True
        assert wv.vis_calls == [True]
        assert s.close() == {'ok': True}
        assert wv.destroyed is True
        assert s.close() == {'ok': True}    # 幂等

    def test_navigate_js_dead_degrades(self):
        """eval_js 返回 None（不可泵送）→ 结构化 INTERNAL（禁挂死）。"""
        s, wv = self._session()
        wv.js_results = []
        with pytest.raises(BrowserError) as ei:
            s.navigate('https://example.com')
        assert ei.value.code is BrowserErrorCode.INTERNAL


# ============================================================ SBPL 生成器（纯函数）

class TestSbpl:

    def test_deny_default_header(self):
        from backend.domains.integrations.browser.platform.mac import build_sbpl
        out = build_sbpl()
        assert out.startswith('(version 1)\n(deny default)')

    def test_network_three_modes(self):
        from backend.domains.integrations.browser.platform.mac import build_sbpl
        assert '(allow network*)' in build_sbpl(network='full')
        assert '127.0.0.1' in build_sbpl(network='loopback')
        none = build_sbpl(network='none')
        assert 'network*' not in none and '127.0.0.1' not in none

    def test_strict_minimal_and_workspace_write(self):
        from backend.domains.integrations.browser.platform.mac import build_sbpl
        strict = build_sbpl(profile='strict', workspace='/Users/x/ws')
        assert 'file-write' not in strict          # strict 无默认写
        std = build_sbpl(profile='standard', workspace='/Users/x/ws')
        assert '(allow file-write* (subpath "/Users/x/ws"))' in std

    def test_subpath_quote_sanitized(self):
        """白名单路径含引号 → 剥离（SBPL 字面量注入防御）。"""
        from backend.domains.integrations.browser.platform.mac import build_sbpl
        out = build_sbpl(workspace='/tmp/ws"x')
        assert '"' not in out.replace(
            '(subpath "', '').replace('")', '')
        assert 'wsx' in out

    def test_extra_paths_whitelisted(self):
        from backend.domains.integrations.browser.platform.mac import build_sbpl
        out = build_sbpl(workspace='/ws', extra_read=['/etc/ssl'],
                         extra_write=['/tmp/out'])
        assert '(allow file-read* (subpath "/etc/ssl"))' in out
        assert '(allow file-write* (subpath "/tmp/out"))' in out


# ============================================================ platform/mac 七接口

class TestMacPlatformServices:

    def test_factory_returns_mac_seven(self):
        from backend.domains.integrations.browser.platform import get_platform_services
        from backend.domains.integrations.browser.platform.mac import MacPlatformServices
        ps = get_platform_services('mac')
        assert isinstance(ps, MacPlatformServices)
        for name in ('secrets', 'sandbox', 'screen', 'trash',
                     'paths', 'process', 'notify'):
            assert getattr(ps, name)() is not None, name

    def test_secrets_unavailable_off_macos(self):
        """非 macOS：Security.framework 不可加载 → 结构化降级（禁抛）。"""
        from backend.domains.integrations.browser.platform.mac import SecretsMac
        if not sys.platform.startswith('win'):
            pytest.skip('macOS 真机走真框架路径（M9.4）')
        s = SecretsMac()
        assert s.set('svc', 'acct', 'v') == {
            'ok': False, 'error': 'SECRETS_UNAVAILABLE',
            'message': 'Security.framework 不可用（非 macOS 环境）'}
        assert s.get('svc', 'acct')['error'] == 'SECRETS_UNAVAILABLE'
        assert s.delete('svc', 'acct')['error'] == 'SECRETS_UNAVAILABLE'

    def test_sandbox_unavailable_off_macos(self):
        from backend.domains.integrations.browser.platform.mac import SandboxMac
        if not sys.platform.startswith('win'):
            pytest.skip('macOS 真机 sandbox-exec 路径（M9.4）')
        sb = SandboxMac()
        assert sb.available() is False
        r = sb.run(['echo', 'x'])
        assert r['ok'] is False and r['error'] == 'SANDBOX_UNAVAILABLE'

    def test_sandbox_limits_for_mapping(self):
        from backend.domains.integrations.browser.platform.mac import SandboxMac
        sb = SandboxMac(workspace='/ws')
        assert sb.limits_for('dangerous')['profile'] == 'strict'
        assert sb.limits_for('normal')['profile'] == 'standard'
        assert sb.limits_for('x')['network'] == 'none'

    def test_paths_mac_dir_semantics(self):
        from backend.domains.integrations.browser.platform.mac import PathsMac
        d = PathsMac.config_dir()
        # 归一斜杠后断言（Windows ntpath 下 expanduser 产生混合分隔符）
        assert d.replace('\\', '/').endswith(
            'Library/Application Support/Harbor')
        assert PathsMac.data_dir() == d
        assert d != os.path.expanduser('~/.glm-chat')  # 与 Win 口径不互通

    def test_trash_unavailable_off_macos(self, tmp_path):
        from backend.domains.integrations.browser.platform.mac import TrashMac
        if not sys.platform.startswith('win'):
            pytest.skip('macOS 真机 NSFileManager 路径（M9.4）')
        f = tmp_path / 'x.txt'
        f.write_text('x', encoding='utf-8')
        r = TrashMac().trash(str(f))
        assert r['ok'] is False and r['error'] == 'TRASH_UNAVAILABLE'
        assert f.exists()      # 未被误删

    def test_trash_bad_params(self):
        from backend.domains.integrations.browser.platform.mac import TrashMac
        r = TrashMac().trash('/nonexistent/path/x')
        assert r['ok'] is False and r['error'] == 'BAD_PARAMS'

    def test_notify_never_raises(self):
        from backend.domains.integrations.browser.platform.mac import NotifyMac
        r = NotifyMac().notify('标题', '内容')
        assert isinstance(r, dict) and 'ok' in r     # 真机 True / 非 mac False

    def test_process_list_degrades(self):
        from backend.domains.integrations.browser.platform.mac import ProcessMac
        rows = ProcessMac().list()          # Windows 上 /bin/ps 不存在 → []
        assert isinstance(rows, list)
        r = ProcessMac().kill()
        assert r['ok'] is False and r['error'] == 'BAD_PARAMS'
        assert ProcessMac().resolve_name(999999) is None or isinstance(
            ProcessMac().resolve_name(999999), str)


# ============================================================ api.get_platform_info 转正

class TestGetPlatformInfo:

    def test_platform_info_shape(self):
        from backend.api import Api
        api = Api()
        r = json.loads(api.get_platform_info())
        assert r['ok'] is True
        assert r['os'] in ('win', 'mac', 'headless')
        assert 'machine' in r and 'python' in r
        assert set(r['services']) >= {'secrets', 'sandbox', 'screen', 'trash',
                                      'paths', 'process', 'notify'}
        bb = r['browser_backend']
        assert bb['platform'] == r['os']
        assert bb['win'] is True and 'mac' in bb

    def test_platform_info_stealth(self):
        from backend.api import _V12_EXTRA
        assert 'get_platform_info' in _V12_EXTRA

    def test_platform_services_win_default(self):
        """Windows 默认工厂仍为 win（零回归）。"""
        from backend.domains.integrations.browser.platform import get_platform_services
        from backend.domains.integrations.browser.platform.win import WinPlatformServices
        if sys.platform.startswith('win'):
            assert isinstance(get_platform_services(), WinPlatformServices)

    def test_driver_factory_mac_branch_degrades(self, monkeypatch, tmp_path):
        """BrowserService 工厂 mac 分支：PyObjC 缺失 → 结构化降级
        （navigate 收口为 UNSUPPORTED_PLATFORM 载荷，禁穿透 js_api）。"""
        import backend.domains.integrations.browser as browser_pkg
        from backend.domains.integrations.browser.driver import BrowserService
        monkeypatch.setattr(browser_pkg, 'detect_platform',
                            lambda: 'mac')
        svc = BrowserService(path=str(tmp_path / 'bs.json'))
        try:
            if sys.platform.startswith('win'):
                r = svc.navigate('https://example.com', timeout=1)
                assert r['ok'] is False
                assert r['error']['code'] == 'UNSUPPORTED_PLATFORM'
        finally:
            svc.shutdown()


# ============================================================ M8.1 预热 / set_mode api

class TestPreheatAndSetMode:

    def _mk(self, tmp_path):
        from backend.domains.integrations.browser.driver import BrowserService
        calls = []

        def factory(mode):
            calls.append(mode)
            ch = FakeMacWebView()
            from backend.domains.integrations.browser.session_win import WinSession
            return WinSession(channel=ch), ch

        svc = BrowserService(session_factory=factory, path=str(tmp_path / 'bs.json'))
        return svc, calls

    def test_preheat_creates_hidden_session(self, tmp_path):
        """M8.1 会话池预热：hidden 工厂调用 + 打点毫秒 + 入池不夺游标。"""
        svc, calls = self._mk(tmp_path)
        try:
            r = svc.preheat()
            assert r['ok'] is True and r['warm'] is True
            assert calls == ['hidden']
            assert isinstance(r['preheat_ms'], int)
            assert len(svc.sessions()['sessions']) == 1
        finally:
            svc.shutdown()

    def test_preheat_factory_failure_structured(self, tmp_path, monkeypatch):
        from backend.domains.integrations.browser.driver import BrowserService

        def bad_factory(mode):
            raise RuntimeError('no GUI')
        svc = BrowserService(session_factory=bad_factory,
                             path=str(tmp_path / 'bs.json'))
        try:
            r = svc.preheat()
            assert r['ok'] is False and r['warm'] is False
        finally:
            svc.shutdown()

    def test_set_mode_via_session_fallback(self, tmp_path):
        """set_mode 的 mac 侧路径：window=None 时回落 session.set_visible
        （理论实现 MacSession.set_visible）。"""
        from backend.domains.integrations.browser.session_mac import MacSession
        from backend.domains.integrations.browser.driver import BrowserService
        wv = FakeMacWebView()
        made = []

        def factory(mode):
            s = MacSession(webview=wv)
            made.append(s)
            return s, None        # mac 分支 window=None
        svc = BrowserService(session_factory=factory,
                             path=str(tmp_path / 'bs.json'))
        try:
            r = svc.navigate('https://example.com', timeout=5)
            assert r['ok'] is True
            out = svc.set_mode('visible')
            assert out['ok'] is True and out['applied'] is True
            assert wv.vis_calls == [True]
            # 投影同步
            assert svc.sessions()['sessions'][0]['mode'] == 'visible'
        finally:
            svc.shutdown()

    def test_browser_set_mode_api_registered(self):
        from backend.api import _V12_EXTRA
        assert 'browser_set_mode' in _V12_EXTRA
        assert 'browser_sessions' in _V12_EXTRA

    def test_browser_set_mode_api_no_session(self):
        from backend.api import Api
        r = json.loads(Api().browser_set_mode('visible'))
        assert r['ok'] is False and r['error']['code'] == 'BAD_PARAMS'
