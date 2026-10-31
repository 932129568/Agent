# -*- coding: utf-8 -*-
"""New-chat, task/space grouping, expert chip and access toggle regressions."""
import re
from pathlib import Path

from test_connect_merge import _run_node
from test_model_executor_foundation import run_case

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / 'frontend' / 'index.template.html'


def test_template_has_new_chat_project_expert_and_access_surfaces():
    tpl = TEMPLATE.read_text(encoding='utf-8')
    assert 'id="panelChat"' in tpl and 'id="newChatScreen"' in tpl and 'id="chatContainer"' in tpl
    assert tpl.index('id="newChatScreen"') < tpl.index('id="chatContainer"')
    for dom_id in ('newChatNewTaskBtn', 'newChatNewProjectBtn', 'newChatHistory',
                   'projectModal', 'projectNameInput', 'projectWorkspaceInput',
                   'projectBrowseBtn', 'projectCreateBtn', 'accessToggle'):
        assert 'id="%s"' % dom_id in tpl, dom_id
    assert 'id="new-chat-btn"' in tpl and 'onclick="openNewChatScreen()"' in tpl
    assert 'id="sessionsNewChatBtn"' in tpl
    assert re.search(r'id="wsQuick"\s+hidden', tpl)
    assert re.search(r'id="wsqInd"[^>]*hidden', tpl)
    assert '允许完全访问' in tpl and '仍受命令沙箱与安全护栏限制' in tpl
    assert re.search(r'id="expertRunSelectedBtn"\s+hidden', tpl)
    assert 'id="expertSelectionChip"' in tpl
    row = re.search(r'<div class="input-row">(.*?)<div class="hint">', tpl, re.S)
    assert row and 'id="expertSelectionChip"' in row.group(1)
    assert '选择此专家（发送时自动加载）' in tpl
    for old in ('id="sessionList"', 'id="userInput"', 'id="sendBtn"',
                'id="expertPickerBtn"', 'id="expertSelectBtn"', 'id="chatContainer"'):
        assert old in tpl, old
    chat_css = (ROOT / 'frontend' / 'styles' / 'features' / 'chat.css').read_text(encoding='utf-8')
    assert '.session-group-body[hidden],.project-sessions[hidden]{display:none!important}' in chat_css


def test_normalize_sessions_keeps_project_binding_fields():
    result = run_case(r'''
const out = normalizeSessions(JSON.stringify([
  {id:'task', messages:[], updatedAt:1},
  {id:'project', messages:[], updatedAt:2, projectId:'p1', projectName:'项目一',
   projectWorkspace:'D:/work/one'},
  {id:'bad', messages:[], projectId:'   ', projectName:' ', projectWorkspace:''}
]));
return out;
''', ['frontend/src/sessions/store.js'])
    by_id = {item['id']: item for item in result}
    assert 'projectId' not in by_id['task'] and 'projectName' not in by_id['task']
    assert by_id['project']['projectId'] == 'p1'
    assert by_id['project']['projectName'] == '项目一'
    assert by_id['project']['projectWorkspace'] == 'D:/work/one'
    assert 'projectId' not in by_id['bad']


def test_send_message_routes_selected_expert_before_ordinary_send():
    result = run_case(r'''
globalThis.attachments = [];
globalThis.isStreaming = false;
globalThis.currentSessionId = 's-demo';
globalThis.expertNextSelection = {packageId:'demo.expert'};
let calls = 0;
globalThis.runExpertSelection = async function(){
  calls += 1;
  return {status:'expert_loaded'};
};
const out = await sendMessage();
return {out: out, calls: calls};
''', ['frontend/src/chat/send.js'])
    assert result['calls'] == 1
    assert result['out']['status'] == 'expert_loaded'


def test_access_toggle_maps_full_and_readonly_to_tool_mode():
    result = _run_node(r"""
async function __main() {
  const mode = __doc.getElementById('toolMode'); mode.value = 'readonly';
  const toggle = __doc.getElementById('accessToggle');
  toggle.setAttribute = function(name, value){ this.dataset[name] = value; };
  const ctx = __ctx({});
  __run(ctx, __fe('38-ws-quick.js'));
  ctx.accessToggleSync();
  const off = {mode: mode.value, pressed: toggle.dataset['aria-pressed'], on: toggle.classList.contains('on')};
  ctx.accessToggleToggle();
  const full = {mode: mode.value, pressed: toggle.dataset['aria-pressed'], on: toggle.classList.contains('on')};
  ctx.accessToggleToggle();
  const readonly = {mode: mode.value, pressed: toggle.dataset['aria-pressed']};
  return {off: off, full: full, readonly: readonly};
}
""", 'project_access_toggle')
    assert result['off'] == {'mode': 'readonly', 'pressed': 'false', 'on': False}
    assert result['full'] == {'mode': 'full', 'pressed': 'true', 'on': True}
    assert result['readonly'] == {'mode': 'readonly', 'pressed': 'false'}


def test_project_creation_persistence_grouping_and_new_chat_screen():
    result = _run_node(r"""
async function __main() {
  const storage = {};
  const localStorage = {
    getItem: function(key){ return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
    setItem: function(key, value){ storage[key] = String(value); },
  };
  const sessions = [{id:'task1', title:'旧任务', createdAt:1, updatedAt:2, messages:[]}];
  const calls = [];
  let saves = 0;
  const ctx = __ctx({
    sessions: sessions,
    currentSessionId: 'task1',
    localStorage: localStorage,
    guardTrusted: new Set(), mcpTrusted: new Set(), agentTrusted: new Set(),
    isStreaming: false, abortController: null,
    requestAnimationFrame: function(fn){ fn(); },
    renderPreview: function(){}, renderChatHistory: function(){},
    updateLiveTokenStat: function(){}, updateTokenStat: function(){},
    refreshWsCard: function(){}, toast: function(){},
    saveSessions: async function(){ saves += 1; },
    callApi: async function(name, args){ calls.push({name:name, args:args}); return '{}'; },
    getCurrentSession: function(){ return sessions.find(function(s){ return s.id === ctx.currentSessionId; }) || null; },
    escapeHtml: function(value){ return String(value == null ? '' : value)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;'); },
  });
  __run(ctx, __fe('85-session-mgmt.js'));
  const screen = __doc.getElementById('newChatScreen');
  const inputArea = __doc.getElementById('chatInputArea');
  ctx.openNewChatScreen();
  const newScreen = {screenHidden: screen.hidden, inputHidden: inputArea.hidden,
    currentSessionId: ctx.currentSessionId};
  const modal = __doc.getElementById('projectModal');
  modal.setAttribute = function(name, value){ this.dataset[name] = value; };
  __doc.getElementById('projectNameInput').value = '项目A';
  __doc.getElementById('projectWorkspaceInput').value = 'D:/very/long/workspace/project-a';
  await ctx.createProjectFromModal();
  const projectRecord = JSON.parse(storage['glm_projects'] || '[]')[0];
  const projectSession = sessions.find(function(s){ return s.projectId === projectRecord.id; });
      const projectHtml = ctx._sessionGroupsHtml({showActions: true});
      ctx.toggleTaskGroup();
      const taskCollapsedHtml = ctx._sessionGroupsHtml({showActions: true});
      ctx.toggleTaskGroup();
      ctx.toggleProjectGroup(projectRecord.id);
      const projectCollapsedHtml = ctx._sessionGroupsHtml({showActions: true});
  const wsCalls = calls.filter(function(call){ return call.name === 'set_session_ws'; });
  return {
    newScreen: newScreen,
    storage: storage,
    project: projectRecord,
    projectSession: projectSession,
    currentSessionId: ctx.currentSessionId,
    saveCount: saves,
    wsCalls: wsCalls,
    projectHtml: projectHtml,
    taskCollapsedHtml: taskCollapsedHtml,
    projectCollapsedHtml: projectCollapsedHtml,
  };
}
""", 'project_groups')
    assert result['newScreen'] == {'screenHidden': False, 'inputHidden': True,
                                   'currentSessionId': None}
    project = result['project']
    assert project['name'] == '项目A'
    assert project['workspace'] == 'D:/very/long/workspace/project-a'
    assert result['projectSession']['projectName'] == '项目A'
    assert result['projectSession']['projectWorkspace'] == project['workspace']
    assert result['currentSessionId'] == result['projectSession']['id']
    assert result['saveCount'] >= 1
    assert any(call['args'][0] == result['projectSession']['id'] and
               call['args'][1] == project['workspace'] and call['args'][2] is True
               for call in result['wsCalls'])
    assert '任务' in result['projectHtml'] and '空间' in result['projectHtml']
    assert '项目A' in result['projectHtml'] and 'project-a' in result['projectHtml']
    assert '在此项目中新建对话' in result['projectHtml']
    assert 'data-project-new="' + project['id'] + '"' in result['projectHtml']
    assert 'hidden' in result['taskCollapsedHtml'].split('session-group-body', 1)[1].split('>', 1)[0]
    assert 'hidden' in result['projectCollapsedHtml'].split('project-sessions', 1)[1].split('>', 1)[0]


def test_project_lookup_falls_back_to_session_metadata_before_projects_load():
    result = run_case(r'''
globalThis.sessions = [{id:'s1', projectId:'p1', projectName:'断桥项目',
  projectWorkspace:'D:/offline/workspace', createdAt:1, updatedAt:2}];
const project = projectById('p1');
return project;
''', ['frontend/src/sessions/controller.js'])
    assert result['id'] == 'p1'
    assert result['name'] == '断桥项目'
    assert result['workspace'] == 'D:/offline/workspace'


def test_project_session_jumps_when_bridge_and_persistence_fail():
    result = _run_node(r"""
async function __main() {
  const storage = {};
  const localStorage = {
    getItem: function(key){ return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
    setItem: function(key, value){ storage[key] = String(value); },
  };
  const sessions = [];
  const ctx = __ctx({
    sessions: sessions, currentSessionId: null, localStorage: localStorage,
    guardTrusted: new Set(), mcpTrusted: new Set(), agentTrusted: new Set(),
    isStreaming: false, abortController: null, requestAnimationFrame: function(fn){ fn(); },
    renderPreview: function(){}, updateLiveTokenStat: function(){}, updateTokenStat: function(){},
    refreshWsCard: function(){}, toast: function(){},
    saveSessions: async function(){ throw new Error('bridge down'); },
    callApi: function(){ throw new Error('bridge down'); },
    getCurrentSession: function(){ return sessions.find(function(s){ return s.id === ctx.currentSessionId; }) || null; },
    escapeHtml: function(value){ return String(value == null ? '' : value)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;'); },
  });
  __run(ctx, __fe('85-session-mgmt.js'));
  const modal = __doc.getElementById('projectModal');
  modal.setAttribute = function(name, value){ this.dataset[name] = value; };
  __doc.getElementById('projectNameInput').value = '断桥项目';
  __doc.getElementById('projectWorkspaceInput').value = 'D:/offline/workspace';
  await ctx.createProjectFromModal();
  return {
    count: sessions.length,
    currentSessionId: ctx.currentSessionId,
    sessionId: sessions[0] && sessions[0].id,
    projectId: sessions[0] && sessions[0].projectId,
    screenHidden: __doc.getElementById('newChatScreen').hidden,
    chatHidden: __doc.getElementById('chatContainer').hidden,
    inputHidden: __doc.getElementById('chatInputArea').hidden,
  };
}
""", 'project_bridge_failure')
    assert result['count'] == 1
    assert result['currentSessionId'] == result['sessionId']
    assert result['projectId']
    assert result['screenHidden'] is True
    assert result['chatHidden'] is False
    assert result['inputHidden'] is False
