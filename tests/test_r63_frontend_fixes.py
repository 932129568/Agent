# -*- coding: utf-8 -*-
"""R63 前端修复回归（vm 沙箱，零网络——stub fetch 供确定性流）。

覆盖用户真机报障的三个修复：
1. 本地模型流「Failed to execute 'getReader' on 'ReadableStream': already
   locked」——Response.body 只读 getter 上赋值静默失败，包装器锁死原流；
   修复后须以重建的 Response 返回且内容完整可读。
2. 群聊用户暂停的中止不再伪装「调用失败」——groupIsAbortError 分类 +
   groupCallModel 带 partialText 转交。
3. 群文件归档完整发言（正文+交接文档全量，不再只存文档小节）。

模式约定：大块编排在 __main（node 侧），vm 只收小片段；fetch/Response 等
Web API 由 node 原生桥进 vm。
"""
from helpers.legacy_vm import _run_node


def test_local_stream_response_rebuild_no_double_lock():
    """本地路径（local=true 槽位包装器）读出的 SSE 内容必须完整且不双锁。"""
    result = _run_node(r"""
async function __main() {
  const stubFetch = async function (url, init) {
    const enc = new TextEncoder();
    const chunks = [
      enc.encode('data: {"choices":[{"delta":{"content":"第一"}}]}\n\n'),
      enc.encode('data: {"choices":[{"delta":{"content":"段正文"}}]}\n\n'),
      enc.encode('data: [DONE]\n\n'),
    ];
    const stream = new ReadableStream({ start(c) { chunks.forEach(x => c.enqueue(x)); c.close(); } });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  const ctx = __ctx({ callApi: async function(){ return '{}'; },
    fetch: stubFetch, Response, ReadableStream, TextEncoder, TextDecoder });
  __run(ctx, __fe('request.js'));
  __run(ctx, __fe('sse-parser.js'));
  const out = await __vm.runInContext("(async () => {"
    + " const request = { endpoint: 'http://local-stub/v1/chat/completions', apiKey: 'x', local: true,"
    + "   body: { model: 'q', stream: true, messages: [{ role: 'user', content: 'hi' }] }, proxyHeaders: {} };"
    + " const resp = await ModelTransport.stream(request, undefined);"
    + " if (!resp || !resp.ok) return 'ERR: status ' + (resp && resp.status);"
    + " const parsed = await parseSseStream(resp.body, {});"
    + " return 'content=' + parsed.content;"
    + " })()", ctx);
  return { out: String(out) };
}
""", 'local_stream')
    assert 'content=第一段正文' in result['out'], result
    assert 'locked' not in result['out'].lower(), result


def test_group_abort_classified_not_failure():
    """用户暂停的中止 → groupIsAbortError 命中；groupCallModel 抛错带 partialText。"""
    result = _run_node(r"""
async function __main() {
  const ctx = __ctx({ callApi: async function(){ return '{}'; } });
  __run(ctx, __fe('group.js'));
  const vmRun = function(code){ return __vm.runInContext(code, ctx); };
  const out = await vmRun("(async () => {"
    + " const steps = [];"
    + " steps.push('cls1=' + groupIsAbortError({ name: 'AbortError' }));"
    + " steps.push('cls2=' + groupIsAbortError(new Error('signal is aborted without reason')));"
    + " steps.push('cls3=' + groupIsAbortError(new Error('HTTP 500 oops')));"
    + " const s = { id: 'sX', messages: [], group: { members: ["
    + "   { id: 'm1', name: '主持人', host: true, model: '', role: '' },"
    + "   { id: 'm2', name: 'UI设计', host: false, model: '', role: '' } ],"
    + "   phase: 'running', turn: 'm1', round: 0, autoRelay: true } };"
    + " groupLoadTools = async function(){ return []; };"
    + " uiEndpointSnapshot = function(){ return { endpoint: 'http://x', apiKey: 'k' }; };"
    + " document = { getElementById: function(){ return null; } };"
    + " ModelTransport = { stream: async function(){ const e = new Error('用户暂停接力'); e.name = 'AbortError'; throw e; } };"
    + " try {"
    + "   await groupCallModel(s, s.group.members[0], [{ role: 'user', content: 'hi' }], function(){}, function(){});"
    + "   steps.push('no-throw');"
    + " } catch (e) {"
    + "   steps.push('aborted=' + (e.aborted === true) + ' partial=' + (e.partialText === ''));"
    + " }"
    + " return steps.join(' | ');"
    + " })()");
  return { out: String(out) };
}
""", 'group_abort')
    assert result['out'] == 'cls1=true | cls2=true | cls3=false | aborted=true partial=true', result


def test_group_archive_keeps_full_text():
    """归档正文 = 完整发言（正文+交接文档），不再截掉正文。"""
    result = _run_node(r"""
async function __main() {
  const ctx = __ctx({ callApi: async function(){ return '{}'; } });
  __run(ctx, __fe('group.js'));
  __run(ctx, __fe('files.js'));
  const vmRun = function(code){ return __vm.runInContext(code, ctx); };
  vmRun("globalThis.__saved = [];");
  vmRun("callApi = async function(name, args){ globalThis.__saved.push({ name: name, args: args });"
    + " return JSON.stringify({ path: 'p', name: 'n' }); };");
  const out = await vmRun("(async () => {"
    + " const s = { id: 's1', title: '群', messages: [], group: { members: ["
    + "   { id: 'm1', name: '主持人', host: true, model: '', role: '' },"
    + "   { id: 'm2', name: 'UI设计', host: false, model: '', role: '' } ], phase: 'paused', round: 1 } };"
    + " const text = '这是方案正文的要点一。\\n这是要点二。\\n【交接文档】\\n- 交接给: UI设计\\n- 本次产出: 方案';"
    + " await groupArchiveHandoff(s, { id: 'm1', name: '主持人' }, text, 1);"
    + " const call = __saved.find(function(x){ return x.name === 'group_files_write'; }) || { args: [] };"
    + " return JSON.stringify(call.args);"
    + " })()");
  const args = JSON.parse(out);
  return { contentArg: String(args[4] || '') };
}
""", 'archive_full')
    content = result['contentArg']
    assert '这是方案正文的要点一' in content, content      # 正文保留
    assert '这是要点二' in content, content
    assert '【交接文档】' in content and '交接给: UI设计' in content, content  # 文档小节保留
