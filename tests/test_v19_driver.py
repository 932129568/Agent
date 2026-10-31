# -*- coding: utf-8 -*-
"""v1.9.0 M3+M5 驱动管线验收测试（master-plan §149/§181）。

锁定：
- WinSession click/fill/screenshot 真实现（fake 通道注入：evaluate_js 返回
  预置 JSON，零窗口零网络）+ 视口外/不可见拒点 + 敏感字段拒填（M3.9）；
- JS 构建纯函数注入防御（M3.9 注入 fixture 雏形：target/selector/text 里的
  JS 注入载荷经 json.dumps 编码，零执行）；
- Bridge 提取桥（on_extract 收集/容量上限/畸形不炸；open_external 非公网拒；
  download_blocked 记录）（M3.5/M3.6）；
- BrowserService 会话池（上限驱逐/游标语义/投影文件/空闲回收/模式切换）（M3.7/3.8）；
- guard 档位矩阵（M5.2：click/fill=always；其余 session）；
- tools_schema 六原语 strict（additionalProperties:false + enum + required）
  + R11 端点过滤 + 三段式描述 lint（M5.1/5.3/5.9）。

铁律：全部 hermetic（fake 通道/monkeypatch；沙箱 DNS 劫持绕过 fixture
同 test_v19_browser——SSRF 字面 IP 语义由既有专测锁定，此处不重复）。
"""
import json
import os
import sys
import threading
import time

import pytest

from conftest import fresh_home  # noqa: F401  （autouse 隔离 HOME）

from backend.application.native_ui import NativeUiDispatcher
from backend.domains.integrations.browser import session_base, session_win
from backend.domains.integrations.browser.session_base import BrowserError, BrowserErrorCode
from backend.domains.integrations.browser.session_win import (
    WinSession, build_click_js, build_fill_js, build_wait_js, map_js_result)


@pytest.fixture(autouse=True)
def _bypass_sandbox_dns_hijack(monkeypatch):
    """沙箱 DNS 劫持处置（test_v19_browser 同款；SSRF 语义由字面 IP 专测锁定）。"""
    monkeypatch.setattr(session_base, '_is_public_host', lambda host: True)
    if hasattr(session_win, '_is_public_host'):
        monkeypatch.setattr(session_win, '_is_public_host', lambda host: True)


PAGE_HTML = ('<html><head><title>测试页</title></head><body><main>'
             + ('Harbor v1.9 驱动测试正文。' * 40)
             + '</main></body></html>')


class FakeDriverChannel:
    """驱动次窗 fake：open_url/eval_js/capture_b64/set_visible 全可控。"""

    supports_wait = True

    def __init__(self, html=PAGE_HTML):
        self.html = html
        self.js_results = []          # eval_js 依次弹出
        self.js_calls = []
        self.captures = 0
        self.urls = []
        self.visible_calls = []
        self.shutdown_called = False

    def open_url(self, url, wait_selector='', timeout=60):
        self.urls.append((url, wait_selector))
        return {'ok': True, 'html': self.html, 'channel': 'driver-window'}

    def eval_js(self, code, timeout=5):
        self.js_calls.append(code)
        return self.js_results.pop(0) if self.js_results else None

    def capture_b64(self):
        self.captures += 1
        return 'ZmFrZS1wbmc='

    def set_visible(self, visible):
        self.visible_calls.append(bool(visible))
        return True

    def shutdown(self):
        self.shutdown_called = True

    @property
    def viewport(self):
        return (1024, 768)


# ============================================================ JS 构建纯函数

class TestJSBuilders:

    def test_click_js_injection_defense(self):
        """M3.9 注入 fixture：target 里的 JS 注入载荷只成为字符串字面量。

        毒参数 x"); alert(1); (" 若未编码即拼接，脚本语义被改写（弹窗/外呼）；
        json.dumps 编码后引号转义，payload 以惰性文本存在——零执行。"""
        poison = 'x"); alert(1); ("'
        js = build_click_js(poison)
        # 编码后的字面量（含转义引号）在脚本里出现；裸注入序列不存在
        assert json.dumps(poison, ensure_ascii=False) in js
        assert '"); alert(1); ("' not in js.replace(
            json.dumps(poison, ensure_ascii=False), '')
        # 脚本完整性：IIFE 闭合（json.loads 解析能力之外的语法由编码保证）
        assert js.startswith('(function(){') and js.endswith('})()')

    def test_fill_js_injection_defense(self):
        poison_sel = 'input"); evil(); ("'
        poison_text = 'hi"); more_evil(); ("'
        js = build_fill_js(poison_sel, poison_text)
        assert json.dumps(poison_sel, ensure_ascii=False) in js
        assert json.dumps(poison_text, ensure_ascii=False) in js
        assert '"); evil(); ("' not in js.replace(
            json.dumps(poison_sel, ensure_ascii=False), '').replace(
            json.dumps(poison_text, ensure_ascii=False), '')

    def test_click_js_viewport_and_visibility_checks(self):
        """M3.9：视口外拒点 + 不可见拒点的检查逻辑在页面 JS 内。"""
        js = build_click_js('#go')
        assert 'out_of_viewport' in js
        assert 'not_visible' in js
        assert 'getComputedStyle' in js
        assert 'getBoundingClientRect' in js

    def test_fill_js_sensitive_field_checks(self):
        """M3.9：敏感字段（password/file）拒绝填充 + native setter。"""
        js = build_fill_js('#pw', 'secret')
        assert 'sensitive_field' in js
        assert 'password' in js and 'file' in js
        assert 'getOwnPropertyDescriptor' in js     # React 受控组件 native setter

    def test_wait_js_shapes(self):
        assert build_wait_js('#main').startswith('(function(){try{')
        assert '"#main"' in build_wait_js('#main')

    def test_map_js_result(self):
        assert map_js_result(None) == {'error': 'js_unavailable'}
        assert map_js_result('') == {'error': 'js_unavailable'}
        assert map_js_result('garbage') == {'error': 'js_unavailable'}
        assert map_js_result('{"ok":true}') == {'ok': True}
        assert map_js_result('[1,2]') == {'error': 'js_unavailable'}


# ============================================================ WinSession 六原语

class TestWinSessionPrimitives:

    def _session(self, html=PAGE_HTML):
        ch = FakeDriverChannel(html)
        return WinSession(channel=ch), ch

    def test_navigate_wait_selector_passthrough(self):
        s, ch = self._session()
        r = s.navigate('https://example.com', wait_selector='#main', timeout=30)
        assert r['ok'] is True and r['channel'] == 'driver-window'
        assert ch.urls == [('https://example.com', '#main')]

    def test_click_ok_with_audit_shots(self):
        s, ch = self._session()
        s.navigate('https://example.com')
        ch.js_results = ['{"ok":true,"how":"selector"}']
        r = s.click('#next')
        assert r['ok'] is True
        assert r['before_b64'] == 'ZmFrZS1wbmc='    # 前后态截图审计（M3.2）
        assert r['after_b64'] == 'ZmFrZS1wbmc='
        assert r['how'] == 'selector'
        assert ch.captures == 2

    def test_click_by_text_uses_xpath(self):
        s, ch = self._session()
        s.navigate('https://example.com')
        ch.js_results = ['{"ok":true,"how":"text"}']
        assert s.click('下一页')['how'] == 'text'
        assert 'normalize-space' in ch.js_calls[0]

    def test_click_not_found(self):
        s, ch = self._session()
        s.navigate('https://example.com')
        ch.js_results = ['{"error":"not_found"}']
        with pytest.raises(BrowserError) as ei:
            s.click('#missing')
        assert ei.value.code is BrowserErrorCode.BAD_PARAMS

    @pytest.mark.parametrize('js_err', ['not_visible', 'out_of_viewport'])
    def test_click_rejects_invisible_or_offscreen(self, js_err):
        """M3.9：不可见 / 视口外元素拒点（BAD_PARAMS 结构化）。"""
        s, ch = self._session()
        s.navigate('https://example.com')
        ch.js_results = ['{"error":"%s"}' % js_err]
        with pytest.raises(BrowserError) as ei:
            s.click('#x')
        assert ei.value.code is BrowserErrorCode.BAD_PARAMS
        assert js_err in (ei.value.message + str(ei.value.hint)) or \
            ei.value.hint or ei.value.message

    def test_click_empty_target(self):
        s, _ = self._session()
        s.navigate('https://example.com')
        with pytest.raises(BrowserError) as ei:
            s.click('')
        assert ei.value.code is BrowserErrorCode.BAD_PARAMS

    def test_fill_ok_masked(self):
        s, ch = self._session()
        s.navigate('https://example.com')
        ch.js_results = ['{"ok":true}']
        r = s.fill('#q', '机密内容')
        assert r == {'ok': True, 'masked': True}     # 契约：禁回显原文

    def test_fill_sensitive_password_rejected(self):
        s, ch = self._session()
        s.navigate('https://example.com')
        ch.js_results = ['{"error":"sensitive_field"}']
        with pytest.raises(BrowserError) as ei:
            s.fill('#pw', 'secret')
        assert ei.value.code is BrowserErrorCode.BAD_PARAMS

    def test_screenshot_ok(self):
        s, ch = self._session()
        s.navigate('https://example.com')
        r = s.screenshot()
        assert r['ok'] is True and r['b64'] == 'ZmFrZS1wbmc='
        assert (r['width'], r['height']) == (1024, 768)

    def test_screenshot_capture_empty_fails_structured(self):
        s, ch = self._session()
        s.navigate('https://example.com')

        def _empty():
            return ''
        ch.capture_b64 = _empty
        with pytest.raises(BrowserError) as ei:
            s.screenshot()
        assert ei.value.code is BrowserErrorCode.INTERNAL

    def test_primitives_unsupported_on_search_channel(self):
        """open_url-only 通道（SearchBrowser 语义，无 eval_js/capture_b64）→
        PRIMITIVE_UNSUPPORTED（M1.5 迁移期行为保持；驱动原语需 DriverWindow
        通道）。离线 fake 通道（禁真实网络——SearchBrowser 真身会走 urllib）。"""

        class _PlainChannel:
            def open_url(self, url, **kw):
                return {'ok': True, 'html': PAGE_HTML, 'channel': 'urllib'}

            def shutdown(self):
                pass

        s = WinSession(channel=_PlainChannel())
        s.navigate('https://example.com')
        for fn in (lambda: s.click('#x'),
                   lambda: s.fill('#x', 't'),
                   lambda: s.screenshot()):
            with pytest.raises(BrowserError) as ei:
                fn()
            assert ei.value.code is BrowserErrorCode.PRIMITIVE_UNSUPPORTED

    def test_click_channel_eval_dead_degrades(self):
        """通道有 eval_js 但派发死（None）→ js_unavailable 降级（不挂死）。"""
        s, ch = self._session()
        s.navigate('https://example.com')
        ch.js_results = []       # eval_js 返回 None
        with pytest.raises(BrowserError) as ei:
            s.click('#x')
        assert ei.value.code is BrowserErrorCode.INTERNAL


# ============================================================ Bridge 提取桥

class TestBridge:

    def _bridge(self):
        from backend.domains.integrations.browser.driver import Bridge
        return Bridge()

    def test_on_extract_collects_and_pops(self):
        b = self._bridge()
        assert b.on_extract('{"title":"t"}') == 'ok'
        assert b.extracts() == [{'title': 't'}]
        assert b.pop_extracts() == [{'title': 't'}]
        assert b.extracts() == []

    def test_on_extract_malformed_never_raises(self):
        b = self._bridge()
        assert b.on_extract('not json') == 'ok'
        assert b.on_extract('[1,2]') == 'ok'
        assert b.on_extract(None) == 'ok'
        assert b.extracts() == []

    def test_on_extract_capacity_cap(self):
        b = self._bridge()
        for i in range(80):
            b.on_extract('{"i":%d}' % i)
        assert len(b.extracts()) == 64      # 毒网页灌垃圾防 OOM

    def test_open_external_public_ok(self):
        """公网 URL → 外联回调被调（系统浏览器打开 + 审计钩子）。"""
        from backend.domains.integrations.browser.driver import Bridge
        seen = []
        b = Bridge(on_external=seen.append)
        assert b.open_external('https://example.com/page') == 'ok'
        assert seen == ['https://example.com/page']

    def test_open_external_blocks_private_and_schemes(self, monkeypatch):
        """毒网页伪造 open_external 调用：内网/环回/非 http(s) 一律拒
        （SSRF 同口径——本测显式恢复私网判定语义，覆盖 autouse 绕过）。"""
        from backend.domains.integrations.browser.driver import Bridge
        from backend.domains.integrations.browser import session_base as sb
        seen = []
        b = Bridge(on_external=seen.append)
        monkeypatch.setattr(sb, '_is_public_host',
                            lambda host: not str(host or '').startswith(
                                ('127.', '192.168.', '10.', '169.254.')))
        for url in ('http://127.0.0.1/x', 'http://192.168.1.1/x',
                    'http://10.0.0.1/x', 'http://169.254.169.254/latest/meta-data',
                    'javascript:alert(1)', 'file:///C:/x', 'data:text/html,x'):
            assert b.open_external(url) == 'ok'
        assert seen == []       # 非公网/非 http(s) 全拒（无系统浏览器打开）

    def test_download_blocked_records(self):
        from backend.domains.integrations.browser.driver import Bridge
        seen = []
        b = Bridge(on_blocked=seen.append)
        assert b.download_blocked('https://evil/x.exe') == 'ok'
        assert seen == ['https://evil/x.exe']
        assert b.blocked() == ['https://evil/x.exe']


# ============================================================ BrowserService 会话池

def _mk_service(pool_limit=3, idle_seconds=60.0, sweep_tick=5.0, path=None):
    from backend.domains.integrations.browser.driver import BrowserService
    made = []

    def factory(mode):
        ch = FakeDriverChannel()
        made.append((mode, ch))
        return WinSession(channel=ch), ch

    svc = BrowserService(session_factory=factory, pool_limit=pool_limit,
                         idle_seconds=idle_seconds, path=path,
                         sweep_tick=sweep_tick)
    return svc, made


class TestBrowserService:

    def test_navigate_creates_cursor_session(self, tmp_path):
        svc, made = _mk_service(path=str(tmp_path / 'bs.json'))
        try:
            r = svc.navigate('https://example.com', wait_selector='#m')
            assert r['ok'] is True and r['session_id']
            # 无 id 原语作用于游标会话
            r2 = svc.extract(mode='text')
            assert r2['ok'] is True and r2.get('text')
            assert made and made[0][0] == 'hidden'      # 默认隐藏驱动
        finally:
            svc.shutdown()

    def test_navigate_visible_mode(self, tmp_path):
        svc, made = _mk_service(path=str(tmp_path / 'bs.json'))
        try:
            r = svc.navigate('https://example.com', mode='visible')
            assert r['ok'] is True and r['mode'] == 'visible'
            assert made[0][0] == 'visible'
        finally:
            svc.shutdown()

    def test_pool_limit_evicts_oldest(self, tmp_path):
        svc, _ = _mk_service(pool_limit=2, path=str(tmp_path / 'bs.json'))
        try:
            r1 = svc.navigate('https://a.example.com')
            svc.navigate('https://b.example.com')
            r3 = svc.navigate('https://c.example.com')
            ids = [s['id'] for s in svc.sessions()['sessions']]
            assert len(ids) == 2
            assert r1['session_id'] not in ids       # 最旧被驱逐
            assert r3['session_id'] in ids
            # 游标 = 最新导航
            assert svc.extract()['ok'] is True
        finally:
            svc.shutdown()

    def test_close_specific_then_all(self, tmp_path):
        svc, _ = _mk_service(path=str(tmp_path / 'bs.json'))
        try:
            r1 = svc.navigate('https://a.example.com')
            svc.navigate('https://b.example.com')
            r = svc.close(r1['session_id'])
            assert r == {'ok': True, 'closed': [r1['session_id']]}
            # 关掉的会话再操作 → BAD_PARAMS（游标回退到剩余最近会话）
            r2 = svc.extract()
            assert r2['ok'] is True
            r3 = svc.close('')
            assert r3['ok'] is True and len(r3['closed']) == 1
            assert svc.extract()['ok'] is False      # 无会话
        finally:
            svc.shutdown()

    def test_projection_file_shape(self, tmp_path):
        """browser_sessions.json 投影（master-plan §6.1 形状，M3.7）。"""
        p = tmp_path / 'bs.json'
        svc, _ = _mk_service(path=str(p))
        try:
            svc.navigate('https://example.com/p1')
            data = json.loads(p.read_text(encoding='utf-8'))
            assert data['version'] == 1
            s = data['sessions'][0]
            assert set(s) >= {'id', 'mode', 'created', 'last_url', 'state'}
            assert s['last_url'] == 'https://example.com/p1'
            assert s['mode'] == 'hidden'
        finally:
            svc.shutdown()

    def test_no_session_structured_bad_params(self, tmp_path):
        svc, _ = _mk_service(path=str(tmp_path / 'bs.json'))
        try:
            r = svc.click('#x')
            assert r['ok'] is False
            assert r['error']['code'] == 'BAD_PARAMS'
        finally:
            svc.shutdown()

    def test_extract_guarded_captcha(self, tmp_path):
        """M5.7 反爬检测：验证码特征页 → CAPTCHA_REQUIRED 结构化（禁裸失败）。"""
        svc, _ = _mk_service(path=str(tmp_path / 'bs.json'))
        try:
            svc._sessions  # noqa
            r = svc.navigate('https://example.com')
            sid = r['session_id']
            # 注入验证码页 HTML（页面 title/body 命中 _captcha_signal 特征）
            svc._sessions[sid]['session']._html = \
                '<html><head><title>请完成安全验证</title></head><body>验证码</body></html>'
            out = svc.extract_guarded(mode='text')
            assert out['ok'] is False
            assert out['error']['code'] == 'CAPTCHA_REQUIRED'
        finally:
            svc.shutdown()

    def test_extract_guarded_clean_passthrough(self, tmp_path):
        svc, _ = _mk_service(path=str(tmp_path / 'bs.json'))
        try:
            svc.navigate('https://example.com')
            out = svc.extract_guarded(mode='text')
            assert out['ok'] is True
        finally:
            svc.shutdown()

    def test_set_mode_visible(self, tmp_path):
        svc, made = _mk_service(path=str(tmp_path / 'bs.json'))
        try:
            svc.navigate('https://example.com')
            r = svc.set_mode('visible')
            assert r['ok'] is True and r['applied'] is True
            assert made[0][1].visible_calls == [True]
        finally:
            svc.shutdown()

    def test_idle_recycle_sweeps(self, tmp_path):
        """空闲回收（M3.7）：idle_seconds 到期自动 close + 投影清空。"""
        p = tmp_path / 'bs.json'
        svc, _ = _mk_service(idle_seconds=0.05, sweep_tick=0.05, path=str(p))
        try:
            svc.navigate('https://example.com')
            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline:
                if not svc.sessions()['sessions']:
                    break
                time.sleep(0.05)
            assert svc.sessions()['sessions'] == []
            assert json.loads(p.read_text(encoding='utf-8'))['sessions'] == []
        finally:
            svc.shutdown()


# ============================================================ api 层转正 + guard 矩阵

class TestApiBrowserPrimitives:

    def _api(self):
        from backend.api import Api
        return Api()

    def test_six_registered_stealth_and_promoted(self):
        from backend.api import _V12_EXTRA
        for m in ('browser_navigate', 'browser_extract', 'browser_click',
                  'browser_fill', 'browser_screenshot', 'browser_close',
                  'browser_sessions'):
            assert m in _V12_EXTRA, m

    def test_guard_tiers_matrix(self):
        """M5.2 档位矩阵：click/fill=always；navigate/extract/screenshot/close=session。"""
        from backend.domains.security.guard_service import DEFAULT_TIERS
        assert DEFAULT_TIERS['browser_click'] == 'always'
        assert DEFAULT_TIERS['browser_fill'] == 'always'
        for op in ('browser_navigate', 'browser_extract',
                   'browser_screenshot', 'browser_close'):
            assert DEFAULT_TIERS[op] == 'session', op

    def test_extract_without_session_structured(self):
        """未导航直接 extract → 结构化 BAD_PARAMS（禁异常穿透 js_api）。"""
        api = self._api()
        r = json.loads(api.browser_extract())
        assert r['ok'] is False
        assert r['error']['code'] == 'BAD_PARAMS'

    def test_close_idempotent_ok(self):
        api = self._api()
        r = json.loads(api.browser_close())
        assert r['ok'] is True

    def test_sessions_view_shape(self):
        api = self._api()
        r = json.loads(api.browser_sessions())
        assert r['ok'] is True and r['version'] == 1

    def test_navigate_ssrf_blocked_literal_ip(self, monkeypatch):
        """SSRF 字面 IP 拦截（不触 DNS；域名绕过 fixture 不影响本测）。"""
        api = self._api()
        monkeypatch.setattr(session_win, '_is_public_host', lambda host: False)
        r = json.loads(api.browser_navigate('http://127.0.0.1/x', timeout=1))
        assert r['ok'] is False
        assert r['error']['code'] in ('SSRF_BLOCKED', 'NAV_BLOCKED')

    def test_armed_click_requires_token(self):
        """武装后 always 档强制 confirm token（S4① 同款语义）。"""
        api = self._api()
        api._guard.arm()
        r = json.loads(api.browser_click('#x'))
        assert r['ok'] is False
        assert 'error' in r

    def test_armed_close_requires_token_and_binds_session(self):
        """会话关闭同样属于 session 档：不得绕过 API 直接回收；
        token 还必须绑定创建时确认的目标 session_id。"""
        api = self._api()
        api._guard.arm()
        called = []
        orig = api._driver.close
        api._driver.close = lambda sid='': called.append(sid) or {'ok': True, 'closed': [sid]}
        try:
            missing = json.loads(api.browser_close('bs_target'))
            assert missing['ok'] is False
            assert missing['error']['code'] == 'CONFIRM_REQUIRED'
            assert called == []
            token = api._guard.issue_confirm_token(
                'browser_close', {'session_id': 'bs_target'})['token']
            allowed = json.loads(api.browser_close('bs_target', token=token))
            assert allowed['ok'] is True and called == ['bs_target']
            called.clear()
            replay = json.loads(api.browser_close('bs_target', token=token))
            assert replay['ok'] is False and called == []
        finally:
            api._driver.close = orig


# ============================================================ tools_schema strict（M5）

class TestToolsSchemaStrict:

    def test_agent_tools_has_six_driver_tools(self):
        from backend.tools_schema import AGENT_TOOLS
        names = {t['function']['name'] for t in AGENT_TOOLS}
        for n in ('browser_navigate', 'browser_extract', 'browser_click',
                  'browser_fill', 'browser_screenshot', 'browser_close'):
            assert n in names, n

    def test_strict_schema(self):
        """M5.3：additionalProperties:false + enum + required。"""
        from backend.tools_schema import AGENT_TOOLS
        by_name = {t['function']['name']: t['function']['parameters']
                   for t in AGENT_TOOLS}
        for n in ('browser_navigate', 'browser_extract', 'browser_click',
                  'browser_fill', 'browser_screenshot', 'browser_close'):
            p = by_name[n]
            assert p.get('additionalProperties') is False, n
        assert by_name['browser_extract']['properties']['mode']['enum'] == \
            ['markdown', 'text', 'links']
        assert by_name['browser_navigate']['required'] == ['url']
        assert by_name['browser_fill']['required'] == ['selector', 'text']
        assert by_name['browser_click']['required'] == ['target']

    def test_default_path_excludes_driver(self):
        """include_agent=False 默认路径零变化（契约红线）。"""
        out = json.loads(__import__('backend.tools_schema', fromlist=['build'])
                         .build())
        names = {t['function']['name'] for t in out}
        assert 'browser_navigate' not in names
        assert 'browser_click' not in names

    def test_glm_endpoint_filters_driver(self):
        """R11：GLM 端点 browser_* 全过滤（含新六原语）。"""
        from backend.tools_schema import build
        out = json.loads(build(include_agent=True, is_glm_endpoint=True))
        names = {t['function']['name'] for t in out}
        assert not any(n.startswith('browser_') for n in names), names
        assert 'software_call' in names

    def test_non_glm_includes_driver(self):
        from backend.tools_schema import build
        out = json.loads(build(include_agent=True, is_glm_endpoint=False))
        names = {t['function']['name'] for t in out}
        assert 'browser_navigate' in names and 'browser_click' in names

    def test_three_part_description_lint(self):
        """M5.9：三段式描述 lint（触发|语义|排除——恰 2 个竖线）。
        范围= v1.9 新工具（v1.8 既有工具文案契约锁定不改）。"""
        from backend.tools_schema import AGENT_TOOLS
        v19_names = {'browser_navigate', 'browser_extract', 'browser_click',
                     'browser_fill', 'browser_screenshot', 'browser_close'}
        for t in AGENT_TOOLS:
            name = t['function']['name']
            if name in v19_names:
                assert t['function']['description'].count('|') == 2, name


# ============================================================ 复核批次回归（2026-10-24 bug 扫描：12 项实证修复）

class _FakeLoadedEvent:
    """pywebview events.loaded 最小 fake（+=/-= 订阅 + fire 触发）。"""

    def __init__(self):
        self.handlers = []

    def __iadd__(self, fn):
        self.handlers.append(fn)
        return self

    def __isub__(self, fn):
        if fn in self.handlers:
            self.handlers.remove(fn)
        return self

    def fire(self):
        for h in list(self.handlers):
            h()


class _FakeDriverWin:
    """最小 pywebview 窗口 fake：events / load_url / url / evaluate_js。

    final_url：模拟 302 重定向（load_url 落地的最终地址≠请求地址）。"""

    def __init__(self, final_url=None):
        self.events = type('_E', (), {'loaded': _FakeLoadedEvent()})()
        self.url = 'file:///C:/harbor.html'      # 窗口初始页（harbor.html）
        self.final_url = final_url
        self.load_fail = False
        self.eval_calls = []
        self.eval_value = '<html>ok</html>'

    def load_url(self, u):
        if self.load_fail:
            raise RuntimeError('load failed')
        self.url = self.final_url or u
        self.events.loaded.fire()

    def evaluate_js(self, code):
        self.eval_calls.append(code)
        return self.eval_value


class TestReviewBatchRegression:
    """2026-10-24 全库 bug 扫描复核批：12 项实证修复的回归锁定。"""

    # ---- P1-1：open_url 终态 URL 复检（重定向 SSRF 缺口） ----
    def test_open_url_redirect_to_private_blocked(self, monkeypatch, tmp_path):
        from backend.domains.integrations.browser import driver as drv
        dw = drv.DriverWindow(user_data_dir=str(tmp_path / 'p'),
                              dispatcher=NativeUiDispatcher.inline())
        win = _FakeDriverWin(final_url='http://169.254.169.254/latest/meta-data')
        dw._win = win
        dw._dispatcher.register(win, 'driver-test')
        monkeypatch.setattr(drv, '_is_public_host',
                            lambda host: not str(host or '').startswith(
                                ('127.', '192.168.', '10.', '169.254.')))
        r = dw.open_url('http://public.example.com/', timeout=2)
        assert r['ok'] is False and r['error'] == 'SSRF_BLOCKED', r

    def test_open_url_public_final_ok(self, monkeypatch, tmp_path):
        from backend.domains.integrations.browser import driver as drv
        dw = drv.DriverWindow(user_data_dir=str(tmp_path / 'p'),
                              dispatcher=NativeUiDispatcher.inline())
        dw._win = _FakeDriverWin(final_url='https://public.example.com/x')
        dw._dispatcher.register(dw._win, 'driver-test')
        monkeypatch.setattr(drv, '_is_public_host', lambda host: True)
        r = dw.open_url('http://public.example.com/', timeout=2)
        assert r['ok'] is True and r['channel'] == 'driver-window'

    def test_open_url_initial_page_event_no_false_block(self, monkeypatch, tmp_path):
        """loaded 是窗口初始页事件的竞态：win.url 仍 file:// 时短暂等待真实
        导航落定——不误判 SSRF，最终以 http(s) 终态放行。"""
        from backend.domains.integrations.browser import driver as drv
        import threading as _th
        dw = drv.DriverWindow(user_data_dir=str(tmp_path / 'p'),
                              dispatcher=NativeUiDispatcher.inline())
        win = _FakeDriverWin()
        dw._win = win
        dw._dispatcher.register(win, 'driver-test')
        monkeypatch.setattr(drv, '_is_public_host', lambda host: True)

        orig_load = win.load_url

        def slow_load(u):
            orig_load(u)          # loaded 事件先行（win.url 仍是初始 file:// 页）
            _th.Timer(0.3, lambda: setattr(win, 'url', u)).start()

        win.load_url = slow_load
        r = dw.open_url('https://public.example.com/', timeout=3)
        assert r['ok'] is True, r

    # ---- P2-5：load_url 抛异常时 loaded 处理器退订（原泄漏） ----
    def test_open_url_load_fail_unsubscribes(self, tmp_path):
        from backend.domains.integrations.browser import driver as drv
        dw = drv.DriverWindow(user_data_dir=str(tmp_path / 'p'),
                              dispatcher=NativeUiDispatcher.inline())
        win = _FakeDriverWin()
        win.load_fail = True
        dw._win = win
        dw._dispatcher.register(win, 'driver-test')
        r = dw.open_url('https://example.com/', timeout=2)
        assert r['ok'] is False and r['error'] == 'WINDOW_UNAVAILABLE'
        assert win.events.loaded.handlers == []      # 已退订（原实现泄漏 1 个/次）

    # ---- P2-4：策略 JS 每次导航后重注入（页内二次导航不再失效） ----
    def test_install_policy_reinjects(self, tmp_path):
        from backend.domains.integrations.browser import driver as drv
        dw = drv.DriverWindow(user_data_dir=str(tmp_path / 'p'),
                              dispatcher=NativeUiDispatcher.inline())
        win = _FakeDriverWin()
        win.eval_value = 'ok'
        dw._win = win
        dw._dispatcher.register(win, 'driver-test')
        dw._install_policy(win)
        dw._install_policy(win)
        assert len(win.eval_calls) == 2              # 原永久标记只注入 1 次

    # ---- P2-12：Bridge 提取载荷三重上限（条数/单条/累计） ----
    def test_on_extract_item_size_cap(self):
        from backend.domains.integrations.browser.driver import Bridge
        b = Bridge()
        big = '{"x":"' + 'a' * (256 * 1024) + '"}'
        assert b.on_extract(big) == 'ok'
        assert b.extracts() == []                    # 超单条上限丢弃

    def test_on_extract_total_size_cap(self):
        from backend.domains.integrations.browser.driver import Bridge
        b = Bridge()
        item = '{"pad":"%s"}' % ('a' * 250_000)      # ~250KB/条 < 单条上限
        for _ in range(20):                          # 累计 5MB > 4MB 上限
            b.on_extract(item)
        n = len(b.extracts())
        assert 15 <= n <= 17, n                      # 累计封顶后拒绝新条目
        assert n * len(item) <= 4 * 1024 * 1024

    # ---- P1-3：busy 闸（sweeper/驱逐不回收在飞会话；死 id 不回填） ----
    def test_sweeper_skips_busy_session(self, tmp_path):
        from backend.domains.integrations.browser.driver import BrowserService
        from backend.domains.integrations.browser.session_base import SessionState
        release = threading.Event()

        class SlowSession:
            def __init__(self):
                self.closed = False

            @property
            def state(self):
                return SessionState.IDLE

            def navigate(self, url, ws='', timeout=60):
                release.wait(5.0)
                return {'ok': True, 'title': 't', 'url': url,
                        'final_url': url, 'channel': 'fake'}

            def close(self):
                self.closed = True

        def factory(mode):
            return SlowSession(), None

        svc = BrowserService(session_factory=factory, idle_seconds=0.05,
                             sweep_tick=0.05, path=str(tmp_path / 'bs.json'))
        try:
            out = {}
            t = threading.Thread(
                target=lambda: out.update(r=svc.navigate('https://e.com')),
                daemon=True)
            t.start()
            sid = None
            for _ in range(200):
                with svc._lock:
                    if svc._sessions:
                        sid = next(iter(svc._sessions))
                        break
                time.sleep(0.01)
            assert sid, '会话未入池'
            time.sleep(0.3)                      # 让 sweeper 扫过若干轮
            with svc._lock:
                assert sid in svc._sessions      # busy 在飞：不被回收
                assert svc._sessions[sid].get('busy') is True
            release.set()
            t.join(5)
            assert out.get('r', {}).get('ok') is True
            time.sleep(0.3)                      # 导航完成空闲后正常回收
            with svc._lock:
                assert sid not in svc._sessions
        finally:
            release.set()
            svc.shutdown()

    def test_evict_skips_busy_session(self, tmp_path):
        """池满驱逐跳过 busy 条目（全部 busy 时放行本次超限）。"""
        from backend.domains.integrations.browser.driver import BrowserService
        from backend.domains.integrations.browser.session_base import SessionState
        release = threading.Event()

        class SlowSession:
            def __init__(self, block):
                self.block = block
                self.closed = False

            @property
            def state(self):
                return SessionState.IDLE

            def navigate(self, url, ws='', timeout=60):
                if self.block:
                    release.wait(5.0)
                return {'ok': True, 'title': 't', 'url': url,
                        'final_url': url, 'channel': 'fake'}

            def close(self):
                self.closed = True

        made = []

        def factory(mode):
            s = SlowSession(len(made) == 0)      # 第一个阻塞（busy），后续直通
            made.append(s)
            return s, None

        svc = BrowserService(session_factory=factory, pool_limit=1,
                             idle_seconds=60.0, sweep_tick=0.05,
                             path=str(tmp_path / 'bs.json'))
        try:
            out = {}
            t = threading.Thread(
                target=lambda: out.update(r=svc.navigate('https://e.com/1')),
                daemon=True)
            t.start()
            sid_a = None
            for _ in range(200):
                with svc._lock:
                    if svc._sessions:
                        sid_a = next(iter(svc._sessions))
                        break
                time.sleep(0.01)
            assert sid_a
            r2 = svc.navigate('https://e.com/2')     # 池满：A busy 不驱逐
            assert r2['ok'] is True
            with svc._lock:
                assert sid_a in svc._sessions        # A 未被驱逐
                assert not made[0].closed
                assert len(svc._sessions) == 2       # 放行超限
        finally:
            release.set()
            svc.shutdown()

    def test_navigate_during_close_no_dead_id_backfill(self, tmp_path):
        """导航期间会话被显式关闭 → 不回填已死 session_id（结构化错误）。"""
        from backend.domains.integrations.browser.driver import BrowserService
        from backend.domains.integrations.browser.session_base import SessionState
        release = threading.Event()

        class SlowSession:
            def __init__(self):
                self.closed = False

            @property
            def state(self):
                return SessionState.IDLE

            def navigate(self, url, ws='', timeout=60):
                release.wait(5.0)
                return {'ok': True, 'title': 't', 'url': url,
                        'final_url': url, 'channel': 'fake'}

            def close(self):
                self.closed = True

        def factory(mode):
            return SlowSession(), None

        svc = BrowserService(session_factory=factory, idle_seconds=60.0,
                             path=str(tmp_path / 'bs.json'))
        try:
            out = {}
            t = threading.Thread(
                target=lambda: out.update(r=svc.navigate('https://e.com')),
                daemon=True)
            t.start()
            sid = None
            for _ in range(200):
                with svc._lock:
                    if svc._sessions:
                        sid = next(iter(svc._sessions))
                        break
                time.sleep(0.01)
            svc.close(sid)                       # 导航在飞时显式关闭
            release.set()
            t.join(5)
            r = out.get('r') or {}
            assert r['ok'] is False
            assert r['error']['code'] == 'SESSION_CLOSED'
            assert 'session_id' not in r
        finally:
            release.set()
            svc.shutdown()

    # ---- P1-2：extract_guarded provenance 包裹（红线 4） ----
    def test_extract_guarded_provenance_tagged(self, tmp_path):
        svc, _ = _mk_service(path=str(tmp_path / 'bs.json'))
        try:
            svc.navigate('https://example.com')
            out = svc.extract_guarded(mode='text')
            assert out['ok'] is True
            assert out.get('untrusted') is True           # UNTRUSTED DATA 标记
            prov = out.get('provenance') or out.get('source') or {}
            assert prov.get('url') == 'https://example.com'
            assert prov.get('channel') == 'driver-window'
        finally:
            svc.shutdown()

    # ---- P2-8：profile 目录序号唯一 + 关闭清理 ----
    def test_close_entry_removes_profile_dir(self, tmp_path):
        from backend.domains.integrations.browser.driver import BrowserService
        d = tmp_path / 'drv_123_1'
        d.mkdir()
        (d / 'f.txt').write_text('x', encoding='utf-8')

        class _W:
            _user_data_dir = str(d)

            def close(self):
                pass

        BrowserService._close_entry({'session': None, 'window': _W()})
        assert not d.exists()                             # 本会话目录已清理
        d2 = tmp_path / 'not_drv_dir'
        d2.mkdir()

        class _W2:
            _user_data_dir = str(d2)

            def close(self):
                pass

        BrowserService._close_entry({'session': None, 'window': _W2()})
        assert d2.exists()                                # 非 drv_ 目录不清

    # ---- P2-13：会话层重复导航入口闸（无副作用拒绝） ----
    def test_navigate_twice_busy_entry_gate(self):
        s, ch = TestWinSessionPrimitives()._session()
        r = s.navigate('https://example.com')
        assert r['ok'] is True
        n_before = len(ch.urls)
        with pytest.raises(BrowserError) as ei:
            s.navigate('https://example.com/2')
        assert ei.value.code is BrowserErrorCode.SESSION_BUSY
        assert len(ch.urls) == n_before                   # 通道未被再次调用

    # ---- P2-6：browser_navigate schema 补 mode 枚举（CAPTCHA 逃生门） ----
    def test_browser_navigate_schema_mode_enum(self):
        from backend.tools_schema import AGENT_TOOLS
        by_name = {t['function']['name']: t['function']['parameters']
                   for t in AGENT_TOOLS}
        mode = by_name['browser_navigate']['properties'].get('mode')
        assert mode is not None                           # 原缺失=逃生门不可用
        assert mode['enum'] == ['hidden', 'visible']
        assert by_name['browser_navigate']['additionalProperties'] is False
