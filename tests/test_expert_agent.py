# -*- coding: utf-8 -*-
"""W5B real single-agent loop with fake package/transport only."""
from test_model_executor_foundation import run_case

MODULES = [
    'frontend/src/agent/request-builder.js', 'frontend/src/agent/sse-parser.js',
    'frontend/src/agent/model-executor.js', 'frontend/src/agent/tool-runtime.js',
    'frontend/src/agent/run-registry.js', 'frontend/src/expert/schemas.js',
    'frontend/src/expert/package-store.js', 'frontend/src/expert/context.js',
    'frontend/src/expert/events.js', 'frontend/src/expert/controller.js',
]
HELPERS = r'''
globalThis.AbortController = class {
  constructor() { this.signal = { aborted: false, listeners: [],
    addEventListener: (event, fn) => this.signal.listeners.push(fn) }; }
  abort() { if (this.signal.aborted) return; this.signal.aborted = true;
    this.signal.listeners.forEach(fn => fn()); }
};
__agentActiveRun = null; __agentRunSeq = 0; ModelTransport = {};
AppState = { currentSessionId: 's1', sessions: [{ id: 's1', messages: [] }] };
let saveCalls = 0;
saveSessions = async () => { saveCalls++; };
accumulateUsage = (session, usage) => { session.spent = (session.spent || 0) + usage.total_tokens; };
function snapshot(overrides = {}) {
  return { id: 'demo.expert', snapshot_id: 'a'.repeat(64), kind: 'agent', version: '1.0.0',
    metadata: { agentName: 'researcher', settings: { tools: ['read_file'] } },
    agents: [{ id: 'researcher', path: 'agents/researcher.md', sha256: 'agent-sha', description: 'research' }],
    team: { leadAgent: 'researcher', memberAgents: [] },
    skills: [{ name: 'demo', path: 'skills/demo/SKILL.md', sha256: 'skill-sha',
      resources: [{ path: 'skills/demo/references/guide.md', sha256: 'guide-sha' }],
      scripts: [{ path: 'skills/demo/scripts/no.py', executable: false }] }],
    resources: [{ path: 'skills/demo/references/guide.md', sha256: 'guide-sha' }],
    limits: { maxTurns: 40, maxToolCalls: 120, runDeadlineSec: 1800 },
    validation: { valid: true, warnings: [] }, ...overrides };
}
function sse(text) {
  const bytes = new TextEncoder().encode(text);
  return { ok: true, status: 200, body: { getReader() { let sent = false; return {
    read: async () => sent ? { done: true } : (sent = true, { done: false, value: bytes }) }; } } };
}
const toolSse = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}\n' +
  'data: {"choices":[{"finish_reason":"tool_calls","delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n' +
  'data: [DONE]\n';
const finalSse = 'data: {"choices":[{"delta":{"content":"最终答案"}}]}\n' +
  'data: {"choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}\n' +
  'data: [DONE]\n';
function makeController(options = {}) {
  const apiCalls = [], bodies = [], toolCalls = [];
  const store = new ExpertPackageStore({ call: async (name, args) => {
    apiCalls.push({ name, args });
    if (name === 'expert_get') return { ok: true, package: options.snapshot || snapshot() };
    if (name === 'expert_read_resource') {
      const path = args[1];
      if (path.includes('scripts')) throw new Error('script read attempted');
      const text = path === 'agents/researcher.md' ? 'PACKAGE UNTRUSTED RULE'
        : path.endsWith('SKILL.md') ? 'SKILL UNTRUSTED' : 'REFERENCE UNTRUSTED';
      return { ok: true, path, sha256: 'sha-' + path, text, truncated: false,
        provenance: { snapshotId: args[0], path } };
    }
    throw new Error('unexpected package API ' + name);
  }});
  let round = 0;
  const controller = new ExpertRunController({ store,
    endpoint: { endpoint: 'http://fake', apiKey: '', model: 'fake-model' },
    hostTools: [{ type: 'function', function: { name: 'read_file' } },
      { type: 'function', function: { name: 'write_file' } }],
    executeBatch: async calls => { toolCalls.push(...calls); return calls.map(call => ({ id: call.id,
      name: call.name, content: '{"ok":true}' })); },
    transport: { async stream(request) { bodies.push(request.body);
      return options.rounds ? options.rounds[round++] : (round++ === 0 ? sse(toolSse) : sse(finalSse)); } },
  });
  return { controller, store, apiCalls, bodies, toolCalls,
    session: AppState.sessions[0], save: () => saveCalls };
}
'''


def test_selection_lazy_skill_real_sse_tool_followup_terminal_usage_and_events():
    result = run_case(HELPERS + r'''
const fixture = makeController();
const result = await fixture.controller.start({ packageId: 'demo.expert', skillName: 'demo',
  resourcePaths: ['skills/demo/references/guide.md'] }, { text: 'research this', sessionId: 's1' });
return { result, apiCalls: fixture.apiCalls, bodies: fixture.bodies,
  toolCalls: fixture.toolCalls, events: fixture.session.expert.events,
  reads: fixture.store.reads, spent: fixture.session.spent, active: RunRegistry.current() };
''', MODULES)
    assert result['result']['status'] == 'completed'
    assert result['result']['content'] == '最终答案'
    assert result['result']['parentRunId'] is None
    assert [call['name'] for call in result['apiCalls']] == [
        'expert_get', 'expert_read_resource', 'expert_read_resource', 'expert_read_resource']
    assert result['reads'][-1]['path'] == 'skills/demo/references/guide.md'
    assert len(result['bodies']) == 2
    assert [item['function']['name'] for item in result['bodies'][0]['tools']] == ['read_file']
    assert any(message['role'] == 'tool' for message in result['bodies'][1]['messages'])
    assert result['toolCalls'][0]['name'] == 'read_file'
    assert len(result['result']['newMessages']) == 3
    assert len(result['result']['usage']['byMessage']) == 2
    assert result['result']['usage']['totals']['total_tokens'] == 12
    assert result['spent'] == 12 and len(result['result']['messageRefs']) == 2
    assert {event['type'] for event in result['events']} >= {'run_started', 'assistant', 'tool_result', 'run_terminal'}
    assert result['active'] is None


def test_unselected_is_ordinary_zero_api_zero_session_diff():
    result = run_case(HELPERS + r'''
const fixture = makeController();
const before = JSON.stringify(AppState.sessions);
const result = await fixture.controller.start(null, { text: 'ordinary', sessionId: 's1' });
return { result, before, after: JSON.stringify(AppState.sessions), apiCalls: fixture.apiCalls,
  bodies: fixture.bodies, active: RunRegistry.current() };
''', MODULES)
    assert result['result']['status'] == 'ordinary'
    assert result['before'] == result['after']
    assert result['apiCalls'] == [] and result['bodies'] == [] and result['active'] is None


def test_snapshot_cache_and_lazy_no_skill_reads():
    result = run_case(HELPERS + r'''
const fixture = makeController();
const first = await fixture.controller.store.get('demo.expert');
const second = await fixture.controller.store.get('demo.expert');
const actor = await fixture.controller.store.loadActor(first, 'researcher');
return { same: first === second, actorText: actor.text,
  calls: fixture.apiCalls.map(call => call.name), reads: fixture.store.reads };
''', MODULES)
    assert result['same'] is True and result['actorText'] == 'PACKAGE UNTRUSTED RULE'
    assert result['calls'] == ['expert_get', 'expert_read_resource']
    assert len(result['reads']) == 1
