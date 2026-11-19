# -*- coding: utf-8 -*-
"""Independent QA2 probes for identity, cancellation and payload boundaries."""
from test_generative_artifact import FALLBACK, run_ui_case
from test_generative_data_ref import run_ui_case as run_data_ref_case


def test_run_registry_current_allows_current_and_rejects_other_run():
    result = run_data_ref_case(r'''
RunRegistry = { current: () => ({ id: 73, sessionId: 'session-real' }) };
AppState = { currentSessionId: 'session-real',
  uiGenerative: { views: {}, toolResults: {}, toolRevision: 0 } };
const currentRevision = registerUiToolResult({
  id: 'current-call', name: 'mcp_list_servers',
  content: JSON.stringify({ servers: [{ name: 'current-server' }] }),
}, { runId: 73, sessionId: 'session-real', generation: 73 });
const oldRevision = registerUiToolResult({
  id: 'old-call', name: 'mcp_list_servers',
  content: JSON.stringify({ servers: [{ name: 'old-server' }] }),
}, { runId: 72, sessionId: 'session-real', generation: 72 });
const dataHost = createUiDataRefHost();
const current = DataRefResolver.resolve({ source: 'tool', toolCallId: 'current-call',
  selector: 'mcp.servers', scope: 'mcp-servers', resultRevision: currentRevision }, dataHost, 'Table');
const old = DataRefResolver.resolve({ source: 'tool', toolCallId: 'old-call',
  selector: 'mcp.servers', scope: 'mcp-servers', resultRevision: oldRevision }, dataHost, 'Table');
return { identity: dataHost.identity, current, old };
''', ['frontend/src/generative/state.js'])
    assert result['identity']['runId'] == '73', result
    assert result['current']['ok'] is True, result
    assert result['old']['ok'] is False and result['old']['code'] == 'forbidden', result


def test_stale_last_run_cannot_override_current_session():
    result = run_data_ref_case(r'''
AppState = { currentSessionId: 'old-session',
  uiGenerative: { views: {}, toolResults: {}, toolRevision: 0 } };
const revision = registerUiToolResult({
  id: 'old-call', name: 'mcp_list_servers',
  content: JSON.stringify({ servers: [{ name: 'old-session-secret' }] }),
}, { runId: 71, sessionId: 'old-session', generation: 71 });
AppState.currentSessionId = 'new-session';
const dataHost = createUiDataRefHost();
const resolved = DataRefResolver.resolve({ source: 'tool', toolCallId: 'old-call',
  selector: 'mcp.servers', scope: 'mcp-servers', resultRevision: revision }, dataHost, 'Table');
return { identity: dataHost.identity, resolved, currentSessionId: AppState.currentSessionId };
''', ['frontend/src/generative/state.js'])
    assert result['resolved']['ok'] is False, result
    assert result['resolved']['code'] == 'forbidden', result


def test_cancelled_ticket_fallback_cannot_overwrite_newer_view():
    result = run_ui_case(FALLBACK + r'''
globalThis.AbortController = class {
  constructor() { this.signal = { aborted: false, listeners: [] }; }
  abort() {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    this.signal.listeners.forEach(listener => listener());
  }
};
const target = host();
const calls = [];
const controller = createUiGenerationController({
  kind: 'test', host: target, fallback: () => fallbackSpec,
  dataRefHost: createUiDataRefHost(),
  generate: ({ onText }) => new Promise(resolve => calls.push({ onText, resolve })),
});
const first = controller.start();
controller.cancel();
const second = controller.start();
const valid = '{"schemaVersion":1,"block":{"blockId":"new","component":"TextBlock","props":{"text":"新 ticket 内容"},"actions":[]}}';
calls[1].onText(valid);
calls[1].resolve({ status: 'completed' });
const secondResult = await second;
const afterSecond = textOf(target);
calls[0].onText('{"schemaVersion":1,"block":{"blockId":"old","component":"TextBlock","props":{"text":"旧迟到内容"},"actions":[]}}');
calls[0].resolve({ status: 'completed' });
const firstResult = await first;
return { firstStatus: firstResult.status, secondStatus: secondResult.status,
  afterSecond, afterFirst: textOf(target) };
''')
    assert result['firstStatus'] == 'cancelled', result
    assert result['secondStatus'] == 'completed', result
    assert '新 ticket 内容' in result['afterSecond'], result
    assert '新 ticket 内容' in result['afterFirst'], result
    assert '手写默认模板' not in result['afterFirst'], result


def test_payload_limits_and_cycles_do_not_write_state():
    result = run_data_ref_case(r'''
AppState = { currentSessionId: 's',
  uiGenerative: { views: {}, toolResults: {}, toolRevision: 0 } };
const context = { runId: 1, sessionId: 's', generation: 1 };
const make = (id, content, name = 'mcp_list_servers') =>
  registerUiToolResult({ id, name, content }, context);
const wrapper = value => '{"servers":[{"name":"' + value + '"}]}';
const overhead = new TextEncoder().encode(wrapper('')).length;
const exactBytes = wrapper('x'.repeat(128 * 1024 - overhead));
const exactBytesRevision = make('exact-bytes', exactBytes);
let depthValue = {};
for (let index = 0; index < 8; index++) depthValue = { child: depthValue };
const depthRevision = make('depth-8', depthValue);
const arrayRevision = make('array-200', { servers: Array.from({ length: 200 }, () => ({})) });
const baseline = JSON.stringify(AppState.uiGenerative);
const rejected = [];
const check = (id, content, name) => {
  const returned = make(id, content, name);
  const unchanged = JSON.stringify(AppState.uiGenerative) === baseline;
  rejected.push({ id, returned, unchanged });
};
check('too-many-bytes', wrapper('x'.repeat(128 * 1024)));
let tooDeep = {};
for (let index = 0; index < 9; index++) tooDeep = { child: tooDeep };
check('too-deep', tooDeep);
const tooManyNodes = {};
for (let index = 0; index < 2049; index++) tooManyNodes['k' + index] = index;
check('too-many-nodes', tooManyNodes);
check('too-long-array', { servers: Array.from({ length: 201 }, () => ({})) });
const cyclic = {}; cyclic.self = cyclic;
check('cyclic', cyclic);
check('not-whitelisted', { servers: [] }, 'read_file');
return { exactBytesRevision, depthRevision, arrayRevision, rejected,
  count: Object.keys(AppState.uiGenerative.toolResults).length };
''', ['frontend/src/generative/state.js'])
    assert result['exactBytesRevision'] > 0, result
    assert result['depthRevision'] > 0, result
    assert result['arrayRevision'] > 0, result
    assert result['count'] == 3, result
    assert all(item['returned'] == 0 and item['unchanged'] for item in result['rejected']), result


def test_pre_and_midflight_cancel_commit_fallback_exactly_once():
    result = run_ui_case(FALLBACK + r'''
const makeProjection = () => {
  const projection = UiProjection.mount(host(), fallbackSpec,
    { dataRefHost: createUiDataRefHost() });
  const original = projection.commit.bind(projection);
  const state = { projection, fallbackCommits: 0 };
  projection.commit = spec => {
    if (spec.blocks.length === 1 && spec.blocks[0].component === 'TextBlock' &&
        spec.blocks[0].props.text === '手写默认模板') state.fallbackCommits++;
    return original(spec);
  };
  return state;
};
const pre = makeProjection();
let preCalls = 0;
const preResult = await generateUiSpec({ kind: 'test', fallbackSpec,
  projection: pre.projection, dataRefHost: createUiDataRefHost(),
  signal: { aborted: true }, generate: async () => { preCalls++; return { status: 'completed' }; } });
const mid = makeProjection();
const signal = { aborted: false };
let active = true;
const midResult = await generateUiSpec({ kind: 'test', fallbackSpec,
  projection: mid.projection, dataRefHost: createUiDataRefHost(), signal,
  isActive: () => active,
  generate: async ({ onText }) => {
    active = false; signal.aborted = true;
    onText('{"schemaVersion":1,"block":{"blockId":"late","component":"TextBlock","props":{"text":"迟到"},"actions":[]}}');
    return { status: 'completed' };
  } });
return { preStatus: preResult.status, preCalls, preFallbacks: pre.fallbackCommits,
  midStatus: midResult.status, midFallbacks: mid.fallbackCommits,
  midText: textOf(mid.projection.root) };
''')
    assert result['preStatus'] == 'cancelled' and result['preCalls'] == 0, result
    assert result['preFallbacks'] == 1, result
    assert result['midStatus'] == 'cancelled' and result['midFallbacks'] == 1, result
    assert '手写默认模板' in result['midText'] and '迟到' not in result['midText'], result
