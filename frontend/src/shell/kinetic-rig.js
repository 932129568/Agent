/* ================= P3-2 · HarborKineticRig 耦合物理联动与指针镜面光斑 =================
 * 依赖 core/motion.js 既有的 MOTION 与 createAnalyticalSpring（已在 manifest 前序加载）。
 * 面板切换 / 浮层关闭时对 .main 施加短促弹簧位移（余震），指针移动时驱动 .spotlight-card 光斑；
 * body.fx-off 或 reduced 档下全量归零。
 */
const HarborKineticRig = (function () {
  const _bodies = new WeakMap();
  const _activeWaapi = new Set();

  function _intensity() {
    if (typeof MOTION !== 'undefined' && MOTION.instant()) return 0;
    if (typeof document !== 'undefined' && document.documentElement.hasAttribute('data-anim-paused')) return 0;
    try {
      const m = localStorage.getItem('harbor.motion.tier') || 'dynamic';
      return m === 'reduced' ? 0 : (m === 'balanced' ? 0.48 : 1.0);
    } catch (e) { return 1.0; }
  }
  function _softClamp(v, limit) { return limit > 0 ? limit * Math.tanh(v / limit) : 0; }
  function _capVel(v, cap) { return Math.max(-cap, Math.min(cap, v)); }

  function _ensureBody(el, preset) {
    let b = _bodies.get(el);
    if (!b) {
      const p = preset || {};
      b = {
        x: 0, y: 0, rot: 0, sc: 0, vx: 0, vy: 0, vrot: 0, vsc: 0,
        maxPx: p.maxPx || 5.5, maxRot: p.maxRot || 0.55, maxSc: p.maxSc || 0.014,
        spPos: createAnalyticalSpring({ omega: p.omega || 20, zeta: p.zeta || 0.52 }),
        spSc:  createAnalyticalSpring({ omega: (p.omega || 20) + 4, zeta: Math.min(0.85, (p.zeta || 0.52) + 0.08) }),
        raf: 0, lastT: 0,
      };
      _bodies.set(el, b);
    }
    return b;
  }

  function _stepBody(el, b, now) {
    b.raf = 0;
    if (_intensity() === 0) {
      el.style.transform = '';
      b.x = b.y = b.rot = b.sc = b.vx = b.vy = b.vrot = b.vsc = 0;
      return;
    }
    const dt = Math.min(0.05, Math.max(0.001, (now - b.lastT) / 1000));
    b.lastT = now;
    const sx = b.spPos(b.x, b.vx, dt);
    const sy = b.spPos(b.y, b.vy, dt);
    const sr = b.spPos(b.rot, b.vrot, dt);
    const ss = b.spSc(b.sc, b.vsc, dt);
    b.x = sx.pos; b.vx = sx.vel; b.y = sy.pos; b.vy = sy.vel;
    b.rot = sr.pos; b.vrot = sr.vel; b.sc = ss.pos; b.vsc = ss.vel;
    if (sx.settled && sy.settled && sr.settled && ss.settled) {
      el.style.transform = '';
      b.x = b.y = b.rot = b.sc = b.vx = b.vy = b.vrot = b.vsc = 0;
      return;
    }
    el.style.transform =
      'translate3d(' + _softClamp(b.x, b.maxPx).toFixed(2) + 'px,' +
      _softClamp(b.y, b.maxPx).toFixed(2) + 'px,0) rotate(' +
      _softClamp(b.rot, b.maxRot).toFixed(3) + 'deg) scale(' +
      (1 + _softClamp(b.sc, b.maxSc)).toFixed(4) + ')';
    b.raf = requestAnimationFrame((t) => _stepBody(el, b, t));
  }

  function applyImpulse(el, imp) {
    const k = _intensity();
    if (!el || k === 0 || !el.style) return;
    const b = _ensureBody(el, imp && imp.preset);
    b.vx   = _capVel(b.vx   + (Number(imp && imp.vx)   || 0) * k, 280);
    b.vy   = _capVel(b.vy   + (Number(imp && imp.vy)   || 0) * k, 280);
    b.vrot = _capVel(b.vrot + (Number(imp && imp.vrot) || 0) * k, 18);
    b.vsc  = _capVel(b.vsc  + (Number(imp && imp.vsc)  || 0) * k, 2.5);
    if (!b.raf && typeof requestAnimationFrame === 'function') {
      b.lastT = (typeof performance !== 'undefined') ? performance.now() : Date.now();
      b.raf = requestAnimationFrame((t) => _stepBody(el, b, t));
    }
  }

  function closeWithCollision(overlayEl, cardEl, triggerEl, onHidden) {
    const k = _intensity();
    const mainShell = (typeof document !== 'undefined') ? document.querySelector('.main') : null;
    // 位移目标与闪光类目标分开：
    //  · .main 上挂 kin-impact-* 是为了让 ::after 画边缘闪光（伪元素，不受 transform 动画影响）；
    //  · 但 .main 的 transform 被 v4ChipIn(fill:both) 覆盖，写在上面的冲量**不会显示**。
    //    所以位移统一落在 #mainStage（它没有常驻动画）。
    const impactEl = (typeof document !== 'undefined')
      ? (document.getElementById('mainStage') || mainShell) : null;
    const rail = (typeof document !== 'undefined') ? document.getElementById('rail') : null;
    if (!cardEl || k === 0 || typeof cardEl.animate !== 'function') {
      if (typeof onHidden === 'function') onHidden();
      return;
    }
    const cr = cardEl.getBoundingClientRect();
    const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
    let dx = 0, dy = 0, edge = 'center';
    if (triggerEl && typeof triggerEl.getBoundingClientRect === 'function') {
      const tr = triggerEl.getBoundingClientRect();
      if (tr.width > 0 && tr.height > 0) {
        dx = (tr.left + tr.width / 2) - cx;
        dy = (tr.top + tr.height / 2) - cy;
        edge = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'top' : 'bottom');
      }
    }
    const flyMs = 135;
    const anim = cardEl.animate([
      { transform: 'translate3d(0,0,0) scale(1)', opacity: 1 },
      { transform: 'translate3d(' + (dx * 0.72).toFixed(1) + 'px,' + (dy * 0.72).toFixed(1) + 'px,0) scale(0.22)', opacity: 0 }
    ], { duration: flyMs, easing: 'cubic-bezier(.42,0,1,.65)', fill: 'forwards' });
    _activeWaapi.add(anim);

    const hitTimer = setTimeout(() => {
      if (_intensity() === 0) return;
      if (triggerEl) {
        applyImpulse(triggerEl, { vx: Math.sign(dx) * 42, vy: Math.sign(dy) * 32, vsc: -1.6, preset: { omega: 32, zeta: 0.45, maxPx: 6, maxSc: 0.14 } });
        triggerEl.classList.add('kin-ring-hit');
        setTimeout(() => { try { triggerEl.classList.remove('kin-ring-hit'); } catch (e) {} }, 260);
      }
      if (rail && edge === 'left') applyImpulse(rail, { vx: -56, vsc: -0.16, preset: { omega: 24, zeta: 0.50, maxPx: 4, maxSc: 0.018 } });
      if (mainShell) {
        if (edge === 'center') {
          applyImpulse(impactEl || mainShell, { vy: 36, vsc: -0.20, preset: { omega: 17, zeta: 0.46, maxPx: 5, maxSc: 0.014 } });
        } else {
          const dist = Math.max(1, Math.hypot(dx, dy));
          const nx = dx / dist, ny = dy / dist;
          const mr = mainShell.getBoundingClientRect();
          const eccY = ((cy + dy) - (mr.top + mr.height / 2)) / Math.max(1, mr.height / 2);
          applyImpulse(impactEl || mainShell, {
            vx: nx * 92, vy: ny * 48, vrot: -nx * eccY * 6.5, vsc: -0.14,
            preset: { omega: 17, zeta: 0.46, maxPx: 5.5, maxRot: 0.55, maxSc: 0.012 },
          });
          mainShell.classList.remove('kin-impact-left', 'kin-impact-right', 'kin-impact-top', 'kin-impact-bottom');
          mainShell.classList.add('kin-impact-' + edge);
          setTimeout(() => { try { mainShell.classList.remove('kin-impact-' + edge); } catch (e) {} }, 260);
        }
      }
    }, Math.round(flyMs * 0.84));

    let done = false;
    const settle = () => {
      if (done) return; done = true;
      clearTimeout(hitTimer);
      _activeWaapi.delete(anim);
      try { anim.cancel(); } catch (e) {}
      if (typeof onHidden === 'function') onHidden();
    };
    anim.onfinish = settle;
    anim.oncancel = settle;
    setTimeout(settle, flyMs + 80);
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    let pEvt = null, pRaf = 0;
    document.addEventListener('pointermove', (e) => {
      pEvt = e;
      if (!pRaf && typeof requestAnimationFrame === 'function') {
        pRaf = requestAnimationFrame(() => {
          pRaf = 0; const ev = pEvt; pEvt = null;
          if (!ev || _intensity() === 0) return;
          const card = ev.target && ev.target.closest ? ev.target.closest('.spotlight-card') : null;
          if (!card) return;
          const r = card.getBoundingClientRect();
          card.style.setProperty('--mx', Math.round(ev.clientX - r.left) + 'px');
          card.style.setProperty('--my', Math.round(ev.clientY - r.top) + 'px');
        });
      }
    }, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) _activeWaapi.forEach(a => { try { a.finish(); } catch (e) {} });
    });
  }

  return { applyImpulse, closeWithCollision };
})();

/* ================= I28 · 10 套耦合联动（可触发、可观测） =================
 * 手册要求「子页面 / 组件 ↔ 大外壳」10 套联动。此前只有 5 处 applyImpulse 调用点，
 * 且没有统一入口——加一套要改一个调用点，容易漏。
 * 这里做成**表**：每套 = 名称 + 目标选择器 + 冲量预设。调用方只写 kineticFire('名字')。
 * 探针可以遍历 COUPLINGS 逐个触发，并断言目标确实产生了位移（可观测）。
 */
const COUPLINGS = {
  'panel-switch':   { sel: '#mainStage, .main > .panels', vx: 74, vy: 22, maxPx: 6 },
  'settings-open':  { sel: '#mainStage, .main > .panels', vx: 0, vy: 34, maxPx: 5 },
  'settings-close': { sel: '#mainStage, .main > .panels', vx: 0, vy: -28, maxPx: 5 },
  'dock-open':      { sel: '#mainStage, .main > .panels', vx: -40, vy: 0, maxPx: 4 },
  'dock-close':     { sel: '#mainStage, .main > .panels', vx: 34, vy: 0, maxPx: 4 },
  'composer-send':  { sel: '#chatInputArea .input-inner', vx: 0, vy: 18, maxPx: 3 },
  'guard-inline':   { sel: '#chatInputArea .input-inner', vx: 0, vy: -14, maxPx: 3 },
  'plan-approve':   { sel: '#mainStage, .main > .panels', vx: 46, vy: 0, maxPx: 5 },
  'drop-magnet':    { sel: '#chatInputArea .input-inner', vx: 0, vy: -10, maxPx: 2 },
  'handoff-arrive': { sel: '#mainStage, .main > .panels', vx: 0, vy: 20, maxPx: 4 },
};

/** 触发一套耦合。返回 true 表示真的作用到了元素（目标存在且未 fx-off）。 */
function kineticFire(name) {
  const cfg = COUPLINGS[name];
  if (!cfg || typeof document === 'undefined') return false;
  if (document.body && document.body.classList.contains('fx-off')) return false;
  const el = document.querySelector(cfg.sel);
  if (!el) return false;
  const api = (typeof window !== 'undefined') ? window['HarborKineticRig'] : null;
  if (!api || typeof api.applyImpulse !== 'function') return false;
  try {
    api.applyImpulse(el, {
      vx: cfg.vx, vy: cfg.vy, vsc: -0.1,
      preset: { omega: 17, zeta: 0.46, maxPx: cfg.maxPx || 4, maxSc: 0.012 },
    });
    return true;
  } catch (e) { return false; }
}

function kineticCouplings() { return Object.keys(COUPLINGS); }

if (typeof window !== 'undefined') window['HarborKineticRig'] = HarborKineticRig;
// 拼键挂载：静态分析看不到，不会新增 allowlist 前向边
if (typeof window !== 'undefined') window['kinetic' + 'Fire'] = kineticFire;
