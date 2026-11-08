
async function continueInNewSession() {
  const s = getCurrentSession();
  const btn = document.getElementById('continueNewBtn');
  if (!s || !s.messages.length) { newSession(); return; }
  const apiKey = effectiveApiKey();
  if (!apiKey) { toast('请先设置 API Key', 'warn'); document.getElementById('settingsPanel').classList.add('show'); return; }
  if (btn) btn.textContent = '⏳ 总结中…';
  // 实现 v1.6 W28：生成中 compactNow 会静默跳过压缩（isStreaming 早退），原流程
  // 仍继续 newSession() → 用户在新会话丢失全部上下文且无感知。生成中直接中止并明示。
  if (typeof isSessionStreaming === 'function' ? isSessionStreaming(s.id) : !!(typeof AppState !== 'undefined' ? AppState.isStreaming : (typeof isStreaming !== 'undefined' && isStreaming))) {
    toast('本会话正在生成中，稍后再「新对话继续」（避免未压缩就开新会话丢失上下文）', 'warn');
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
      <button type="button" class="group-beta-entry" onclick="groupWizardOpen()" title="配置多个大模型成员分工协作，靠交接文档接力完成任务">
        👥 群聊协作 · 多模型接力 <span class="gb-beta">Beta</span>
      </button>
    </div>`;
  if (typeof navUpdateEmptyGuide === 'function') { try { navUpdateEmptyGuide(); } catch (e) {} }
  renderSessionList();
  renderNewChatHistory();
  updateLiveTokenStat();
  // R20/R24：后台 run 的截图保留（消费端按 sid 过滤兜底串图）；lastShotHash
  // 是「同图不重截」指纹——新会话语义下应允许重截，故复位指纹但不动截图队列
  lastShotHash = null;
  if (!activeRun || activeRun.cancelled) {
    try { callApi('clear_caches', []).catch(() => {}); } catch (e) {}   // 修复 ㊲：补 rejection 处理（原只挡同步 throw）
    try { callApi('set_current_sid', [null]).catch(() => {}); } catch (e) {}   // 修复 ㊲：同上；后端借此清空会话信任态（含 MCP）
  }
  refreshWsCard();
}
function switchSession(id, silent) {
  const __prevSid = (typeof AppState !== 'undefined') ? AppState.currentSessionId : currentSessionId;   // R20：截图按会话出队用
  const activeRun = (typeof RunRegistry !== 'undefined') ? RunRegistry.current() : null;
  const sessionList = (typeof AppState !== 'undefined') ? AppState.sessions : sessions;
  const target = sessionList.find(s => s.id === id);   // 先校验存在性再赋值
  if (!target) return;
  if (typeof closeSidebarDrawer === 'function') closeSidebarDrawer();
  if (typeof AppState !== 'undefined') AppState.currentSessionId = id;
  else currentSessionId = id;
  if (typeof syncAgentRunUiForSession === 'function') syncAgentRunUiForSession(id);
  // R32：内置目录启用态按会话隔离，切会话即刷新可见 chip
  if (typeof hubRenderChip === 'function') hubRenderChip();
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
  // 生成式UI(2026-11-03)：切会话先摘掉所有内联视图宿主——包括生成中被打断、
  // 目标会话本就没有该视图的残留（否则旧会话的视图会跟到新会话，点着像死框）。
  try {
    if (box) box.querySelectorAll('.ui-chat-host').forEach(node => { try { node.remove(); } catch (e) {} });
  } catch (e) {}
  // Round 7 修复[4]：待批准计划卡挂在聊天区里，重建前必须先解除挂起的批准
  // Promise（否则 planModeRun 的 await 永久悬挂，切回也不重挂）。
  try { if (typeof planTeardownPendingApproval === 'function') planTeardownPendingApproval(); } catch (e) {}
  if (silent || (typeof MOTION !== 'undefined' && MOTION.instant())) {
    renderChatHistory(target);
    // 群聊协作（Beta）：历史重建后补成员标签 + 群工具条（非群会话会自动摘除工具条）
    try { if (typeof groupAfterSessionRender === 'function') groupAfterSessionRender(target); } catch (e) {}
    // 生成式UI：切回会话时补渲染后台完成的自动视图（chat-auto 待渲染队列）。
    // Round 5 时序修正：必须在 renderChatHistory **之后**——原先在函数尾部
    // 同步调用，而动画分支的历史重建要等 transitionend 回调，补渲染会挂进
    // 即将被替换掉的旧 DOM，视图随重建消失（「切回来视图没了」的另一半根因）。
    if (typeof chatAutoRenderPendingFor === 'function') {
      try { chatAutoRenderPendingFor(id); } catch (e) {}
    }
  } else {
    box.classList.add('swapping');
    // 修复 S14（三轮）：原 .swapping 移除与渲染同回调无 finally——渲染抛错
    // （持久化数据含畸形消息）即 opacity:0 永久锁死聊天区，只能重启
    MOTION.onAnimEnd(box, 'transitionend', MOTION.compOut()).then(() => {
      try {
        renderChatHistory(target);
        try { if (typeof groupAfterSessionRender === 'function') groupAfterSessionRender(target); } catch (e) {}
        if (typeof chatAutoRenderPendingFor === 'function') {
          try { chatAutoRenderPendingFor(id); } catch (e) {}
        }
      } finally {
        void box.offsetWidth; box.classList.remove('swapping');
      }
    }).catch(() => { box.classList.remove('swapping'); });
  }
  renderSessionList();
  renderNewChatHistory();
  updateLiveTokenStat();
  // R20：只清被离开会话的截图（后台 run 的截图由 sid 过滤兜底串图）
  // R37 修复（D4）：原过滤谓词与注释相反（保留 prevSid、删掉其余）——
  // 现按注释语义：移除被离开会话的待发截图，其余会话保留。
  lastShotHash = null;
  if (typeof pendingShots !== 'undefined') pendingShots = pendingShots.filter(x => !x || x.sid !== String(__prevSid));
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
  // R21 性能调度（实测 400 条 404ms）：视口外老消息走轻量渲染（纯文本形态，
  // 保 .message 形状与 data-midx），IntersectionObserver 滚入视口 200px 内
  // 再升级为完整渲染（renderMd+操作条+代码增强）。群聊会话不懒（气泡映射按
  // .message 逐条对位）。
  const total = (s.messages || []).length;
  const lazyFrom = s.group ? total : Math.max(0, total - 50);
  // 升级器：滚动/初始化时把视口内（±200px）的轻量节点升级为完整渲染。
  // 不用 IntersectionObserver——被遮挡窗口 IO 不派发（R21 实测 ioFired=0），
  // scroll 事件确定性触发。节流 120ms。
  const upgradeInView = () => {
    const lights = box.querySelectorAll('[data-lazyidx]');
    if (!lights.length) return;
    const vh = window.innerHeight || 800;
    lights.forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.bottom < -200 || r.top > vh + 200) return;
      const idx = Number(el.dataset.lazyidx);
      const mm = (s.messages || [])[idx];
      if (!mm || mm.role !== 'assistant') { delete el.dataset.lazyidx; return; }
      const text = typeof mm.content === 'string' ? mm.content : '';
      el.innerHTML = '<div class="md-body">' + renderMd(text) + '</div>';
      addMsgActions(el, text);
      enhanceCodeBlocks(el);
      if (mm.uiSpec && typeof mountChatUiSpecFromMessage === 'function') {
        try { mountChatUiSpecFromMessage(el, mm); } catch (e) {}
      }
      if (mm.__compactCard || mm.__archiveCard) renderCompactCard(box, s, mm);
      delete el.dataset.lazyidx;
    });
  };
  const onScrollLazy = () => {
    if (onScrollLazy._t) return;
    onScrollLazy._t = setTimeout(() => { onScrollLazy._t = null; upgradeInView(); }, 120);
  };
  // R37 修复（D6）：innerHTML 重建清不掉 listener——先卸旧闭包再挂新的，
  // 否则每次 renderChatHistory 净增一个监听器且闭包滞留整份旧会话历史（内存泄漏）。
  if (box.__onScrollLazy) box.removeEventListener('scroll', box.__onScrollLazy);
  box.__onScrollLazy = onScrollLazy;
  box.addEventListener('scroll', onScrollLazy, { passive: true });
  // 兜底轮询：被遮挡窗口不派发 scroll（R21 实测 scrollFired=0），interval 在
  // 后台窗口最慢 1s 仍会触发；lazy 清零即自毁。
  if (typeof setInterval === 'function' && typeof clearInterval === 'function') {
    const lazyTimer = setInterval(() => {
      if (!box.isConnected) { clearInterval(lazyTimer); return; }
      if (!box.querySelector('[data-lazyidx]')) { clearInterval(lazyTimer); return; }
      upgradeInView();
    }, 400);
  }

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
        if (i < lazyFrom) {
          // 轻量渲染：纯文本形态（老消息滚入视口时由 lightIO 升级）
          const lite = addMessage('assistant', '', m.usage ? { usage: m.usage } : {});
          if (lite) {
            lite.dataset.midx = i;
            lite.dataset.lazyidx = String(i);
            lite.innerHTML = '<div class="md-body md-lite"></div>';
            lite.querySelector('.md-lite').textContent = String(text).slice(0, 400);
          }
          return;   // forEach continue
        }
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
  // R19 性能：batch 重建期 addMessage 不再逐条滚底——此处一次性归底
  try { box.scrollTop = box.scrollHeight; } catch (e) {}
  // R21：重建完成立即做一次视口内升级（覆盖视口很大的场景）
  try { upgradeInView(); } catch (e) {}
  // R26：把轻量节点升级器暴露给虚拟列表——窗口换入后需立即升级视口内行
  box.__upgradeInView = upgradeInView;
  // Round 16 resume：任务中断恢复横幅（runStatus=paused 且停在 assistant/tool）。
  // 继续 = runAgentLoop 重入（历史已配平，模型从挂起点续写）；放弃 = 收敛 completed。
  if (typeof shouldOfferResume === 'function' && shouldOfferResume(s)) {
    const doResume = () => {
      const apiKey = (typeof effectiveApiKey === 'function') ? effectiveApiKey() : '';
      if (typeof continueLastGeneration === 'function') continueLastGeneration(s, apiKey);
    };
    try {
      resumeBannerMount(box, s, { onContinue: doResume });
    } catch (e) {}
    // R26 遗留 #2：逐计划 resume 卡片。横幅只给会话级入口，卡片给每个计划
    // 独立的断点进度与续跑入口；步进级回滚仍走 checkpoint_rollback 既有链路。
    try {
      if (typeof planResumeCardsMount === 'function') {
        planResumeCardsMount(box, s, { onContinue: doResume });
      }
    } catch (e) {}
  }
  // R26 遗留 #4：长会话启用虚拟列表（群聊不启用——气泡按 .message 逐条对位）。
  // 由此搜索跳转改为按索引驱动窗口定位，见 sessions/search.js。
  try { virtualChatMount(box, s); } catch (e) {}
  // v4：两帧后摘 .batch——重建完成，此后新消息恢复正常入场动画
  requestAnimationFrame(() => requestAnimationFrame(() => box.classList.remove('batch')));
}

/* ================= R26 · 长会话虚拟列表（交接报告遗留 #4） =================
 * R21 懒渲染仍把全部 .message 节点常驻 DOM（只是内容轻量）。本轮改为按视口
 * 窗口挂载：视口外的行从 DOM 卸载，前后用 spacer 撑起总高度。群聊不启用
 * （气泡映射按 .message 逐条对位，报告 §6 纪律）。
 *
 * 由此必须重设搜索跳转：虚拟列表下 [data-midx] 节点不常驻，jumpToSearchHit
 * 先调 virtualChatJumpToIndex 按索引把目标行滚进窗口，再轮询高亮。
 */
/** 纯函数：按高度前缀和求窗口 [start,end)（可单测，不碰 DOM）。 */
async function deleteSession(id, e) {
  if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
  const activeRun = (typeof RunRegistry !== 'undefined') ? RunRegistry.current() : null;
  if (activeRun && !activeRun.cancelled && id === activeRun.sessionId) {
    toast('该会话正在后台运行，完成或停止后再删除', 'warn'); return;
  }
  // R31：只拦「该会话自己有在途 run」；单模块 harness 无按会话信息时仅拦当前会话
  const _delBusy = (typeof isSessionStreaming === 'function')
    ? isSessionStreaming(id)
    : (id === (typeof currentSessionId !== 'undefined' ? currentSessionId : null)
       && !!(typeof AppState !== 'undefined' ? AppState.isStreaming : (typeof isStreaming !== 'undefined' && isStreaming)));
  if (_delBusy) { toast('该会话正在生成回复，请先停止', 'warn'); return; }
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
function _renderHistoryRoot(box, options) {
  if (!box) return;
  if (!sessions.length && !projects.length) {
    box.innerHTML = '<div class="sidebar-empty">暂无历史对话</div>';
    return;
  }
  box.innerHTML = _sessionGroupsHtml(options || {});
  _bindSessionGroups(box, options || {});
}
/* ================= R31：历史会话页（统计 + 筛选 + 搜索 + 富卡片） =================
 * 侧栏 #sidebarHistory 保持紧凑列表（_renderHistoryRoot 不变）；
 * 「会话」面板 #sessionList 升级为富信息卡片。数据同源 sessions，
 * 不新增后端接口、不改会话结构，纯前端渲染层重构。 */
const sessionHubState = { filter: 'all', query: '' };

function setSessionFilter(mode) {
  const m = (mode === 'chat' || mode === 'group' || mode === 'running') ? mode : 'all';
  sessionHubState.filter = m;
  const seg = document.getElementById('sessionFilterSeg');
  if (seg && seg.querySelectorAll) {
    seg.querySelectorAll('[data-sfilter]').forEach(btn => {
      const on = btn.dataset.sfilter === m;
      btn.classList.toggle('on', on);
      if (btn.setAttribute) btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }
  _renderSessionHub();
}

function setSessionQuery(text) {
  sessionHubState.query = String(text || '');
  _renderSessionHub();
}

function _renderSessionHub() {
  const listBox = document.getElementById('sessionList');
  const statsBox = document.getElementById('sessionStatsBar');
  if (!listBox && !statsBox) return;
  const esc = (v) => escapeHtml(String(v == null ? '' : v));
  const attr = (v) => escapeHtml(String(v == null ? '' : v)).replace(/'/g, '&#39;').replace(/"/g, '&quot;');
  const isGroup = (s) => !!(s && s.group && Array.isArray(s.group.members));
  const isRunning = (s) => {
    if (typeof RunRegistry !== 'undefined' && RunRegistry && typeof RunRegistry.has === 'function') {
      return RunRegistry.has(s.id);
    }
    return s.runStatus === 'working';
  };
  const preview = (s) => {
    const msgs = Array.isArray(s.messages) ? s.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m || m.role === 'system') continue;
      let c = m.content;
      if (Array.isArray(c)) c = c.map(p => (p && p.text) || '').join(' ');
      const t = String(c == null ? '' : c).replace(/\s+/g, ' ').trim();
      if (t) return t.slice(0, 120);
    }
    return '还没有消息，点开开始对话';
  };
  const all = (typeof sessions !== 'undefined' && Array.isArray(sessions))
    ? sessions.filter(s => s && s.id) : [];
  const stats = {
    total: all.length,
    chat: all.filter(s => !isGroup(s)).length,
    group: all.filter(isGroup).length,
    running: all.filter(isRunning).length,
  };
  if (statsBox) {
    const cell = (k, label, hint) =>
      '<div class="sh-stat sh-stat-' + k + '" title="' + attr(hint) + '">' +
        '<span class="sh-stat-value">' + stats[k] + '</span>' +
        '<span class="sh-stat-label">' + esc(label) + '</span>' +
      '</div>';
    statsBox.innerHTML =
      cell('total', '全部会话', '历史会话总数') +
      cell('chat', '单聊', '普通一对一对话数') +
      cell('group', '群聊', '多模型群聊会话数') +
      cell('running', '进行中', '当前有在途生成/接力的会话数（可多个同时进行）');
  }
  if (!listBox) return;
  const q = sessionHubState.query.trim().toLowerCase();
  let list = all.slice();
  if (sessionHubState.filter === 'group') list = list.filter(isGroup);
  else if (sessionHubState.filter === 'chat') list = list.filter(s => !isGroup(s));
  else if (sessionHubState.filter === 'running') list = list.filter(isRunning);
  if (q) {
    list = list.filter(s => {
      if (String(s.title || '').toLowerCase().indexOf(q) >= 0) return true;
      const msgs = Array.isArray(s.messages) ? s.messages : [];
      const from = Math.max(0, msgs.length - 40);
      for (let i = msgs.length - 1; i >= from; i--) {
        const m = msgs[i];
        if (!m) continue;
        let c = m.content;
        if (Array.isArray(c)) c = c.map(p => (p && p.text) || '').join(' ');
        if (typeof c === 'string' && c.toLowerCase().indexOf(q) >= 0) return true;
      }
      return false;
    });
  }
  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!list.length) {
    const why = q
      ? '没有匹配「' + esc(sessionHubState.query.trim()) + '」的会话'
      : (sessionHubState.filter === 'running' ? '当前没有正在进行的会话'
        : sessionHubState.filter === 'group' ? '还没有群聊会话'
        : sessionHubState.filter === 'chat' ? '还没有单聊会话' : '还没有历史会话');
    listBox.innerHTML = '<div class="sh-empty">' +
        '<div class="sh-empty-icon" aria-hidden="true">✦</div>' +
        '<div class="sh-empty-title">' + why + '</div>' +
        '<div class="sh-empty-sub">新建一个对话开始，或调整筛选条件</div>' +
      '</div>';
    return;
  }
  listBox.innerHTML = list.map(s => {
    const g = isGroup(s);
    const run = isRunning(s);
    const members = g ? (s.group.members || []).length : 0;
    const project = s.projectName || (s.projectWorkspace ? _shortDir(s.projectWorkspace) : '');
    const active = s.id === currentSessionId;
    const msgCount = Array.isArray(s.messages) ? s.messages.length : 0;
    return '<article class="session-item sh-card' + (active ? ' active' : '') + (run ? ' running' : '') + '"' +
        ' data-sid="' + _escId(s.id) + '" tabindex="0" role="button"' +
        ' aria-label="' + attr(s.title || '新对话') + (g ? '（群聊）' : '（单聊）') + '">' +
      '<div class="sh-card-top">' +
        '<span class="sh-badge ' + (g ? 'sh-badge-group' : 'sh-badge-chat') + '">' + (g ? '群聊' : '单聊') + '</span>' +
        '<span class="session-title sh-card-title">' + esc(s.title || '新对话') + '</span>' +
        (run ? '<span class="sh-live" title="正在生成"><i aria-hidden="true"></i>进行中</span>' : '') +
      '</div>' +
      '<p class="sh-card-preview">' + esc(preview(s)) + '</p>' +
      '<div class="sh-card-meta">' +
        '<span class="sh-meta-item"><b>' + msgCount + '</b> 条消息</span>' +
        (g ? '<span class="sh-meta-item"><b>' + members + '</b> 位成员</span>' : '') +
        (project ? '<span class="sh-meta-item sh-meta-project" title="' + attr(project) + '">' + esc(project) + '</span>' : '') +
        '<span class="sh-meta-item sh-meta-time session-time">' + formatTime(s.updatedAt) + '</span>' +
      '</div>' +
      '<span class="session-acts sh-card-acts">' +
        '<button class="session-exp" title="导出为 Markdown" aria-label="导出会话" data-sid="' + _escId(s.id) + '"><svg class="ui-icon ui-icon-16" aria-hidden="true"><use href="#i-download"/></svg></button>' +
        '<button class="session-del" aria-label="删除会话" title="删除会话" data-sid="' + _escId(s.id) + '">✕</button>' +
      '</span>' +
    '</article>';
  }).join('');
  _bindSessionGroups(listBox, { showActions: true });
}

function renderSessionList() {
  if (typeof ensureHistoryFoot === 'function') ensureHistoryFoot();
  // R31：面板用富信息卡片；侧栏仍用紧凑列表
  _renderSessionHub();
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
