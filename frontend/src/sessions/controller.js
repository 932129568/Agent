/* ================= 会话管理 ================= */
const PROJECTS_KEY = 'glm_projects';
let projects = [];
let _taskGroupCollapsed = false;
const _collapsedProjects = new Set();

async function continueInNewSession() {
  const s = getCurrentSession();
  const btn = document.getElementById('continueNewBtn');
  if (!s || !s.messages.length) { newSession(); return; }
  const apiKey = effectiveApiKey();
  if (!apiKey) { toast('请先设置 API Key', 'warn'); document.getElementById('settingsPanel').classList.add('show'); return; }
  if (btn) btn.textContent = '⏳ 总结中…';
  // 实现 v1.6 W28：生成中 compactNow 会静默跳过压缩（isStreaming 早退），原流程
  // 仍继续 newSession() → 用户在新会话丢失全部上下文且无感知。生成中直接中止并明示。
  if (isStreaming) {
    toast('AI 正在生成中，稍后再「新对话继续」（避免未压缩就开新会话丢失上下文）', 'warn');
    if (btn) btn.innerHTML = '<svg class="ui-icon ui-icon-16" aria-hidden="true"><use href="#i-arrow"></use></svg>新对话继续';
    return;
  }
  try { await compactNow(s, apiKey, { quiet: false }); }
  catch (e) {
    // 修复 W25（二轮）：压缩失败不再静默吞——否则用户在新会话丢失全部上下文且无察觉
    toast('历史压缩失败，已中止开新会话（当前对话未受影响）：' + (e && e.message || e), 'err');
    if (btn) btn.innerHTML = '<svg class="ui-icon ui-icon-16" aria-hidden="true"><use href="#i-arrow"></use></svg>新对话继续';
    return;
  }
  newSession();
  if (btn) btn.innerHTML = '<svg class="ui-icon ui-icon-16" aria-hidden="true"><use href="#i-arrow"></use></svg>新对话继续';
  document.getElementById('userInput').focus();
}
function normalizeProjects(raw) {
  let arr = [];
  try {
    const parsed = (typeof raw === 'string') ? JSON.parse(raw || '[]') : raw;
    if (Array.isArray(parsed)) arr = parsed;
  } catch (e) { arr = []; }
  const now = Date.now();
  return arr.filter(x => x && typeof x === 'object').map(x => ({
    id: x.id ? String(x.id) : ('p_' + now + '_' + Math.random().toString(36).slice(2, 7)),
    name: String(x.name || '未命名项目').trim().slice(0, 60) || '未命名项目',
    workspace: String(x.workspace || '').trim(),
    createdAt: Number(x.createdAt) || now,
    updatedAt: Number(x.updatedAt) || now,
  })).filter(x => x.workspace);
}
function loadProjects() {
  try {
    projects = normalizeProjects(localStorage.getItem(PROJECTS_KEY) || '[]');
  } catch (e) { projects = []; }
  return projects;
}
function saveProjects() {
  try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects)); } catch (e) {}
}
function projectById(id) {
  const stored = projects.find(p => p.id === id);
  if (stored) return stored;
  // Browser/no-bridge boot may render project groups from session metadata
  // before loadProjects() runs; resolve that same project so group actions work.
  const session = sessions.find(s => s.projectId === id);
  if (!session) return null;
  return {
    id: id, name: session.projectName || '项目空间',
    workspace: session.projectWorkspace || '',
    createdAt: session.createdAt || Date.now(), updatedAt: session.updatedAt || Date.now(),
  };
}
function _projectSessionCount(projectId) {
  return sessions.filter(s => s.projectId === projectId).length;
}
function _setNewChatScreenVisible(visible) {
  const screen = document.getElementById('newChatScreen');
  const chat = document.getElementById('chatContainer');
  const inputArea = document.getElementById('chatInputArea');
  const runArea = document.getElementById('expertRunArea');
  if (screen) screen.hidden = !visible;
  if (chat) chat.hidden = !!visible;
  if (inputArea) inputArea.hidden = !!visible;
  if (runArea) runArea.hidden = !!visible;
  if (visible) renderNewChatHistory();
}
function openNewChatScreen() {
  // New-chat screen is a selection surface, not a blank session. Reuse the
  // existing reset path so streaming/attachments/trust are cleared safely.
  if (typeof closeSidebarDrawer === 'function') closeSidebarDrawer();
  newSession();
  _setNewChatScreenVisible(true);
  renderNewChatHistory();
  const focus = document.getElementById('newChatNewTaskBtn');
  if (focus && focus.focus) { try { focus.focus(); } catch (e) {} }
}
function _newChatGroupsData() {
  const sorted = [...sessions].filter(s => s && s.id)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const tasks = sorted.filter(s => !s.projectId);
  const known = new Map(projects.map(p => [p.id, p]));
  sorted.forEach(s => {
    if (s.projectId && !known.has(s.projectId)) {
      known.set(s.projectId, {
        id: s.projectId, name: s.projectName || '项目空间',
        workspace: s.projectWorkspace || '', createdAt: s.createdAt || Date.now(),
        updatedAt: s.updatedAt || Date.now(),
      });
    }
  });
  const spaces = [...known.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map(project => ({ project, sessions: sorted.filter(s => s.projectId === project.id) }));
  return { tasks, spaces };
}
const RUN_STATUS_META = {
  working: { label: '进行中', title: '会话正在运行' },
  completed: { label: '已完成', title: '会话已完成' },
  paused: { label: '已暂停', title: '会话已暂停' },
  failed: { label: '运行失败', title: '会话运行失败' },
};
function _runStatusHtml(s) {
  const status = s && s.runStatus;
  const meta = RUN_STATUS_META[status];
  if (!meta) return '';
  const label = status === 'working' ? `<span class="session-status-label">${meta.label}</span>` : '';
  return `<span class="session-status ${status}" role="img" title="${meta.title}" aria-label="${meta.title}">` +
    `<span class="session-status-dot" aria-hidden="true"></span>${label}</span>`;
}
function setSessionRunStatus(sessionOrId, status) {
  if (!RUN_STATUS_META[status]) return false;
  const session = (sessionOrId && typeof sessionOrId === 'object')
    ? sessionOrId : sessions.find(s => s.id === sessionOrId);
  if (!session) return false;
  if (session.runStatus === status) return true;
  session.runStatus = status;
  try { saveSessions(); } catch (e) {}
  try { renderSessionList(); } catch (e) {}
  return true;
}
function migrateWorkingRunStatuses() {
  let migrated = 0;
  sessions.forEach(s => {
    if (s && s.runStatus === 'working') { s.runStatus = 'paused'; migrated += 1; }
  });
  if (migrated) {
    try { saveSessions(); } catch (e) {}
    try { renderSessionList(); } catch (e) {}
  }
  return migrated;
}
function _sessionItemHtml(s, showActions) {
  const acts = showActions ? `<span class="session-acts">
      <button class="session-exp" title="导出为 Markdown" aria-label="导出会话" data-sid="${escapeHtml(s.id)}">⤓</button>
      <button class="session-del" aria-label="删除会话" title="删除会话" data-sid="${escapeHtml(s.id)}">✕</button>
    </span>` : '';
  return `<div class="session-item ${s.id === currentSessionId ? 'active' : ''}" data-sid="${escapeHtml(s.id)}" tabindex="0" role="button" aria-label="${escapeHtml(s.title || '新对话')}">
      <div class="session-title">${escapeHtml(s.title || '新对话')}</div>
      <div class="session-time">${formatTime(s.updatedAt)}${_runStatusHtml(s)}</div>
      ${acts}
    </div>`;
}
function _sessionGroupsHtml(options) {
  const opts = options || {};
  const data = _newChatGroupsData();
  const itemHtml = (s) => _sessionItemHtml(s, !!opts.showActions);
  const tasksHidden = _taskGroupCollapsed;
  let html = '<section class="session-group-block session-group-tasks">' +
    `<button type="button" class="session-group-head" data-group-toggle="tasks" aria-expanded="${tasksHidden ? 'false' : 'true'}">` +
      `<span class="session-group-chevron" aria-hidden="true">${tasksHidden ? '▸' : '▾'}</span>` +
      '<span class="session-group-title">任务</span>' +
      `<span class="session-group-count">${data.tasks.length}</span>` +
    '</button>' +
    `<div class="session-group-body" ${tasksHidden ? 'hidden' : ''}>` +
      (data.tasks.length ? data.tasks.map(itemHtml).join('') : '<div class="session-empty">暂无任务</div>') +
    '</div></section>';
  if (data.spaces.length) {
    html += '<section class="session-group-block session-group-spaces">' +
      '<div class="session-group-head session-group-static"><span class="session-group-title">空间</span></div>';
    data.spaces.forEach(({ project, sessions: projectSessions }) => {
      const collapsed = _collapsedProjects.has(project.id);
      html += `<div class="project-group ${project.id === (getCurrentSession() || {}).projectId ? 'active' : ''}" data-project-id="${escapeHtml(project.id)}">
        <div class="project-head">
          <button type="button" class="project-toggle" data-project-toggle="${escapeHtml(project.id)}" aria-expanded="${collapsed ? 'false' : 'true'}">
            <span class="project-chevron" aria-hidden="true">${collapsed ? '▸' : '▾'}</span>
            <span class="project-copy">
              <span class="project-name">${escapeHtml(project.name)}</span>
              <span class="project-path" title="${escapeHtml(project.workspace)}">${escapeHtml(_shortDir(project.workspace))}</span>
            </span>
            <span class="session-group-count">${projectSessions.length}</span>
          </button>
          <button type="button" class="project-new-chat" data-project-new="${escapeHtml(project.id)}" title="在此项目中新建对话" aria-label="在此项目中新建对话">＋</button>
        </div>
        <div class="project-sessions" ${collapsed ? 'hidden' : ''}>` +
          (projectSessions.length ? projectSessions.map(itemHtml).join('') : '<div class="session-empty">暂无对话</div>') +
        '</div></div>';
    });
    html += '</section>';
  }
  return html;
}
function toggleTaskGroup() {
  _taskGroupCollapsed = !_taskGroupCollapsed;
  renderSessionList();
  renderNewChatHistory();
}
function toggleProjectGroup(projectId) {
  if (_collapsedProjects.has(projectId)) _collapsedProjects.delete(projectId);
  else _collapsedProjects.add(projectId);
  renderSessionList();
  renderNewChatHistory();
}
function _bindSessionGroups(root, options) {
  const opts = options || {};
  if (!root) return;
  root.querySelectorAll('.session-item[data-sid]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('.session-acts')) return;
      switchSession(el.dataset.sid);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target && e.target.closest && e.target.closest('.session-acts')) return;
      e.preventDefault();
      switchSession(el.dataset.sid);
    });
  });
  if (opts.showActions) {
    root.querySelectorAll('.session-exp[data-sid]').forEach(el => {
      el.addEventListener('click', (e) => { e.stopPropagation(); exportSessionMd(el.dataset.sid, e); });
    });
    root.querySelectorAll('.session-del[data-sid]').forEach(el => {
      el.addEventListener('click', (e) => { e.stopPropagation(); deleteSession(el.dataset.sid, e); });
    });
  }
  root.querySelectorAll('[data-group-toggle="tasks"]').forEach(el => {
    el.addEventListener('click', toggleTaskGroup);
  });
  root.querySelectorAll('[data-project-toggle]').forEach(el => {
    el.addEventListener('click', () => toggleProjectGroup(el.dataset.projectToggle));
  });
  root.querySelectorAll('[data-project-new]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const project = projectById(el.dataset.projectNew);
      if (project) createProjectSession(project);
    });
  });
}
function renderNewChatHistory() {
  const box = document.getElementById('newChatHistory');
  if (!box) return;
  if (!sessions.length && !projects.length) {
    box.innerHTML = '<div class="session-empty session-empty-large">还没有对话或项目。新建一个任务，或创建项目空间。</div>';
    return;
  }
  box.innerHTML = _sessionGroupsHtml({showActions: false});
  _bindSessionGroups(box, {showActions: false});
}
async function createProjectSession(project) {
  if (!project) return null;
  const now = Date.now();
  const session = {
    id: 's_' + now + '_' + Math.random().toString(36).slice(2, 7),
    title: '', createdAt: now, updatedAt: now, messages: [],
    projectId: project.id, projectName: project.name, projectWorkspace: project.workspace,
  };
  sessions.push(session);
  project.updatedAt = now;
  saveProjects();
  // UI jump must never depend on the pywebview bridge. Commit the visible state
  // first; persistence/workspace sync are best-effort follow-ups.
  let entered = false;
  try { switchSession(session.id, true); entered = currentSessionId === session.id; } catch (e) {}
  if (!entered) {
    if (typeof AppState !== 'undefined') AppState.currentSessionId = session.id;
    else currentSessionId = session.id;
    _setNewChatScreenVisible(false);
    try { renderSessionList(); } catch (e) {}
    try { renderNewChatHistory(); } catch (e) {}
    try { renderChatHistory(session); } catch (e) {}
    try { updateLiveTokenStat(); } catch (e) {}
  }
  try { await saveSessions(); } catch (e) {}
  return session;
}
function _projectError(text) {
  const el = document.getElementById('projectError');
  if (el) el.textContent = text || '';
}
function openProjectModal() {
  const modal = document.getElementById('projectModal');
  if (!modal) return;
  const name = document.getElementById('projectNameInput');
  const workspace = document.getElementById('projectWorkspaceInput');
  if (name) name.value = '';
  if (workspace) workspace.value = '';
  _projectError('');
  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
  setTimeout(() => { if (name && name.focus) { try { name.focus(); } catch (e) {} } }, 0);
}
function closeProjectModal() {
  const modal = document.getElementById('projectModal');
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
}
async function pickProjectFolder() {
  try {
    const raw = JSON.parse(await callApi('pick_folder', [currentSessionId], 60000) || '{}');
    if (raw && raw.ok && raw.path) {
      const input = document.getElementById('projectWorkspaceInput');
      if (input) input.value = raw.path;
      _projectError('');
    } else if (raw && raw.err) {
      _projectError('目录选择不可用：' + raw.err + '（可手动输入路径）');
    }
  } catch (e) { _projectError('目录选择失败，可手动输入路径'); }
}
async function createProjectFromModal() {
  const nameEl = document.getElementById('projectNameInput');
  const wsEl = document.getElementById('projectWorkspaceInput');
  const name = nameEl ? nameEl.value.trim() : '';
  const workspace = wsEl ? wsEl.value.trim() : '';
  if (!name) { _projectError('请填写项目名称'); if (nameEl) nameEl.focus(); return; }
  if (!workspace) { _projectError('请选择或输入项目工作文件夹'); if (wsEl) wsEl.focus(); return; }
  const now = Date.now();
  const project = {
    id: 'p_' + now + '_' + Math.random().toString(36).slice(2, 7),
    name: name.slice(0, 60), workspace, createdAt: now, updatedAt: now,
  };
  projects.push(project);
  saveProjects();
  closeProjectModal();
  await createProjectSession(project);
}
function projectUiInit() {
  if (projectUiInit._bound) return;
  projectUiInit._bound = true;
  const on = (id, event, handler) => {
    const el = document.getElementById(id);
    if (el && el.addEventListener) el.addEventListener(event, handler);
  };
  on('newChatNewTaskBtn', 'click', () => newSession());
  on('newChatNewProjectBtn', 'click', openProjectModal);
  on('projectBrowseBtn', 'click', pickProjectFolder);
  on('projectCreateBtn', 'click', createProjectFromModal);
  on('projectCancelBtn', 'click', closeProjectModal);
  const modal = document.getElementById('projectModal');
  if (modal && modal.addEventListener) {
    modal.addEventListener('click', (e) => { if (e.target === modal) closeProjectModal(); });
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeProjectModal(); }
    });
  }
}
function newSession() {
  const activeRun = (typeof RunRegistry !== 'undefined') ? RunRegistry.current() : null;
  if (activeRun && !activeRun.cancelled) activeRun.background = true;
  if (typeof AppState !== 'undefined') AppState.currentSessionId = null;
  else currentSessionId = null;
  if (typeof syncAgentRunUiForSession === 'function') syncAgentRunUiForSession(null);
  if (typeof clearExpertSelection === 'function') clearExpertSelection();
  window.__hitRate = 0;
  window.__turnTokens = 0;
  if (typeof AppState !== 'undefined') AppState.attachments = [];
  else attachments = [];
  guardTrusted.clear();               // v1.2 R2：会话级信任随会话结束失效
  mcpTrusted.clear();                 // 修复 W26：MCP 会话信任同步清空（文案「本会话内不再提示」原本被当成进程级永久信任）
  agentTrusted.clear();               // 修复（对抗复审）：Agent 工具族（browser_/software_）会话信任同步清空——后端 set_current_sid(null) 亦清空会话信任态（guard_service.clear_session_trust），前端不清则「登记失败不进 Set」修复仍会留下跨会话残留信任
  renderPreview();
  _setNewChatScreenVisible(false);
  document.getElementById('chatContainer').innerHTML =
    `<div class="empty-state" id="emptyState">
      <div class="empty-icon">✦</div>
      <h2>开始和 Harbor 聊天</h2>
      <p>支持文字、图片、视频、文本文件 · 历史记录自动保存</p>
      <div class="empty-guide" id="emptyGuide">
        <div class="eg-step"><b>1</b>选来源<button type="button" class="modal-btn" onclick="navGuidePickSource()">去选择<svg class="ui-icon ui-icon-16"><use href="#i-arrow"/></svg></button></div>
        <div class="eg-step"><b>2</b>填 Key<button type="button" class="modal-btn" onclick="navGuideFillKey()">去填写<svg class="ui-icon ui-icon-16"><use href="#i-arrow"/></svg></button></div>
        <div class="eg-step"><b>3</b>发问<button type="button" class="modal-btn" disabled>在下方输入框</button></div>
      </div>
    </div>`;
  if (typeof navUpdateEmptyGuide === 'function') { try { navUpdateEmptyGuide(); } catch (e) {} }
  renderSessionList();
  renderNewChatHistory();
  updateLiveTokenStat();
  lastShotHash = null; pendingShots = []; shotState = 'idle';
  if (!activeRun || activeRun.cancelled) {
    try { callApi('clear_caches', []).catch(() => {}); } catch (e) {}   // 修复 ㊲：补 rejection 处理（原只挡同步 throw）
    try { callApi('set_current_sid', [null]).catch(() => {}); } catch (e) {}   // 修复 ㊲：同上；后端借此清空会话信任态（含 MCP）
  }
  refreshWsCard();
}
function switchSession(id, silent) {
  const activeRun = (typeof RunRegistry !== 'undefined') ? RunRegistry.current() : null;
  const sessionList = (typeof AppState !== 'undefined') ? AppState.sessions : sessions;
  const target = sessionList.find(s => s.id === id);   // 先校验存在性再赋值
  if (!target) return;
  if (typeof closeSidebarDrawer === 'function') closeSidebarDrawer();
  if (typeof AppState !== 'undefined') AppState.currentSessionId = id;
  else currentSessionId = id;
  if (typeof syncAgentRunUiForSession === 'function') syncAgentRunUiForSession(id);
  _setNewChatScreenVisible(false);
  window.__hitRate = 0;
  window.__turnTokens = 0;
  if (typeof AppState !== 'undefined') AppState.attachments = [];
  else attachments = [];
  guardTrusted.clear();               // v1.2 R2：会话级信任随会话切换失效
  mcpTrusted.clear();                 // 修复 W26：与文案「本会话内不再提示」对齐，切会话即失效
  agentTrusted.clear();               // 修复（对抗复审）：Agent 工具族会话信任同步清空（后端 set_current_sid 检测 sid 变化即清空会话信任态，两侧对齐）
  renderPreview();
  // v4：切会话容器级过渡——先 .swapping 淡出（140ms in-soft），重建历史后再淡入（200ms out-soft）；
  // boot 首次（silent）与 fx-off/reduced-motion 降级直接重建，避免开屏空容器闪一下
  const box = document.getElementById('chatContainer');
  if (silent || (typeof MOTION !== 'undefined' && MOTION.instant())) {
    renderChatHistory(target);
  } else {
    box.classList.add('swapping');
    // 修复 S14（三轮）：原 .swapping 移除与渲染同回调无 finally——渲染抛错
    // （持久化数据含畸形消息）即 opacity:0 永久锁死聊天区，只能重启
    MOTION.onAnimEnd(box, 'transitionend', MOTION.compOut()).then(() => {
      try {
        renderChatHistory(target);
      } finally {
        void box.offsetWidth; box.classList.remove('swapping');
      }
    }).catch(() => { box.classList.remove('swapping'); });
  }
  renderSessionList();
  renderNewChatHistory();
  updateLiveTokenStat();
  lastShotHash = null; pendingShots = []; shotState = 'idle';
  if (!activeRun || activeRun.cancelled) {
    try { callApi('clear_caches', []).catch(() => {}); } catch (e) {}   // 修复 ㊲
    try { callApi('set_current_sid', [currentSessionId]).catch(() => {}); } catch (e) {}   // 修复 ㊲：后端据此清空会话信任态（含 MCP）
    if (target.projectWorkspace) {
      try {
        callApi('set_session_ws', [id, target.projectWorkspace, true]).catch(() => {
          if ((window.pywebview && window.pywebview.api || window.HARBOR_API_BASE) && typeof toast === 'function') {
            toast('已进入项目对话；工作区绑定暂未同步，可稍后重试', 'warn');
          }
        });
      } catch (e) {}
    }
  }
  refreshWsCard();
  // 生成式UI：切回会话时补渲染后台完成的自动视图（chat-auto 待渲染队列）
  if (typeof chatAutoRenderPendingFor === 'function') {
    try { chatAutoRenderPendingFor(id); } catch (e) {}
  }
}
/** 修复 ㉘：抽出的历史回放渲染（switchSession / regenerate 共用——原 regenerate 只回放 user，历史 assistant 消失） */
function renderChatHistory(s) {
  const box = document.getElementById('chatContainer');
  // v4：重建期间挂 .batch——禁消息逐条重播入场动画（否则长历史瞬间刷屏）
  box.classList.add('batch');
  box.innerHTML = '';
  let pendingTools = [];
  const flushTools = () => {
    if (!pendingTools.length) return;
    const div = document.createElement('div');
    div.className = 'tool-call-item done';
    div.style.margin = '4px 0 10px 43px';
    div.innerHTML = '<span class="tc-dot"></span><span>' + escapeHtml('本次操作 · ' + pendingTools.join(' · ')) + '</span>';
    box.appendChild(div);
    pendingTools = [];
  };
  (s.messages || []).forEach((m, i) => {
    if (m.role === 'user') {
      flushTools();
      let text = '';
      if (typeof m.content === 'string') text = m.content;
      else if (Array.isArray(m.content)) {
        m.content.forEach(p => {
          if (p.type === 'text') text += p.text;
          else if (p.type === 'image_url') text += '\n[图片]';
          else if (p.type === 'video_url') text += '\n[视频]';
        });
      }
      const uEl = addMessage('user', text, {});
      if (uEl && uEl.dataset) uEl.dataset.midx = i;   // 修复 UX-3（v1.4）：消息元素 stamp 源消息下标，供会话搜索跳转定位（dataset 防御）
      if (text.trim()) addMsgActions(uEl, text.trim(), true);
    } else if (m.role === 'assistant') {
      let text = typeof m.content === 'string' ? m.content : '';
      const toolCalls = m.tool_calls && m.tool_calls.length ? m.tool_calls : null;
      if (toolCalls) {
        toolCalls.forEach(tc => {
          let args = {}; try { args = JSON.parse(tc.function?.arguments || '{}'); } catch (e) {}
          const nm = tc.function?.name || '';
          if (nm === 'read_file') pendingTools.push('读 ' + (args.path || ''));
          else if (nm === 'list_dir') pendingTools.push('列 ' + (args.path || ''));
          else if (nm === 'write_file') pendingTools.push('写 ' + (args.path || ''));
          else if (nm === 'append_file') pendingTools.push('追加 ' + (args.path || ''));
          else if (nm === 'search_replace') pendingTools.push('改 ' + (args.path || ''));
          else if (nm === 'run_command') pendingTools.push('执行 ' + String(args.cmd || '').slice(0, 30));
          else if (nm === 'run_powershell') pendingTools.push('执行 ' + String(args.cmd || '').slice(0, 30));
          else if (nm === 'take_screenshot') pendingTools.push('截图');
          else pendingTools.push(nm);
        });
      }
      if (text.trim()) {
        flushTools();
        const extra = m.usage ? { usage: m.usage } : {};
        const contentEl = addMessage('assistant', text, extra);
        if (contentEl && contentEl.dataset) contentEl.dataset.midx = i;   // 修复 UX-3（v1.4）：stamp 源消息下标，供会话搜索跳转定位（dataset 防御）
        addMsgActions(contentEl, text);
        enhanceCodeBlocks(contentEl);
        // 生成式UI（P0-4 重做）：消息携带 uiSpec 时重建内联可交互视图（跨重启持久）
        if (m.uiSpec && typeof mountChatUiSpecFromMessage === 'function') {
          try { mountChatUiSpecFromMessage(contentEl, m); } catch (e) {}
        }
        if (m.__compactCard || m.__archiveCard) renderCompactCard(box, s, m);   // 修复 UX-1（v1.4）：压缩/归档卡片（token 对比+恢复原文）
      }
    }
  });
  flushTools();
  // v4：两帧后摘 .batch——重建完成，此后新消息恢复正常入场动画
  requestAnimationFrame(() => requestAnimationFrame(() => box.classList.remove('batch')));
}
/** 修复 F1（v1.4）：会话导出为 Markdown——前端序列化（零后端/零新 js_api/零依赖）。
 *  消息角色标题 + 工具调用块 + 时间戳 + 可选 token 统计页脚；Blob 下载。
 *  边界：空会话正常生成（仅标题+说明）；超长消息截断防爆；文件名净化非法字符。 */
function exportSessionMd(id, e) {
  if (e) e.stopPropagation();
  const s = sessions.find(x => x.id === id);
  if (!s) { toast('会话不存在', 'warn'); return; }
  const lines = [];
  lines.push('# ' + (s.title || 'Harbor 会话'));
  lines.push('');
  // 修复 建议㊷（三轮）：APP_VERSION 前端永无定义（原恒显旧版 '1.4'）——兜底取全局
  // window.__appVersion（后端可注入），再无则省略版本号，不显示错误版本
  const _ver = (typeof APP_VERSION !== 'undefined' && APP_VERSION)
    ? APP_VERSION : (window.__appVersion || '');
  lines.push('> 导出自 Harbor' + (_ver ? ' v' + _ver : '') +
    ' · ' + new Date().toLocaleString('zh-CN'));
  lines.push('');
  let toolCount = 0, usage = null;
  for (const m of (s.messages || [])) {
    if (m.role === 'user') {
      let text = typeof m.content === 'string' ? m.content : '';
      if (Array.isArray(m.content)) {
        text = m.content.map(p => p.text || (p.type === 'image_url' ? '[图片]' : p.type === 'video_url' ? '[视频]' : '')).join(' ');
      }
      lines.push('## 🧑 我', '', String(text).slice(0, 20000), '');
    } else if (m.role === 'assistant') {
      if (m.tool_calls && m.tool_calls.length) {
        for (const tc of m.tool_calls) {
          toolCount++;
          let args = {};
          try { args = JSON.parse(tc.function?.arguments || '{}'); } catch (e) {}
          lines.push('#### 🔧 工具调用 · `' + (tc.function?.name || '') + '`');
          lines.push('```json');
          lines.push(JSON.stringify(args, null, 2).slice(0, 4000));
          lines.push('```', '');
        }
      }
      if (m.content && String(m.content).trim()) {
        lines.push('## 🤖 AI', '', String(m.content).slice(0, 20000), '');
      }
      if (m.usage) usage = m.usage;   // 最后一次 usage = 会话累计口径（calcUsage 同源）
    } else if (m.role === 'tool') {
      lines.push('<details><summary>📄 工具结果</summary>', '', '```', String(m.content || '').slice(0, 8000), '```', '', '</details>', '');
    }
  }
  if (usage) {
    lines.push('---', '', '**Token 统计**：输入 ' + (usage.prompt_tokens || 0) +
      ' · 输出 ' + (usage.completion_tokens || 0) +
      ' · 合计 ' + (usage.total_tokens || 0) +
      (usage.prompt_tokens_details?.cached_tokens ? ' · 缓存命中 ' + usage.prompt_tokens_details.cached_tokens : '') +
      ' · 工具调用 ' + toolCount + ' 次', '');
  }
  const fname = (s.title || 'chat').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) +
    '-' + new Date().toISOString().slice(0, 10) + '.md';
  const content = lines.join('\n');
  // 2026-10-21 补：原生「另存为」对话框优先（后端 pick_save_path + save_export_file 现成），
  // 旧 exe/取消/失败回落浏览器 Blob 下载
  const blobFallback = () => {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('已导出 Markdown', 'ok');
  };
  (async () => {
    try {
      const pr = JSON.parse(await callApi('pick_save_path', [fname], 120000) || '{}');
      if (!pr || !pr.ok || !pr.path) { blobFallback(); return; }   // 取消或旧后端
      const wr = JSON.parse(await callApi('save_export_file', [pr.path, content], 60000) || '{}');
      if (wr && wr.ok) toast('已导出到 ' + pr.path, 'ok');
      else blobFallback();
    } catch (e) { blobFallback(); }
  })();
}

/* 删除会话（真删：sessions + ws 绑定 + plan + checkpoint）。
 * 修复（对抗复审）：
 * ① stopPropagation typeof 守卫——程序调用 deleteSession(id)（无事件对象）时
 *    原裸 e.stopPropagation() 直接 NPE；
 * ② 原「新版真删覆盖」monkey-patch 模式（文件尾部 deleteSession = async
 *    function…）把带守卫的新版叠在被覆盖的旧声明上，旧声明（裸 NPE + 无 purge）
 *    成为死代码但保留在盘——任何直接引用旧绑定的路径（_origDeleteSession 别名/
 *    未来重构）都会复活无守卫版本。现合并为单一函数声明，消灭双定义。 */
async function deleteSession(id, e) {
  if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
  const activeRun = (typeof RunRegistry !== 'undefined') ? RunRegistry.current() : null;
  if (activeRun && !activeRun.cancelled && id === activeRun.sessionId) {
    toast('该会话正在后台运行，完成或停止后再删除', 'warn'); return;
  }
  if (isStreaming && id === currentSessionId) { toast('正在生成回复，请先停止', 'warn'); return; }
  const r = await uiConfirm({ title: '删除对话', body: '确定彻底删除这条对话？历史条目、工作区绑定、计划与检查点快照都将真删除，不可恢复。', danger: true, okText: '彻底删除' });
  if (!r.ok) return;
  const s = sessions.find(x => x.id === id) || {};
  const taskIds = (s.plan && s.plan.task_id) ? JSON.stringify([s.plan.task_id]) : '[]';
  sessions = sessions.filter(x => x.id !== id);
  rememberDeletedSession(id);   // 修复 W24（二轮）：删除墓碑（防后端写失败后合并复活）
  saveSessions();
  callApi('delete_session_ws', [id]).catch(() => {});
  callApi('session_purge', [id, taskIds], 30000).then(raw => {
    try {
      const r2 = JSON.parse(raw || '{}');
      const rm = (r2 && r2.removed) || {};
      const bits = [];
      if (rm.sessions) bits.push('历史条目');
      if (rm.ws) bits.push('工作区绑定');
      if (rm.plans) bits.push('计划');
      if (rm.checkpoints) bits.push('检查点');
      if (bits.length) toast('已真删：' + bits.join('、'), 'ok');
    } catch (e2) { /*  purge 结果解析失败不打扰（列表已更新） */ }
  }).catch(() => {});
  if (currentSessionId === id) openNewChatScreen();
  else renderSessionList();
}
/** 修复 建议㉝（二轮）：会话 id 拼 onclick 前统一转义（模块作用域，UX-3 搜索跳转同样复用）。 */
// 修复 建议㉝（二轮）：会话 id 拼 onclick 前统一转义（模块作用域，UX-3 搜索跳转同样复用）。
// 修复 51（三轮）：补双引号转义——escapeHtml 走 textContent→innerHTML 不转引号，
// 属性上下文（onclick="..."）里双引号同样有注入面（与单引号一并纵深防御）
const _escId = (id) => escapeHtml(String(id)).replace(/'/g, '&#39;').replace(/"/g, '&quot;');
function _renderHistoryRoot(box, options) {
  if (!box) return;
  if (!sessions.length && !projects.length) {
    box.innerHTML = '<div class="sidebar-empty">暂无历史对话</div>';
    return;
  }
  box.innerHTML = _sessionGroupsHtml(options || {});
  _bindSessionGroups(box, options || {});
}
function renderSessionList() {
  if (typeof ensureHistoryFoot === 'function') ensureHistoryFoot();
  _renderHistoryRoot(document.getElementById('sessionList'), {showActions: true});
  // 迁移期（岛层）：侧栏由岛渲染时只推数据不重绘 DOM，
  // 避免两套渲染器同时写 #sidebarHistory（重复节点/事件重复绑定）。
  if (typeof harborIslandSidebarActive === 'function' && harborIslandSidebarActive()) {
    if (typeof harborIslandSyncSidebar === 'function') harborIslandSyncSidebar();
  } else {
    _renderHistoryRoot(document.getElementById('sidebarHistory'), {showActions: true});
  }
  renderNewChatHistory();
  updateTokenStat();
}
/** 日期分组键：今天/昨天/更早（跨天边界用自然日比对，非 24h 减法）。 */
function _dayGroup(ts) {
  const t = Number(ts);
  if (!ts || !isFinite(t)) return '更早';
  const d = new Date(t), now = new Date();
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return '今天';
  const y = new Date(Date.now() - 86400000);
  if (sameDay(d, y)) return '昨天';
  return '更早';
}
function formatTime(ts) {
  // 修复 建议㉲（三轮）：undefined/非时间戳不再显示 Invalid Date/NaN
  const t = Number(ts);
  if (!ts || !isFinite(t)) return '';
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  return (d.getMonth() + 1) + '/' + d.getDate();
}
function ensureSession() {
  if (!currentSessionId) {
    currentSessionId = 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    sessions.push({ id: currentSessionId, title: '', createdAt: Date.now(), updatedAt: Date.now(), messages: [] });
  }
}
function updateSessionTitle(text) {
  const s = getCurrentSession();
  if (!s || s.title) return;
  s.title = text.replace(/\s+/g, ' ').slice(0, 20) || '新对话';
}

/* ============ 历史存放目录 + 真删（2026-10-21 用户需求）============
 * 「历史记录存放可以自己选择放哪个文件夹，删掉就是真的删掉了」。
 * 全部动态 DOM（零 template 改动——UI 并行协作纪律）；类名避开既有
 * UI 契约集合（40 id/13 onclick/43 callApi/39 类/21 变量只增不改的
 * 是既有面，新增动态类不在此列）。
 * 数据流：history_dir_get/set（后端 history.json 独立配置）+ 目录对话
 * 框复用 legacy pick_folder(sid)；删除经 session_purge 后端真删
 * （sessions 条目 + ws 绑定 + plan json + checkpoint 目录）。
 */

/* 历史目录 UI 样式已由模板 index.template.html:1991-2029 官方样式承载
 * （变量均已定义）——原 _hdStyle IIFE 动态注入与模板样式冲突，删除。 */

function ensureHistoryFoot() {
  if (document.getElementById('historyFoot')) return;
  const list = document.getElementById('sessionList');
  if (!list) return;
  const foot = document.createElement('div');
  foot.id = 'historyFoot';
  foot.className = 'history-foot';
  foot.innerHTML = '<button class="history-dir-btn" id="historyDirBtn" title="选择历史记录存放文件夹">📁 历史目录</button>';
  if (list.parentNode) list.parentNode.appendChild(foot);
  const btn = document.getElementById('historyDirBtn');
  if (btn) btn.addEventListener('click', showHistoryDirPanel);
  refreshHistoryFoot();
}
async function refreshHistoryFoot() {
  const btn = document.getElementById('historyDirBtn');
  if (!btn) return;
  try {
    const r = JSON.parse(await callApi('history_dir_get', [], 20000) || '{}');
    btn.textContent = r.dir ? '📁 ' + _shortDir(r.dir) : '📁 历史目录（默认）';
    btn.title = r.dir ? ('历史存放：' + r.dir + '\n点击更改') : '历史存放：默认 ~/.glm-chat\n点击更改';
  } catch (e) { /* 后端旧版：保持默认文案 */ }
}
function _shortDir(d) {
  const s = String(d || '');
  return s.length > 22 ? '…' + s.slice(-21) : s;
}
/* hdSave 防连点闸门（保存期间忽略重复点击并禁用面板按钮） */
let _hdBusy = false;
/* 修复（建议14 残余）：面板「成功提示停留后自动关闭」延时不硬编码毫秒——
 * 以 MOTION.comp()（组件入场令牌，默认 200ms）为基元取倍数：保存成功停留
 * 4×（默认 800ms）、恢复默认 3×（默认 600ms），语义=「让用户读完一行结果」；
 * fx-off 下 comp=1ms → 倍增值同样趋 0，立即关闭（关特效不拖节奏）。
 * typeof 守卫：vm 单模块沙箱未加载 00-motion 时回落原字面量。 */
const _hdLingerMs = (mult) => (typeof MOTION !== 'undefined' && MOTION.comp) ? MOTION.comp() * mult : 200 * mult;
function showHistoryDirPanel() {
  if (document.getElementById('historyDirMask')) return;
  const mask = document.createElement('div');
  mask.id = 'historyDirMask';
  mask.className = 'history-dir-mask';
  const panel = document.createElement('div');
  panel.className = 'history-dir-panel';
  panel.innerHTML =
    '<div class="hd-title">历史记录存放</div>' +
    '<div class="hd-desc">选择会话历史的存放文件夹（默认在用户目录 .glm-chat）。切换后新对话写入新位置。</div>' +
    '<div class="hd-row"><input class="hd-input" id="hdInput" placeholder="目录路径（如 D:////harbor-history）" spellcheck="false"></div>' +
    '<div class="hd-row hd-btns">' +
    '<button class="hd-btn" id="hdBrowse">浏览…</button>' +
    '<label class="hd-chk"><input type="checkbox" id="hdMigrate"> 迁移已有历史</label>' +
    '</div>' +
    '<div class="hd-row hd-btns">' +
    '<button class="hd-btn hd-primary" id="hdSave">保存</button>' +
    '<button class="hd-btn" id="hdDefault">恢复默认</button>' +
    '<button class="hd-btn" id="hdClose">取消</button>' +
    '</div>' +
    '<div class="hd-msg" id="hdMsg"></div>';
  mask.appendChild(panel);
  document.body.appendChild(mask);
  const input = document.getElementById('hdInput');
  const msg = document.getElementById('hdMsg');
  const say = (t, ok) => { msg.textContent = t; msg.className = 'hd-msg ' + (ok ? 'ok' : 'err'); };
  callApi('history_dir_get', [], 20000).then(raw => {
    const r = JSON.parse(raw || '{}');
    if (r.dir) input.value = r.dir;
  }).catch(() => {});
  document.getElementById('hdBrowse').addEventListener('click', async () => {
    try {
      const raw = JSON.parse(await callApi('pick_folder', [currentSessionId], 60000) || '{}');
      if (raw && raw.ok && raw.path) input.value = raw.path;
      else if (raw && raw.err) say('目录选择不可用：' + raw.err + '（请手动输入）', false);
    } catch (e) { say('目录选择失败', false); }
  });
  document.getElementById('hdSave').addEventListener('click', async () => {
    if (_hdBusy) return;   // 防连点：保存进行中忽略重复点击
    const d = input.value.trim();
    if (!d) { say('请输入目录路径', false); return; }
    _hdBusy = true;
    // 保存期间禁用三个按钮（hdSave/hdClose/hdBrowse），防重复提交与误关面板
    const _hdBtns = ['hdSave', 'hdClose', 'hdBrowse'].map(bid => document.getElementById(bid)).filter(Boolean);
    _hdBtns.forEach(b => { b.disabled = true; });
    try {
      const raw = JSON.parse(await callApi('history_dir_set', [d, document.getElementById('hdMigrate').checked], 60000) || '{}');
      if (raw.error) { say(raw.error, false); return; }
      say(raw.migrated ? '已保存并迁移旧历史' : '已保存', true);
      refreshHistoryFoot();
      setTimeout(() => mask.remove(), _hdLingerMs(4));
    } catch (e) { say('保存失败: ' + (e.message || e), false); }
    finally { _hdBusy = false; _hdBtns.forEach(b => { b.disabled = false; }); }
  });
  document.getElementById('hdDefault').addEventListener('click', async () => {
    try {
      await callApi('history_dir_set', ['', false], 20000);
      say('已恢复默认目录', true);
      refreshHistoryFoot();
      setTimeout(() => mask.remove(), _hdLingerMs(3));
    } catch (e) { say('恢复失败', false); }
  });
  document.getElementById('hdClose').addEventListener('click', () => mask.remove());
  mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
}
/* 真删：session_purge 后端调用已并入上方 deleteSession 主体（sessions+ws+plan+
 * checkpoint）。原文件尾部的「const _origDeleteSession = deleteSession;
 * deleteSession = async function…」monkey-patch 覆盖模式已删除（对抗复审）：
 * 双定义让无守卫的旧声明成为潜伏死代码，单一函数声明 + typeof 守卫是终态。 */
