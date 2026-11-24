export function readStorage(key, fallback = '') {
  try {
    const v = globalThis.localStorage ? globalThis.localStorage.getItem(key) : null
    return v === null ? fallback : v
  } catch {
    return fallback
  }
}

export function writeStorage(key, value) {
  try {
    if (globalThis.localStorage) globalThis.localStorage.setItem(key, String(value))
    return true
  } catch {
    return false
  }
}
