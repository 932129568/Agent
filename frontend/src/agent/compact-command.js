/* ================= compact ================= */
const MAX_DONE_TASKS = 8;
/* 修复 UX-1（v1.4）：in-place 压缩（compactNow/archiveOldTasks）的单份可恢复备份。
 * 备份仅存「被替换掉的原始消息」，上限 50 条（COMPACT_BACKUP_CAP），超限标记不可恢复；
 * 新压缩覆盖旧备份（单份），卡片按 gen 核对归属——被覆盖的旧卡片显示不可恢复。 */
const COMPACT_BACKUP_CAP = 50;
function saveCompactBackup(s, kind, replacedMsgs) {
  const gen = Date.now();
  const truncated = replacedMsgs.length > COMPACT_BACKUP_CAP;
  s._compactBackup = {
    gen: gen, kind: kind, at: gen,
    truncated: truncated,
    count: replacedMsgs.length,
    msgs: truncated ? [] : replacedMsgs
  };
  return { gen: gen, truncated: truncated, count: replacedMsgs.length };
}
/** 恢复原文：按 kind 把备份消息插回当前 messages（压缩段换回原文），重存 + 重渲染。 */
function restoreCompactBackup(s, gen) {
  // 复核修正：生成中禁止恢复——renderChatHistory 重建 DOM 会摘除在途流式
  // 气泡（最终消息可能只在数据层不在界面）
  if (typeof isStreaming !== 'undefined' && isStreaming) {
    toast('AI 正在生成中，请先停止或等待完成再恢复原文', 'warn');
    return false;
  }
  const bk = s && s._compactBackup;
  if (!bk || bk.gen !== gen || bk.truncated || !Array.isArray(bk.msgs) || !bk.msgs.length) {
    toast('该压缩备份已被后续压缩覆盖或超限，无法恢复', 'warn');
    return false;
  }
  const head = bk.kind === 'compact' ? 2 : 1;   // compact 替换段=[纪要,已读纪要]；archive 替换段=[归档占位]
  s.messages = [...bk.msgs, ...s.messages.slice(head)];
  s._compactBackup = null;
  saveSessions();
  renderChatHistory(s);
  renderSessionList();
  updateLiveTokenStat();
  toast('已恢复压缩前的原文', 'ok');
  return true;
}
/** 修复 UX-1（v1.4）：渲染压缩/归档卡片（token 前后对比 + 恢复原文按钮）。
 *  live 路径（compactNow/archiveOldTasks 当前会话显示中）与历史重渲染
 *  （renderChatHistory）共用。 */
function renderCompactCard(box, s, m) {
  if (!box) return;
  const card = m.__compactCard || m.__archiveCard;
  if (!card) return;
  const kind = m.__compactCard ? '压缩' : '归档';
  const pct = card.before > 0 ? Math.max(0, Math.round((1 - card.after / card.before) * 100)) : 0;
  const cd = document.createElement('div');
  cd.className = 'compact-card';
  cd.innerHTML = '<div class="compact-card-head">🗜 已' + kind + ' ' + card.count + ' 条 · 约 ' +
    Math.round(card.before).toLocaleString() + ' → ' + Math.round(card.after).toLocaleString() +
    ' tokens（-' + pct + '%）' +
    (card.truncated ? ' · 备份超 ' + COMPACT_BACKUP_CAP + ' 条上限，不可恢复' : '') + '</div>';
  if (!card.truncated) {
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = '↩ 恢复原文';
    btn.onclick = () => restoreCompactBackup(s, card.gen);
    cd.appendChild(btn);
  }
  box.appendChild(cd);
}
/** 修复 UX-1（v1.4）：当前会话正在显示时即时挂卡片（历史重渲染走 renderChatHistory）。 */
function _liveCompactCard(s, placeholderMsg) {
  try {
    if (typeof currentSessionId !== 'undefined' && currentSessionId === s.id && typeof document !== 'undefined') {
      renderCompactCard(document.getElementById('chatContainer'), s, placeholderMsg);
    }
  } catch (e) {}
}
function archiveOldTasks(s) {
  const starts = [];
  s.messages.forEach((m, i) => { if (m.role === 'user') starts.push(i); });
  if (starts.length <= MAX_DONE_TASKS) return false;
  let end = starts[starts.length - MAX_DONE_TASKS];
  // 修复 ㉖：删除回退 while 死代码——starts 只收 user 消息下标，end 必是 user 角色而非 tool，循环永不执行
  if (end <= 0) return false;
  const paths = new Set();
  s.messages.slice(0, end).forEach(m => (m.tool_calls || []).forEach(tc => {
    try { const a = JSON.parse(tc.function.arguments || '{}'); if (a.path) paths.add(a.path); } catch (e) {}
  }));
  const replaced = s.messages.slice(0, end);
  s.messages.splice(0, end, { role: 'assistant',
    content: `[早期任务已归档，共 ${end} 条消息。涉及文件: ${[...paths].slice(0, 10).join('、') || '无'}。需要内容请重新 read_file，不要凭记忆作答]` });
  s._readKeys = [];   // 修复 S5（二轮，S21 对偶路径）：归档蒸发了含文件原文的消息，
  // 已读去重集必须同步清空——否则归档占位语让 AI 重读、去重器答「原文仍在上下文」，两句都是谎言
  // 修复 UX-1（v1.4）：归档同样存单份可恢复备份（超 50 条标记不可恢复）+ 卡片数据
  const _before = (typeof historyTokens === 'function') ? historyTokens(replaced) : 0;
  const _after = (typeof historyTokens === 'function') ? historyTokens(s.messages) : 0;
  const _bk = saveCompactBackup(s, 'archive', replaced);
  s.messages[0].__archiveCard = { before: _before, after: _after, gen: _bk.gen, truncated: _bk.truncated, count: replaced.length };
  // 修复 ㊵（三轮）：原地 splice 使既有消息元素的 data-midx 全部错位（后续
  // applyShrinkMarkers 打错弱化标记、会话搜索跳错消息）——当前会话显示中时
  // 整段重渲染（renderChatHistory 会按 __archiveCard 挂卡片，midx 与新数组对齐）；
  // 非当前会话（后台）保持原轻量挂卡路径。typeof 守卫保 vm 单模块沙箱可测。
  if (typeof currentSessionId !== 'undefined' && currentSessionId === s.id
      && typeof renderChatHistory === 'function') {
    renderChatHistory(s);
  } else {
    _liveCompactCard(s, s.messages[0]);   // 修复 UX-1（v1.4）：当前会话显示中则即时挂归档卡片
  }
  return true;
}
function recallMemory(query, k = 3) {
  try {
    const items = JSON.parse(window.__memCache || '[]');
    const q = new Set((query || '').toLowerCase().match(/[a-z0-9_\u4e00-\u9fa5]{2,}/g) || []);
    return items.map(it => {
      const w = (it.text || '').toLowerCase().match(/[a-z0-9_\u4e00-\u9fa5]{2,}/g) || [];
      return { it, s: w.reduce((a, x) => a + (q.has(x) ? 1 : 0), 0) / (w.length + 1) };
    }).filter(x => x.s > 0.08).sort((a, b) => b.s - a.s).slice(0, k)
      .map(x => `- ${x.it.ts} ${x.it.text}`).join('\n');
  } catch (e) { return ''; }
}
function summarizeToolResult(raw) {
  try {
    const p = JSON.parse(raw);
    if (p.path && p.total_lines) {
      return `已读取文件 ${p.path}（共 ${p.total_lines} 行），原文仍完整保留在上方上下文中，直接引用即可，禁止重新 read_file`;
    }
    if (p.path && p.skipped) return `[已跳过重复读取 ${p.path}：本次任务已读过，内容在上方对话中]`;
    if (p.path) return `[工具已处理 ${p.path}，结果已在更早轮次提供]`;
    if (p.output) return `[命令已执行，输出已在更早轮次提供、需要时可重新执行] ` + String(p.output).slice(0, 150);
  } catch (e) {}
  return '[早期工具结果已压缩，需要时可重新调用]';
}
async function compactNow(s, apiKey, opts = {}) {
  const quietAdd = (msg) => { if (!opts.quiet) addMessage('assistant', msg); };
  if (!opts.force && isStreaming) return quietAdd('AI 正在生成中，稍后再压缩。');
  if (s.messages.length < 6) return quietAdd('历史很短，无需压缩。');
  const lastMsg = s.messages[s.messages.length - 1];
  const keepLast = !!(lastMsg && lastMsg.role === 'assistant' && !lastMsg.tool_calls);
  const dumpSrc = keepLast ? s.messages.slice(0, -1) : s.messages;
  const dump = dumpSrc.map(m => (m.role === 'user' ? '用户: ' : m.role === 'assistant' ? 'GLM: ' : '工具: ')
    + (typeof m.content === 'string' ? m.content.slice(0, 400) : '[多模态/工具调用]')).join('\n').slice(0, 24000);
  if (dump.trim().length < 200) return quietAdd('可压缩内容太少，跳过。');
  const liveEl = document.getElementById('liveTokenStat');
  if (liveEl) liveEl.textContent = '正在压缩历史…';
  try {
    // v1.2 R6 修复：压缩请求与主链路一致——自定义端点走 provider 地址与 Key，
    // 并剥离 GLM 专属字段（thinking）；此前硬编码 API_URL + thinking 会导致自定义端点压缩必失败。
    const _glm = isGlmEndpoint();
    const _cmpModel = _glm ? 'glm-5.3-flash' : (providerState.model || 'glm-5.3-flash');
    // W0 R19：压缩提示词改读 prompts/compact.md（版本化）；失败回落内置串
    // （与 prompts 文件渲染值逐字节一致，回落零行为差异）
    let _cmpPrompt = '把以下人机协作历史压缩成 ≤200 字工作纪要，必须保留: 任务目标、涉及文件路径、已做改动、未完成事项、关键结论、工具调用序列(工具名与关键参数摘要)。直接输出: \n\n';
    try {
      const _cmpRaw = await callApi('prompt_get', ['compact']);
      const _cmp = JSON.parse(_cmpRaw || '{}');
      if (_cmp && _cmp.ok && _cmp.text) _cmpPrompt = _cmp.text;
    } catch (e) { /* 回落内置 */ }
    const _cmpBody = {
      model: _cmpModel, max_tokens: 600,
      // 修复 HF-1（v1.6）排查记录：压缩请求当前只发一条 user（无 system），
      // 形态上不可能触发 Qwen 模板的 500；归一化在下方以 typeof 守卫接线（未来防呆）。
      // 实现 v1.6 T5③：压缩提示词增「保留工具调用序列」要求（原只保留文件路径，
      // 恢复后续跑时丢失「调过什么工具、参数是什么」的脉络）
      messages: [{ role: 'user', content: _cmpPrompt + dump }]
    };
    // 修复 HF-1（v1.6 收口，QA 复验建议）：未来防呆——若压缩提示词哪天改成
    // [system 摘要规范, user 历史]，本地 Ollama/Qwen 会立刻 500（system 必须在最前且只一条）。
    // 用 typeof 守卫接线：正常构建（41 模块同一 <script>）时归一化生效；
    // node vm 单模块沙箱只加载本文件、函数未定义时 typeof 不抛 ReferenceError，自动跳过，
    // 既有单模块沙箱用例（test_s21 / test_backup_and_restore）不受影响。
    if (typeof normalizeSystemMessages === 'function') {
      _cmpBody.messages = normalizeSystemMessages(_cmpBody.messages);
    }
    if (_glm) _cmpBody.thinking = { type: 'disabled' };
    const resp = await fetch(resolveApiEndpoint(), { method: 'POST',
      // v1.6 HF-P0：local 模式经后端 CORS 代理时附 X-Harbor-Target（真实本地
      // base_url）；typeof 守卫保 node vm 单模块沙箱可测（71-provider 未加载时跳过）
      headers: Object.assign({ 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        (typeof localProxyHeaders === 'function') ? localProxyHeaders() : {}),
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify(_cmpBody) });
    const data = await resp.json();
    const summary = data.choices?.[0]?.message?.content || '（压缩失败，保留历史）';
    if (summary === '（压缩失败，保留历史）') { if (liveEl) updateLiveTokenStat(); return quietAdd(summary); }
    const _before = (typeof historyTokens === 'function') ? historyTokens(s.messages) : 0;   // 修复 UX-1（v1.4）：压缩前后 token 对比（防御：沙箱/降级无该函数时记 0，不中断压缩）
    const _replaced = dumpSrc;                    // 被纪要替换掉的原始消息段（备份用）
    s.messages = [
      { role: 'user', content: '【历史纪要（compact 生成）】\n' + summary,
        ...(data.usage ? { usage: { ...data.usage, model: _cmpModel } } : {}) },
      { role: 'assistant', content: '已读纪要，继续。' },
      ...(keepLast ? [lastMsg] : [])
    ];
    saveSessions();
    s.apiFrozen = {};
    s._readKeys = [];   // 修复 S21：压缩已把含文件原文的消息换成纪要，已读去重集必须同步清空（否则 read_file 拒重读返回谎言）
    // 修复 UX-1（v1.4）：单份可恢复备份 + 纪要消息挂卡片数据（renderChatHistory 渲染「恢复原文」）
    const _bk = saveCompactBackup(s, 'compact', _replaced);
    s.messages[0].__compactCard = { before: _before, after: (typeof historyTokens === 'function') ? historyTokens(s.messages) : _before, gen: _bk.gen, truncated: _bk.truncated, count: _replaced.length };
    // 修复 ㊵（三轮）：s.messages 整组替换后旧 DOM 的 data-midx 全部错位（原仅
    // _liveCompactCard 在容器尾部追加卡片——位置错且旧气泡/midx 残留）。当前会话
    // 显示中时整段重渲染（renderChatHistory 按 __compactCard 挂卡片，midx 对齐）；
    // 后台会话保持轻量挂卡。typeof 守卫保 vm 单模块沙箱可测。
    if (typeof currentSessionId !== 'undefined' && currentSessionId === s.id
        && typeof renderChatHistory === 'function') {
      renderChatHistory(s);
    } else {
      _liveCompactCard(s, s.messages[0]);   // 修复 UX-1（v1.4）：当前会话显示中则即时挂压缩卡片
    }
    // 重渲染后再追加提示（quietAdd 只进 DOM 不落库，若先 add 会被整段重建抹掉）
    quietAdd(`已压缩 ${dumpSrc.length} 条历史 → 1 份纪要，下轮请求输入将大幅下降。`);
    try { callApi('clear_caches', []).catch(() => {}); } catch (e) {}   // 修复 建议㉕（二轮）：补 rejection 处理（85 已修此处漏）
  } catch (e) {
    if (opts.quiet) { console.warn('自动压缩失败(静默跳过)', e);
      const le = document.getElementById('liveTokenStat');
      if (le) le.textContent = '△ 自动压缩失败，本轮仍按原历史发送';
    } else addMessage('error', '压缩失败: ' + e.message);
  }
  if (liveEl) updateLiveTokenStat();
}
async function compactHistory(s) {
  let changed = archiveOldTasks(s);
  let lastUserIdx = -1;
  for (let i = s.messages.length - 1; i >= 0; i--) {
    if (s.messages[i].role === 'user') { lastUserIdx = i; break; }
  }
  for (let i = 0; i < lastUserIdx; i++) {
    const m = s.messages[i];
    // 实现 v1.6 W30：逐消息防护——原循环体无 try/catch，单条坏消息（如
    // content 为不可序列化的特殊对象、访问器抛错）会中断整个 compactHistory，
    // 异常沿 Agent 轮次上抛终止整轮。坏消息跳过并继续，压缩尽力而为。
    try {
      if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 500 && !m._compacted && m.__tool !== 'read_file' && m.__tool !== 'read_more') {
        m.content = summarizeToolResult(m.content) || (m.content.slice(0, 300) + '…(已压缩)');
        m._compacted = true; changed = true;
      }
      if ((m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
          && m.content.length > 1500 && !m._compacted
          && !(m.role === 'user' && m.content.includes('已完整注入'))) {   // 注入的附件全文也不截
        m.content = m.content.slice(0, 1500) + '…(旧对话已压缩)';
        m._compacted = true; changed = true;
      }
      if (Array.isArray(m.content)) {
        const replaced = m.content.map(p => {
          if (p.type === 'image_url') return { type: 'text', text: '[图片]' };
          if (p.type === 'video_url') return { type: 'text', text: '[视频]' };
          if (p.type === 'text' && p.text && p.text.length > 1500)
            return { type: 'text', text: p.text.slice(0, 1500) + '…(已压缩)' };
          return p;
        });
        if (JSON.stringify(replaced) !== JSON.stringify(m.content)) { m.content = replaced; changed = true; }
      }
      if (m.tool_calls) {
        const mapped = m.tool_calls.map(tc => {
          try {
            const a = JSON.parse(tc.function.arguments || '{}');
            let inner = false;
            for (const k of Object.keys(a)) {
              if (typeof a[k] === 'string' && a[k].length > 300) { a[k] = a[k].slice(0, 300) + '…(已截断)'; inner = true; }
            }
            if (inner) return { ...tc, function: { ...tc.function, arguments: JSON.stringify(a) } };
            return tc;
          } catch (e) { return tc; }
        });
        if (JSON.stringify(mapped) !== JSON.stringify(m.tool_calls)) { m.tool_calls = mapped; changed = true; }
      }
    } catch (e) { /* 实现 v1.6 W30：单条坏消息跳过，不中断整轮压缩 */ }
  }
  if (changed) saveSessions();  // 后台异步保存，不阻塞压缩流程
}
