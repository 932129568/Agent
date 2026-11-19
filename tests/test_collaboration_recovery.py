# -*- coding: utf-8 -*-
"""W5E3 persisted checkpoint, new-run continuation and freshness gates."""
from test_collaboration_flow import FLOW, MODULES
from test_model_executor_foundation import run_case

RECOVERY_MODULES = MODULES + ['frontend/src/collaboration/recovery.js',
                              'frontend/src/expert/events.js', 'frontend/src/expert/projection.js']
RECOVERY_HELPERS = FLOW + r'''
function partialFixture() {
  const responses = successfulResponses();
  responses['cloud-reviewer'] = [jsonSse(review('pass')), jsonSse(review('revise', 'improve t2'))];
  responses['local-worker'][0] = collabToolSse('read_file', { path: 'a.txt' });
  responses['local-worker'].splice(1, 0, jsonSse(workerResult('t1 tool result')));
  return flowController(responses, { config: config({ max_review_rounds: 0 }) });
}
function checkpointFor(fixture, original) {
  const recovery = new CollaborationRecovery(fixture.controller);
  const checkpoint = recovery.capture(original, { goal: 'recover goal', sessionId: 's1',
    endpointDigests: { cloud: endpoints().cloud.snapshotDigest, local: endpoints().local.snapshotDigest },
    allowedTools: ['read_file'], toolEffects: [{ tool: 'read_file', resultRef: original.latest.t1.result.resultRef }] });
  return { recovery, checkpoint };
}
'''


def test_partial_checkpoint_resume_revalidates_refs_without_replaying_tools_or_usage():
    result = run_case(RECOVERY_HELPERS + r'''
const fixture = partialFixture();
const original = await fixture.controller.start('recover goal', { sessionId: 's1' });
const { recovery, checkpoint } = checkpointFor(fixture, original);
const session = AppState.sessions[0];
await recovery.persist(session, checkpoint);
const resumed = flowController({
  'local-reviser': [jsonSse(workerResult('t2 revised'))],
  'cloud-reviewer': [jsonSse(review('pass'))],
  'cloud-finalizer': [textSse('recovered final')],
});
const recovered = await recovery.recover(checkpoint, { goal: 'recover goal', sessionId: 's1',
  endpoints: endpoints(), transport: resumed.controller.transport, config: config(), allowedTools: ['read_file'] });
return { original, recovered, checkpoint, resumedCalls: resumed.calls.map(call => call.role),
  resumedHostCalls: resumed.hostCalls, originalHostCalls: fixture.hostCalls,
  projection: projectExpertSessionEvents(session, original.runId), active: RunRegistry.current() };
''', RECOVERY_MODULES)
    assert result['original']['status'] == 'partial'
    assert result['checkpoint']['pendingTasks'] == [{'taskId': 't2', 'attempt': 1}]
    assert result['recovered']['status'] == 'completed'
    assert result['resumedCalls'] == ['local-reviser', 'cloud-reviewer', 'cloud-finalizer']
    assert result['recovered']['runId'] != result['original']['runId']
    assert result['recovered']['parentRunId'] == result['original']['runId']
    assert result['recovered']['final']['resultRefs'][0] != result['original']['latest']['t1']['result']['resultRef']
    assert result['recovered']['final']['resultRefs'][1].startswith('res_plan1_t2_a2_')
    assert result['recovered']['usage']['totalTokens'] == 30
    assert result['recovered']['cumulativeUsage']['totalTokens'] == result['original']['usage']['totalTokens'] + 30
    assert len(result['originalHostCalls']) == 1 and result['resumedHostCalls'] == []
    assert result['projection']['latestCheckpoint']['runId'] == result['original']['runId']
    assert result['active'] is None


def test_recovery_source_endpoint_and_permission_changes_block_without_calls():
    result = run_case(RECOVERY_HELPERS + r'''
const fixture = partialFixture();
const original = await fixture.controller.start('recover goal', { sessionId: 's1' });
const { recovery, checkpoint } = checkpointFor(fixture, original);
const sourceChanged = await recovery.recover(checkpoint, { goal: 'different goal', sessionId: 's1', endpoints: endpoints() });
const changedEndpoints = Object.assign({}, endpoints(), { cloud: collaborationEndpointSnapshot('cloud', endpoint('other-cloud')) });
const endpointChanged = await recovery.recover(checkpoint, { goal: 'recover goal', sessionId: 's1', endpoints: changedEndpoints });
const permissionChanged = await recovery.recover(checkpoint, { goal: 'recover goal', sessionId: 's1', endpoints: endpoints(), allowedTools: [] });
return { sourceChanged, endpointChanged, permissionChanged, active: RunRegistry.current() };
''', RECOVERY_MODULES)
    assert result['sourceChanged']['status'] == 'blocked'
    assert result['sourceChanged']['error']['code'] == 'DATA_SOURCE_CHANGED'
    assert result['endpointChanged']['status'] == 'blocked'
    assert result['endpointChanged']['error']['code'] == 'ENDPOINT_CHANGED'
    assert result['permissionChanged']['status'] == 'blocked'
    assert result['permissionChanged']['error']['code'] == 'PERMISSION_CHANGED'
    assert result['active'] is None


def test_cancelled_recovery_ignores_late_reviser_and_does_not_finalize():
    result = run_case(RECOVERY_HELPERS + r'''
const fixture = partialFixture();
const original = await fixture.controller.start('recover goal', { sessionId: 's1' });
const { recovery, checkpoint } = checkpointFor(fixture, original);
let pending;
const resumed = flowController({});
resumed.controller.transport = { stream: request => {
  resumed.calls.push({ role: request.role, endpointRole: request.endpointRef.role, body: request.body });
  return new Promise(resolve => { pending = resolve; });
} };
const running = recovery.recover(checkpoint, { goal: 'recover goal', sessionId: 's1',
  endpoints: endpoints(), transport: resumed.controller.transport, config: config(), allowedTools: ['read_file'] });
while (!pending) await new Promise(resolve => setTimeout(resolve, 0));
const newRunId = RunRegistry.current().id;
fixture.controller.cancel(newRunId);
pending(sse(jsonSse(workerResult('late reviser'))));
const recovered = await running;
return { recovered, newRunId, calls: resumed.calls.map(call => call.role), active: RunRegistry.current() };
''', RECOVERY_MODULES)
    assert result['recovered']['status'] == 'cancelled' and result['recovered']['final'] is None
    assert result['recovered']['parentRunId'] == str(result['newRunId'] - 1)
    assert result['calls'] == ['local-reviser'] and result['active'] is None
