import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Root } from './app/Root.jsx'
import App from './app/App.jsx'
import { createStore } from './state/createStore.js'
import { initialSlices } from './state/slices.js'
import { mountPoint } from './platform/dom.js'

/**
 * 单一入口（规范 §3/§10）。
 * 评审确认后由 frontend/build.js 注入 harbor.html；当前仅为可运行骨架，
 * 不覆盖任何生产产物。
 */
export function bootstrap(options = {}) {
  const host = options.host || mountPoint(options.hostId || 'harbor-app-root')
  if (!host) return null
  const store = options.store || createStore(initialSlices)
  const root = createRoot(host)
  flushSync(() => {
    root.render(React.createElement(Root, { store }, React.createElement(App)))
  })
  return { root, store }
}

export default { bootstrap }
