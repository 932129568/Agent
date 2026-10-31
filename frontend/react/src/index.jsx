/**
 * Harbor 岛层入口（React 19.3.1）。
 *
 * 产物契约：单一 IIFE，全局仅 `HarborIsland`，供 frontend/build.js 的
 * prebuilt 校验（provides=["HarborIsland"]）。CSS 以字符串内联注入，
 * 产物零外部资源（WebView2 走 file://）。
 *
 * 挂载契约（框架无关，任何实现都遵循同一形状）：
 *   HarborIsland.mount(target, { island, onSelect, onNewSessionInProject })
 *   HarborIsland.unmount(target)
 *   HarborIsland.api.syncSessions(sessions, projects, currentId)
 *   HarborIsland.islands / HarborIsland.version / HarborIsland.framework
 */
import { version as reactVersion } from 'react'
import { createRoot } from 'react-dom/client'
import SessionHistory from './SessionHistory.jsx'
import { syncSessions, getState } from './store.js'
import tokensCss from '../../styles/tokens.css'
import islandCss from './island.css'

const STYLE_ID = 'harbor-island-styles'
const roots = new WeakMap()

function injectStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = tokensCss + '\n' + islandCss
  document.head.appendChild(style)
}

export function mount(target, options) {
  const el = typeof target === 'string' ? document.querySelector(target) : target
  if (!el) throw new Error('HarborIsland.mount: 找不到挂载点')
  const opts = options || {}
  // 契约显式化：未实现的岛名直接报错，避免静默渲染成别的内容
  const island = opts.island || 'sidebar'
  if (!islands.includes(island)) {
    throw new Error(`HarborIsland.mount: 未知岛「${island}」（已实现：${islands.join(', ')}）`)
  }
  injectStyles()
  const root = createRoot(el)
  root.render(
    <SessionHistory
      onSelect={opts.onSelect}
      onNewSessionInProject={opts.onNewSessionInProject}
    />,
  )
  roots.set(el, root)
  return root
}

export function unmount(target) {
  const el = typeof target === 'string' ? document.querySelector(target) : target
  if (!el) return false
  const root = roots.get(el)
  if (!root) return false
  root.unmount()
  roots.delete(el)
  return true
}

export const islands = ['sidebar']
export const version = reactVersion
export const framework = 'react'

export const api = {
  syncSessions,
  getState,
}

export default { mount, unmount, islands, version, framework, api }
