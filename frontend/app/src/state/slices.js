/** 四个状态分片（规范 §5）。全部为纯数据，不含 React / DOM / 网络。 */
export const initialSlices = {
  sessionSlice: {
    sessions: [],
    currentSessionId: null,
    messagesBySid: {},
    runStatusBySid: {},
  },
  uiSlice: {
    panel: 'chat',
    theme: 'dark',
    openDialogs: {},
    hubEnabled: [],
    hubPicksBySid: {},
    wsRootBySid: {},
  },
  runtimeSlice: {
    activeRuns: [],
    toolProgressBySid: {},
    takeoverBySid: {},
    streaming: false,
  },
  settingsSlice: {
    endpoint: null,
    guardLevel: 'default',
    localModel: null,
  },
}

/** 空态工厂，便于测试隔离。 */
export function emptySlices() {
  return JSON.parse(JSON.stringify(initialSlices))
}
