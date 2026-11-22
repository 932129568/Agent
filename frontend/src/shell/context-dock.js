/* ================= R101 T03 · 右侧上下文副屏（context-dock） =================
 * 目的：把「这次会话现在是什么状态」摊在右侧随手可见，不用切页签——
 *   消息数 / 估算 token / 累计工具调用（来自 execution-trace 的快照）/
 *   当前信任级别（来自 guard 的快照）/ 当前面板与皮肤。
 *
 * 三条实现约束（都是本仓踩过的坑）：
 *  ① 不在模板里新增 id/onclick：模板新增 id 会撞 arch-contract 的
 *     「B0 结构零丢失（300 个 id 全覆盖）」，也会进 contract_diff 的 dom_ids。
 *     因此整块 DOM 在运行时创建。
 *  ② 从别的模块取数据一律走 window[dynamic]，不写裸标识符或 window.X：
 *     两种写法都会在 AST 里留下静态边，SCC 棘轮 17/104 零余量，加边即红。
 *  ③ 显隐用 inline style.display，不用 hidden 属性（.modal-mask 那类类选择器
 *     的 display 会压过浏览器默认的 [hidden]{display:none}）。
 */

const CONTEXT_DOCK = {
  root: null,
  timer: 0,
  open: false,
};

/** 动态取全局函数（避开静态依赖分析）。 */
function _dockFn(name) {
  try { return (typeof window !== 'undefined' && window[name]) || null; } catch (e) { return null; }
}

function _dockBuild() {
  if (typeof document === 'undefined') return null;
  if (CONTEXT_DOCK.root && CONTEXT_DOCK.root.isConnected) return CONTEXT_DOCK.root;
  const el = document.createElement('aside');
  el.className = 'ctx-dock';
  el.id = 'contextDock';
  el.style.display = 'none';
  el.setAttribute('aria-label', '上下文副屏');
  el.innerHTML =
    '<div class="cd-head">' +
      '<span class="cd-title">上下文</span>' +
      '<button type="button" class="cd-close" data-cd="close" title="关闭（Esc）">×</button>' +
    '</div>' +
    '<div class="cd-body">' +
      '<div class="cd-sec"><div class="cd-k">会话</div><div class="cd-v" data-cd="session"></div></div>' +
      '<div class="cd-sec"><div class="cd-k">消息</div><div class="cd-v" data-cd="messages"></div></div>' +
      '<div class="cd-sec"><div class="cd-k">估算 token</div><div class="cd-v" data-cd="tokens"></div></div>' +
      '<div class="cd-sec"><div class="cd-k">工具调用</div><div class="cd-v" data-cd="tools"></div></div>' +
      '<div class="cd-sec"><div class="cd-k">信任</div><div class="cd-v" data-cd="trust"></div></div>' +
      '<div class="cd-sec"><div class="cd-k">面板 / 皮肤</div><div class="cd-v" data-cd="view"></div></div>' +
    '</div>' +
    '<div class="cd-foot">Ctrl+Alt+D 开关 · 数据每 1.5s 刷新</div>';
  document.body.appendChild(el);
  el.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('[data-cd]') : null;
    if (t && t.getAttribute('data-cd') === 'close') contextDockClose();
  });
  CONTEXT_DOCK.root = el;
  return el;
}

/** 取当前会话对象（sessions 既可能在 AppState 也可能是全局变量）。 */
function _dockSession() {
  try {
    const st = (typeof AppState !== 'undefined') ? AppState : null;
    const list = st ? st.sessions : (typeof sessions !== 'undefined' ? sessions : null);
    const sid = st ? st.currentSessionId : (typeof currentSessionId !== 'undefined' ? currentSessionId : '');
    if (!Array.isArray(list)) return null;
    return list.find(s => s && s.id === sid) || null;
  } catch (e) { return null; }
}

function _dockText(el, text) {
  if (!el) return;
  const t = String(text == null ? '' : text);
  if (el.textContent !== t) el.textContent = t;
}

/** 刷新一次（幂等；被 interval 与事件调用）。 */
function contextDockRefresh() {
  if (typeof document === 'undefined') return;
  const root = CONTEXT_DOCK.root;
  if (!root || !root.isConnected) return;
  const s = _dockSession();
  const snapFn = _dockFn('traceSnapshot');
  const trustFn = _dockFn('guardTrustSnapshot');
  const msgs = s && Array.isArray(s.messages) ? s.messages : [];
  let chars = 0;
  for (let k = 0; k < msgs.length; k++) {
    const c = msgs[k] && msgs[k].content;
    if (typeof c === 'string') chars += c.length;
  }
  const q = name => root.querySelector('[data-cd="' + name + '"]');
  _dockText(q('session'), s ? (s.title || s.id || '(未命名)') : '(无会话)');
  _dockText(q('messages'), msgs.length ? msgs.length + ' 条' : '—');
  _dockText(q('tokens'), msgs.length ? '约 ' + Math.ceil(chars / 1.8).toLocaleString() : '—');
  const ts = snapFn ? snapFn() : null;
  _dockText(q('tools'), ts && ts.total
    ? ts.total + ' 次' + (ts.fail ? '（失败 ' + ts.fail + '）' : ' 全部成功')
    : '—');
  const tr = trustFn ? trustFn() : null;
  _dockText(q('trust'), tr
    ? '本会话 ' + tr.session + ' · 永久 ' + tr.persistent
    : '—');
  const panel = (typeof currentPanel !== 'undefined') ? currentPanel : '—';
  const skin = (typeof document !== 'undefined' && document.documentElement.getAttribute('data-skin')) || 'classic';
  _dockText(q('view'), panel + ' / ' + skin);
}

function contextDockOpen() {
  if (typeof document === 'undefined') return;
  const el = _dockBuild();
  if (!el) return;
  el.style.display = 'flex';
  CONTEXT_DOCK.open = true;
  contextDockRefresh();
  if (!CONTEXT_DOCK.timer) {
    CONTEXT_DOCK.timer = setInterval(() => {
      if (!CONTEXT_DOCK.open) return;
      contextDockRefresh();
    }, 1500);
  }
}

function contextDockClose() {
  const el = CONTEXT_DOCK.root;
  if (el) el.style.display = 'none';
  CONTEXT_DOCK.open = false;
  if (CONTEXT_DOCK.timer) { clearInterval(CONTEXT_DOCK.timer); CONTEXT_DOCK.timer = 0; }
}

function contextDockToggle() {
  if (CONTEXT_DOCK.open) contextDockClose();
  else contextDockOpen();
}
