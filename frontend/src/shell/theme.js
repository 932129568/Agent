/* ================= 主题 ================= */
// R18：主题图标走 sprite（i-sun/i-moon），与全站图标同源同描边
const THEME_ICON_SUN = '<svg class="ui-icon ui-icon-20" aria-hidden="true"><use href="#i-sun"/></svg>';
const THEME_ICON_MOON = '<svg class="ui-icon ui-icon-20" aria-hidden="true"><use href="#i-moon"/></svg>';
function applyTheme(t) {
  document.body.classList.toggle('dark', t === 'dark');
  const b = document.getElementById('themeBtn');
  if (b) b.innerHTML = t === 'dark' ? THEME_ICON_SUN : THEME_ICON_MOON;
}
function toggleTheme() {
  const t = document.body.classList.contains('dark') ? 'light' : 'dark';
  const apply = () => { applyTheme(t); try { localStorage.setItem('glm_theme', t); } catch (e) {} };
  // v4：主题切换表面过渡——原生 ViewTransition 优先（ Chromium ），否则 .theming 白名单过渡
  if (document.startViewTransition && typeof MOTION !== 'undefined' && !MOTION.prefersReduced()) {
    try {
      // R17 扫描实证：连点主题键时并发 ViewTransition 会以 InvalidStateError 拒绝
      //（unhandledrejection）——updateCallbackDone 失败时降级直切，finished 静默。
      const vt = document.startViewTransition(apply);
      if (vt && vt.updateCallbackDone) vt.updateCallbackDone.catch(() => { try { apply(); } catch (e) {} });
      if (vt && vt.ready) vt.ready.catch(() => {});        // 窗口被遮挡/跳过时 ready 拒绝（R17 扫描实证）
      if (vt && vt.finished) vt.finished.catch(() => {});
      return;
    } catch (e) {}
  }
  document.body.classList.add('theming');
  apply();
  // 修复 建议㉗（三轮）：MOTION 未定义（模块未加载/降级路径）时兜底 240ms，不再 ReferenceError
  setTimeout(() => document.body.classList.remove('theming'), (typeof MOTION !== 'undefined' && MOTION.theme ? MOTION.theme() : 240) + 60);
}

/* ================= R101 T04 · 极性与玻璃透明度 =================
 * 极性用**新增属性** data-polarity，不改任何既有变量名（计划要求：极性问题用新增变量）。
 * 透明度写 --glass-opacity（新增），旧变量一律不动 ⇒ ui-contract 的 22 个必需变量零影响。
 * 持久化用独立 key，不混进主题 key：两者是不同维度的偏好（主题=明暗皮肤，极性=文字极性）。
 */
const GLASS_OPACITY_KEY = 'harbor.glass.opacity';
const GLASS_POLARITY_KEY = 'harbor.glass.polarity';

function glassPolarityApply(polarity) {
  if (typeof document === 'undefined') return 'light';
  const p = (String(polarity) === 'dark') ? 'dark' : 'light';
  document.documentElement.setAttribute('data-polarity', p);
  try { localStorage.setItem(GLASS_POLARITY_KEY, p); } catch (e) {}
  return p;
}

function glassPolarityToggle() {
  const cur = (typeof document !== 'undefined')
    ? (document.documentElement.getAttribute('data-polarity') || 'light') : 'light';
  return glassPolarityApply(cur === 'dark' ? 'light' : 'dark');
}

/** 透明度 0..1；越界夹取。返回最终生效值。 */
function glassOpacitySet(v) {
  const n = Number(v);
  const clamped = isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.62;
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--glass-opacity', String(clamped));
  }
  try { localStorage.setItem(GLASS_OPACITY_KEY, String(clamped)); } catch (e) {}
  return clamped;
}

/** 启动恢复：读本地偏好并套用（读不到就用默认值，不报错）。 */
function glassStateRestore() {
  let p = 'light';
  let op = 0.62;
  try {
    p = localStorage.getItem(GLASS_POLARITY_KEY) || 'light';
    const raw = localStorage.getItem(GLASS_OPACITY_KEY);
    if (raw !== null) { const n = Number(raw); if (isFinite(n)) op = Math.max(0, Math.min(1, n)); }
  } catch (e) {}
  glassPolarityApply(p);
  return { polarity: p, opacity: glassOpacitySet(op) };
}

/** 演示可见模式：给玻璃宿主加虚线轮廓并抬透明度，便于演示/截图比对。
 *  只加属性不改颜色 —— 截图比对时颜色必须是真实值，否则比的是演示态而不是产品态。 */
function glassDemoToggle() {
  if (typeof document === 'undefined') return false;
  const root = document.documentElement;
  const on = root.getAttribute('data-glass-demo') === '1';
  if (on) root.removeAttribute('data-glass-demo');
  else root.setAttribute('data-glass-demo', '1');
  return !on;
}
