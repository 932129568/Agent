# -*- coding: utf-8 -*-
"""W9-fix session isolation, usage atomicity and credential reference boundaries."""
from test_collaboration_flow import FLOW, MODULES
from test_collaboration_recovery import RECOVERY_HELPERS, RECOVERY_MODULES
from test_model_executor_foundation import run_case


def test_recovery_requires_checkpoint_target_and_active_session_match():
    result = run_case(RECOVERY_HELPERS + r'''
const fixture = partialFixture();
const original = await fixture.controller.start('recover goal', { sessionId: 's1' });
const { recovery, checkpoint } = checkpointFor(fixture, original);
AppState.currentSessionId = 's2';
const targetMismatch = await recovery.recover(checkpoint, { goal: 'recover goal', sessionId: 's2', endpoints: endpoints() });
AppState.currentSessionId = 's1';
const activeMismatch = await recovery.recover(checkpoint, { goal: 'recover goal', sessionId: 's2', endpoints: endpoints() });
const missingTarget = await recovery.recover(checkpoint, { goal: 'recover goal', endpoints: endpoints() });
const resumed = flowController({ 'local-reviser': [jsonSse(workerResult('t2 revised'))],
  'cloud-reviewer': [jsonSse(review('pass'))], 'cloud-finalizer': [textSse('valid recovery')] });
const valid = await recovery.recover(checkpoint, { goal: 'recover goal', sessionId: 's1',
  endpoints: endpoints(), transport: resumed.controller.transport, config: config() });
return { targetMismatch, activeMismatch, missingTarget, valid, original,
  resumedCalls: resumed.calls.map(call => call.role) };
''', RECOVERY_MODULES)
    for name in ('targetMismatch', 'activeMismatch', 'missingTarget'):
        blocked = result[name]
        assert blocked['status'] == 'blocked' and blocked['error']['code'] == 'RECOVERY_SESSION_MISMATCH'
        assert blocked['content'] == '' and blocked['checkpoint'] is None
    assert result['valid']['status'] == 'completed'
    assert result['valid']['parentRunId'] == result['original']['runId']
    assert result['resumedCalls'] == ['local-reviser', 'cloud-reviewer', 'cloud-finalizer']


def test_direct_controller_recovery_also_rejects_session_mismatch():
    result = run_case(RECOVERY_HELPERS + r'''
const fixture = partialFixture();
const original = await fixture.controller.start('recover goal', { sessionId: 's1' });
const { checkpoint } = checkpointFor(fixture, original);
const blocked = await fixture.controller.start('recover goal', { sessionId: 's2', recovery: checkpoint,
  endpoints: endpoints(), config: config() });
return { blocked, active: RunRegistry.current() };
''', RECOVERY_MODULES)
    assert result['blocked']['status'] == 'blocked'
    assert result['blocked']['error']['code'] == 'RECOVERY_SESSION_MISMATCH'
    assert result['active'] is None


def test_invalid_usage_is_atomic_and_valid_or_unknown_usage_remains_idempotent():
    result = run_case(FLOW + r'''
const budget = new CollaborationBudget(config(), endpoints());
const initial = JSON.stringify(budget.snapshot());
const invalid = [
  { total_tokens: -1, prompt_tokens: 0, completion_tokens: 0 },
  { total_tokens: 1, prompt_tokens: NaN, completion_tokens: 0 },
  { total_tokens: 1, prompt_tokens: 0, completion_tokens: Infinity },
  { total_tokens: 2, prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 2 } },
  { total_tokens: 1, prompt_tokens: 2, completion_tokens: 0 },
  { total_tokens: '1', prompt_tokens: 0, completion_tokens: 0 },
];
const failures = [];
for (let index = 0; index < invalid.length; index++) {
  const reservation = budget.reserve('local-worker', 10);
  try { budget.settle('invalid-' + index, 'local-worker', invalid[index], reservation); }
  catch (error) { failures.push({ message: error.message, settled: reservation.settled,
    unchanged: JSON.stringify(budget.snapshot()) === initial }); }
}
const validReservation = budget.reserve('cloud-reviewer', 10);
const valid = budget.settle('valid', 'cloud-reviewer', { total_tokens: 10, prompt_tokens: 6,
  completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } }, validReservation);
const duplicate = budget.settle('valid', 'cloud-reviewer', { total_tokens: -100 }, validReservation);
const unknownReservation = budget.reserve('local-worker', 25);
const unknown = budget.settle('unknown', 'local-worker', {}, unknownReservation);
return { failures, valid, duplicate, unknown, snapshot: budget.snapshot() };
''', MODULES)
    assert len(result['failures']) == 6
    assert all(item['message'] == 'COLLABORATION_USAGE_INVALID' and item['settled'] is False and item['unchanged']
               for item in result['failures'])
    assert result['valid'] is True and result['duplicate'] is False and result['unknown'] is True
    assert result['snapshot']['byMessage']['unknown']['estimated'] is True
    assert result['snapshot']['byMessage']['unknown']['total_tokens'] == 25


def test_endpoint_credential_ref_structure_and_secret_shapes():
    result = run_case(FLOW + r'''
const digest = 'a'.repeat(64);
const base = { role: 'cloud', preset: 'preset', baseUrlRef: 'cache.cloud', model: 'model',
  prices: { in: 0, out: 0, cache: 0 }, toolCapability: [], ctxWindow: 8192 };
const valid = new EndpointRef(Object.assign({}, base, { credentialRef: { kind: 'provider-key', providerConfigDigest: digest } }));
const custom = new EndpointRef(Object.assign({}, base, { credentialRef: { kind: 'custom-provider-key', providerConfigDigest: digest } }));
const invalidRefs = ['ghp_1234567890abcdef', 'github_pat_1234567890abcdef',
  { kind: 'provider-key', providerConfigDigest: 'short' },
  { kind: 'provider-key', providerConfigDigest: digest, token: 'secret' },
  { kind: 'raw-token', providerConfigDigest: digest }, null, 'plain-string'];
const failures = invalidRefs.map(credentialRef => {
  try { new EndpointRef(Object.assign({}, base, { credentialRef })); return null; }
  catch (error) { return error.message; }
});
let modelSecret = null;
try { new EndpointRef(Object.assign({}, base, { model: 'ghp_1234567890abcdef',
  credentialRef: { kind: 'provider-key', providerConfigDigest: digest } })); }
catch (error) { modelSecret = error.message; }
return { valid, custom, failures, modelSecret };
''', MODULES)
    assert result['valid']['credentialRef']['kind'] == 'provider-key'
    assert result['custom']['credentialRef']['kind'] == 'custom-provider-key'
    assert all(message == 'ENDPOINT_SECRET_FORBIDDEN' for message in result['failures'])
    assert result['modelSecret'] == 'ENDPOINT_SECRET_FORBIDDEN'
