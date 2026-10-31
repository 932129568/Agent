# -*- coding: utf-8 -*-
"""§3.3/§4.4 Agent 工具护栏链回归：web_search/software_call enforce + dangerous。"""
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from conftest import fresh_home  # noqa: E402


class TestGuardMatrix:
    def test_new_ops_in_matrix(self):
        from backend.domains.security.guard_service import GUARD_OPS, DEFAULT_TIERS
        assert 'web_search' in GUARD_OPS and 'software_call' in GUARD_OPS
        # 用户裁决（2026-10-24）：搜索只读无本地副作用、全程留审计——默认放行
        # 免每次确认（原 session 档）；护栏设置可提档 session/always 加固
        assert DEFAULT_TIERS['web_search'] == 'off'
        assert DEFAULT_TIERS['software_call'] == 'session'

    def test_check_confirm_default(self, fresh_home):
        from backend.domains.security.guard_service import GuardService
        g = GuardService()
        assert g.check('web_search', {'query': 'x'})['action'] == 'allow'
        r = g.check('software_call', {'software': 'git', 'action': 'status'})
        assert r['action'] == 'confirm'      # session 档默认需确认

    def test_off_tier_allow(self, fresh_home):
        from backend.domains.security.guard_service import GuardService
        g = GuardService()
        g.save_config(json.dumps({'tiers': {'web_search': 'off'}}))
        assert g.check('web_search', {'query': 'x'})['action'] == 'allow'


class TestApiEnforce:
    def test_browser_search_default_off_armed(self, fresh_home):
        """默认 off 档（用户裁决 2026-10-24）：armed 态直接放行，不再逐次确认。"""
        from backend.api import Api
        api = Api()
        api._guard.arm()
        r = json.loads(api.browser_search({'query': 'python'}))
        assert 'error' not in r or r.get('error', {}).get('code') != 'CONFIRM_REQUIRED'

    def test_browser_search_session_tier_token_armed(self, fresh_home):
        """提档 session（用户可自行加固）：armed 态强制 token 的机制回归。"""
        from backend.api import Api
        api = Api()
        api._guard.arm()
        api._guard.save_config(json.dumps({'tiers': {'web_search': 'session'}}))
        r = json.loads(api.browser_search({'query': 'python'}))
        assert r['ok'] is False
        assert r['error']['code'] == 'CONFIRM_REQUIRED'
        assert r['error']['op'] == 'web_search'

    def test_software_call_needs_token_armed(self, fresh_home):
        from backend.api import Api
        api = Api()
        api._guard.arm()
        r = json.loads(api.software_call({'software': 'git', 'action': 'status'}))
        assert r['ok'] is False
        assert r['error']['code'] == 'CONFIRM_REQUIRED'

    def test_token_flow_pass(self, fresh_home):
        """确认框换 token → 携带执行 → 放行（落到 service 层参数校验错误即证明
        guard 已过——UNKNOWN_SOFTWARE/BAD_PARAMS 是 guard 之后的层）。"""
        from backend.api import Api
        api = Api()
        t = json.loads(api.guard_confirm_token(
            'web_search', json.dumps({'query': 'python'})))
        assert t['token']
        r = json.loads(api.browser_search({'query': 'python'}, t['token']))
        # guard 过：不再 CONFIRM_REQUIRED（可能因无网/无窗回落 urllib 或参数错，
        # 但绝不是 CONFIRM_REQUIRED）
        assert 'error' not in r or r.get('error', {}).get('code') != 'CONFIRM_REQUIRED'

    def test_dangerous_force_always(self, fresh_home):
        """dangerous action：force_always 置位 → 无 token 必拒（§4.4）。"""
        from backend.api import Api
        from backend.domains.integrations import software_service as ss_mod
        api = Api()
        svc = api._software
        # 塞一个 dangerous 动作的假注册项
        with svc._lock:
            svc._registry['faketool'] = {
                'name': 'faketool', 'kind': 'cli',
                'probe': ['faketool', '--version'],
                'actions': [{'name': 'wipe', 'argv': ['faketool', 'wipe'],
                             'risk': 'dangerous'}]}
        assert svc.action_risk('faketool', 'wipe') == 'dangerous'
        r = json.loads(api.software_call({'software': 'faketool', 'action': 'wipe'}))
        assert r['ok'] is False
        assert r['error']['code'] == 'CONFIRM_REQUIRED'
        # dangerous 换 token 后可过 guard（落到 NOT_INSTALLED 之类）
        t = json.loads(api.guard_confirm_token(
            'software_call', json.dumps({'software': 'faketool', 'action': 'wipe',
                                         'force_always': True})))
        assert t['token']
        r2 = json.loads(api.software_call({'software': 'faketool', 'action': 'wipe'}, t['token']))
        assert 'error' not in r2 or r2.get('error', {}).get('code') != 'CONFIRM_REQUIRED'

    def test_session_trust_skips_second(self, fresh_home):
        """session 档：一次 token 确认后同 op 同 detail 会话信任放行。"""
        from backend.api import Api
        api = Api()
        t = json.loads(api.guard_confirm_token(
            'web_search', json.dumps({'query': 'python'})))
        api.browser_search({'query': 'python'}, t['token'])
        r = json.loads(api.browser_search({'query': 'python'}))   # 二次无 token
        assert 'error' not in r or r.get('error', {}).get('code') != 'CONFIRM_REQUIRED'
