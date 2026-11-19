/** 设置域动作：端点、护栏、本地模型；持久化由 platform/storage.js 负责。 */
export const settingsActions = {
  setEndpoint(store, endpoint) {
    return store.update({ settingsSlice: prev => ({ ...prev, endpoint }) },
      { reason: 'settings:setEndpoint' })
  },
  setGuardLevel(store, guardLevel) {
    return store.update({ settingsSlice: prev => ({ ...prev, guardLevel }) },
      { reason: 'settings:setGuardLevel' })
  },
  setLocalModel(store, localModel) {
    return store.update({ settingsSlice: prev => ({ ...prev, localModel }) },
      { reason: 'settings:setLocalModel' })
  },
  hydrate(store, patch) {
    return store.update({ settingsSlice: prev => ({ ...prev, ...patch }) },
      { reason: 'settings:hydrate' })
  },
}
