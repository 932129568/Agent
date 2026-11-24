import { useEffect, useMemo, useState } from 'react'
import {
  useSlice,
  runGroupRelay,
  pauseGroupRelay,
  resumeGroupRelay,
  abortGroupRelay,
  triggerRelayShowcase,
  refreshGroupFiles,
  openGroupFileInDock,
  openGroupFilesFolder,
  deleteGroupFile,
  resolvePendingApproval,
  setDockPreview,
  addGroupMember,
  updateGroupMember,
  removeGroupMember,
  applyGroupPreset,
  setGroupRoutingMode,
  setAskBeforeDesign,
  openArtifactCanvas,
  exportCurrentGroupMarkdown,
  convertGroupToWorkflow,
  pushToast,
} from '../../state/store.js'
import { CAPABILITY_CATALOG, GROUP_ROSTER_PRESETS, inferMemberCapabilities } from '../../services/capabilityRouter.js'
import { REASONING_TIERS } from '../../services/reasoningPresets.js'
import { copyText } from '../../platform/dom.js'
import { estTokens, historyTokens } from '../../services/compaction.js'
import { extractArtifactsFromMarkdown } from '../../services/artifacts.js'
import MarkdownView from '../../ui/MarkdownView.jsx'
import RelayTrackStage from '../../ui/RelayTrackStage.jsx'
import ContextUsageRing from '../../ui/ContextUsageRing.jsx'
import DropdownMenu from '../../ui/DropdownMenu.jsx'
import InlineApproval from '../../ui/InlineApproval.jsx'
import './GroupPanel.css'

function isLongContent(text) {
  const s = String(text || '')
  return s.length > 220 || s.split('\n').length > 5
}

function formatBytes(n) {
  const b = Number(n) || 0
  return b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} KB`
}

export default function GroupPanel() {
  const group = useSlice('group')
  const ui = useSlice('ui')
  const runtime = useSlice('runtime')
  const settings = useSlice('settings')
  const [topic, setTopic] = useState('')
  const [activeDrawer, setActiveDrawer] = useState(null) // null | 'roster' | 'files'
  const [expandedMap, setExpandedMap] = useState({})
  const [resumeNote, setResumeNote] = useState('')
  const [newName, setNewName] = useState('')
  const [newPersona, setNewPersona] = useState('')
  const [newModel, setNewModel] = useState('')
  const [newCaps, setNewCaps] = useState(['text'])
  const [newCapsTouched, setNewCapsTouched] = useState(false)

  useEffect(() => { refreshGroupFiles(group.activeGroupId).catch(() => {}) }, [group.activeGroupId])

  useEffect(() => {
    if (!activeDrawer) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setActiveDrawer(null)
      }
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [activeDrawer])

  const pendingApproval = runtime.pendingApproval && runtime.pendingApproval.sid === 'group' ? runtime.pendingApproval : null

  const handleSend = () => {
    if (!topic.trim() || group.running) return
    const q = topic.trim()
    setTopic('')
    setActiveDrawer(null)
    runGroupRelay(q)
  }

  const toggleCap = (list, capId) => (
    list.includes(capId)
      ? (list.length > 1 ? list.filter((x) => x !== capId) : list)
      : [...list, capId]
  )

  const handleNewRoleInput = (nextName, nextPersona) => {
    setNewName(nextName)
    setNewPersona(nextPersona)
    if (!newCapsTouched) {
      setNewCaps(inferMemberCapabilities(nextName, nextPersona))
    }
  }

  const handleAddMember = () => {
    if (!newName.trim()) return
    const finalCaps = newCapsTouched ? newCaps : inferMemberCapabilities(newName, newPersona)
    addGroupMember({
      name: newName.trim(),
      persona: newPersona.trim() || '按专长完成当前接力棒次任务',
      model: newModel.trim(),
      capabilities: finalCaps,
      reasoningTier: 'auto',
      allowTools: true,
    })
    setNewName('')
    setNewPersona('')
    setNewModel('')
    setNewCaps(['text'])
    setNewCapsTouched(false)
  }

  const hasLongAssistant = group.messages.some((m) => m.role === 'assistant' && isLongContent(m.content))
  const anyCollapsed = group.messages.some((m) => m.role === 'assistant' && isLongContent(m.content) && !expandedMap[m.id])

  const groupCtxLimit = Number(settings.backendConfig.context_window) || 128000
  const groupCtxUsed = useMemo(() => {
    const hist = historyTokens(group.messages)
    const live = estTokens(group.liveContent) + Math.ceil(estTokens(group.liveReasoning) * 0.2) + estTokens(topic)
    const sysBaseline = group.messages.length > 0 ? 1100 : 0
    return hist + live + sysBaseline
  }, [group.messages, group.liveContent, group.liveReasoning, topic])

  return (
    <section className="gp-root">
      <header className="gp-head">
        <div className="gp-head-left">
          <h2 className="gp-title">{group.title || '多角色群聊'}</h2>
          <div className="gp-seg" role="group" aria-label="路由模式">
            <button type="button" className="gp-seg-btn" data-active={String(group.routingMode === 'smart')} onClick={() => setGroupRoutingMode('smart')}>
              🎙 主持人智能调度
            </button>
            <button type="button" className="gp-seg-btn" data-active={String(group.routingMode === 'all')} onClick={() => setGroupRoutingMode('all')}>
              固定名册顺序
            </button>
          </div>
        </div>

        <div className="gp-controls">
          <button
            type="button"
            className="gp-chip-btn"
            data-active={String(activeDrawer === 'roster')}
            onClick={() => setActiveDrawer((d) => (d === 'roster' ? null : 'roster'))}
          >
            ⚙ 自定义角色与模型 ({group.members.length})
          </button>
          <button
            type="button"
            className="gp-chip-btn"
            data-active={String(activeDrawer === 'files')}
            data-highlight={String(group.status === 'done' && Boolean(group.lastArchivedName) && activeDrawer !== 'files')}
            onClick={() => {
              setActiveDrawer((d) => (d === 'files' ? null : 'files'))
              refreshGroupFiles().catch(() => {})
            }}
          >
            📁 本群文件 ({(group.files || []).length})
          </button>
          <DropdownMenu
            align="right"
            direction="down"
            label="⋯ 更多"
            ariaLabel="群聊更多操作"
            triggerClassName="gp-chip-btn"
            items={[
              { section: '协作设置' },
              {
                id: 'gp-ask',
                icon: ui.askBeforeDesign ? '🎯' : '⚡',
                label: ui.askBeforeDesign ? '效果先问我（已开启）' : '自主发挥模式',
                active: ui.askBeforeDesign,
                onClick: () => setAskBeforeDesign(!ui.askBeforeDesign),
              },
              {
                id: 'gp-toggle-long',
                icon: anyCollapsed ? '▾' : '▴',
                label: anyCollapsed ? '展开全部交付' : '收起全部交付',
                hidden: !hasLongAssistant,
                onClick: () => {
                  const next = {}
                  for (const m of group.messages) if (m.role === 'assistant') next[m.id] = anyCollapsed
                  setExpandedMap(next)
                },
              },
              { divider: true },
              { section: '流转与导出' },
              {
                id: 'gp-to-dag',
                icon: '⚡',
                label: '编译为 DAG 工作流',
                onClick: () => convertGroupToWorkflow(),
              },
              {
                id: 'gp-export',
                icon: '⬇',
                label: '导出群聊纪要 (.md)',
                disabled: group.messages.length === 0,
                onClick: () => exportCurrentGroupMarkdown(),
              },
              { divider: true },
              {
                id: 'gp-demo',
                icon: '▶',
                label: '预览光梭接力动画',
                onClick: () => { setActiveDrawer(null); triggerRelayShowcase() },
              },
            ]}
          />
        </div>
      </header>

      {group.routingWarning && <div className="gp-warn">⚠ {group.routingWarning}</div>}

      <RelayTrackStage
        status={group.status}
        members={group.activeMembers && group.activeMembers.length ? group.activeMembers : group.members}
        activeIndex={group.activeIndex}
        handoffFrom={group.handoffFrom}
        handoffTo={group.handoffTo}
        liveContent={group.liveContent}
        liveReasoning={group.liveReasoning}
        liveTools={group.liveTools}
        cps={group.cps}
        intentLabel={group.lastIntent ? group.lastIntent.label : ''}
        motionTier={settings.motion}
      />

      <div className="gp-feed">
        {group.messages.length === 0 && group.status === 'idle' ? (
          <div className="gp-empty">
            <strong style={{ fontSize: 15 }}>多角色协同接力 · 共享前缀缓存 · 直接操作工作区</strong>
            <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
              下方为当前接力名册，点右上角「⚙ 自定义角色与模型」可随时换行业班底或给单角色指定独立模型。
            </div>
            <div className="gp-empty-roster">
              {group.members.map((m, idx) => (
                <span key={m.id} className="gp-stat-pill">
                  #{idx + 1} {m.name}（{(m.capabilities || []).join('/')}{m.allowTools !== false ? '·🔧' : ''}）
                </span>
              ))}
            </div>
          </div>
        ) : (
          group.messages.map((m) => {
            const long = m.role === 'assistant' && isLongContent(m.content)
            const collapsed = long && !expandedMap[m.id]
            const toolsArr = Array.isArray(m.tools) ? m.tools : []
            return (
              <article key={m.id} className="gp-msg" data-role={m.role}>
                <div className="gp-msg-head">
                  <div className="gp-author-left">
                    <span className="gp-author-name">{m.author}</span>
                    {m.model && <span className="gp-model-tag">{m.model}</span>}
                    {toolsArr.length > 0 && (
                      <span className="gp-stat-pill gp-tool-badge">
                        🔧 {toolsArr.length} 工具（{toolsArr.slice(0, 3).map((t) => t.name).join(', ')}{toolsArr.length > 3 ? '…' : ''}）
                      </span>
                    )}
                    {m.role === 'assistant' && (
                      <span className="gp-stat-pill">{String(m.content || '').length} 字</span>
                    )}
                  </div>
                  {m.role === 'assistant' && (
                    <div className="gp-author-actions">
                      {long && (
                        <button
                          type="button"
                          className="gp-chip-btn"
                          onClick={() => setExpandedMap((prev) => ({ ...prev, [m.id]: !prev[m.id] }))}
                        >
                          {collapsed ? '展开 ▾' : '收起 ▴'}
                        </button>
                      )}
                      <button type="button" className="gp-chip-btn" onClick={async () => { await copyText(m.content); pushToast('已复制该棒交付内容', 'ok') }}>
                        复制
                      </button>
                      {extractArtifactsFromMarkdown(m.content).slice(0, 1).map((art) => (
                        <button key={art.id} type="button" className="gp-chip-btn" data-active="true" onClick={() => openArtifactCanvas(art)}>
                          ✦ 实时画布
                        </button>
                      ))}
                      <button type="button" className="gp-chip-btn" onClick={() => setDockPreview(`### ${m.author}\n\n${m.content}`)}>
                        副屏 →
                      </button>
                    </div>
                  )}
                </div>

                <div className="gp-msg-content">
                  {m.reasoning && (
                    <details style={{ fontSize: 12, color: 'var(--text-3)' }}>
                      <summary style={{ cursor: 'pointer' }}>查看本棒思考过程</summary>
                      <pre style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{m.reasoning}</pre>
                    </details>
                  )}
                  <div className="gp-body-wrap" data-collapsed={String(collapsed)}>
                    <MarkdownView content={m.content} />
                  </div>
                </div>

                {collapsed && (
                  <button
                    type="button"
                    className="gp-expand-bar"
                    onClick={() => setExpandedMap((prev) => ({ ...prev, [m.id]: true }))}
                  >
                    ▾ 已收纳长交付（{String(m.content || '').length} 字）· 点击展开全文
                  </button>
                )}
              </article>
            )
          })
        )}
      </div>

      <InlineApproval request={pendingApproval} onResolve={resolvePendingApproval} />

      {group.status === 'paused' && group.checkpoint && (
        <div className="gp-pause-bar">
          <div className="gp-member-row" style={{ justifyContent: 'space-between' }}>
            <strong>接力已暂停于第 {group.checkpoint.nextIndex + 1} 棒（可调整名册或补充指导后继续）</strong>
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
          placeholder="输入议题（如：在工作区做一个简单的网页 index.html / 制作视频分镜脚本）…"
        />
        <ContextUsageRing
          usedTokens={groupCtxUsed}
          limitTokens={groupCtxLimit}
          cacheHitRate={Number((runtime.cacheTotals && runtime.cacheTotals.latestHitRate) || 0)}
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

      {/* 悬浮滑出抽屉：角色与模型配置 / 群文件库（点击空白即关，绝不撑乱主视图） */}
      {activeDrawer === 'roster' && (
        <div className="gp-drawer-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setActiveDrawer(null) }}>
          <div className="gp-roster-panel" role="dialog" aria-label="自定义角色与模型">
            <div className="gp-member-row" style={{ justifyContent: 'space-between' }}>
              <strong style={{ fontSize: 13.5 }}>⚙ 自定义角色、模型与工具权限</strong>
              <button type="button" className="gp-chip-btn" onClick={() => setActiveDrawer(null)}>完成 ×</button>
            </div>
            <div className="gp-member-row">
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>一键换班底：</span>
              {Object.values(GROUP_ROSTER_PRESETS).map((p) => (
                <button key={p.id} type="button" className="gp-chip-btn" onClick={() => applyGroupPreset(p.id)} title={p.desc}>
                  + {p.name}
                </button>
              ))}
            </div>

            {group.members.map((m, idx) => (
              <div key={m.id} className="gp-member-card">
                <div className="gp-member-row">
                  <span style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>#{idx + 1}</span>
                  <input className="gp-field-sm" style={{ width: 116 }} value={m.name} onChange={(e) => updateGroupMember(m.id, { name: e.target.value })} placeholder="角色名" />
                  <input className="gp-field-sm" style={{ flex: 1, minWidth: 140 }} value={m.persona} onChange={(e) => updateGroupMember(m.id, { persona: e.target.value })} placeholder="人设与职责描述" />
                  <input className="gp-field-sm" style={{ width: 140 }} value={m.model || ''} onChange={(e) => updateGroupMember(m.id, { model: e.target.value })} placeholder="独立模型名（留空继承）" />
                  <select className="gp-field-sm" value={m.reasoningTier || 'auto'} onChange={(e) => updateGroupMember(m.id, { reasoningTier: e.target.value })} title="独立思考档位">
                    {REASONING_TIERS.filter((t) => t.id !== 'custom').map((t) => (
                      <option key={t.id} value={t.id}>思考:{t.label}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="gp-chip-btn"
                    data-active={String(m.allowTools !== false)}
                    onClick={() => updateGroupMember(m.id, { allowTools: m.allowTools === false })}
                  >
                    {m.allowTools !== false ? '🔧 工具开' : '仅文本'}
                  </button>
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
                  <input className="gp-field-sm" style={{ flex: 1, minWidth: 130 }} value={m.baseUrl || ''} onChange={(e) => updateGroupMember(m.id, { baseUrl: e.target.value })} placeholder="可选：独立 Base URL" />
                </div>
              </div>
            ))}

            <div className="gp-member-card">
              <strong style={{ fontSize: 12 }}>+ 新增自定义角色</strong>
              <div className="gp-member-row">
                <input className="gp-field-sm" style={{ width: 126 }} value={newName} onChange={(e) => handleNewRoleInput(e.target.value, newPersona)} placeholder="新角色名（如 ui设计）" />
                <input className="gp-field-sm" style={{ flex: 1, minWidth: 150 }} value={newPersona} onChange={(e) => handleNewRoleInput(newName, e.target.value)} placeholder="职责与输出要求（自动推断能力标签）" />
                <input className="gp-field-sm" style={{ width: 140 }} value={newModel} onChange={(e) => setNewModel(e.target.value)} placeholder="指定模型名（可选）" />
                <button type="button" className="gp-chip-btn" data-active="true" onClick={handleAddMember}>添加角色</button>
              </div>
              <div className="gp-member-row">
                <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>自动推断能力：</span>
                {CAPABILITY_CATALOG.map((cap) => (
                  <button
                    key={cap.id}
                    type="button"
                    className="gp-chip-btn"
                    data-active={String(newCaps.includes(cap.id))}
                    onClick={() => { setNewCapsTouched(true); setNewCaps((c) => toggleCap(c, cap.id)) }}
                  >
                    {cap.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {activeDrawer === 'files' && (
        <div className="gp-drawer-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setActiveDrawer(null) }}>
          <div className="gp-files-panel" role="dialog" aria-label="群文件与交接文档库">
            <div className="gp-member-row" style={{ justifyContent: 'space-between' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <strong style={{ fontSize: 13.5 }}>📁 「{group.title || '当前群聊'}」专属群文件（{(group.files || []).length} 份 · 与其他群聊完全隔离）</strong>
                {group.filesDir && (
                  <div className="gp-file-sub" style={{ marginTop: 2 }}>目录：{group.filesDir}</div>
                )}
              </div>
              <div className="gp-member-row">
                <button type="button" className="gp-chip-btn" onClick={() => refreshGroupFiles()}>刷新</button>
                <button type="button" className="gp-chip-btn" data-active="true" onClick={() => openGroupFilesFolder()}>📂 打开目录</button>
                <button type="button" className="gp-chip-btn" onClick={() => setActiveDrawer(null)}>×</button>
              </div>
            </div>
            {(group.files || []).length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--text-3)', padding: '8px 0' }}>
                尚未生成群交接文档。完成一轮群聊接力后会自动归档 Markdown 交接文档至此。
              </div>
            ) : (
              (group.files || []).map((f) => (
                <div key={f.path || f.name} className="gp-file-row">
                  <div className="gp-file-meta">
                    <span className="gp-file-title">{f.title || f.name}</span>
                    <span className="gp-file-sub">{f.name} · {f.member || '主持人'} · {formatBytes(f.size)}</span>
                  </div>
                  <div className="gp-member-row" style={{ flexShrink: 0 }}>
                    <button type="button" className="gp-chip-btn" data-active="true" onClick={() => { setActiveDrawer(null); openGroupFileInDock(f) }}>副屏查看 →</button>
                    <button type="button" className="gp-chip-btn" onClick={() => deleteGroupFile(f.name)}>删除</button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </section>
  )
}
