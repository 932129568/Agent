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
  // Round 13（2026-11-04 主理人裁定）：取消 24 轮接力上限，改为不限轮数——
  // 群主随时可「暂停接力」，这就是唯一的停手开关。
  memberHistoryTurns: 12,  // 每成员上下文保留的最近消息条数
  memberMsgChars: 4000,    // 单条注入消息截断
  // Round 14（2026-11-04 主理人报障「生成物是纯代码，是不是用不了工具」）：
  // 群聊成员原先直接调模型、不挂工具面——只能把代码贴在正文里。现在每位成员
  // 拥有与主对话同源的完整工具面（受设置里「工具档」约束），单次发言内最多
  // 连续 6 轮工具调用（够读需求→写文件→自检）。
  memberToolRounds: 6,
});

/* 群主（人类）作为一等公民的交接目标：成员 @群主 / 交接给: 群主 时，
 * 系统暂停接力并把问题显式交还给人（原先仅暂停且提示「没有明确交接对象」，
 * 主理人报障：明明说好要问我，实际谁也没问到我）。 */
/* R31：多群并行——busy/paused 标记按会话集合存储。
 * 原 `groupSpeak._busySid` / `_pausedSid` 是单值，第二个群启动会覆盖第一个群的
 * 标记，导致忙闲判定错乱、暂停互相串台。改为 Set 后任意数量群聊互不干扰。 */
const GROUP_BUSY_SIDS = new Set();
const GROUP_PAUSED_SIDS = new Set();

const GROUP_OWNER = Object.freeze({ __owner: true });

/** 清理模型回声的【xx】前缀：成员看到的群聊流里每条都带【名字】标注，
 * 模型常把它当成格式要求抄进自己的正文，于是出现「【主持人】【前端】@群主…」
 * 这种张冠李戴。只剥离开头连续的、且确实是成员名/群主/系统 的标签。 */
function groupStripEcho(text, group) {
  let out = String(text == null ? '' : text);
  const names = new Set(['群主', '系统', '群聊调度']);
  ((group && group.members) || []).forEach(m => { if (m && m.name) names.add(m.name); });
  let guard = 0;
  while (guard++ < 8) {
    const m = /^\s*【([^】]{1,16})】\s*/.exec(out);
    if (!m || !names.has(m[1].trim())) break;
    out = out.slice(m[0].length);
  }
  return out;
}

function groupSessionOf(sid) {
  const s = (typeof sessions !== 'undefined' && Array.isArray(sessions))
    ? sessions.find(x => x.id === sid) : null;
  return (s && s.group && Array.isArray(s.group.members)) ? s : null;
}

/* ---------- 配置向导 ---------- */

const GROUP_PRESET_TEAM = [
  { name: '主持人', model: '', role: '你是群聊主持人，负责理解群主目标、拆解任务并下发。你的每次输出必须以【交接文档】小节收尾，格式：\n【交接文档】\n- 交接给: <成员名>\n- 本次产出: <规划摘要>\n- 对<成员名>的要求: <具体任务与验收标准>\n- 风险与注意: <可空>\n交接文档必须完整（完整说明写全，不许缩写），只规划与分配，不代替其他成员产出具体内容。' },
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
  // Round 15：模型下拉改为「全端点目录」（智谱/DeepSeek/Kimi/… 分组）。
  // 原先只抄设置页当前端点的选项，于是「智谱下只能选智谱模型」。
  let opts;
  if (typeof groupModelSelectOptions === 'function') {
    opts = groupModelSelectOptions(null, m.model);
  } else {
    const sel = (typeof document !== 'undefined') ? document.getElementById('modelSelect') : null;
    opts = '<option value="">（用当前模型）</option>';
    if (sel) {
      for (const o of sel.options) {
        const v = o.value || '';
        if (!v || v === '__group__' || v === '__manual__') continue;
        opts += '<option value="' + v.replace(/"/g, '&quot;') + '"' + (v === m.model ? ' selected' : '') + '>' +
          v.replace(/</g, '&lt;') + '</option>';
      }
    }
  }
  const isCrossEp = String(m.model || '').indexOf('::') >= 0;
  let epKey = '';
  if (isCrossEp && typeof groupMemberEndpoint === 'function') {
    const t = groupMemberEndpoint(null, m);
    epKey = (t && t.ep && t.ep.api_key) || '';
  }
  return '<div class="gw-mate" data-idx="' + idx + '">' +
    '<div class="gw-mate-head">' +
      '<span class="gw-ava">' + (idx + 1) + '号</span>' +
      '<input class="gw-name" value="' + String(m.name || '').replace(/"/g, '&quot;') + '" placeholder="成员名" maxlength="12">' +
      '<label class="gw-host"><input type="radio" name="gwHost" ' + (m.host ? 'checked' : '') + '>主持人</label>' +
      '<button type="button" class="gw-del" title="移除成员" onclick="groupMemberDel(' + idx + ')">✕</button>' +
    '</div>' +
    '<div class="gw-mate-row"><span class="gw-lab">模型</span><select class="gw-model">' + opts + '</select></div>' +
    // 跨端点模型：该端点的 Key 就地补填（只存进群聊端点快照，不写全局配置）
    '<div class="gw-mate-row gw-eprow"' + (isCrossEp ? '' : ' hidden') + '>' +
      '<span class="gw-lab">端点Key</span>' +
      '<input class="gw-epkey" type="password" spellcheck="false" placeholder="跨端点模型需要该端点的 API Key" value="' +
        String(epKey).replace(/"/g, '&quot;') + '">' +
      '<button type="button" class="gw-eptest" title="用该端点+Key+模型发一次测试请求">测试</button>' +
    '</div>' +
    '<div class="gw-mate-row"><span class="gw-lab">身份</span><textarea class="gw-role" rows="3" ' +
      'placeholder="该成员的职责与输出约定（建议要求以【交接文档】小节收尾）">' + String(m.role || '').replace(/</g, '&lt;') + '</textarea></div>' +
  '</div>';
}

function groupPresetFill() {
  const box = document.getElementById('gwMates');
  if (!box) return;
  box.innerHTML = GROUP_PRESET_TEAM.map((m, i) => groupMemberRow(Object.assign({ host: i === 0 }, m), i)).join('');
  groupBindEndpointRows(box);
}

/** 成员行绑定：选到跨端点模型 → 露出「端点Key」输入框。幂等（data-bound 标记）。 */
function groupBindEndpointRows(scope) {
  if (!scope || !scope.querySelectorAll) return;
  scope.querySelectorAll('.gw-mate').forEach(row => {
    const sel = row.querySelector('.gw-model');
    if (!sel || sel.getAttribute('data-bound')) return;
    sel.setAttribute('data-bound', '1');
    const sync = () => {
      // R26：callApi 桥未就绪时「测试端点」不再静默——显式禁用 + 明确 title。
      // 下拉每次变化都会重跑 sync，桥就绪后自动恢复，不留永久禁用态。
      const tb0 = row.querySelector('.gw-eptest');
      if (tb0) {
        const bridgeReady = typeof callApi === 'function';
        tb0.disabled = !bridgeReady;
        tb0.title = bridgeReady ? '用该端点+Key+模型发一次测试请求'
          : '后端桥未就绪，暂时无法测试端点（请等待应用加载完成）';
      }
      const row2 = row.querySelector('.gw-eprow');
      if (!row2) return;
      const cross = String(sel.value || '').indexOf('::') >= 0;
      row2.hidden = !cross;
      if (cross) {
        // 该端点已保存过 Key？有则回填占位提示，避免用户误以为必须重填
        let has = false;
        try {
          const s0 = (typeof AppState !== 'undefined') ? groupSessionOf(AppState.currentSessionId) : null;
          const t = groupModelTarget(sel.value);
          has = !!(t && s0 && s0.group && s0.group.endpoints &&
                   s0.group.endpoints[t.endpointId] && s0.group.endpoints[t.endpointId].api_key);
        } catch (e) {}
        const inp = row2.querySelector('.gw-epkey');
        if (inp) inp.placeholder = has ? '已保存该端点 Key（留空沿用）' : '跨端点模型需要该端点的 API Key';
      }
    };
    sel.addEventListener('change', sync);
    sync();
    // 「测试」按钮：就地验证 端点+Key+模型（跑 test_provider_endpoint）
    const row2 = row.querySelector('.gw-eprow');
    const testBtn = row.querySelector('.gw-eptest');
    if (testBtn && row2 && !testBtn.getAttribute('data-bound')) {
      testBtn.setAttribute('data-bound', '1');
      testBtn.addEventListener('click', async () => {
        // R26：桥未就绪 → 明确提示。原实现直接 await callApi 抛 ReferenceError，
        // 被 catch 吞成泛化「端点测试失败」，用户看不出真因（交接报告遗留 #3）。
        if (typeof callApi !== 'function') {
          if (typeof toast === 'function') toast('后端桥未就绪，无法测试端点；请等待应用加载完成后重试', 'warn');
          return;
        }
        const model = String(sel.value || '');
        const i = model.indexOf('::');
        if (i < 0) { if (typeof toast === 'function') toast('当前是当前端点模型，无需单独测试', 'info'); return; }
        const epId = model.slice(0, i), m = model.slice(i + 2);
        const s0 = (typeof AppState !== 'undefined') ? groupSessionOf(AppState.currentSessionId) : null;
        const ep = (s0 && s0.group && s0.group.endpoints && s0.group.endpoints[epId]) || null;
        const key = (row2.querySelector('.gw-epkey') || {}).value || (ep && ep.api_key) || '';
        const base = (ep && ep.base_url) || null;
        if (!base || !key) { if (typeof toast === 'function') toast('先填该端点的 Base URL / API Key', 'warn'); return; }
        const old2 = testBtn.textContent;
        testBtn.textContent = '测试中';
        testBtn.disabled = true;
        try {
          const raw = await callApi('test_provider_endpoint', [base, key, m, 15, false], 25000);
          const r = raw ? JSON.parse(raw) : null;
          if (r && r.ok) {
            if (typeof toast === 'function') toast('端点可用：' + m + (r.reply ? ' · 回复：' + r.reply : ''), 'ok');
          } else if (typeof toast === 'function') toast('端点测试失败：' + ((r && r.error) || '未知错误'), 'err');
        } catch (e) {
          if (typeof toast === 'function') toast('端点测试失败：' + (e && e.message ? e.message : e), 'err');
        } finally {
          testBtn.textContent = old2;
          testBtn.disabled = false;
        }
      });
    }
  });
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

/** 读一行成员配置；跨端点模型顺带把该端点 Key 落进 group.endpoints。 */
function groupReadMemberRow(row, group) {
  const name = ((row.querySelector('.gw-name') || {}).value || '').trim().slice(0, 12);
  const model = ((row.querySelector('.gw-model') || {}).value || '').trim();
  const role = ((row.querySelector('.gw-role') || {}).value || '').slice(0, 2000);
  const host = !!((row.querySelector('.gw-host input') || {}).checked);
  if (group && typeof groupModelTarget === 'function') {
    const t = groupModelTarget(model);
    if (t && typeof groupEnsureEndpoint === 'function') {
      const keyEl = row.querySelector('.gw-epkey');
      const key = keyEl ? String(keyEl.value || '').trim() : '';
      const knownBase = (group.endpoints && group.endpoints[t.endpointId] || {}).base_url;
      let base = knownBase;
      if (!base) {
        let p = null;
        try { p = (typeof PRESETS === 'object' && PRESETS) ? PRESETS[t.endpointId] : null; } catch (e) {}
        base = (p && p.base_url) || '';
      }
      if (key) groupEnsureEndpoint(group, t.endpointId, base, key);
    }
  }
  return { name: name, model: model, role: role, host: host };
}

function groupCreate() {
  const box = document.getElementById('gwMates');
  if (!box) return;
  const members = [];
  for (const row of box.children) {
    const r = groupReadMemberRow(row, null);
    if (!r.name) { if (typeof toast === 'function') toast('有成员没有名字', 'warn'); return; }
    members.push({ id: 'm' + (members.length + 1), name: r.name,
      model: r.model, role: r.role, host: r.host });
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
  // 点名队列预告（Round 15 优化）：群主一次 @ 多人时，工具栏直接展示后续顺序
  const qNames = (Array.isArray(g.mentionQueue) ? g.mentionQueue : [])
    .map(id => g.members.find(m => m.id === id)).filter(Boolean)
    .map(m => m.name);
  const qHint = qNames.length ? ' → ' + qNames.slice(0, 3).map(function (n) {
    return String(n).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }).join('→') + (qNames.length > 3 ? '…' : '') : '';
  const chips = g.members.map(m => {
    const on = m.id === g.turn;
    const chipName = String(m.name || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return '<button type="button" class="gb-chip' + (on ? ' on' : '') + (m.host ? ' host' : '') +
      '" data-mid="' + m.id + '" title="' + (on ? '等待该成员发言' : '点击 @ 该成员') + '">' +
      (m.host ? '★ ' : '') + chipName + (on ? ' ✍' : '') + '</button>';
  }).join('');
  bar.innerHTML =
    '<div class="gb-row">' +
      '<span class="gb-title"><svg class="ui-icon ui-icon-16" aria-hidden="true"><use href="#i-users"/></svg> 群聊 <span class="gb-beta">Beta</span></span>' + chips +
      '<span style="flex:1"></span>' +
      '<span class="gb-phase" id="gbPhase">' + (g.phase === 'running' ? '接力中 · 第 ' + (g.round || 0) + ' 轮' + qHint : g.phase === 'paused' ? '已暂停（第 ' + (g.round || 0) + ' 轮）' + qHint : '待群主下发任务') + '</span>' +
      '<button type="button" class="modal-btn" id="gbFiles" title="群文件：交接文档仓库（可搜索/改目录）"><svg class="ui-icon ui-icon-16" aria-hidden="true"><use href="#i-folder"/></svg> 群文件' +
        ((s.groupFiles && s.groupFiles.length) ? ' ' + s.groupFiles.length : '') + '</button>' +
      '<button type="button" class="modal-btn" id="gbPause" onclick="groupToggleRelay()">' +
        (g.phase === 'running' ? '⏸ 暂停接力' : '▶ 继续接力') + '</button>' +
    '</div>';
  const anchor = document.getElementById('chatContainer');
  if (anchor) anchor.insertBefore(bar, anchor.firstChild);
  const filesBtn = bar.querySelector('#gbFiles');
  if (filesBtn) filesBtn.addEventListener('click', () => groupFilesOpen());
  bar.querySelectorAll('.gb-chip').forEach(ch => {
    groupBindLongPress(ch, () => groupManageOpen());   // 长按成员名 → 群聊管理
    ch.title = '点击 @ 该成员 · 长按打开群聊管理';
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

function groupToggleRelay(sidArg) {
  // R31：可选指定会话（多任务面板/停止按钮可精确暂停后台群）；不传=当前可见会话
  const sid = (typeof sidArg === 'string' && sidArg)
    ? sidArg
    : ((typeof AppState !== 'undefined') ? AppState.currentSessionId : currentSessionId);
  const s = groupSessionOf(sid);
  if (!s) return;
  if (s.group.phase === 'running') {
    s.group.phase = 'paused';
    GROUP_PAUSED_SIDS.add(s.id);   // 在途循环据此立即退出（勿再开下一轮）
    // Round 8 自审修复：暂停必须真的中断在途请求——groupAbort 是模块级单例，
    // abort 后 renew（下一位成员调用用新 controller）。原先只有暂停语义、
    // 请求照跑，暂停按钮形同虚设。
    // R31：只中断本群的请求（原模块级单例会连坐其他并行群）
    try { groupAbortController(s.id).abort(); } catch (e) {}
    groupAbortRenew(s.id);
    if (typeof toast === 'function') toast('接力已暂停（在途请求已中断）；群主可插话，点「继续接力」恢复', 'info');
  } else if (s.group.phase === 'paused') {
    s.group.phase = 'running';
    GROUP_PAUSED_SIDS.delete(s.id);
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

/** sendMessage 前置拦截（send.js 在 group 会话调用本函数；返回 true=已接管）。
 * Round 15：**多目标 @**——原实现只取开头第一个 @，一次 @ 三人只有最后被记成
 * turn 的那位真正发言（主理人报障「一次性@多人时只有最后一个收到」）。现在
 * 取出全部被 @ 成员（去重保序），交给 groupSpeak 内部按 **打字顺序** 逐一发言。
 * Round 15b：**@ 顺序保真**——原先外层循环把第一位交棒后就 break，后续顺序
 * 由成员自己输出里的 @ 路由决定（后 @ 的反而先说话）。现在显式 @ 队列挂在
 * g.mentionQueue，groupSpeak 每轮发言后**先吃队列再走自由路由**；队列耗尽
 * 才恢复成员自由接力。autoRelay 关闭时队列照走（显式点名=群主指令，优先级
 * 高于「自动接力」开关——开关只管模型自己拉链）。 */
async function groupHandleOutgoing(text) {
  const sid = (typeof AppState !== 'undefined') ? AppState.currentSessionId : currentSessionId;
  const s = groupSessionOf(sid);
  if (!s) return false;
  const g = s.group;
  const trimmed = String(text || '').trim();
  if (!trimmed) return true;
  // 群主消息入流（member=null）
  groupPush(s, 'user', trimmed, null);
  // @路由：显式点名（可多个，按出现顺序）→ 依次发言；否则主持人
  const mentioned = (typeof groupMentionTargets === 'function')
    ? groupMentionTargets(trimmed, s) : [];
  const queue = mentioned.length
    ? mentioned.slice()
    : [g.members.find(m => m.host) || g.members[0]];
  g.turn = queue[0].id;
  g.mentionQueue = queue.slice(1).map(m => m.id);   // 余下名单（id 序列，跨重启保留）
  g.phase = 'running';
  g.round = 0;
  groupToolbarRefresh(sid);
  try { if (typeof saveSessions === 'function') saveSessions(); } catch (e) {}
  await groupSpeak(s, queue[0]);
  return true;
}

/** 成员消息 = 折叠工作气泡（2026-11-04 主理人裁定：群里只显示简略内容，
 * 点击气泡看全文）。working 态（呼吸点+实时字数）→ done 态（摘要行+可展开）。 */
function groupHueOf(member) {
  let h = 0;
  const key = String((member && member.id) || '?');
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}

function groupBriefOf(text) {
  const clean = String(text || '').replace(/【交接文档】[\s\S]*$/, '').trim();
  const line = clean.split('\n').map(l => l.trim()).filter(Boolean)[0] || '（查看全文）';
  return line.length > 72 ? line.slice(0, 72) + '…' : line;
}

/** 挂载一个气泡（working/done 共用；历史重建也走这里保持形态一致）。
 * done 态：整卡点击打开**独立详情页**（2026-11-04 主理人裁定：不在会话流里
 * 原位展开）；气泡上的名字长按 500ms 打开群聊管理。 */
function groupBubbleMount(container, member, text, state) {
  const el = document.createElement('div');
  el.className = 'gwb' + (state === 'working' ? ' working' : '') + (member && member.host ? ' host' : '');
  const hue = groupHueOf(member);
  const _nm = member ? String(member.name || '') : '';
  const name = member ? ((member.host ? '★ ' : '') + _nm.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')) : '群主';
  el.innerHTML =
    '<div class="gwb-side"><div class="gwb-ava" style="--hue:' + hue + '">' +
      (member ? String(member.id || '').replace(/^m/, '') : '群') + '</div></div>' +
    '<div class="gwb-main">' +
      '<div class="gwb-head"><span class="gwb-name" title="长按编辑该成员">' + name + '</span>' +
        '<span class="gwb-state">' + (state === 'working' ? '工作中' : '已完成') + '</span></div>' +
      '<div class="gwb-brief">' + (state === 'working'
        ? '<span class="gwb-dots"><i></i><i></i><i></i></span> 正在整理输出…'
        : '') + '</div>' +
      '<div class="gwb-full" hidden></div>' +
      (state === 'done' ? '<div class="gwb-hint">点击查看完整内容</div>' : '') +
    '</div>';
  const briefEl = el.querySelector('.gwb-brief');
  const fullEl = el.querySelector('.gwb-full');
  const nameEl = el.querySelector('.gwb-name');
  if (state !== 'working') briefEl.textContent = groupBriefOf(text);   // done 摘要行
  // 长按名字 → 群聊管理（桌面：按住 500ms；移动/触屏同语义）
  if (nameEl) groupBindLongPress(nameEl, () => groupManageOpen());
  if (state === 'working') {
    el.__setBrief = t => {   // R20 扫描修复：t 来自模型工具名，textContent 装配防注入
      briefEl.innerHTML = '<span class="gwb-dots"><i></i><i></i><i></i></span> ';
      briefEl.appendChild(document.createTextNode(String(t || '').slice(0, 60)));
    };
    el.__finish = (fullText, meta) => {
      el.classList.remove('working');
      el.querySelector('.gwb-state').textContent = '已完成';
      briefEl.textContent = groupBriefOf(fullText);
      const hint = document.createElement('div');
      hint.className = 'gwb-hint';
      hint.textContent = '点击查看完整内容';
      el.querySelector('.gwb-main').appendChild(hint);
      el.classList.add('clickable');
      el.addEventListener('click', () => groupDetailOpen(fullText, member, meta || null));
      el.__setBrief = null;
      el.__finish = null;
    };
  } else {
    el.classList.add('clickable');
    el.__fullText = String(text || '');
    el.addEventListener('click', () => groupDetailOpen(el.__fullText, member, null));
  }
  container.appendChild(el);
  try { container.scrollTop = container.scrollHeight; } catch (e) {}
  return el;
}

/** 长按绑定（500ms；按下期间移动/抬起取消）。 */
function groupBindLongPress(el, fn) {
  if (!el) return;
  let timer = null;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('mousedown', () => { cancel(); timer = setTimeout(() => { timer = null; fn(); }, 500); });
  el.addEventListener('touchstart', () => { cancel(); timer = setTimeout(() => { timer = null; fn(); }, 500); }, { passive: true });
  ['mouseup', 'mouseleave', 'touchend', 'touchcancel', 'mousemove'].forEach(ev =>
    el.addEventListener(ev, cancel));
}

/** 交接文档生成式 UI 化（Round 9 升级点）：气泡展开区的【交接文档】小节
 * 渲染为结构化卡（Callout 语义 + 键值行），零模型调用、纯本地解析。 */
function groupFullHandoffCard(fullEl, text) {
  const m = /【交接文档】\s*\n([\s\S]*)$/.exec(String(text || ''));
  if (!m || !fullEl) return;
  // Round 14：交接文档要求写全，卡片也不能截断（原 slice(0,8)/slice(0,300)
  // 会把「完整说明」砍掉，正是主理人说的「看不清楚」）
  const lines = m[1].split('\n').map(l => l.trim()).filter(Boolean);
  const rows = lines.map(l => {
    const kv = /^[-*•]?\s*([^:：]{1,20})[:：]\s*([\s\S]+)$/.exec(l);
    return kv ? { k: kv[1].trim(), v: kv[2].trim() } : null;
  }).filter(Boolean);
  if (!rows.length) return;
  const card = document.createElement('div');
  card.className = 'gwb-handoff';
  card.innerHTML = '<div class="gwb-handoff-title">📋 交接文档</div>' +
    rows.map(r => '<div class="gwb-handoff-row"><span class="gh-k"></span>' +
      '<span class="gh-v"></span></div>').join('');
  const vs = card.querySelectorAll('.gh-v');
  const ks = card.querySelectorAll('.gh-k');
  rows.forEach((r, i) => {
    const el = vs[i];
    if (/^(前端|后端|UI设计|测试|主持人)$/.test(r.v) || r.k === '交接给') el.classList.add('gh-target');
    el.textContent = r.v;
    if (ks[i]) ks[i].textContent = r.k;   // R20 扫描修复：键名来自模型正文，textContent 装配
  });
  fullEl.appendChild(card);
}

/* ---------- 气泡详情页（独立页面，打开↔返回，2026-11-04 主理人裁定） ---------- */

function groupDetailOpen(text, member, meta) {
  let page = document.getElementById('groupDetail');
  if (page) page.remove();
  const hue = groupHueOf(member);
  page = document.createElement('div');
  page.id = 'groupDetail';
  page.className = 'gd-page';
  page.innerHTML =
    '<div class="gd-head">' +
      '<button type="button" class="gd-back" id="gdBack">‹ 返回群聊</button>' +
      '<div class="gd-id">' +
        '<div class="gwb-ava" style="--hue:' + hue + '">' + (member ? String(member.id || '').replace(/^m/, '') : '群') + '</div>' +
        '<div><div class="gd-name">' + (member ? ((member.host ? '★ ' : '') +
          String(member.name || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')) : '群主') +
          (member && member.host ? ' · 主持人' : '') + '</div>' +
        '<div class="gd-sub">' + (member && member.model ? member.model : (meta && meta.model) || '群聊发言') +
          ' · 第 ' + ((meta && meta.round) || '—') + ' 轮</div></div>' +
      '</div>' +
      '<button type="button" class="gd-copy" id="gdCopy" title="复制全文">⧉ 复制全文</button>' +
    '</div>' +
    '<div class="gd-body"><div class="gd-article"></div></div>';
  const article = page.querySelector('.gd-article');
  article.innerHTML = (typeof renderMd === 'function') ? renderMd(String(text || '')) : '';
  groupFullHandoffCard(article, text);
  document.body.appendChild(page);
  document.body.classList.add('gd-lock');
  void page.offsetWidth;   // 强制 reflow 后再加 show——入场过渡必播（同步可达）
  page.classList.add('show');
  const close = () => {
    page.classList.remove('show');
    document.body.classList.remove('gd-lock');
    setTimeout(() => { try { page.remove(); } catch (e) {} }, 220);
    document.removeEventListener('keydown', onEsc);
  };
  const onEsc = e => { if (e.key === 'Escape') close(); };
  page.querySelector('#gdBack').addEventListener('click', close);
  document.addEventListener('keydown', onEsc);
  page.__close = close;
  const body = page.querySelector('.gd-body');
  if (body) body.scrollTop = 0;
  // 复制全文（主理人高频动作：把成员产出搬去别处）——uiClipboard 优先，
  // 降级 navigator.clipboard，再降级后端 set_clipboard
  const copyBtn = page.querySelector('#gdCopy');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const t = String(text || '');
      let done = false;
      try {
        if (typeof uiClipboard === 'object' && uiClipboard && typeof uiClipboard.write === 'function') {
          await uiClipboard.write(t); done = true;
        } else if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(t); done = true;
        }
      } catch (e) {}
      if (!done && typeof callApi === 'function') {
        try { await callApi('set_clipboard', [t]); done = true; } catch (e) {}
      }
      if (typeof toast === 'function') toast(done ? '已复制全文' : '复制失败', done ? 'ok' : 'err');
      copyBtn.textContent = done ? '✓ 已复制' : '✕ 复制失败';
      setTimeout(() => { copyBtn.textContent = '⧉ 复制全文'; }, 1500);
    });
  }
  return page;
}

/* ---------- 群聊管理（长按成员名打开：改身份/模型/增删成员） ---------- */

function groupManageOpen() {
  const sid = (typeof AppState !== 'undefined') ? AppState.currentSessionId : currentSessionId;
  const s = groupSessionOf(sid);
  if (!s) { if (typeof toast === 'function') toast('请在群聊会话中操作', 'info'); return; }
  let mask = document.getElementById('groupManage');
  if (mask) mask.remove();
  mask = document.createElement('div');
  mask.id = 'groupManage';
  mask.className = 'gw-mask show';
  mask.innerHTML =
    '<div class="gw-win gm-win" role="dialog" aria-label="群聊管理">' +
      '<div class="gw-head"><b>群聊管理</b>' +
        '<button type="button" class="icon-btn" id="gmClose" aria-label="关闭">✕</button></div>' +
      '<div class="gw-sub">长按聊天里的成员名随时回到这里。修改身份或模型后，下一位成员发言即生效。</div>' +
      '<div class="gw-mates" id="gmMates"></div>' +
      '<div class="gw-foot">' +
        '<button type="button" class="modal-btn" id="gmAdd">＋ 添加成员</button>' +
        '<span style="flex:1"></span>' +
        '<button type="button" class="modal-btn" id="gmCancel">取消</button>' +
        '<button type="button" class="modal-btn primary" id="gmSave">保存</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(mask);
  const box = mask.querySelector('#gmMates');
  // DOM → members 同步（编辑期间任何重绘前必须先收值，否则丢用户输入——
  // Round 11 实证：先改名字再点添加，重绘把名字重置、保存被空名拦截）
  const syncDomToMembers = () => {
    const rows = [...box.querySelectorAll('.gw-mate')];
    for (let i = 0; i < rows.length && i < s.group.members.length; i++) {
      const r = groupReadMemberRow(rows[i], s.group);
      s.group.members[i].name = r.name;
      s.group.members[i].model = r.model;
      s.group.members[i].role = r.role;
      s.group.members[i].host = r.host;
    }
    if (typeof groupHydrateEndpoints === 'function') groupHydrateEndpoints(s.group);
  };
  const render = () => {
    box.innerHTML = s.group.members.map(m => groupMemberRow(
      { name: m.name, model: m.model, role: m.role, host: m.host }, s.group.members.indexOf(m))).join('');
    groupBindEndpointRows(box);
    box.querySelectorAll('.gw-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.closest('.gw-mate').getAttribute('data-idx'));
        if (s.group.members.length <= GROUP_LIMITS.membersMin) {
          if (typeof toast === 'function') toast('群聊至少保留 ' + GROUP_LIMITS.membersMin + ' 名成员', 'warn');
          return;
        }
        syncDomToMembers();
        s.group.members.splice(idx, 1);
        s.group.members.forEach((m, i) => { m.id = 'm' + (i + 1); });
        if (!s.group.members.some(m => m.host) && s.group.members[0]) s.group.members[0].host = true;
        if (!s.group.members.find(m => m.id === s.group.turn)) {
          s.group.turn = (s.group.members.find(m => m.host) || s.group.members[0]).id;
        }
        render();
      });
    });
  };
  render();
  const onGmEsc = e => {
    if (e.key !== 'Escape') return;
    gmCloseFn();
  };
  const gmCloseFn = () => {
    document.removeEventListener('keydown', onGmEsc);
    if (mask.parentNode) mask.remove();
  };
  document.addEventListener('keydown', onGmEsc);
  mask.querySelector('#gmClose').addEventListener('click', gmCloseFn);
  mask.querySelector('#gmCancel').addEventListener('click', gmCloseFn);
  mask.querySelector('#gmAdd').addEventListener('click', () => {
    if (s.group.members.length >= GROUP_LIMITS.membersMax) {
      if (typeof toast === 'function') toast('群聊最多 ' + GROUP_LIMITS.membersMax + ' 名成员', 'warn');
      return;
    }
    syncDomToMembers();   // 先收当前编辑值再增行，防重绘丢输入
    s.group.members.push({ id: 'm' + (s.group.members.length + 1), name: '', model: '', role: '', host: false });
    render();
  });
  mask.querySelector('#gmSave').addEventListener('click', () => {
    const rows = [...box.querySelectorAll('.gw-mate')];
    const next = [];
    for (const row of rows) {
      const name = ((row.querySelector('.gw-name') || {}).value || '').trim();
      const model = ((row.querySelector('.gw-model') || {}).value || '').trim();
      const role = ((row.querySelector('.gw-role') || {}).value || '').slice(0, 2000);
      const host = !!((row.querySelector('.gw-host input') || {}).checked);
      if (!name) { if (typeof toast === 'function') toast('有成员没有名字', 'warn'); return; }
      next.push({ id: 'm' + (next.length + 1), name: name.slice(0, 12), model, role, host });
    }
    if (next.length < GROUP_LIMITS.membersMin) {
      if (typeof toast === 'function') toast('至少需要 ' + GROUP_LIMITS.membersMin + ' 名成员', 'warn');
      return;
    }
    if (!next.some(m => m.host)) { if (typeof toast === 'function') toast('请指定一名主持人', 'warn'); return; }
    s.group.members = next;
    if (!next.find(m => m.id === s.group.turn)) s.group.turn = (next.find(m => m.host) || next[0]).id;
    try { if (typeof saveSessions === 'function') saveSessions(); } catch (e) {}
    gmCloseFn();
    groupToolbarRefresh(sid);
    if (typeof toast === 'function') toast('群聊配置已保存', 'ok');
  });
}

function groupPush(s, role, text, member, opts) {
  const isSys = !!(opts && opts.system);
  const msg = { role, content: String(text || '') };
  if (member) msg.member = { id: member.id, name: member.name, host: !!member.host };
  // system：调度/系统提示。必须与「群主说的话」区分开——原先 member=null 一律按
  // 群主渲染，于是「接力已达上限」这类系统消息看起来像群主自己发的，模型也会
  // 在上下文里收到【群主】前缀，误以为是人类指令（主理人报障：不是群主的标群主）。
  if (isSys) msg.system = true;
  s.messages.push(msg);
  s.updatedAt = Date.now();
  // skipDom：气泡已由 groupSpeak 的 working→finish 生命周期承担消息本体，
  // 这里只入存储，避免双气泡（完成态气泡即消息）。
  if (!(opts && opts.skipDom)) {
    const box = document.getElementById('chatContainer');
    if (box && (typeof AppState === 'undefined' || AppState.currentSessionId === s.id)) {
      if (member) {
        groupBubbleMount(box, member, String(text || ''), 'done');
      } else {
        const el = (typeof addMessage === 'function') ? addMessage(role, text, {}) : null;
        if (el) {
          const tag = document.createElement('div');
          tag.className = 'group-msg-tag ' + (isSys ? 'sys' : 'owner');
          tag.textContent = isSys ? '调度' : '群主';
          el.insertBefore(tag, el.firstChild);
        }
      }
      try { box.scrollTop = box.scrollHeight; } catch (e) {}
    }
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

/** 成员发言：工作气泡（简略态）→ 调模型（气泡内实时计数）→ 转完成态（可展开）
 * → 接力调度。群里永不直接铺全文（主理人 2026-11-04 裁定）。
 * Round 13：取消轮数上限。接力改为**迭代**而非递归——不限轮数后递归会持续
 * 加深调用栈（几百轮即 RangeError），循环只占常量栈。群主随时可暂停。 */
async function groupSpeak(s, member) {
  const g = s.group;
  if (!g) return;
  // 同一会话已有在途循环（继续接力/插话都会触发）→ 交给那个循环接手，避免并发双接力。
  // R31：按会话集合判定——不同群可同时各跑各的循环。
  if (GROUP_BUSY_SIDS.has(s.id)) return;
  GROUP_BUSY_SIDS.add(s.id);
  GROUP_PAUSED_SIDS.delete(s.id);   // 新发起的一轮不受旧暂停标志影响
  // R31：群聊 run 登记进统一注册表——多任务面板/历史页「进行中」可感知；
  // kind='group' 使单聊发送键/流式条不被群聊接管（群有自己的工具栏）。
  let _groupRun = null;
  if (typeof RunRegistry !== 'undefined') {
    _groupRun = RunRegistry.start(s);
    _groupRun.kind = 'group';
    _groupRun.parallel = true;
    _groupRun.startedAt = Date.now();
    _groupRun.stopHandler = () => { try { groupToggleRelay(s.id); } catch (e) {} };
  }
  try {
    let current = member;
    while (current) {
    if (g.phase !== 'running' || GROUP_PAUSED_SIDS.has(s.id)) return;   // 群主暂停/群被关闭
    const phase = document.getElementById('gbPhase');
    if (phase) phase.textContent = current.name + ' 工作中…';
    const box = document.getElementById('chatContainer');
    let bubble = null;
    if (box && (typeof AppState === 'undefined' || AppState.currentSessionId === s.id)) {
      bubble = groupBubbleMount(box, current, '', 'working');
    }
    const tick = (n) => {
      if (bubble && bubble.__setBrief) bubble.__setBrief('正在输出… ' + n + ' 字');
    };
    const messages = groupContextFor(s, current);
    let text = '';
    let toolSteps = 0;
    let acc = 0;   // R20 扫描修复：模块级 _acc 被并行群会话共享，改为本次调用局部
    try {
      text = await groupCallModel(s, current, messages, (delta) => {
        acc += String(delta || '').length;
        tick(acc);
      }, (name) => {
        toolSteps++;
        if (bubble && bubble.__setBrief) bubble.__setBrief('调用工具 ' + name + '（第 ' + toolSteps + ' 次）');
      });
    } catch (e) {
      text = '';
      if (bubble && bubble.__finish) bubble.__finish('【' + current.name + ' 调用失败】' + (e && e.message ? e.message : e));
      else groupPush(s, 'assistant', '【' + current.name + ' 调用失败】' + (e && e.message ? e.message : e) + '；接力暂停。', null);
      g.phase = 'paused';
      g.turn = current.id;
      groupToolbarRefresh(s.id);
      try { if (typeof saveSessions === 'function') saveSessions(); } catch (e2) {}
      return;
    }
    const trimmedOut = groupStripEcho(String(text || '').trim(), g) || '（空回复）';
    if (bubble && bubble.__finish) {
      bubble.__finish(trimmedOut, { round: (g.round || 0) + 1 });
      groupPush(s, 'assistant', trimmedOut, current, { skipDom: true });   // 气泡即消息本体
    } else {
      groupPush(s, 'assistant', trimmedOut, current);
    }
    g.round = (g.round || 0) + 1;
    // 群文件归档：每轮交接文档一条，失败不阻断接力（正文仍在会话流里）
    if (typeof groupArchiveHandoff === 'function') {
      try { await groupArchiveHandoff(s, current, trimmedOut, g.round); } catch (e) {}
    }
    try { if (typeof saveSessions === 'function') saveSessions(); } catch (e) {}
    // 接力调度（Round 15b）：显式 @ 队列优先——群主点名顺序就是发言顺序，
    // 队列耗尽后才交给成员自由路由（模型输出里的 @/交接）。
    const viaQueue = Array.isArray(g.mentionQueue) && g.mentionQueue.length > 0;
    const queuedId = viaQueue ? g.mentionQueue.shift() : null;
    const next = viaQueue
      ? (g.members.find(m => m.id === queuedId) || null)
      : groupNextMember(s, current, trimmedOut);
    if (next === GROUP_OWNER) {
      // 成员点名要群主拍板：暂停并把问题**明确**交到人类手上（系统消息，非群主自述）
      g.phase = 'paused';
      groupPush(s, 'assistant',
        '【需要群主决策】' + current.name + ' 在等你确认：\n' + groupOwnerQuestion(trimmedOut) +
        '\n\n直接回复即可继续（回复会自动从主持人重新起棒）。', null, { system: true });
      groupToolbarRefresh(s.id);
      try { if (typeof saveSessions === 'function') saveSessions(); } catch (e) {}
      return;
    }
    if (!next) {
      // 无人接手（主持人未指名 / 成员都指向自己）→ 交还群主
      g.phase = 'paused';
      groupPush(s, 'assistant', '【群聊调度】本轮没有明确交接对象，接力暂停，交还群主。可「继续接力」或直接发新指令。', null, { system: true });
      groupToolbarRefresh(s.id);
      try { if (typeof saveSessions === 'function') saveSessions(); } catch (e) {}
      return;
    }
    g.turn = next.id;
    groupToolbarRefresh(s.id);
    // viaQueue：群主显式点名的后续名单，不受「自动接力」开关限制——
    // @ 了三个人，开关再关也得让三个人都说完（Round 15b 主理人裁定）
    if (!(g.phase === 'running' && (g.autoRelay || viaQueue))) return;
    current = next;
  }
  } finally {
    GROUP_BUSY_SIDS.delete(s.id);
    if (_groupRun && typeof RunRegistry !== 'undefined') RunRegistry.finish(_groupRun);
    if (typeof groupAbortRelease === 'function') groupAbortRelease(s.id);
  }
}

/** 接力路由（2026-11-04 自由讨论版）：优先取文本中**最后一个 @成员名**（≠自己）
 * ——支持互相讨论/反驳的对话流；否则「交接给: X」两步匹配；匹配自己回主持人；
 * 主持人无明确指向 → 暂停等群主。 */
function groupNextMember(s, from, out) {
  const g = s.group;
  const text = String(out || '');
  const ats = text.match(/@([^\s@，,。；;！!？?"']{1,12})/g) || [];
  for (let i = ats.length - 1; i >= 0; i--) {
    const raw = ats[i].slice(1);
    if (raw === '群主' || raw.indexOf('群主') === 0) return GROUP_OWNER;   // 要找人类拍板
    const hit = g.members.find(x => x.id !== from.id && (x.name === raw || raw.indexOf(x.name) === 0));
    if (hit) return hit;
  }
  const m = /交接给[:：]\s*([^\n]+)/.exec(text);
  if (m) {
    const raw = m[1].replace(/[〈>《「」"'（）()，,。.\s]/g, '');
    if (raw === '群主' || raw.indexOf('群主') === 0) return GROUP_OWNER;
    if (raw) {
      const hit = g.members.find(x => x.id !== from.id && x.name === raw)
        || g.members.find(x => x.id !== from.id && raw.indexOf(x.name) === 0);
      if (hit) return hit;
    }
  }
  if (from.host) return null;   // 主持人无明确指向 → 等群主
  return g.members.find(x => x.host) || null;
}

/** 抽出成员要问群主的那一问（给「需要群主决策」提示用）。 */
function groupOwnerQuestion(text) {
  const lines = String(text || '').split('\n');
  const hit = lines.find(l => /@群主|交接给[:：]\s*群主/.test(l));
  const q = String(hit || '').replace(/^[\s\-*>·]+/, '').replace(/@群主/g, '').trim();
  return q || '（成员请求群主确认，详见该消息全文）';
}

/** 群聊感知上下文（2026-11-04 升级）：成员明确知道这是群聊、知道全部名册、
 * 可以 @ 任何成员交流方案（含反驳）；群聊消息流以简略形式全量可见
 * （他人消息 300 字截断——保持职责边界感），自己的历史全文。 */
function groupContextFor(s, member) {
  const g = s.group;
  const roster = g.members.map(m =>
    (m.host ? '★' : '·') + m.name + '（' + (m.host ? '主持人' : '成员') + (m.model ? '，模型 ' + m.model : '') + '）'
  ).join('\n') + '\n★ 群主（人类，最终决策人；不是成员，不在接力名单里）';
  const sys = '你是群聊成员「' + member.name + '」' + (member.host ? '（主持人）' : '') +
    '。这是一场多模型群聊协作，群主是人类。' +
    '当前成员名册：\n' + roster + '\n' +
    '\n交流规则：\n' +
    '1. 对某位成员说话，用 @成员名 开头；可以自由讨论方案，支持或反驳都要有理有据。\n' +
    '2. 只负责自己的职责范围，不替其他成员产出其职责内的内容；发现他人方案有问题时 @对方指出。\n' +
    '3. 群主是唯一决策人，与群主指示冲突时以群主为准。\n' +
    '4. 每次发言以【交接文档】小节收尾。**交接文档要写全，不许用「见上」「同上」「如前所述」「略」之类的缩写或省略**——下一棒的模型看不到你的推理过程和完整正文，只凭这份文档工作。格式：\n' +
    '【交接文档】\n' +
    '- 交接给: <成员名或「群主」>\n' +
    '- 本次产出: <一句话主题，会用作群文件名>\n' +
    '- 完整说明: <把你这一轮的结论、方案、关键参数、字段名、文件路径逐条写全；他人看不懂就等于没写>\n' +
    '- 对下一棒的要求: <具体清单，可逐条编号>\n' +
    '- 已确认的事实: <已经验证过的前提，避免下一棒重复试错>\n' +
    '- 风险与注意: <可空，但不要为了省字而省略>\n' +
    '5. 不要在自己正文开头写【你的名字】或任何【】前缀——群聊流里的【名字】是系统标注发言人用的，不是要你照抄的格式。正文直接从内容开始。\n' +
    '6. 需要群主拍板或补充信息时，正文写「@群主 请确认：<具体问题>」，并在【交接文档】写「交接给: 群主」。系统会自动暂停接力把问题交到群主手上。绝不允许假装群主已经回答过。\n' +
    '7. 你有工具（读写文件、执行命令等，取决于群主的工具档设置）。产出必须落到实际文件：写代码就写进文件，不要只在正文里贴一大段代码；需要确认环境就先读目录/文件。正文只写结论与文件路径。\n' +
    '8. 每轮交接文档会被自动归档到「群文件」，文件名形如 时间_成员_主题.md。后续任何人（包括群主和之后的模型）可以先按关键词检索群文件，再读全文补齐上下文。\n' +
    (typeof groupFilesContextLines === 'function' ? groupFilesContextLines(s) : '') +
    (member.role ? '\n你的身份与职责：\n' + member.role : '');
  const msgs = [{ role: 'system', content: sys }];
  // 群聊消息流（简略视图：他人 300 字，群主 1200 字）
  const stream = s.messages.slice(-24);
  for (const m of stream) {
    if (m.system) {   // 调度/系统提示：不是群主说的话，别让模型当成人类指令
      msgs.push({ role: 'user', content: '【系统通知】' + String(m.content).slice(0, 400) });
      continue;
    }
    if (!m.member) {
      msgs.push({ role: 'user', content: '【群主】' + String(m.content).slice(0, 1200) });
      continue;
    }
    if (m.member.id === member.id) {
      msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user',
        content: '【你（' + m.member.name + '）的发言】' + String(m.content).slice(0, GROUP_LIMITS.memberMsgChars) });
    } else {
      msgs.push({ role: 'user', content: '【' + m.member.name + '】' + String(m.content).slice(0, 300) });
    }
  }
  if (msgs.length === 1) msgs.push({ role: 'user', content: '【群主】（见系统提示）请开始。' });
  return msgs;
}

/** 群聊成员的工具面：与主对话同源（后端 build_tools），受设置里的「工具档」约束。
 * 后端不可用/未开工具 → 返回空数组，成员退化为纯文本（旧行为），不报错中断接力。 */
// R21 工具调用优化：工具面缓存——原实现每次成员发言都打一次 build_tools RPC
// （群聊一轮接力 = N 次），面不随发言变化。按 (mode|endpoint) 缓存 60s；
// 设置面板保存配置时由 saveConfig 侧的 groupToolsCacheReset 清空。
let _gfToolsCache = { key: '', tools: null, at: 0 };
function groupToolsCacheReset() { _gfToolsCache = { key: '', tools: null, at: 0 }; }
async function groupLoadTools() {
  try {
    const el = document.getElementById('toolMode');
    const mode = (el && el.value) || 'full';
    if (mode === 'off' || mode === 'chat') return [];
    if (typeof callApi !== 'function' || typeof isGlmEndpoint !== 'function') return [];
    const key = mode + '|' + (typeof isGlmEndpoint === 'function' ? isGlmEndpoint() : '');
    if (_gfToolsCache.key === key && _gfToolsCache.tools &&
        Date.now() - _gfToolsCache.at < 60000) return _gfToolsCache.tools;
    const role = mode === 'readonly' ? 'ro' : 'full';
    // include_agent=false：群聊里不挂浏览器/软件驱动（接力场景用不上，且确认档会打断流水线）
    const raw = await callApi('build_tools', [role, false, false, isGlmEndpoint()]);
    const parsed = raw ? JSON.parse(raw) : null;
    const tools = Array.isArray(parsed) ? parsed : [];
    _gfToolsCache = { key, tools, at: Date.now() };
    return tools;
  } catch (e) { return []; }
}

/** 模型调用：复用 ModelTransport + parseSseStream 主链路；本地端点串行已由
 * 调度天然保证（群聊一次只有一名成员发言），本地附加 keep_alive 减少重载。
 * Round 14：接上工具循环——成员可以真的读写文件、跑命令，产出落到磁盘，
 * 而不是把一大段代码贴在正文里（主理人报障「生成物是纯代码」）。 */
async function groupCallModel(s, member, messages, onDelta, onTool) {
  const snap = (typeof uiEndpointSnapshot === 'function') ? uiEndpointSnapshot() : {};
  const sel = document.getElementById('modelSelect');
  const curModel = sel ? sel.value : '';
  // Round 15：成员可绑定其它端点（'ep::model'）——按成员自己的端点发送。
  // 缺端点/缺 Key 时明确报错（否则会拿当前端点的 Key 去打别的域名，得到 401 谜题）。
  let epTarget = null;
  if (typeof groupMemberEndpoint === 'function') {
    epTarget = groupMemberEndpoint(s.group, member);
    if (epTarget && epTarget.missing) {
      const why = epTarget.missing === 'endpoint'
        ? '该成员选用的是另一个端点，但端点地址没有记录'
        : '该成员选用的是另一个端点，但还没填这个端点的 API Key';
      const err = new Error('【' + member.name + '】' + why + '。请长按成员名 → 群聊管理里补上「端点Key」。');
      err.code = 'GROUP_ENDPOINT_MISSING';
      throw err;
    }
  }
  const local = epTarget ? false : !!(typeof localModeActive === 'function' && localModeActive());
  const tools = await groupLoadTools();
  const convo = Array.isArray(messages) ? messages.slice() : [];
  let text = '';
  const maxRounds = GROUP_LIMITS.memberToolRounds;
  for (let round = 0; round <= maxRounds; round++) {
    const body = {
      messages: (typeof normalizeSystemMessages === 'function') ? normalizeSystemMessages(convo) : convo,
      model: (epTarget && epTarget.model) || member.model || curModel || '',
      stream: true,
      temperature: 0.4,
    };
    if (tools.length) body.tools = tools;
    if (local) body.keep_alive = '10m';   // Ollama：群聊接力间隙不卸载模型
    const useEp = epTarget && epTarget.ep && epTarget.ep.base_url;
    const resp = await ModelTransport.stream({
      endpoint: useEp ? (typeof chatCompletionsOf === 'function'
        ? chatCompletionsOf(epTarget.ep.base_url) : epTarget.ep.base_url) : snap.endpoint,
      apiKey: useEp ? epTarget.ep.api_key : snap.apiKey,
      body, local,
      // 跨端点直连：不走当前端点的代理目标头（否则会被转发回当前端点）
      proxyHeaders: useEp ? {} : ((typeof localProxyHeaders === 'function') ? localProxyHeaders() : {}),
    }, groupAbortController(s.id).signal);
    if (!resp || !resp.ok || !resp.body) {
      let detail = '';
      try { detail = (await resp.text()).slice(0, 200); } catch (e) {}
      throw new Error('HTTP ' + (resp ? resp.status : '?') + (detail ? ' ' + detail : ''));
    }
    const parsed = await parseSseStream(resp.body, {
      round,
      onEvent(json) {
        const d = json && json.choices && json.choices[0] && json.choices[0].delta;
        if (d && d.content && typeof onDelta === 'function') onDelta(d.content);
      },
    });
    text += parsed.content || '';
    const calls = Object.keys(parsed.toolCallMap || {}).map(k => parsed.toolCallMap[k]);
    if (!calls.length) break;                       // 没有工具调用 → 本轮发言结束
    if (round === maxRounds) break;                 // 工具轮数到顶：保留已有正文
    convo.push({
      role: 'assistant', content: parsed.content || '',
      tool_calls: calls.map(c => ({
        id: c.id, type: 'function',
        function: { name: c.name, arguments: c.argsStr || '{}' },
      })),
    });
    for (const c of calls) {
      let args = {};
      try { args = c.argsStr ? JSON.parse(c.argsStr) : {}; } catch (e) { args = {}; }
      let out;
      try {
        out = (typeof executeTool === 'function')
          ? await executeTool(c.name, args, s.id)
          : JSON.stringify({ ok: false, error: '工具执行器不可用' });
      } catch (e) {
        out = JSON.stringify({ ok: false, error: String(e && e.message || e) });
      }
      convo.push({ role: 'tool', tool_call_id: c.id, content: String(out).slice(0, 8000) });
      if (typeof onTool === 'function') {
        try { onTool(c.name, out); } catch (e) {}
      }
    }
    if (parsed.content) text += '\n';
  }
  return text;
}

const groupAbort = { controller: new AbortController(), bySid: new Map() };

/** R31：按会话取 abort controller —— 暂停 A 群不中断并行中的 B 群。 */
function groupAbortController(sid) {
  let c = groupAbort.bySid.get(sid);
  if (!c) { c = new AbortController(); groupAbort.bySid.set(sid, c); }
  return c;
}
/** R31：会话内换新 controller（暂停后下一位成员用新信号）。 */
function groupAbortRenew(sid) {
  const c = new AbortController();
  groupAbort.bySid.set(sid, c);
  return c;
}
/** R31：会话循环结束时释放信号，防 Map 随会话数增长。 */
function groupAbortRelease(sid) {
  groupAbort.bySid.delete(sid);
}

/* ---------- 会话切换/渲染联动 ---------- */

function groupAfterSessionRender(s) {
  // 群聊会话历史重建：成员消息以**折叠工作气泡**形态重现（与实况一致），
  // 群主消息保留原文 + 群主标签；非群会话自动摘除工具条。
  if (s && s.group) {
    groupToolbarRender(s);
    // 群文件索引（上下文注入 + 工具栏计数）——异步补，不阻塞渲染
    if (typeof groupFilesSync === 'function') { try { void groupFilesSync(s); } catch (e) {} }
    // @ 选择器（Round 15）：群聊会话里打 @ 弹成员列表
    if (typeof groupMentionBind === 'function') { try { groupMentionBind(); } catch (e) {} }
    const box = document.getElementById('chatContainer');
    if (box) {
      const els = box.querySelectorAll('.message');
      let i = 0;
      els.forEach(el => {
        const m = (s.messages || [])[i++];
        if (!m) return;
        const contentEl = el.querySelector('.content');
        if (!contentEl) return;
        if (m.member) {
          // Round 11 修「挤在中间」：.message 的 content 是收缩宽度+大间距——
          // 群聊 member 消息打 group-msg 类让气泡撑满、间距收紧、时间戳隐藏
          // （时间在详情页头部有）。
          el.classList.add('group-msg');
          contentEl.innerHTML = '';
          contentEl.style.display = 'block';
          groupBubbleMount(contentEl, m.member, String(m.content || ''), 'done');
        } else if (m.role === 'user' || m.system) {
          // 系统消息（调度/需要群主决策）不能标成「群主」——那会让人以为是自己说的
          const tag = document.createElement('div');
          tag.className = 'group-msg-tag ' + (m.system ? 'sys' : 'owner');
          tag.textContent = m.system ? '调度' : '群主';
          contentEl.insertBefore(tag, contentEl.firstChild);
        }
      });
    }
  } else {
    const old = document.getElementById('groupToolbar');
    if (old) old.remove();
  }
}
