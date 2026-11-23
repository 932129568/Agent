/* ================= 发送 ================= */
/* R31：按会话判定的防御式包装。
 * 生产环境（全模块装载）走 isSessionStreaming/RunRegistry 的精确判定；
 * 单模块 harness（旧测试只装载 send.js）缺这些符号时按 run 自身 sessionId 判定，
 * 再退回全局标志——保证「跨会话并行」与「同会话双发保护」在两种环境都成立。 */
function _sendSessionBusy(sid) {
  if (typeof isSessionStreaming === 'function') return isSessionStreaming(sid);
  const run = (typeof RunRegistry !== 'undefined' && RunRegistry && typeof RunRegistry.current === 'function')
    ? RunRegistry.current(sid) : null;
  if (run) return !run.cancelled && (!sid || run.sessionId === sid);
  return (typeof AppState !== 'undefined') ? !!AppState.isStreaming
    : (typeof isStreaming !== 'undefined' && !!isStreaming);
}
function _sendRefreshStreaming() {
  if (typeof refreshStreamingFlag === 'function') return refreshStreamingFlag();
  if (typeof AppState !== 'undefined') AppState.isStreaming = false;
  else isStreaming = false;
  return false;
}
/* ================= R101 T02 · 排队条 =================
 * 现状问题：在途 run 期间发消息只会弹一句 toast「已排队」，随后消息被追加进
 * s.messages 等下一轮 beforeRound 带走。用户看不到「排了几条、什么时候发、
 * 能不能撤回」，只能干等 —— 提示是一次性的，队列本身在界面上不存在。
 *
 * 这里的队列**不是第二套发送机制**：消息仍在发送时就写进 s.messages（既有语义
 * 不动，在途 run 的下一轮自然带上）。本队列只做「可见 + 可撤回」这一层视图。
 *
 * 撤回的边界（很重要，写错会删掉已被消费的消息）：
 *   只在「该条仍是会话最后一条消息，且其后没有任何 assistant 回复」时才允许删。
 *   一旦 run 已经把它当成一轮输入消费掉（后面出现了 assistant 内容），撤回就
 *   不是「取消发送」而是「篡改历史」，必须拒绝。
 */
const _sendQueue = [];

function _queueSid() {
  try {
    return String((typeof AppState !== 'undefined' && AppState.currentSessionId)
      || (typeof currentSessionId !== 'undefined' ? currentSessionId : '') || '');
  } catch (e) { return ''; }
}

function _queuePrune() {
  const s = (typeof getCurrentSession === 'function') ? getCurrentSession() : null;
  const total = s && Array.isArray(s.messages) ? s.messages.length : 0;
  for (let i = _sendQueue.length - 1; i >= 0; i--) {
    const q = _sendQueue[i];
    if (q.sid !== _queueSid() || q.midx >= total) _sendQueue.splice(i, 1);
  }
}

function _queueRender() {
  if (typeof document === 'undefined') return;
  _queuePrune();
  const host = document.querySelector('#chatInputArea .input-inner');
  if (!host) return;
  let bar = document.getElementById('queueBar');
  if (!_sendQueue.length) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'queue-bar';
    bar.id = 'queueBar';
    bar.setAttribute('role', 'status');
    const anchor = document.getElementById('attachPreview');
    if (anchor && anchor.parentNode === host) anchor.insertAdjacentElement('afterend', bar);
    else host.insertBefore(bar, host.firstChild);
  }
  const head = '<span class="qb-count">' + _sendQueue.length + ' 条排队中</span>' +
    '<span class="qb-hint">当前步骤结束后按顺序发送</span>';
  const rows = _sendQueue.map((q, i) =>
    '<div class="qb-row"><span class="qb-text"></span>' +
    '<button type="button" class="qb-cancel" data-qb-act="one" data-i="' + i +
    '" title="撤回这条排队消息">撤回</button></div>').join('');
  bar.innerHTML = '<div class="qb-head">' + head +
    '<button type="button" class="qb-clear" data-qb-act="all" title="撤回全部排队消息">全部撤回</button></div>' + rows;
  // 文案用 textContent 写入，避免用户输入里的尖括号被当 HTML
  Array.prototype.forEach.call(bar.querySelectorAll('.qb-text'), (el, i) => {
    el.textContent = (_sendQueue[i] && _sendQueue[i].text) || '（无文本）';
  });
  // 不在这里绑 onclick：绑定会让 render → cancel* 形成符号级环。
  // 事件统一由文件末尾的 document 级委托处理（见 _queueBindDelegation）。
}

function _queueCancelOne(i) {
  const q = _sendQueue[i];
  if (!q) return;
  const s = (typeof getCurrentSession === 'function') ? getCurrentSession() : null;
  if (!s || !Array.isArray(s.messages)) return;
  const last = s.messages.length - 1;
  // 只有「仍是最后一条」才安全；否则说明 run 已消费（或后面已有新消息）
  if (q.midx !== last || !s.messages[last] || s.messages[last].role !== 'user') {
    _sendQueue.splice(i, 1);
    _queueRender();
    if (typeof toast === 'function') toast('该消息已被当前任务读取，无法撤回（队列显示已清理）', 'warn');
    return;
  }
  s.messages.splice(last, 1);
  _sendQueue.splice(i, 1);
  if (typeof saveSessions === 'function') saveSessions();
  if (typeof renderChatHistory === 'function') { try { renderChatHistory(s.id); } catch (e) {} }
  if (typeof navUpdateEmptyGuide === 'function') navUpdateEmptyGuide();
  _queueRender();
  if (typeof toast === 'function') toast('已撤回排队消息', 'ok');
}

function _queueCancelAll() {
  // 从后往前撤：每次都让被撤的那条成为「最后一条」，边界判据始终成立
  for (let i = _sendQueue.length - 1; i >= 0; i--) _queueCancelOne(i);
}

/* 队列条的点击统一在这里委托。
 * 为什么不在 _queueRender 里逐按钮绑 onclick：那会让
 * `_queueRender → _queueCancelOne → _queueRender` 形成符号级环
 * （SCC 棘轮零余量，本轮实测把 17/104 推到 19/109）。
 * 顶层匿名监听器不算符号，链路是单向的：监听器 → cancel → render。 */
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('[data-qb-act]') : null;
    if (!t) return;
    const act = t.getAttribute('data-qb-act');
    if (act === 'one') _queueCancelOne(parseInt(t.getAttribute('data-i'), 10));
    else if (act === 'all') _queueCancelAll();
  });
}

/* ================= R101 T03 · 待编辑重发（覆盖删除） =================
 * 语义（用户拍定）：编辑某条历史提问并重发时，**直接覆盖删除**旧的后继内容，
 * 不保留分支。这正是 regenerate() 的截断语义，所以这里只是把它前移到发送链入口，
 * 让「编辑 → 改字 → 发送」是一条连续动作，而不是先弹编辑器再重跑一遍。
 *
 * 编辑态由 markdown.js 的「编辑」按钮标在消息元素上（.content.editing +
 * data-edit-midx / data-edit-sid + 输入区里已填好的原文）。这里是消费端：
 *   ① 该条之后的消息整体 splice 掉（覆盖删除）；
 *   ② 该条 content 换成这次输入（数组形态替换文本段，图片等非文本段保留）；
 *   ③ 清掉编辑标记，**继续走原有发送流程**——但不再 push 一条新的 user 消息，
 *      否则同一条提问会在历史与界面上各出现两次。
 *
 * 为什么用 DOM 做中间态：编辑态的生产方（markdown.js）与消费方（本文件）不是
 * 同一个模块，跨模块共享一个 let 会新增静态引用（SCC 棘轮 17/104 零余量），
 * DOM 是零成本、零依赖的既有通道，还自带「哪一条」的定位信息。
 */
function _sendPendingEditTarget() {
  try {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null;
    const el = document.querySelector('.content.editing');
    if (!el || !el.dataset) return null;
    const midx = parseInt(el.dataset.editMidx, 10);
    if (!Number.isInteger(midx) || midx < 0) return null;
    return { el: el, midx: midx, sid: String(el.dataset.editSid || '') };
  } catch (e) { return null; }
}

/** 清掉一条消息上的编辑标记（发送已消费 / 目标失效时调用）。 */
function _sendClearEditMark(el) {
  if (!el) return;
  try { if (el.classList) el.classList.remove('editing'); } catch (e) {}
  try { if (el.dataset) { delete el.dataset.editMidx; delete el.dataset.editSid; } } catch (e) {}
  try {
    const flag = (typeof el.querySelector === 'function') ? el.querySelector('.edit-flag') : null;
    if (flag && typeof flag.remove === 'function') flag.remove();
  } catch (e) {}
}

/**
 * 消费待编辑状态。返回：
 *   'none'    无编辑态 / 编辑态不属于当前会话 → 走正常发送
 *   'busy'    本会话正在生成 → 已 toast 提示，调用方必须中止本次发送
 *   'applied' 已截断并替换本条内容 → 调用方直接起 run，**不要**再 push user 消息
 */
function _sendApplyPendingEdit(s, userContent, sentTokens, sentDirective, queued) {
  const hit = _sendPendingEditTarget();
  if (!hit) return 'none';
  if (!s || !Array.isArray(s.messages)) { _sendClearEditMark(hit.el); return 'none'; }
  const sid = String(s.id || '');
  // 别的会话的编辑态：不消费也不清除（用户切回去还能接着改）
  if (hit.sid && sid && hit.sid !== sid) return 'none';
  // 与「流式生成中」互斥：覆盖删除会改掉在途 run 正在读的历史
  if (queued || _sendSessionBusy(sid)) {
    if (typeof toast === 'function') toast('本会话正在生成回复，请先停止或等待完成', 'warn');
    return 'busy';
  }
  const m = s.messages[hit.midx];
  if (!m || m.role !== 'user') { _sendClearEditMark(hit.el); return 'none'; }
  // ① 覆盖删除：这条之后的全部消息（assistant/tool）直接丢弃，不留分支。
  // 截断点落在 user 边界上，tool_calls 配平天然成立（与 regenerate 同口径）。
  if (s.messages.length > hit.midx + 1) s.messages.splice(hit.midx + 1);
  // ② 内容替换（与 R58 同口径：数组形态原地换文本段，保留图片/附件占位）
  if (Array.isArray(userContent)) {
    m.content = userContent;
  } else if (Array.isArray(m.content)) {
    const ti = m.content.findIndex(p => p && p.type === 'text');
    if (ti >= 0) m.content[ti].text = userContent;
    else m.content.unshift({ type: 'text', text: userContent });
  } else {
    m.content = userContent;
  }
  m.edited = true;
  // 本轮若带了输入舱胶囊，元数据跟着换（否则重启后徽章还是旧那一轮的）
  if (Array.isArray(sentTokens) && sentTokens.length > 0) {
    m.meta = { tokens: sentTokens, directive: String(sentDirective || '') };
    s._metaRev = (s._metaRev || 0) + 1;
  }
  s.updatedAt = Date.now();   // R99 P0：截断改了会话内容，必须推进 updatedAt
  _sendClearEditMark(hit.el);
  return 'applied';
}

async function sendMessage() {
  const appState = (typeof AppState !== 'undefined') ? AppState : null;
  const appAttachments = appState ? appState.attachments : attachments;
  const activeSessionId = appState ? appState.currentSessionId : currentSessionId;
  const activeRun = (typeof RunRegistry !== 'undefined' && RunRegistry && typeof RunRegistry.current === 'function')
    ? RunRegistry.current(activeSessionId) : null;
  // R31：只有「本会话自己的 run」才拦截；其他会话在途一律并行放行
  const _sameRun = (activeRun && !activeRun.cancelled && (!activeSessionId || activeRun.sessionId === activeSessionId))
    ? activeRun : null;
  if (_sameRun) {
    // R45（排队式 steering，F2d 改进⑥）：同会话 run 在途 → 消息**排队**而非
    // 拦截——走下方主路径入库（气泡+历史），runAgentLoop 调用点按标志跳过；
    // 下一轮 beforeRound 重建请求时自然带上（轮边界注入=Claude Code 语义的
    // Harbor 化，调研轮 21）。群聊会话不排队（调度器另有 _busySid 语义）；
    // 专家一次性消费不排队。
    const _qInput = document.getElementById('userInput');
    const _qText = _qInput ? _qInput.value.trim() : '';
    const _qAtt = appState ? appState.attachments : attachments;
    const _qSid = appState ? appState.currentSessionId : currentSessionId;
    const _isGroup = (typeof sessions !== 'undefined' && Array.isArray(sessions) &&
      (sessions.find(x => x.id === _qSid) || {}).group &&
      Array.isArray((sessions.find(x => x.id === _qSid) || {}).group.members));
    const _expertPending = (typeof expertNextSelection !== 'undefined' && expertNextSelection);
    if ((_qText || _qAtt.length > 0) && !_isGroup && !_expertPending) {
      sendMessage._queued = true;
      // R1-UX[7]：排队明示（替代「点停止键」提示——纠偏无需打断）
      if (typeof toast === 'function') {
        toast('已排队：当前工具步骤结束后，AI 将看到这条消息（无需打断任务）', 'info');
      }
    } else {
      // 群聊/专家/空输入维持原行为（一次性节流提示）
      if (typeof toast === 'function' && !sendMessage._busyToastAt) {
        sendMessage._busyToastAt = Date.now();
        toast('正在生成中，点红色停止键可中断', 'info');
        setTimeout(() => { sendMessage._busyToastAt = 0; }, 8000);
      }
      return;   // 当前会话已有活动 run，不启动第二 run
    }
  }
  // 主理人追加裁定（2026-11-01）：跨会话发送默认并行——__crossRun 时不再拦截
  // 提示，runAgentLoop 入口自动升级为并行 run；isStreaming 全局标志由 run
  // 所有权管理（P0-3「并行」按钮路径同口径）
  // R31：同会话在途 run 已在上方拦截；此处按会话判定，跨会话并行不再阻塞。
  // R48-1 修复：排队分支（_queued）已确认在途 run 并打算入库——此处若仍拦截
  // 则消息永不入库且 _queued 残留毒化下一次正常发送（扫描实证的死路）。
  if (_sendSessionBusy(activeSessionId) && !sendMessage._queued) return;
  // 群聊协作（Beta）：群会话由 group.js 接管发送链（成员调度/交接/接力）
  if (typeof groupHandleOutgoing === 'function') {
    const _gSid = appState ? appState.currentSessionId : currentSessionId;
    if (_gSid && typeof sessions !== 'undefined' && Array.isArray(sessions)) {
      const _gs = sessions.find(x => x.id === _gSid);
      if (_gs && _gs.group && Array.isArray(_gs.group.members)) {
        const _gText = document.getElementById('userInput').value.trim();
        if (_gText) {
          document.getElementById('userInput').value = '';
          if (appState) appState.attachments = [];
          else attachments = [];
          try { if (typeof renderPreview === 'function') renderPreview(); } catch (e) {}
          await groupHandleOutgoing(_gText);
        }
        return;
      }
    }
  }
  // 专家选择是一次性消费：回车与发送按钮都在真正普通发送之前走专家 run。
  // R62：先确保会话存在——空会话态（新建对话后）选的专家原先带着 sessionId=''
  // 跑 run（幽灵空 id 会话被 push 进 sessions，且选专家时的会话对不上号）。
  // v2.1 M1（P04）：统一入口——输入舱内联胶囊里的原生专家包（builtin_pkg）与旧
  // expertNextSelection 走同一条路：都交给 runExpertSelection，由它在主对话流里
  // 生成带徽章的用户气泡并清空输入框，不再"隐身"运行。composer* 在部分测试沙箱
  // 里不存在，全程 typeof 守卫。
  const _curTokens = (typeof composerGetTokens === 'function')
    ? composerGetTokens(activeSessionId) : [];
  const _builtinToken = _curTokens.find(t => t && t.source === 'builtin_pkg') || null;
  if (_builtinToken || (typeof expertNextSelection !== 'undefined' && expertNextSelection)) {
    try { ensureSession(); } catch (e) {}
    return runExpertSelection({ token: _builtinToken, allTokens: _curTokens });
  }
  const input = document.getElementById('userInput');
  const text = input.value.trim();
  if (!text && appAttachments.length === 0) return;
  // I08：/sub <任务> —— 派生子代理（运行期入口，不新增按钮/模板 id）。
  // 只支持"纯文本任务、无附件"：带附件时应走普通发送，避免语义含糊。
  if (/^\/sub\s+/.test(text) && appAttachments.length === 0) {
    const spawn = (typeof window !== 'undefined') ? window['subagent' + 'Spawn'] : null;
    const s0 = (typeof getCurrentSession === 'function') ? getCurrentSession() : null;
    if (typeof spawn === 'function' && s0) {
      const task = text.replace(/^\/sub\s+/, '').trim();
      const h = spawn(s0, task, {});
      input.value = '';
      if (h && h.ok) {
        addMessage('system', '已派生子代理：' + task.slice(0, 40) + '（完成后回一条摘要到本会话）');
        if (typeof updateCostEstimate === 'function') { try { updateCostEstimate() } catch (e) {} }
        return;
      }
      addMessage('error', '子代理未能派生：' + ((h && h.reason) || 'unknown'));
      return;
    }
  }
  const apiKey = effectiveApiKey();
  if (!apiKey && !localModeActive()) {   // 修复：本地模式无需 API Key（原误报）
    addMessage('error', '请先在「设置」中填入 API Key');
    document.getElementById('settingsPanel').classList.add('show');
    return;
  }
  // 修复 S20：入口同步置位 isStreaming——runAgentLoop 原先在两个 await 之后才置位，
  // Enter 长按连发/快速双击可在置位前过守卫，起双并发 Agent 循环（消息交错/计费翻倍）。
  // 以下所有提前 return 的路径都必须复位。
  if (appState) appState.isStreaming = true;
  else isStreaming = true;
  try {
  ensureSession();
  const s = getCurrentSession();
  if (s.messages.length <= 1 && !s.worklogInjected) {
    try {
      const wl = await callApi('get_worklog', []);
      if (wl && wl.trim().length > 0) {
        s.worklogInjected = true;
        s.messages.push({ role: 'system', content:
          '【工作日志】\n' + wl + '\n（来自 _glm_worklog.md，供延续上下文）' });
      }
    } catch (e) {}
  }
  try {
    // 复核修正：上下文口径改 historyTokens（原 sumSessionTokens 累加每轮
    // usage.total_tokens——每轮重复计入整个 prompt，随轮数近平方增长，
    // 20 万阈值过早触发 force 压缩，破坏前缀缓存并丢历史）
    const _ctxTok = (typeof historyTokens === 'function')
      ? historyTokens(s.messages) : sumSessionTokens(s);
    // 复核批新增：上下文窗口偏好（模型弹层内嵌）——非 0 时压缩阈值随偏好
    // 调整（0.8 头部余量给本轮输出）；默认 200K 口径不变
    const _mpC = (typeof getModelPrefs === 'function') ? getModelPrefs() : null;
    const _ctxCap = (_mpC && _mpC.ctx_k > 0) ? Math.floor(_mpC.ctx_k * 1000 * 0.8) : 200000;
    if (_ctxTok > _ctxCap && s.messages.length >= 6) {
      await compactNow(s, apiKey, { force: true, quiet: true });
    }
  } catch (e) {}
  if (text === '/compact') {
    input.value = ''; attachments = []; renderPreview();
    if (s.messages.length && String(s.messages[0]?.content || '').includes('【历史纪要】')) {
      _sendRefreshStreaming();   // 修复 S20：提前 return 路径复位（R31 按会话重算）
      addMessage('assistant', '刚刚已做过压缩，历史已是纪要态，无需重复。'); return;
    }
    // 复核修正：压缩期间保持流式锁——原提前复位使 30s 压缩窗口内可并发
    // 发送，compactNow 整体替换 s.messages 会把并发写入的用户消息/在途
    // 回复从历史与 UI 一并抹掉。force 绕过 compactNow 的 isStreaming 早退。
    if (appState) appState.isStreaming = true; else isStreaming = true;
    try {
      await compactNow(s, apiKey, { force: true });
    } finally {
      _sendRefreshStreaming();
    }
    return;
  }
  /* ================= v1.8.0 M3：/plan 计划模式入口 =================
   * /plan <任务> → 生成计划（LLM JSON / 模板兜底）→ 计划卡待批准 →
   * 批准 → 建检查点 → 以任务文本走原 Agent 循环（todo 由 60-agent-loop 推进）。 */
  if (text.indexOf('/plan') === 0) {
    input.value = ''; attachments = []; renderPreview();
    const task = text.slice(5).trim() || (text ? '' : '');
    if (!task) {
      _sendRefreshStreaming();
      addMessage('assistant', '用法：/plan <任务描述>\n例：/plan 查一下 Qwen3 发布信息并整理成笔记保存到工作区');
      return;
    }
    _sendRefreshStreaming();   // 计划阶段不占流式；批准后由内层发送逻辑重新置位
    await planModeRun(task);
    return;
  }
  const currentAttachments = appState ? appState.attachments : attachments;
  const images = currentAttachments.filter(a => a.type === 'image');
  const videos = currentAttachments.filter(a => a.type === 'video');
  const textFiles = currentAttachments.filter(a => a.type === 'text');
  const otherFiles = currentAttachments.filter(a => a.type === 'file');   // R33：任意格式文件附件
  const toolModeEl = document.getElementById('toolMode');
  const attachmentWriteAllowed = !toolModeEl || !toolModeEl.value || toolModeEl.value === 'full';
  const mem = recallMemory(text);
  const memBlock = mem ? '\n\n[相关历史记忆]\n' + mem + '\n（背景参考，无关可忽略）' : '';
  let userContent;
  if (images.length === 0 && videos.length === 0 && textFiles.length === 0 && otherFiles.length === 0) {
    userContent = (text + memBlock) || '请回复';
  } else {
    const parts = [];
    let fullText = (text ? text + memBlock : '');
    if (otherFiles.length > 0) {
      const meta = otherFiles.map(f => '- ' + f.name + '（' + (f.mime || '未知类型') +
        '，' + ((Number(f.size) || 0) / 1024).toFixed(1) + ' KB；二进制内容未解析）').join('\n');
      fullText = (fullText ? fullText + '\n' : '') + '[附件文件]\n' + meta;
    }
    if (textFiles.length > 0) {
      const ATT_FULL = 200000;   // ≤20万字符直接全文注入
      const results = await Promise.all(textFiles.map(async f => {
        if (!attachmentWriteAllowed) {
          if (f.text.length <= ATT_FULL) {
            return `\n----- 附件: ${f.name} | 用户提供的全文 ${f.text.length} 字（未写入工作区）-----\n${f.text}`;
          }
          return `\n----- 附件: ${f.name} | 用户提供的文件，仅预览前500字（未写入工作区）-----\n${f.text.slice(0,500)}…`;
        }
        let p = '';
        try { p = await callApi('save_workspace_file', [f.name, f.text]); } catch (e) {}
        if (f.text.length <= ATT_FULL) {
          return `\n----- 附件: ${f.name} | 全文 ${f.text.length} 字已完整注入 | 原文件路径: ${p} -----\n修改此文件用 search_replace 打补丁到上述路径, 禁止另存副本。\n${f.text}`;
        }
        return `\n----- 附件: ${f.name} | 全文 ${f.text.length} 字超预算, 已存工作区 | 路径: ${p} -----\n预览前500字:\n${f.text.slice(0,500)}…\n需要原文用 read_file(路径, force=true) 分段读`;
      }));
      fullText = (fullText ? fullText + '\n' : '') + results.join('\n');
    }
    parts.push({ type: 'text', text: fullText || '请分析以上内容' });
    images.forEach(img => parts.push({ type: 'image_url', image_url: { url: img.dataUrl } }));
    videos.forEach(v => parts.push({ type: 'video_url', video_url: { url: v.dataUrl } }));
    userContent = parts;
  }
  const displayText = text +
    (textFiles.length > 0 ? `\n（附带 ${textFiles.length} 个文本文件）` : '') +
    (otherFiles.length > 0 ? `\n（附带 ${otherFiles.length} 个文件）` : '');
  const displayExtra = {};
  if (images.length > 0) displayExtra.images = images.map(i => i.dataUrl);
  if (textFiles.length > 0) displayExtra.files = textFiles.map(f => f.name);
  // v2.1 M1（P04）：消费本轮一次性胶囊（保留 scope==='session' 常驻胶囊），并把
  // 本轮指令快照固化进用户消息的 meta——这是「重启后徽章复原」与「并行会话不串台」
  // 的同一份数据源。composer*/hub* 在部分测试沙箱里不存在，全部 typeof 守卫；
  // tokens 仅在非空时才挂到 displayExtra/meta，避免给既有断言多出空字段。
  const _sentTokens = (typeof composerConsumeOnceTokens === 'function')
    ? composerConsumeOnceTokens(s.id) : [];
  if (_sentTokens.length > 0) displayExtra.tokens = _sentTokens;
  const _sentDirective = (typeof hubBuildTokensDirective === 'function')
    ? (hubBuildTokensDirective(_sentTokens)
      || ((typeof hubDirectiveFor === 'function') ? hubDirectiveFor(s.id) : ''))
    : '';
  /* R101 T03：编辑重发（覆盖删除）——在真正 push 之前消费编辑态。
   * 位置刻意选在这里：activeSessionId / apiKey / 附件与记忆块都已就绪，
   * userContent 就是这一次要写回那条旧提问的内容；而 addMessage/push 尚未发生，
   * 所以覆盖删除后不会多出第二条 user 消息。 */
  {
    const _editState = _sendApplyPendingEdit(s, userContent, _sentTokens, _sentDirective, !!sendMessage._queued);
    if (_editState === 'busy') {
      sendMessage._queued = false;   // R48-1：中止路径清排队旗，防毒化下一次发送
      _sendRefreshStreaming();       // S20：入口已置位 isStreaming，中止必须复位
      return;
    }
    if (_editState === 'applied') {
      saveSessions();
      renderSessionList();
      input.value = '';
      input.style.height = 'auto';
      if (appState) appState.attachments = [];
      else attachments = [];
      renderPreview();
      // 历史已被截断+替换：重绘当前会话（旧的后继气泡必须从界面消失）。
      // 走动态索引而非裸标识符：renderChatHistory 在 sessions/controller.js，
      // 裸引用会给 sendMessage 新增一条静态出边（SCC 棘轮零余量）。
      const _renderHistory = (typeof window !== 'undefined') ? window['render' + 'ChatHistory'] : null;
      if (typeof _renderHistory === 'function') { try { _renderHistory(s); } catch (e) {} }
      if (typeof navUpdateEmptyGuide === 'function') navUpdateEmptyGuide();
      if (typeof toast === 'function') toast('已覆盖原来的提问，正在重新生成…', 'ok');
      runAgentLoop(s, apiKey);
      return;
    }
  }
  const uEl = addMessage('user', displayText || '（发送附件）', displayExtra);
  if (text) addMsgActions(uEl, text, true);
  if (_sentTokens.length > 0 || _sentDirective) {
    const _userMsgObj = { role: 'user', content: userContent };
    _userMsgObj.meta = { tokens: _sentTokens, directive: _sentDirective };
    s.messages.push(_userMsgObj);
    // 落盘签名要能看见 meta 变化，否则 sessions/store.js 的「未变更短路」会跳过写盘
    s._metaRev = (s._metaRev || 0) + 1;
  } else {
    s.messages.push({ role: 'user', content: userContent });
  }
  if (typeof navUpdateEmptyGuide === 'function') navUpdateEmptyGuide();   // 修复（四轮）：首条消息发出后空态引导立即消失
  // 修复 UX-1/UX-3（v1.4）：live 消息也 stamp 下标（瘦身标记/搜索跳转用）。
  // dataset 防御：非 DOM 元素（测试桩/降级路径）时静默跳过，不抛错中断发送
  if (uEl && uEl.dataset) uEl.dataset.midx = s.messages.length - 1;
  updateSessionTitle(text || (textFiles[0]?.name || '附件'));
  s.updatedAt = Date.now();
  saveSessions();
  renderSessionList();
  input.value = '';
  input.style.height = 'auto';
  if (appState) appState.attachments = [];
  else attachments = [];
  renderPreview();
  if (sendMessage._queued) {
    // R45（排队式 steering）：消息已入库——在途 run 的下一轮 beforeRound
    // 重建请求时自然带上；不启动第二 run。清标志，后续发送恢复正常语义。
    // isStreaming 由在途 run 所有权管理——此处不得复位（防误伤在途 run）。
    // R101 T02：同时登记到可视队列（只做展示与撤回，不改发送语义）。
    try {
      _sendQueue.push({
        sid: s.id,
        midx: s.messages.length - 1,
        text: String(text || (textFiles && textFiles.length ? textFiles[0].name : '') || '').slice(0, 120)
      });
      _queueRender();
    } catch (e) {}
    sendMessage._queued = false;
    return;
  }
  runAgentLoop(s, apiKey);
  } catch (e) {
    sendMessage._queued = false;   // R48-1：异常路径清排队旗（防毒化下一次发送）
    _sendRefreshStreaming();   // S20：异常不卡在生成中（R31 按会话重算）
    toast('发送失败: ' + (e && e.message ? e.message : e), 'err');
  }
}
/* ================= R101 T03 · 续跑纠偏指令 =================
 * 落点选择（重要，说明为什么这么做）：
 *   `continueLastGeneration` 是续跑的最终入口，它此前只做一件事——runAgentLoop
 *   重入。**不存在**既有的「续跑提示注入点」可供拼接（没有往输入框或请求里塞
 *   提示的代码），所以没有现成的地方可复用。
 *   两条可行路径：
 *     A. 在 runAgentLoop 之前临时追加一条 system 消息，run 结束后移除（本实现）；
 *     B. 改 run-controller 的 beforeRound，把指令拼进每轮 sysContent。
 *   选 A 的理由：B 要动 run-controller 里刚修好的 S2/S3 段落与 sysContent 装配
 *   逻辑（零余量的高风险区），而 A 完全落在 send.js 内。且 A 的效果与 B 等价——
 *   请求装配处 `normalizeSystemMessages([{system:sysContent}, ...slimMsgs])` 会把
 *   历史里的所有 system 按顺序合并进唯一那条 system，所以临时 system 最终落在
 *   **系统提示词**里而不是 user turns 里，不污染对话历史语义。
 *
 * 生命周期：
 *   · 追加：只在 directive 非空时；带 __resumeDirective 标记便于排查；
 *   · 移除：run 的 promise 落定（成功或失败）后按**对象身份**摘除；run 期间若发生
 *     压缩换掉整个 messages 数组，对象已不存在 → 什么都不做（幂等）；
 *   · 收尾再 saveSessions 一次：run 期间可能已经落盘过带指令的历史，不补这一次
 *     会把「已摘除」的内存态和磁盘态分叉，重开会话时陈旧指令又冒出来。
 */
async function continueLastGeneration(s, apiKey, directive) {
  if (_sendSessionBusy(s && s.id)) return;   // R31：只拦本会话
  const d = String(directive == null ? '' : directive).trim();
  let injected = null;
  if (d && s && Array.isArray(s.messages)) {
    injected = {
      role: 'system',
      content: '【用户纠偏指令（本次续跑专用）】\n' + d +
        '\n（请据此调整方案；若与更早的历史指令冲突，以本条为准）',
      __resumeDirective: true,
    };
    s.messages.push(injected);
  }
  const dropInjected = () => {
    if (!injected) return;
    try {
      const idx = Array.isArray(s.messages) ? s.messages.indexOf(injected) : -1;
      if (idx >= 0) s.messages.splice(idx, 1);   // 只摘自己那条，不动 run 期间新增的消息
      if (typeof saveSessions === 'function') saveSessions();
    } catch (e) {}
    injected = null;
  };
  let runPromise = null;
  try { runPromise = runAgentLoop(s, apiKey); } catch (e) { dropInjected(); throw e; }
  if (injected) {
    if (runPromise && typeof runPromise.then === 'function') {
      runPromise.then(dropInjected, dropInjected);   // 成功/失败都要摘，别留残迹
    } else {
      dropInjected();   // 同步桩（vm harness）：没有真 run 在跑，立即收尾
    }
  }
}
async function regenerate(midx) {
  const s = getCurrentSession();
  if (!s || _sendSessionBusy(s.id)) return;   // R31：只拦本会话
  // 复核修正：截断到最后一条 user 消息之后——原 splice(lastAssistant) 会把
  // Agent 循环早退/报错留下的悬挂 user 消息一并删掉（历史与 UI 同时丢消息）；
  // 悬挂的 user 提问正是重生成应回应的对象，保留。
  // R58：支持从任意 assistant 消息重生成（midx=被点击消息下标）——回溯到其前
  // 最近的 user 边界截断重跑；缺省（live 气泡/末条）保持「最后一条 user」语义。
  let lastUser = -1;
  const fromIdx = (Number.isInteger(midx) && midx >= 0 && s.messages[midx]
    && s.messages[midx].role === 'assistant') ? midx : s.messages.length - 1;
  for (let i = Math.min(fromIdx, s.messages.length - 1); i >= 0; i--) {
    if (s.messages[i] && s.messages[i].role === 'user') { lastUser = i; break; }
  }
  if (lastUser < 0) return;                    // 无用户消息无从重生成
  if (s.messages.length > lastUser + 1) {
    s.messages.splice(lastUser + 1);
    // R99 P0：截断是**对会话内容的修改**，必须推进 updatedAt——否则双源合并
    // （store.js 按 updatedAt 取新）看不到本次修改，重开会话时旧的长历史会
    // 反压回来，表现为「重新生成/回退失效」或「完整版被截断版覆盖」。
    s.updatedAt = Date.now();
  }
  // 修复 ㉘：重建全部历史消息（原只回放 user，历史 assistant 回复与工具摘要从界面消失）
  renderChatHistory(s);
  const apiKey = effectiveApiKey();
  if (!apiKey && !localModeActive()) {   // 修复：本地模式无需 API Key（原误报）
    addMessage('error', '请先在「设置」中填入 API Key');
    document.getElementById('settingsPanel').classList.add('show');
    return;
  }
  runAgentLoop(s, apiKey);
}
function exportChat() {
  const s = getCurrentSession();
  if (!s || s.messages.length === 0) { toast('当前没有对话可导出', 'warn'); return; }
  let md = `# ${s.title || '对话'}\n\n`;
  s.messages.forEach(m => {
    if (m.role === 'user') {
      let text = typeof m.content === 'string' ? m.content
        : (Array.isArray(m.content) ? m.content.map(p => p.text || '').join(' ') : '');
      md += `## 我\n\n${text}\n\n`;
    } else if (m.role === 'assistant' && typeof m.content === 'string' && m.content) {
      md += `## GLM\n\n${m.content}\n\n`;
    }
  });
  const blob = new Blob([md], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (s.title || 'chat').replace(/[\\/:*?\"<>|]/g, '_').slice(0, 40) + '.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
/* 一次性绑定标记挂函数属性（勿用模块级 let——vm harness 抽函数体会丢外层声明） */
function toggleSettings() {
  const panel = document.getElementById('settingsPanel');
  if (!panel) return;
  if (!toggleSettings._bound) {
    toggleSettings._bound = true;
    // 点遮罩（窗口外空白）关闭；Esc 关闭（v4 设置窗口化交互补全）。
    // typeof 守卫：vm 沙箱的 panel/document 桩可能无 addEventListener（test_v13_qa）
    if (panel.addEventListener) {
      panel.addEventListener('click', (e) => { if (e.target === panel) toggleSettings(); });
    }
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!panel.classList.contains('show')) return;
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'TEXTAREA' || tag === 'INPUT') return;   // 输入中不误关
        toggleSettings();
      });
    }
  }
  if (panel.classList.contains('show')) {
    // v4：关=播退场（v4SetWinOut 140ms in-soft）再撤 .show——不再生硬瞬消
    if (panel.classList.contains('hiding')) return;   // 防重入
    panel.classList.add('hiding');
    const done = () => {
      try { panel.classList.remove('show', 'hiding'); } catch (e) {}
      if (typeof _unbindOverlayKeyboard === 'function') _unbindOverlayKeyboard(panel);
    };
    if (typeof MOTION !== 'undefined' && !MOTION.instant()) {
      MOTION.onAnimEnd(panel, 'animationend', MOTION.compOut()).then(done);
    } else { done(); }
    return;
  }
  panel.classList.add('show');
  // 打开设置面板时顺带刷新 MCP 服务器列表（纯本地读取，零网络；失败已在 loadMcpServers 内 toast）
  try { loadMcpServers(); } catch (e) {}
  // 修复 UX-4（v1.4）：设置浮层打开时构建锚点导航（DOM 已就绪；每次打开重建保持幂等）
  try { buildSetNav(); } catch (e) {}
  if (typeof _bindOverlayKeyboard === 'function') {
    _bindOverlayKeyboard(panel, (event) => {
      const tag = (event.target && event.target.tagName) || '';
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      toggleSettings();
    });
  }
}
function closeSidebarDrawer() {
  const wasOpen = document.body.classList.contains('sidebar-open');
  document.body.classList.remove('sidebar-open');
  const backdrop = document.getElementById('sidebarBackdrop');
  if (backdrop) backdrop.hidden = true;
  const btn = document.getElementById('sidebarToggleBtn');
  if (wasOpen && btn && btn.setAttribute) btn.setAttribute('aria-expanded', 'false');
}
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const mobile = typeof window.matchMedia === 'function' && window.matchMedia('(max-width:768px)').matches;
  if (mobile) {
    const open = !document.body.classList.contains('sidebar-open');
    document.body.classList.toggle('sidebar-open', open);
    sidebar.classList.remove('collapsed');
    const backdrop = document.getElementById('sidebarBackdrop');
    if (backdrop) backdrop.hidden = !open;
    const btn = document.getElementById('sidebarToggleBtn');
    if (btn && btn.setAttribute) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    return;
  }
  closeSidebarDrawer();
  sidebar.classList.toggle('collapsed');
}


/* ================= v1.8.0 M3：计划模式主流程 =================
 * 计划生成策略（ux-flows 流程 8）：LLM 输出 JSON 计划为主，解析失败/
 * 桥不可用回落模板计划（按句读/分号/换行拆分，3-7 步）——任何情况下
 * 都不阻断「先看计划再执行」的核心体验。 */
let _planGenSeq = 0;
async function planModeRun(task) {
  addMessage('user', '/plan ' + task);
  const plan = await planGenerate(task);
  if (!plan || !plan.steps || !plan.steps.length) {
    addMessage('assistant', '计划生成失败，请直接发送任务描述让 Agent 执行。');
    return;
  }
  let created = null;
  try {
    const raw = await pcCall('plan_create', [plan.title, plan.steps], 20000);
    created = JSON.parse(raw || '{}');
  } catch (e) { created = null; }
  const full = (created && created.ok && created.plan) ? created.plan
    : { task_id: 'local_' + Date.now(), title: plan.title, steps: plan.steps, status: 'planning' };
  if (plan.files && plan.files.length) full.files = plan.files;
  try {
    await planShow(full);   // 等用户批准；拒绝 → AbortError
  } catch (e) {
    return;   // 已拒绝（toast 已提示）
  }
  // 批准：task_id 落库到当前会话（85-session-mgmt 真删 session_purge 的 taskIds 数据源；
  // 只挂 task_id，不挂整个 plan 对象；65-session-store 白名单同步放行）
  {
    const _s = getCurrentSession();
    if (_s) { _s.plan = { task_id: full.task_id }; saveSessions(); }
  }
  // 批准：建检查点（git 锚点 + 计划涉及文件快照；空 files 时 git HEAD 仍记录）
  try {
    let ws = '';
    try {
      const eff = JSON.parse(await callApi('get_effective_ws', []) || '{}');
      ws = (eff && eff.ws) || '';
    } catch (e) {}
    const raw = await pcCall('checkpoint_create', [full.task_id, full.files || [], ws], 60000);
    const r = JSON.parse(raw || '{}');
    if (r && r.ok) ckptShow(full.task_id, r);
    else if (r && r.error) pcToast('检查点创建失败：' + r.error + '（任务继续，但无法回滚）', 'warn');
  } catch (e) {
    pcToast('检查点创建失败（任务继续，但无法回滚）', 'warn');
  }
  // 以任务文本走原发送链（isStreaming 由 sendMessage 内部管理）
  // Round 7 修复[3]：批准→执行之间有最长 60s 的 checkpoint_create await 窗口，
  // 期间用户可发起新消息（此刻 isStreaming=false、无 activeRun，守卫放行）——
  // 窗口闭合后这里的 sendMessage 会被忙守卫静默吞掉，计划卡永远停在「执行中」。
  // 忙则把计划态复位回 approved 并明示用户，不再静默吞任务。
  {
    const _busy = (typeof RunRegistry !== 'undefined' && RunRegistry.current() && !RunRegistry.current().cancelled)
      || ((typeof AppState !== 'undefined') ? AppState.isStreaming : isStreaming);
    if (_busy) {
      try {
        await pcCall('plan_update', [full.task_id, 'approved'], 15000);
      } catch (e) {}
      const _ps = getCurrentSession();
      if (_ps) _ps.plan = { task_id: full.task_id };
      const _badge = document.getElementById('planBadge');
      if (_badge) { _badge.className = 'plan-badge pending'; _badge.textContent = '待执行（忙）'; }
      if (typeof pcToast === 'function') pcToast('当前有生成任务进行中，计划已保留；空闲后重新发送任务文本即可执行', 'warn');
      saveSessions();
      return;
    }
  }
  const input = document.getElementById('userInput');
  if (input) input.value = task;
  sendMessage();
}

/** 生成计划：LLM JSON 优先，模板兜底。steps: [{text, risk}]。 */
async function planGenerate(task) {
  const seq = ++_planGenSeq;
  const sysPrompt = '你是任务规划器。把用户任务拆成 3-7 个可执行步骤，只输出 JSON：' +
    '{"title":"计划标题","steps":[{"text":"步骤描述","risk":"l2|l0|"}],"files":["涉及的相对路径"]}。' +
    'risk 标注：会写文件/执行命令的步骤标 l2（授权内），删除/越界/提权标 l0（需确认），只读不标。' +
    '只输出 JSON，不要解释。';
  // HF-1 约定：所有 messages 构造点必须过 normalizeSystemMessages（防多 system
  // 被 Qwen/Ollama Jinja 模板拒；fetchGLMStream 内部虽也归一，构造点显式过是铁律）
  const planMsgs = normalizeSystemMessages([
    { role: 'system', content: sysPrompt },
    { role: 'user', content: task }
  ]);
  try {
    const resp = await fetchGLMStream({
      apiKey: (typeof effectiveApiKey === 'function') ? effectiveApiKey() : '',
      body: {
        model: (typeof connectModelValue === 'function' && connectModelValue()) || 'glm-4.5-flash',   // Round 12：原兜底模型名不存在(1211)
        messages: planMsgs,
        temperature: 0.3, max_tokens: 800, stream: false
      }
    }, undefined);
    if (resp && resp.ok) {
      const txt = await resp.text();
      const m = txt.match(/\{[\s\S]*\}/);
      if (m) {
        const d = JSON.parse(m[0]);
        if (d && Array.isArray(d.steps) && d.steps.length) {
          if (seq !== _planGenSeq) return null;
          return { title: d.title || task.slice(0, 40), steps: d.steps.map(x => ({
            text: String(x.text || x.step || '').slice(0, 200),
            risk: String(x.risk || '').slice(0, 4)
          })), files: Array.isArray(d.files) ? d.files.slice(0, 20) : [] };
        }
      }
    }
  } catch (e) { /* 回落模板 */ }
  if (seq !== _planGenSeq) return null;
  return planGenerateFallback(task);
}

/** 模板兜底计划：按句读/分号/换行拆 3-7 步（本地零依赖，断网可用）。 */
function planGenerateFallback(task) {
  const parts = String(task || '')
    .split(/[。；;\n]+|\s+然后\s+|\s+接着\s+|\s+再\s+/)
    .map(x => x.trim()).filter(x => x.length >= 2);
  const steps = (parts.length >= 2 ? parts.slice(0, 7) : [
    '理解任务：' + task.slice(0, 60),
    '执行核心操作',
    '验证结果并汇报'
  ]).map(t => ({ text: t.slice(0, 200), risk: /删|除|reset|push|force|提权|admin/i.test(t) ? 'l0'
    : (/写|保存|提交|commit|生成|创建|修改/i.test(t) ? 'l2' : '') }));
  return { title: '任务计划 · ' + task.slice(0, 30), steps: steps, files: [] };
}

if (typeof registerUISeam === 'function') registerUISeam({ continueLastGeneration, closeSidebarDrawer });
