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
  container.scrollTop = container.scrollHeight;
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
    // 编辑：内容回输入框（不删消息）
    mk(MSG_ICONS.edit, '编辑（内容放回输入框）', (b) => {
      const input = document.getElementById('userInput');
      if (input) { input.value = text; input.focus(); updateCostEstimate(); }
    });
  } else {
    mk(MSG_ICONS.regen, '重新生成', () => { if (typeof regenerate === 'function') regenerate(); });
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
  if (isStreaming) { toast('正在生成回复，请先停止或等待完成', 'warn'); return; }
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
  if (typeof saveSessions === 'function') saveSessions();
  // 重渲染当前会话（含 DOM 清理）
  if (typeof switchSession === 'function' && typeof currentSessionId !== 'undefined') switchSession(currentSessionId);
  const input = document.getElementById('userInput');
  if (input) { input.value = text; input.focus(); }
  if (typeof toast === 'function') toast('已撤回，内容放回输入框', 'ok');
}

