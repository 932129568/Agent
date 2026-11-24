let cached = null

export function libs() {
  if (cached) return cached
  cached = Object.freeze({
    marked: globalThis.marked || null,
    purify: globalThis.DOMPurify || null,
    highlight: globalThis.hljs || null,
  })
  return cached
}

export function desktopBridge() {
  return globalThis.HarborDesktop || null
}

export function apiBaseUrl() {
  return String((globalThis.HarborDesktop && globalThis.HarborDesktop.apiBase) || globalThis.HARBOR_API_BASE || '')
}
