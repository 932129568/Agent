/** 派生选择器（规范 §5）：跨 slice 逻辑只在这里，组件不得自行重算。 */
export const selectCurrentSession = (state) =>
  state.sessionSlice.sessions.find(s => s.id === state.sessionSlice.currentSessionId) || null

export const selectCurrentMessages = (state) =>
  state.sessionSlice.messagesBySid[state.sessionSlice.currentSessionId] || []

export const selectCurrentRunStatus = (state) =>
  state.sessionSlice.runStatusBySid[state.sessionSlice.currentSessionId] || 'idle'

export const selectActiveRuns = (state) => state.runtimeSlice.activeRuns

/** 失败/挂起即接管点（架构原则②）：从运行时态派生可接管项。 */
export const selectTakeoverCandidates = (state) =>
  state.runtimeSlice.activeRuns.filter(r => r.status === 'failed' || r.status === 'paused')

export const selectCurrentPick = (state) =>
  state.uiSlice.hubPicksBySid[state.sessionSlice.currentSessionId] || null

export const selectWsRoot = (state) =>
  state.uiSlice.wsRootBySid[state.sessionSlice.currentSessionId] || null
