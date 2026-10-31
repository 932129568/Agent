/* ================= Toast 通知与模态确认（v1.2 R3 + R2 载体） =================
 * toast：三态（ok/warn/err）视觉分离、队列纵向堆叠不重叠、可手动关闭、自动消失（err 停留更久）。
 * uiConfirm / uiPrompt：alert()/confirm() 的应用内替代品（R3），也是 R2 破坏性操作确认框。
 * 纯新增模块，不改动任何既有 DOM id / CSS 类 / callApi 契约。
 */

/* ---- Toast ---- */

/* 实现 v1.6 T13：DND 免打扰——窗口失焦（document.hidden / blur）时抑制非关键
 * toast（ok/info 级；warn/err 仍弹）。被抑制项入通知中心（41-nav 的
 * navRenderNotify 渲染；聚焦时红点清零）。开关存 localStorage['glm_dnd']
 * （UI 偏好独立存储，不污染 config.json——契约红线）。 */
const DND_SUPPRESS_TYPES = ['ok', 'info'];
let _notifyItems = [];   // 通知中心数据（41-nav 消费；模块 18 先于 41 拼接，声明在前）

function dndEnabled() {
  try { return localStorage.getItem('glm_dnd') === '1'; } catch (e) { return false; }
}

/** DND 生效中 = 开关开 且 窗口失焦/最小化。 */
function dndSuppressActive() {
  if (!dndEnabled() || typeof document === 'undefined') return false;
  try {
    return document.hidden === true || document.hasFocus() === false;
  } catch (e) { return false; }
}

/** 入通知中心（供 navRenderNotify 渲染 + 红点数）。 */
function notifyPush(msg, type) {
  _notifyItems.unshift({ msg: String(msg || ''), type: type || 'info', at: Date.now() });
  if (_notifyItems.length > 50) _notifyItems.pop();
  if (typeof navRenderNotify === 'function') navRenderNotify();
}

/** 设置面板回填（110-boot 调用）。 */
function loadDndSetting() {
  const el = document.getElementById('dndEnabled');
  if (el) el.checked = dndEnabled();
}

/** 设置面板保存（checkbox onchange）。 */
function saveDndSetting() {
  const el = document.getElementById('dndEnabled');
  const on = !!(el && el.checked);
  try { localStorage.setItem('glm_dnd', on ? '1' : '0'); } catch (e) {}
  toast(on ? '已开启免打扰：失焦时非关键提示将进入通知中心' : '已关闭免打扰', 'ok');
}

const _toastBox = (() => {
  let box = null;
  return () => {
    if (!box || !document.body.contains(box)) {
      box = document.createElement('div');
      box.id = 'toastBox';
      document.body.appendChild(box);
    }
    return box;
  };
})();

/**
 * toast(msg, type='info', opts={stay, detail})
 *  type: 'ok' | 'warn' | 'err' | 'info'
 */
function toast(msg, type, opts) {
  type = type || 'info';
  opts = opts || {};
  // 实现 v1.6 T13：DND 抑制——ok/info 非关键提示在窗口失焦时入通知中心不弹窗
  // （opts.force 可强制弹，如更新提示等长流程；warn/err 永不被抑制）
  if (!opts.force && DND_SUPPRESS_TYPES.indexOf(type) !== -1 && dndSuppressActive()) {
    if (typeof notifyPush === 'function') notifyPush(msg, type);
    return null;
  }
  const box = _toastBox();
  // v4：队列溢出优先让最旧的走退场动画（无 close 句柄才直接移除）
  // 修复 fe-H2（四轮）：原 while + old.close() 在动画模式下死循环——close() 的
  // remove() 在 onAnimEnd 异步执行（≥140ms），同步循环内 children.length 永不下降，
  // 第二轮起 __closing 幂等守卫直接 return，第 6 个 toast 冻结整个 UI（错误风暴
  // 5~6 条并发完全可能）。改为单次判断 + 强制同步移除（溢出场景无需退场动画）。
  if (box.children.length >= 5) {
    // 修复（建议15）：淘汰目标从「无脑删队首」改为「队首向后找第一个非 pinned」——
    // pinned toast（下载/更新等长流程进度，ttl=Infinity）被误删时流程仍在跑但
    // 进度提示凭空消失。全 pinned 时不删（允许临时超过 5 条：长流程提示不丢
    // 优于队列封顶；pinned 生命周期由调用方 t.close 收尾）。
    let victim = null;
    for (let i = 0; i < box.children.length; i++) {
      if (!box.children[i].__pinned) { victim = box.children[i]; break; }
    }
    if (victim) {
      if (victim.close) { try { victim.__closing = true; } catch (e) {} }
      try { box.removeChild(victim); } catch (e) {}
    }
  }
  const t = document.createElement('div');
  t.className = 'toast toast-' + type;
  const icon = type === 'ok' ? '✓' : type === 'warn' ? '△' : type === 'err' ? '✕' : 'ℹ';
  t.innerHTML = '<span class="toast-ico">' + icon + '</span>' +
    '<span class="toast-msg"></span>' +
    (opts.detail ? '<button class="toast-more">明细</button>' : '') +
    '<button class="toast-close" aria-label="关闭通知">✕</button>';
  // v4：首行作粗体标题（长文案首行即摘要，短文案整体标题化）——
  // 修复旧版纯文本一坨、错误场景「请求失败」与详情无层次
  {
    const raw = String(msg == null ? '' : msg);
    const nl = raw.indexOf('\n');
    const msgEl = t.querySelector('.toast-msg');
    if (nl > 0) {
      const b = document.createElement('b');
      b.className = 'toast-title';
      b.textContent = raw.slice(0, nl);
      msgEl.appendChild(b);
      msgEl.appendChild(document.createTextNode(raw.slice(nl)));
    } else {
      const b = document.createElement('b');
      b.className = 'toast-title';
      b.textContent = raw;
      msgEl.appendChild(b);
    }
  }
  // v4：__closing 去重 + MOTION.onAnimEnd 双兜底（.out 的 140ms 过渡结束即拆；
  //   桩环境无事件监听时 setTimeout 兜底，instant 降级立即拆）
  const close = () => {
    if (t.__closing) return;
    t.__closing = true;
    t.classList.add('out');
    if (typeof MOTION !== 'undefined' && !MOTION.instant()) {
      MOTION.onAnimEnd(t, 'transitionend', MOTION.compOut()).then(() => { try { t.remove(); } catch (e) {} });
    } else { try { t.remove(); } catch (e) {} }
  };
  t.querySelector('.toast-close').onclick = close;
  if (opts.detail) {
    t.querySelector('.toast-more').onclick = () => {
      let d = t.querySelector('.toast-detail');
      if (!d) { d = document.createElement('div'); d.className = 'toast-detail'; d.textContent = opts.detail; t.appendChild(d); }
      else d.style.display = d.style.display === 'none' ? '' : 'none';
    };
  }
  box.appendChild(t);
  const ttl = opts.pinned ? Infinity : (opts.stay ? 60000 : (type === 'err' ? 9000 : type === 'warn' ? 6500 : 4500));   // 修复 ㊵：pinned 永不自动消失（下载/更新等长流程进度）
  if (isFinite(ttl)) setTimeout(close, ttl);
  t.close = close;   // 修复 ㊵：暴露关闭句柄供调用方在流程结束时收尾
  t.__pinned = !!opts.pinned;   // 修复（建议15）：pinned 标记——溢出淘汰时跳过（长流程进度提示不误删）
  return t;
}

/* ---- 模态层 ---- */
let _uiConfirmResolve = null;   // 修复 S22：当前挂起确认的兜底 resolve（模态被外部关闭时按「取消」收尾）
let _uiPromptResolve = null;    // 修复 W22（二轮）：uiPrompt 的兜底 resolve（原其 Promise 永不 settle）
let _uiConfirmQueue = Promise.resolve();   // 修复 S22：全局串行队列——并发确认依次弹窗，不再互相覆盖

function _settlePendingModal(reason) {
  // 修复 W22（二轮）：兜底取消集中处理 + toast 提示（原静默 deny，用户不知情）
  if (_uiConfirmResolve) {
    const r = _uiConfirmResolve; _uiConfirmResolve = null;
    try { toast('确认框被其它窗口接管，本次操作按取消处理' + (reason ? '（' + reason + '）' : ''), 'warn'); } catch (e) {}
    r({ ok: false, checked: undefined });
  }
  if (_uiPromptResolve) {
    const r = _uiPromptResolve; _uiPromptResolve = null;
    try { toast('输入框被其它窗口接管，本次输入已取消', 'warn'); } catch (e) {}
    r(null);
  }
}

function _overlayFocusables(container) {
  return [...container.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.hidden && el.getAttribute('aria-hidden') !== 'true' &&
      (typeof el.getClientRects !== 'function' || el.getClientRects().length > 0));
}
function _bindOverlayKeyboard(container, onClose) {
  if (!container || container.__overlayKeyBound || !container.addEventListener) return;
  container.__overlayKeyBound = true;
  container.__overlayReturnFocus = document.activeElement;
  const handler = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (typeof onClose === 'function') onClose(event);
      return;
    }
    if (event.key !== 'Tab') return;
    const items = _overlayFocusables(container);
    if (!items.length) { event.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first ||
        (typeof container.contains === 'function' && !container.contains(active)))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault(); first.focus();
    }
  };
  container.__overlayKeyHandler = handler;
  container.addEventListener('keydown', handler);
  setTimeout(() => {
    if (!container.__overlayKeyBound) return;
    if (typeof container.contains === 'function' && container.contains(document.activeElement)) return;
    const items = _overlayFocusables(container);
    if (items.length) items[0].focus();
  }, 0);
}
function _unbindOverlayKeyboard(container) {
  if (!container || !container.__overlayKeyBound) return;
  container.__overlayKeyBound = false;
  if (container.removeEventListener) container.removeEventListener('keydown', container.__overlayKeyHandler);
  container.__overlayKeyHandler = null;
  const previous = container.__overlayReturnFocus;
  container.__overlayReturnFocus = null;
  if (previous && previous.focus) previous.focus();
}

function _modalRoot() {
  let m = document.getElementById('modalRoot');
  // v4：已存在的 root 带 .closing（正在退场）→ 立即 remove 再创建新的，
  // 保证「每次开弹=新元素」的计数语义，且旧 root 的延迟拆 DOM 不会误杀新模态
  if (m && m.classList && m.classList.contains('closing')) { try { m.remove(); } catch (e) {} m = null; }
  if (m) {
    // 修复 S22：模态被复用（重绘 innerHTML）时，挂起中的确认兜底按「取消」收尾，避免 Promise 永不 settle
    _settlePendingModal('modal-reuse');
    _bindOverlayKeyboard(m, _closeModal);
    return m;
  }
  m = document.createElement('div');
  m.id = 'modalRoot';
  document.body.appendChild(m);
  _bindOverlayKeyboard(m, _closeModal);
  return m;
}
function _closeModal() {
  const m = document.getElementById('modalRoot');
  // 修复 S22：模态 DOM 被移除而确认仍挂起时，兜底 resolve {ok:false}（防 Promise 永不 settle 卡死应用）。
  // v4：兜底逻辑保持同步（先 settle 再走退场动画拆 DOM）——S22/W22 测试依赖同步收尾。
  _settlePendingModal('modal-closed');
  if (!m) return;
  _unbindOverlayKeyboard(m);
  if (typeof MOTION !== 'undefined' && !MOTION.instant()) {
    // v4：.closing 类驱动遮罩/卡片退场（140ms in-soft），动画结束（+超时双兜底）后拆 DOM
    m.classList.add('closing');
    MOTION.onAnimEnd(m, 'animationend', MOTION.compOut()).then(() => { try { m.remove(); } catch (e) {} });
  } else { try { m.remove(); } catch (e) {} }
}

/**
 * uiConfirm({title, body, danger, okText, cancelText, checkboxLabel, checkboxLabel2})
 * → Promise<{ok:boolean, checked?:boolean, checked2?:boolean}>
 *   checked  = 第一勾选（本会话内不再提示）；checked2 = 第二勾选（永久信任，UX-2 v1.4）
 */
function uiConfirm(opts) {
  opts = opts || {};
  // 修复 S22：串行化——同一批并发工具触发多个确认时依次弹窗，杜绝单例模态互相覆盖
  const run = () => new Promise(resolve => {
    const m = _modalRoot();   // 修复 S22 追加：先取模态再登记兜底——若先登记，模态残留时
    // （上个确认被兜底取消但 DOM 未拆/外部查看器占用）新确认会被自己的兜底瞬间自我取消
    _uiConfirmResolve = (v) => { _uiConfirmResolve = null; resolve(v); };   // 修复 S22：登记兜底 resolve
    m.innerHTML =
      '<div class="modal-mask"></div>' +
      '<div class="modal-card" role="dialog" aria-modal="true">' +
      '<div class="modal-title"></div>' +
      '<div class="modal-body"></div>' +
      (opts.checkboxLabel ? '<label class="modal-check"><input type="checkbox" id="modalChk"><span></span></label>' : '') +
      (opts.checkboxLabel2 ? '<label class="modal-check"><input type="checkbox" id="modalChk2"><span></span></label>' : '') +
      '<div class="modal-btns">' +
      '<button class="modal-btn modal-cancel"></button>' +
      '<button class="modal-btn modal-ok"></button>' +
      '</div></div>';
    m.querySelector('.modal-title').textContent = opts.title || '确认';
    const body = m.querySelector('.modal-body');
    if (opts.bodyHtml) body.innerHTML = opts.bodyHtml;
    else body.textContent = opts.body || '';
    if (opts.checkboxLabel) m.querySelector('#modalChk').nextElementSibling.textContent = opts.checkboxLabel;
    if (opts.checkboxLabel2) {
      const lbl2 = m.querySelector('#modalChk2').nextElementSibling;
      lbl2.textContent = opts.checkboxLabel2;
      lbl2.style.color = 'var(--warn)';   // 修复 UX-2（v1.4）：永久信任勾选视觉差异化（高风险语义）
    }
    m.querySelector('.modal-ok').textContent = opts.okText || '确定';
    m.querySelector('.modal-cancel').textContent = opts.cancelText || '取消';
    m.querySelector('.modal-ok').classList.add(opts.danger ? 'danger' : 'primary');
    const done = (ok) => {
      const chk = m.querySelector('#modalChk');
      const chk2 = m.querySelector('#modalChk2');
      const checked = chk ? chk.checked : undefined;
      const checked2 = chk2 ? chk2.checked : undefined;
      if (_uiConfirmResolve) _uiConfirmResolve({ ok, checked, checked2 });   // 先 resolve（清兜底句柄）再拆 DOM
      _closeModal();
    };
    m.querySelector('.modal-ok').onclick = () => done(true);
    m.querySelector('.modal-cancel').onclick = () => done(false);
    m.querySelector('.modal-mask').onclick = () => done(false);
    // 修复（建议14 残余）：30ms 硬编码 focus 延时改 MOTION 令牌（press=90ms，
    // 最小的交互反馈令牌；fx-off 下 1ms）。typeof 守卫保 vm 沙箱可测。
    const _focusDelay = (typeof MOTION !== 'undefined' && MOTION.press) ? MOTION.press() : 30;
    setTimeout(() => m.querySelector('.modal-ok').focus(), _focusDelay);
  });
  // 修复 S22：确认串行入队——前一个确认收尾后才弹下一个
  const p = _uiConfirmQueue.then(run, run);
  _uiConfirmQueue = p.then(() => {}, () => {});
  return p;
}

/**
 * uiPrompt({title, body, placeholder, value, type})
 * → Promise<string|null>  （prompt 的替代；取消返回 null）
 */
function uiPrompt(opts) {
  opts = opts || {};
  // 修复 W22（二轮）：uiPrompt 复用全局模态队列——与 uiConfirm 并发时不再互相覆盖
  //（原绕过队列直开模态，可把挂起中的 uiConfirm 兜底吞掉）
  const run = () => new Promise(resolve => {
    // 修复 M2（四轮）：先取模态、后登记兜底——_modalRoot() 复用被外部占用的模态时会
    // 调 _settlePendingModal（把刚登记的 resolve 立即按 null 收尾 = uiPrompt 自我取消，
    // uiConfirm 同款问题 W22 修复时只改了 confirm 侧）。与 uiConfirm :171-173 顺序对齐。
    const m = _modalRoot();
    _uiPromptResolve = (v) => { _uiPromptResolve = null; resolve(v); };   // 修复 W22：登记兜底
    m.innerHTML =
      '<div class="modal-mask"></div>' +
      '<div class="modal-card" role="dialog" aria-modal="true">' +
      '<div class="modal-title"></div>' +
      '<div class="modal-body"></div>' +
      '<input class="modal-input" id="modalInput">' +
      '<div class="modal-btns">' +
      '<button class="modal-btn modal-cancel">取消</button>' +
      '<button class="modal-btn modal-ok primary">确定</button>' +
      '</div></div>';
    m.querySelector('.modal-title').textContent = opts.title || '输入';
    m.querySelector('.modal-body').textContent = opts.body || '';
    const input = m.querySelector('#modalInput');
    input.placeholder = opts.placeholder || '';
    if (opts.value != null) input.value = opts.value;
    input.type = opts.type || 'text';
    const done = (v) => { if (_uiPromptResolve) _uiPromptResolve(v); _closeModal(); };   // 修复 W22：先消费兜底句柄再拆 DOM（不双发）
    m.querySelector('.modal-ok').onclick = () => done(input.value);
    m.querySelector('.modal-cancel').onclick = () => done(null);
    m.querySelector('.modal-mask').onclick = () => done(null);
    input.onkeydown = (e) => { if (e.key === 'Enter') done(input.value); };
    // 修复（建议14 残余）：同上，30ms focus 延时改 MOTION.press() 令牌
    const _focusDelay2 = (typeof MOTION !== 'undefined' && MOTION.press) ? MOTION.press() : 30;
    setTimeout(() => { input.focus(); input.select && input.select(); }, _focusDelay2);
  });
  const p = _uiConfirmQueue.then(run, run);
  _uiConfirmQueue = p.then(() => {}, () => {});
  return p;
}
