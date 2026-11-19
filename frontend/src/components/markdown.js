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
    <div class="content ${role === 'error' ? 'error' : ''}">${body}${extraHtml}</div>
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
      } catch (e) { flash(b, 'fail'); }
    });
  }
  msgEl.appendChild(bar);
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
  const contentEl = msgEl.querySelector('.content') || msgEl;
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
}

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
  __rollbackBuf.sid = sid;
  __rollbackBuf.msgs = s.messages.splice(midx + 1);
  // R99 P0：回退本身改变了 s.messages（切片已移入撤销缓冲），同样推进 updatedAt——
  // 否则「回退」在后端落盘失败后重开时会被旧的长版本反压，回退静默失效。
  s.updatedAt = Date.now();
  if (typeof saveSessions === 'function') saveSessions();
  if (typeof renderChatHistory === 'function') renderChatHistory(s);
  _rollbackUndoBanner(s, __rollbackBuf.msgs.length);
}

/** 回退撤销横幅（10s 自动消失；撤销=拼接回历史并重渲染，不重跑模型）。 */
function _rollbackUndoBanner(s, count) {
  if (typeof document === 'undefined') return;
  const host = document.getElementById('chatContainer');
  if (!host) return;
  const bar = document.createElement('div');
  bar.className = 'rollback-banner';
  bar.style.cssText = 'display:flex;align-items:center;gap:10px;margin:8px auto;max-width:640px;' +
    'padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius);' +
    'background:var(--main-bg);font-size:12.5px;color:var(--text-2);';
  const label = document.createElement('span');
  label.textContent = '已回退 ' + count + ' 条消息（上下文将不含这部分；已消耗的 token 不退还）';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'modal-btn';
  btn.textContent = '撤销回退';
  btn.onclick = () => {
    if (_convBusyGuard()) { if (typeof toast === 'function') toast('正在生成中，无法撤销回退', 'warn'); return; }
    if (__rollbackBuf.sid === s.id && Array.isArray(__rollbackBuf.msgs)) {
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
  if (__rollbackBuf.timer) { try { clearTimeout(__rollbackBuf.timer); } catch (e) {} }
  __rollbackBuf.timer = setTimeout(() => { try { bar.remove(); } catch (e) {} }, 10000);
}

