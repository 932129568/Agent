import { useEffect, useState } from 'react'
import { useSlice, refreshPlanning, pushToast } from '../../state/store.js'
import * as api from '../../services/bridge.js'
import './PlanningPanel.css'

export default function PlanningPanel() {
  const planning = useSlice('planning')
  const [title, setTitle] = useState('')
  const [stepsText, setStepsText] = useState('')
  const [confirmRb, setConfirmRb] = useState('')

  useEffect(() => { refreshPlanning().catch(() => {}) }, [])

  const handleCreate = async () => {
    if (!title.trim()) return
    const steps = stepsText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    try {
      await api.planCreate(title.trim(), steps.length ? steps : ['分析现状', '执行修改', '验证收口'])
      setTitle('')
      setStepsText('')
      await refreshPlanning()
      pushToast('任务计划已创建', 'ok')
    } catch (e) {
      pushToast(e.message, 'err')
    }
  }

  const handleRollback = async (taskId) => {
    try {
      const r = await api.checkpointRollback(taskId, '', true)
      setConfirmRb('')
      if (r && r.ok) pushToast(`已回滚至检查点 ${taskId}`, 'ok')
      else pushToast(`回滚失败：${(r && (r.error || r.message)) || '无可用检查点'}`, 'err')
    } catch (e) {
      pushToast(e.message, 'err')
    }
  }

  return (
    <section className="pl-root">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>任务计划与检查点回滚</h2>
        <button type="button" className="pl-btn" onClick={() => refreshPlanning()}>↻ 刷新</button>
      </div>

      <div className="pl-card">
        <div style={{ fontWeight: 600 }}>新建结构化任务计划</div>
        <input className="pl-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="任务标题…" />
        <textarea className="pl-input" rows={3} value={stepsText} onChange={(e) => setStepsText(e.target.value)} placeholder="每行一个执行步骤（留空自动生成三步默认计划）…" />
        <div>
          <button type="button" className="pl-btn pl-btn-primary" onClick={handleCreate}>创建计划</button>
        </div>
      </div>

      <div className="pl-card">
        <div style={{ fontWeight: 600 }}>历史任务与检查点（{planning.plans.length}）</div>
        {planning.plans.length === 0
          ? <div style={{ color: 'var(--text-3)', fontSize: 13 }}>暂无计划记录。</div>
          : planning.plans.map((p) => (
            <div key={p.task_id} className="pl-row">
              <div>
                <strong>{p.title || p.task_id}</strong>
                <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-3)' }}>状态：{p.status || 'planning'}</span>
              </div>
              {confirmRb === p.task_id ? (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="pl-btn pl-btn-primary" onClick={() => handleRollback(p.task_id)}>确认回滚</button>
                  <button type="button" className="pl-btn" onClick={() => setConfirmRb('')}>取消</button>
                </div>
              ) : (
                <button type="button" className="pl-btn" onClick={() => setConfirmRb(p.task_id)}>↺ 回滚到此任务前</button>
              )}
            </div>
          ))}
      </div>
    </section>
  )
}
