import React from 'react'
import { useStore } from '../state/storeContext.jsx'
import { selectActiveRuns, selectTakeoverCandidates } from '../state/selectors.js'
import { appVersion } from '../platform/env.js'
import { LAYOUT_AREAS, LAYOUT_COMPONENTS } from '../layout/index.js'

/**
 * 应用根组件（骨架）。
 * 评审通过后，layout/ 的 10 个占位会被真实区域组件替换，
 * features/ 按 B1–B9 逐域接入；此处只做组合，不含业务逻辑。
 */
export default function App() {
  const store = useStore()
  const state = store.getSnapshot()
  const activeRuns = selectActiveRuns(state)
  const takeovers = selectTakeoverCandidates(state)
  return (
    <React.Fragment>
      {LAYOUT_COMPONENTS.map((Component, index) =>
        React.createElement(Component, { key: LAYOUT_AREAS[index] }))}
      <footer className="harbor-app-status" data-version={appVersion()}>
        {'在途任务 ' + activeRuns.length + ' · 待接管 ' + takeovers.length}
      </footer>
    </React.Fragment>
  )
}
