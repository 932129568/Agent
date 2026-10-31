# -*- coding: utf-8 -*-
"""W5E4 real config save, collaboration run and shared timeline UI behavior."""
from test_collaboration_flow import FLOW, MODULES
from test_generative_registry import DOM
from test_model_executor_foundation import run_case

UI_MODULES = MODULES + ['frontend/src/collaboration/recovery.js', 'frontend/src/expert/events.js',
    'frontend/src/analytics/expert.js', 'frontend/src/expert/timeline.js', 'frontend/src/providers/hybrid.js',
    'frontend/src/collaboration/timeline.js', 'frontend/src/collaboration/ui.js']
UI_HELPERS = DOM + FLOW + r'''
document.body = host(); globalThis.document = document;
document.getElementById = id => walk(document.body).find(element => element.id === id) || null;
El.prototype.addEventListener = function(name, listener) { (this.listeners || (this.listeners = {}))[name] = listener; };
function uiElement(id, tag = 'div') { const element = document.createElement(tag); element.id = id;
  document.body.appendChild(element); return element; }
const hybridBlock = uiElement('hybridBlock');
const collaborationBlock = uiElement('collaborationBlock', 'section'); collaborationBlock.hidden = true;
['collaborationStatus', 'collaborationEndpointSummary', 'collaborationPreview', 'expertRunTimeline'].forEach(id => uiElement(id));
const userInput = uiElement('userInput', 'textarea'); userInput.value = 'complete the research';
const collaborationEnabled = uiElement('collaborationEnabled', 'input'); collaborationEnabled.type = 'checkbox';
const collaborationCloudBudget = uiElement('collaborationCloudBudget', 'input');
const collaborationTotalBudget = uiElement('collaborationTotalBudget', 'input');
const collaborationCostBudget = uiElement('collaborationCostBudget', 'input');
const collaborationDeadline = uiElement('collaborationDeadline', 'input');
const collaborationReviewRounds = uiElement('collaborationReviewRounds', 'input');
const collaborationUploadScope = uiElement('collaborationUploadScope', 'select');
['collaborationSaveBtn', 'collaborationPreviewBtn', 'collaborationRunBtn', 'collaborationStopBtn', 'collaborationRecoverBtn'].forEach(id => uiElement(id, 'button'));
let collabSaveCalls = [], failSave = false;
callApi = async (name, args) => {
  if (name !== 'hybrid_save_config') throw new Error('unexpected API ' + name);
  collabSaveCalls.push({ name, args });
  if (failSave) return JSON.stringify({ ok: false, error: { code: 'SAVE_FAILED', message: 'disk full' } });
  return JSON.stringify({ ok: true, config: { strategy: 'auto', collaboration: args[0].collaboration } });
};
function resetUi() {
  collabSaveCalls = []; failSave = false; collaborationUiState.initialized = false;
  collaborationUiState.controller = null; collaborationUiState.result = null; collaborationUiState.running = false;
  collaborationUiState.endpoints = endpoints(); collaborationUiState.transport = null;
  collaborationUiState.config = config(); collaborationUiRenderConfig(collaborationUiState.config);
  document.getElementById('expertRunTimeline').replaceChildren();
}
'''


def test_ui_real_save_and_validation_failure_rollback():
    result = run_case(UI_HELPERS + r'''
resetUi(); collaborationUiInit();
const saved = await collaborationUiSave({ enabled: true, cloud_cost_budget: 1000, endpoint_cache: both() });
failSave = true;
const before = collaborationUiState.config;
const failed = await collaborationUiSave({ enabled: true, cloud_cost_budget: 2, endpoint_cache: both() });
return { saved, failed, before, after: collaborationUiState.config, collabSaveCalls,
  blockParent: collaborationBlock.parentNode === hybridBlock, hidden: collaborationBlock.hidden };
''', UI_MODULES)
    assert result['saved']['ok'] is True and result['failed']['ok'] is False
    assert result['before'] == result['after']
    assert result['collabSaveCalls'][0]['name'] == 'hybrid_save_config'
    assert result['blockParent'] is True and result['hidden'] is False


def test_ui_real_run_renders_forced_rereview_refs_and_usage_once():
    result = run_case(UI_HELPERS + r'''
resetUi(); collaborationUiInit();
const flow = flowController(successfulResponses());
collaborationUiState.transport = flow.controller.transport;
const result = await collaborationRun();
const timeline = new CollaborationTimeline(document.getElementById('expertRunTimeline')).render(result);
return { result, timeline, text: textOf(document.getElementById('expertRunTimeline')),
  calls: flow.calls.map(call => call.role) };
''', UI_MODULES)
    assert result['result']['status'] == 'completed'
    assert result['timeline']['projection']['tasks'][0]['attempt'] == 2
    assert 'finalRef=' in result['text'] and 'reviewDigest=' in result['text']
    assert 'local-reviser' in result['text'] and 'cloud-finalizer' in result['text']
    assert result['timeline']['shared']['usage']['total']['total_tokens'] == 80
    assert result['timeline']['projection']['usage']['cloudCost'] == result['result']['usage']['cloudCost']
    assert result['calls'][-1] == 'cloud-finalizer'


def test_ui_off_zero_calls_and_recovery_uses_new_parent_without_replay():
    result = run_case(UI_HELPERS + r'''
resetUi(); collaborationUiInit();
collaborationUiRenderConfig(config({ enabled: false }));
const off = await collaborationRun();
collaborationUiRenderConfig(config());
const firstFlow = flowController(successfulResponses());
collaborationUiState.transport = firstFlow.controller.transport;
const first = await collaborationRun();
const resumeFlow = flowController({ 'cloud-finalizer': [textSse('recovered final')] });
collaborationUiState.transport = resumeFlow.controller.transport;
const recovered = await collaborationRecover();
return { off, first, recovered, resumeCalls: resumeFlow.calls.map(call => call.role),
  active: RunRegistry.current() };
''', UI_MODULES)
    assert result['off']['status'] == 'ordinary'
    assert result['first']['status'] == 'completed'
    assert result['recovered']['status'] == 'completed'
    assert result['recovered']['parentRunId'] == result['first']['runId']
    assert result['resumeCalls'] == ['cloud-finalizer']
    assert result['recovered']['usage']['totalTokens'] == 10
    assert result['active'] is None
