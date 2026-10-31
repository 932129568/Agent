# -*- coding: utf-8 -*-
"""Independent W9 adversarial checks for recovery, budget and secret identity."""
from test_collaboration_flow import FLOW, MODULES
from test_collaboration_recovery import RECOVERY_HELPERS, RECOVERY_MODULES
from test_model_executor_foundation import run_case


def test_recovery_rejects_checkpoint_from_another_session():
    result = run_case(RECOVERY_HELPERS + r'''
const fixture = partialFixture();
const original = await fixture.controller.start('recover goal', { sessionId: 's1' });
const { recovery, checkpoint } = checkpointFor(fixture, original);
AppState.currentSessionId = 's2';
const resumed = flowController({
  'local-reviser': [jsonSse(workerResult('t2 revised'))],
  'cloud-reviewer': [jsonSse(review('pass'))],
  'cloud-finalizer': [textSse('cross session secret')],
});
const recovered = await recovery.recover(checkpoint, {
  goal: 'recover goal', sessionId: 's2', endpoints: endpoints(),
  transport: resumed.controller.transport, config: config(), allowedTools: ['read_file'],
});
return { originalSession: checkpoint.sessionId, recovered,
  calls: resumed.calls.map(call => call.role) };
''', RECOVERY_MODULES)
    assert result['recovered']['status'] == 'blocked', result
    assert result['calls'] == [], result


def test_negative_usage_cannot_reduce_budget_consumption():
    result = run_case(FLOW + r'''
const budget = new CollaborationBudget(config(), endpoints());
const reservation = budget.reserve('local-worker', 100);
let error = '';
let settled = false;
try { settled = budget.settle('negative-usage', 'local-worker', {
  prompt_tokens: -10000, completion_tokens: 0, total_tokens: -10000,
}, reservation); } catch (caught) { error = caught.message; }
return { error, settled, snapshot: budget.snapshot() };
''', MODULES)
    assert result['error'], result
    assert result['settled'] is False, result
    assert result['snapshot']['totalTokens'] == 0, result
    assert 'negative-usage' not in result['snapshot']['byMessage'], result


def test_endpoint_rejects_raw_github_token_as_credential_ref():
    result = run_case(r'''
let accepted = false;
let error = '';
try {
  const ref = new EndpointRef({ role: 'cloud', preset: 'github', baseUrlRef: 'cache.github',
    model: 'm', credentialRef: 'ghp_1234567890abcdef',
    prices: { in: 1, out: 1, cache: 0 }, toolCapability: [], ctxWindow: 8192 });
  accepted = !!ref;
} catch (caught) { error = caught.message; }
return { accepted, error };
''', ['frontend/src/collaboration/endpoint.js'])
    assert result['accepted'] is False, result
    assert result['error'] == 'ENDPOINT_SECRET_FORBIDDEN', result
