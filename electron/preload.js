/**
 * §2.4 桥切换注点（一行语义）：frontend/src/core/bridge.js 判序
 *   `window.pywebview.api` 存在 → pywebview；否则 `window.HARBOR_API_BASE` 非空 → HTTP。
 * Electron 下 pywebview 永不存在——expose 这一行即完成切换，前端源码零改动。
 * base 由 main.js 在 server.listen 之后写入本进程 env（渲染进程继承）。
 */
const { contextBridge } = require('electron')

const base = process.env.HARBOR_API_BASE || ''
contextBridge.exposeInMainWorld('HARBOR_API_BASE', base)
console.log('[harbor-preload] bridge base =', base || '(EMPTY — bridge will fail loud)')
