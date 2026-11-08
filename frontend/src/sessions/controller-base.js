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
function _runStatusHtml(s) {
  const status = s && s.runStatus;
  const meta = RUN_STATUS_META[status];
  if (!meta) return '';
  const label = status === 'working' ? `<span class="session-status-label">${meta.label}</span>` : '';
  return `<span class="session-status ${status}" role="img" title="${meta.title}" aria-label="${meta.title}">` +
    `<span class="session-status-dot" aria-hidden="true"></span>${label}</span>`;
}
function _sessionItemHtml(s, showActions) {
  const acts = showActions ? `<span class="session-acts">
      <button class="session-exp" title="导出为 Markdown" aria-label="导出会话" data-sid="${escapeHtml(s.id)}"><svg class="ui-icon ui-icon-16" aria-hidden="true"><use href="#i-download"/></svg></button>
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
function virtualChatWindowRange(prefix, scrollTop, vh, buffer) {
  const n = prefix.length - 1;
  if (!n) return { start: 0, end: 0 };
  const lo = Math.max(0, scrollTop - vh);
  const hi = scrollTop + vh * 2;
  let start = 0, end = n;
  for (let i = 0; i < n; i++) { if (prefix[i + 1] > lo) { start = i; break; } }
  for (let i = start; i < n; i++) { if (prefix[i] >= hi) { end = i + 1; break; } }
  return { start: Math.max(0, start - buffer), end: Math.min(n, end + buffer) };
}

/** search.js 判据：当前容器是否处于虚拟列表态。 */
function virtualChatActive(box) {
  return !!(box && box.__virtualChat);
}

/** 启用虚拟列表；不满足条件返回 null（短会话 / 群聊 / 无容器）。 */
function virtualChatMount(box, s) {
  const MIN_ROWS = 120, BUFFER = 6, MIN_H = 24;
  if (!box || !box.appendChild || !box.children || !box.children.length) return null;
  if (s && s.group) return null;                       // 群聊逐条对位，不虚拟化
  const rows = Array.prototype.slice.call(box.children);
  if (rows.length < MIN_ROWS) return null;
  const heights = rows.map(r => Math.max(MIN_H, Number(r.offsetHeight) || MIN_H));
  const prefix = [0];
  for (let i = 0; i < heights.length; i++) prefix.push(prefix[i] + heights[i]);
  const top = document.createElement('div');
  const bottom = document.createElement('div');
  top.className = 'virtual-spacer';
  bottom.className = 'virtual-spacer';
  top.dataset.virtualSpacer = 'top';
  bottom.dataset.virtualSpacer = 'bottom';
  top.style.width = '100%'; bottom.style.width = '100%';
  top.style.pointerEvents = 'none'; bottom.style.pointerEvents = 'none';
  const state = {
    box: box, rows: rows, heights: heights, prefix: prefix,
    top: top, bottom: bottom, start: -1, end: -1,
    apply: null, onScroll: null,
  };
  const recalcPrefix = () => {
    state.prefix = [0];
    for (let i = 0; i < state.heights.length; i++) {
      state.prefix.push(state.prefix[i] + state.heights[i]);
    }
  };
  const detach = (el) => {
    if (!el) return;
    try {
      if (box.removeChild) box.removeChild(el);
      else if (el.remove) el.remove();
    } catch (e) {}
  };
  const apply = (scrollTop) => {
    const vh = Number(box.clientHeight) || 800;
    const r = virtualChatWindowRange(state.prefix, scrollTop, vh, BUFFER);
    if (r.start === state.start && r.end === state.end) return;
    // 保留非 rows 的动态节点（恢复横幅 / 计划卡 / 逐计划 resume 卡片）
    const dynamic = Array.prototype.slice.call(box.children).filter(n =>
      n !== state.top && n !== state.bottom && state.rows.indexOf(n) < 0);
    state.rows.forEach(detach);
    detach(state.top); detach(state.bottom);
    dynamic.forEach(detach);
    state.top.style.height = state.prefix[r.start] + 'px';
    state.bottom.style.height = Math.max(0, state.prefix[state.rows.length] - state.prefix[r.end]) + 'px';
    box.appendChild(state.top);
    for (let i = r.start; i < r.end; i++) box.appendChild(state.rows[i]);
    box.appendChild(state.bottom);
    dynamic.forEach(n => box.appendChild(n));
    state.start = r.start; state.end = r.end;
    // 窗口内行实测高度回填（R21 懒渲染升级后会变高），修正 spacer 防漂移
    let changed = false;
    for (let i = r.start; i < r.end; i++) {
      const h = Number(state.rows[i].offsetHeight);
      if (h && Math.abs(h - state.heights[i]) > 2) {
        state.heights[i] = Math.max(MIN_H, h); changed = true;
      }
    }
    if (changed) recalcPrefix();
    try { if (typeof box.__upgradeInView === 'function') box.__upgradeInView(); } catch (e) {}
  };
  state.apply = apply;
  const onScroll = () => {
    if (onScroll._t) return;
    onScroll._t = setTimeout(() => { onScroll._t = null; apply(Number(box.scrollTop) || 0); }, 60);
  };
  state.onScroll = onScroll;
  // 切会话会重建 box.innerHTML——先卸掉旧监听，避免叠加
  const prev = box.__virtualChat;
  if (prev && prev.onScroll && box.removeEventListener) {
    try { box.removeEventListener('scroll', prev.onScroll); } catch (e) {}
  }
  if (box.addEventListener) box.addEventListener('scroll', onScroll, { passive: true });
  box.__virtualChat = state;
  // renderChatHistory 的收尾归底发生在 spacer 撑高之前，此处按总高度重新归底
  box.scrollTop = prefix[rows.length];
  apply(Number(box.scrollTop) || prefix[rows.length]);
  return state;
}

/** 搜索跳转：按消息索引 midx 找到对应行，驱动虚拟窗口把它滚进 DOM。
 *  返回 true 表示已接管定位（调用方随后轮询 [data-midx] 做高亮）。 */
function virtualChatJumpToIndex(box, midx) {
  const state = box && box.__virtualChat;
  if (!state) return false;
  const target = Number(midx);
  let rowIdx = -1;
  for (let i = 0; i < state.rows.length; i++) {
    const r = state.rows[i];
    let hit = null;
    try { hit = r.querySelector ? r.querySelector('[data-midx="' + target + '"]') : null; } catch (e) {}
    if (hit || (r.dataset && String(r.dataset.midx) === String(target))) { rowIdx = i; break; }
  }
  if (rowIdx < 0) rowIdx = Math.max(0, Math.min(state.rows.length - 1, target));
  const vh = Number(box.clientHeight) || 800;
  const scrollTop = Math.max(0, state.prefix[rowIdx] - Math.round(vh / 3));
  box.scrollTop = scrollTop;
  state.start = -1;              // 强制重算窗口（即使区间相同也要换入目标行）
  state.apply(scrollTop);
  return true;
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
const _escId = (id) => escapeHtml(String(id)).replace(/'/g, '&#39;').replace(/"/g, '&quot;');
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
  foot.innerHTML = '<button class="history-dir-btn" id="historyDirBtn" title="选择历史记录存放文件夹"><svg class="ui-icon ui-icon-16" aria-hidden="true"><use href="#i-folder"/></svg> 历史目录</button>';
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
    btn.innerHTML = r.dir ? '<svg class="ui-icon ui-icon-16" aria-hidden="true"><use href="#i-folder"/></svg> ' + _shortDir(r.dir)
      : '<svg class="ui-icon ui-icon-16" aria-hidden="true"><use href="#i-folder"/></svg> 历史目录（默认）';
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
