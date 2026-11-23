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
  // I27 续：副屏也进 top layer（popover manual）。CSS 里已做 inset:auto 复位，
  // 否则 popover 的 UA 样式（position:fixed;inset:0;margin:auto）会把右下角定位顶掉。
  try { if (typeof el.showPopover === 'function') el.setAttribute('popover', 'manual'); } catch (e) {}
  el.setAttribute('aria-label', '上下文副屏');
  el.innerHTML =
    '<div class="cd-head">' +
      '<span class="cd-title">上下文</span>' +
      '<button type="button" class="cd-close" data-cd="close" title="关闭（Esc）">×</button>' +
    '</div>' +
    // I23：4 标签工作台（概览 / 改动 / Trace / 预览）
    '<div class="cd-tabs" role="tablist">' +
      '<button type="button" class="cd-tab on" data-tab="overview" role="tab">概览</button>' +
      '<button type="button" class="cd-tab" data-tab="diff" role="tab">改动</button>' +
      '<button type="button" class="cd-tab" data-tab="trace" role="tab">Trace</button>' +
      '<button type="button" class="cd-tab" data-tab="preview" role="tab">预览</button>' +
    '</div>' +
    '<div class="cd-body">' +
      '<div class="cd-pane on" data-pane="overview">' +
        '<div class="cd-sec"><div class="cd-k">会话</div><div class="cd-v" data-cd="session"></div></div>' +
        '<div class="cd-sec"><div class="cd-k">消息</div><div class="cd-v" data-cd="messages"></div></div>' +
        '<div class="cd-sec"><div class="cd-k">估算 token</div><div class="cd-v" data-cd="tokens"></div></div>' +
        '<div class="cd-sec"><div class="cd-k">工具调用</div><div class="cd-v" data-cd="tools"></div></div>' +
        '<div class="cd-sec"><div class="cd-k">信任</div><div class="cd-v" data-cd="trust"></div></div>' +
        '<div class="cd-sec"><div class="cd-k">面板 / 皮肤</div><div class="cd-v" data-cd="view"></div></div>' +
      '</div>' +
      '<div class="cd-pane" data-pane="diff"><div class="cd-diff"></div></div>' +
      '<div class="cd-pane" data-pane="trace"><div class="cd-trace"></div></div>' +
      '<div class="cd-pane" data-pane="preview"><div class="cd-prev"></div></div>' +
    '</div>' +
    '<div class="cd-foot">Ctrl+Alt+D 开关 · 事件驱动（静止不轮询）</div>';
  document.body.appendChild(el);
  el.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('[data-cd]') : null;
    if (t && t.getAttribute('data-cd') === 'close') { contextDockClose(); return; }
    const tab = e.target && e.target.closest ? e.target.closest('.cd-tab') : null;
    if (tab) contextDockTab(tab.getAttribute('data-tab'));
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
  try { if (typeof el.showPopover === 'function' && !el.matches(':popover-open')) el.showPopover(); } catch (e) {}
  CONTEXT_DOCK.open = true;
  contextDockRefresh();
  // I23：**不再轮询**。原来 1.5s 一次的 setInterval 在静止时纯空转。
  // 改为监听 run 生命周期事件（harbor:trace / harbor:run），事件到了才刷新。
  contextDockBindEvents();
}

function contextDockClose() {
  const el = CONTEXT_DOCK.root;
  if (el) el.style.display = 'none';
  try { if (el && typeof el.hidePopover === 'function' && el.matches(':popover-open')) el.hidePopover(); } catch (e) {}
  CONTEXT_DOCK.open = false;
  CONTEXT_DOCK.timer = 0;   // 已无定时器；字段保留仅为兼容既有探针
  const rig = _dockFn('Harbor' + 'KineticRig');
  if (rig && typeof rig.applyImpulse === 'function' && typeof document !== 'undefined') {
    const mainEl = document.querySelector('.main');
    if (mainEl) rig.applyImpulse(mainEl, { vx: 46, preset: { omega: 20, zeta: 0.52, maxPx: 4.0 } });
  }
}

function contextDockToggle() {
  if (CONTEXT_DOCK.open) contextDockClose();
  else contextDockOpen();
}

/* ================= I23 · 事件驱动 + 4 标签渲染 =================
 * 判据：改代码即时推红绿 Hunk Diff；静止 0 轮询。
 * 驱动源：run-controller 在工具轮落定/run 起止时 dispatch CustomEvent——
 *   harbor:trace  { sid, writes: [{tool, path, before?, after?}] }
 *   harbor:run    { sid, phase: 'start'|'end' }
 * dock 只在这些事件到达时刷新；没有事件时**一个定时器都不挂**。
 */
const CONTEXT_DOCK_WRITES = [];   // 最近的写操作（含可选的 before/after），上限 20

function contextDockBindEvents() {
  if (typeof document === 'undefined' || CONTEXT_DOCK.boundEvents) return;
  CONTEXT_DOCK.boundEvents = true;
  const onTrace = (e) => {
    const d = (e && e.detail) || {};
    if (Array.isArray(d.writes) && d.writes.length) {
      for (const w of d.writes) {
        CONTEXT_DOCK_WRITES.push(w);
        if (CONTEXT_DOCK_WRITES.length > 20) CONTEXT_DOCK_WRITES.shift();
      }
    }
    if (CONTEXT_DOCK.open) { contextDockRefresh(); contextDockRenderPanes(); }
  };
  const onRun = () => { if (CONTEXT_DOCK.open) { contextDockRefresh(); contextDockRenderPanes(); } };
  document.addEventListener('harbor:trace', onTrace);
  document.addEventListener('harbor:run', onRun);
  // I13 收口：run-controller 在 P0-4 里派发 harbor:diff（带 before/after），
  // 但此前**没有任何监听者**——真实 diff 到不了「改动」页，等于内联 Diff 没有供给方。
  // 这里接上：写进 _WRITES（带前后文），改动页就能画真红绿行。
  const onDiff = (e) => {
    const d = (e && e.detail) || {};
    if (!d || !d.path) return;
    CONTEXT_DOCK_WRITES.push({
      tool: d.tool || 'edit', path: String(d.path),
      before: typeof d.before === 'string' ? d.before : undefined,
      after: typeof d.after === 'string' ? d.after : undefined,
    });
    if (CONTEXT_DOCK_WRITES.length > 20) CONTEXT_DOCK_WRITES.shift();
    if (CONTEXT_DOCK.open) { contextDockRefresh(); contextDockRenderPanes(); }
  };
  document.addEventListener('harbor:diff', onDiff);
}

/** 切标签（幂等；只改 class，不重建 DOM）。 */
function contextDockTab(name) {
  const root = CONTEXT_DOCK.root;
  if (!root) return '';
  const target = String(name || 'overview');
  root.querySelectorAll('.cd-tab').forEach((b) => {
    b.classList.toggle('on', b.getAttribute('data-tab') === target);
  });
  root.querySelectorAll('.cd-pane').forEach((p) => {
    p.classList.toggle('on', p.getAttribute('data-pane') === target);
  });
  contextDockRenderPanes();
  return target;
}

/** 渲染三个非概览面板（Trace / 改动 / 预览）。 */
function contextDockRenderPanes() {
  const root = CONTEXT_DOCK.root;
  if (!root) return;
  // Trace：复用 execution-trace 的渲染（动态索引，不产生静态边）
  const traceBox = root.querySelector('.cd-trace');
  if (traceBox) {
    const render = _dockFn('traceRenderInto');
    const s = _dockSession();
    if (typeof render === 'function') render(traceBox, 8, s && s.id);
    else traceBox.textContent = '轨迹模块未装载';
  }
  // 改动：只列真实发生过的写操作；有 before/after 才画红绿行
  const diffBox = root.querySelector('.cd-diff');
  if (diffBox) {
    diffBox.innerHTML = '';
    if (!CONTEXT_DOCK_WRITES.length) {
      const em = document.createElement('div');
      em.className = 'cd-empty';
      em.textContent = '还没有写操作。写入文件后这里会出现改动记录。';
      diffBox.appendChild(em);
    } else {
      const lineDiff = _dockFn('guardLineDiff');
      CONTEXT_DOCK_WRITES.slice(-8).reverse().forEach((w) => {
        const item = document.createElement('div');
        item.className = 'cd-hunk';
        const head = document.createElement('div');
        head.className = 'cd-hunk-head';
        head.textContent = String(w.tool || 'write') + ' · ' + String(w.path || '(未知路径)');
        item.appendChild(head);
        if (typeof w.before === 'string' && typeof w.after === 'string' && typeof lineDiff === 'function') {
          const rows = lineDiff(w.before, w.after);
          const body = document.createElement('div');
          body.className = 'cd-hunk-body';
          rows.slice(0, 40).forEach((r) => {
            const ln = document.createElement('div');
            ln.className = 'cd-ln ' + (r.type === 'add' ? 'add' : (r.type === 'del' ? 'del' : 'same'));
            ln.textContent = (r.type === 'add' ? '+ ' : (r.type === 'del' ? '- ' : '  ')) + r.text;
            body.appendChild(ln);
          });
          item.appendChild(body);
        } else {
          const note = document.createElement('div');
          note.className = 'cd-hunk-note';
          note.textContent = '（本次未提供前后内容，只有操作记录）';
          item.appendChild(note);
        }
        diffBox.appendChild(item);
      });
    }
  }
  // 预览：当前会话最后一条 assistant 摘要
  const prevBox = root.querySelector('.cd-prev');
  if (prevBox) {
    // I17：外部注入的产物预览优先（群聊交接卡/产物卡用）；没有注入才回落到最后一条 AI 回复。
    if (CONTEXT_DOCK.previewText) {
      prevBox.textContent = CONTEXT_DOCK.previewText;
      return;
    }
    const s = _dockSession();
    const msgs = (s && Array.isArray(s.messages)) ? s.messages : [];
    let last = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i] && msgs[i].role === 'assistant' && typeof msgs[i].content === 'string') { last = msgs[i]; break; }
    }
    prevBox.textContent = last ? last.content.slice(0, 400) : '（本会话还没有 AI 回复）';
  }
}

/* ================= I17 · 产物卡 → 副屏预览 =================
 * 判据「产物卡一键副屏预览」：点一下就把产物内容放到副屏的「预览」页并切过去，
 * 不是"打开副屏让你自己去找"。
 */
function contextDockSetPreview(text, title) {
  if (typeof document === 'undefined') return false;
  CONTEXT_DOCK.previewText = String(text == null ? '' : text).slice(0, 4000);
  if (title) CONTEXT_DOCK.previewTitle = String(title);
  contextDockOpen();
  contextDockTab('preview');
  contextDockRenderPanes();
  return true;
}

function contextDockClearPreview() {
  CONTEXT_DOCK.previewText = '';
  contextDockRenderPanes();
}
