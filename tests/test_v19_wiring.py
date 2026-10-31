# -*- coding: utf-8 -*-
"""v1.9.0 M2.1/M2.2/M2.9/M2.11 接线回归（批 2c，design §A3.8/§A3.4/§A3.10）。

覆盖：RSS 主路径接线（bing 先 RSS/HTML 兜底零改/429 结构化/验证码 RSS hint）、
provenance 三接入点（搜索 _assemble tag / browser_open reader+tag / 软件
_call_cli tag）、search_cache_stats ttl_classes 分布、reader 与 stats 实例共享。
"""
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from conftest import fresh_home  # noqa: E402

FX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'v18')


def _fx(name):
    return io.open(os.path.join(FX, name), encoding='utf-8').read()


class _FakeBrowser:
    """既有 FakeBrowser 口径（open_url 返回 HTML；用于 HTML 兜底断言）。"""

    def __init__(self, html, channel='urllib'):
        self.calls = []
        self._html = html
        self._channel = channel

    def open_url(self, url):
        self.calls.append(url)
        return {'ok': True, 'html': self._html, 'channel': self._channel}


def _mk_service(html, tmpdir, **kw):
    from backend.domains.integrations.browser.service import SearchService
    return SearchService(browser=_FakeBrowser(html),
                         cache_dir=os.path.join(str(tmpdir), 'cache'),
                         **kw)


class TestRssMainPath:
    def test_bing_rss_used_first(self, tmp_path, monkeypatch):
        """bing：RSS 非空 → 采用（channel='rss'，不触 HTML 抓取）。"""
        svc = _mk_service(_fx('bing_dual.html'), tmp_path)
        rss_xml = _fx('bing_rss.xml')
        monkeypatch.setattr(svc, '_fetch_rss',
                            lambda url: {'results': _parse(rss_xml)})
        r = svc.browser_search({'query': 'Harbor 本地模型'})
        assert r['ok'] and r['channel'] == 'rss'
        assert r['source'] == 'live'
        assert len(svc._browser.calls) == 0        # HTML 通道零调用
        assert r['results'][0]['title']

    def test_rss_empty_falls_back_html(self, tmp_path, monkeypatch):
        """RSS 空 → 静默回落 HTML 兜底（既有路径零改）。"""
        svc = _mk_service(_fx('bing_dual.html'), tmp_path)
        monkeypatch.setattr(svc, '_fetch_rss', lambda url: {})
        r = svc.browser_search({'query': 'Harbor 本地模型'})
        assert r['ok'] and r['channel'] == 'urllib'   # HTML 兜底通道
        assert len(svc._browser.calls) == 1

    def test_rss_429_fatal(self, tmp_path, monkeypatch):
        """RSS 429 → ENGINE_UNREACHABLE（http_status 透传 + RSS 通道 hint）。"""
        svc = _mk_service(_fx('bing_dual.html'), tmp_path)
        monkeypatch.setattr(svc, '_fetch_rss', lambda url: {
            'fatal': True, 'code': 'ENGINE_UNREACHABLE',
            'message': 'Bing RSS 通道限流（HTTP 429）',
            'hint': 'RSS 通道限流，可稍后重试或切换引擎（HTML 通道同受限）'})
        r = svc.browser_search({'query': 'x'})
        assert not r['ok'] and r['error']['code'] == 'ENGINE_UNREACHABLE'
        assert 'RSS' in r['error']['hint']

    def test_rss_captcha_hint(self, tmp_path, monkeypatch):
        """RSS 检出验证特征 → CAPTCHA_REQUIRED + RSS 通道 hint + takeover_id。"""
        svc = _mk_service(_fx('bing_dual.html'), tmp_path)
        monkeypatch.setattr(svc, '_fetch_rss',
                            lambda url: {'captcha': 'captcha-page'})
        r = svc.browser_search({'query': 'x'})
        assert r['error']['code'] == 'CAPTCHA_REQUIRED'
        assert 'RSS 通道检出验证特征' in r['error']['hint']
        assert r['error'].get('takeover_id')

    def test_non_bing_no_rss(self, tmp_path):
        """非 bing 引擎不走 RSS（HTML 路径零改）。"""
        svc = _mk_service(_fx('ddg_results.html'), tmp_path)
        r = svc.browser_search({'query': 'python', 'engine': 'duckduckgo'})
        assert r['ok']
        assert len(svc._browser.calls) == 1


class TestProvenanceWiring:
    def test_search_payload_tagged(self, tmp_path):
        svc = _mk_service(_fx('bing_results.html'), tmp_path)
        r = svc.browser_search({'query': 'python'})
        assert r['untrusted'] is True
        assert r['source'] == 'live'              # 契约 source 键零改动
        prov = r['provenance']                    # provenance 摘要独立键
        assert prov['engine'] == 'bing'
        assert 'query' not in prov                # 禁原文 query 进载荷键
        assert len(prov['query_sha256']) == 16    # sha256 前 16 位
        assert prov['fetched_at']

    def test_browser_open_reader_and_tag(self, tmp_path, monkeypatch):
        """browser_open：reader 未配置 → raw 模式 + digest=None + provenance tag。"""
        import backend.domains.integrations.browser.service as _svc_mod
        monkeypatch.setattr(_svc_mod, '_is_public_host', lambda h: True)
        svc = _mk_service(_fx('bing_results.html'), tmp_path)
        r = svc.browser_open({'url': 'https://example.com/page'})
        assert r['ok']
        assert r['reader_mode'] == 'raw'          # 未配置 reader 降级
        assert r['digest'] is None
        assert r['untrusted'] is True
        assert r['source']['url'] == 'https://example.com/page'

    def test_software_payload_tagged(self, fresh_home):
        from backend.domains.integrations.software_service import SoftwareService
        from backend.domains.security.guard_service import GuardService
        from backend.domains.workspace.cmd_service import CmdService
        from backend.domains.workspace.sandbox_service import SandboxService
        svc = SoftwareService(guard=GuardService(), sandbox=SandboxService())
        # 直接测 _call_cli 的 tag（runner 注入假执行器）
        svc._runner = lambda argv, cwd, timeout, limits: {
            'stdout': 'hello', 'stderr': '', 'returncode': 0, 'sandboxed': False}
        entry = {'name': 'fake', 'kind': 'cli', 'exe': 'fake',
                 'actions': [{'name': 'run', 'args': []}]}
        payload = svc._call_cli(entry, {'name': 'run', 'args': []}, {},
                                False, 5, 'low', 'panel')
        assert payload['ok']
        assert payload['untrusted'] is True
        assert payload['source'] == {'software': 'fake', 'action': 'run'}

    def test_sanitize_applied_to_stdout(self, fresh_home):
        from backend.domains.integrations.software_service import SoftwareService, sanitize_text
        from backend.domains.security.guard_service import GuardService
        from backend.domains.workspace.sandbox_service import SandboxService
        svc = SoftwareService(guard=GuardService(), sandbox=SandboxService())
        svc._runner = lambda argv, cwd, timeout, limits: {
            'stdout': '\x1b[31m红色\u200e输出\x00', 'stderr': '',
            'returncode': 0, 'sandboxed': False}
        entry = {'name': 'fake', 'kind': 'cli', 'exe': 'fake',
                 'actions': [{'name': 'run', 'args': []}]}
        payload = svc._call_cli(entry, {'name': 'run', 'args': []}, {},
                                False, 5, 'low', 'panel')
        assert payload['stdout'] == '红色输出'


class TestStatsTtlClasses:
    def test_ttl_classes_distribution(self, tmp_path):
        svc = _mk_service(_fx('bing_results.html'), tmp_path)
        # 写三类条目
        svc._cache_put('k_news', {'query': '今天的新闻', 'results': [],
                                  'fetched_ts': svc._clock()},
                       ttl_class='news', ttl_minutes=5)
        svc._cache_put('k_gen', {'query': 'python 教程', 'results': [],
                                 'fetched_ts': svc._clock()},
                       ttl_class='general', ttl_minutes=60)
        svc._cache_put('k_enc', {'query': '量子是什么', 'results': [],
                                 'fetched_ts': svc._clock()},
                       ttl_class='encyclopedia', ttl_minutes=1440)
        st = svc.search_cache_stats()
        assert st['ttl_classes'] == {'news': 1, 'general': 1,
                                     'encyclopedia': 1}
        assert st['entries'] == 3

    def test_legacy_entry_counts_general(self, tmp_path):
        svc = _mk_service(_fx('bing_results.html'), tmp_path)
        svc._cache_put('k_old', {'query': 'q', 'results': [],
                                 'fetched_ts': svc._clock()})   # 无分类
        st = svc.search_cache_stats()
        assert st['ttl_classes']['general'] == 1


class TestReaderSharing:
    def test_api_shares_reader(self, fresh_home):
        from backend.api import Api
        api = Api()
        assert api._search._reader is api._reader    # 计数口径一致

    def test_stats_reflects_open_reader_calls(self, fresh_home, monkeypatch):
        import backend.domains.integrations.browser.service as _svc_mod
        monkeypatch.setattr(_svc_mod, '_is_public_host', lambda h: True)
        """browser_open 走 reader 后，search_reader_stats 的 reader_calls 增长。"""
        from backend.api import Api
        from backend.domains.integrations.browser.service import SearchService
        api = Api()
        before = json.loads(api.search_reader_stats())['reader_calls']
        # 直接调 SearchService.browser_open（经 FakeBrowser 不可注入——
        # 用 monkeypatch 方式在实例上换通道）
        from backend.domains.providers.search_reader import SearchReader

        class _StubBrowser:
            def open_url(self, url):
                return {'ok': True, 'html': '<html><body><article>'
                        + '正文内容' * 50 + '</article></body></html>',
                        'channel': 'urllib'}
        api._search._browser = _StubBrowser()
        r = api._search.browser_open({'url': 'https://example.com/x'})
        assert r['ok'] and r['reader_mode'] == 'raw'
        after = json.loads(api.search_reader_stats())['reader_calls']
        assert after == before + 1


def _parse(xml):
    from backend.domains.integrations.browser.adapters import parse_rss
    return parse_rss(xml)
