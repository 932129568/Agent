# -*- coding: utf-8 -*-
"""Independent cross-module probes for the G4-QA repair verification."""
from test_generative_artifact import FALLBACK, run_ui_case
from test_generative_data_ref import run_ui_case as run_data_ref_case
from test_generative_registry import DOM
from test_generative_state import MODULES as STATE_MODULES
from test_model_executor_foundation import run_case


def test_production_tool_result_uses_real_run_identity_end_to_end():
    result = run_data_ref_case(r'''
AppState = { currentSessionId: 'session-real',
  uiGenerative: { views: {}, toolResults: {}, toolRevision: 0 } };
const revision = registerUiToolResult({
  id: 'real-call', name: 'mcp_list_servers',
  content: JSON.stringify({ servers: [{ name: 'real-server', transport: 'stdio' }] }),
}, { runId: 73, sessionId: 'session-real', generation: 73 });
const ref = { source: 'tool', toolCallId: 'real-call', selector: 'mcp.servers',
  scope: 'mcp-servers', resultRevision: revision };
const defaultHostResult = DataRefResolver.resolve(
  ref, createUiDataRefHost(), 'Table');
const explicitControl = DataRefResolver.resolve(
  ref, createUiDataRefHost({ runId: 73, sessionId: 'session-real' }), 'Table');
return { revision, defaultHostResult, explicitControl,
  stored: AppState.uiGenerative.toolResults['real-call'] };
''', ['frontend/src/generative/state.js'])
    assert result['explicitControl']['ok'] is True, result
    assert result['defaultHostResult']['ok'] is True, result


def test_skeleton_then_final_spec_restores_selection_and_focus():
    result = run_case(DOM + r'''
El.prototype.querySelectorAll = function(selector) {
  return walk(this).filter(element => {
    if (selector === '[data-entity-id]') return element.getAttribute('data-entity-id') !== null;
    if (selector === '[data-focus-key]') return element.getAttribute('data-focus-key') !== null;
    if (selector === '[data-block-id]') return element.getAttribute('data-block-id') !== null;
    if (selector.startsWith('.')) {
      return String(element.className).split(/\s+/).includes(selector.slice(1));
    }
    return false;
  });
};
El.prototype.closest = function(selector) {
  let element = this;
  while (element) {
    if (selector === '[data-block-id]' && element.getAttribute('data-block-id') !== null) return element;
    element = element.parentNode;
  }
  return null;
};
El.prototype.contains = function(element) { return walk(this).includes(element); };
El.prototype.addEventListener = function() {};
AppState = { currentSessionId: 's', mcpServers: [
  { name: 'server', transport: 'stdio', tool_count: 1, status: 'ok' },
], uiGenerative: { views: {}, toolResults: {}, toolRevision: 0 } };
mcpServersRevision = 1;
const spec = UiSpecFixtures.mcp({ revision: 1, runId: 'r', sessionId: 's' });
const projection = UiProjection.mount(host(), spec,
  { dataRefHost: createUiDataRefHost({ runId: 'r', sessionId: 's' }) });
const before = projection.root.querySelectorAll('[data-entity-id]')[0];
before.setAttribute('data-selected', 'true');
before.focus();
UiGenerativeState.save(UiGenerativeState.capture(projection));
const pending = Object.assign({}, spec, { revision: 2, blocks: [
  { blockId: 'generation-skeleton', component: 'Skeleton',
    props: { lines: 3 }, actions: [] },
] });
projection.commit(pending);
projection.commit(Object.assign({}, spec, { revision: 3 }));
const after = projection.root.querySelectorAll('[data-entity-id]')[0];
return { beforeId: before.getAttribute('data-entity-id'),
  afterId: after.getAttribute('data-entity-id'),
  selected: after.getAttribute('data-selected'),
  focused: document.activeElement === after,
  storedKeys: Object.keys(AppState.uiGenerative.views[spec.specId].entities) };
''', STATE_MODULES)
    assert result['beforeId'] == result['afterId'], result
    assert result['selected'] == 'true', result
    assert result['focused'] is True, result


def test_midflight_cancel_restores_handwritten_fallback():
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
const controller = createUiGenerationController({
  kind: 'test', host: target, fallback: () => fallbackSpec,
  dataRefHost: createUiDataRefHost(),
  generate: ({ signal }) => new Promise(resolve => {
    signal.addEventListener = (event, listener) => signal.listeners.push(listener);
    signal.addEventListener('abort', () => resolve({ status: 'cancelled' }));
  }),
});
const pending = controller.start();
controller.cancel();
const response = await pending;
return { status: response.status, text: textOf(target) };
''')
    assert result['status'] == 'cancelled', result
    assert '手写默认模板' in result['text'], result
