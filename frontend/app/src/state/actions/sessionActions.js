/** 会话域动作（规范 §5）：组件不得直接写 store.state，一律经 actions。 */
export const sessionActions = {
  setSessions(store, sessions) {
    return store.update({ sessionSlice: prev => ({ ...prev, sessions }) },
      { reason: 'session:setSessions' })
  },
  setCurrent(store, sid) {
    return store.update({ sessionSlice: prev => ({ ...prev, currentSessionId: sid }) },
      { reason: 'session:setCurrent' })
  },
  setMessages(store, sid, messages) {
    return store.update({
      sessionSlice: prev => ({
        ...prev,
        messagesBySid: { ...prev.messagesBySid, [sid]: messages },
      }),
    }, { reason: 'session:setMessages', sid })
  },
  setRunStatus(store, sid, status) {
    return store.update({
      sessionSlice: prev => ({
        ...prev,
        runStatusBySid: { ...prev.runStatusBySid, [sid]: status },
      }),
    }, { reason: 'session:setRunStatus', sid })
  },
}
