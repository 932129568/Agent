/* ================= 多面板路由（v4 · icon rail · 交叉淡化） =================
 * R1 铁律：所有面板 DOM 常驻在册（模板里一次性写死），这里只切 class，
 * 绝不运行时注入含 select 的面板 DOM，保证 initCustomSelect 一次遍历即可全部包装。
 * R8：流式生成中切走对话面板时给出轻提示（不强制打断任务）。
 * v4 交叉淡化：离场面板保留 .on（display:flex 不撤）只加 .leaving（absolute 脱流），
 * animationend 后才移除 .on；入场面板 .in-* 必须 z-index:1（CSS 已保）。
 * 方向映射：PANEL_ORDER 索引递增 = fwd（新面板从右进），递减 = back（从左进）。
 */
const PANELS = ['chat', 'sessions', 'analytics', 'workspace'];
const PANEL_ORDER = PANELS;   // v4：方向映射用（顺序即导航序）
let currentPanel = 'chat';
let _panelLeaving = null;   // v4：正在退场的面板（收尸句柄，防重复动画叠加）

function switchPanel(name) {
  if (!PANELS.includes(name)) return;
  const prev = currentPanel; if (prev === name) return;
  currentPanel = name;
  document.querySelectorAll('.rail-btn[data-panel]').forEach(btn => {
    btn.classList.toggle('on', btn.dataset.panel === name);
  });
  const dir = PANEL_ORDER.indexOf(name) > PANEL_ORDER.indexOf(prev) ? 'fwd' : 'back';
  const oldEl = document.getElementById('panel' + prev[0].toUpperCase() + prev.slice(1));
  const newEl = document.getElementById('panel' + name[0].toUpperCase() + name.slice(1));
  if (typeof closeAllCS === 'function') closeAllCS();
  if (typeof MOTION !== 'undefined' && MOTION.instant()) {
    // 降级（fx-off / reduced-motion）：同步切换，不做交叉淡化
    if (_panelLeaving) { _panelLeaving.el.classList.remove('on', 'leaving', 'out-fwd', 'out-back'); _panelLeaving = null; }
    if (oldEl) oldEl.classList.remove('on');
    if (newEl) newEl.classList.add('on');
  } else {
    if (_panelLeaving) { _panelLeaving.el.classList.remove('on', 'leaving', 'out-fwd', 'out-back'); _panelLeaving = null; }
    if (oldEl) oldEl.classList.add('leaving', 'out-' + dir);
    if (newEl) newEl.classList.add('on', 'in-' + dir);   // 修复 建议㉝（三轮）：newEl null 守卫（原 L33 无守卫，面板 id 不存在即抛）
    // 修复（本轮）：onAnimEnd 同样过 newEl null 守卫——面板 id 缺失时不得调 MOTION.onAnimEnd(null)（.then 内再抛）
    if (newEl) MOTION.onAnimEnd(newEl, 'animationend', MOTION.panel()).then(() => newEl.classList.remove('in-' + dir));
    if (oldEl) {
      _panelLeaving = { el: oldEl };
      MOTION.onAnimEnd(oldEl, 'animationend', MOTION.panelOut()).then(() => {
        oldEl.classList.remove('on', 'leaving', 'out-' + dir);
        if (_panelLeaving && _panelLeaving.el === oldEl) _panelLeaving = null;
      });
    }
  }
  // 进入分析面板时刷新一次图表（数据纯前端聚合，成本低）
  if (name === 'analytics' && typeof renderAnalytics === 'function') renderAnalytics();
  // R8：生成中切走对话面板，提示可随时切回
  if (name !== 'chat' && typeof isStreaming !== 'undefined' && isStreaming) {
    if (typeof addSysTip === 'function') addSysTip('正在生成回复，可随时回到「对话」面板查看进度');
  }
}
/* ================= 特效总开关（E1–E9 降级矩阵） =================
 * 关闭时给 body 加 .fx-off：冻结极光、停装饰动效；玻璃材质与 3px 焦点环保留。
 * 持久化：localStorage['glm_fx']（参照 glm_theme 写法，不改 glm_config 字段契约）。
 */
function applyFx(on) {
  document.body.classList.toggle('fx-off', !on);
  const t = document.getElementById('fxToggle');
  if (t) t.checked = !!on;
}
function toggleFx() {
  const t = document.getElementById('fxToggle');
  const on = t ? !!t.checked : true;
  applyFx(on);
  try { localStorage.setItem('glm_fx', on ? '1' : '0'); } catch (e) {}
}
function initFx() {
  let on = true;
  try { on = localStorage.getItem('glm_fx') !== '0'; } catch (e) {}
  applyFx(on);
}
