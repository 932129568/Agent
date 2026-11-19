/**
 * 主题适配（规范 §7.6）：CSS 变量主题的唯一写入点。
 * 平台层白名单：允许触碰 document.documentElement，业务层不得直接改主题。
 */
const THEME_KEY = 'harbor_theme'
const VALID = new Set(['dark', 'light'])

export function readTheme() {
  try {
    const saved = globalThis.localStorage && globalThis.localStorage.getItem(THEME_KEY)
    if (VALID.has(saved)) return saved
  } catch (_) { /* file:// 下可能被禁用 */ }
  return 'dark'
}

export function applyTheme(theme) {
  const next = VALID.has(theme) ? theme : 'dark'
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.dataset.theme = next
  }
  try {
    if (globalThis.localStorage) globalThis.localStorage.setItem(THEME_KEY, next)
  } catch (_) { /* 忽略持久化失败，不影响渲染 */ }
  return next
}
