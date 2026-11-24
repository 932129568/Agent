/** 平台白名单：唯一允许访问挂载点、剪贴板与文件下载的位置（LAW-01 白名单）。 */
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
