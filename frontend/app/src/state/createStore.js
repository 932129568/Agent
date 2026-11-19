/**
 * 单一状态源工厂（规范 §5）。
 *
 * 设计：分片 store + useSyncExternalStore，零外部依赖。
 * 每个 slice 独立订阅，避免 state.js 式 god-module 造成全量重渲染。
 * 禁止调用方直接写 state；写入一律经 actions（骨架里由 update 收口）。
 */
export function createStore(initialSlices) {
  let state = Object.freeze({ ...initialSlices })
  const listeners = new Set()

  function getSnapshot() { return state }
  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  function slice(name) {
    return {
      getSnapshot: () => state[name],
      subscribe,
    }
  }
  /** 唯一写入口：patch 为 { sliceName: nextSlice } 或 { sliceName: (prev)=>next }。 */
  function update(patch, meta = {}) {
    let changed = false
    const next = { ...state }
    for (const [name, value] of Object.entries(patch)) {
      if (!(name in state)) throw new Error('[store] 未知 slice: ' + name)
      const resolved = typeof value === 'function' ? value(state[name]) : value
      if (resolved === state[name]) continue
      next[name] = resolved
      changed = true
    }
    if (!changed) return false
    state = Object.freeze(next)
    for (const listener of listeners) listener(meta)
    return true
  }
  return { getSnapshot, subscribe, slice, update }
}

/** 与 React useSyncExternalStore 对齐的 hook 工厂（避免每处手写订阅样板）。 */
export function makeSliceHook(useSyncExternalStore, store, name) {
  return function useSlice() {
    return useSyncExternalStore(store.slice(name).subscribe,
      store.slice(name).getSnapshot, store.slice(name).getSnapshot)
  }
}
