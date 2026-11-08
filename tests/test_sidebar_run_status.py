# -*- coding: utf-8 -*-
"""Left sidebar history, run-status and background-run ownership regressions."""
from pathlib import Path

from test_connect_merge import _run_node
from test_model_executor_foundation import run_case

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / 'frontend' / 'index.template.html'
CHAT_CSS = ROOT / 'frontend' / 'styles' / 'features' / 'chat.css'
SHELL_CSS = ROOT / 'frontend' / 'styles' / 'shell.css'


def test_sidebar_history_is_fixed_and_central_history_is_hidden():
    tpl = TEMPLATE.read_text(encoding='utf-8')
    css = CHAT_CSS.read_text(encoding='utf-8')
    assert tpl.index('class="sidebar-header"') < tpl.index('id="sidebarHistory"') < tpl.index('class="side-note"')
    assert 'id="sessionList"' in tpl
    central = tpl.split('id="newChatHistory"', 1)[1].split('>', 1)[0]
    assert 'hidden' in central
    assert '.sidebar-history{flex:1;min-height:0;overflow:auto' in css
    assert 'session-status.working' in css and '#2fbf71' in css and '#e55353' in css
    shell = SHELL_CSS.read_text(encoding='utf-8')
    assert 'body.sidebar-open .sidebar{transform:translateX(0)' in shell
    assert 'animation:none!important' in shell   # v4BootRail must not override drawer transform
    assert 'id="sidebarBackdrop"' in tpl
    send_src = (ROOT / 'frontend' / 'src' / 'chat' / 'send.js').read_text(encoding='utf-8')
    assert "classList.toggle('sidebar-open'" in send_src
    run_src = (ROOT / 'frontend' / 'src' / 'agent' / 'run-controller.js').read_text(encoding='utf-8')
    assert "setSessionRunStatus(s, 'working')" in run_src
    assert "naturalDone ? 'completed' : 'paused'" in run_src
    assert "'paused' : 'failed'" in run_src


def test_normalize_sessions_keeps_known_run_status_only():
    result = run_case(r'''
return normalizeSessions(JSON.stringify([
  {id:'a', messages:[], runStatus:'working'},
  {id:'b', messages:[], runStatus:'completed'},
  {id:'c', messages:[], runStatus:'paused'},
  {id:'d', messages:[], runStatus:'failed'},
  {id:'e', messages:[], runStatus:'weird'}
]));
''', ['frontend/src/sessions/store.js'])
    assert [item.get('runStatus') for item in result] == [
        'working', 'completed', 'paused', 'failed', None]


def test_run_status_persistence_migration_and_sidebar_sync():
    result = _run_node(r"""
async function __main() {
  const sessions = [
    {id:'work', title:'工作中', updatedAt:1, messages:[{role:'user',content:'x'}], runStatus:'working'},
    {id:'done', title:'已完成', updatedAt:2, messages:[{role:'assistant',content:'x'}], runStatus:'completed'},
    {id:'pause', title:'已暂停', updatedAt:3, messages:[{role:'assistant',content:'x'}], runStatus:'paused'},
    {id:'fail', title:'失败', updatedAt:4, messages:[{role:'assistant',content:'x'}], runStatus:'failed'},
    {id:'plain', title:'普通', updatedAt:5, messages:[]},
  ];
  let saves = 0;
  const ctx = __ctx({
    sessions: sessions, currentSessionId: 'work',
    guardTrusted: new Set(), mcpTrusted: new Set(), agentTrusted: new Set(),
    isStreaming: false, abortController: null, requestAnimationFrame: function(fn){ fn(); },
    saveSessions: function(){ saves += 1; },
    callApi: async function(){ return '{}'; },
    renderPreview: function(){}, refreshWsCard: function(){},
    updateTokenStat: function(){}, updateLiveTokenStat: function(){},
    getCurrentSession: function(){ return sessions.find(function(s){ return s.id === ctx.currentSessionId; }) || null; },
    escapeHtml: function(value){ return String(value == null ? '' : value)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;'); },
  });
  __run(ctx, __fe('85-session-mgmt.js'));
  ctx.renderSessionList();
  const initialSidebar = __doc.getElementById('sidebarHistory').innerHTML;
  const migrated = ctx.migrateWorkingRunStatuses();
  ctx.renderSessionList();
  const sidebar = __doc.getElementById('sidebarHistory').innerHTML;
  const panel = __doc.getElementById('sessionList').innerHTML;
  const statusCount = (initialSidebar.match(/class="session-status /g) || []).length;
  const statusesBefore = sessions.map(function(s){ return s.runStatus || ''; });
  ctx.setSessionRunStatus('done', 'paused');
  return {migrated: migrated, statuses: statusesBefore, initialSidebar: initialSidebar,
    sidebar: sidebar, panel: panel, same: sidebar === panel, statusCount: statusCount,
    sidebarSids: (sidebar.match(/data-sid=/g) || []).length,
    panelSids: (panel.match(/data-sid=/g) || []).length,
    saves: saves, afterUpdate: sessions[1].runStatus};
}
""", 'run_status_sidebar')
    assert result['migrated'] == 1
    assert result['statuses'] == ['paused', 'completed', 'paused', 'failed', '']
    # R31：会话面板升级为富卡片（sk-card），侧栏仍为紧凑列表——不再共用同一渲染；
    # 但两者必须覆盖同一批会话（同一数据源）。
    assert result['same'] is False
    assert result['sidebarSids'] >= result['panelSids'] > 0
    assert 'sh-card' in result['panel'] and 'sh-card' not in result['sidebar']
    assert result['statusCount'] == 4
    assert 'session-status working' in result['initialSidebar']
    assert 'session-status completed' in result['initialSidebar']
    assert 'session-status paused' in result['initialSidebar']
    assert 'session-status failed' in result['initialSidebar']
    assert '进行中' in result['initialSidebar']
    assert 'session-status working' not in result['sidebar']
    assert result['afterUpdate'] == 'paused'
    assert result['saves'] >= 2


def test_switch_session_and_new_session_background_existing_run_without_cancel():
    result = _run_node(r"""
async function __main() {
  const sessions = [
    {id:'a', title:'A', updatedAt:1, messages:[]},
    {id:'b', title:'B', updatedAt:2, messages:[]},
  ];
  const run = {id:1, sessionId:'a', session:sessions[0], cancelled:false, background:false,
    abortController:{abort:function(){}}, nudgeTimer:null, localWaitTimer:null, stopHandler:function(){}};
  const syncTargets = [];
  const calls = [];
  let saves = 0;
  const ctx = __ctx({
    sessions: sessions, currentSessionId: 'a', RunRegistry: {current: function(){ return run; }},
    guardTrusted: new Set(), mcpTrusted: new Set(), agentTrusted: new Set(),
    isStreaming: false, abortController: null, requestAnimationFrame: function(fn){ fn(); },
    saveSessions: function(){ saves += 1; }, callApi: async function(name, args){ calls.push({name:name,args:args}); return '{}'; },
    renderPreview: function(){}, refreshWsCard: function(){}, updateTokenStat: function(){},
    updateLiveTokenStat: function(){},
    syncAgentRunUiForSession: function(target){ syncTargets.push(target); run.background = target !== run.sessionId; },
    getCurrentSession: function(){ return sessions.find(function(s){ return s.id === ctx.currentSessionId; }) || null; },
    escapeHtml: function(value){ return String(value == null ? '' : value)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;'); },
  });
  __run(ctx, __fe('85-session-mgmt.js'));
  ctx.switchSession('b', true);
  const afterSwitch = {cancelled: run.cancelled, background: run.background,
    current: ctx.currentSessionId, target: syncTargets[syncTargets.length - 1]};
  ctx.newSession();
  return {afterSwitch: afterSwitch, afterNew: {cancelled: run.cancelled, background: run.background,
    current: ctx.currentSessionId, target: syncTargets[syncTargets.length - 1]}, saves: saves,
    calls: calls};
}
""", 'background_switch')
    assert result['afterSwitch'] == {'cancelled': False, 'background': True,
                                     'current': 'b', 'target': 'b'}
    assert result['afterNew']['cancelled'] is False
    assert result['afterNew']['background'] is True
    assert result['afterNew']['current'] is None
    assert result['afterNew']['target'] is None
    assert not [call for call in result['calls'] if call['name'] in ('set_current_sid', 'clear_caches')]


def test_background_shadow_message_does_not_touch_visible_chat():
    result = _run_node(r"""
async function __main() {
  const ctx = __ctx({
    currentSessionId: 'other',
    renderMd: function(text){ return '<p>' + String(text || '') + '</p>'; },
    escapeHtml: function(value){ return String(value == null ? '' : value)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); },
  });
  __run(ctx, __fe('60-agent-loop.js'));
  const run = {id:1, sessionId:'hidden', cancelled:false, background:true,
    assistantMsg:null, abortController:null, nudgeTimer:null, localWaitTimer:null};
  ctx.__testRun = run;
  __run(ctx, '__agentActiveRun = __testRun');
  const shadow = ctx.runAddMessage(run, 'assistant', 'background text');
  return {visibleHtml: __doc.getElementById('chatContainer').innerHTML,
    shadowHtml: shadow.innerHTML, visible: ctx.agentRunVisible(run),
    current: ctx.agentRunCurrent(run)};
}
""", 'background_shadow')
    assert result['visibleHtml'] == ''
    assert 'background text' in result['shadowHtml']
    assert result['visible'] is False
    assert result['current'] is True


def test_send_message_cross_session_is_parallel_without_warning():
    """跨会话发送默认并行(主理人 2026-11-01 裁定,取代原「先提示再拦截」)。

    原断言「另一个会话正在运行」已被产品决策删除:跨会话发送直接进并行 run。
    这里守住新语义的两条不变量——不弹拦截提示、不被 isStreaming 全局标志挡回
    (能走到读取输入框这一步即证明守卫已放行)。
    """
    result = run_case(r'''
globalThis.attachments = [];
globalThis.isStreaming = true;
globalThis.currentSessionId = 'b';
const toasts = [];
globalThis.toast = function(message){ toasts.push(String(message)); };
globalThis.RunRegistry = {current: function(){ return {
  id: 1, sessionId: 'a', cancelled: false, background: true
}; }};
let inputRead = false;
globalThis.document = { getElementById: function(){ inputRead = true;
  return { value: 'x', classList: { add(){}, remove(){} }, scrollTop: 0, scrollHeight: 0 }; } };
try { await sendMessage(); } catch (e) { /* 后续依赖未装载,只校验守卫放行 */ }
return { toasts, inputRead };
''', ['frontend/src/chat/send.js'])
    assert result['inputRead'] is True, '跨会话发送应放行到输入读取(并行),而非提前 return'
    assert not any('另一个会话正在运行' in message for message in result['toasts'])
