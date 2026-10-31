/* ================= v4 动效常量表（CSS 变量为单一事实源） =================
 * 来源：deliverables/design/v4 设计令牌文档（彩格调）附录 A。
 * 纪律：JS 一律通过 MOTION 从 getComputedStyle(document.body) 现读 --dur-* / --stagger-*，
 * 禁止在 JS 硬编码毫秒数（v3 的 640 / 200 / 2600 等全部清场）。
 * CSS 改令牌即全站生效；fx-off 时变量被覆盖为 1ms，JS 读到的也是 1ms，天然同步。
 * 取值在使用时而非加载时——DOM 未就绪时调用也有兜底默认值。
 */
const MOTION = (() => {
  const readMs = (name, fallback) => {
    let v = '';
    try { v = getComputedStyle(document.body).getPropertyValue(name).trim(); } catch (e) {}
    if (!v) return fallback;
    const m = /^(-?[\d.]+)(m?s)$/.exec(v);
    return m ? (m[2] === 's' ? parseFloat(m[1]) * 1000 : parseFloat(m[1])) : fallback;
  };
  /* 精确 cubic-bezier 求解（与 --ease-out-soft:cubic-bezier(.25,.8,.35,1) 对齐） */
  function cubicBezier(p1x, p1y, p2x, p2y) {
    const cx = 3 * p1x, bx = 3 * (p2x - p1x) - cx, ax = 1 - cx - bx;
    const cy = 3 * p1y, by = 3 * (p2y - p1y) - cy, ay = 1 - cy - by;
    const sx = t => ((ax * t + bx) * t + cx) * t;
    const sy = t => ((ay * t + by) * t + cy) * t;
    const dx = t => (3 * ax * t + 2 * bx) * t + cx;
    return x => { let t = x;
      for (let i = 0; i < 8; i++) { const e = sx(t) - x;
        if (Math.abs(e) < 1e-6) break;
        const d = dx(t); if (Math.abs(d) < 1e-6) break; t -= e / d; }
      return sy(t); };
  }
  const easeOutSoft = cubicBezier(.25, .8, .35, 1);
  return {
    press:    () => readMs('--dur-press', 90),
    micro:    () => readMs('--dur-micro', 130),
    comp:     () => readMs('--dur-comp', 200),
    compOut:  () => readMs('--dur-comp-out', 140),
    panel:    () => readMs('--dur-panel', 240),
    panelOut: () => readMs('--dur-panel-out', 200),
    narr:     () => readMs('--dur-narr', 220),
    theme:    () => readMs('--dur-theme', 280),
    count:    () => readMs('--dur-count', 600),
    chart:    () => readMs('--dur-chart', 800),
    staggerXs:() => readMs('--stagger-xs', 40),
    staggerSm:() => readMs('--stagger-sm', 60),
    easeOutSoft,
    prefersReduced: () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches),
    fxOff:    () => document.body.classList.contains('fx-off'),
    instant:  () => document.body.classList.contains('fx-off') ||
                    !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches),
    sleep:    ms => new Promise(r => setTimeout(r, ms)),
    /* 动画/过渡结束事件 + 超时双兜底（reduced-motion 下时长 .01ms，事件照发但不可信赖） */
    onAnimEnd: (el, ev, ms) => new Promise(res => {
      let done = false;
      const fin = () => { if (done) return; done = true; try { el.removeEventListener(ev, fin); } catch (e) {} res(); };
      try { el.addEventListener(ev, fin); } catch (e) { /* 桩环境无 addEventListener */ }
      setTimeout(fin, ms + 80);
    })
  };
})();
