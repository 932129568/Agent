/* ================= Markdown 渲染（高亮 + 节流） ================= */
if (window.DOMPurify) {
  DOMPurify.addHook('afterSanitizeAttributes', (n) => {
    if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener'); }
  });
}
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  // 修复 W29（三轮）：textContent→innerHTML 只转义 & < >，不转义引号——onclick
  // 属性上下文（'...'）存在注入面。补引号转义（纵深防御；当前 id 规则不可触发）
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function renderMd(text) {
  if (window.marked && window.DOMPurify) {
    try { return DOMPurify.sanitize(marked.parse(text || '')); } catch (e) {}
  }
  // 修复 S19：fail-closed —— purify 未加载/消毒抛异常时不再回退到未消毒的裸 marked
  //（模型输出是半不可信输入，XSS 在 pywebview 下等于拿到全部 js_api 本地能力），降级为纯文本转义。
  return '<p>' + escapeHtml(text || '') + '</p>';
}
/* R39（F3a/D24）块级冻结流式渲染：onDelta 全文重解析 O(n²) 根治。
 * 按 marked 顶层 token 切分——已闭合块冻结（每块终身只过一次 marked+DOMPurify），
 * 每次仅重渲染尾部活动块；未闭合围栏由 lexer 自动按代码块补全（F3a③，消除裸符号闪烁）。
 * 正确性边界：跨块语义（引用链接后置定义等）流式期间允许瞬时分歧，
 * 轮末/流末调用方 renderMd 全文权威渲染兜底纠正（F3a 共识：Streamdown/Cherry 同型方案）。 */
const _mdStreamMap = new WeakMap();   // el -> { doneRaw, doneHtml }
function renderMdStream(el, text) {
  const src = String(text || '');
  if (!el || !(window.marked && window.marked.lexer && window.DOMPurify)) return renderMd(src);
  let st = _mdStreamMap.get(el);
  // 增量前提：新文本须是已冻结前缀的延长（截断/重生成/换轮内容 → 全量重建，自愈）
  if (!(st && src.length >= st.doneRaw.length && src.startsWith(st.doneRaw))) {
    st = { doneRaw: '', doneHtml: '' };
    _mdStreamMap.set(el, st);
  }
  let tokens = null;
  try { tokens = marked.lexer(src.slice(st.doneRaw.length)); } catch (e) { tokens = null; }
  if (!tokens || !tokens.length) return st.doneHtml;
  if (tokens.length > 1) {
    // ≥2 块：前 n-1 块已闭合 → 冻结（st.doneHtml 终身累计，不重渲染）
    let frozen = '';
    for (let i = 0; i < tokens.length - 1; i++) frozen += renderMd(tokens[i].raw);
    st.doneHtml += frozen;
    st.doneRaw += tokens.slice(0, tokens.length - 1).map(t => t.raw).join('');
  }
  return st.doneHtml + renderMd(tokens[tokens.length - 1].raw);
}
/** 轮次边界复位（run-controller beforeRound 调用）：新一轮正文重新累计。 */
function resetMdStream(el) { if (el) _mdStreamMap.delete(el); }
const _rafPendingMap = new WeakMap();   // 修复 W28：按 el 保存唯一待渲染记录，避免全局单 flag 丢帧；终帧可同步 flush
function scheduleRender(el, fn) {
  // 复核批修正（真机实证）：WebView2 合成器空闲时 rAF 回调可能不派发——
  // 状态栏 textContent 正常跳动而气泡流式渲染冻结，直到下一次输入强制
  // 重绘才把积压回调全部冲出。rAF + 120ms 定时器双路竞速：正常环境 rAF
  // 先达（定时器经 done 闸成为 no-op），rAF 挂起环境定时器兜底必达。
  let pending = _rafPendingMap.get(el);
  if (pending) {
    pending.fn = fn;   // 同一元素只保留最新终态，避免闭包语义依赖调用方
    return;
  }
  pending = { fn: fn, done: false, paint: null };
  pending.paint = () => {
    if (pending.done) return;
    pending.done = true;
    _rafPendingMap.delete(el);
    try { el.innerHTML = pending.fn(); } catch (e) {}
  };
  _rafPendingMap.set(el, pending);
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(pending.paint);
  setTimeout(pending.paint, 120);
}
/** 流末/工具终态同步绘制最新分片；已排队的 rAF/定时器随后幂等空转。 */
function flushRender(el) {
  const pending = _rafPendingMap.get(el);
  if (pending) pending.paint();
}
function enhanceCodeBlocks(container) {
  container.querySelectorAll('pre').forEach(pre => {
    const code = pre.querySelector('code');
    if (code && window.hljs && !code.dataset.hl) {
      try { hljs.highlightElement(code); } catch (e) {}
      code.dataset.hl = '1';
    }
    if (code && /language-[\w+-]/.test(code.className) && !pre.querySelector('.code-lang')) {
      const lang = (code.className.match(/language-([\w+-]+)/) || [])[1] || 'code';
      const tag = document.createElement('span');
      tag.className = 'code-lang'; tag.textContent = lang;
      pre.appendChild(tag);
    }
    if (pre.querySelector('.code-copy')) return;
    const btn = document.createElement('button');
    btn.className = 'code-copy'; btn.textContent = '复制';
    btn.onclick = (e) => {
      e.stopPropagation();
      const t = (pre.querySelector('code') || {}).innerText || pre.innerText;
      navigator.clipboard.writeText(t).then(() => {   // 修复 建议㉔（三轮）：补 .catch，剪贴板权限拒绝不再 unhandled rejection
        btn.textContent = '✓';
        setTimeout(() => btn.textContent = '复制', 1500);
      }).catch(() => { btn.textContent = '✗'; setTimeout(() => btn.textContent = '复制', 1500); });
    };
    pre.appendChild(btn);
  });
}
function viewImage(src) {
  // 修复 建议㉓（三轮）：单例 + Esc 关闭——原多开叠加无上限、只能点图关闭
  const prev = document.getElementById('__imgViewer');
  if (prev) prev.remove();
  const ov = document.createElement('div');
  ov.id = '__imgViewer';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
  const img = document.createElement('img');
  img.src = src; img.style.cssText = 'max-width:92%;max-height:92%;border-radius:10px;';
  ov.appendChild(img);
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  ov.onclick = close;
  document.addEventListener('keydown', onKey);
  document.body.appendChild(ov);
}
function addMessage(role, content, extra) {
  const container = document.getElementById('chatContainer');
  const empty = document.getElementById('emptyState');
  if (empty) {
    // v4：淡出退场（原瞬删突兀）；fx-off/instant 直删
    if (typeof MOTION !== 'undefined' && !MOTION.instant()) {
      empty.classList.add('leaving');
      MOTION.onAnimEnd(empty, 'animationend', MOTION.compOut())
        .then(() => empty.remove()).catch(() => { try { empty.remove(); } catch (e) {} });
    } else empty.remove();
  }
  const div = document.createElement('div');
  div.className = 'message ' + role;
  let extraHtml = '';
  // v2.1 M1（P05-A）：随本条用户消息一起发出的专家/技能/连接器/文件胶囊徽章。
  // 全部外部字段过 escapeHtml（label/id/emoji 可能来自专家包元数据或文件路径，
  // 属不可信输入）。此处只用 className 拼接，不写 id="…" 字面量——源码会被内联进
  // harbor.html，而 contract_diff 从产物正则提取 dom_ids，多一个 id 就判漂移。
  let tokenHtml = '';
  if (extra && Array.isArray(extra.tokens) && extra.tokens.length > 0) {
    const _kindZh = { expert: '专家', team: '专家团', skill: '技能', connector: '连接器', file: '文件' };
    tokenHtml = '<div class="msg-tokens">' + extra.tokens.map(tk => {
      const t = tk || {};
      const k = _kindZh[t.kind] || '能力';
      const icon = t.emoji
        ? '<span class="msg-tok-ic">' + escapeHtml(String(t.emoji)) + '</span>' : '';
      return '<span class="msg-tok msg-tok-' + escapeHtml(String(t.kind || 'expert')) + '">' +
        icon + '<span class="msg-tok-kind">' + escapeHtml(k) + '</span>' +
        '<span class="msg-tok-lbl">' + escapeHtml(String(t.label || t.id || '')) + '</span></span>';
    }).join('') + '</div>';
  }
  if (extra && extra.images)
    // 修复 建议㉜（二轮）：images URL 未转义直拼 innerHTML（上轮点名漏修，
    // 当时仅因 dataURL 巧合无引号而侥幸安全）
    extraHtml = '<div class="msg-images">' + extra.images.map(u => `<img src="${escapeHtml(String(u))}" onclick="viewImage(this.src)">`).join('') + '</div>';
  if (extra && extra.files)
    extraHtml += extra.files.map(f => `<div class="msg-file">📎 ${escapeHtml(f)}</div>`).join('');
  if (extra && extra.usage) {
    const u = extra.usage;
    // 修复 S9（二轮）：usage 三字段来自 API 响应（自定义端点=不可信输入），
    // 未转义直拼 innerHTML 可被恶意端点注入（pywebview 下 XSS = 全部 js_api 本地能力）
    extraHtml += `<div class="usage-info"><span>输入 <b>${escapeHtml(String(u.prompt_tokens ?? ''))}</b></span>` +
      `<span>输出 <b>${escapeHtml(String(u.completion_tokens ?? ''))}</b></span><span>合计 <b>${escapeHtml(String(u.total_tokens ?? ''))}</b></span></div>`;
  }
  const body = (role === 'assistant' && typeof content === 'string') ? '<div class="md-body">' + renderMd(content) + '</div>' : escapeHtml(content || '');
  const now = new Date();
  const hm = ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2);
  div.innerHTML = `
    <div class="avatar">${role === 'user' ? '我' : 'AI'}</div>
    <div class="content ${role === 'error' ? 'error' : ''}">${tokenHtml}${body}${extraHtml}</div>
    <span class="msg-time">${hm}</span>`;
  container.appendChild(div);
  // R19 性能（实测 400 条消息 1548ms → 根因=每条一次 scrollTop 写强制回流）：
  // renderChatHistory 的 .batch 重建期不逐条滚底，由其收尾一次性滚动
  if (!container.classList.contains('batch')) container.scrollTop = container.scrollHeight;
  // v4 配色重设计（用户反馈「气泡颜色太深」）：错误气泡前缀红字加粗、正文中性色——
  // 语义色收窄到标题（完整规则见模板 .message .content.error：中性卡+红色左边条）
  if (role === 'error') fillErrorBubble(div.querySelector('.content'), content);
  return div.querySelector('.content');
}
/* v4 配色重设计：错误气泡文本装配——「请求失败:」前缀红字（b.err-title），
   正文中性色；textContent 组装不碰 innerHTML（端点错误文本=不可信输入，防注入）。 */
function fillErrorBubble(el, text) {
  if (!el) return;
  const txt = String(text == null ? '' : text);
  el.textContent = '';
  // 拆解：标题前缀（「XX：」）/ 尾部「（原始错误：…）」详情 / 正文
  const detailM = /[(（]原始错误[:：]\s*([\s\S]*?)[)）]\s*$/.exec(txt);
  const detail = detailM ? detailM[1].trim() : '';
  const main = detailM ? txt.slice(0, detailM.index) : txt;
  const titleM = /^([^:：\n]{0,14}[:：])\s*/.exec(main);
  const title = titleM ? titleM[1] : '';
  const body = (titleM ? main.slice(titleM[0].length) : main).trim();
  // 结构：头部（图标+标题+详情开关）+ 正文 + 折叠详情块
  const head = document.createElement('div');
  head.className = 'err-head';
  const ico = document.createElement('span');
  ico.className = 'err-ico';
  ico.textContent = '!';
  head.appendChild(ico);
  const t = document.createElement('b');
  t.className = 'err-title';
  t.textContent = (title || '出错了') + ' ';
  head.appendChild(t);
  const bd = document.createElement('div');
  bd.className = 'err-body';
  bd.textContent = body;
  el.appendChild(head);
  el.appendChild(bd);
  if (detail) {
    const dt = document.createElement('div');
    dt.className = 'err-detail';
    const pre = document.createElement('div');
    pre.className = 'err-detail-txt';
    pre.textContent = detail;
    dt.appendChild(pre);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'err-detail-btn';
    toggle.innerHTML = '技术详情 <span class="err-caret">▸</span>';
    toggle.onclick = () => {
      const open = dt.classList.toggle('open');
      toggle.querySelector('.err-caret').style.transform = open ? 'rotate(90deg)' : '';
    };
    el.appendChild(dt);
    head.appendChild(toggle);
  }
}
/* v4：触屏/无悬停设备——点消息唤出操作条（.acting），点其他消息或空白处收起 */
document.addEventListener('click', (e) => {
  const msg = (e.target && e.target.closest) ? e.target.closest('.message') : null;
  document.querySelectorAll('.message.acting').forEach(m => { if (m !== msg) m.classList.remove('acting'); });
  if (msg && !(e.target.closest && e.target.closest('.msg-actions'))) msg.classList.add('acting');
});
/* v4 极简操作图标（16px 线性 stroke 1.8，hover 才显色——克制） */
// R18：消息操作图标走 sprite（i-copy/i-back/i-edit/i-regen/i-star），单描边来源
const MSG_ICONS = {
  copy: '<svg class="ui-icon ui-icon-16" aria-hidden="true"><use href="#i-copy"/></svg>',
  back: '<svg class="ui-icon ui-icon-16" aria-hidden="true"><use href="#i-back"/></svg>',
  edit: '<svg class="ui-icon ui-icon-16" aria-hidden="true"><use href="#i-edit"/></svg>',
  regen: '<svg class="ui-icon ui-icon-16" aria-hidden="true"><use href="#i-regen"/></svg>',
  rewind: '<svg class="ui-icon ui-icon-16" aria-hidden="true"><use href="#i-arrow"/></svg>',
  fav: '<svg class="ui-icon ui-icon-16" aria-hidden="true"><use href="#i-star"/></svg>'
};

/** 消息操作条（v4 极简：小图标悬停浮现）。
 *  contentEl = .message 行；text = 消息原文；onlyCopy = 用户消息（复制/撤回/编辑）。 */
function addMsgActions(msgEl, text, onlyCopy) {
  if (!msgEl || !text) return;
  const bar = document.createElement('div');
  bar.className = 'msg-actions';
  const mk = (icon, title, fn) => {
    const b = document.createElement('button');
    b.className = 'msg-ic';
    b.type = 'button';
    b.title = title;
    b.innerHTML = icon;
    b.onclick = () => fn(b);
    bar.appendChild(b);
    return b;
  };
  const flash = (b, cls) => { b.classList.add(cls); setTimeout(() => b.classList.remove(cls), 1500); };
  mk(MSG_ICONS.copy, '复制', (b) => {
    navigator.clipboard.writeText(text)
      .then(() => flash(b, 'done'))
      .catch(() => flash(b, 'fail'));   // 修复 ㉔（三轮）：剪贴板不可用不再 unhandled rejection
  });
  if (onlyCopy) {
    // 撤回：删除该条 user 消息及其后连续的 assistant/tool 消息（若它们是末尾），内容回输入框
    mk(MSG_ICONS.back, '撤回（删除本条及紧随的回复，内容回输入框）', (b) => msgRecall(msgEl, text));
    // R58：编辑重发（ChatGPT 语义——截断其后回复，替换本条提问，重新生成）
    mk(MSG_ICONS.edit, '编辑并重发（修改提问后从这条重新生成）', (b) => msgEditResend(msgEl, text));
    // R58：回退至此（任意位置——保留本条，移除其后全部，可一键撤销）
    mk(MSG_ICONS.rewind, '回退至此（回到这条提问，其后的对话移除且可撤销）', (b) => msgRollback(msgEl, text));
  } else {
    // R58：历史 assistant 消息的重生成带上自身 midx——从**本轮提问**起重跑
    //（原无 midx，点旧消息的重生成实际总从最后一条 user 重跑，语义误导）
    mk(MSG_ICONS.regen, '重新生成（从这轮提问起）', () => {
      const mi = msgEl && msgEl.dataset ? parseInt(msgEl.dataset.midx, 10) : NaN;
      if (typeof regenerate === 'function') regenerate(Number.isInteger(mi) ? mi : undefined);
    });
    mk(MSG_ICONS.fav, '收藏到记忆', async (b) => {
      try {
        await callApi('append_memory', [JSON.stringify({ text: text.slice(0, 500) })]);
        flash(b, 'done');
        // R101 T03：收藏成功后挂「记忆溯源」折叠条（条数 + 来源 + 可展开原文）
        memTraceAdd(msgEl, text);
      } catch (e) { flash(b, 'fail'); }
    });
  }
  msgEl.appendChild(bar);
}

/* ================= R101 T03 · 记忆溯源（条数 + 来源标签，可展开） =================
 * 收藏到记忆原本只有一个一闪而过的 ✓：用户不知道「存了几条」「存在哪儿」，
 * 也没法回看存了什么。这里在消息下方补一条可展开的折叠行。
 *
 * 诚实性边界（写死在代码里，不要改）：本仓库后端 append_memory 只接收
 * { text }，**没有**来源字段，收藏也不会返回被写入条目的 id/来源。所以这里
 * 能如实呈现的只有两件事：
 *   ① 本次收藏在前端计数里累计了几条（同一消息多次收藏 → 同一元素内累加）；
 *   ② 被收藏文本的正文（前 200 字，textContent 写入）。
 * 「来源」因此只能在「本会话」与「未标注」之间二选一：能取到非空会话 id 就是
 * 「本会话」，否则「未标注」。**不得**写「来自全局记忆库」之类后端不存在的来源。
 */
function memTraceAdd(msgEl, text) {
  if (!msgEl || typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  let tr = null;
  const kids = msgEl.children || [];
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (k && k.classList && typeof k.classList.contains === 'function' && k.classList.contains('mem-trace')) { tr = k; break; }
  }
  if (!tr) {
    tr = document.createElement('div');
    tr.className = 'mem-trace';
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'mem-trace-head';
    head.setAttribute('aria-expanded', 'false');
    const body = document.createElement('div');
    body.className = 'mem-trace-body';
    // 用户内容只走 textContent（禁止 innerHTML 拼接）
    body.textContent = String(text || '').slice(0, 200);
    head.onclick = () => {
      let open = false;
      try { open = tr.classList.toggle('open'); } catch (e) { open = false; }
      try { head.setAttribute('aria-expanded', open ? 'true' : 'false'); } catch (e) {}
    };
    tr.appendChild(head);
    tr.appendChild(body);
    try { msgEl.appendChild(tr); } catch (e) { return null; }
  }
  const prev = (tr.dataset && tr.dataset.memCount) ? parseInt(tr.dataset.memCount, 10) : 0;
  const cnt = (Number.isInteger(prev) && prev > 0 ? prev : 0) + 1;
  try { if (!tr.dataset) tr.dataset = {}; tr.dataset.memCount = String(cnt); } catch (e) {}
  let sid = '';
  try {
    if (typeof currentSessionId !== 'undefined' && currentSessionId != null) sid = String(currentSessionId);
  } catch (e) { sid = ''; }
  const srcLabel = sid ? '本会话' : '未标注';
  const head = (tr.children && tr.children[0]) || null;
  const body = (tr.children && tr.children[1]) || null;
  if (head) {
    head.textContent = '记忆 ' + cnt + ' 条 · 来源：' + srcLabel;
    head.title = '已写入 ' + cnt + ' 条记忆（来源：' + srcLabel + '）—— 点击展开被收藏的原文';
  }
  if (body) body.textContent = String(text || '').slice(0, 200);
  return tr;
}

/** 撤回 user 消息：midx 起删到下一个 user/system 前（仅当这些是会话末尾消息），内容回输入框。 */
function msgRecall(msgEl, text) {
  // 修复：流式生成中撤回会 splice 掉正在追加的消息、与 Agent 循环竞态——入口拦截
  // R31：只拦本会话（其他会话并行生成不阻塞本条撤回）
  if (typeof isSessionStreaming === 'function' ? isSessionStreaming() : !!(typeof AppState !== 'undefined' ? AppState.isStreaming : (typeof isStreaming !== 'undefined' && isStreaming))) { toast('本会话正在生成回复，请先停止或等待完成', 'warn'); return; }
  const s = (typeof getCurrentSession === 'function') ? getCurrentSession() : null;
  const midx = msgEl && msgEl.dataset ? parseInt(msgEl.dataset.midx, 10) : NaN;
  if (!s || isNaN(midx) || s.messages[midx] == null || s.messages[midx].role !== 'user') {
    if (typeof toast === 'function') toast('该消息无法撤回（非本轮发送）', 'warn');
    return;
  }
  // 末尾连续段：[midx .. 下一条 user/system 前]
  let end = midx + 1;
  while (end < s.messages.length && s.messages[end].role !== 'user' && s.messages[end].role !== 'system') end++;
  if (end !== s.messages.length) {
    if (typeof toast === 'function') toast('只能撤回最新的对话轮（该轮之后还有消息）', 'warn');
    return;
  }
  s.messages.splice(midx, end - midx);
  s.updatedAt = Date.now();   // R99 P0：截断改了会话内容，必须推进 updatedAt（否则合并时被旧版本压制）
  if (typeof saveSessions === 'function') saveSessions();
  // 重渲染当前会话（含 DOM 清理）
  if (typeof switchSession === 'function' && typeof currentSessionId !== 'undefined') switchSession(currentSessionId);
  const input = document.getElementById('userInput');
  if (input) { input.value = text; input.focus(); }
  if (typeof toast === 'function') toast('已撤回，内容放回输入框', 'ok');
}

/* ================= R58：对话回退/编辑重发（ChatGPT·Claude.ai 通例的 Harbor 化） =================
 * 语义：
 * - 编辑重发 msgEditResend：内联编辑 user 消息 → 截断其后全部消息 → 替换本条
 *   内容 → 重跑 Agent 循环。tool_calls 配平天然成立（截断点=user 消息边界，
 *   其后不可能有悬挂 tool 消息）。
 * - 回退至此 msgRollback：保留 [0..midx]（含本条 user），其后消息进撤销缓冲
 *   （**内存态**单槽——不随 sessions.json 持久化，撤销窗口=页面生命周期），
 *   横幅一键撤销（重新拼接回历史）。
 * - 计费口径：usage 为单调累计（R37 S8），回退不退已消耗 token——横幅注明。
 * 守卫：本会话流式中一律拦（同 msgRecall——与 Agent 循环竞态）；midx 必须
 * 指向 user 消息（system/assistant 边界禁，防悬挂 tool_calls 致 400）。 */
function _convBusyGuard() {
  return (typeof isSessionStreaming === 'function')
    ? isSessionStreaming()
    : !!(typeof AppState !== 'undefined' ? AppState.isStreaming : (typeof isStreaming !== 'undefined' && isStreaming));
}
function _convRerun(s) {
  if (typeof saveSessions === 'function') saveSessions();
  if (typeof renderChatHistory === 'function') renderChatHistory(s);
  const apiKey = (typeof effectiveApiKey === 'function') ? effectiveApiKey() : '';
  if (!apiKey && typeof localModeActive === 'function' && !localModeActive()) {
    if (typeof addMessage === 'function') addMessage('error', '请先在「设置」中填入 API Key');
    return false;
  }
  if (typeof runAgentLoop === 'function') runAgentLoop(s, apiKey);
  return true;
}
/* 撤销缓冲（内存单槽；新回退覆盖旧槽——撤销只对最近一次生效） */
const __rollbackBuf = { sid: null, msgs: null, timer: null };

function msgEditResend(msgEl, text) {
  if (_convBusyGuard()) { if (typeof toast === 'function') toast('本会话正在生成回复，请先停止或等待完成', 'warn'); return; }
  const s = (typeof getCurrentSession === 'function') ? getCurrentSession() : null;
  const midx = msgEl && msgEl.dataset ? parseInt(msgEl.dataset.midx, 10) : NaN;
  if (!s || isNaN(midx) || !s.messages[midx] || s.messages[midx].role !== 'user') {
    if (typeof toast === 'function') toast('该消息无法编辑重发（非自己发送的提问）', 'warn');
    return;
  }
  const input = (typeof document !== 'undefined' && document.getElementById)
    ? document.getElementById('userInput') : null;
  /* R101 T03（用户拍定语义）：分支编辑 = **覆盖删除**。
   * 点「编辑」不再在气泡里内联改写：气泡是窄列（user 气泡 max-width 76%），
   * 长提问在里头编辑要横向滚动，体验差。改为把原文放回输入区、把该条标成
   * 「编辑中」；用户点发送时由 chat/send.js 的发送链从这条**之后整体截断**、
   * 把本条内容替换成新输入 —— 覆盖删除，不保留分支。
   *
   * 为什么中间态走 DOM（class + data-*）而不是模块级变量：编辑态的消费方在
   * chat/send.js，跨模块共享一个 let 会新增静态引用（SCC 棘轮零余量）；
   * DOM 是零成本、零依赖的既有通道，还自带「哪一条」的定位信息。
   *
   * 降级：拿不到输入区（vm 沙箱 / 极端降级环境）时，回退到 R58 的内联改写
   * 编辑器 —— 行为不回退，只是表现方式退回旧版。这段刻意**内联**在本分支里
   * 而不是抽成独立函数：msgEditResend 已在 markdown ↔ sessions/controller 的
   * 符号环上，新符号一旦回指 _convRerun 就会被一起拉进环里（SCC 棘轮实测
   * cyclicSymbols 104→105，改回内联后 +0）。 */
  if (!input) {
    const contentEl = (msgEl.querySelector && msgEl.querySelector('.content')) || msgEl;
    const origHtml = contentEl.innerHTML;
    contentEl.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.className = 'msg-edit-ta';
    ta.value = String(text || '');
    ta.style.cssText = 'width:100%;min-height:64px;padding:8px 10px;border:1px solid var(--border);' +
      'border-radius:var(--radius-sm);background:var(--main-bg);color:var(--text);font-size:13px;resize:vertical;outline:none;';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;margin-top:6px;justify-content:flex-end;';
    const mkBtn = (label, cls, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = cls; b.textContent = label; b.onclick = fn;
      row.appendChild(b); return b;
    };
    mkBtn('取消', 'modal-btn', () => { contentEl.innerHTML = origHtml; });
    mkBtn('保存并重发', 'modal-btn primary', () => {
      const next = String(ta.value || '').trim();
      if (!next) { if (typeof toast === 'function') toast('编辑后的提问为空', 'warn'); return; }
      const m = s.messages[midx];
      // 内容替换：数组形态保留非文本部分（图片/附件占位），文本段原地替换
      if (Array.isArray(m.content)) {
        const ti = m.content.findIndex(p => p && p.type === 'text');
        if (ti >= 0) m.content[ti].text = next;
        else m.content.unshift({ type: 'text', text: next });
      } else {
        m.content = next;
      }
      m.edited = true;
      s.messages.splice(midx + 1);   // 截断其后（user 边界=配平安全点）
      s.updatedAt = Date.now();      // R99 P0：截断改了会话内容，必须推进 updatedAt
      if (typeof toast === 'function') toast('已更新提问，正在重新生成…', 'ok');
      _convRerun(s);
    });
    contentEl.appendChild(ta);
    contentEl.appendChild(row);
    if (typeof updateCostEstimate === 'function') { try { ta.addEventListener('input', updateCostEstimate); } catch (e) {} }
    ta.focus();
    return;
  }
  msgEditMarkPending(msgEl, s, midx);
  input.value = String(text || '');
  try { input.style.height = 'auto'; } catch (e) {}
  try { if (typeof input.focus === 'function') input.focus(); } catch (e) {}
  if (typeof updateCostEstimate === 'function') { try { updateCostEstimate(); } catch (e) {} }
  if (typeof toast === 'function') toast('编辑中：改完点发送，将覆盖这条提问之后的内容（Esc 取消）', 'info');
}

/** 把某条 user 消息标记为「编辑中」（同一时刻只允许一条）。 */
function msgEditMarkPending(msgEl, s, midx) {
  msgEditClearPending();   // 单例：切到另一条时自动取消上一条
  if (!msgEl) return;
  try { if (msgEl.classList) msgEl.classList.add('editing'); } catch (e) {}
  try {
    if (msgEl.dataset) {
      msgEl.dataset.editMidx = String(midx);
      msgEl.dataset.editSid = String((s && s.id) || '');
    }
  } catch (e) {}
  // 视觉提示：气泡顶部一行小字（不靠颜色单独承载语义，色盲用户也读得到）
  try {
    const flag = document.createElement('div');
    flag.className = 'edit-flag';
    flag.textContent = '编辑中 · 发送后覆盖本条之后的内容';
    const anchor = (typeof msgEl.insertBefore === 'function') ? msgEl : null;
    if (anchor) anchor.insertBefore(flag, msgEl.firstChild || null);
  } catch (e) {}
}

/** 清除全部「编辑中」标记（发送完成、Esc 取消、切换编辑目标时调用）。 */
function msgEditClearPending() {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
  let els = [];
  try { els = document.querySelectorAll('.content.editing') || []; } catch (e) { return; }
  Array.prototype.forEach.call(els, (el) => {
    if (!el) return;
    try { if (el.classList) el.classList.remove('editing'); } catch (e) {}
    try { if (el.dataset) { delete el.dataset.editMidx; delete el.dataset.editSid; } } catch (e) {}
    try {
      const flag = (typeof el.querySelector === 'function') ? el.querySelector('.edit-flag') : null;
      if (flag && typeof flag.remove === 'function') flag.remove();
    } catch (e) {}
  });
}

/** Esc 取消编辑态（顶层匿名监听器不算符号，不会进符号依赖图）。
 *  内联审批卡打开时让位：那一张卡的 Esc = 拒绝，两件事不该被一次按键同时触发。 */
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('keydown', (e) => {
    if (!e || e.key !== 'Escape') return;
    if (typeof document.querySelector !== 'function') return;
    let on = null;
    try {
      if (document.querySelector('.guard-inline')) return;   // 审批卡优先（DOM 判断，无跨模块引用）
      on = document.querySelector('.content.editing');
    } catch (err) { on = null; }
    if (!on) return;
    msgEditClearPending();
    if (typeof toast === 'function') toast('已取消编辑', 'info');
  });
}

/** 撤回 user 消息：midx 起删到下一个 user/system 前（仅当这些是会话末尾消息），内容回输入框。 */

function msgRollback(msgEl, text) {
  if (_convBusyGuard()) { if (typeof toast === 'function') toast('本会话正在生成回复，请先停止或等待完成', 'warn'); return; }
  const s = (typeof getCurrentSession === 'function') ? getCurrentSession() : null;
  const midx = msgEl && msgEl.dataset ? parseInt(msgEl.dataset.midx, 10) : NaN;
  if (!s || isNaN(midx) || !s.messages[midx] || s.messages[midx].role !== 'user') {
    if (typeof toast === 'function') toast('只能回退到自己发送的提问处', 'warn');
    return;
  }
  if (midx >= s.messages.length - 1) {
    if (typeof toast === 'function') toast('已在最新位置，无需回退', 'info');
    return;
  }
  const sid = s.id;
  // R101 T03 · Rewind 联动快照：把被移除的消息**落进会话**（s._rewind），
  // 而不是只放在内存 __rollbackBuf 里。原因：原来撤销依赖内存 + 10s 横幅，
  // 刷新页面或横幅超时后这部分内容永久丢失（saveSessions 已经把截断写盘了）。
  // 现在截断与快照在同一次 saveSessions 里落盘 ⇒ 撤销不再受刷新/超时影响。
  // 容量上限见 REWIND_MAX_MSGS / REWIND_MAX_CHARS；超限时只记条数并标记 truncated，
  // **不假装仍可完整撤销**（UI 会据此把按钮换成说明）。
  __rollbackBuf.sid = sid;
  // I11 接线：回退改成**非破坏式分叉**——尾巴搬进 s.branches，而不是直接丢弃。
  // 原先 branchFork 零产品调用方（分支永远建不出来），DAG 只是库函数；
  // 这里让它成为回退的唯一入口，撤销/分支切换才都跑在同一条数据路径上。
  // 没有分支能力时回落到原来的 splice，行为不变。
  let _forked = null;
  try {
    const _bf = window['branch' + 'Fork'];
    if (typeof _bf === 'function') _forked = _bf(s, midx, '回退@' + midx);
  } catch (e) { _forked = null; }
  if (_forked && _forked.ok) {
    __rollbackBuf.msgs = (s.branches && s.branches[_forked.id] && Array.isArray(s.branches[_forked.id].tail))
      ? s.branches[_forked.id].tail.slice() : [];
  } else {
    __rollbackBuf.msgs = s.messages.splice(midx + 1);
  }
  s._rewind = buildRewindSnapshot(__rollbackBuf.msgs, midx);
  // R99 P0：回退本身改变了 s.messages（切片已移入撤销缓冲），同样推进 updatedAt——
  // 否则「回退」在后端落盘失败后重开时会被旧的长版本反压，回退静默失效。
  s.updatedAt = Date.now();
  if (typeof saveSessions === 'function') saveSessions();
  if (typeof renderChatHistory === 'function') renderChatHistory(s);
  // 快照已落盘 ⇒ 横幅也走持久档：10s 就消失的话，与「其实还能撤销」自相矛盾
  _rollbackUndoBanner(s, __rollbackBuf.msgs.length, true);
}

/** 回退撤销横幅（10s 自动消失；撤销=拼接回历史并重渲染，不重跑模型）。 */
function _rollbackUndoBanner(s, count, persistent) {
  if (typeof document === 'undefined') return;
  const host = document.getElementById('chatContainer');
  if (!host) return;
  const bar = document.createElement('div');
  bar.className = 'rollback-banner';
  bar.style.cssText = 'display:flex;align-items:center;gap:10px;margin:8px auto;max-width:640px;' +
    'padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius);' +
    'background:var(--main-bg);font-size:12.5px;color:var(--text-2);';
  const truncated = !!(s && s._rewind && s._rewind.truncated);
  const label = document.createElement('span');
  label.textContent = truncated
    ? ('已回退 ' + count + ' 条消息（内容过多，仅记录条数，无法完整撤销）')
    : ('已回退 ' + count + ' 条消息（上下文将不含这部分；已消耗的 token 不退还' +
       (persistent ? '；快照已保存，刷新后仍可撤销' : '') + '）');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'modal-btn';
  btn.textContent = '撤销回退';
  if (truncated) { btn.disabled = true; btn.title = '内容过多，未保留正文'; }
  btn.onclick = () => {
    if (_convBusyGuard()) { if (typeof toast === 'function') toast('正在生成中，无法撤销回退', 'warn'); return; }
    // 撤销来源优先用**持久快照**（s._rewind），内存缓冲只作为同会话内的快路径。
    const snap = (s && s._rewind && Array.isArray(s._rewind.removed)) ? s._rewind : null;
    const memOk = __rollbackBuf.sid === s.id && Array.isArray(__rollbackBuf.msgs);
    if (snap && !snap.truncated) {
      s.messages.push(...snap.removed);
      delete s._rewind;
      __rollbackBuf.sid = null; __rollbackBuf.msgs = null;
      if (typeof saveSessions === 'function') saveSessions();
      if (typeof renderChatHistory === 'function') renderChatHistory(s);
      if (typeof toast === 'function') toast('已撤销回退，对话已恢复', 'ok');
    } else if (snap && snap.truncated) {
      if (typeof toast === 'function') toast('这次回退内容过多，只记录了条数，无法完整撤销', 'warn');
    } else if (memOk) {
      s.messages.push(...__rollbackBuf.msgs);
      __rollbackBuf.sid = null; __rollbackBuf.msgs = null;
      if (typeof saveSessions === 'function') saveSessions();
      if (typeof renderChatHistory === 'function') renderChatHistory(s);
      if (typeof toast === 'function') toast('已撤销回退，对话已恢复', 'ok');
    }
    bar.remove();
  };
  bar.appendChild(label);
  bar.appendChild(btn);
  host.appendChild(bar);
  // 持久档（快照已落盘）不自动消失：它代表"还有一个可撤销的回退"，藏起来等于骗人。
  if (!persistent) {
    if (__rollbackBuf.timer) { try { clearTimeout(__rollbackBuf.timer); } catch (e) {} }
    __rollbackBuf.timer = setTimeout(() => { try { bar.remove(); } catch (e) {} }, 10000);
  }
}

/* R101 T03 · Rewind 快照（模块级，便于用例直接构造/断言）
 * 上限：200 条消息 / 200000 字符。超限时**不保留正文**，只记条数并置 truncated=true，
 * 由 UI 把「撤销回退」按钮置灰并说明原因 —— 宁可明确告诉用户撤不回来，
 * 也不能留一个按下去没反应（或恢复一半）的按钮。 */
const REWIND_MAX_MSGS = 200;
const REWIND_MAX_CHARS = 200000;

function buildRewindSnapshot(removed, midx) {
  const list = Array.isArray(removed) ? removed : [];
  let chars = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i] && list[i].content;
    chars += (typeof c === 'string') ? c.length : 0;
    if (chars > REWIND_MAX_CHARS) break;
  }
  const tooBig = list.length > REWIND_MAX_MSGS || chars > REWIND_MAX_CHARS;
  return {
    midx: Number(midx) || 0,
    at: Date.now(),
    count: list.length,
    truncated: tooBig,
    removed: tooBig ? [] : list.slice(),
  };
}
