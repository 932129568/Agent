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
    /* R27：focus 延时专用令牌——三处面板的入场节奏不同，独立可读，
       数值与原硬编码 30/60/80ms 精确一致；fx-off 下由变量级降级为 0ms。 */
    focusXs:  () => readMs('--dur-focus-xs', 30),
    focusSm:  () => readMs('--dur-focus-sm', 60),
    focusMd:  () => readMs('--dur-focus-md', 80),
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
/* ================= v2.1 M1（P09-A）：欠阻尼弹簧闭式解析解 =================
 * 与上面 MOTION 表分离：MOTION 管「时长令牌」，本函数管「物理轨迹」。
 * 为什么必须是闭式解而非积分：玻璃拟态的高帧率动画里，欧拉/半隐式积分
 * 每帧累加会随 dt 抖动漂移（掉帧时刚性变化、低帧率下能量注入发散），
 * 而解析解对任意 dt 都精确、无状态累积、可任意跳帧求值（滚动/暂停/回放）。
 * 定义式（欠阻尼 0<ζ<1，ω_d = ω√(1-ζ²) 为阻尼振动角频率）：
 *   A = x0，B = (v0 + ζω·x0) / ω_d
 *   pos(t) = e^{-ζωt} · ( A·cos(ω_d t) + B·sin(ω_d t) )
 *   vel(t) = e^{-ζωt} · ( (B·ω_d - ζω·A)·cos(ω_d t)
 *                        - (A·ω_d + ζω·B)·sin(ω_d t) )
 * vel 由 pos 对 t 求导得到（含衰减项的乘积法则），故二者恒自洽。
 * 纪律：纯函数、零副作用、不读写 DOM、不引 import/export（本文件拼接进单 <script>）。
 */
/**
 * 构造一个欠阻尼弹簧的求值器。
 * @param {Object} [opts] 弹簧参数；缺省即取下列默认值（不做 DOM 读取，纯数值）
 * @param {number} [opts.omega=24.0] 自然角频率 ω（rad/s），越大越"紧"
 * @param {number} [opts.zeta=0.72] 阻尼比 ζ；越界值被 clamp 到 [0.05, 0.99)，
 *        因为 ζ≥1 退化为过阻尼/临界（无 ω_d 实数解），ζ≤0 则永不收敛
 * @returns {function(number, number, number): {pos:number, vel:number, settled:boolean}}
 *         evaluate(x0, v0, dtSec)：给定初位移/初速度与经过秒数，返回该时刻的
 *         位移 pos、速度 vel 与是否已静止 settled
 */
function createAnalyticalSpring(opts) {
  const o = opts || {};
  // ω 必须为正有限数，否则 e^{-ζωt} 衰减项语义反转（负 ω 会发散）
  let omega = Number(o.omega);
  if (!isFinite(omega) || omega <= 0) omega = 24.0;
  // ζ 越界 clamp 而非抛错：调用方传 settings 里的用户档位时不该因数值异常中断动画
  let zeta = Number(o.zeta);
  if (!isFinite(zeta)) zeta = 0.72;
  if (zeta < 0.05) zeta = 0.05;
  // 上界取 0.989 而非常量区间写的 0.99 —— **不是笔误，勿改回 0.99**：
  // 契约区间是半开 [0.05, 0.99)，ζ=0.99 时 omegaD = ω√(1-0.9801) ≈ 0.141ω 仍非零，
  // 但 B = (v0 + ζω·x0) / omegaD 会随 omegaD 缩小被同比放大（ζ→0.99 时已放大约 7 倍）。
  // 取 0.989 给 omegaD 留一点数值余量，避免「接近临界阻尼」的档位把 B 推成巨值、
  // 让 pos 在 t≈0 处出现肉眼可见的尖峰。挡住的只是 0.99 这一个退化点，不影响常规档位。
  if (zeta >= 0.99) zeta = 0.989;
  const omegaD = omega * Math.sqrt(1 - zeta * zeta);   // 欠阻尼必有 1-ζ²>0（ζ<0.99）
  const decay = zeta * omega;                          // 衰减指数系数 ζω
  return function evaluate(x0, v0, dtSec) {
    // 非有限入参一律按「已静止在原点」处理，避免 NaN 顺着渲染链扩散。
    // **这条是刻意加的防御，不是漏写的 bug，勿删**：本函数直接驱动 transform/opacity，
    // 一旦返回 NaN，浏览器会静默丢弃整条 transform 并让元素停在上一帧（不报错），
    // 表现为「动画卡死在半路」——现场极难定位到源头是某个 undefined 初值。
    // 因此宁可降级成「不动」，也不让 NaN 进渲染链。
    const a0 = Number(x0);
    const v = Number(v0);
    const t = Number(dtSec);
    // t<=0 与 NaN 同归一支：t===0 保留初速（调用方用它取 t=0 时刻状态），
    // t<0（时间倒流，语义未定义）按 0 速度处理，不做外推。
    if (!isFinite(a0) || !isFinite(v) || !isFinite(t) || t <= 0) {
      const p0 = isFinite(a0) ? a0 : 0;
      const w0 = isFinite(v) ? v : 0;
      return { pos: p0, vel: (t === 0 ? w0 : 0), settled: Math.abs(p0) < 1e-3 && Math.abs(w0) < 1e-2 };
    }
    const A = a0;
    const B = (v + decay * a0) / omegaD;
    const wt = omegaD * t;
    const e = Math.exp(-decay * t);       // e^{-ζωt}
    const c = Math.cos(wt);
    const s = Math.sin(wt);
    const pos = e * (A * c + B * s);
    const vel = e * ((B * omegaD - decay * A) * c - (A * omegaD + decay * B) * s);
    // 双阈值判静止：位移要足够小（1e-3）且速度要足够小（1e-2）——
    // 只判位移会在过零点附近误判静止（此时速度仍大，视觉上还在动）
    const settled = Math.abs(pos) < 1e-3 && Math.abs(vel) < 1e-2;
    return { pos: pos, vel: vel, settled: settled };
  };
}
