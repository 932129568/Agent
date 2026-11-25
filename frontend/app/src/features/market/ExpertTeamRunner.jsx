import { useEffect, useMemo, useState } from 'react'
import { useSlice, startExpertTeamRun, stopExpertTeamRun, setDockPreview } from '../../state/store.js'
import { TEAM_CATEGORIES, buildAvailableTeams, safeExpertText } from '../../services/expertTeam.js'
import MarkdownView from '../../ui/MarkdownView.jsx'
import './ExpertTeamRunner.css'

export default function ExpertTeamRunner() {
  const ui = useSlice('ui')
  const market = useSlice('market')
  const team = useSlice('expertTeam')
  const [cat, setCat] = useState('all')
  const [selectedTeamId, setSelectedTeamId] = useState(() => ui.marketTeamId || 'software-company')

  useEffect(() => {
    if (ui.marketTeamId && ui.marketTeamId !== selectedTeamId) setSelectedTeamId(ui.marketTeamId)
  }, [ui.marketTeamId])
  const [goal, setGoal] = useState('')

  const allTeams = useMemo(() => buildAvailableTeams(market.experts || []), [market.experts])
  const visibleTeams = useMemo(() => (cat === 'all' ? allTeams : allTeams.filter((t) => t.category === cat)), [allTeams, cat])
  const activeTeam = useMemo(() => visibleTeams.find((t) => t.id === selectedTeamId) || allTeams.find((t) => t.id === selectedTeamId) || allTeams[0], [visibleTeams, allTeams, selectedTeamId])

  const handleLaunch = (useRecovery = false) => {
    if (!activeTeam) return
    const taskGoal = goal.trim() || (team.checkpoint && team.checkpoint.goal) || activeTeam.defaultGoal
    startExpertTeamRun({ goal: taskGoal, lead: activeTeam.lead, members: activeTeam.members, useRecovery })
  }

  return (
    <div className="et-root" data-section="expert-team-runner">
      <div className="et-filter-row" role="tablist" aria-label="专家团队分类">
        {TEAM_CATEGORIES.map((c) => (
          <button key={c.id} type="button" className="et-btn" data-active={String(cat === c.id)} onClick={() => setCat(c.id)}>{c.label}</button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-3)' }}>共 {visibleTeams.length} 支成建制原生团队</span>
      </div>

      <div className="et-split">
        <div className="et-roster-col" aria-label="原生专家团队列表">
          {visibleTeams.map((t) => (
            <button key={t.id} type="button" className="et-team-card" data-selected={String(activeTeam && activeTeam.id === t.id)}
              style={{ '--team-accent': t.accent || 'var(--primary)' }} onClick={() => setSelectedTeamId(t.id)}>
              <div className="et-team-head">
                <div><div className="et-team-name">{t.name}</div><div className="et-team-sub">{t.subtitle}</div></div>
                <span className="et-team-badge">{1 + (t.members ? t.members.length : 0)}人团</span>
              </div>
              <div className="et-team-tag">{t.tagline}</div>
              <div className="et-org-mini">
                <span className="et-role-pill" data-lead="true">👑 {safeExpertText(t.lead && t.lead.name)}</span>
                {(t.members || []).slice(0, 3).map((m) => <span key={m.id} className="et-role-pill">{safeExpertText(m.name)}</span>)}
                {(t.members || []).length > 3 && <span className="et-role-pill">+{(t.members || []).length - 3}</span>}
              </div>
            </button>
          ))}
        </div>

        <div className="et-detail-col">
          {activeTeam && (
            <section className="et-console" aria-label="专家团任务派发控制台">
              <div className="et-console-head">
                <div>
                  <div style={{ fontSize: 16, fontWeight: 750, color: 'var(--text)' }}>{activeTeam.name}</div>
                  <div style={{ marginTop: 3, fontSize: 12, color: 'var(--text-3)' }}>{activeTeam.subtitle} · 串行信箱接力 + 总监终审定稿</div>
                </div>
                <button type="button" className="et-btn" onClick={() => setGoal(activeTeam.defaultGoal)}>填入示范任务</button>
              </div>
              <div className="et-pipeline" aria-label="团队组织协作流水线">
                {(activeTeam.members || []).map((m, idx) => (
                  <div key={m.id} className="et-node">
                    <span className="et-node-role">Step {idx + 1} · {safeExpertText(m.role)}</span>
                    <span className="et-node-title">{safeExpertText(m.name)}</span>
                    {m.description && <span className="et-node-desc">{safeExpertText(m.description)}</span>}
                  </div>
                ))}
                <div className="et-node" data-lead="true">
                  <span className="et-node-role">终审定稿 · {safeExpertText(activeTeam.lead && activeTeam.lead.role)}</span>
                  <span className="et-node-title">👑 {safeExpertText(activeTeam.lead && activeTeam.lead.name)}</span>
                  {activeTeam.lead && activeTeam.lead.description && <span className="et-node-desc">{safeExpertText(activeTeam.lead.description)}</span>}
                </div>
              </div>
              {Array.isArray(activeTeam.deliverables) && activeTeam.deliverables.length > 0 && (
                <div className="et-deliverables">
                  <strong>标准交付物：</strong>
                  {activeTeam.deliverables.map((d) => <span key={d} className="et-deliv-chip">✓ {d}</span>)}
                </div>
              )}
              <textarea className="et-textarea" value={goal} onChange={(e) => setGoal(e.target.value)}
                placeholder={`向「${activeTeam.name}」下达任务目标（留空则按示范任务启动）：\n${activeTeam.defaultGoal}`} />
              <div className="et-actions">
                {team.running ? (
                  <button type="button" className="et-btn et-btn-primary" onClick={() => stopExpertTeamRun()}>■ 暂停编排并保存断点</button>
                ) : (
                  <button type="button" className="et-btn et-btn-primary" onClick={() => handleLaunch(false)}>▶ 派发任务给「{activeTeam.name}」</button>
                )}
                {!team.running && team.checkpoint && <button type="button" className="et-btn" onClick={() => handleLaunch(true)}>↺ 从断点续跑</button>}
                {team.finalReport && <button type="button" className="et-btn" onClick={() => setDockPreview(team.finalReport)}>送入右侧副屏阅读 →</button>}
              </div>
            </section>
          )}
          {team.timeline.length > 0 && (
            <div className="et-console">
              <strong style={{ fontSize: 13 }}>实时协作时间线 & 信箱投递（{team.mailbox.length} 封信件）</strong>
              <div className="et-tl">
                {team.timeline.map((ev) => (
                  <div key={ev.id} className="et-tl-row">
                    <strong>{safeExpertText(ev.label)}</strong>
                    {ev.detail && <div style={{ color: 'var(--text-3)', marginTop: 2 }}>{safeExpertText(ev.detail)}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {team.finalReport && (
            <div className="et-console">
              <strong style={{ fontSize: 13 }}>团队最终交付报告</strong>
              <MarkdownView content={team.finalReport} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
