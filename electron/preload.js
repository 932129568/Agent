/**
 * §2.4 桥切换注点（一行语义）：frontend/src/core/bridge.js 判序
 *   `window.pywebview.api` 存在 → pywebview；否则 `window.HARBOR_API_BASE` 非空 → HTTP。
 * Electron 下 pywebview 永不存在——expose 这一行即完成切换，前端源码零改动。
 * base 由 main.js 在 server.listen 之后写入本进程 env（渲染进程继承）。
 *
 * R80 / W2 增量：桌面壁纸镜像（契约 §6）。
 *   - 暴露只读对象 HARBOR_WP（仅 onUpdate），**不暴露 ipcRenderer 本身**；
 *   - 同时把载荷落到 :root 的 --wp-url / --wp-visible / --wp-x / --wp-y / --wp-size
 *     与 <html data-wp>（§3.4）。写在 preload 里是刻意的：这条链路的主进程取数、
 *     坐标换算、CSS 变量落值全部闭环在 W2 名下，styles/ 与 scripts/ 一行都不用改
 *     （本轮那两个目录由别的代理并行改，任何跨目录依赖都会冲突）。
 *   - 载荷两种形态（见 main.js pushWallpaper）：整包带 url/style/tile，增量只有
 *     x/y/visible。增量**不许**清空 --wp-url（3MB data URI 只在首包发一次）。
 */
const { contextBridge, ipcRenderer } = require('electron')

const base = process.env.HARBOR_API_BASE || ''
contextBridge.exposeInMainWorld('HARBOR_API_BASE', base)
console.log('[harbor-preload] bridge base =', base || '(EMPTY — bridge will fail loud)')

/* ================= R80 / W2：壁纸镜像 ================= */

const WP_CHANNEL = 'harbor:wp'

/**
 * WallpaperStyle → CSS background-size（Windows 语义）
 *   0 居中 / 1 平铺 / 2 拉伸 / 6 适应 / 10 填充 / 20 跨区 / 22 跨区
 * TileWallpaper=1 时平铺优先（--wp-size: auto）。未列出的按填充处理。
 * @param {string} style
 * @param {string} tile
 * @returns {string}
 */
function sizeForStyle(style, tile) {
  if (String(tile) === '1') return 'auto'
  switch (String(style)) {
    case '0': return 'auto'          // 居中
    case '1': return 'auto'          // 平铺
    case '2': return '100% 100%'     // 拉伸
    case '6': return 'contain'       // 适应
    case '20':                       // 跨区（Span）
    case '22':                       // 跨区
    case '10':                       // 填充（Windows 11 默认）
    default: return 'cover'
  }
}

/** 主进程给的是物理像素负偏移；CSS 里要 CSS px，除以 devicePixelRatio 还原。 */
function toCssPx(value) {
  const raw = Number(value)
  if (!Number.isFinite(raw)) return 0
  const dpr = Number(window.devicePixelRatio) > 0 ? Number(window.devicePixelRatio) : 1
  return Math.round((raw / dpr) * 100) / 100
}

/**
 * 落值到 :root 与 <html data-wp>。
 * @param {{url?:string,style?:string,tile?:string,x?:number,y?:number,visible?:boolean,partial?:boolean}} p
 */
function applyWallpaper(payload) {
  if (!payload || typeof payload !== 'object') return
  const root = document.documentElement
  if (!root) return
  const style = root.style

  // 整包才动 url/style/size：增量包没有这些字段，绝不能拿 undefined 去覆盖
  if (payload.partial !== true) {
    const url = typeof payload.url === 'string' ? payload.url : ''
    style.setProperty('--wp-url', url ? 'url("' + url + '")' : 'none')
    style.setProperty('--wp-size', sizeForStyle(payload.style, payload.tile))
  }
  if (payload.x !== undefined) style.setProperty('--wp-x', toCssPx(payload.x) + 'px')
  if (payload.y !== undefined) style.setProperty('--wp-y', toCssPx(payload.y) + 'px')
  if (payload.visible !== undefined) {
    style.setProperty('--wp-visible', payload.visible ? '1' : '0')
    try { root.dataset.wp = payload.visible ? 'ready' : 'none' } catch (error) { /* 忽略 */ }
  }
}

contextBridge.exposeInMainWorld('HARBOR_WP', {
  onUpdate: (cb) => ipcRenderer.on(WP_CHANNEL, (_e, p) => { if (typeof cb === 'function') cb(p) }),
})

ipcRenderer.on(WP_CHANNEL, (_event, payload) => {
  try { applyWallpaper(payload) } catch (error) { console.log('[harbor-preload] wallpaper apply failed:', error && error.message) }
})
