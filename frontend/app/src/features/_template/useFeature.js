/** 模板 hook：组件与状态/服务之间的唯一编排层。 */
import { useSyncExternalStore } from 'react'
import { useStore } from '../../state/storeContext.jsx'
import { selectCurrentSession } from '../../state/selectors.js'
import { loadFeatureData } from './service.js'

export function useFeature() {
  const store = useStore()
  const session = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const current = selectCurrentSession(session)
  return {
    current,
    async reload(signal) {
      const data = await loadFeatureData([], { signal })
      store.update({ settingsSlice: prev => ({ ...prev, featureData: data }) },
        { reason: 'feature:reload' })
      return data
    },
  }
}
