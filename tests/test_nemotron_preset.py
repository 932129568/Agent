# -*- coding: utf-8 -*-
"""Nemotron 3 Ultra 550B preset and OpenAI-compatible runtime regressions."""
from pathlib import Path

from helpers.frontend import read_frontend_source
from test_connect_merge import _run_node
from test_model_executor_foundation import run_case

ROOT = Path(__file__).resolve().parent.parent
CONNECTION = ROOT / 'frontend' / 'src' / 'settings' / 'connection.js'
TEMPLATE = ROOT / 'frontend' / 'index.template.html'
MODEL_ID = '显卡一哥nemotron-3-ultra-550b'


def test_nemotron_preset_and_hot_models_metadata():
    result = _run_node(r"""
async function __main() {
  const ctx = __ctx({ callApi: async function(){ return '{}'; } });
  __run(ctx, __fe('36-connect.js'));
  __run(ctx, 'globalThis.__preset = PRESETS.nemotron;'
             + 'globalThis.__order = CONNECT_PRESET_ORDER;'
             + 'globalThis.__hot = connectHotModels("https://legui.xyz/v1");');
  const preset = ctx.__preset;
  const model = preset.models[0];
  return {preset: preset, model: model, order: ctx.__order, hot: ctx.__hot};
}
""", 'nemotron_preset')
    preset = result['preset']
    model = result['model']
    assert preset['name'] == 'Nemotron 3 Ultra 550B'
    assert preset['base_url'] == 'https://legui.xyz/v1'
    assert preset['key_required'] is True and preset['local'] is False
    assert preset['glm_capable'] is False
    assert preset['key_hint'] == 'legui.xyz API Key（仅保存在本机）'
    assert model['id'] == MODEL_ID
    assert model['ctx_window'] == 262144
    assert model['tool_capable'] is True
    assert model['badge'] == '262k'
    assert result['order'].index('nemotron') == 4
    assert result['hot'][0]['id'] == MODEL_ID
    assert result['hot'][0]['badge'] == '262k'
    connection = read_frontend_source(str(ROOT), '36-connect.js')
    assert "ctx_window: 262144, tool_capable: true" in connection


def test_nemotron_preset_is_in_template_and_source_has_no_key():
    connection = read_frontend_source(str(ROOT), '36-connect.js')
    template = TEMPLATE.read_text(encoding='utf-8')
    assert '<option value="nemotron">Nemotron 3 Ultra 550B</option>' in template
    assert 'https://legui.xyz/v1' in connection
    assert 'host: \'legui.xyz\'' in connection
    assert 'sk-' not in connection
    assert 'sk-' not in template


def test_non_glm_request_body_keeps_openai_tools_and_stream_usage():
    result = run_case(r'''
const body = buildChatRequestBody({
  model: '显卡一哥nemotron-3-ultra-550b',
  messages: [{role: 'user', content: 'hi'}],
  temperature: 0.7, topP: 0.95, maxTokens: 128,
  effort: 'medium', glm: false,
  tools: [{type: 'function', function: {name: 'get_time', parameters: {type: 'object', properties: {}}}}]
});
return {reasoning: body.reasoning_effort, thinking: body.thinking, tools: body.tools,
        stream: body.stream, usage: body.stream_options, model: body.model};
''', ['frontend/src/agent/request-builder.js'])
    assert result.get('reasoning') is None and result.get('thinking') is None
    assert result['tools'][0]['function']['name'] == 'get_time'
    assert result['stream'] is True and result['usage'] == {'include_usage': True}
    assert result['model'] == MODEL_ID


def test_sse_parser_accepts_nemotron_reasoning_content_and_tool_delta():
    result = run_case(r'''
const events = [
  'data: {"model":"显卡一哥nemotron-3-ultra-550b","choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
  'data: {"model":"显卡一哥nemotron-3-ultra-550b","choices":[{"delta":{"content":"answer"}}]}\n\n',
  'data: {"model":"显卡一哥nemotron-3-ultra-550b","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_time","arguments":"{\\"tz\\":\\"UTC\\"}"}}]}}]}\n\n',
  'data: {"model":"显卡一哥nemotron-3-ultra-550b","choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}\n\n',
  'data: [DONE]\n\n'
];
let index = 0;
const chunks = events.map(item => new TextEncoder().encode(item));
const stream = {getReader: () => ({read: async () => index < chunks.length
  ? {done: false, value: chunks[index++]} : {done: true, value: undefined}})};
return await parseSseStream(stream, {});
''', ['frontend/src/agent/sse-parser.js'])
    assert result['reasoning'] == 'think'
    assert result['content'] == 'answer'
    assert result['finishReason'] == 'tool_calls'
    assert result['usage']['total_tokens'] == 10
    assert result['toolCallMap']['0']['name'] == 'get_time'
    assert result['toolCallMap']['0']['argsStr'] == '{"tz":"UTC"}'
