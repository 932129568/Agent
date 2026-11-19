/**
 * 持久化（规范 §5/§2）：唯一写本地存储的位置。
 * 硬约束：只写独立 key，绝不触碰 config.json（config.json 零污染铁律）。
 */
const PREFIX = 'harbor_app_'
const FORBIDDEN = new Set(['config.json', 'config'])

export function storageKey(name) {
  if (FORBIDDEN.has(String(name).toLowerCase())) {
    throw new Error('[storage] 禁止写入 config.json 相关键: ' + name)
  }
  return PREFIX + name
}

export function readJson(name, fallback = null) {
  try {
    const raw = globalThis.localStorage && globalThis.localStorage.getItem(storageKey(name))
    return raw ? JSON.parse(raw) : fallback
  } catch (_) { return fallback }
}

export function writeJson(name, value) {
  try {
    if (!globalThis.localStorage) return false
    globalThis.localStorage.setItem(storageKey(name), JSON.stringify(value))
    return true
  } catch (_) { return false }
}

export function remove(name) {
  try {
    if (globalThis.localStorage) globalThis.localStorage.removeItem(storageKey(name))
    return true
  } catch (_) { return false }
}
