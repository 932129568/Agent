# -*- coding: utf-8 -*-
"""GLM 1211 救援回归（2026-10-21 用户实测 P0：模型不可用 + 前端 CORS 吞真因）。

覆盖：_models_base 派生 / humanize_http_error 1211 分流（含中文特征）/
test_provider_endpoint 1211 时附 available_models（mock urllib 双响应）/
ERROR_HUMANIZE 前端表含 1211 与 Failed-to-fetch 引导条目。
"""
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from conftest import fresh_home  # noqa: E402
from helpers.frontend import read_frontend_source  # noqa: E402


class TestModelsBase:
    def test_strip_chat_completions(self):
        from backend.domains.providers.provider_service import _models_base
        assert _models_base('https://open.bigmodel.cn/api/paas/v4/chat/completions') \
            == 'https://open.bigmodel.cn/api/paas/v4/models'

    def test_idempotent_models_suffix(self):
        from backend.domains.providers.provider_service import _models_base
        assert _models_base('http://127.0.0.1:1919/v1/models') \
            == 'http://127.0.0.1:1919/v1/models'

    def test_plain_base(self):
        from backend.domains.providers.provider_service import _models_base
        assert _models_base('http://x/v1') == 'http://x/v1/models'


class TestHumanize1211:
    def test_1211_code(self):
        from backend.domains.providers.provider_service import humanize_http_error
        h = humanize_http_error(400, '{"error":{"code":"1211","message":"模型 glm-5.3-flash 不存在"}}')
        assert '1211' in h and '获取模型' in h

    def test_chinese_no_permission(self):
        from backend.domains.providers.provider_service import humanize_http_error
        h = humanize_http_error(400, '{"error":{"code":"1210","message":"该 model 无权限访问"}}')
        assert '1211' in h or '无权限' in h      # 中文特征兜底（code 非 1211 也捕获）

    def test_normal_404_not_hijacked(self):
        from backend.domains.providers.provider_service import humanize_http_error
        h = humanize_http_error(404, '{"error":{"message":"page not found"}}')
        assert '1211' not in h and '端点地址' in h

    def test_429_unchanged(self):
        from backend.domains.providers.provider_service import humanize_http_error
        assert '频繁' in humanize_http_error(429, '')


class TestRescueAttachesModels:
    """1211 时 test_provider_endpoint 附 available_models（mock 双响应：
    首个 POST chat/completions → 400 1211；随后 GET /models → 清单）。"""

    def test_rescue_attaches(self, fresh_home, monkeypatch):
        import backend.domains.providers.provider_service as ps
        import urllib.error

        calls = {'n': 0}

        class _Resp:
            def __init__(self, body):
                self._b = body.encode()
            def read(self, n=None):
                return self._b
            def close(self):
                pass
            def __enter__(self):
                return self
            def __exit__(self, *a):
                return False
            @property
            def headers(self):
                return {}

        def fake_urlopen(req, timeout=None):
            url = req.full_url
            if 'chat/completions' in url:
                raise urllib.error.HTTPError(url, 400, 'Bad Request', {},
                                             _Resp('{"error":{"code":"1211","message":"模型不存在"}}'))
            return _Resp(json.dumps({'object': 'list', 'data': [
                {'id': 'glm-4.5'}, {'id': 'glm-4-plus'}, {'id': 'glm-4-air'}]}))

        import backend.domains.providers.local_model_service as lms
        monkeypatch.setattr(ps, 'urlopen_no_redirect', fake_urlopen)
        monkeypatch.setattr(lms, 'urlopen_no_redirect', fake_urlopen)
        r = json.loads(ps.ProviderService().test_endpoint(
            'https://open.bigmodel.cn/api/paas/v4', 'k', 'glm-5.3-flash', 15))
        assert r['ok'] is False
        assert '1211' in r['error']
        assert r['available_models'] == ['glm-4.5', 'glm-4-plus', 'glm-4-air']

    def test_rescue_failure_does_not_mask(self, fresh_home, monkeypatch):
        import backend.domains.providers.provider_service as ps
        import urllib.error

        def fake_urlopen(req, timeout=None):
            url = req.full_url
            if 'chat/completions' in url:
                raise urllib.error.HTTPError(url, 400, 'Bad Request', {}, io.BytesIO(
                    b'{"error":{"code":"1211","message":"x"}}'))
            raise OSError('models endpoint down')     # 清单也挂

        import backend.domains.providers.local_model_service as lms
        monkeypatch.setattr(ps, 'urlopen_no_redirect', fake_urlopen)
        monkeypatch.setattr(lms, 'urlopen_no_redirect', fake_urlopen)
        r = json.loads(ps.ProviderService().test_endpoint(
            'https://open.bigmodel.cn/api/paas/v4', 'k', 'glm-5.3-flash', 15))
        assert r['ok'] is False and '1211' in r['error']
        assert 'available_models' not in r          # 不掩盖原始错误


class TestFrontendTable:
    def test_error_humanize_has_1211_and_fetch_guide(self):
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        src = read_frontend_source(root, '76-cost-estimate.js')
        assert '1211' in src
        assert '测试连接' in src                    # Failed to fetch 条目指路测试连接
        assert '获取模型' in src
