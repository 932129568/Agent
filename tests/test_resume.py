# -*- coding: utf-8 -*-
"""Resume 恢复机制（Round 16，2026-11-05 主理人立项）。

「完整实现 resume 机制，并在全部功能场景中完整运用，确保中断后可接续且状态一致。」

主缺口（本文件锁定）：网络断流等 error 路径此前丢弃部分正文、不配平 tool_calls、
runStatus=failed 且无恢复入口。验收口径：
1. 错误分类：网络/超时/5xx/429 可恢复；401/余额/400 确定性失败不可恢复；
2. 横幅判定：paused+尾部 assistant/tool 才弹；completed/空会话不弹；
3. 横幅交互：继续 → 回调触发；放弃 → 状态收敛 completed；
4. run-controller error 路径已接 isResumableError（源码断言）。
"""
from pathlib import Path

from test_connect_merge import _run_node

ROOT = Path(__file__).resolve().parent.parent
RESUME_JS = ROOT / 'frontend' / 'src' / 'agent' / 'resume.js'
RUN_CTRL = ROOT / 'frontend' / 'src' / 'agent' / 'run-controller.js'


def _run(body, name):
    return _run_node((r"""
async function __main() {
  const ctx = __ctx({callApi: async function(){ return '{}'; }});
  __run(ctx, __fe('resume.js'));
""" + body + """
}
"""), name)


def test_error_classification():
    result = _run(r"""
  const f = __vm.runInContext('isResumableError', ctx);
  return {
    net: f('Failed to fetch'),
    timeout: f('Request timeout after 30s'),
    srv: f('HTTP 502: bad gateway'), srv2: f('HTTP 500'),
    rate: f('HTTP 429: too many requests'),
    cn: f('连接已重置'), cn2: f('请求超时'),
    auth: f('HTTP 401: unauthorized'),
    bad: f('HTTP 400: invalid params'),
    plain: f('something odd'),
    empty: f('')
  };
""", 'resume_cls')
    assert result['net'] and result['timeout'] and result['srv'] and result['srv2']
    assert result['rate'] and result['cn'] and result['cn2']
    assert not result['auth'] and not result['bad'] and not result['plain'] and not result['empty']


def test_should_offer_resume_matrix():
    result = _run(r"""
  const f = __vm.runInContext('shouldOfferResume', ctx);
  const mk = (runStatus, lastRole, toolCalls) => ({ runStatus, messages: (() => {
    const arr = [{ role: 'user', content: '帮我读文件并总结' }];
    if (lastRole === 'assistant') {
      const a = { role: 'assistant', content: '部分输出…' };
      if (toolCalls) a.tool_calls = [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }];
      arr.push(a);
    } else if (lastRole === 'tool') {
      arr.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
      arr.push({ role: 'tool', tool_call_id: 'c1', content: '...' });
    }
    return arr;
  })() });
  return {
    pausedAssistant: f(mk('paused', 'assistant', false)),
    pausedTool: f(mk('paused', 'tool', false)),
    pausedToolCalls: f(mk('paused', 'assistant', true)),
    completed: f(mk('completed', 'assistant', false)),
    failed: f(mk('failed', 'assistant', false)),
    empty: f({ runStatus: 'paused', messages: [] }),
    null: f(null)
  };
""", 'resume_should')
    assert result['pausedAssistant'] and result['pausedTool'] and result['pausedToolCalls']
    assert not result['completed'] and not result['failed'] and not result['empty'] and not result['null']


def test_banner_continue_and_dismiss():
    result = _run(r"""
  const script = `(function(){
  const el = document.createElement('div');
  const box = document.createElement('div');
  const s = { runStatus: 'paused', messages: [
    { role: 'user', content: '任务' },
    { role: 'assistant', content: '写到一半…' } ] };
  let continued = 0, dismissed = 0;
  const actions = { onContinue: function(){ continued++; },
                    onDismiss: function(){ dismissed++; } };
  const banner = resumeBannerMount(box, s, actions);
  const shown = !!banner && !!box.children.length;
  const text = (banner && banner.__textEl) ? banner.__textEl.textContent : '';
  // 点继续
  box.children[0].__continue();
  // 点放弃（新挂一条）
  const b2 = resumeBannerMount(box, s, actions);
  box.children[0].__dismiss();
  return {shown: shown, text: text, continued: continued, dismissed: dismissed,
          statusAfterDismiss: s.runStatus};
  })()`;
  return __vm.runInContext(script, ctx);
""", 'resume_banner')
    assert result['shown'] is True
    assert '中断' in result['text'] and '保留' in result['text']
    assert result['continued'] == 1 and result['dismissed'] == 1
    assert result['statusAfterDismiss'] == 'completed'


def test_banner_not_mounted_for_healthy_session():
    result = _run(r"""
  const script = `(function(){
  const box = document.createElement('div');
  const s = { runStatus: 'completed', messages: [{ role: 'user', content: 'hi' }] };
  const banner = resumeBannerMount(box, s, {});
  return {mounted: !!banner, kids: box.children.length};
  })()`;
  return __vm.runInContext(script, ctx);
""", 'resume_none')
    assert result['mounted'] is None or result['mounted'] is False
    assert result['kids'] == 0


def test_run_controller_wires_resumable_error_path():
    src = RUN_CTRL.read_text(encoding='utf-8')
    assert 'isResumableError(err.message)' in src
    # error 路径（非 abort）也要固化部分正文 + 配平 + paused
    assert 'if (typeof isResumableError === \'function\' && isResumableError(err.message)) {' in src
    assert "(err.name === 'AbortError' || userStopped || _resumable) ? 'paused' : 'failed'" in src


def test_render_hooks_banner():
    src = (ROOT / 'frontend' / 'src' / 'sessions' / 'controller.js').read_text(encoding='utf-8')
    assert 'shouldOfferResume(s)' in src and 'resumeBannerMount(box, s' in src


def test_banner_plan_context_enrichment():
    """挂 plan.task_id 的中断会话：横幅文案升级为计划视角（plan_get 异步增强）。"""
    result = _run(r"""
  const ctx2 = ctx;
  __run(ctx2, "globalThis.__calls = []; globalThis.callApi = async function(name, args){"
    + " globalThis.__calls.push({name: name, args: args});"
    + " return JSON.stringify({ plan: { title: '重构登录页', status: 'executing',"
    + " steps: [{status:'done'},{status:'doing'},{status:'todo'}] } }); };");
  const script = `(function(){
    const box = document.createElement('div');
    const s = { runStatus: 'paused', plan: { task_id: 't1' },
                messages: [{role:'user',content:'go'},{role:'assistant',content:'...'}] };
    const b = resumeBannerMount(box, s, {});
    return new Promise(function(res){
      setTimeout(function(){ res({ text: b && b.__textEl ? b.__textEl.textContent : '',
        calls: globalThis.__calls.length }); }, 30);
    });
  })()`;
  return __vm.runInContext(script, ctx2);
""", 'resume_plan')
    assert '重构登录页' in result['text'] and '2/3' in result['text'], result
    assert result['calls'] >= 1
