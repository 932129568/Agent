/**
 * 主题、真窗外材质与动效强度唯一写入点（LAW-01 白名单）。
 */
import { readStorage, writeStorage } from './storage.js'
import { desktopBridge } from './libs.js'

const THEME_KEY = 'harbor.v2.theme'
const BACKDROP_KEY = 'harbor.v2.backdrop'
const OPACITY_KEY = 'harbor.v2.opacity'
const MOTION_KEY = 'harbor.v2.motion'

export function readVisualPrefs() {
  const theme = readStorage(THEME_KEY, 'dark') === 'light' ? 'light' : 'dark'
  const backdrop = readStorage(BACKDROP_KEY, 'acrylic')
  const rawOp = Number(readStorage(OPACITY_KEY, '0.66'))
  const opacity = Number.isFinite(rawOp) ? Math.min(0.96, Math.max(0.32, rawOp)) : 0.66
  const motion = readStorage(MOTION_KEY, 'dynamic')
  return {
    theme,
    backdrop: ['acrylic', 'mica', 'tabbed', 'none'].includes(backdrop) ? backdrop : 'acrylic',
    opacity,
    motion: ['dynamic', 'balanced', 'reduced'].includes(motion) ? motion : 'dynamic',
  }
}

export async function applyVisualPrefs(prefs) {
  const root = typeof document !== 'undefined' ? document.documentElement : null
  if (!root) return prefs
  const next = { ...readVisualPrefs(), ...(prefs || {}) }

  root.dataset.theme = next.theme
  root.dataset.motion = next.motion
  root.style.setProperty('--glass-rail', String(Math.max(0.28, next.opacity - 0.14).toFixed(2)))
  root.style.setProperty('--glass-stage', String(next.opacity.toFixed(2)))
  root.style.setProperty('--glass-card', String(Math.min(0.95, next.opacity + 0.16).toFixed(2)))

  writeStorage(THEME_KEY, next.theme)
  writeStorage(BACKDROP_KEY, next.backdrop)
  writeStorage(OPACITY_KEY, next.opacity)
  writeStorage(MOTION_KEY, next.motion)

  const desktop = desktopBridge()
  if (desktop && typeof desktop.setBackdrop === 'function') {
    try {
      const res = await desktop.setBackdrop(next.backdrop)
      root.dataset.backdrop = res && res.ok ? res.mode : 'none'
    } catch {
      root.dataset.backdrop = 'none'
    }
  } else {
    // 非 Electron 浏览器打开时优雅退回实体底色
    root.dataset.backdrop = 'none'
  }
  return next
}
