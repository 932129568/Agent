/**
 * 缓存 / 单飞 / 重试（规范 §6）：统一收口，禁止散落在组件。
 * 零 DOM、零 React、零全局符号。
 */
import { HarborError, isAbort } from './errors.js'

export function createCache({ ttlMs = 60_000, maxEntries = 200 } = {}) {
  const entries = new Map()
  return {
    get(key) {
      const hit = entries.get(key)
      if (!hit) return undefined
      if (hit.expiresAt < Date.now()) { entries.delete(key); return undefined }
      return hit.value
    },
    set(key, value, ttl = ttlMs) {
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value)
      entries.set(key, { value, expiresAt: Date.now() + ttl })
      return value
    },
    invalidate(key) {
      if (key === undefined) entries.clear()
      else entries.delete(key)
    },
    get size() { return entries.size },
  }
}

/** 同 key 并发只发一次请求（对应 server 侧 get_config / build_tools 缓存）。 */
export function createSingleFlight() {
  const inflight = new Map()
  return function singleFlight(key, producer) {
    if (inflight.has(key)) return inflight.get(key)
    const promise = Promise.resolve().then(producer).finally(() => inflight.delete(key))
    inflight.set(key, promise)
    return promise
  }
}

/** 有界重试：429 / 5xx 可重试，用户中止立即透传不重试。 */
export async function withRetry(producer, { retries = 2, baseDelayMs = 300, signal, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise(r => setTimeout(r, ms)))
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal && signal.aborted) throw new HarborError('USER_PAUSED', '用户暂停')
    try {
      return await producer(attempt)
    } catch (error) {
      lastError = error
      if (isAbort(error) || attempt === retries) throw error
      await wait(baseDelayMs * (2 ** attempt))
    }
  }
  throw lastError
}
