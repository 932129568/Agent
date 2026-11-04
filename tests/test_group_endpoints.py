# -*- coding: utf-8 -*-
"""群成员自由选择模型 / 跨端点（Round 15，2026-11-04 主理人需求）。

报障原文：「能使用的模型并不能自由选择，如果在设置里面保存了智谱的就只能用
智谱的，用 deepseek 就只有 deepseek 的模型，改一下可以自由选择模型」。

判定：成员下拉来自「全端点目录」而不是设置页当前端点；成员可绑定
`端点id::模型名`，发言时用该端点自己的 base_url + key 发送；缺 key 时给出
明确错误而不是拿当前端点 Key 去打别的域名。
"""
from test_connect_merge import _run_node


def _boot(body, name):
    return _run_node((r"""
async function __main() {
  const ctx = __ctx({callApi: async function(){ return '[]'; }, AbortController: AbortController,
                     ReadableStream: ReadableStream, TextEncoder: TextEncoder, TextDecoder: TextDecoder});
  __run(ctx, __fe('group.js'));
  __run(ctx, __fe('mention.js'));
  __run(ctx, __fe('endpoints.js'));
  __run(ctx, __fe('45-request-debounce.js'));
  __run(ctx, __fe('sse-parser.js'));
  const vmRun = function(code){ return __vm.runInContext(code, ctx); };
  // 端点上下文：内置预设表 + 当前端点
  vmRun('PRESETS = {'
      + 'glm: { name: "智谱 GLM", base_url: "https://open.bigmodel.cn/api/paas/v4", local: false,'
      + '       models: [{ id: "glm-4.5-flash" }, { id: "glm-4.5" }] },'
      + 'deepseek: { name: "DeepSeek", base_url: "https://api.deepseek.com/v1", local: false,'
      + '       models: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] } };');
  vmRun('providerState = { name: "glm", base_url: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.5-flash" };');
  vmRun('connectHotModels = function(){ return []; };');
  vmRun('chatCompletionsOf = function(b){ b = String(b || ""); while (b.length && b.charAt(b.length-1) === "/") b = b.slice(0, -1); return b ? b + "/chat/completions" : ""; };');
  vmRun('currentEndpointName = function(){ return "智谱 GLM"; };');
  vmRun('providerState.enabled = true;');
  vmRun('sessions = [{ id: "s1", title: "群", messages: [], group: { members: [], phase: "paused", round: 0 } }];');
  vmRun('AppState = { currentSessionId: "s1" };');
""" + body + """
}
"""), name)


def test_catalog_includes_other_providers_not_only_current():
    result = _boot(r"""
  const cat = vmRun('groupEndpointCatalog')();
  const ids = cat.map(function(e){ return e.id; });
  const models = [];
  cat.forEach(function(e){ e.models.forEach(function(m){ models.push(m.id); }); });
  return {ids: ids, models: models};
""", 'ep_catalog')
    assert 'deepseek' in result['ids'], result
    assert 'deepseek-flash' in result['models'], result       # 智谱端点下也能选 DeepSeek
    assert 'glm-4.5-flash' in result['models']


def test_member_options_group_by_endpoint_and_mark_cross():
    result = _boot(r"""
  const html = vmRun('groupModelSelectOptions')(null, 'deepseek::deepseek-v4-pro');
  return {hasGroup: html.indexOf('<optgroup') >= 0,
          hasCross: html.indexOf('deepseek::deepseek-v4-pro" selected') >= 0,
          hasGlm: html.indexOf('glm-4.5-flash') >= 0,
          hasDs: html.indexOf('deepseek-flash') >= 0};
""", 'ep_options')
    assert result['hasGroup'] and result['hasCross'] and result['hasGlm'] and result['hasDs'], result


def test_model_target_parses_only_cross_endpoint_form():
    result = _boot(r"""
  const f = vmRun('groupModelTarget');
  return {empty: f(''), bare: f('glm-4.5'), cross: f('deepseek::deepseek-flash')};
""", 'ep_target')
    assert result['empty'] is None and result['bare'] is None
    assert result['cross'] == {'endpointId': 'deepseek', 'model': 'deepseek-flash'}


def test_member_endpoint_reports_missing_key():
    result = _boot(r"""
  const f = vmRun('groupMemberEndpoint');
  const noKey = f({ endpoints: { deepseek: { base_url: 'https://api.deepseek.com/v1', api_key: '' } } },
                  { model: 'deepseek::deepseek-flash' });
  const withKey = f({ endpoints: { deepseek: { base_url: 'https://api.deepseek.com/v1', api_key: 'sk-ds' } } },
                    { model: 'deepseek::deepseek-flash' });
  const bare = f({}, { model: 'glm-4.5' });
  return {noKey: noKey && noKey.missing, withKey: withKey && withKey.missing, bare: bare};
""", 'ep_missing')
    assert result['noKey'] == 'key'
    assert result['withKey'] == ''
    assert result['bare'] is None


def test_group_send_uses_member_endpoint_and_key():
    result = _boot(r"""
  // ModelTransport 被 Object.freeze——桩要打在更底层的 fetch 上（顺带验证
  // 跨端点真的走到了自己的 URL/Key/model 组合）
  vmRun("globalThis.__cap = [];"
      + "globalThis.fetch = async function(url, opt){"
      + "  var body = JSON.parse(opt.body);"
      + "  __cap.push({endpoint: String(url), key: String(opt.headers.Authorization || ''), model: body.model});"
      + "  var NL = String.fromCharCode(10);"
      + "  var sse = 'data: ' + JSON.stringify({choices:[{delta:{content:'OK'}}]}) + NL + NL + 'data: [DONE]' + NL + NL;"
      + "  return { status: 200, ok: true, headers: { get: function(){ return null; } },"
      + "    body: new ReadableStream({ start: function(c){ c.enqueue(new TextEncoder().encode(sse)); c.close(); } }) };"
      + "};");
  const grp = { group: { endpoints: { deepseek: { name:'DeepSeek',
    base_url: 'https://api.deepseek.com/v1', api_key: 'sk-ds-123' } } } };
  await vmRun('groupCallModel')(grp, { id:'m2', name:'前端', model:'deepseek::deepseek-v4-pro' },
    [{ role:'user', content:'hi' }], function(){}, function(){});
  return {calls: vmRun('globalThis.__cap')};
""", 'ep_send')
    assert len(result['calls']) == 1, result
    c = result['calls'][0]
    assert c['endpoint'] == 'https://api.deepseek.com/v1/chat/completions', c
    assert c['key'] == 'Bearer sk-ds-123'
    assert c['model'] == 'deepseek-v4-pro'


def test_group_send_without_key_fails_loudly():
    result = _boot(r"""
  let err = null;
  try {
    await vmRun('groupCallModel')({ members: [], endpoints: {} },
      { id:'m2', name:'UI设计', model:'deepseek::deepseek-flash' },
      [{ role:'user', content:'hi' }], function(){}, function(){});
  } catch (e) { err = String(e && e.message || e); }
  return {err: err};
""", 'ep_nokey')
    assert result['err'] and 'UI设计' in result['err'] and '端点' in result['err'], result
