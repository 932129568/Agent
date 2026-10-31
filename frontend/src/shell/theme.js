/* ================= 主题 ================= */
const THEME_ICON_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const THEME_ICON_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></svg>';
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
    try { document.startViewTransition(apply); return; } catch (e) {}
  }
  document.body.classList.add('theming');
  apply();
  // 修复 建议㉗（三轮）：MOTION 未定义（模块未加载/降级路径）时兜底 240ms，不再 ReferenceError
  setTimeout(() => document.body.classList.remove('theming'), (typeof MOTION !== 'undefined' && MOTION.theme ? MOTION.theme() : 240) + 60);
}
