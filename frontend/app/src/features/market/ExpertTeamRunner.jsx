import { useMemo, useState } from 'react'
import {
  useSlice,
  startExpertTeamRun,
  stopExpertTeamRun,
  setDockPreview,
  pushToast,
} from '../../state/store.js'
import { CURATED_INDUSTRY_PACKS } from '../../services/industryExperts.js'
import { DREAM_TEAM_PRESETS, safeExpertText } from '../../services/expertTeam.js'
import MarkdownView from '../../ui/MarkdownView.jsx'
import './ExpertTeamRunner.css'

export default function ExpertTeamRunner() {
  const market = useSlice('market')
  const team = useSlice('expertTeam')
  const [goal, setGoal] = useState('')
  const [filterText, setFilterText] = useState('')
  const [selectedIds, setSelectedIds] = useState(['superpowers-tdd-architect', 'frontend-ui-craft', 'security-code-auditor'])

  // R24 修复与扩容：安全融合 56 大行业专家库 + 本地 .codebuddy-plugin 包，全部通过 safeExpertText 解包 {en, zh}，彻底根绝 React #31
  const allExperts = useMemo(() => {
    const map = new Map()
    for (const pack of CURATED_INDUSTRY_PACKS) {
      map.set(pack.id, {
        id: pack.id,
        name: safeExpertText(pack.name, pack.id),
        categoryLabel: safeExpertText(pack.categoryLabel, '行业专家'),
        description: safeExpertText(pack.description, ''),
        prompt: safeExpertText(pack.prompt, ''),
        source: 'curated',
      })
    }
    for (const pkg of (market.experts || [])) {
      if (!pkg || !pkg.id) continue
      const m = pkg.metadata || pkg
      const name = safeExpertText(m.displayName, safeExpertText(m.name, pkg.id))
      const desc = safeExpertText(m.displayDescription || m.description, '')
      if (!map.has(pkg.id)) {
        map.set(pkg.id, {
          id: pkg.id,
          name,
          categoryLabel: safeExpertText(m.profession, '本地包'),
          description: desc,
          prompt: '',
          source: 'local',
        })
      }
    }
    return Array.from(map.values())
  }, [market.experts])

  const expertById = useMemo(() => {
    const m = new Map()
    for (const item of allExperts) m.set(item.id, item)
    return m
  }, [allExperts])

  const visibleExperts = useMemo(() => {
    const q = filterText.trim().toLowerCase()
    if (!q) return allExperts
    return allExperts.filter((e) => (
      e.name.toLowerCase().includes(q)
      || e.categoryLabel.toLowerCase().includes(q)
      || e.description.toLowerCase().includes(q)
      || e.id.toLowerCase().includes(q)
    ))
  }, [allExperts, filterText])

  const selectedExperts = useMemo(
    () => selectedIds.map((id) => expertById.get(id)).filter(Boolean),
    [selectedIds, expertById]
  )

  const toggleMember = (id) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const applyPreset = (preset) => {
    const validIds = (preset.memberIds || []).filter((id) => expertById.has(id))
    setSelectedIds(validIds.length ? validIds : allExperts.slice(0, 3).map((e) => e.id))
    if (!goal.trim() && preset.defaultGoal) setGoal(preset.defaultGoal)
    pushToast(`已装配「${preset.name}」编队（${validIds.length} 位专家）`, 'ok')
  }

  const handleRun = (useRecovery) => {
    const list = selectedExperts.length ? selectedExperts : allExperts.slice(0, 3)
    if (!list.length) return
    const lead = list[0]
    const squad = list.slice(1).length ? list.slice(1) : list
    const taskGoal = goal.trim() || (team.checkpoint && team.checkpoint.goal) || '请针对当前项目给出架构评审与分步落地计划'
    startExpertTeamRun({ goal: taskGoal, lead, members: squad, useRecovery })
  }

  return (
    <div className="et-root" data-section="expert-team-runner">
      <div className="et-card">
        <div className="et-head">
          <strong style={{ fontSize: 13.5 }}>✦ 多专家梦之队编排器（{allExperts.length} 位可用专家 · 串行信箱 + 断点恢复）</strong>
          {selectedExperts.length > 0 && (
            <button type="button" className="et-chip" onClick={() => setSelectedIds([])}>清空编队</button>
          )}
        </div>
        <div className="et-sub">
          第 1 位已选专家担任<strong>主理专家 (Lead)</strong> 负责汇总定稿，其余专家依次完成各自专业模块并投递信箱交接。
        </div>

        <div className="et-presets" aria-label="一键梦之队预设">
          {DREAM_TEAM_PRESETS.map((preset) => (
            <button key={preset.id} type="button" className="et-preset-btn" onClick={() => applyPreset(preset)}>
              <strong>{preset.name}</strong>
              <span>{preset.badge} · {preset.memberIds.length} 位黄金搭档</span>
            </button>
          ))}
        </div>

        <div className="et-roster-bar" aria-label="当前出战编队">
          <span style={{ color: 'var(--text-3)', fontWeight: 600 }}>当前出战 ({selectedExperts.length})：</span>
          {selectedExperts.length === 0 ? (
            <span style={{ color: 'var(--text-3)' }}>未手动勾选时将自动挑选前 3 位专家</span>
          ) : (
            selectedExperts.map((m, idx) => (
              <span key={m.id} className="et-selected-pill">
                <span>{idx === 0 ? '👑 主理' : `#${idx + 1}`} {m.name}</span>
                <button type="button" aria-label={`移除 ${m.name}`} onClick={() => toggleMember(m.id)}>×</button>
              </span>
            ))
          )}
        </div>

        <input
          className="et-input"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder={`筛选 ${allExperts.length} 位行业/本地专家加入编队（如：架构、短剧、小红书、法务、数据库）…`}
        />

        <div className="et-chips" role="group" aria-label="可选专家池">
          {visibleExperts.map((p) => {
            const active = selectedIds.includes(p.id)
            return (
              <button
                key={p.id}
                type="button"
                className="et-chip"
                data-active={String(active)}
                title={p.description || p.name}
                onClick={() => toggleMember(p.id)}
              >
                {active ? '✓ ' : '✦ '}{p.name}
              </button>
            )
          })}
        </div>

        <input
          className="et-input"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="输入团队协同目标（可先点上方梦之队预设自动填充，也可直接输入你的真实任务）…"
        />

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {team.running ? (
            <button type="button" className="et-chip et-chip-primary" onClick={() => stopExpertTeamRun()}>■ 暂停并保存断点</button>
          ) : (
            <button type="button" className="et-chip et-chip-primary" onClick={() => handleRun(false)}>▶ 启动专家团队编排</button>
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
                <strong>{safeExpertText(ev.label)}</strong>
                {ev.detail && <div style={{ color: 'var(--text-3)' }}>{safeExpertText(ev.detail)}</div>}
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
