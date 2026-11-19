# -*- coding: utf-8 -*-
"""W3C3B full shared ModelExecutor and ToolRuntime behavior tests."""
from pathlib import Path

from helpers.frontend import read_frontend_source
from test_model_executor_foundation import run_case

ROOT = Path(__file__).resolve().parent.parent
EXECUTOR = 'frontend/src/agent/model-executor.js'
RUNTIME = 'frontend/src/agent/tool-runtime.js'
PARSER = 'frontend/src/agent/sse-parser.js'
BUILDER = 'frontend/src/agent/request-builder.js'
RUN = 'frontend/src/agent/run-controller.js'
MODULES = [EXECUTOR, RUNTIME, PARSER, BUILDER]
RESPONSE_HELPERS = r'''
function response(events) {
  const wire = events.map(event => 'data: ' + JSON.stringify(event) + '\n').join('');
  const bytes = new TextEncoder().encode(wire);
  let sent = false;
  return { ok: true, status: 200, body: { getReader() {
    return { async read() {
      if (sent) return { done: true };
      sent = true;
      return { done: false, value: bytes };
    } };
  } }, text: async () => '' };
}
function contentEvent(content, usage) {
  const event = { choices: [{ delta: { content }, finish_reason: 'stop' }] };
  if (usage) event.usage = usage;
  return event;
}
function toolEvent(name, id, args, usage) {
  const event = { choices: [{ delta: { tool_calls: [
    { id, function: { name, arguments: args } },
  ] }, finish_reason: 'tool_calls' }] };
  if (usage) event.usage = usage;
  return event;
}
'''


def test_fake_transport_complete_two_round_tool_loop_and_usage_commit():
    result = run_case(RESPONSE_HELPERS + r'''
const calls = [];
const commits = [];
let turn = 0;
const transport = { async stream(request) {
  calls.push({ endpoint: request.endpoint, body: request.body });
  turn++;
  if (turn === 1) return response([
    { choices: [{ delta: { content: 'working' } }] },
    toolEvent('read_file', 'read-1', '{"path":"a.txt"}', { total_tokens: 3 }),
  ]);
  return response([contentEvent('done', { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 })]);
} };
const executed = [];
const context = { messages: [], runId: 'run-1', sessionId: 's1', generation: 1 };
const execution = await ModelExecutor.execute({
  context,
  endpoint: { endpoint: 'https://actor.invalid', apiKey: 'actor-key', local: false },
  transport,
  tools: createToolRuntime({ async executeTool(call) {
    executed.push(call.name);
    return JSON.stringify({ ok: true, output: call.name });
  } }),
  observer: {
    beforeRound: async () => ({ body: { model: 'fake-model', messages: context.messages }, model: 'fake-model' }),
    onAssistant: async ({ assistant }) => { commits.push({ role: assistant.role, usage: assistant.usage }); },
  },
});
return { execution, calls, commits, executed,
         roles: context.messages.map(message => message.role) };
''', MODULES)
    execution = result['execution']
    assert execution['status'] == 'completed'
    assert execution['content'] == 'done'
    assert execution['modelTurns'] == 2
    assert execution['usage']['total_tokens'] == 7
    assert execution['partialContent'] == 'done'
    assert len(execution['newMessages']) == 3
    assert result['roles'] == ['assistant', 'tool', 'assistant']
    assert result['executed'] == ['read_file']
    assert len(result['commits']) == 2
    assert result['commits'][0]['usage']['total_tokens'] == 3
    assert result['calls'][0]['endpoint'] == 'https://actor.invalid'
    assert result['calls'][0]['body']['model'] == 'fake-model'
    assert 'apiKey' not in execution


def test_independent_actor_contexts_and_endpoint_refs_do_not_cross_contaminate():
    result = run_case(RESPONSE_HELPERS + r'''
const requests = [];
const transport = { async stream(request) {
  requests.push({ endpoint: request.endpoint, apiKey: request.apiKey,
                  model: request.body.model });
  return response([contentEvent(request.body.model + '-done')]);
} };
const execute = (actor, endpoint, key) => ModelExecutor.execute({
  context: { messages: [], runId: actor, sessionId: actor, generation: 1, memberRunId: actor + '-member' },
  endpoint: { endpoint, apiKey: key, local: false }, transport,
  tools: createToolRuntime({}),
  observer: { beforeRound: async () => ({ body: { model: actor, messages: [] }, model: actor }) },
});
const a = await execute('actor-a', 'https://a.invalid', 'key-a');
const b = await execute('actor-b', 'https://b.invalid', 'key-b');
return { requests, a: a.content, b: b.content,
         aMessages: a.newMessages.length, bMessages: b.newMessages.length };
''', MODULES)
    assert result['a'] == 'actor-a-done' and result['b'] == 'actor-b-done'
    assert result['requests'][0]['endpoint'] == 'https://a.invalid'
    assert result['requests'][0]['apiKey'] == 'key-a'
    assert result['requests'][1]['endpoint'] == 'https://b.invalid'
    assert result['requests'][1]['apiKey'] == 'key-b'
    assert result['aMessages'] == 1 and result['bMessages'] == 1


def test_tool_runtime_write_serial_guard_denial_and_result_order():
    result = run_case(r'''
let activeWrites = 0;
let maxActiveWrites = 0;
const executed = [];
const runtime = createToolRuntime({
  guard: async call => call.name !== 'write_file' || call.id !== 'denied',
  executeTool: async call => {
    if (call.name === 'write_file') {
      activeWrites++;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
    }
    executed.push(call.id);
    await Promise.resolve();
    if (call.name === 'write_file') activeWrites--;
    return JSON.stringify({ ok: true, id: call.id });
  },
});
const denied = await runtime.execute({ id: 'denied', name: 'write_file' }, {});
const deniedCount = executed.length;
const calls = [
  { id: 'w1', name: 'write_file' }, { id: 'w2', name: 'write_file' },
  { id: 'r1', name: 'read_file' },
];
const results = await runtime.executeBatch(calls, {});
return { denied: JSON.parse(denied.content), deniedCount, maxActiveWrites,
         executed, resultIds: results.map(result => result.id) };
''', [RUNTIME])
    assert result['denied']['error']['code'] == 'GUARD_DENIED'
    assert result['deniedCount'] == 0
    assert result['maxActiveWrites'] == 1
    assert result['executed'] == ['w1', 'w2', 'r1']
    assert result['resultIds'] == ['w1', 'w2', 'r1']


def test_cancelled_late_usage_does_not_commit_assistant_or_messages():
    result = run_case(RESPONSE_HELPERS + r'''
let active = true;
let commits = 0;
const context = { messages: [{ role: 'user', content: 'old' }], runId: 'r1', sessionId: 's1' };
const execution = await ModelExecutor.execute({
  context, endpoint: { endpoint: 'https://x.invalid', apiKey: 'x' },
  transport: { async stream() {
    return response([contentEvent('late', { total_tokens: 99 })]);
  } },
  tools: createToolRuntime({}),
  observer: {
    beforeRound: async () => ({ body: { messages: context.messages } }),
    isActive: () => active,
    onUsage: () => { active = false; },
    onAssistant: async () => { commits++; },
  },
});
return { execution, commits, messages: context.messages };
''', MODULES)
    assert result['execution']['status'] == 'cancelled'
    assert result['execution']['usage'] is None
    assert result['execution']['newMessages'] == []
    assert result['commits'] == 0
    assert result['messages'] == [{'role': 'user', 'content': 'old'}]


def test_sixty_round_limit_length_partial_and_budget_terminal_shapes():
    result = run_case(RESPONSE_HELPERS + r'''
let count = 0;
const transport = { async stream() {
  count++;
  return response([toolEvent('read_file', 'read-' + count, '{}')]);
} };
const limited = await ModelExecutor.execute({
  context: { messages: [], runId: 'limit', sessionId: 's' },
  endpoint: { endpoint: 'https://limit.invalid', apiKey: 'x' }, transport,
  tools: createToolRuntime({ executeTool: async call => '{}' }),
  observer: { beforeRound: async () => ({ body: { messages: [] } }) },
  limits: { maxRounds: 60 },
});
const length = await ModelExecutor.execute({
  context: { messages: [], runId: 'length', sessionId: 's' },
  endpoint: { endpoint: 'https://length.invalid', apiKey: 'x' },
  transport: { async stream() { return response([
    { choices: [{ delta: { content: 'part' }, finish_reason: 'length' }] },
  ]); } },
  tools: createToolRuntime({}),
  observer: { beforeRound: async () => ({ body: { messages: [] } }) },
});
let transportCalls = 0;
const budget = await ModelExecutor.execute({
  context: { messages: [], runId: 'budget', sessionId: 's' },
  endpoint: { endpoint: 'https://budget.invalid', apiKey: 'x' },
  transport: { async stream() { transportCalls++; return response([]); } },
  tools: createToolRuntime({}),
  observer: { beforeRound: async () => ({ stop: true, status: 'budget', finished: true }) },
});
return { limited: { status: limited.status, turns: limited.modelTurns,
                    messages: limited.newMessages.length },
         length: { status: length.status, partial: length.partialContent },
         budget: { status: budget.status, finished: budget.finished },
         transportCalls };
''', MODULES)
    assert result['limited'] == {'status': 'limit', 'turns': 60, 'messages': 120}
    assert result['length'] == {'status': 'length', 'partial': 'part'}
    assert result['budget'] == {'status': 'budget', 'finished': True}
    assert result['transportCalls'] == 0


def test_http_error_preserves_headers_for_legacy_humanization():
    result = run_case(r'''
const execution = await ModelExecutor.execute({
  context: { messages: [], runId: 'http', sessionId: 's' },
  endpoint: { endpoint: 'https://x.invalid', apiKey: 'x' },
  transport: { async stream() {
    return { ok: false, status: 429,
      headers: { forEach(callback) { callback('10', 'x-ratelimit-remaining'); } },
      text: async () => 'rate limited' };
  } },
  tools: createToolRuntime({}),
  observer: { beforeRound: async () => ({ body: { messages: [] } }) },
});
return { status: execution.status, headers: execution.error.headers };
''', MODULES)
    assert result == {'status': 'error', 'headers': {'x-ratelimit-remaining': '10'}}


def test_executor_has_no_dom_or_global_active_and_run_controller_uses_it():
    executor = read_frontend_source(str(ROOT), EXECUTOR)
    controller = read_frontend_source(str(ROOT), RUN)
    for forbidden in ('document', 'localStorage', 'providerState', 'AppState',
                      '__agentActiveRun'):
        assert forbidden not in executor
    assert 'ModelExecutor.execute({' in controller
    assert 'createToolRuntime({ executeBatch })' in controller
    assert 'hybridOnUsage(usage, currentModel)' in controller
    assert 'accumulateUsage(s, assistantMsg.usage)' in controller
    assert 'for (let round = 0; round < 60; round++)' not in controller
