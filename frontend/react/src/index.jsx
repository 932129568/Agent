/**
 * Harbor React 层入口（React 19.3.1）。
 *
 * R67：React 由「侧栏岛」升级为**全量 UI 渲染层**。
 * 产物契约：单一 IIFE，全局仅 `HarborIsland`（frontend/build.js prebuilt provides）。
 *
 * 挂载契约：
 *   HarborIsland.mount(target, opts)          —— 侧栏历史岛（保留，向后兼容）
 *   HarborIsland.unmount(target)
 *   HarborIsland.api.mountApp(target)         —— 全量 UI 外壳（幂等）
 *   HarborIsland.api.renderMode()             —— 'react' | 'legacy-fallback'
 *   HarborIsland.api.legacyEventCount()       —— 已桥接的内联事件数
 *   HarborIsland.api.syncSessions(...)        —— 侧栏数据推流
 *
 * 渲染权边界（关键，勿破坏）：
 *   App 是**纯静态组件树**，flushSync 渲染一次后不再重渲染。这样 legacy 服务层的
 *   453 处 getElementById / 206 处 innerHTML / 374 处 appendChild 继续作用于 React
 *   生成的真实 DOM，而不会被 React 的后续 render 覆盖。逐域迁移时，每把一块 DOM
 *   写入改造成 React state，就同步删掉该域的 legacy DOM 写点。
 *
 * 降级：挂载失败时用 <template id="harbor-legacy-fallback"> 的内容整体替换根容器，
 * 页面保持可用（legacy 直接操作该 DOM），绝不白屏。
 */
import { version as reactVersion } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import SessionHistory from './SessionHistory.jsx'
import ParallelRuns from './ParallelRuns.jsx'
import App from './generated/App.jsx'
import AgentProcessPanel from './AgentProcessPanel.jsx'
import { syncSessions, getState } from './store.js'
import tokensCss from '../../styles/tokens.css'
import islandCss from './island.css'

const STYLE_ID = 'harbor-island-styles'
const APP_HOST_ID = 'harbor-react-root'
const FALLBACK_ID = 'harbor-legacy-fallback'
const roots = new WeakMap()

let appRoot = null
let bgRoot = null
let boundEvents = 0

function injectStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = tokensCss + '\n' + islandCss
  document.head.appendChild(style)
}

/**
 * 把模板内联 on* 事件还原成**属性式**原生绑定。
 * 用 el.onclick = fn 而非 addEventListener，是为了与浏览器内联 onclick 完全等价：
 * this 指向元素、event 为原生事件、return false 阻止默认、且 legacy 后续
 * `btn.onclick = ...` 能覆盖它（sendBtn 等运行时改绑的按钮依赖这一点）。
 */
function bindLegacyEvents(rootEl) {
  let count = 0
  const nodes = rootEl.querySelectorAll('[data-h-events]')
  nodes.forEach(el => {
    let list
    try { list = JSON.parse(el.getAttribute('data-h-events')) } catch (_) { return }
    if (!Array.isArray(list)) return
    for (const item of list) {
      if (!item || typeof item.code !== 'string') continue
      let fn
      try { fn = new Function('event', item.code) }
      catch (error) {
        console.error('[Harbor] 内联事件编译失败:', item.code, error)
        continue
      }
      el['on' + item.type] = function (event) {
        const result = fn.call(el, event)
        if (result === false) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault()
        }
        return result
      }
      count++
    }
  })
  return count
}

/** React 挂载失败时回落到模板内的静态 DOM，保证页面不白屏。 */
function activateFallback(reason) {
  try {
    const host = document.getElementById(APP_HOST_ID)
    const tpl = document.getElementById(FALLBACK_ID)
    if (!host || !tpl) return
    if (appRoot) { try { appRoot.unmount() } catch (_) {} appRoot = null }
    if (bgRoot) { try { bgRoot.unmount() } catch (_) {} bgRoot = null }
    if (typeof window !== 'undefined') window.__HARBOR_REACT_BGTASKS__ = false
    host.replaceWith(tpl.content.cloneNode(true))
    document.documentElement.dataset.harborRender = 'legacy-fallback'
    console.warn('[Harbor] React 全量挂载失败，已回落静态 DOM：', reason)
  } catch (error) {
    console.error('[Harbor] 降级也失败：', error)
  }
}

/** 全量 UI 外壳：同步渲染，确保 legacy 脚本执行前 DOM 已就绪。 */
export function mountApp(target) {
  const el = typeof target === 'string'
    ? (typeof document !== 'undefined' ? document.getElementById(target.replace(/^#/, '')) : null)
    : target
  if (!el) return null
  if (appRoot) return appRoot
  injectStyles()
  try {
    const root = createRoot(el)
    flushSync(() => { root.render(<App />) })
    boundEvents = bindLegacyEvents(el)
    appRoot = root
    document.documentElement.dataset.harborRender = 'react'
    // R67：后台任务/过程面板是第一个「数据源 + 渲染」整体迁入 React 的域。
    // 独立 createRoot 挂到模板既有容器 #bgTaskList，App 静态树不重渲染该节点。
    const bgHost = document.getElementById('bgTaskList')
    if (bgHost) {
      try {
        const bg = createRoot(bgHost)
        flushSync(() => { bg.render(<AgentProcessPanel />) })
        bgRoot = bg
        window.__HARBOR_REACT_BGTASKS__ = true
      } catch (error) {
        console.warn('[Harbor] 过程面板挂载失败，保持 legacy 渲染：', error)
        window.__HARBOR_REACT_BGTASKS__ = false
        bgRoot = null
      }
    }
    return root
  } catch (error) {
    activateFallback(error)
    return null
  }
}

export function unmountApp() {
  if (!appRoot) return false
  try { appRoot.unmount() } catch (_) { return false }
  appRoot = null
  if (bgRoot) { try { bgRoot.unmount() } catch (_) {} bgRoot = null }
  if (typeof window !== 'undefined') window.__HARBOR_REACT_BGTASKS__ = false
  return true
}

// ---------- 侧栏岛（保留既有契约，island-host.js 依赖） ----------

export function mount(target, options) {
  const el = typeof target === 'string' ? document.querySelector(target) : target
  if (!el) throw new Error('HarborIsland.mount: 找不到挂载点')
  const opts = options || {}
  const island = opts.island || 'sidebar'
  if (!islands.includes(island)) {
    throw new Error(`HarborIsland.mount: 未知岛「${island}」（已实现：${islands.join(', ')}）`)
  }
  injectStyles()
  const root = createRoot(el)
  root.render(
    <>
      <ParallelRuns />
      <SessionHistory
        onSelect={opts.onSelect}
        onNewSessionInProject={opts.onNewSessionInProject}
        onDeleteProject={opts.onDeleteProject}
      />
    </>,
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
  mountApp,
  unmountApp,
  renderMode: () => (typeof document !== 'undefined'
    ? (document.documentElement.dataset.harborRender || 'react') : 'unknown'),
  legacyEventCount: () => boundEvents,
  bgTasksReact: () => !!bgRoot,
}

export default { mount, unmount, islands, version, framework, api }

// IIFE 位于 harbor.html <script> 的最前面（prebuilt 先于 117 个 legacy 模块），
// 此时 body 中的根容器已解析，可同步完成渲染。
if (typeof document !== 'undefined') {
  const host = document.getElementById(APP_HOST_ID)
  if (host) mountApp(host)
}
