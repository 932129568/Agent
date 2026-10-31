# -*- coding: utf-8 -*-
"""W1 trace_id + W2 readiness 回归（deep-research W1/W2）。"""
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from conftest import fresh_home  # noqa: E402


class TestTraceId:
    def test_audit_carries_trace(self, fresh_home):
        from backend.api import Api
        from backend.domains.security.guard_service import AUDIT_LOG
        api = Api()
        t = api._current_trace()
        assert t.startswith('t_') and len(t) >= 10
        api._guard.audit('web_search', {'query': 'x'}, 'check', 'allow')
        lines = io.open(AUDIT_LOG, encoding='utf-8').read().strip().splitlines()
        assert json.loads(lines[-1])['trace'] == t

    def test_session_switch_rotates(self, fresh_home):
        from backend.api import Api
        api = Api()
        t1 = api._current_trace()
        api.set_current_sid('other')
        assert api._current_trace() != t1

    def test_trace_new_js_api(self, fresh_home):
        from backend.api import Api
        api = Api()
        t1 = api._current_trace()
        r = json.loads(api.trace_new())
        assert r['ok'] and r['trace'] != t1
        assert api._current_trace() == r['trace']

    def test_no_hook_backward_compat(self, fresh_home):
        """无 hook（旧装配路径）：audit 不带 trace 但不炸。"""
        from backend.domains.security.guard_service import GuardService
        g = GuardService()
        g.audit('web_search', {'q': '1'}, 'check', 'allow')
        assert g.current_trace() is None

    def test_contract_not_polluted(self, fresh_home):
        from backend.api import _V12_EXTRA
        assert 'trace_new' in _V12_EXTRA
        assert 'current_trace' not in _V12_EXTRA      # 私有方法不进契约面


class TestReadiness:
    def test_full_setup(self):
        from backend.domains.providers.local_model_service import readiness
        r = readiness({'id': 'qwen2.5:7b', 'ctx_window': 32768,
                       'tool_capable': True, 'estimated': False},
                      {'local_max_iter': 2},
                      {'schema_json': True, 'reachable': True,
                       'keep_alive': True, 'error_kind': 'timeout'})
        assert r['score'] == 16 and r['verdict'] == 'full'
        assert len(r['items']) == 8 and r['suggestions'] == []

    def test_unreachable_cloud(self):
        from backend.domains.providers.local_model_service import readiness
        r = readiness(None, None, {'reachable': False})
        assert r['verdict'] == 'cloud' and r['score'] < 8
        assert len(r['suggestions']) >= 5

    def test_partial_middle(self):
        from backend.domains.providers.local_model_service import readiness
        r = readiness({'id': 'llama3.1:8b', 'tool_capable': True,
                       'estimated': True}, {}, {'schema_json': True})
        assert 8 <= r['score'] < 16

    def test_no_tool_capable_low(self):
        from backend.domains.providers.local_model_service import readiness
        r = readiness({'id': 'x', 'tool_capable': False, 'estimated': False},
                      {'local_max_iter': 1}, {'schema_json': True})
        assert 'tool_capable' in [i['name'] for i in r['items'] if i['score'] == 0]

    def test_js_api_unreachable(self, fresh_home):
        from backend.api import Api
        r = json.loads(Api().local_readiness('http://127.0.0.1:59999/v1', 'qwen'))
        assert r['ok'] and r['verdict'] == 'cloud'
        assert r['model'] == 'qwen' and len(r['items']) == 8

    def test_js_api_mock_full(self, fresh_home, monkeypatch):
        from backend.api import Api
        from backend.domains.providers import local_model_service as lms
        monkeypatch.setattr(lms.LocalModelService, 'models',
                            lambda self, b, api_key='': {'ok': True, 'models': [
                                {'id': 'qwen2.5:7b', 'ctx_window': 32768,
                                 'tool_capable': True, 'estimated': False}]})
        r = json.loads(Api().local_readiness('http://127.0.0.1:11434/v1', 'qwen2.5:7b'))
        assert r['verdict'] == 'full' and r['model'] == 'qwen2.5:7b'

    def test_in_v12_extra(self):
        from backend.api import _V12_EXTRA
        assert 'local_readiness' in _V12_EXTRA
