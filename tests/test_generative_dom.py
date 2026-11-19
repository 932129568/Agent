# -*- coding: utf-8 -*-
"""G3 real DOM generation, cancellation, fallback and Edge page-button evidence."""
import json
from pathlib import Path

from test_generative_artifact import FALLBACK, run_ui_case

ROOT = Path(__file__).resolve().parent.parent


def test_ai_button_busy_abort_and_late_result_cannot_commit():
    result = run_ui_case(FALLBACK + r'''
globalThis.AbortController = class {
  constructor() { this.signal = { aborted: false, listeners: [] }; }
  abort() { if (this.signal.aborted) return; this.signal.aborted = true;
    this.signal.listeners.forEach(fn => fn()); }
};
const button = { disabled: false }, cancelButton = { hidden: true };
const events = [], applied = [];
globalThis.toast = (message, kind) => events.push({ message, kind });
let resolveGeneration;
const controller = createUiGenerationController({
  kind: 'test', host: host(), button, cancelButton, fallback: () => fallbackSpec,
  dataRefHost: createUiDataRefHost(),
  generate: ({ signal, onText }) => new Promise(resolve => {
    resolveGeneration = resolve;
    signal.addEventListener = (event, fn) => signal.listeners.push(fn);
    signal.addEventListener('abort', () => resolve({ status: 'cancelled' }));
  }),
  onResult: result => applied.push(result.status),
});
const pending = controller.start();
const busy = { busy: controller.isBusy(), disabled: button.disabled, cancelHidden: cancelButton.hidden };
const cancelled = controller.cancel();
const afterCancel = { busy: controller.isBusy(), disabled: button.disabled,
  cancelHidden: cancelButton.hidden, events: events.slice() };
const result = await pending;
return { busy, cancelled, afterCancel, result: result.status, applied,
  abortObserved: true };
''')
    assert result['busy'] == {'busy': True, 'disabled': True, 'cancelHidden': False}
    assert result['cancelled'] is True
    assert result['afterCancel']['busy'] is False
    assert result['afterCancel']['disabled'] is False
    assert result['afterCancel']['cancelHidden'] is True
    assert result['afterCancel']['events'][-1]['kind'] == 'info'
    assert result['result'] == 'cancelled' and result['applied'] == []


def test_complete_repaired_fallback_and_stale_revision_dom():
    result = run_ui_case(FALLBACK + r'''
const target = host();
const valid = '{"schemaVersion":1,"block":{"blockId":"ok","component":"TextBlock","props":{"text":"完整生成"},"actions":[]}}';
const complete = await generateUiSpec({ kind: 'test', fallbackSpec, host: target,
  dataRefHost: createUiDataRefHost(), generate: async ({ onText }) => {
    onText(valid); return { status: 'completed' }; } });
let repairCalls = 0;
const repaired = await generateUiSpec({ kind: 'test', fallbackSpec, host: host(),
  dataRefHost: createUiDataRefHost(), generate: async ({ onText }) => {
    repairCalls++;
    onText(repairCalls === 1 ? '{"schemaVersion":1,"block":' : valid);
    return { status: 'completed' };
  } });
const failed = await generateUiSpec({ kind: 'test', fallbackSpec, host: host(),
  dataRefHost: createUiDataRefHost(), generate: async ({ onText }) => {
    onText('not-json'); return { status: 'completed' };
  } });
const stale = complete.projection.commit(Object.assign({}, complete.spec, { revision: 0 }));
return { complete: complete.status, repaired: repaired.status, repairAttempts: repaired.attempts.length,
  failed: failed.status, fallbackText: textOf(failed.projection.root),
  stale, currentRevision: complete.projection.current.revision };
''')
    assert result['complete'] == 'completed' and result['repaired'] == 'completed'
    assert result['repairAttempts'] == 2 and result['failed'] == 'fallback'
    assert '手写默认模板' in result['fallbackText']
    assert result['stale']['error'] == 'stale_revision' and result['currentRevision'] == 2


def test_half_json_unknown_binding_xss_timeout_and_cancel_safety():
    result = run_ui_case(FALLBACK + r'''
const half = await generateUiSpec({ kind: 'test', fallbackSpec, host: host(), maxRepairs: 0,
  dataRefHost: createUiDataRefHost(), generate: async ({ onText }) => {
    onText('{"schemaVersion":1,"block":'); return { status: 'completed' }; } });
const unknown = await generateUiSpec({ kind: 'test', fallbackSpec, host: host(), maxRepairs: 0,
  dataRefHost: createUiDataRefHost(), generate: async ({ onText }) => {
    onText('{"schemaVersion":1,"block":{"blockId":"x","component":"Unknown","props":{},"actions":[]}}');
    return { status: 'completed' }; } });
const binding = await generateUiSpec({ kind: 'test', fallbackSpec, host: host(), maxRepairs: 0,
  dataRefHost: createUiDataRefHost(), generate: async ({ onText }) => {
    onText('{"schemaVersion":1,"block":{"blockId":"x","component":"Table","props":{"columns":["x"]},"bind":{"source":"appState","selector":"../../secret","scope":"mcp-servers"},"actions":[]}}');
    return { status: 'completed' }; } });
const xss = await generateUiSpec({ kind: 'test', fallbackSpec, host: host(), maxRepairs: 0,
  dataRefHost: createUiDataRefHost(), generate: async ({ onText }) => {
    onText('{"schemaVersion":1,"block":{"blockId":"x","component":"TextBlock","props":{"text":"<img src=x onerror=alert(1)>"},"actions":[]}}');
    return { status: 'completed' }; } });
const timeout = await generateUiSpec({ kind: 'test', fallbackSpec, host: host(), maxRepairs: 0,
  dataRefHost: createUiDataRefHost(), generate: async () => ({ status: 'error', error: { code: 'timeout' } }) });
let calls = 0;
const cancelled = await generateUiSpec({ kind: 'test', fallbackSpec, host: host(),
  dataRefHost: createUiDataRefHost(), signal: { aborted: true },
  generate: async () => { calls++; return { status: 'completed' }; } });
return { half: half.status, halfError: half.reason, unknown: unknown.status,
  binding: binding.reason, xss: xss.status, xssText: textOf(xss.projection.root),
  imgCount: walk(xss.projection.root).filter(el => el.tagName === 'IMG').length,
  timeout: timeout.reason, cancelled: cancelled.status, calls };
''')
    assert result['half'] == 'fallback' and result['halfError'] == 'incomplete_block'
    assert result['unknown'] == 'fallback'
    assert result['binding'] == 'binding.forbidden'
    assert result['xss'] == 'completed' and result['imgCount'] == 0
    assert '<img src=x' in result['xssText']
    assert result['timeout'] == 'timeout'
    assert result['cancelled'] == 'cancelled' and result['calls'] == 0


def test_g3_edge_page_button_and_layout_evidence():
    report = json.loads((ROOT / 'outputs' / 'generative-g3' / 'layout-report.json').read_text(encoding='utf-8'))
    assert report['ok'] is True
    assert report['realModel'] == 'UNCOVERED' and report['realExe'] == 'UNCOVERED'
    assert {item['scenario'] for item in report['captures']} == {'complete', 'repaired', 'fallback'}
    for capture in report['captures']:
        assert capture['overflow'] == []
        assert capture['documentWidth'] <= capture['viewport'][0] + 2
        assert (ROOT / 'outputs' / 'generative-g3' / (capture['name'] + '.png')).stat().st_size > 1000
    assert report['pageChecks']['plan']['passed'] is True
    assert report['pageChecks']['mcp']['passed'] is True
    assert report['pageChecks']['memory']['passed'] is True
    assert report['safety']['halfJsonSafe'] is True
    assert report['safety']['unknownSafe'] is True
    assert report['safety']['bindingMissSafe'] is True
    assert report['safety']['xssSafe'] is True
    assert report['safety']['timeoutSafe'] is True
    assert report['safety']['lateRevisionSafe'] is True
