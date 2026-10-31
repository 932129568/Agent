# -*- coding: utf-8 -*-
"""W5E2 shared ModelExecutor collaboration flow and negative gates."""
from test_expert_agent import HELPERS
from test_model_executor_foundation import run_case

MODULES = [
    'frontend/src/collaboration/endpoint.js', 'frontend/src/collaboration/schemas.js',
    'frontend/src/collaboration/config.js', 'frontend/src/collaboration/plan.js',
    'frontend/src/collaboration/budget.js', 'frontend/src/collaboration/privacy.js',
    'frontend/src/agent/request-builder.js', 'frontend/src/agent/sse-parser.js',
    'frontend/src/agent/model-executor.js', 'frontend/src/agent/run-registry.js',
    'frontend/src/collaboration/controller.js',
]
FLOW = HELPERS + r'''
providerState = { model: 'fake-model' };
function endpoint(preset) { return { preset, baseUrlRef: 'cache.' + preset, model: preset + '-model',
  prices: { in: 1, out: 2, cache: 0.5 }, toolCapability: ['read_file'], ctxWindow: 32768 }; }
function both() { return { cloud: endpoint('cloud'), local: endpoint('local') }; }
function endpoints() { return createCollaborationEndpoints({ active: 'cloud', currentCloud: endpoint('cloud'), cache: { local: endpoint('local') } }); }
function config(overrides = {}) { return normalizeCollaborationConfig(Object.assign({ enabled: true, cloud_cost_budget: 1000, endpoint_cache: both() }, overrides)); }
function task(id, dependsOn = []) { return { taskId: id, title: id, instruction: 'do ' + id,
  dependsOn, capability: { kind: 'understand', requiredTools: ['read_file'], outputKind: 'text', complexity: 1 },
  sensitivity: 'normal', inputRefs: [], outputSchemaRef: { type: 'string', maxLength: 100 },
  route: { preferred: 'local', reason: 'local capable' }, attempt: { current: 1, max: 3 } }; }
function rawPlan() { return { schemaVersion: 1, planId: 'plan1', runId: 'planner-run', goal: 'planner-goal',
  createdBy: 'cloud-planner', dataScopeRef: 'scope', acceptanceCriteria: ['evidence'],
  tasks: [task('t1'), task('t2', ['t1'])], budgetSnapshot: {}, planDigest: '' }; }
function workerResult(text) { return { status: 'completed', contentRef: text, evidenceRefs: ['evidence'],
  selfCheck: { ok: true, issues: [], confidence: 0.9 }, provenance: { untrusted: true } }; }
function review(verdict, instruction) { return { verdict, issues: [], confidence: 0.9,
  revisionInstruction: instruction || '' }; }
function jsonSse(value, usage = { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 }) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: 'stop' }], usage }) + '\n';
}
function textSse(text, usage = { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 }) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage }) + '\n';
}
function collabToolSse(name, args) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-' + name,
    function: { name, arguments: JSON.stringify(args || {}) } }] } }] }) + '\n' +
    'data: {"choices":[{"finish_reason":"tool_calls","delta":{}}],"usage":{"prompt_tokens":6,"completion_tokens":4,"total_tokens":10}}\n';
}
function flowController(responses, options = {}) {
  const calls = [];
  const transport = { async stream(request) {
    calls.push({ role: request.role, endpointRole: request.endpointRef.role, body: request.body });
    const queue = responses[request.role] || [];
    if (!queue.length) throw new Error('unexpected role ' + request.role);
    return sse(queue.shift());
  } };
  const hostCalls = [];
  const controller = new CollaborationController({ config: options.config || config(), endpoints: endpoints(), transport,
    hostTools: [{ type: 'function', function: { name: 'read_file' } }, { type: 'function', function: { name: 'write_file' } }],
    executeBatch: async calls => { hostCalls.push(...calls); return calls.map(call => ({ id: call.id, name: call.name, content: '{"ok":true}' })); },
  });
  return { controller, calls, hostCalls };
}
function successfulResponses() { return {
  'cloud-planner': [jsonSse(rawPlan())],
  'local-worker': [jsonSse(workerResult('t1 draft')), jsonSse(workerResult('t2 result'))],
  'cloud-reviewer': [jsonSse(review('revise', 'improve evidence')), jsonSse(review('pass')), jsonSse(review('pass'))],
  'local-reviser': [jsonSse(workerResult('t1 revised'))],
  'cloud-finalizer': [textSse('final answer')],
}; }
'''


def test_planner_worker_revise_forced_rereview_final_refs_and_cost():
    result = run_case(FLOW + r'''
const fixture = flowController(successfulResponses());
const result = await fixture.controller.start('complete the research', { sessionId: 's1' });
return { result, calls: fixture.calls.map(call => ({ role: call.role, endpointRole: call.endpointRole })),
  provider: providerState.model, final: result.final, hostCalls: fixture.hostCalls };
''', MODULES)
    assert result['result']['status'] == 'completed'
    assert [call['role'] for call in result['calls']] == [
        'cloud-planner', 'local-worker', 'cloud-reviewer', 'local-reviser',
        'cloud-reviewer', 'local-worker', 'cloud-reviewer', 'cloud-finalizer']
    assert all(call['endpointRole'] == ('cloud' if call['role'].startswith('cloud-') else 'local') for call in result['calls'])
    assert result['result']['content'] == 'final answer'
    assert result['final']['resultRefs'][0].startswith('res_plan1_t1_a2_')
    assert result['final']['resultRefs'][1].startswith('res_plan1_t2_a1_')
    assert len(result['final']['reviewDigests']) == 2 and result['final']['finalRef'].startswith('final_plan1_')
    assert result['result']['usage']['totalTokens'] == 80 and result['result']['usage']['cloudTokens'] == 50
    assert abs(result['result']['usage']['cloudCost'] - 0.07) < 1e-9
    assert len(result['result']['usage']['byMessage']) == 8
    assert result['result']['checkpoint']['finalRef'] == result['final']['finalRef']
    assert result['provider'] == 'fake-model' and result['hostCalls'] == []


def test_review_failure_and_bad_schema_never_reach_finalizer():
    result = run_case(FLOW + r'''
const failedReview = successfulResponses(); failedReview['cloud-reviewer'] = [jsonSse(review('fail'))];
const first = flowController(failedReview);
const failed = await first.controller.start('review failure', { sessionId: 's1' });
const bad = flowController({ 'cloud-planner': [textSse('not-json')] });
const schema = await bad.controller.start('bad schema', { sessionId: 's1' });
return { failed, schema, failedCalls: first.calls.map(call => call.role), badCalls: bad.calls.map(call => call.role) };
''', MODULES)
    assert result['failed']['status'] == 'partial' and result['failed']['final'] is None
    assert result['failedCalls'] == ['cloud-planner', 'local-worker', 'cloud-reviewer']
    assert result['schema']['status'] == 'failed' and result['schema']['final'] is None
    assert result['badCalls'] == ['cloud-planner']


def test_budget_exceeded_stops_before_next_cloud_call_and_unknown_usage_is_conservative():
    result = run_case(FLOW + r'''
const responses = successfulResponses();
responses['local-worker'][0] = jsonSse(workerResult('huge'), { prompt_tokens: 10000, completion_tokens: 10000, total_tokens: 20000 });
const fixture = flowController(responses, { config: config({ cloud_token_budget: 10000, total_token_budget: 10000, max_review_rounds: 0 }) });
const result = await fixture.controller.start('budget', { sessionId: 's1' });
const budget = new CollaborationBudget(config(), endpoints());
const reservation = budget.reserve('local-worker', 100);
const first = budget.settle('unknown-1', 'local-worker', null, reservation);
const duplicate = budget.settle('unknown-1', 'local-worker', null, reservation);
return { result, calls: fixture.calls.map(call => call.role), first, duplicate, snapshot: budget.snapshot() };
''', MODULES)
    assert result['result']['status'] == 'budget_exceeded'
    assert result['calls'] == ['cloud-planner', 'local-worker']
    assert result['result']['final'] is None
    assert result['first'] is True and result['duplicate'] is False
    assert result['snapshot']['byMessage']['unknown-1']['estimated'] is True
    assert result['snapshot']['totalTokens'] == 100


def test_cancel_late_worker_cannot_review_or_write_final():
    result = run_case(FLOW + r'''
const fixture = flowController({ 'cloud-planner': [jsonSse(rawPlan())] });
let pending;
fixture.controller.transport = { stream: request => {
  fixture.calls.push({ role: request.role, endpointRole: request.endpointRef.role, body: request.body });
  if (request.role === 'cloud-planner') return Promise.resolve(sse(jsonSse(rawPlan())));
  return new Promise(resolve => { pending = resolve; });
} };
const running = fixture.controller.start('cancel worker', { sessionId: 's1' });
while (!pending) await new Promise(resolve => setTimeout(resolve, 0));
const runId = RunRegistry.current().id;
fixture.controller.cancel(runId);
pending(sse(jsonSse(workerResult('late'))));
const result = await running;
return { result, calls: fixture.calls.map(call => call.role), active: RunRegistry.current() };
''', MODULES)
    assert result['result']['status'] == 'cancelled' and result['result']['content'] == ''
    assert result['result']['final'] is None and result['calls'] == ['cloud-planner', 'local-worker']
    assert result['active'] is None


def test_tool_guard_allows_declared_tool_once_and_rejects_plan_escape_without_replay():
    result = run_case(FLOW + r'''
const responses = successfulResponses();
responses['local-worker'][0] = collabToolSse('read_file', { path: 'a.txt' });
responses['local-worker'].splice(1, 0, jsonSse(workerResult('t1 tool result')));
const allowed = flowController(responses);
const completed = await allowed.controller.start('tool flow', { sessionId: 's1' });
const deniedResponses = successfulResponses(); deniedResponses['local-worker'][0] = collabToolSse('write_file', { path: 'b.txt' });
const denied = flowController(deniedResponses);
const rejected = await denied.controller.start('tool escape', { sessionId: 's1' });
return { completed, rejected, allowedHostCalls: allowed.hostCalls,
  deniedHostCalls: denied.hostCalls, deniedCalls: denied.calls.map(call => call.role) };
''', MODULES)
    assert result['completed']['status'] == 'completed'
    assert [call['name'] for call in result['allowedHostCalls']] == ['read_file']
    assert result['rejected']['status'] == 'failed' and result['rejected']['final'] is None
    assert result['deniedHostCalls'] == []
    assert result['deniedCalls'] == ['cloud-planner', 'local-worker']


def test_disabled_and_local_only_have_zero_collaboration_calls_and_redaction_is_safe():
    result = run_case(FLOW + r'''
const off = new CollaborationController({ config: config({ enabled: false }), endpoints: endpoints(), transport: { stream() { throw new Error('network'); } } });
const ordinary = await off.start('ordinary');
const local = new CollaborationController({ config: config({ upload_scope: 'local_only' }), endpoints: endpoints(), transport: { stream() { throw new Error('network'); } } });
const localOnly = await local.start('local only');
const preview = collaborationPrivacyPreview({ actor: 'cloud-reviewer', taskId: 't1', resultRef: 'r1',
  text: 'Bearer abc123 api_key=secret C:\\work\\secret.txt', scope: 'task_summary_only' });
return { ordinary, localOnly, preview, active: RunRegistry.current() };
''', MODULES)
    assert result['ordinary']['status'] == 'ordinary' and result['localOnly']['status'] == 'ordinary'
    assert 'abc123' not in result['preview']['text'] and 'secret.txt' not in result['preview']['text']
    assert result['preview']['meta']['redactions']
    assert result['active'] is None
