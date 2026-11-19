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
