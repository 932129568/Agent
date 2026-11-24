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
  pushToast,
} from '../../state/store.js'
import { CAPABILITY_CATALOG, GROUP_ROSTER_PRESETS } from '../../services/capabilityRouter.js'
import { REASONING_TIERS } from '../../services/reasoningPresets.js'
import { copyText } from '../../platform/dom.js'
import MarkdownView from '../../ui/MarkdownView.jsx'
import RelayTrackStage from '../../ui/RelayTrackStage.jsx'
import { estTokens, historyTokens } from '../../services/compaction.js'
import ContextUsageRing from '../../ui/ContextUsageRing.jsx'
import InlineApproval from '../../ui/InlineApproval.jsx'
import './GroupPanel.css'

function isLongContent(text) {
  const s = String(text || '')
  return s.length > 220 || s.split('\n').length > 5
}

function formatBytes(n) {
  const b = Number(n) || 0
  if (b < 1024) return `${b} B`
  return `${(b / 1024).toFixed(1)} KB`
}

export default function GroupPanel() {
  const group = useSlice('group')
  const runtime = useSlice('runtime')
  const settings = useSlice('settings')
  const [topic, setTopic] = useState('')
  const [showRoster, setShowRoster] = useState(false)
  const [showFiles, setShowFiles] = useState(false)
  const [expandedMap, setExpandedMap] = useState({})
  const [resumeNote, setResumeNote] = useState('')
  const [newName, setNewName] = useState('')
  const [newPersona, setNewPersona] = useState('')
  const [newModel, setNewModel] = useState('')
  const [newCaps, setNewCaps] = useState(['text'])

  useEffect(() => { refreshGroupFiles().catch(() => {}) }, [])

  // 接力刚完成并归档新交接文档时，自动展开群文件抽屉让用户一眼看到
  useEffect(() => {
    if (group.status === 'done' && group.lastArchivedName) {
      setShowFiles(true)
    }
  }, [group.status, group.lastArchivedName])

  const pendingApproval = runtime.pendingApproval && runtime.pendingApproval.sid === 'group' ? runtime.pendingApproval : null

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
      allowTools: true,
    })
    setNewName('')
    setNewPersona('')
    setNewModel('')
    setNewCaps(['text'])
  }

  const setAllExpanded = (val) => {
    const next = {}
    for (const m of group.messages) {
      if (m.role === 'assistant') next[m.id] = val
    }
    setExpandedMap(next)
  }

  const hasLongAssistant = group.messages.some((m) => m.role === 'assistant' && isLongContent(m.content))
  const groupCtxLimit = Number(settings.backendConfig.context_window) || 128000
  const groupCtxUsed = useMemo(() => {
    const hist = historyTokens(group.messages)
    const live = estTokens(group.liveContent) + Math.ceil(estTokens(group.liveReasoning) * 0.2) + estTokens(topic)
    const sysBaseline = group.messages.length > 0 ? 1100 : 0
    return hist + live + sysBaseline
  }, [group.messages, group.liveContent, group.liveReasoning, topic])

  return (
    <section className="gp-root">
      <div className="gp-head">
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>多角色群聊接力</h2>
          <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-2)' }}>
            成员支持直接调用工作区工具写文件/执行命令、共享冻结前缀缓存；长交付自动折叠收纳，交接文档直达群文件库
          </p>
        </div>
        <div className="gp-controls">
          <button type="button" className="gp-chip-btn" data-active={String(group.routingMode === 'smart')} onClick={() => setGroupRoutingMode('smart')}>
            智能能力路由
          </button>
          <button type="button" className="gp-chip-btn" data-active={String(group.routingMode === 'all')} onClick={() => setGroupRoutingMode('all')}>
            全员按序接力
          </button>
          <button type="button" className="gp-chip-btn" data-active={String(showRoster)} onClick={() => { setShowRoster((v) => !v); setShowFiles(false) }}>
            ⚙ 自定义角色与模型 ({group.members.length})
          </button>
          <button type="button" className="gp-chip-btn" data-active={String(showFiles)} onClick={() => { setShowFiles((v) => !v); setShowRoster(false); refreshGroupFiles().catch(() => {}) }}>
            📁 群文件 ({(group.files || []).length})
          </button>
          {hasLongAssistant && (
            <button type="button" className="gp-chip-btn" onClick={() => {
              const anyCollapsed = group.messages.some((m) => m.role === 'assistant' && isLongContent(m.content) && !expandedMap[m.id])
              setAllExpanded(anyCollapsed)
            }}>
              {group.messages.some((m) => m.role === 'assistant' && isLongContent(m.content) && !expandedMap[m.id]) ? '展开全部交付' : '收起全部交付'}
            </button>
          )}
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
                <input className="gp-field-sm" style={{ width: 120 }} value={m.name} onChange={(e) => updateGroupMember(m.id, { name: e.target.value })} placeholder="角色名" />
                <input className="gp-field-sm" style={{ flex: 1, minWidth: 150 }} value={m.persona} onChange={(e) => updateGroupMember(m.id, { persona: e.target.value })} placeholder="人设与职责描述" />
                <input className="gp-field-sm" style={{ width: 145 }} value={m.model || ''} onChange={(e) => updateGroupMember(m.id, { model: e.target.value })} placeholder="独立模型名（留空继承）" />
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
                  title="允许该成员直接调用工作区工具写文件与执行命令"
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
                <input className="gp-field-sm" style={{ flex: 1, minWidth: 140 }} value={m.baseUrl || ''} onChange={(e) => updateGroupMember(m.id, { baseUrl: e.target.value })} placeholder="可选：独立 Base URL（跨供应商混跑）" />
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

      {showFiles && (
        <div className="gp-files-panel" aria-label="群文件与交接文档库">
          <div className="gp-member-row" style={{ justifyContent: 'space-between' }}>
            <div>
              <strong style={{ fontSize: 13 }}>📁 群文件与交接文档（{(group.files || []).length} 份）</strong>
              {group.filesDir && (
                <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-3)', marginTop: 2 }}>
                  目录：{group.filesDir}
                </div>
              )}
            </div>
            <div className="gp-member-row">
              <button type="button" className="gp-chip-btn" onClick={() => refreshGroupFiles()}>刷新</button>
              <button type="button" className="gp-chip-btn" data-active="true" onClick={() => openGroupFilesFolder()}>📂 打开本地文件夹</button>
            </div>
          </div>
          {(group.files || []).length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
              尚未生成群交接文档。完成一轮群聊接力后会自动归档 Markdown 交接文档到此面板。
            </div>
          ) : (
            (group.files || []).map((f) => (
              <div key={f.path || f.name} className="gp-file-row">
                <div className="gp-file-meta">
                  <span className="gp-file-title">{f.title || f.name}</span>
                  <span className="gp-file-sub">
                    {f.name} · {f.member || '主持人'} · {formatBytes(f.size)}
                  </span>
                </div>
                <div className="gp-member-row">
                  <button type="button" className="gp-chip-btn" data-active="true" onClick={() => openGroupFileInDock(f)}>副屏查看 →</button>
                  <button type="button" className="gp-chip-btn" onClick={() => deleteGroupFile(f.name)}>删除</button>
                </div>
              </div>
            ))
          )}
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
        liveTools={group.liveTools}
        cps={group.cps}
        intentLabel={group.lastIntent ? group.lastIntent.label : ''}
        motionTier={settings.motion}
      />

      <div className="gp-feed">
        {group.messages.length === 0 && group.status === 'idle' ? (
          <div style={{ color: 'var(--text-3)', fontSize: 13 }}>
            当前名册：{group.members.map((m) => `${m.name}(${(m.capabilities || []).join('/')}${m.allowTools !== false ? '·工具' : ''})`).join(' ⟶ ')}。
            输入议题发起接力（如「帮我在工作区创建一个简单的网页 index.html」），成员将直接调用工具落盘并归档至「📁 群文件」。
          </div>
        ) : (
          group.messages.map((m) => {
            const long = m.role === 'assistant' && isLongContent(m.content)
            const collapsed = long && !expandedMap[m.id]
            const toolsArr = Array.isArray(m.tools) ? m.tools : []
            return (
              <article key={m.id} className="gp-msg">
                <div className="gp-author">
                  <div className="gp-author-left">
                    <span>{m.author}</span>
                    {m.model && <span className="gp-model-tag">{m.model}</span>}
                    {toolsArr.length > 0 && (
                      <span className="gp-stat-pill gp-tool-badge">
                        🔧 调用 {toolsArr.length} 工具（{toolsArr.slice(0, 3).map((t) => t.name).join(', ')}{toolsArr.length > 3 ? '…' : ''}）
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
                          {collapsed ? '展开全文 ▾' : '收起 ▴'}
                        </button>
                      )}
                      <button type="button" className="gp-chip-btn" onClick={async () => { await copyText(m.content); pushToast('已复制该棒交付内容', 'ok') }}>
                        复制
                      </button>
                      <button type="button" className="gp-chip-btn" onClick={() => setDockPreview(`### ${m.author}\n\n${m.content}`)}>
                        副屏预览 →
                      </button>
                    </div>
                  )}
                </div>

                {m.reasoning && (
                  <details style={{ fontSize: 12, color: 'var(--text-3)' }}>
                    <summary style={{ cursor: 'pointer' }}>查看本棒思考过程</summary>
                    <pre style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{m.reasoning}</pre>
                  </details>
                )}

                <div className="gp-body-wrap" data-collapsed={String(collapsed)}>
                  <MarkdownView content={m.content} />
                  {collapsed && (
                    <div
                      className="gp-body-fade"
                      onClick={() => setExpandedMap((prev) => ({ ...prev, [m.id]: true }))}
                    >
                      <span className="gp-chip-btn">已自动收纳长交付 · 点击展开全文</span>
                    </div>
                  )}
                </div>
              </article>
            )
          })
        )}
      </div>

      <InlineApproval request={pendingApproval} onResolve={resolvePendingApproval} />

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
    </section>
  )
}
