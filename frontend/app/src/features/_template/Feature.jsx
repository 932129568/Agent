import Button from '../../ui/Button.jsx'
import { useFeature } from './useFeature.js'

/** 模板组件：props/state 驱动，零原生 DOM 操作。 */
export default function Feature() {
  const { current, reload } = useFeature()
  return (
    <div className="harbor-feature">
      <span>{current ? current.title : '未选择会话'}</span>
      <Button onClick={() => { Promise.resolve(reload()).catch(() => {}) }}>刷新</Button>
    </div>
  )
}
