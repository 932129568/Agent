/**
 * 主题、真窗外材质与通透度标量唯一写入点（v3 明亮校准版，LAW-01 白名单）。
 */
import { readStorage, writeStorage } from './storage.js'
import { desktopBridge } from './libs.js'

const THEME_KEY = 'harbor.v3.theme'
const BACKDROP_KEY = 'harbor.v3.backdrop'
const OPACITY_KEY = 'harbor.v3.opacity'
const MOTION_KEY = 'harbor.v3.motion'
const IMPACT_STYLE_KEY = 'harbor.v4.impact_style'
const VALID_IMPACT_STYLES = ['mercury', 'prism', 'ripple', 'crystal', 'aurora', 'random']

export function readVisualPrefs() {
  const theme = readStorage(THEME_KEY, 'light') === 'dark' ? 'dark' : 'light'
  const backdrop = readStorage(BACKDROP_KEY, 'acrylic')
  const rawOp = Number(readStorage(OPACITY_KEY, '0.44'))
  const opacity = Number.isFinite(rawOp) ? Math.min(0.92, Math.max(0.22, rawOp)) : 0.44
  const motion = readStorage(MOTION_KEY, 'dynamic')
  const impactStyle = readStorage(IMPACT_STYLE_KEY, 'mercury')
  return {
    theme,
    backdrop: ['acrylic', 'mica', 'tabbed', 'none'].includes(backdrop) ? backdrop : 'acrylic',
    opacity,
    motion: ['dynamic', 'balanced', 'reduced'].includes(motion) ? motion : 'dynamic',
    impactStyle: VALID_IMPACT_STYLES.includes(impactStyle) ? impactStyle : 'mercury',
  }
}

export async function applyVisualPrefs(prefs) {
  const root = typeof document !== 'undefined' ? document.documentElement : null
  if (!root) return prefs
  const next = { ...readVisualPrefs(), ...(prefs || {}) }

  root.dataset.theme = next.theme
  root.dataset.motion = next.motion
  root.dataset.impactStyle = next.impactStyle || 'mercury'
  root.style.setProperty('--glass-rail', String(Math.max(0.20, next.opacity - 0.08).toFixed(2)))
  root.style.setProperty('--glass-stage', String(next.opacity.toFixed(2)))
  root.style.setProperty('--glass-card', String(Math.min(0.90, next.opacity + 0.24).toFixed(2)))

  writeStorage(THEME_KEY, next.theme)
  writeStorage(BACKDROP_KEY, next.backdrop)
  writeStorage(OPACITY_KEY, next.opacity)
  writeStorage(MOTION_KEY, next.motion)
  writeStorage(IMPACT_STYLE_KEY, next.impactStyle || 'mercury')

  const desktop = desktopBridge()
  if (desktop && typeof desktop.setBackdrop === 'function') {
    try {
      const res = await desktop.setBackdrop(next.backdrop)
      root.dataset.backdrop = res && res.ok ? res.mode : 'none'
    } catch {
      root.dataset.backdrop = 'none'
    }
  } else {
    root.dataset.backdrop = 'none'
  }
  return next
}
