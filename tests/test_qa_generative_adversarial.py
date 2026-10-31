# -*- coding: utf-8 -*-
"""Independent QA adversarial coverage for G1-G4 acceptance boundaries."""
from test_generative_artifact import FALLBACK, run_ui_case
from test_generative_registry import DOM
from test_generative_state import HELPERS, MODULES as STATE_MODULES
from test_model_executor_foundation import run_case


def test_strict_fallback_handles_real_model_executor_error():
    result = run_ui_case(r'''
const bodies = [];
const transport = { async stream(request) {
  bodies.push(request.body);
  return { ok: false, status: 400,
    text: async () => 'response_format json_schema unsupported by endpoint' };
} };
const generate = productionUiGenerate({
  transport, endpoint: { endpoint: 'http://fake', apiKey: '' }, model: 'm',
});
const response = await generate({ messages: [], onText() {}, strictSchema: true });
return { calls: bodies.length, status: response.status,
  schemaFallback: !!response.schemaFallback,
  error: String(response.error && response.error.message || response.error),
  strictFlags: bodies.map(body => !!(body.response_format && body.response_format.json_schema.strict)) };
''')
    assert result['calls'] == 2, result
    assert result['strictFlags'] == [True, False], result
    assert result['schemaFallback'] is True, result


def test_cancel_rejects_late_model_delta_and_final_commit():
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
const valid = '{"schemaVersion":1,"block":{"blockId":"late","component":"TextBlock","props":{"text":"迟到内容不得提交"},"actions":[]}}';
let publishLate;
const controller = createUiGenerationController({
  kind: 'test', host: target, fallback: () => fallbackSpec,
  dataRefHost: createUiDataRefHost(),
  generate: ({ onText }) => new Promise(resolve => {
    publishLate = () => { onText(valid); resolve({ status: 'completed' }); };
  }),
});
const pending = controller.start();
controller.cancel();
publishLate();
const response = await pending;
return { status: response.status, text: textOf(target) };
''')
    assert result['status'] == 'cancelled', result
    assert '迟到内容不得提交' not in result['text'], result


def test_tool_ref_from_another_run_is_forbidden():
    result = run_ui_case(r'''
AppState = { currentSessionId: 'current-session' };
globalThis.__uiToolResults = {
  shared: { value: [{ name: 'cross-run-secret', transport: 'stdio' }],
    revision: 7, allowed: true, runId: 'other-run', sessionId: 'other-session' },
};
const resolved = DataRefResolver.resolve({
  source: 'tool', toolCallId: 'shared', selector: 'mcp.servers',
  scope: 'mcp-servers', resultRevision: 7,
}, createUiDataRefHost(), 'Table');
return resolved;
''')
    assert result['ok'] is False and result['code'] == 'forbidden', result


def test_plan_step_replacement_at_same_index_has_new_entity_key():
    result = run_ui_case(r'''
planCurrent = { task_id: 'p', steps: [{ text: '旧实体', status: 'doing' }] };
planUiRevision = 1;
AppState = { currentSessionId: 's' };
const ref = { source: 'appState', selector: 'plan.steps', scope: 'current-plan' };
const before = DataRefResolver.resolve(ref, createUiDataRefHost(), 'Timeline');
planCurrent = { task_id: 'p', steps: [{ text: '同位置的新实体', status: 'doing' }] };
planUiRevision = 2;
const after = DataRefResolver.resolve(ref, createUiDataRefHost(), 'Timeline');
return { before: before.entityKeys, after: after.entityKeys };
''')
    assert result['before'] != result['after'], result


def test_transient_skeleton_does_not_delete_saved_entity_state():
    result = run_case(DOM + HELPERS + r'''
AppState = { uiGenerative: { views: {} } };
const oldEntity = entity('old', 'block/old');
oldEntity.setAttribute('data-selected', 'true');
const oldRoot = rootFor([oldEntity]);
const saved = UiGenerativeState.capture({
  current: specFor('run', 1), root: oldRoot, document,
});
UiGenerativeState.save(saved);
const skeleton = specFor('run', 2);
skeleton.blocks = [{ blockId: 'generation-skeleton', component: 'Skeleton',
  props: { lines: 3 }, actions: [] }];
UiGenerativeState.restore({
  current: skeleton, root: rootFor([]), document,
}, saved);
return { savedKeys: Object.keys(saved.entities),
  storedKeys: Object.keys(AppState.uiGenerative.views['state-spec'].entities) };
''', STATE_MODULES)
    assert result['savedKeys'] == ['block/old'], result
    assert result['storedKeys'] == ['block/old'], result


def test_unbound_business_numbers_are_not_accepted_as_real_data():
    result = run_ui_case(FALLBACK + r'''
const fabricated = '{"schemaVersion":1,"block":{"blockId":"fake-chart","component":"BarChart","props":{"items":[{"label":"伪造收入","value":999999}]},"actions":[]}}';
const response = await generateUiSpec({
  kind: 'test', fallbackSpec, host: host(), maxRepairs: 0,
  dataRefHost: createUiDataRefHost(),
  generate: async ({ onText }) => {
    onText(fabricated);
    return { status: 'completed' };
  },
});
return { status: response.status, text: textOf(response.projection.root),
  reason: response.reason || '' };
''')
    assert result['status'] == 'fallback', result
    assert '999999' not in result['text'], result


def test_unknown_component_preserves_metric_and_reason():
    result = run_ui_case(FALLBACK + r'''
const response = await generateUiSpec({
  kind: 'test', fallbackSpec, host: host(), maxRepairs: 0,
  dataRefHost: createUiDataRefHost(),
  generate: async ({ onText }) => {
    onText('{"schemaVersion":1,"block":{"blockId":"x","component":"Unknown","props":{},"actions":[]}}');
    return { status: 'completed' };
  },
});
return { status: response.status, reason: response.reason,
  metrics: response.projection.metrics };
''')
    assert result['status'] == 'fallback', result
    assert result['reason'] == 'unknown_component', result


def test_untrusted_click_cannot_execute_action():
    result = run_case(r'''
UiGenerativeSettings.actionsEnabled = true;
let calls = 0;
class FakeElement {
  constructor(tag, text) {
    this.tagName = tag; this.textContent = text || ''; this.children = [];
    this.attributes = {}; this.listeners = {};
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) {
    return this.attributes[name] === undefined ? null : this.attributes[name];
  }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  appendChild(child) { this.children.push(child); return child; }
}
const wrapper = new FakeElement('article', '授权文本');
wrapper.attributes['data-block-id'] = 'b';
const projection = {
  root: { querySelectorAll: () => [wrapper] },
  current: { blocks: [{ blockId: 'b', actions: [{ name: 'copy' }] }] },
  options: { actionPermission: () => true,
    actionHandlers: { copy: async () => { calls++; } } },
  metrics: {},
  createElement: (tag, className, text) => new FakeElement(tag, text),
};
uiActionAfterRender(projection);
const row = wrapper.children[0];
const button = row.children[0];
await button.listeners.click({ isTrusted: false });
return { calls, metrics: projection.metrics };
''', STATE_MODULES)
    assert result['calls'] == 0, result
    assert not result['metrics'].get('actions_executed'), result


def test_dom_action_permission_fails_closed_without_host_permission():
    result = run_case(r'''
const allowed = uiActionPermission({ options: {} },
  { blockId: 'unbound', actions: [{ name: 'copy' }] }, 'copy');
return { allowed };
''', STATE_MODULES)
    assert result['allowed'] is False, result


def test_render_failure_does_not_advance_current_revision():
    result = run_ui_case(r'''
const projection = UiProjection.mount(host(), simple('已显示旧视图', 5));
projection.createElement = () => { throw new Error('injected_dom_failure'); };
let thrown = '';
try { projection.commit(simple('未显示的新视图', 6)); }
catch (error) { thrown = error.message; }
return { thrown, currentRevision: projection.current.revision,
  currentText: projection.current.blocks[0].props.text,
  domText: textOf(projection.root) };
''')
    assert result['thrown'] == 'injected_dom_failure', result
    assert result['currentRevision'] == 5, result
    assert result['currentText'] == '已显示旧视图', result
