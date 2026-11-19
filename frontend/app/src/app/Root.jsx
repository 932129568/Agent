import React from 'react'
import ErrorBoundary from '../ui/ErrorBoundary.jsx'
import { StoreProvider } from '../state/storeContext.jsx'

/** 根容器：错误边界 + store Provider，不含业务逻辑。 */
export function Root({ store, children }) {
  return React.createElement(ErrorBoundary, null,
    React.createElement(StoreProvider, { store }, children))
}
