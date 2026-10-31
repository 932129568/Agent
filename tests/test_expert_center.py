# -*- coding: utf-8 -*-
"""W5D center package API timing and one-shot real controller selection."""
from test_expert_team import TEAM_HELPERS, TEAM_MODULES
from test_generative_registry import DOM
from test_model_executor_foundation import run_case

CENTER_MODULES = TEAM_MODULES + ['frontend/src/expert/timeline.js', 'frontend/src/expert/center.js']
CENTER_DOM = DOM + r'''
document.body = host();
document.getElementById = id => walk(document.body).find(element => element.id === id) || null;
globalThis.document = document;
El.prototype.addEventListener = function(name, listener) { (this.listeners || (this.listeners = {}))[name] = listener; };
function centerElement(id, tag = 'div') { const element = document.createElement(tag); element.id = id;
  document.body.appendChild(element); return element; }
['expertCenter', 'expertCenterStatus', 'expertPackageList', 'expertPackageDetail',
  'expertSelectionChip', 'expertRunTimeline', 'expertStopBtn', 'expertRecoverBtn',
  'expertSelectBtn', 'expertEnableBtn', 'expertRunSelectedBtn'].forEach(id => centerElement(id));
const userInput = centerElement('userInput', 'textarea'); userInput.value = 'run task';
const expertSearch = centerElement('expertSearch', 'input'); expertSearch.value = '';
const expertImportPath = centerElement('expertImportPath', 'input');
const expertCloseBtn = centerElement('expertCloseBtn', 'button');
const expertPickerBtn = centerElement('expertPickerBtn', 'button');
'''
CENTER_HELPERS = CENTER_DOM + TEAM_HELPERS + r'''
let apiCalls = [];
let packageError = false;
callApi = async (name, args) => {
  apiCalls.push({ name, args });
  if (packageError) return { ok: false, error: { code: 'PACKAGE_ERROR', message: 'injected package failure' } };
  if (name === 'expert_list') return { ok: true, packages: [
    { id: 'demo.expert', name: 'demo.expert', kind: 'agent', version: '1.0.0', enabled: true },
    { id: 'disabled.expert', name: 'disabled.expert', kind: 'team', version: '1.0.0', enabled: false },
  ] };
  if (name === 'expert_get') return { ok: true, package: snapshot() };
  if (name === 'expert_read_resource') return { ok: true, path: args[1], sha256: 'sha', text: 'UNTRUSTED', truncated: false,
    provenance: { snapshotId: args[0], path: args[1] } };
  if (name === 'expert_set_enabled') return { ok: true, enabled: args[1], active_snapshot: args[2] };
  if (name === 'expert_import_directory') return { ok: true, package_id: 'demo.expert', snapshot_id: 'a'.repeat(64), version: '1.0.0', activated: false };
  throw new Error('unexpected API ' + name);
};
function resetCenter() {
  apiCalls = []; packageError = false; expertCenterState.detail = null; expertCenterState.controller = null;
  expertCenterState.runPromise = null; expertCenterState.runResult = null; expertCenterState.open = false;
  expertCenterState.packages = []; expertCenterState.loading = false; expertCenterState.error = '';
  clearExpertSelection(); document.getElementById('expertCenter').hidden = true;
}
'''


def test_center_api_only_on_open_detail_and_one_shot_chip():
    result = run_case(CENTER_HELPERS + r'''
resetCenter();
const before = apiCalls.length;
await openExpertCenter();
const afterOpen = apiCalls.map(call => call.name);
await expertSelectPackage('demo.expert');
const selected = expertSelectForNextRun();
const chip = document.getElementById('expertSelectionChip').textContent;
const sessionBefore = JSON.stringify(AppState.sessions);
clearExpertSelection();
return { before, afterOpen, selected, chip, sessionBefore,
  sessionAfter: JSON.stringify(AppState.sessions), apiCalls };
''', CENTER_MODULES)
    assert result['before'] == 0
    assert result['afterOpen'] == ['expert_list']
    assert result['selected'] is True and '发送时自动加载' in result['chip']
    assert result['sessionBefore'] == result['sessionAfter']
    assert [call['name'] for call in result['apiCalls']] == ['expert_list', 'expert_get']


def test_real_run_consumes_only_accepted_selection_and_failure_keeps_it():
    result = run_case(CENTER_HELPERS + r'''
resetCenter();
await openExpertCenter(); await expertSelectPackage('demo.expert'); expertSelectForNextRun();
ModelTransport.stream = async () => sse(finalSse);
const completed = await runExpertSelection();
const consumed = !document.getElementById('expertSelectionChip').hidden;
expertCenterState.controller = null;
await openExpertCenter(); await expertSelectPackage('demo.expert'); expertSelectForNextRun();
packageError = true;
const failed = await runExpertSelection();
const retained = !document.getElementById('expertSelectionChip').hidden;
return { completed, failed, consumed, retained };
''', CENTER_MODULES)
    assert result['completed']['status'] == 'completed' and result['consumed'] is False
    assert result['failed']['status'] == 'error' and result['retained'] is True


def test_accepted_runtime_error_keeps_selection_for_retry():
    result = run_case(CENTER_HELPERS + r'''
resetCenter();
await openExpertCenter(); await expertSelectPackage('demo.expert'); expertSelectForNextRun();
expertCenterState.controller = { start: async () => ({
  status: 'error', accepted: true, runId: 'r-error',
  error: { code: 'MODEL_FAILED', message: 'runtime failed' }
}) };
const failed = await runExpertSelection();
return { failed, retained: !document.getElementById('expertSelectionChip').hidden,
  selection: expertNextSelection };
''', CENTER_MODULES)
    assert result['failed']['status'] == 'error'
    assert result['retained'] is True
    assert result['selection']['packageId'] == 'demo.expert'


def test_expert_center_uses_chinese_labels_and_localized_description_guide():
    result = run_case(CENTER_HELPERS + r'''
resetCenter();
await openExpertCenter();
await expertSelectPackage('demo.expert');
expertCenterState.detail.metadata.displayDescription = { zh: '中文优先描述', en: 'English fallback' };
expertCenterState.detail.metadata.description = 'English fallback description';
expertCenterRenderDetail();
return {
  listText: textOf(document.getElementById('expertPackageList')),
  detailText: textOf(document.getElementById('expertPackageDetail'))
};
''', CENTER_MODULES)
    assert '单专家' in result['listText'] and '专家团' in result['listText']
    assert '已启用' in result['listText'] and '已停用' in result['listText']
    for text in ('中文优先描述', '使用说明', '角色', '限制', '技能与资料',
                 'scripts 只作为资料展示，不会执行', '下一次发送消息时自动加载'):
        assert text in result['detailText'], text


def test_disabled_package_cannot_be_selected_and_long_text_is_textcontent():
    result = run_case(CENTER_HELPERS + r'''
resetCenter();
await openExpertCenter();
await expertSelectPackage('disabled.expert');
const disabled = expertSelectForNextRun();
expertCenterState.detail.metadata.description = '<img src=x onerror=alert(1)> long text';
expertCenterRenderDetail();
return { disabled, chipHidden: document.getElementById('expertSelectionChip').hidden,
  detailText: textOf(document.getElementById('expertPackageDetail')),
  childTags: walk(document.getElementById('expertPackageDetail')).map(element => element.tagName) };
''', CENTER_MODULES)
    assert result['disabled'] is False and result['chipHidden'] is True
    assert '<img src=x' in result['detailText']
    assert all(tag != 'IMG' for tag in result['childTags'])
