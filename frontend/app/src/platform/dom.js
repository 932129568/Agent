/** 平台白名单：唯一允许访问挂载点、剪贴板与文件读写的出口（LAW-01 白名单）。 */
export function mountPoint(id = 'harbor-app-root') {
  return typeof document !== 'undefined' ? document.getElementById(id) : null
}

export async function copyText(text) {
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(String(text || ''))
    return true
  }
  return false
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'))
    reader.readAsText(file)
  })
}

/** 浏览器原生 Blob 下载（用于一键导出 Markdown 会话纪要与 HTML/SVG Artifact）。 */
export function downloadTextFile(filename, text, mimeType = 'text/plain;charset=utf-8') {
  if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') return false
  const blob = new Blob([String(text || '')], { type: mimeType })
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = String(filename || 'harbor-export.txt')
    document.body.appendChild(a)
    a.click()
    a.remove()
    return true
  } finally {
    setTimeout(() => { try { URL.revokeObjectURL(url) } catch {} }, 800)
  }
}


export function createOffscreenCanvas(width, height) {
  if (typeof document === 'undefined') return null
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  return c
}


/**
 * R28 液态玻璃沙盒与 3D 助手 DOM 适配器（集中于 LAW-01 唯一白名单 platform/dom.js）：
 * - 给所有液态玻璃方块（按钮、导航胶囊、状态岛、快捷卡、输入框等）提供稳定坐标、原位隐藏（抓起后绝不留残影在原地）与点击/聚焦操作；
 */
const GLASS_TARGET_SELECTOR = [
  '.hb-rail-btn',
  '.hb-island',
  '.hb-top-btn',
  '.chat-quick-card',
  '.chat-mini-btn',
  '.mp-trigger',
].join(', ')

let _glassAutoSeq = 0

export function ensureGlassElementId(el) {
  if (!el || typeof el.getAttribute !== 'function') return ''
  let id = el.getAttribute('data-glass-id')
  if (id) return id
  const title = (el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 22)
  id = `gb_${++_glassAutoSeq}_${title.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]+/g, '_').slice(0, 14) || 'blk'}`
  el.setAttribute('data-glass-id', id)
  return id
}

export function findClosestGlassElement(target) {
  if (!target || typeof target.closest !== 'function') return null
  if (target.closest('.ov-modal, .cp-root, .gs-panel, .mp-panel, .dm-panel, .gsb-layer')) return null
  const el = target.closest(GLASS_TARGET_SELECTOR)
  if (!el) return null
  const rect = el.getBoundingClientRect()
  if (!rect || rect.width < 24 || rect.height < 20 || rect.width > 520 || rect.height > 220) return null
  return el
}

export function collectVisibleGlassBlocks() {
  if (typeof document === 'undefined') return []
  const nodes = Array.from(document.querySelectorAll(GLASS_TARGET_SELECTOR))
  const out = []
  for (const el of nodes) {
    if (el.closest('.ov-modal, .cp-root, .gsb-layer')) continue
    const r = el.getBoundingClientRect()
    if (!r || r.width < 28 || r.height < 22 || r.width > 480 || r.height > 180) continue
    if (r.right < 0 || r.bottom < 0 || r.left > (window.innerWidth || 1400) || r.top > (window.innerHeight || 900)) continue
    const id = ensureGlassElementId(el)
    const label = (el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent || '液态玻璃').replace(/\s+/g, ' ').trim().slice(0, 26)
    const cs = getComputedStyle(el)
    out.push({
      id,
      label,
      x: r.left,
      y: r.top,
      w: r.width,
      h: r.height,
      radius: parseFloat(cs.borderRadius) || 14,
    })
  }
  return out
}

export function findGlassElementById(glassId) {
  if (typeof document === 'undefined' || !glassId) return null
  const safe = String(glassId).replace(/"/g, '\\"')
  return document.querySelector(`[data-glass-id="${safe}"]`)
}

export function getGlassRectById(glassId) {
  const el = findGlassElementById(glassId)
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (!r || (r.width === 0 && r.height === 0)) return null
  return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
}

/** 抓起/碎裂后原位方块彻底隐藏（绝不留在原地！），归位或修补完成后恢复可见 */
export function setGlassSourceVisibility(glassId, visible) {
  const el = findGlassElementById(glassId)
  if (!el) return false
  el.style.visibility = visible ? '' : 'hidden'
  el.style.pointerEvents = visible ? '' : 'none'
  if (visible) el.removeAttribute('data-glass-detached')
  else el.setAttribute('data-glass-detached', 'true')
  return true
}

/** 3D 助手按语义定位软件内真实按钮坐标并代用户点击 */
export function findUiControlByHint(hint = '') {
  if (typeof document === 'undefined') return null
  const selectors = {
    settings: '.hb-rail-btn[title="系统设置"]',
    market: '.hb-rail-btn[title*="专家"]',
    chat: '.hb-rail-btn[title="智能对话"]',
    group: '.hb-rail-btn[title="角色群聊"]',
    workflow: '.hb-rail-btn[title="工作流插件"]',
    workspace: '.hb-rail-btn[title="工作空间"]',
    more: '.hb-rail-more-toggle',
    search: '.hb-topbar button[title*="工具箱"]',
    model: '.hb-island',
    appearance: '.hb-topbar button[title*="外观"]',
    composer: '.chat-textarea',
    send: '.chat-send-btn',
  }
  const sel = selectors[hint] || hint
  if (!sel) return null
  let el = null
  try { el = document.querySelector(sel) } catch {}
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (!r || (r.width === 0 && r.height === 0)) return null
  return { el, x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
}

export function triggerUiControlClick(hint = '') {
  const hit = findUiControlByHint(hint)
  if (!hit || !hit.el) return false
  try {
    hit.el.click()
    return true
  } catch {
    return false
  }
}

export function focusComposerInput() {
  const hit = findUiControlByHint('composer')
  if (hit && hit.el && typeof hit.el.focus === 'function') {
    hit.el.focus()
    return hit
  }
  return null
}
