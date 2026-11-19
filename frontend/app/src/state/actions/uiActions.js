/** UI 域动作：面板、弹窗、主题、功能市场启用集、工作目录绑定。 */
export const uiActions = {
  setPanel(store, panel) {
    return store.update({ uiSlice: prev => ({ ...prev, panel }) }, { reason: 'ui:setPanel' })
  },
  setTheme(store, theme) {
    return store.update({ uiSlice: prev => ({ ...prev, theme }) }, { reason: 'ui:setTheme' })
  },
  toggleDialog(store, name, open) {
    return store.update({
      uiSlice: prev => ({
        ...prev,
        openDialogs: { ...prev.openDialogs, [name]: open === undefined ? !prev.openDialogs[name] : open },
      }),
    }, { reason: 'ui:toggleDialog', name })
  },
  setHubEnabled(store, ids) {
    return store.update({ uiSlice: prev => ({ ...prev, hubEnabled: ids }) },
      { reason: 'ui:setHubEnabled' })
  },
  /** R68 一步生效：启用即写当前会话 pick，下一次发送直接注入角色口令。 */
  setPick(store, sid, pick) {
    return store.update({
      uiSlice: prev => ({
        ...prev,
        hubPicksBySid: { ...prev.hubPicksBySid, [sid]: pick },
      }),
    }, { reason: 'ui:setPick', sid })
  },
  bindWsRoot(store, sid, root) {
    return store.update({
      uiSlice: prev => ({ ...prev, wsRootBySid: { ...prev.wsRootBySid, [sid]: root } }),
    }, { reason: 'ui:bindWsRoot', sid })
  },
}
