import { useState } from 'react'
import {
  useSlice,
  startExpertTeamRun,
  stopExpertTeamRun,
  setDockPreview,
} from '../../state/store.js'
import MarkdownView from '../../ui/MarkdownView.jsx'
import './ExpertTeamRunner.css'

export default function ExpertTeamRunner() {
  const market = useSlice('market')
  const team = useSlice('expertTeam')
  const [goal, setGoal] = useState('')
  const [selectedIds, setSelectedIds] = useState([])

  const experts = market.experts || []
  const toggleMember = (id) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const pickMembers = () => {
    const chosen = experts.filter((p) => selectedIds.includes(p.id))
    const list = chosen.length ? chosen : experts.slice(0, 3)
    return list.map((p) => {
      const m = p.metadata || p
      return { id: p.id, name: m.displayName || m.name || p.id, description: m.description || '' }
    })
  }

  const handleRun = (useRecovery) => {
    const members = pickMembers()
    if (!members.length) return
    const lead = members[0]
    const taskGoal = goal.trim() || (team.checkpoint && team.checkpoint.goal) || '请针对当前项目给出架构评审与分步落地计划'
    startExpertTeamRun({ goal: taskGoal, lead, members: members.slice(1).length ? members.slice(1) : members, useRecovery })
  }

  return (
    <div className="et-root">
      <div className="et-card">
        <strong style={{ fontSize: 13 }}>多专家团队编排器（串行信箱交接 + 实时时间线 + 断点恢复）</strong>
        <div className="et-chips">
          {experts.map((p) => {
            const m = p.metadata || p
            const name = m.displayName || m.name || p.id
            return (
              <button key={p.id} type="button" className="et-chip" data-active={String(selectedIds.includes(p.id))} onClick={() => toggleMember(p.id)}>
                ✦ {name}
              </button>
            )
          })}
        </div>
        <input className="et-input" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="输入团队协同目标（不选成员默认取前 3 个内置专家）…" />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {team.running ? (
            <button type="button" className="et-chip" data-active="true" onClick={() => stopExpertTeamRun()}>■ 暂停并保存断点</button>
          ) : (
            <button type="button" className="et-chip" data-active="true" onClick={() => handleRun(false)}>▶ 启动专家团队编排</button>
          )}
          {!team.running && team.checkpoint && (
            <button type="button" className="et-chip" onClick={() => handleRun(true)}>↺ 从断点恢复（跳过已完成成员）</button>
          )}
          {team.finalReport && (
            <button type="button" className="et-chip" onClick={() => setDockPreview(team.finalReport)}>送入右侧副屏预览 →</button>
          )}
        </div>
      </div>

      {team.timeline.length > 0 && (
        <div className="et-card">
          <strong style={{ fontSize: 12.5 }}>执行时间线 & 信箱投递（{team.mailbox.length} 封信件）</strong>
          <div className="et-tl">
            {team.timeline.map((ev) => (
              <div key={ev.id} className="et-tl-row">
                <strong>{ev.label}</strong>
                {ev.detail && <div style={{ color: 'var(--text-3)' }}>{ev.detail}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {team.finalReport && (
        <div className="et-card">
          <strong style={{ fontSize: 12.5 }}>团队最终交付报告</strong>
          <MarkdownView content={team.finalReport} />
        </div>
      )}
    </div>
  )
}
