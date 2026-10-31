# -*- coding: utf-8 -*-
"""v1.9.0 M2.1/M2.2 读取器与 provenance 回归（design §A3.4）。

覆盖：read 全链（reader 成功/raw 降级/skip 路由/网络失败降级/schema 失败
计数/三级解析/response_format 剥除重试）、provenance 包裹与 payload 纯增键、
reader.json 配置校验（budget 1-60/schema_mode 枚举/max_input_chars 域）、
stats 计数、route_reader 三策略语义、js_api 转正与隐身。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from conftest import fresh_home  # noqa: E402

GOOD_DIGEST = {'title': 'Python 教程', 'summary': '一份教程',
               'key_points': ['基础', '进阶'],
               'entities': [{'name': 'Python', 'type': 'product'}],
               'published_at': ''}


def _mk_reader(home, transport=None, router=None):
    from backend.domains.providers.search_reader import SearchReader
    from backend import paths
    return SearchReader(config_path=paths.READER_FILE, router=router,
                        transport=transport)


def _cfg_dir(home, **kw):
    from backend import paths
    from backend.domains.settings.config_service import atomic_write_json
    from backend.domains.providers.search_reader import DEFAULTS
    d = dict(DEFAULTS)
    d.update(kw)
    os.makedirs(os.path.dirname(paths.READER_FILE), exist_ok=True)
    atomic_write_json(paths.READER_FILE, d)


def _ok_transport(content):
    def t(messages, body, url, timeout):
        return {'ok': True, 'content': content}
    return t


class TestReaderSuccessPath:
    def test_reader_mode_digest(self, fresh_home):
        _cfg_dir(os.environ['HOME'], base_url='http://127.0.0.1:11434/v1',
                 model='qwen2.5:7b')
        r = _mk_reader(os.environ['HOME'],
                       transport=_ok_transport(json.dumps(GOOD_DIGEST)))
        out = r.read('网页正文内容', 'https://example.com/a', 'window')
        assert out['ok'] and out['mode'] == 'reader'
        assert out['digest']['title'] == 'Python 教程'
        assert out['source'] == {'url': 'https://example.com/a',
                                 'channel': 'window'}
        assert out['reader_ms'] >= 0

    def test_reader_text_has_provenance(self, fresh_home):
        _cfg_dir(os.environ['HOME'], base_url='http://127.0.0.1:11434/v1')
        r = _mk_reader(os.environ['HOME'],
                       transport=_ok_transport(json.dumps(GOOD_DIGEST)))
        out = r.read('正文', 'https://x.com', 'rss')
        assert 'UNTRUSTED DATA' in out['text'] and 'END UNTRUSTED' in out['text']
        assert 'https://x.com' in out['text']

    def test_reader_reports_local_ok(self, fresh_home):
        from backend.domains.providers.hybrid_router import HybridRouter
        _cfg_dir(os.environ['HOME'], base_url='http://127.0.0.1:11434/v1')
        hr = HybridRouter()
        r = _mk_reader(os.environ['HOME'], transport=_ok_transport(
            json.dumps(GOOD_DIGEST)), router=hr)
        r.read('正文')
        assert hr.local_unavailable() is False       # 成功清零失败链


class TestReaderDegradePath:
    def test_unconfigured_skip_raw(self, fresh_home):
        r = _mk_reader(os.environ['HOME'])
        out = r.read('很长的网页正文' * 100, 'https://x.com', 'html')
        assert out['ok'] and out['mode'] == 'raw'
        assert '未配置' in out.get('reason', '')
        assert 'UNTRUSTED DATA' in out['text']

    def test_disabled_skip_raw(self, fresh_home):
        _cfg_dir(os.environ['HOME'], enabled=False,
                 base_url='http://127.0.0.1:11434/v1')
        r = _mk_reader(os.environ['HOME'],
                       transport=_ok_transport(json.dumps(GOOD_DIGEST)))
        assert r.read('正文')['mode'] == 'raw'

    def test_network_fail_degrade(self, fresh_home):
        _cfg_dir(os.environ['HOME'], base_url='http://127.0.0.1:1/v1')

        def boom(messages, body, url, timeout):
            raise ConnectionRefusedError('拒了')

        r = _mk_reader(os.environ['HOME'], transport=boom)
        out = r.read('正文', 'https://x.com')
        assert out['mode'] == 'raw' and '本地调用失败' in out['reason']
        assert r.stats()['degrade_count'] == 1

    def test_http_500_degrade(self, fresh_home):
        _cfg_dir(os.environ['HOME'], base_url='http://127.0.0.1:1/v1')
        r = _mk_reader(os.environ['HOME'],
                       transport=lambda m, b, u, t: {'ok': False,
                                                     'error': 'HTTP 500'})
        assert r.read('正文')['mode'] == 'raw'
        assert r.stats()['degrade_count'] == 1

    def test_schema_fail_counts(self, fresh_home):
        _cfg_dir(os.environ['HOME'], base_url='http://127.0.0.1:11434/v1')
        r = _mk_reader(os.environ['HOME'],
                       transport=_ok_transport('这不是 JSON 是散文'))
        out = r.read('正文')
        assert out['mode'] == 'raw' and 'JSON' in out['reason']
        assert r.stats()['schema_fail'] == 1

    def test_missing_fields_schema_fail(self, fresh_home):
        _cfg_dir(os.environ['HOME'], base_url='http://127.0.0.1:11434/v1')
        r = _mk_reader(os.environ['HOME'],
                       transport=_ok_transport(json.dumps({'title': '缺字段'})))
        assert r.read('正文')['mode'] == 'raw'
        assert r.stats()['schema_fail'] == 1

    def test_three_fail_streak_skips(self, fresh_home):
        """3 连败 → local_unavailable → route skip（raw）。"""
        from backend.domains.providers.hybrid_router import HybridRouter
        _cfg_dir(os.environ['HOME'], base_url='http://127.0.0.1:1/v1')
        hr = HybridRouter()
        r = _mk_reader(os.environ['HOME'],
                       transport=lambda m, b, u, t: {'ok': False,
                                                     'error': 'x'},
                       router=hr)
        for _ in range(3):
            r.read('正文')
        assert hr.local_unavailable() is True
        out = r.read('正文')
        assert out['mode'] == 'raw' and '3 连败' in out['reason']


class TestParseStrict:
    def test_three_levels(self):
        from backend.domains.providers.search_reader import SearchReader
        # ① 严格
        assert SearchReader._parse_json_strict(json.dumps(GOOD_DIGEST)) == GOOD_DIGEST
        # ② 提取块（前后有散文）
        assert SearchReader._parse_json_strict('前言废话\n%s\n后记' % json.dumps(GOOD_DIGEST)) == GOOD_DIGEST
        # ② 尾逗号修复
        assert SearchReader._parse_json_strict('{"title":"t","summary":"s","key_points":[],'
                  '"entities":[],"published_at":"",}') is not None
        # ③ 失败
        assert SearchReader._parse_json_strict('完全不是JSON') is None

    def test_entities_type_checked(self):
        from backend.domains.providers.search_reader import SearchReader
        bad = dict(GOOD_DIGEST)
        bad['entities'] = [{'name': 'x'}]        # 缺 type
        assert SearchReader._parse_json_strict(json.dumps(bad)) is None

    def test_extra_keys_kept(self):
        from backend.domains.providers.search_reader import SearchReader
        d = dict(GOOD_DIGEST)
        d['extra'] = '前向兼容保留'
        out = SearchReader._parse_json_strict(json.dumps(d))
        assert out is not None and out.get('extra') == '前向兼容保留'


class TestResponseFormatDowngrade:
    def test_400_strip_retry(self, fresh_home):
        _cfg_dir(os.environ['HOME'], base_url='http://127.0.0.1:11434/v1')
        calls = []

        def t(messages, body, url, timeout):
            calls.append(body.get('response_format'))
            if body.get('response_format'):
                return {'ok': False, 'error': 'HTTP 400: response_format not supported',
                        'status': 400}
            return {'ok': True, 'content': json.dumps(GOOD_DIGEST)}

        r = _mk_reader(os.environ['HOME'], transport=t)
        out = r.read('正文')
        assert out['mode'] == 'reader'      # 剥除重试后成功
        assert calls == [{'type': 'json_object'}, None]   # 带→剥除


class TestReaderConfig:
    def test_defaults(self, fresh_home):
        from backend.domains.providers.search_reader import load_reader_config
        c = load_reader_config()
        assert c['budget_s'] == 10 and c['schema_mode'] == 'auto'
        assert c['allow_cloud_fallback'] is False

    def test_validate_budget_bounds(self):
        from backend.domains.providers.search_reader import validate_reader_config
        assert validate_reader_config({'budget_s': 1})[0]
        assert validate_reader_config({'budget_s': 60})[0]
        assert not validate_reader_config({'budget_s': 0})[0]
        assert not validate_reader_config({'budget_s': 61})[0]
        assert not validate_reader_config({'budget_s': True})[0]   # bool 拒

    def test_validate_schema_mode(self):
        from backend.domains.providers.search_reader import validate_reader_config
        for m in ('auto', 'json_object', 'prompt'):
            assert validate_reader_config({'schema_mode': m})[0], m
        assert not validate_reader_config({'schema_mode': 'yaml'})[0]

    def test_corrupt_file_falls_back(self, fresh_home):
        from backend import paths
        from backend.domains.providers.search_reader import load_reader_config
        os.makedirs(os.path.dirname(paths.READER_FILE), exist_ok=True)
        with open(paths.READER_FILE, 'w') as f:
            f.write('{bad json')
        assert load_reader_config()['budget_s'] == 10   # 损坏回落缺省


class TestRouteReader:
    def test_quality_still_local(self):
        from backend.domains.providers.hybrid_router import HybridRouter
        hr = HybridRouter()
        hr.save_config(json.dumps({'strategy': 'quality'}))
        r = hr.route_reader(True, 10)
        assert r['channel'] == 'local'      # 读取器永不升云（隐私前处理）

    def test_local_down_skip(self):
        from backend.domains.providers.hybrid_router import HybridRouter
        hr = HybridRouter()
        r = hr.route_reader(False, 10)
        assert r['channel'] == 'skip' and r['degraded'] is True

    def test_stage_max_tokens_reader(self):
        from backend.domains.providers.hybrid_router import HybridRouter
        assert HybridRouter.STAGE_MAX_TOKENS['reader'] == 512


class TestProvenance:
    def test_wrap_untrusted(self):
        from backend.domains.providers.provenance import wrap_untrusted
        t = wrap_untrusted('正文', 'https://x.com', 'window', '2026-10-23T00:00:00Z')
        assert t.startswith('[UNTRUSTED DATA — 来源: https://x.com')
        assert t.endswith('[END UNTRUSTED DATA]')
        assert '\n正文\n' in t

    def test_wrap_default_ts(self):
        from backend.domains.providers.provenance import wrap_untrusted
        t = wrap_untrusted('x', 'u')
        assert 'T' in t and t.count('Z') >= 1

    def test_tag_payload_pure_add(self):
        from backend.domains.providers.provenance import tag_payload
        p = {'ok': True, 'results': [1, 2]}
        out = tag_payload(p, '', 'search', source={'engine': 'bing',
                                                   'query_sha256': 'abcd1234'})
        assert out['ok'] is True and out['results'] == [1, 2]   # 原键不动
        assert out['untrusted'] is True
        assert out['source']['engine'] == 'bing'

    def test_tag_non_dict_passthrough(self):
        from backend.domains.providers.provenance import tag_payload
        assert tag_payload('not dict') == 'not dict'


class TestJsApiSurface:
    def test_stats_transformed(self, fresh_home):
        from backend.api import Api
        r = json.loads(Api().search_reader_stats())
        assert r['ok'] and 'reader_calls' in r and 'configured' in r

    def test_reader_config_js_api(self, fresh_home):
        from backend.api import Api
        api = Api()
        s = json.loads(api.reader_config_save(
            json.dumps({'base_url': 'http://127.0.0.1:11434/v1'})))
        assert s['ok']
        g = json.loads(api.reader_config_get())
        assert g['base_url'] == 'http://127.0.0.1:11434/v1'

    def test_stealth_registered(self):
        from backend.api import _V12_EXTRA
        for m in ('reader_config_get', 'reader_config_save'):
            assert m in _V12_EXTRA, m

    def test_contract_clean(self, fresh_home):
        from backend.api import Api
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from conftest import legacy
        a = json.loads(legacy.Api().get_api_info())
        b = json.loads(Api().get_api_info())
        assert a['methods'] == b['methods']
