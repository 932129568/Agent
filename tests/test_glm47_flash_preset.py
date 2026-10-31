# -*- coding: utf-8 -*-
"""GLM-4.7-Flash free preset, pricing and request-contract regressions."""
from pathlib import Path

from test_connect_merge import _run_node
from test_model_executor_foundation import run_case

ROOT = Path(__file__).resolve().parent.parent
CONNECTION = ROOT / 'frontend' / 'src' / 'settings' / 'connection.js'
TOKENS = ROOT / 'frontend' / 'src' / 'analytics' / 'tokens.js'
MODEL_ID = 'glm-4.7-flash'


def test_glm_preset_and_hot_models_include_free_glm47_without_reordering():
    result = _run_node(r"""
async function __main() {
  const ctx = __ctx({callApi: async function(){ return '{}'; } });
  __run(ctx, __fe('36-connect.js'));
  __run(ctx, 'globalThis.__models = connectPresetModels("glm");'
             + 'globalThis.__hot = connectHotModels("https://open.bigmodel.cn/api/paas/v4");');
  return {models: ctx.__models, hot: ctx.__hot};
}
""", 'glm47_preset')
    ids = [model['id'] for model in result['models']]
    assert ids[:2] == ['glm-5.3-flash', 'glm-5.3-flashx']
    assert MODEL_ID in ids
    target = next(model for model in result['models'] if model['id'] == MODEL_ID)
    assert '免费/普惠' in target['text']
    hot_ids = [model['id'] for model in result['hot']]
    assert hot_ids[:4] == ['glm-5.3-flash', 'glm-5.3-flashx', 'glm-4.6', 'glm-4.5-air']
    assert hot_ids[-1] == MODEL_ID


def test_glm47_has_zero_price_and_connection_source_has_no_key():
    result = run_case(r"""
const price = MODEL_PRICE['glm-4.7-flash'];
return {price: price, keys: Object.keys(MODEL_PRICE)};
""", ['frontend/src/analytics/tokens.js'])
    assert result['price'] == {'in': 0, 'out': 0, 'cache': 0}
    source = CONNECTION.read_text(encoding='utf-8')
    assert 'glm-4.7-flash' in source
    assert 'sk-' not in source


def test_glm47_keeps_glm_request_shape_for_stream_tools_and_usage():
    result = run_case(r'''
const body = buildChatRequestBody({
  model: 'glm-4.7-flash',
  messages: [{role: 'user', content: 'hi'}],
  temperature: 0.7, topP: 0.95, maxTokens: 128,
  effort: 'medium', glm: true,
  tools: [{type: 'function', function: {name: 'get_time', parameters: {type: 'object', properties: {}}}}]
});
return {model: body.model, stream: body.stream, usage: body.stream_options,
        reasoning: body.reasoning_effort, thinking: body.thinking, tools: body.tools};
''', ['frontend/src/agent/request-builder.js'])
    assert result['model'] == MODEL_ID
    assert result['stream'] is True and result['usage'] == {'include_usage': True}
    assert result['reasoning'] == 'medium' and result.get('thinking') is None
    assert result['tools'][0]['function']['name'] == 'get_time'
