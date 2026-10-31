# -*- coding: utf-8 -*-
"""v1.9.0 M2.6 审计五维+哈希链回归（design §A3.6）。

覆盖：链 append 链接/verify 全过/篡改检出/断链定位/head 持久/旧条目跳过；
audit 五维（identity/intent/plan/evidence 哈希非原文/result）+ 旧四参兼容；
get_audit_log 链块扩展；identity hook；memory_retrieve 入账。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from conftest import fresh_home  # noqa: E402


class TestChainCore:
    def _chain(self):
        from backend.domains.security.audit_chain import AuditChain
        from backend import paths
        return AuditChain(path=paths.AUDIT_CHAIN_FILE)

    def test_append_links(self, fresh_home):
        c = self._chain()
        e1 = c.append({'op': 'a', 'action': 'check'})
        e2 = c.append({'op': 'b', 'action': 'decision'})
        assert e1['prev_hash'] == '0' * 64          # genesis
        assert e2['prev_hash'] == e1['hash']
        assert e1['hash'] != e2['hash']

    def test_verify_ok(self, fresh_home):
        c = self._chain()
        es = [c.append({'op': 'o%d' % i}) for i in range(5)]
        r = c.verify(es)
        assert r['ok'] and r['checked'] == 5
        assert r['len'] == 5

    def test_tamper_detected(self, fresh_home):
        c = self._chain()
        es = [c.append({'op': 'o%d' % i}) for i in range(4)]
        es[2]['op'] = '篡改'                          # 改中间条目
        r = c.verify(es)
        assert not r['ok']
        assert r['broken_at']['index'] == 2
        assert r['broken_at']['op'] == '篡改'

    def test_head_persisted(self, fresh_home):
        from backend.domains.security.audit_chain import AuditChain
        from backend import paths
        c1 = AuditChain(path=paths.AUDIT_CHAIN_FILE)
        e = c1.append({'op': 'x'})
        c2 = AuditChain(path=paths.AUDIT_CHAIN_FILE)   # 重开实例
        assert c2._head == e['hash']
        e2 = c2.append({'op': 'y'})
        assert e2['prev_hash'] == e['hash']

    def test_legacy_entries_skipped(self, fresh_home):
        """无 hash 字段的旧条目跳过（不计 checked，不判 broken——前向兼容）。"""
        c = self._chain()
        old = {'op': 'legacy', 'ts': '2026-10-01 00:00:00'}
        es = [old] + [c.append({'op': 'new%d' % i}) for i in range(2)]
        r = c.verify(es)
        assert r['ok'] and r['checked'] == 2

    def test_canonical_stable(self):
        from backend.domains.security.audit_chain import entry_hash, canonical_json
        a = {'b': 1, 'a': 2}
        b = {'a': 2, 'b': 1}
        assert canonical_json(a) == canonical_json(b)      # 键序不影响
        assert entry_hash('p', a) == entry_hash('p', b)

    def test_hash_order_sensitive(self):
        from backend.domains.security.audit_chain import entry_hash
        e1 = {'op': 'a', 'ts': 't1'}
        e2 = {'op': 'b', 'ts': 't2'}
        # 防重排：prev+条目顺序敏感
        assert entry_hash('p', e1) != entry_hash('p', e2)


class TestGuardAuditFiveDims:
    def _guard(self):
        from backend.domains.security.guard_service import GuardService
        return GuardService()

    def test_five_dimensions_present(self, fresh_home):
        g = self._guard()
        g.set_identity_hook(lambda: {'sid': 's1', 'principal': 'user'})
        g.audit('delete_path', {'path': 'x.py'}, 'decision', 'token-confirm',
                plan={'task_id': 't1', 'plan_status': 'approved'},
                result={'status': 'ok'})
        entries = self._read_entries(g)
        last = entries[-1]
        assert last['identity'] == {'sid': 's1', 'principal': 'user'}
        assert last['intent']['trace'] == '' and 'delete_path' in last['intent']['summary']
        assert last['plan']['task_id'] == 't1'
        assert 'args_sha256' in last['evidence']
        assert last['result']['status'] == 'ok'
        assert last['hash'] and last['prev_hash']          # 链字段在

    def test_evidence_is_hash_not_raw(self, fresh_home):
        g = self._guard()
        g.audit('run_command', {'cmd': 'secret-token-xyz'}, 'check')
        entries = self._read_entries(g)
        ev = entries[-1].get('evidence') or {}
        assert ev.get('args_sha256')
        raw = json.dumps(entries[-1], ensure_ascii=False)
        assert 'secret-token-xyz' in raw                    # detail 原文仍在（既有口径）
        assert 'secret-token-xyz' not in json.dumps(ev)     # evidence 只哈希

    def test_backward_compat_four_args(self, fresh_home):
        """旧 4 参调用零改（kwarg 全缺省；五维键仍落——形状前向兼容）。"""
        g = self._guard()
        g.audit('web_search', {'query': 'q'}, 'block', 'deny')
        entries = self._read_entries(g)
        last = entries[-1]
        assert last['op'] == 'web_search' and last['decision'] == 'deny'

    def test_identity_hook_exception_safe(self, fresh_home):
        g = self._guard()

        def boom():
            raise RuntimeError('hook 炸')

        g.set_identity_hook(boom)
        g.audit('x', {'a': 1})
        entries = self._read_entries(g)
        assert entries[-1]['identity']['sid'] == ''     # 异常 → sid 空，不阻断

    def _read_entries(self, g):
        out = []
        with open(g._audit_path, encoding='utf-8') as f:
            for line in f:
                if line.strip():
                    out.append(json.loads(line))
        return out


class TestApprovalBudget:
    def _guard(self):
        from backend.domains.security.guard_service import GuardService
        return GuardService()

    def test_default_merged(self, fresh_home):
        g = self._guard()
        b = g.approval_budget()
        assert b['ok'] and b['limit'] == 20 and b['used'] == 0

    def test_count_on_token_confirm(self, fresh_home):
        g = self._guard()
        r = g.issue_confirm_token('run_command', {'cmd': 'x'})
        assert g.approval_budget()['used'] == 1

    def test_refund_decrements(self, fresh_home):
        """真实序列：签发 → 执行点消费（token 离 map）→ 执行前失败退还。"""
        g = self._guard()
        r = g.issue_confirm_token('run_command', {'cmd': 'x'})
        assert g.consume_token('run_command', {'cmd': 'x'}, r['token'])
        assert g.refund_token('run_command', {'cmd': 'x'}, r['token'])
        assert g.approval_budget()['used'] == 0

    def test_count_on_trust_session(self, fresh_home):
        g = self._guard()
        g.trust_session('run_command')
        assert g.approval_budget()['used'] == 1

    def test_no_count_on_grant(self, fresh_home):
        """grant 放行不计预算（design §A3.5 计数口径表）。"""
        g = self._guard()
        g.task_grant(['exec'])
        # grant 覆盖的 op 走 enforce_exec_ex——used 不变
        reason, bx = g.enforce_exec_ex('run_command', {'cmd': 'x'})
        assert g.approval_budget()['used'] == 0

    def test_escalate_at_limit(self, fresh_home):
        g = self._guard()
        g.approval_budget(limit=2)
        g.issue_confirm_token('run_command', {'cmd': 'a'})
        g.issue_confirm_token('run_command', {'cmd': 'b'})
        b = g.approval_budget()
        assert b['escalated'] is True and b['used'] == 2

    def test_reset_on_session_switch(self, fresh_home):
        g = self._guard()
        g.issue_confirm_token('run_command', {'cmd': 'x'})
        g.clear_session_trust()
        b = g.approval_budget()
        assert b['used'] == 0 and b['escalated'] is False

    def test_enforce_ex_returns_budget_payload(self, fresh_home):
        """越限后需要确认的 op → (None, APPROVAL_BUDGET_EXCEEDED payload)。

        先 arm()（武装=桌面 UI 会话在位；未武装环境 always/session 档按
        legacy 兼容直接 allow，不产生确认需求——预算语义只在武装后有戏）。
        bug 修复回归：enforce_exec_ex 改 reason 先行——未武装（无确认流）
        不升级；武装后需确认（token-missing）才升级。
        """
        g = self._guard()
        g.arm()
        g.approval_budget(limit=1)
        g.issue_confirm_token('delete_path', {'path': 'a.py'})   # used=1 越限
        reason, bx = g.enforce_exec_ex('delete_path', {'path': 'b.py'})
        assert reason is None and bx is not None
        assert bx['code'] == 'APPROVAL_BUDGET_EXCEEDED'
        assert bx['used'] == 1 and bx['limit'] == 1
        assert bx['suggest_scopes'] == ['workspace_write']   # delete_path 映射

    def test_budget_upgrade_skips_grant_covered(self, fresh_home):
        """bug 修复回归：预算升级不短路授权链——grant 覆盖的 op 放行（bx=None）。"""
        g = self._guard()
        g.arm()
        g.approval_budget(limit=1)
        g.issue_confirm_token('delete_path', {'path': 'a.py'})   # used=1 越限
        g.task_grant(['workspace_write'], ttl_seconds=600)
        reason, bx = g.enforce_exec_ex('delete_path', {'path': 'b.py'})
        assert reason is None and bx is None      # grant 覆盖 → 直接放行

    def test_budget_limit_persisted(self, fresh_home):
        """bug 修复回归：limit 落盘持久（重启不回默认 20）。"""
        g = self._guard()
        g.approval_budget(limit=7)
        with open(g._path, encoding='utf-8') as f:
            data = json.load(f)
        assert data.get('approval_budget', {}).get('limit') == 7
        g2 = self._guard()
        assert g2.approval_budget()['limit'] == 7

    def test_api_set_limit_bounds(self, fresh_home):
        from backend.api import Api
        api = Api()
        assert json.loads(api.guard_approval_budget(100))['ok']
        bad = json.loads(api.guard_approval_budget(0))
        assert 'error' in bad

    def test_api_read_only(self, fresh_home):
        from backend.api import Api
        api = Api()
        before = json.loads(api.guard_approval_budget())
        api.guard_approval_budget()
        after = json.loads(api.guard_approval_budget())
        assert before == after                    # 只读不动状态


class TestPlanIntentFields:
    def test_create_optional_eta_scope(self, fresh_home):
        from backend.domains.planning.plan_service import PlanService
        ps = PlanService()
        r = ps.create('T', [{'text': 'a', 'risk': 'l2'},
                            {'text': 'b', 'risk': 'l0'}],
                      eta_seconds=300,
                      scope={'modifies': ['a.py'], 'no_access': ['.git']})
        p = r['plan']
        assert p['eta_seconds'] == 300 and p['scope']['modifies'] == ['a.py']
        assert p['scope']['no_access'] == ['.git']

    def test_create_preserves_tools(self, fresh_home):
        from backend.domains.planning.plan_service import PlanService
        ps = PlanService()
        r = ps.create('T', [{'text': 'a', 'tools': ['write_file', 'run_command']}])
        assert r['plan']['steps'][0]['tools'] == ['write_file', 'run_command']

    def test_risk_max_derived(self, fresh_home):
        from backend.domains.planning.plan_service import PlanService
        ps = PlanService()
        r = ps.create('T', [{'text': 'a', 'risk': 'l2'},
                            {'text': 'b', 'risk': 'l0'}])
        assert r['plan']['risk_max'] == 'l0'

    def test_eta_heuristic(self, fresh_home):
        from backend.domains.planning.plan_service import PlanService
        ps = PlanService()
        r = ps.create('T', [{'text': 'a'}, {'text': 'b'}, {'text': 'c'}])
        assert r['plan']['eta_seconds'] == 120        # 3 步 × 40s 启发

    def test_approve_sets_approved_at(self, fresh_home):
        from backend.domains.planning.plan_service import PlanService
        ps = PlanService()
        r = ps.create('T', [{'text': 'a'}])
        u = ps.update(r['task_id'], status='approved')
        assert u['plan']['approved_at']
        assert u['plan']['status'] == 'approved'

    def test_old_call_shape_unchanged(self, fresh_home):
        """旧三方调用（无尾参）零改。"""
        from backend.domains.planning.plan_service import PlanService
        ps = PlanService()
        r = ps.create('T', ['步骤一', '步骤二'])
        assert r['ok'] and len(r['plan']['steps']) == 2
        assert r['plan']['eta_seconds'] == 80        # 尾参缺省=启发式


class TestAuditLogChainBlock:
    def test_chain_block_shape(self, fresh_home):
        from backend.api import Api
        api = Api()
        api.guard_approval_budget(3)
        r = json.loads(api.get_audit_log(limit=50))
        assert 'chain' in r
        ch = r['chain']
        assert ch['head'] and len(ch['head']) == 8      # 首 8 位口径
        assert isinstance(ch['len'], int) and ch['valid'] is True

    def test_memory_retrieve_audited(self, fresh_home):
        from backend.api import Api
        api = Api()
        api.memory_retrieve('测试查询')
        r = json.loads(api.get_audit_log(limit=10))
        ops = [e.get('op') for e in r.get('entries', [])]
        assert 'memory_retrieve' in ops
        # query 只落 sha256（禁原文）
        entry = [e for e in r['entries'] if e.get('op') == 'memory_retrieve'][-1]
        assert 'query_sha256' in entry['detail']
        assert '测试查询' not in json.dumps(entry['detail'], ensure_ascii=False)
