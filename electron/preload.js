/**
 * Harbor Electron Preload（最小暴露面，零 ipcRenderer 泄漏，零假壁纸推送）
 */
const { contextBridge, ipcRenderer } = require('electron')

const base = process.env.HARBOR_API_BASE || ''
contextBridge.exposeInMainWorld('HARBOR_API_BASE', base)
contextBridge.exposeInMainWorld('HarborDesktop', Object.freeze({
  platform: process.platform,
  apiBase: base,
  setBackdrop: (mode) => ipcRenderer.invoke('harbor:set-backdrop', String(mode || 'acrylic')),
  getBackdrop: () => ipcRenderer.invoke('harbor:get-backdrop'),
}))
