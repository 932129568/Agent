/**
 * Harbor 响应式状态内核（R15 架构解耦）：
 * - 独立收口 pub-sub 订阅、浅相等去重切片更新、useSyncExternalStore Hook 与会话级遥测同步；
 * - 零循环依赖，供 store.js 与后续领域切片共享，将底层引擎从 2,100 行单体解耦。
 */
import { useSyncExternalStore } from 'react'

export const EMPTY_CACHE_TOTALS = Object.freeze({
  promptTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  hitRate: 0,
  turnPromptTokens: 0,
  turnCachedTokens: 0,
  latestHitRate: 0,
  latestPromptTokens: 0,
  latestCachedTokens: 0,
  prefixHash: '',
  prefixLocked: false,
})

let _state = null
const _listeners = new Set()

function shallowEqualObj(a, b) {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i]
    if (!Object.prototype.hasOwnProperty.call(b, k) || !Object.is(a[k], b[k])) return false
  }
  return true
}

export function initKernel(initialState) {
  _state = initialState
  return _state
}

export function getState() {
  return _state
}

export function subscribe(fn) {
  _listeners.add(fn)
  return () => _listeners.delete(fn)
}

export function patchSlice(sliceName, updater) {
  const prev = _state[sliceName]
  const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater }
  if (shallowEqualObj(prev, next)) return _state
  _state = Object.freeze({ ..._state, [sliceName]: Object.freeze(next) })
  for (const fn of _listeners) {
    try { fn(_state) } catch {}
  }
  return _state
}

export function useSlice(name) {
  return useSyncExternalStore(subscribe, () => _state[name], () => _state[name])
}

export function useStoreSelector(selector) {
  return useSyncExternalStore(subscribe, () => selector(_state), () => selector(_state))
}

export function activeViewSid() {
  if (!_state) return ''
  return _state.ui.activePanel === 'group' ? _state.group.activeGroupId : _state.sessions.currentId
}

export function syncRuntimeTelemetryForSid(targetSid) {
  return patchSlice('runtime', (r) => ({
    ...r,
    cacheTotals: (targetSid && r.cacheTotalsBySid && r.cacheTotalsBySid[targetSid]) || { ...EMPTY_CACHE_TOTALS },
    activeToolProfile: (targetSid && r.toolProfileBySid && r.toolProfileBySid[targetSid]) || null,
  }))
}
