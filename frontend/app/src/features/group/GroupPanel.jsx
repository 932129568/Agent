import { useEffect, useState } from 'react'
import {
  useSlice,
  runGroupRelay,
  pauseGroupRelay,
  resumeGroupRelay,
  abortGroupRelay,
  triggerRelayShowcase,
  refreshGroupFiles,
  setDockPreview,
  addGroupMember,
  updateGroupMember,
  removeGroupMember,
  applyGroupPreset,
  setGroupRoutingMode,
} from '../../state/store.js'
import { CAPABILITY_CATALOG, GROUP_ROSTER_PRESETS } from '../../services/capabilityRouter.js'
import { REASONING_TIERS } from '../../services/reasoningPresets.js'
import MarkdownView from '../../ui/MarkdownView.jsx'
import RelayTrackStage from '../../ui/RelayTrackStage.jsx'
import './GroupPanel.css'

export default function GroupPanel() {
  const group = useSlice('group')
  const settings = useSlice('settings')
  const [topic, setTopic] = useState('')
  const [showRoster, setShowRoster] = useState(false)
  const [resumeNote, setResumeNote] = useState('')
  const [newName, setNewName] = useState('')
  const [newPersona, setNewPersona] = useState('')
  const [newModel, setNewModel] = useState('')
  const [newCaps, setNewCaps] = useState(['text'])

  useEffect(() => { refreshGroupFiles().catch(() => {}) }, [])

  const handleSend = () => {
    if (!topic.trim() || group.running) return
    const q = topic.trim()
    setTopic('')
    runGroupRelay(q)
  }

  const toggleCap = (list, capId) => (
    list.includes(capId)
      ? (list.length > 1 ? list.filter((x) => x !== capId) : list)
      : [...list, capId]
  )

  const handleAddMember = () => {
    if (!newName.trim()) return
    addGroupMember({
      name: newName.trim(),
      persona: newPersona.trim() || '按专长完成当前接力棒次任务',
      model: newModel.trim(),
      capabilities: newCaps,
      reasoningTier: 'auto',
    })
    setNewName('')
    setNewPersona('')
    setNewModel('')
    setNewCaps(['text'])
  }

  return (
    <section className="gp-root">
      <div className="gp-head">
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>多角色群聊接力</h2>
          <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-2)' }}>
            支持自定义角色、每角色独立模型/思考档位、按任务能力智能分派（含视频/视觉/代码/长文），以及暂停续跑
          </p>
        </div>
        <div className="gp-controls">
          <button type="button" className="gp-chip-btn" data-active={String(group.routingMode === 'smart')} onClick={() => setGroupRoutingMode('smart')}>
            智能能力路由
          </button>
          <button type="button" className="gp-chip-btn" data-active={String(group.routingMode === 'all')} onClick={() => setGroupRoutingMode('all')}>
            全员按序接力
          </button>
          <button type="button" className="gp-chip-btn" data-active={String(showRoster)} onClick={() => setShowRoster((v) => !v)}>
            ⚙ 自定义角色与模型 ({group.members.length})
          </button>
          <button type="button" className="gp-chip-btn" onClick={() => triggerRelayShowcase()}>
            ▶ 预览光梭接力动画
          </button>
        </div>
      </div>

      {showRoster && (
        <div className="gp-roster-panel">
          <div className="gp-member-row" style={{ justifyContent: 'space-between' }}>
            <strong style={{ fontSize: 13 }}>一键切换行业班底模板</strong>
            <div className="gp-member-row">
              {Object.values(GROUP_ROSTER_PRESETS).map((p) => (
                <button key={p.id} type="button" className="gp-chip-btn" onClick={() => applyGroupPreset(p.id)} title={p.desc}>
                  + {p.name}
                </button>
              ))}
            </div>
          </div>

          {group.members.map((m, idx) => (
            <div key={m.id} className="gp-member-card">
              <div className="gp-member-row">
                <span style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>#{idx + 1}</span>
                <input className="gp-field-sm" style={{ width: 126 }} value={m.name} onChange={(e) => updateGroupMember(m.id, { name: e.target.value })} placeholder="角色名" />
                <input className="gp-field-sm" style={{ flex: 1, minWidth: 160 }} value={m.persona} onChange={(e) => updateGroupMember(m.id, { persona: e.target.value })} placeholder="人设与职责描述" />
                <input className="gp-field-sm" style={{ width: 150 }} value={m.model || ''} onChange={(e) => updateGroupMember(m.id, { model: e.target.value })} placeholder="独立模型名（留空继承）" />
                <select className="gp-field-sm" value={m.reasoningTier || 'auto'} onChange={(e) => updateGroupMember(m.id, { reasoningTier: e.target.value })} title="独立思考档位">
                  {REASONING_TIERS.filter((t) => t.id !== 'custom').map((t) => (
                    <option key={t.id} value={t.id}>思考:{t.label}</option>
                  ))}
                </select>
                <button type="button" className="gp-chip-btn" onClick={() => removeGroupMember(m.id)}>删</button>
              </div>
              <div className="gp-member-row">
                <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>声明能力：</span>
                {CAPABILITY_CATALOG.map((cap) => (
                  <button
                    key={cap.id}
                    type="button"
                    className="gp-chip-btn"
                    data-active={String((m.capabilities || []).includes(cap.id))}
                    onClick={() => updateGroupMember(m.id, { capabilities: toggleCap(m.capabilities || ['text'], cap.id) })}
                  >
                    {cap.label}
                  </button>
                ))}
                <input className="gp-field-sm" style={{ flex: 1, minWidth: 150 }} value={m.baseUrl || ''} onChange={(e) => updateGroupMember(m.id, { baseUrl: e.target.value })} placeholder="可选：独立 Base URL（跨供应商混跑）" />
              </div>
            </div>
          ))}

          <div className="gp-member-card">
            <strong style={{ fontSize: 12 }}>+ 新增自定义角色</strong>
            <div className="gp-member-row">
              <input className="gp-field-sm" style={{ width: 130 }} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="新角色名（如分镜导演）" />
              <input className="gp-field-sm" style={{ flex: 1, minWidth: 160 }} value={newPersona} onChange={(e) => setNewPersona(e.target.value)} placeholder="职责与输出要求" />
              <input className="gp-field-sm" style={{ width: 150 }} value={newModel} onChange={(e) => setNewModel(e.target.value)} placeholder="指定模型名（可选）" />
              <button type="button" className="gp-chip-btn" data-active="true" onClick={handleAddMember}>添加角色</button>
            </div>
            <div className="gp-member-row">
              {CAPABILITY_CATALOG.map((cap) => (
                <button key={cap.id} type="button" className="gp-chip-btn" data-active={String(newCaps.includes(cap.id))} onClick={() => setNewCaps((c) => toggleCap(c, cap.id))}>
                  {cap.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {group.routingWarning && <div className="gp-warn">⚠ {group.routingWarning}</div>}

      <RelayTrackStage
        status={group.status}
        members={group.activeMembers && group.activeMembers.length ? group.activeMembers : group.members}
        activeIndex={group.activeIndex}
        handoffFrom={group.handoffFrom}
        handoffTo={group.handoffTo}
        liveContent={group.liveContent}
        liveReasoning={group.liveReasoning}
        cps={group.cps}
        intentLabel={group.lastIntent ? group.lastIntent.label : ''}
        motionTier={settings.motion}
      />

      <div className="gp-feed">
        {group.messages.length === 0 && group.status === 'idle' ? (
          <div style={{ color: 'var(--text-3)', fontSize: 13 }}>
            当前名册：{group.members.map((m) => `${m.name}(${(m.capabilities || []).join('/')})`).join(' ⟶ ')}。
            输入议题发起接力，或点上方「⚙ 自定义角色与模型」一键切换「视频制作班底」或自定义成员。
          </div>
        ) : (
          group.messages.map((m) => (
            <article key={m.id} className="gp-msg">
              <div className="gp-author">
                <span>
                  {m.author}
                  {m.model && <span className="gp-model-tag">{m.model}</span>}
                </span>
                {m.role === 'assistant' && (
                  <button type="button" className="gp-chip-btn" onClick={() => setDockPreview(`### ${m.author}\n\n${m.content}`)}>
                    副屏预览 →
                  </button>
                )}
              </div>
              {m.reasoning && (
                <details style={{ marginBottom: 8, fontSize: 12, color: 'var(--text-3)' }}>
                  <summary style={{ cursor: 'pointer' }}>查看本棒思考过程</summary>
                  <pre style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{m.reasoning}</pre>
                </details>
              )}
              <MarkdownView content={m.content} />
            </article>
          ))
        )}
      </div>

      {group.status === 'paused' && group.checkpoint && (
        <div className="gp-pause-bar">
          <div className="gp-member-row" style={{ justifyContent: 'space-between' }}>
            <strong>接力已暂停于第 {group.checkpoint.nextIndex + 1} 棒（可修改名册模型或补充一句指导后继续）</strong>
            <div className="gp-member-row">
              <button type="button" className="gp-btn" onClick={() => { const n = resumeNote; setResumeNote(''); resumeGroupRelay(n) }}>▶ 继续接力</button>
              <button type="button" className="gp-btn gp-btn-err" onClick={() => abortGroupRelay()}>× 放弃本轮</button>
            </div>
          </div>
          <input className="gp-field-sm" value={resumeNote} onChange={(e) => setResumeNote(e.target.value)} placeholder="可选：给接下来接力成员补一句方向纠偏…" />
        </div>
      )}

      <div className="gp-bar">
        <input
          className="gp-input"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSend() }}
          placeholder="输入议题（如：制作一段 60 秒科技产品宣传视频分镜脚本 / 重构缓存失效方案）…"
        />
        {group.running ? (
          <>
            <button type="button" className="gp-btn gp-btn-warn" onClick={() => pauseGroupRelay()}>⏸ 暂停</button>
            <button type="button" className="gp-btn gp-btn-err" onClick={() => abortGroupRelay()}>■ 中止</button>
          </>
        ) : (
          <button type="button" className="gp-btn" onClick={handleSend}>发起接力</button>
        )}
      </div>
    </section>
  )
}
