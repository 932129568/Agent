# -*- coding: utf-8 -*-
"""G3 complete-block generation, directed repair and safe fallback tests."""
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
    'frontend/src/generative/artifact.js',
    'frontend/src/agent/request-builder.js',
    'frontend/src/agent/sse-parser.js',
    'frontend/src/agent/model-executor.js',
    'frontend/src/generative/controller.js',
]


def run_ui_case(body):
    if not NODE:
        pytest.skip('Node.js is required for generative artifact tests')
    return run_case(DOM + body, MODULES)


FALLBACK = r'''
const fallbackSpec = { schemaVersion: 1, specId: 'fallback', revision: 1,
  runId: 'run', sessionId: 'session', generation: 1,
  layout: 'single-column', title: '默认视图', blocks: [
    { blockId: 'default', component: 'TextBlock', props: { text: '手写默认模板' }, actions: [] },
  ] };
'''


def test_complete_blocks_stream_incrementally_without_half_json_parse():
    result = run_ui_case(FALLBACK + r'''
const target = host();
const chunks = [
  '{"schemaVersion":1,"layout":"two-column","block":{"blockId":"a","component":"TextBlock","props":{"text":"第一块"},"actions":[]}}',
  '\n{"schemaVersion":1,"block":{"blockId":"b","component":"Card","props":{"title":"第二块","fields":[]},"actions":[]}}',
];
const result = await generateUiSpec({ kind: 'test', fallbackSpec, host: target,
  dataRefHost: createUiDataRefHost(),
  generate: async ({ onText }) => {
    onText(chunks[0].slice(0, 35)); onText(chunks[0].slice(35) + chunks[1].slice(0, 20));
    onText(chunks[1].slice(20));
    return { status: 'completed', content: chunks.join('\n') };
  },
});
return { status: result.status, revision: result.spec.revision, layout: result.spec.layout,
  text: textOf(result.projection.root), blocks: result.spec.blocks.map(block => block.blockId),
  attempts: result.attempts.length, metrics: result.metrics };
''')
    assert result['status'] == 'completed'
    assert result['revision'] == 2 and result['layout'] == 'two-column'
    assert result['blocks'] == ['a', 'b'] and result['attempts'] == 1
    assert '第一块' in result['text'] and '第二块' in result['text']


def test_invalid_output_directed_repair_uses_error_and_original_output():
    result = run_ui_case(FALLBACK + r'''
const calls = [];
const valid = '{"schemaVersion":1,"block":{"blockId":"fixed","component":"TextBlock","props":{"text":"修复成功"},"actions":[]}}';
const result = await generateUiSpec({ kind: 'test', fallbackSpec, host: host(),
  dataRefHost: createUiDataRefHost(), maxRepairs: 1,
  generate: async ({ messages, onText }) => {
    calls.push(messages.map(message => message.content).join('\n'));
    if (calls.length === 1) onText('{"schemaVersion":1,"block":');
    else onText(valid);
    return { status: 'completed' };
  },
});
return { status: result.status, calls, attempts: result.attempts.length,
  text: textOf(result.projection.root) };
''')
    assert result['status'] == 'completed' and result['attempts'] == 2
    assert '上一次输出未通过校验' in result['calls'][1]
    assert 'incomplete_block' in result['calls'][1]
    assert '"block":' in result['calls'][1]
    assert '修复成功' in result['text']


def test_business_binding_failure_never_executes_and_falls_back():
    result = run_ui_case(FALLBACK + r'''
AppState = { currentSessionId: 'session', mcpServers: [{ name: 'safe' }] };
mcpServersRevision = 1;
const bad = '{"schemaVersion":1,"block":{"blockId":"bad","component":"Table","props":{"columns":["x"]},"bind":{"source":"appState","selector":"../../secret","scope":"mcp-servers"},"actions":[]}}';
const result = await generateUiSpec({ kind: 'mcp', fallbackSpec, host: host(),
  dataRefHost: createUiDataRefHost(), maxRepairs: 1,
  generate: async ({ onText }) => { onText(bad); return { status: 'completed' }; },
});
return { status: result.status, reason: result.reason, text: textOf(result.projection.root),
  attempts: result.attempts.length, metrics: result.metrics };
''')
    assert result['status'] == 'fallback' and result['attempts'] == 2
    assert 'binding.forbidden' in result['reason'] or 'invalid' in result['reason']
    assert '手写默认模板' in result['text']
    assert 'secret' not in result['text']


def test_prose_html_and_actions_are_rejected_without_execution():
    result = run_ui_case(FALLBACK + r'''
globalThis.__executed = 0;
const result = await generateUiSpec({ kind: 'test', fallbackSpec, host: host(),
  dataRefHost: createUiDataRefHost(), maxRepairs: 0,
  generate: async ({ onText }) => {
    onText('<script>globalThis.__executed++</script>{"schemaVersion":1,"block":{"blockId":"x","component":"TextBlock","props":{"text":"x"},"actions":[{"name":"delete"}]}}');
    return { status: 'completed' };
  },
});
return { status: result.status, text: textOf(result.projection.root), executed: globalThis.__executed,
  errors: result.attempts[0].errors };
''')
    assert result['status'] == 'fallback' and result['executed'] == 0
    assert '手写默认模板' in result['text'] and '<script>' not in result['text']
    assert result['errors']


def test_cancel_before_generation_has_no_model_call_and_keeps_fallback():
    result = run_ui_case(FALLBACK + r'''
let calls = 0;
const signal = { aborted: true, addEventListener() {} };
const result = await generateUiSpec({ kind: 'test', fallbackSpec, host: host(),
  dataRefHost: createUiDataRefHost(), signal,
  generate: async () => { calls++; return { status: 'completed' }; },
});
return { status: result.status, calls, text: textOf(result.projection.root) };
''')
    assert result['status'] == 'cancelled' and result['calls'] == 0
    assert '手写默认模板' in result['text']


def test_strict_schema_is_opt_in_and_normal_request_shape_unchanged():
    result = run_ui_case(r'''
const messages = [{ role: 'user', content: 'x' }];
const normal = createUiGenerationBody({ messages, model: 'm', strictSchema: false });
const strict = createUiGenerationBody({ messages, model: 'm', strictSchema: true });
return { normal, strictFormat: strict.response_format,
  normalKeys: Object.keys(normal).sort(), strictSchema: UI_STRICT_JSON_SCHEMA.additionalProperties };
''')
    assert 'response_format' not in result['normal']
    assert result['strictFormat']['type'] == 'json_schema'
    assert result['strictFormat']['json_schema']['strict'] is True
    assert result['normalKeys'] == ['max_tokens', 'messages', 'model', 'stream', 'stream_options', 'temperature', 'top_p']
    assert result['strictSchema'] is False


def test_shared_model_executor_sse_to_projection_and_no_tools():
    result = run_ui_case(FALLBACK + r'''
const envelope = '{"schemaVersion":1,"block":{"blockId":"sse","component":"TextBlock","props":{"text":"来自共享执行器"},"actions":[]}}';
const payloads = [];
const transport = { stream: async request => {
  payloads.push(request.body);
  const lines = [
    'data: {"choices":[{"delta":{"content":' + JSON.stringify(envelope.slice(0, 40)) + '}}]}',
    'data: {"choices":[{"delta":{"content":' + JSON.stringify(envelope.slice(40)) + '}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
    'data: [DONE]', '',
  ];
  const stream = { getReader() {
    let sent = false;
    return { read: async () => sent ? { done: true } : (sent = true,
      { done: false, value: new TextEncoder().encode(lines.join('\n')) }), releaseLock() {} };
  } };
  return { ok: true, status: 200, body: stream };
} };
const baseGenerate = productionUiGenerate({ transport, endpoint: { endpoint: 'http://fake', apiKey: '' }, model: 'm' });
const generate = async args => {
  const response = await baseGenerate(args);
  globalThis.__directError = response && response.error ? String(response.error.stack || response.error) : '';
  return response;
};
const result = await generateUiSpec({ kind: 'test', fallbackSpec, host: host(),
  dataRefHost: createUiDataRefHost(), generate });
return { status: result.status, reason: result.reason, detail: result.attempts,
  debug: globalThis.__directError.split('\n')[0],
  text: textOf(result.projection.root), calls: payloads.length,
  body: payloads[0], attempts: result.attempts.length };
''')
    assert result['status'] == 'completed', result
    assert '来自共享执行器' in result['text']
    assert result['body']['model'] == 'm' and 'tools' not in result['body']
    assert result['body']['temperature'] == 0 and result['attempts'] == 1


def test_strict_schema_fallback_only_for_schema_unsupported():
    result = run_ui_case(r'''
const strictCalls = [];
const strictExecutor = async request => {
  strictCalls.push(request.observer.beforeRound({ context: { messages: [] } }).body);
  if (strictCalls.length === 1) return { status: 'error', error: {
    code: 'unsupported_response_format', message: 'response_format json_schema unsupported' } };
  return { status: 'completed' };
};
const generate = productionUiGenerate({ executor: strictExecutor, transport: {}, endpoint: {}, model: 'm' });
const repaired = await generate({ messages: [], onText() {}, strictSchema: true });
let networkCalls = 0;
const networkGenerate = productionUiGenerate({ endpoint: {}, transport: {}, model: 'm',
  executor: async () => { networkCalls++; return { status: 'error',
    error: { code: 'network_error', message: 'fetch failed' } }; } });
const network = await networkGenerate({ messages: [], onText() {}, strictSchema: true });
return { strictCalls: strictCalls.length, networkCalls, repaired, network };
''')
    assert result['strictCalls'] == 2 and result['networkCalls'] == 1
    assert result['repaired']['schemaFallback'] is True
    assert result['network']['status'] == 'error'


def test_generative_path_has_no_html_eval_or_inline_handlers():
    for name in ('frontend/src/generative/artifact.js', 'frontend/src/generative/controller.js'):
        source = (ROOT / name).read_text(encoding='utf-8')
        for banned in ('innerHTML', 'new Function', 'eval(', 'onclick=', 'foreignObject'):
            assert banned not in source, (name, banned)
