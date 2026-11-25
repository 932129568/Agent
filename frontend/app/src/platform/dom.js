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
