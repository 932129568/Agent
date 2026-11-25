/**
 * Harbor Electron Preload（最小暴露面，零 ipcRenderer 泄漏，支持真桌面跨窗漫游桥）
 */
const { contextBridge, ipcRenderer } = require('electron')

const base = process.env.HARBOR_API_BASE || ''
contextBridge.exposeInMainWorld('HARBOR_API_BASE', base)
contextBridge.exposeInMainWorld('HarborDesktop', Object.freeze({
  platform: process.platform,
  apiBase: base,
  setBackdrop: (mode) => ipcRenderer.invoke('harbor:set-backdrop', String(mode || 'acrylic')),
  getBackdrop: () => ipcRenderer.invoke('harbor:get-backdrop'),
  getDesktopMetrics: () => ipcRenderer.invoke('harbor:get-desktop-metrics'),
  syncDesktopStage: (payload) => ipcRenderer.send('harbor:desktop-stage-sync', payload),
  setDesktopStageIgnore: (ignore) => ipcRenderer.send('harbor:desktop-stage-ignore', Boolean(ignore)),
  emitDesktopStageEvent: (event) => ipcRenderer.send('harbor:desktop-stage-event', event),
  onDesktopStageSync: (cb) => {
    if (typeof cb !== 'function') return () => {}
    const handler = (_evt, payload) => { try { cb(payload) } catch {} }
    ipcRenderer.on('harbor:desktop-stage-sync', handler)
    return () => ipcRenderer.removeListener('harbor:desktop-stage-sync', handler)
  },
  onDesktopStageEvent: (cb) => {
    if (typeof cb !== 'function') return () => {}
    const handler = (_evt, payload) => { try { cb(payload) } catch {} }
    ipcRenderer.on('harbor:desktop-stage-event', handler)
    return () => ipcRenderer.removeListener('harbor:desktop-stage-event', handler)
  },
  onWindowLifecycle: (cb) => {
    if (typeof cb !== 'function') return () => {}
    const handler = (_evt, payload) => { try { cb(payload) } catch {} }
    ipcRenderer.on('harbor:window-lifecycle', handler)
    return () => ipcRenderer.removeListener('harbor:window-lifecycle', handler)
  },
}))
