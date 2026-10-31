# -*- coding: utf-8 -*-
"""G2 real DataRef, provenance, permission and existing-view integration tests."""
from pathlib import Path
import shutil

import pytest

from test_generative_registry import DOM
from test_model_executor_foundation import run_case

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which('node')
MODULES = [
    'libs/ui-schema.bundle.js',
    'frontend/src/generative/schemas.js',
    'frontend/src/generative/registry.js',
    'frontend/src/generative/data-ref.js',
    'frontend/src/generative/fixtures.js',
    'frontend/src/generative/projection.js',
]


def run_ui_case(body, extra=None):
    if not NODE:
        pytest.skip('Node.js is required for generative UI tests')
    return run_case(DOM + body, MODULES + list(extra or []))


def test_plan_real_data_binding_and_revision_update():
    result = run_ui_case(r'''
planCurrent = { task_id: 'plan-1', title: '真实计划', status: 'running', steps: [
  { text: '读取数据', status: 'done' }, { text: '生成视图', status: 'doing' },
] };
planUiRevision = 3;
AppState = { currentSessionId: 'session-plan' };
const target = host();
const projection = UiProjection.mount(target, UiSpecFixtures.plan({
  revision: 3, runId: 'run-plan', sessionId: 'session-plan',
}), { dataRefHost: createUiDataRefHost() });
const before = { result: projection.lastResult, text: textOf(projection.root),
  bindings: Object.keys(projection.bindings), provenance: projection.bindings['plan-steps'].provenance };
planCurrent.steps[1].status = 'done';
planUiRevision = 4;
const update = projection.commit(UiSpecFixtures.plan({
  revision: 4, runId: 'run-plan', sessionId: 'session-plan',
}));
return { before, update, after: textOf(projection.root),
  statuses: walk(projection.root).filter(el => String(el.className).includes('ui-timeline-item'))
    .map(el => el.className) };
''')
    assert result['before']['result']['ok'] is True
    assert result['before']['result']['bindings'] == 2
    assert result['before']['bindings'] == ['plan-summary', 'plan-steps']
    assert '真实计划' in result['before']['text'] and '读取数据' in result['before']['text']
    assert result['before']['provenance']['taskId'] == 'plan-1'
    assert result['before']['provenance']['sessionId'] == 'session-plan'
    assert result['update']['ok'] is True
    assert result['statuses'][-1].endswith('ui-status-done')


def test_mcp_real_rows_and_memory_entity_redaction_and_update():
    result = run_ui_case(r'''
AppState = { currentSessionId: 'session-2', mcpServers: [
  { name: 'local-tools', transport: 'stdio', tool_count: 4, status: 'ready', enabled: true,
    api_key: 'must-not-render' },
] };
mcpServersRevision = 2;
const mcp = UiProjection.mount(host(), UiSpecFixtures.mcp({ revision: 2, runId: 'r', sessionId: 's' }),
  { dataRefHost: createUiDataRefHost() });
const mcpText = textOf(mcp.root);
mmLastItems = [{ text: '第一条 secret=do-not-render', ts: 't1' }];
memoryReqSeq = 5;
const memory = UiProjection.mount(host(), UiSpecFixtures.memory({ revision: 5, runId: 'r', sessionId: 's' }),
  { dataRefHost: createUiDataRefHost() });
const memoryBefore = textOf(memory.root);
const oldBlockId = memory.current.blocks[0].blockId;
mmLastItems = [{ text: '同一位置的新记忆', ts: 't2' }];
memoryReqSeq = 6;
const update = memory.commit(UiSpecFixtures.memory({ revision: 6, runId: 'r', sessionId: 's' }));
return { mcpText, memoryBefore, oldBlockId, update,
  newBlockId: memory.current.blocks[0].blockId, memoryAfter: textOf(memory.root),
  mcpBindings: Object.keys(mcp.bindings), memoryBindings: Object.keys(memory.bindings) };
''')
    assert 'local-tools' in result['mcpText'] and 'stdio' in result['mcpText']
    assert 'must-not-render' not in result['mcpText']
    assert result['mcpBindings'] == ['mcp-summary', 'mcp-table']
    assert '第一条' in result['memoryBefore'] and 'do-not-render' not in result['memoryBefore']
    assert result['oldBlockId'] != result['newBlockId']
    assert result['update']['ok'] is True and '同一位置的新记忆' in result['memoryAfter']
    assert 'do-not-render' not in result['memoryAfter']


def test_tool_ref_success_stale_missing_and_non_json():
    result = run_ui_case(r'''
globalThis.__uiToolResults = {
  call1: { value: [{ name: 'tool-a', transport: 'http', tool_count: 2, status: 'ok' }],
    revision: 7, allowed: true },
  text: { value: 'not-json-structure', revision: 1, allowed: true },
  denied: { value: [{ name: 'secret' }], revision: 1, allowed: false },
};
const dataHost = createUiDataRefHost();
const ref = { source: 'tool', toolCallId: 'call1', selector: 'mcp.servers',
  scope: 'mcp-servers', resultRevision: 7 };
const ok = DataRefResolver.resolve(ref, dataHost, 'Table');
const stale = DataRefResolver.resolve({ ...ref, resultRevision: 6 }, dataHost, 'Table');
const missing = DataRefResolver.resolve({ ...ref, toolCallId: 'missing' }, dataHost, 'Table');
const denied = DataRefResolver.resolve({ ...ref, toolCallId: 'denied', resultRevision: 1 }, dataHost, 'Table');
const nonJson = DataRefResolver.resolve({ ...ref, toolCallId: 'text', resultRevision: 1 }, dataHost, 'Table');
return { ok, stale, missing, denied, nonJson };
''')
    assert result['ok']['ok'] is True and result['ok']['value'][0][0] == 'tool-a'
    assert result['ok']['provenance']['toolCallId'] == 'call1'
    assert result['stale']['code'] == 'stale'
    assert result['missing']['code'] == 'forbidden'
    assert result['denied']['code'] == 'forbidden'
    assert result['nonJson']['code'] == 'type_mismatch'


def test_arbitrary_paths_and_forbidden_binding_fall_back_without_leaking():
    result = run_ui_case(r'''
AppState = { currentSessionId: 's', mcpServers: [{ name: 'safe', apiKey: 'hidden' }] };
mcpServersRevision = 1;
const spec = UiSpecFixtures.mcp({ revision: 1, runId: 'r', sessionId: 's' });
spec.blocks[1].bind.selector = 'sessions[*].apiKey';
const projection = UiProjection.mount(host(), spec, { dataRefHost: createUiDataRefHost() });
const arbitrary = DataRefResolver.resolve({ source: 'appState', selector: '../../secret', scope: 'mcp-servers' },
  createUiDataRefHost(), 'Table');
const session = DataRefResolver.resolve({ source: 'session', selector: 'mcp.servers', scope: 'mcp-servers' },
  createUiDataRefHost(), 'Table');
return { text: textOf(projection.root), metrics: projection.metrics,
  result: projection.lastResult, arbitrary, session };
''')
    assert result['result']['ok'] is True
    assert result['metrics']['binding.forbidden'] == 1
    assert '没有权限查看此数据' in result['text'] and 'hidden' not in result['text']
    assert result['arbitrary']['code'] == 'forbidden'
    assert result['session']['code'] == 'forbidden'


def test_existing_plan_mcp_memory_controls_preserve_original_views():
    plan = run_ui_case(r'''
planCurrent = { task_id: 'p', title: '计划', status: 'running', steps: [{ text: '步骤', status: 'done' }] };
planUiRevision = 1;
AppState = { currentSessionId: 's' };
const original = host(), generated = host(), generate = host(), raw = host();
const card = { __uiOriginal: original, __uiHost: generated,
  __uiGenerateBtn: generate, __uiRawBtn: raw, __uiProjection: null };
const shown = planGenerativeShow(card);
const generatedText = textOf(generated);
const showState = [original.hidden, generated.hidden, generate.hidden, raw.hidden];
planGenerativeHide(card);
return { generatedText, showState, hideState: [original.hidden, generated.hidden, generate.hidden, raw.hidden],
  bindings: shown.lastResult.bindings };
''', ['frontend/src/planning/card.js'])
    assert plan['showState'] == [True, False, True, False]
    assert plan['hideState'] == [False, True, False, True]
    assert '步骤' in plan['generatedText'] and plan['bindings'] == 2

    mcp = run_ui_case(r'''
mcpServers = [{ name: 'server-a', transport: 'stdio', tool_count: 1, status: 'ready' }];
mcpServersRevision = 2;
AppState = { currentSessionId: 's', mcpServers, mcpLoadFailed: false };
const original = host(), generated = host(), generate = host(), raw = host();
Object.assign(mcpGenerativeState, { box: original, host: generated, generate, raw, projection: null });
mcpGenerativeShow();
const generatedText = textOf(generated);
const showState = [original.hidden, generated.hidden, generate.hidden, raw.hidden];
mcpGenerativeHide();
return { generatedText, showState, hideState: [original.hidden, generated.hidden, generate.hidden, raw.hidden] };
''', ['frontend/src/integrations/mcp-panel.js'])
    assert mcp['showState'] == [True, False, True, False]
    assert mcp['hideState'] == [False, True, False, True]
    assert 'server-a' in mcp['generatedText']

    memory = run_ui_case(r'''
mmLastItems = [{ text: '记忆正文', ts: 't' }];
memoryReqSeq = 3;
AppState = { currentSessionId: 's' };
const original = host(), generated = host(), generate = host(), raw = host();
Object.assign(mmGenerativeState, { list: original, host: generated, generate, raw, projection: null });
memoryGenerativeShow();
const generatedText = textOf(generated);
const showState = [original.hidden, generated.hidden, generate.hidden, raw.hidden];
memoryGenerativeHide();
return { generatedText, showState, hideState: [original.hidden, generated.hidden, generate.hidden, raw.hidden] };
''', ['frontend/src/settings/memory.js'])
    assert memory['showState'] == [True, False, True, False]
    assert memory['hideState'] == [False, True, False, True]
    assert '记忆正文' in memory['generatedText']


def test_sessions_keep_generative_metadata_optional_and_legacy_untouched():
    result = run_case(r'''
const legacy = { id: 's1', title: '旧会话', messages: [{ role: 'user', content: 'x' }] };
const enriched = { ...legacy, uiGenerative: { specs: [{ specId: 'spec-1', revision: 2 }] } };
const normalized = SessionStore.normalize([legacy, enriched]);
return { normalized, legacyKeys: Object.keys(normalized[0]).sort(),
  hasGenerative: normalized[1].uiGenerative.specs[0].specId };
''', ['frontend/src/sessions/store.js', 'frontend/src/sessions/store-api.js'])
    assert result['hasGenerative'] == 'spec-1'
    assert 'uiGenerative' not in result['legacyKeys']
