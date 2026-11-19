/** 运行时动作：在途 run、工具进度、接管态（架构原则①过程可见 ②失败即接管）。 */
export const runtimeActions = {
  setActiveRuns(store, runs) {
    return store.update({ runtimeSlice: prev => ({ ...prev, activeRuns: runs }) },
      { reason: 'runtime:setActiveRuns' })
  },
  setToolProgress(store, sid, progress) {
    return store.update({
      runtimeSlice: prev => ({
        ...prev,
        toolProgressBySid: { ...prev.toolProgressBySid, [sid]: progress },
      }),
    }, { reason: 'runtime:setToolProgress', sid })
  },
  setStreaming(store, streaming) {
    return store.update({ runtimeSlice: prev => ({ ...prev, streaming }) },
      { reason: 'runtime:setStreaming' })
  },
  clearTakeover(store, sid) {
    return store.update({
      runtimeSlice: prev => {
        const next = { ...prev.takeoverBySid }
        delete next[sid]
        return { ...prev, takeoverBySid: next }
      },
    }, { reason: 'runtime:clearTakeover', sid })
  },
}
