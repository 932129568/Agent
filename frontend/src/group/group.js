/* ================= 群聊协作（Beta, 2026-11-04 主理人立项） =================
 * 群主配置 N 个大模型成员（各自模型+身份），指定主持人；成员独立上下文，
 * 靠【交接文档】接力完成共同任务。设计裁剪（去无效设计）：
 * - 不做每成员独立端点覆盖：分工靠同端点下不同模型即可，少一层配置面
 * - 不做图片生成：对话模型不产图，UI 成员产出结构化设计描述/HTML 由前端实现
 * - 不做手动模式开关：「暂停接力」按钮本身就是手动语义，冗余开关删除
 * - 交接零解析依赖：模型按提示词约定输出【交接文档】小节，前端把上一条
 *   消息全文原样注入下一位（解析失败也无损——全文即交接）
 * 上下文口径（成员隔离）：群主任务原文 + 指名给自己的消息 + 交接给自己的
 *   文档 + 自己的历史（尾部截断）；绝不注入其他成员的中间产出全文。 */

const GROUP_LIMITS = Object.freeze({
  membersMin: 2, membersMax: 6,
  turnBudget: 24,          // 单任务发言轮数上限（防无限接力），到顶自动暂停
  memberHistoryTurns: 12,  // 每成员上下文保留的最近消息条数
  memberMsgChars: 4000,    // 单条注入消息截断
});

function groupSessionOf(sid) {
  const s = (typeof sessions !== 'undefined' && Array.isArray(sessions))
    ? sessions.find(x => x.id === sid) : null;
  return (s && s.group && Array.isArray(s.group.members)) ? s : null;
}

/* ---------- 配置向导 ---------- */

const GROUP_PRESET_TEAM = [
  { name: '主持人', model: '', role: '你是群聊主持人，负责理解群主目标、拆解任务并下发。你的每次输出必须以【交接文档】小节收尾，格式：\n【交接文档】\n- 交接给: <成员名>\n- 本次产出: <规划摘要>\n- 对<成员名>的要求: <具体任务与验收标准>\n- 风险与注意: <可空>\n只规划与分配，不代替其他成员产出具体内容。' },
  { name: 'UI设计', model: '', role: '你是 UI 设计师。产出界面结构、布局说明、配色与关键元素描述，必要时给出 HTML/CSS 结构草稿供前端直接实现。输出以【交接文档】小节收尾：\n【交接文档】\n- 交接给: 前端\n- 本次产出: <设计要点>\n- 对前端的实现要求: <明确清单>\n- 风险与注意: <可空>' },
  { name: '前端', model: '', role: '你是前端工程师。依据 UI 设计与交接文档实现代码（完整可用的 HTML/CSS/JS），不臆造设计细节，缺失信息在【交接文档】的「风险与注意」里列出。输出以【交接文档】小节收尾。' },
  { name: '后端', model: '', role: '你是后端工程师。产出接口设计、数据结构与实现代码，与前端约定字段命名。输出以【交接文档】小节收尾。' },
  { name: '测试', model: '', role: '你是测试工程师。对其他成员产出做验收：列出测试点、发现问题、给出修复建议并指名交接给对应成员。输出以【交接文档】小节收尾。' },
];

function groupWizardOpen() {
  let w = document.getElementById('groupWizard');
  if (w) { w.classList.add('show'); return; }
  w = document.createElement('div');
  w.id = 'groupWizard';
  w.className = 'gw-mask';
  w.innerHTML = `
    <div class="gw-win" role="dialog" aria-label="群聊协作配置">
      <div class="gw-head"><b>群聊协作 <span class="gw-beta">Beta</span></b>
        <button type="button" class="icon-btn" onclick="groupWizardClose()" aria-label="关闭">✕</button></div>
      <div class="gw-sub">为每个成员选择模型并定义身份；主持人负责规划与下发，成员靠交接文档接力。成员上下文彼此独立。</div>
      <div class="gw-mates" id="gwMates"></div>
      <div class="gw-foot">
        <button type="button" class="modal-btn" onclick="groupPresetFill()">填入软件开发团队预设</button>
        <button type="button" class="modal-btn" onclick="groupMemberAdd()">＋ 添加成员</button>
        <span style="flex:1"></span>
        <button type="button" class="modal-btn" onclick="groupWizardClose()">取消</button>
        <button type="button" class="modal-btn primary" id="gwCreate" onclick="groupCreate()">创建群聊</button>
      </div>
    </div>`;
  document.body.appendChild(w);
  groupPresetFill();
}

function groupWizardClose() {
  const w = document.getElementById('groupWizard');
  if (w) w.classList.remove('show');
}

function groupMemberRow(m, idx) {
  const sel = (typeof document !== 'undefined') ? document.getElementById('modelSelect') : null;
  let opts = '<option value="">（用当前模型）</option>';
  if (sel) {
    for (const o of sel.options) {
      const v = o.value || '';
      if (!v || v === '__group__' || v === '__manual__') continue;
      opts += '<option value="' + v.replace(/"/g, '&quot;') + '"' + (v === m.model ? ' selected' : '') + '>' +
        v.replace(/</g, '&lt;') + '</option>';
    }
  }
  return '<div class="gw-mate" data-idx="' + idx + '">' +
    '<div class="gw-mate-head">' +
      '<span class="gw-ava">' + (idx + 1) + '号</span>' +
      '<input class="gw-name" value="' + String(m.name || '').replace(/"/g, '&quot;') + '" placeholder="成员名" maxlength="12">' +
      '<label class="gw-host"><input type="radio" name="gwHost" ' + (m.host ? 'checked' : '') + '>主持人</label>' +
      '<button type="button" class="gw-del" title="移除成员" onclick="groupMemberDel(' + idx + ')">✕</button>' +
    '</div>' +
    '<div class="gw-mate-row"><span class="gw-lab">模型</span><select class="gw-model">' + opts + '</select></div>' +
    '<div class="gw-mate-row"><span class="gw-lab">身份</span><textarea class="gw-role" rows="3" ' +
      'placeholder="该成员的职责与输出约定（建议要求以【交接文档】小节收尾）">' + String(m.role || '').replace(/</g, '&lt;') + '</textarea></div>' +
  '</div>';
}

function groupPresetFill() {
  const box = document.getElementById('gwMates');
  if (!box) return;
  box.innerHTML = GROUP_PRESET_TEAM.map((m, i) => groupMemberRow(Object.assign({ host: i === 0 }, m), i)).join('');
}

function groupMemberAdd() {
  const box = document.getElementById('gwMates');
  if (!box) return;
  if (box.children.length >= GROUP_LIMITS.membersMax) {
    if (typeof toast === 'function') toast('群聊最多 ' + GROUP_LIMITS.membersMax + ' 名成员', 'warn');
    return;
  }
  box.insertAdjacentHTML('beforeend', groupMemberRow({ name: '', model: '', role: '', host: false }, box.children.length));
}

function groupMemberDel(idx) {
  const box = document.getElementById('gwMates');
  if (!box) return;
  if (box.children.length <= GROUP_LIMITS.membersMin) {
    if (typeof toast === 'function') toast('群聊至少保留 ' + GROUP_LIMITS.membersMin + ' 名成员', 'warn');
    return;
  }
  box.children[idx].remove();
  [...box.children].forEach((r, i) => r.setAttribute('data-idx', String(i)));
}

function groupCreate() {
  const box = document.getElementById('gwMates');
  if (!box) return;
  const members = [];
  for (const row of box.children) {
    const name = (row.querySelector('.gw-name') || {}).value || '';
    const model = (row.querySelector('.gw-model') || {}).value || '';
    const role = (row.querySelector('.gw-role') || {}).value || '';
    const host = !!(row.querySelector('.gw-host input') || {}).checked;
    if (!String(name).trim()) { if (typeof toast === 'function') toast('有成员没有名字', 'warn'); return; }
    members.push({ id: 'm' + (members.length + 1), name: String(name).trim().slice(0, 12),
      model: String(model).trim(), role: String(role).slice(0, 2000), host });
  }
  if (members.length < GROUP_LIMITS.membersMin) {
    if (typeof toast === 'function') toast('至少需要 ' + GROUP_LIMITS.membersMin + ' 名成员', 'warn');
    return;
  }
  if (!members.some(m => m.host)) {
    if (typeof toast === 'function') toast('请指定一名主持人', 'warn');
    return;
  }
  // 创建群聊会话（复用会话存储链；group 顶层字段进 normalizeSessions 白名单）。
  // ensureSession 只保证存在不返回引用（send.js 同款用法）→ 再取当前会话。
  if (typeof ensureSession === 'function') { try { ensureSession(); } catch (e) {} }
  const sidNow = (typeof AppState !== 'undefined') ? AppState.currentSessionId : currentSessionId;
  const s = (typeof sessions !== 'undefined' && Array.isArray(sessions))
    ? sessions.find(x => x.id === sidNow) : null;
  if (!s) { if (typeof toast === 'function') toast('会话创建失败', 'err'); return; }
  s.title = '👥 ' + members.map(m => m.name).join('·').slice(0, 40);
  s.group = {
    members,
    turn: members.find(m => m.host).id,
    phase: 'idle',            // idle | running | paused
    round: 0,
    autoRelay: true,
  };
  try { if (typeof saveSessions === 'function') saveSessions(); } catch (e) {}
  groupWizardClose();
  if (typeof _setNewChatScreenVisible === 'function') _setNewChatScreenVisible(false);
  if (typeof renderChatHistory === 'function') renderChatHistory(s);
  groupToolbarRender(s);
  const input = document.getElementById('userInput');
  if (input && input.focus) input.focus();
  if (typeof toast === 'function') toast('群聊已创建：以群主身份发送任务，主持人会开始规划分工', 'ok', { stay: true });
}

/* ---------- 群工具条 ---------- */

function groupToolbarRender(s) {
  const old = document.getElementById('groupToolbar');
  if (old) old.remove();
  if (!s || !s.group) return;
  const g = s.group;
  const bar = document.createElement('div');
  bar.id = 'groupToolbar';
  bar.className = 'group-bar';
  const chips = g.members.map(m => {
    const on = m.id === g.turn;
    return '<button type="button" class="gb-chip' + (on ? ' on' : '') + (m.host ? ' host' : '') +
      '" data-mid="' + m.id + '" title="' + (on ? '等待该成员发言' : '点击 @ 该成员') + '">' +
      (m.host ? '★ ' : '') + m.name + (on ? ' ✍' : '') + '</button>';
  }).join('');
  bar.innerHTML =
    '<div class="gb-row">' +
      '<span class="gb-title">👥 群聊 <span class="gb-beta">Beta</span></span>' + chips +
      '<span style="flex:1"></span>' +
      '<span class="gb-phase" id="gbPhase">' + (g.phase === 'running' ? '接力中 · 第 ' + (g.round || 0) + ' 轮' : g.phase === 'paused' ? '已暂停（第 ' + (g.round || 0) + ' 轮）' : '待群主下发任务') + '</span>' +
      '<button type="button" class="modal-btn" id="gbPause" onclick="groupToggleRelay()">' +
        (g.phase === 'running' ? '⏸ 暂停接力' : '▶ 继续接力') + '</button>' +
    '</div>';
  const anchor = document.getElementById('chatContainer');
  if (anchor) anchor.insertBefore(bar, anchor.firstChild);
  bar.querySelectorAll('.gb-chip').forEach(ch => {
    ch.addEventListener('click', () => {
      const m = g.members.find(x => x.id === ch.getAttribute('data-mid'));
      const input = document.getElementById('userInput');
      if (m && input) {
        input.value = '@' + m.name + ' ' + (input.value || '');
        if (input.focus) input.focus();
      }
    });
  });
}

function groupToolbarRefresh(sid) {
  const s = groupSessionOf(sid || ((typeof AppState !== 'undefined') ? AppState.currentSessionId : currentSessionId));
  groupToolbarRender(s);
}

function groupToggleRelay() {
  const sid = (typeof AppState !== 'undefined') ? AppState.currentSessionId : currentSessionId;
  const s = groupSessionOf(sid);
  if (!s) return;
  if (s.group.phase === 'running') {
    s.group.phase = 'paused';
    // Round 8 自审修复：暂停必须真的中断在途请求——groupAbort 是模块级单例，
    // abort 后 renew（下一位成员调用用新 controller）。原先只有暂停语义、
    // 请求照跑，暂停按钮形同虚设。
    try { groupAbort.controller.abort(); } catch (e) {}
    groupAbort.controller = new AbortController();
    if (typeof toast === 'function') toast('接力已暂停（在途请求已中断）；群主可插话，点「继续接力」恢复', 'info');
  } else if (s.group.phase === 'paused') {
    s.group.phase = 'running';
    if (typeof toast === 'function') toast('接力已恢复，下一位：' + groupMemberName(s, s.group.turn), 'info');
    void groupAdvance(sid);
  } else {
    if (typeof toast === 'function') toast('当前空闲：发送任务后自动开始接力', 'info');
  }
  groupToolbarRefresh(sid);
  try { if (typeof saveSessions === 'function') saveSessions(); } catch (e) {}
}

function groupMemberName(s, mid) {
  const m = (s.group.members || []).find(x => x.id === mid);
  return m ? m.name : (mid || '?');
}

/* ---------- 消息发送接管 ---------- */

/** sendMessage 前置拦截（send.js 在 group 会话调用本函数；返回 true=已接管）。 */
async function groupHandleOutgoing(text) {
  const sid = (typeof AppState !== 'undefined') ? AppState.currentSessionId : currentSessionId;
  const s = groupSessionOf(sid);
  if (!s) return false;
  const g = s.group;
  const trimmed = String(text || '').trim();
  if (!trimmed) return true;
  // 群主消息入流（member=null）
  groupPush(s, 'user', trimmed, null);
  // @路由：显式点名 → 该成员；否则主持人
  const at = /^@(\S+)\s*/.exec(trimmed);
  let target = g.members.find(m => m.host) || g.members[0];
  if (at) {
    const named = g.members.find(m => m.name === at[1]);
    if (named) target = named;
  }
  g.turn = target.id;
  g.phase = 'running';
  g.round = 0;
  groupToolbarRefresh(sid);
  try { if (typeof saveSessions === 'function') saveSessions(); } catch (e) {}
  await groupSpeak(s, target);
  return true;
}

function groupPush(s, role, text, member) {
  const msg = { role, content: String(text || '') };
  if (member) msg.member = { id: member.id, name: member.name, host: !!member.host };
  s.messages.push(msg);
  s.updatedAt = Date.now();
  const box = document.getElementById('chatContainer');
  if (box && (typeof AppState === 'undefined' || AppState.currentSessionId === s.id)) {
    const label = member ? (member.host ? '★' : '') + member.name : '群主';
    const el = (typeof addMessage === 'function') ? addMessage(role, (role === 'assistant' ? '' : '') + text, {}) : null;
    if (el) {
      const tag = document.createElement('div');
      tag.className = 'group-msg-tag' + (member ? '' : ' owner') + (msg.member && msg.member.host ? ' host' : '');
      tag.textContent = label + ' · ' + (member ? (member.id) : '群主');
      el.insertBefore(tag, el.firstChild);
      if (role === 'assistant') el.classList.add('group-msg');
    }
    try { box.scrollTop = box.scrollHeight; } catch (e) {}
  }
  return msg;
}

/** 恢复接力入口：从当前 turn 的成员继续（groupToggleRelay 的「继续」分支）。 */
async function groupAdvance(sid) {
  const s = groupSessionOf(sid);
  if (!s || !s.group || s.group.phase !== 'running') return;
  const m = s.group.members.find(x => x.id === s.group.turn);
  if (m) await groupSpeak(s, m);
}

/** 成员发言：构建隔离上下文 → 调模型 → 入流 → 接力调度。 */
async function groupSpeak(s, member) {
  const g = s.group;
  if (g.round >= GROUP_LIMITS.turnBudget) {
    g.phase = 'paused';
    groupPush(s, 'assistant', '【群聊调度】已连续 ' + GROUP_LIMITS.turnBudget + ' 轮，自动暂停。请群主检视后继续。', null);
    groupToolbarRefresh(s.id);
    try { if (typeof saveSessions === 'function') saveSessions(); } catch (e) {}
    return;
  }
  const phase = document.getElementById('gbPhase');
  if (phase) phase.textContent = member.name + ' 正在发言…';
  const messages = groupContextFor(s, member);
  let text = '';
  try {
    text = await groupCallModel(s, member, messages, (delta) => {
      // 轻量流式：只更新相位文本，避免逐帧重排整条消息（反馈快速 + 不闪）
      if (phase) phase.textContent = member.name + ' 正在发言… ' + String(delta || '').length + ' 字';
    });
  } catch (e) {
    text = '';
    groupPush(s, 'assistant', '【' + member.name + ' 调用失败】' + (e && e.message ? e.message : e) + '；接力暂停，请检查该成员模型配置后点「继续接力」。', null);
    g.phase = 'paused';
    g.turn = member.id;
    groupToolbarRefresh(s.id);
    try { if (typeof saveSessions === 'function') saveSessions(); } catch (e2) {}
    return;
  }
  const trimmedOut = String(text || '').trim() || '（空回复）';
  groupPush(s, 'assistant', trimmedOut, member);
  g.round = (g.round || 0) + 1;
  try { if (typeof saveSessions === 'function') saveSessions(); } catch (e) {}
  // 接力调度：解析「交接给: X」→ 匹配成员；否则回主持人；轮数到顶暂停
  const next = groupNextMember(s, member, trimmedOut);
  if (!next) {
    g.phase = 'paused';
    groupPush(s, 'assistant', '【群聊调度】接力已达上限（' + GROUP_LIMITS.turnBudget + ' 轮），自动暂停交还群主。', null);
    groupToolbarRefresh(s.id);
    try { if (typeof saveSessions === 'function') saveSessions(); } catch (e) {}
    return;
  }
  g.turn = next.id;
  if (g.phase === 'running' && g.autoRelay) {
    groupToolbarRefresh(s.id);
    await groupSpeak(s, next);
  } else {
    g.phase = g.phase === 'running' ? 'running' : g.phase;
    groupToolbarRefresh(s.id);
  }
}

/** 交接路由：优先「交接给: X」匹配（精确名→前缀名两步）；X 是自己 → 回主持人；
 * 解析失败回主持人；主持人发言后无明确交接 → 暂停等群主（规划已出）。 */
function groupNextMember(s, from, out) {
  const g = s.group;
  if (g.round >= GROUP_LIMITS.turnBudget) return null;
  const m = /交接给[:：]\s*([^\n]+)/.exec(String(out || ''));
  if (m) {
    const raw = m[1].replace(/[〈>《「」"'（）()，,。.\s]/g, '');
    if (raw) {
      const hit = g.members.find(x => x.id !== from.id && x.name === raw)
        || g.members.find(x => x.id !== from.id && raw.indexOf(x.name) === 0);
      if (hit) return hit;
    }
  }
  if (from.host) return null;   // 主持人规划完且无明确交接 → 等群主
  return g.members.find(x => x.host) || null;
}

/** 成员隔离上下文。 */
function groupContextFor(s, member) {
  const g = s.group;
  const sys = '你是群聊协作中的成员「' + member.name + '」' + (member.host ? '（主持人）' : '') +
    '。群主是人类的唯一代言人。其他成员的发言你只能通过【交接文档】看到。\n' +
    '输出约定：每次发言以【交接文档】小节收尾，格式：\n【交接文档】\n- 交接给: <成员名>\n- 本次产出: <摘要>\n- 对下一棒的要求: <具体清单>\n- 风险与注意: <可空>\n' +
    (member.role ? '\n你的身份与职责：\n' + member.role : '');
  const msgs = [{ role: 'system', content: sys }];
  // 群主任务原文（第一条 user）
  const firstUser = s.messages.find(m => m.role === 'user' && !m.member);
  if (firstUser) msgs.push({ role: 'user', content: '【群主任务】' + String(firstUser.content).slice(0, GROUP_LIMITS.memberMsgChars) });
  // 交接给自己的文档（最近 2 份）+ 指名给自己的消息
  const forMe = s.messages.filter(m => m.role === 'assistant' && m.member && m.member.id !== member.id &&
    String(m.content).indexOf('交接给') >= 0 &&
    (() => { const mm = /交接给[:：]\s*([^\n]+)/.exec(String(m.content)); return mm && mm[1].indexOf(member.name) >= 0; })());
  for (const h of forMe.slice(-2)) {
    msgs.push({ role: 'user', content: '【来自 ' + h.member.name + ' 的交接文档】\n' + String(h.content).slice(0, GROUP_LIMITS.memberMsgChars) });
  }
  const atMe = s.messages.filter(m => m.role === 'user' && !m.member && s.messages.indexOf(m) > 0);
  for (const a of atMe.slice(-2)) {
    if (a === firstUser) continue;
    msgs.push({ role: 'user', content: '【群主补充】' + String(a.content).slice(0, 1200) });
  }
  // 自己的历史（尾部截断）
  const mine = s.messages.filter(m => m.member && m.member.id === member.id);
  for (const m of mine.slice(-GROUP_LIMITS.memberHistoryTurns)) {
    msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content).slice(0, GROUP_LIMITS.memberMsgChars) });
  }
  if (msgs.length === 1) msgs.push({ role: 'user', content: '【群主任务】（见系统提示）请开始。' });
  return msgs;
}

/** 模型调用：复用 ModelTransport + parseSseStream 主链路；本地端点串行已由
 * 调度天然保证（群聊一次只有一名成员发言），本地附加 keep_alive 减少重载。 */
async function groupCallModel(s, member, messages, onDelta) {
  const snap = (typeof uiEndpointSnapshot === 'function') ? uiEndpointSnapshot() : {};
  const sel = document.getElementById('modelSelect');
  const curModel = sel ? sel.value : '';
  const local = !!(typeof localModeActive === 'function' && localModeActive());
  const body = {
    messages,
    model: member.model || curModel || '',
    stream: true,
    temperature: 0.4,
  };
  if (local) body.keep_alive = '10m';   // Ollama：群聊接力间隙不卸载模型
  const resp = await ModelTransport.stream({
    endpoint: snap.endpoint, apiKey: snap.apiKey, body, local,
    proxyHeaders: (typeof localProxyHeaders === 'function') ? localProxyHeaders() : {},
  }, groupAbort.controller.signal);
  if (!resp || !resp.ok || !resp.body) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 200); } catch (e) {}
    throw new Error('HTTP ' + (resp ? resp.status : '?') + (detail ? ' ' + detail : ''));
  }
  const parsed = await parseSseStream(resp.body, {
    onEvent(json) {
      const d = json && json.choices && json.choices[0] && json.choices[0].delta;
      if (d && d.content && typeof onDelta === 'function') onDelta(d.content);
    },
  });
  return parsed.content || '';
}

const groupAbort = { controller: new AbortController() };

/* ---------- 会话切换/渲染联动 ---------- */

function groupAfterSessionRender(s) {
  // 群聊会话历史重建：给消息补成员标签 + 重建工具条
  if (s && s.group) {
    groupToolbarRender(s);
    const box = document.getElementById('chatContainer');
    if (box) {
      let i = 0;
      box.querySelectorAll('.message').forEach(el => {
        const m = (s.messages || [])[i++];
        if (!m || !m.member) {
          if (m && m.role === 'user' && s.group) {
            const tag = document.createElement('div');
            tag.className = 'group-msg-tag owner';
            tag.textContent = '群主';
            el.insertBefore(tag, el.firstChild);
          }
          return;
        }
        const tag = document.createElement('div');
        tag.className = 'group-msg-tag' + (m.member.host ? ' host' : '');
        tag.textContent = (m.member.host ? '★' : '') + m.member.name + ' · ' + m.member.id;
        el.insertBefore(tag, el.firstChild);
      });
    }
  } else {
    const old = document.getElementById('groupToolbar');
    if (old) old.remove();
  }
}
