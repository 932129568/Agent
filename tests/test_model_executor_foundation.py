# -*- coding: utf-8 -*-
"""W3C3A shared transport, request builder and pure SSE parser tests."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

import pytest

from helpers.frontend import read_frontend_source

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which('node')
REQUEST = 'frontend/src/providers/request.js'
CONTEXT = 'frontend/src/agent/context.js'
BUILDER = 'frontend/src/agent/request-builder.js'
PARSER = 'frontend/src/agent/sse-parser.js'
RUN = 'frontend/src/agent/run-controller.js'


def run_case(body, modules):
    if not NODE:
        pytest.skip('Node.js is required for model executor tests')
    sources = {}
    for name in modules:
        try:
            sources[name] = read_frontend_source(str(ROOT), name)
        except ValueError:
            local_file = ROOT / name
            if not local_file.is_file():
                raise
            sources[name] = local_file.read_text(encoding='utf-8')
    script = r'''
const vm = require('vm');
const sources = SOURCES;
const body = BODY;
const waits = [];
const logs = [];
const ctx = {
  TextDecoder, TextEncoder, Uint8Array, JSON, Object, Array, String, Number, DOMException,
  setTimeout(fn, ms) { waits.push(ms); fn(); return 1; },
  clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
  console: { log(...args) { logs.push(args.join(' ')); }, warn(...args) { logs.push(args.join(' ')); } },
  __waits: waits, __logs: logs,
};
ctx.window = ctx;
vm.createContext(ctx);
for (const source of Object.values(sources)) vm.runInContext(source, ctx);
(async () => {
  const result = await vm.runInContext('(async () => {' + body + '})()', ctx);
  process.stdout.write(JSON.stringify(result));
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
'''.replace('SOURCES', json.dumps(sources, ensure_ascii=False)).replace(
        'BODY', json.dumps(body, ensure_ascii=False))
    fd, path = tempfile.mkstemp(suffix='.js', prefix='qa_model_foundation_')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write(script)
        result = subprocess.run([NODE, path], cwd=ROOT,
                                capture_output=True, text=True, timeout=60)
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def test_explicit_endpoint_is_not_global_overridden_and_key_not_logged():
    result = run_case(r'''
const calls = [];
resolveApiEndpoint = () => 'https://global-override.invalid';
fetch = async (endpoint, options) => {
  calls.push({ endpoint, options });
  return { ok: true, status: 200 };
};
const response = await ModelTransport.stream({
  endpoint: 'https://explicit.invalid/v1', apiKey: 'sk-test-secret',
  body: { messages: [{ role: 'user', content: 'x' }] },
  local: false, proxyHeaders: { 'X-Test': 'yes' },
});
return { endpoint: calls[0].endpoint, auth: calls[0].options.headers.Authorization,
         proxy: calls[0].options.headers['X-Test'], logs: __logs.join('\n'),
         status: response.status };
''', [REQUEST, CONTEXT])
    assert result['endpoint'] == 'https://explicit.invalid/v1'
    assert result['auth'] == 'Bearer sk-test-secret'
    assert result['proxy'] == 'yes' and result['status'] == 200
    assert 'sk-test-secret' not in result['logs']


def test_legacy_fetch_wrapper_uses_same_transport_and_normalizes_messages():
    result = run_case(r'''
const calls = [];
resolveApiEndpoint = () => 'https://legacy.invalid/chat';
localState = { mode: true };
localProxyHeaders = () => ({ 'X-Harbor-Target': 'http://127.0.0.1:11434' });
fetch = async (endpoint, options) => {
  calls.push({ endpoint, options });
  return { ok: true, status: 200 };
};
await fetchGLMStream({ apiKey: 'legacy-key', body: {
  messages: [{ role: 'user', content: 'u' }, { role: 'system', content: 's1' },
             { role: 'system', content: 's2' }],
} });
const sent = JSON.parse(calls[0].options.body);
return { endpoint: calls[0].endpoint, target: calls[0].options.headers['X-Harbor-Target'],
         roles: sent.messages.map(message => message.role),
         system: sent.messages[0].content };
''', [REQUEST, CONTEXT])
    assert result['endpoint'] == 'https://legacy.invalid/chat'
    assert result['target'] == 'http://127.0.0.1:11434'
    assert result['roles'] == ['system', 'user']
    assert result['system'] == 's1\n\ns2'


def test_retry_balance_fail_fast_and_abort_semantics():
    result = run_case(r'''
let count = 0;
fetch = async () => {
  count++;
  if (count < 4) return { ok: false, status: 503 };
  return { ok: true, status: 200 };
};
const recovered = await ModelTransport.stream({
  endpoint: 'https://local.invalid', apiKey: '', body: {}, local: true,
});
const recoveredCount = count;
let balanceCount = 0;
fetch = async () => {
  balanceCount++;
  return { ok: false, status: 429, clone() {
    return { text: async () => 'insufficient quota and billing' };
  } };
};
const balance = await ModelTransport.stream({
  endpoint: 'https://cloud.invalid', apiKey: 'x', body: {}, local: false,
});
let abortCount = 0;
fetch = async () => {
  abortCount++;
  throw new DOMException('Aborted', 'AbortError');
};
let abortName = '';
try {
  await ModelTransport.stream({ endpoint: 'https://x.invalid', apiKey: 'x', body: {} },
    { aborted: true, addEventListener() {} });
} catch (error) { abortName = error.name; }
return { recovered: recovered.status, recoveredCount, waits: __waits,
         balance: balance.status, balanceCount, abortName, abortCount };
''', [REQUEST, CONTEXT])
    assert result['recovered'] == 200 and result['recoveredCount'] == 4
    assert result['waits'] == [2000, 4000, 8000]
    assert result['balance'] == 429 and result['balanceCount'] == 1
    assert result['abortName'] == 'AbortError' and result['abortCount'] == 1


def test_sse_fragmentation_bad_lines_tools_usage_finish_and_decoder_tail():
    result = run_case(r'''
const events = [
  { choices: [{ delta: { reasoning_content: 'think' } }] },
  { choices: [{ delta: { content: 'hel' } }] },
  { choices: [{ delta: { content: 'lo' } }] },
  { choices: [{ delta: { tool_calls: [{ function: { name: 'read_file', arguments: '{"pa' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ function: { arguments: 'th":"x"}' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ id: 'tool-2', function: { name: 'run_command', arguments: '{"cmd":"echo"}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } },
  { choices: [{ delta: { content: '!' } }] },
];
let wire = events.map(event => 'data: ' + JSON.stringify(event) + '\n').join('');
wire += 'data: {bad json}\nnot-data\n';
const bytes = new TextEncoder().encode(wire);
const chunks = [bytes.slice(0, 7), bytes.slice(7, 31), bytes.slice(31, 113),
                bytes.slice(113, 271), bytes.slice(271, 419), bytes.slice(419)];
let index = 0;
const deltas = [];
const usages = [];
const parsed = await parseSseStream({ getReader() {
  return { async read() {
    if (index >= chunks.length) return { done: true };
    return { done: false, value: chunks[index++] };
  } };
} }, { round: 2,
  onDelta(delta, current) { deltas.push(current.content); },
  onUsage(usage) { usages.push(usage.total_tokens); },
});
return { content: parsed.content, reasoning: parsed.reasoning,
         tools: Object.values(parsed.toolCallMap), usage: parsed.usage,
         finish: parsed.finishReason, deltas, usages };
''', [PARSER])
    assert result['content'] == 'hello!' and result['reasoning'] == 'think'
    assert result['finish'] == 'stop' and result['usage']['total_tokens'] == 7
    assert result['usages'] == [7]
    assert len(result['tools']) == 2
    assert result['tools'][0]['name'] == 'read_file'
    assert result['tools'][0]['argsStr'] == '{"path":"x"}'
    assert result['tools'][1]['id'] == 'tool-2'
    assert result['tools'][1]['name'] == 'run_command'
    assert result['tools'][1]['argsStr'] == '{"cmd":"echo"}'
    assert result['deltas'][-1] == 'hello!'


def test_request_body_and_400_degradation_match_legacy_shapes():
    result = run_case(r'''
const tools = [{ function: { name: 'read_file' } }];
const glm = buildChatRequestBody({
  model: 'glm-x', messages: [{ role: 'user', content: 'x' }],
  temperature: 0.2, topP: 0.8, maxTokens: 4096,
  effort: 'off', glm: true, tools,
});
const cloud = buildChatRequestBody({
  model: 'other', messages: [], temperature: 1, topP: 1, maxTokens: 10,
  effort: 'high', glm: false, tools,
});
const thinkingAction = degradeChatBodyFor400(glm, 'thinking rejected');
const toolAction = degradeChatBodyFor400(cloud, 'tool_choice is unsupported');
const plain = buildChatRequestBody({ model: 'm', messages: [],
  temperature: 0, topP: 1, maxTokens: 1, effort: 'low', glm: true, tools: [] });
const noAction = degradeChatBodyFor400(plain, 'ordinary bad params');
return { glm, cloud, thinkingAction, toolAction, plain, noAction };
''', [BUILDER])
    assert result['glm']['stream'] is True
    assert result['glm']['stream_options'] == {'include_usage': True}
    assert result['thinkingAction'] == 'thinking'
    assert 'thinking' not in result['glm'] and 'reasoning_effort' not in result['glm']
    assert result['toolAction'] == 'tools' and 'tools' not in result['cloud']
    assert result['cloud']['model'] == 'other'
    assert result['plain']['reasoning_effort'] == 'low'
    assert result['noAction'] is None


def test_run_controller_uses_single_foundation_without_old_reader_loop():
    source = read_frontend_source(str(ROOT), RUN)
    assert 'buildChatRequestBody({' in source
    assert 'transport: ModelTransport' in source
    executor = read_frontend_source(str(ROOT), 'frontend/src/agent/model-executor.js')
    assert 'degradeChatBodyFor400(body, errorText)' in executor
    assert 'await parseSseStream(response.body' in executor
    assert 'const reader = resp.body.getReader()' not in source
    assert 'hybridOnUsage(usage, currentModel)' in source
    assert 'accumulateUsage(s, assistantMsg.usage)' in source
