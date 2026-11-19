import React, { createContext, useContext } from 'react'

/**
 * store 的 React 绑定层（规范 §3 的显式例外：state/ 允许 import React，
 * 但禁止依赖 DOM 与网络）。下沉到这里是为了让 features/ 只向下依赖 state/，
 * 不产生 features → app 的反向边。
 */
export const StoreContext = createContext(null)

export function useStore() {
  const store = useContext(StoreContext)
  if (!store) throw new Error('[Harbor] useStore 必须在 StoreProvider 内使用')
  return store
}

export function StoreProvider({ store, children }) {
  return React.createElement(StoreContext.Provider, { value: store }, children)
}
