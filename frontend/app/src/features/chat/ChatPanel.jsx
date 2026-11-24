import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  useSlice,
  setComposerDraft,
  addComposerToken,
  removeComposerToken,
  enqueueOrSendChat,
  stopSessionRun,
  cancelQueuedMessage,
  resolvePendingApproval,
  resolvePendingTakeover,
  resolveBudgetPause,
  resumePausedSession,
  dismissResumeBanner,
  compactSessionNow,
  abortAllSubagentsForSession,
  captureScreenshotToComposer,
  switchSessionBranch,
  rewindSessionAt,
  undoSessionRewind,
  toggleDock,
  setAskBeforeDesign,
  openProjectSessionModal,
  convertSessionToNormal,
  openArtifactCanvas,
  exportCurrentSessionMarkdown,
  saveAtomicMemory,
  setSessionModelOverride,
  setWebSearchMode,
  setActivePanel,
  openModal,
  toggleSearchDock,
  openSourceInForeground,
  triggerFourActShowcase,
  pushToast,
} from '../../state/store.js'
import { siblingMeta } from '../../services/dag.js'
import { shouldOfferResume } from '../../services/budgetAndResume.js'
import { extractUiSpecsFromMarkdown } from '../../services/generative.js'
import { extractArtifactsFromMarkdown } from '../../services/artifacts.js'
import { copyText, readFileAsText } from '../../platform/dom.js'
import { captureTriggerRect } from '../../platform/kinetic.js'
import { estTokens, historyTokens } from '../../services/compaction.js'
import { normalizeSessionKind, shortFolderLabel } from '../../services/sessionMode.js'
import { CURATED_INDUSTRY_PACKS } from '../../services/industryExperts.js'
import ContextUsageRing from '../../ui/ContextUsageRing.jsx'
import MarkdownView from '../../ui/MarkdownView.jsx'
import GenerativeView from '../../ui/GenerativeView.jsx'
import LivingChamber from '../../ui/LivingChamber.jsx'
import InlineApproval from '../../ui/InlineApproval.jsx'
import DropdownMenu from '../../ui/DropdownMenu.jsx'
import ComposerMenu, { buildComposerMenuItems } from './ComposerMenu.jsx'
import './ChatPanel.css'

const ChatMessageItem = memo(function ChatMessageItem({
  msg,
  idx,
  sib,
  sid,
  onFork,
  onRewind,
  onSaveMemory,
}) {
  const tokens = (msg.meta && Array.isArray(msg.meta.tokens)) ? msg.meta.tokens : []
  const parsed = useMemo(
    () => (msg.role === 'assistant' ? extractUiSpecsFromMarkdown(msg.content) : { cleanMarkdown: msg.content, specs: [] }),
    [msg.role, msg.content]
  )
  const artifacts = useMemo(
    () => (msg.role === 'assistant' ? extractArtifactsFromMarkdown(msg.content) : []),
    [msg.role, msg.content]
  )

  return (
    <div className="chat-msg" data-role={msg.role}>
      <div className="chat-bubble">
        {tokens.length > 0 && (
          <div className="chat-tokens-row" style={{ marginBottom: 8 }}>
            {tokens.map((t) => <span key={t.id} className="chat-token-chip">@{t.name}</span>)}
          </div>
        )}
        {msg.reasoning && (
          <details className="chat-think-details">
            <summary>已深度思考（点击展开完整推演过程）</summary>
            <pre className="chat-think-pre">{msg.reasoning}</pre>
          </details>
        )}
        {msg.role === 'assistant' ? (
          <>
            {parsed.cleanMarkdown && <MarkdownView content={parsed.cleanMarkdown} />}
            {parsed.specs.map((sp) => (
              <GenerativeView key={sp.specId} spec={sp} onAction={() => pushToast('已复制 UiSpec JSON', 'ok')} />
            ))}
          </>
        ) : (
          <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
        )}
      </div>

      {msg.role !== 'user' && Array.isArray(msg.webSources) && msg.webSources.length > 0 && (
        <div className="chat-sources-bar" aria-label="联网参考来源">
          <button type="button" className="chat-source-pill chat-source-head" onClick={() => toggleSearchDock(true)}>
            🌐 已联网参考 {msg.webSources.length} 个来源 ↗
          </button>
          {msg.webSources.slice(0, 4).map((src, sIdx) => (
            <button
              key={src.url || sIdx}
              type="button"
              className="chat-source-pill"
              title={`${src.title}
${src.url}
点击在前台浏览器打开查看`}
              onClick={() => openSourceInForeground(src.url)}
            >
              {src.domain || src.title}
            </button>
          ))}
        </div>
      )}

      <div className="chat-msg-bar">
        {sib && (
          <>
            <button type="button" className="chat-mini-btn" disabled={sib.index <= 1} onClick={() => switchSessionBranch(sid, msg._nodeId, -1)}>‹</button>
            <span>{sib.index} / {sib.total}</span>
            <button type="button" className="chat-mini-btn" disabled={sib.index >= sib.total} onClick={() => switchSessionBranch(sid, msg._nodeId, 1)}>›</button>
          </>
        )}
        <button type="button" className="chat-mini-btn" onClick={async () => { await copyText(msg.content); pushToast('已复制', 'ok') }}>复制</button>
        {msg.role === 'user' ? (
          <>
            <button type="button" className="chat-mini-btn" onClick={() => onFork(idx, msg.content)}>分叉编辑</button>
            <button type="button" className="chat-mini-btn" onClick={() => onRewind(idx)}>回退到此之前</button>
          </>
        ) : (
          <>
            {artifacts.map((art) => (
              <button key={art.id} type="button" className="chat-mini-btn" onClick={() => openArtifactCanvas(art)}>
                ✦ 实时画布 · {art.title}
              </button>
            ))}
            <button type="button" className="chat-mini-btn" onClick={() => onSaveMemory(msg.content)}>提炼入记忆</button>
          </>
        )}
      </div>
    </div>
  )
})

export default function ChatPanel() {
  const ui = useSlice('ui')
  const sessionsState = useSlice('sessions')
  const runtime = useSlice('runtime')
  const settings = useSlice('settings')
  const workspace = useSlice('workspace')
  const market = useSlice('market')

  const [editingIdx, setEditingIdx] = useState(null)
  const [menuIdx, setMenuIdx] = useState(0)
  const [resumeDirective, setResumeDirective] = useState('')
  const scrollRef = useRef(null)
  const fileRef = useRef(null)

  const session = sessionsState.items.find((s) => s.id === sessionsState.currentId) || sessionsState.items[0]
  const sid = session ? session.id : ''
  const run = (sid && runtime.runsBySid[sid]) || { phase: 'idle', stageLabel: '', reasoning: '', answer: '', cps: 0, elapsedMs: 0, tools: [], diffs: [], error: '' }
  const queue = (sid && runtime.queuesBySid[sid]) || []
  const subagents = (sid && runtime.subagentsBySid[sid]) || []
  const runningSubs = subagents.filter((x) => x.status === 'running')
  const isBusy = ['waiting', 'thinking', 'streaming'].includes(run.phase)

  const pendingApproval = runtime.pendingApproval && runtime.pendingApproval.sid === sid ? runtime.pendingApproval : null
  const pendingTakeover = runtime.pendingTakeover && runtime.pendingTakeover.sid === sid ? runtime.pendingTakeover : null
  const pendingBudgetPause = runtime.pendingBudgetPause && runtime.pendingBudgetPause.sid === sid ? runtime.pendingBudgetPause : null
  const showResume = !isBusy && shouldOfferResume(session)

  const mergedExpertsForAt = useMemo(() => {
    const disabled = new Set(market.disabledCurated || [])
    const curated = CURATED_INDUSTRY_PACKS.filter((p) => !disabled.has(p.id)).map((p) => ({
      id: p.id,
      kind: p.kind,
      metadata: { displayName: p.name, description: p.prompt },
    }))
    return [...curated, ...(market.experts || [])]
  }, [market.disabledCurated, market.experts])

  const menu = useMemo(
    () => buildComposerMenuItems(ui.composerDraft, { workspaceEntries: workspace.entries, experts: mergedExpertsForAt }),
    [ui.composerDraft, workspace.entries, mergedExpertsForAt]
  )
  const activeMenuIdx = Math.min(menuIdx, Math.max(0, menu.items.length - 1))

  useEffect(() => {
    const el = scrollRef.current
    if (el && isBusy) el.scrollTop = el.scrollHeight
  }, [run.answer, run.reasoning, run.phase, isBusy])

  const pickMenuItem = (item) => {
    if (!item) return
    const withoutTrigger = ui.composerDraft.slice(0, ui.composerDraft.length - menu.trigger.length)
    if (item.kind === 'expert' && item.expert) {
      const m = item.expert.metadata || item.expert
      addComposerToken({ id: item.expert.id, name: m.displayName || m.name || item.expert.id, kind: item.expert.kind || 'expert', prompt: m.description || '' })
      setComposerDraft(withoutTrigger)
    } else {
      setComposerDraft(withoutTrigger + (item.insert || ''))
    }
    setMenuIdx(0)
  }

  const handleSubmit = () => {
    const text = String(ui.composerDraft || '').trim()
    if (!text) return
    const forkIdx = editingIdx
    setEditingIdx(null)
    setComposerDraft('')
    enqueueOrSendChat(text, Number.isInteger(forkIdx) ? { sid, forkIdx } : { sid })
  }

  const handleAttachFile = async (e) => {
    const f = e.target.files && e.target.files[0]
    if (!f) return
    try {
      const content = await readFileAsText(f)
      setComposerDraft(`${ui.composerDraft ? ui.composerDraft + '\n\n' : ''}[附件 ${f.name}]\n\`\`\`\n${content.slice(0, 6000)}\n\`\`\``)
      pushToast(`已附带文件：${f.name}`, 'ok')
    } catch (err) {
      pushToast(`读取附件失败：${err.message}`, 'err')
    } finally {
      e.target.value = ''
    }
  }

  const handleForkMessage = useCallback((idx, content) => {
    setEditingIdx(idx)
    setComposerDraft(content)
  }, [])

  const handleRewindMessage = useCallback((idx) => {
    rewindSessionAt(sid, idx)
  }, [sid])

  const saveOneSentenceMemory = useCallback((rawText) => saveAtomicMemory(rawText), [])

  const messages = (session && Array.isArray(session.messages)) ? session.messages : []
  const ctxLimit = Number(settings.backendConfig.context_window) || 128000
  const estCtxUsed = useMemo(() => {
    const hist = historyTokens(messages)
    const draft = estTokens(ui.composerDraft)
    const live = isBusy ? estTokens(run.answer) + Math.ceil(estTokens(run.reasoning) * 0.2) : 0
    const sysBaseline = messages.length > 0 ? 900 : 0
    const est = hist + draft + live + sysBaseline
    const realPrompt = Number(runtime.cacheTotals && runtime.cacheTotals.latestPromptTokens) || 0
    return messages.length > 0 ? Math.max(est, realPrompt) : draft
  }, [messages, ui.composerDraft, isBusy, run.answer, run.reasoning, runtime.cacheTotals])
  const liveParsed = useMemo(() => extractUiSpecsFromMarkdown((isBusy || run.isDemo) ? run.answer : ''), [isBusy, run.isDemo, run.answer])

  return (
    <div className="chat-root">
      <div ref={scrollRef} className="chat-scroll">
        {session && session._rewind && (
          <div className="chat-rewind-bar">
            <span>已回退 {session._rewind.count} 条历史消息（跨重启保留撤销快照）</span>
            <button type="button" className="chat-mini-btn" onClick={() => undoSessionRewind(sid)}>撤销回退</button>
          </div>
        )}

        {messages.length === 0 && run.phase === 'idle' ? (
          <div className="chat-welcome">
            <h1>Harbor 智能工作台</h1>
            <p>
              当前模型：<strong>{settings.backendConfig.model || 'glm-4.5-flash'}</strong> · 输入 <code>/</code> 呼出快捷指令，输入 <code>@</code> 引用行业专家或项目文件。
            </p>
            <div className="chat-quick-grid">
              <button type="button" className="chat-quick-card" onClick={() => openProjectSessionModal('create')}>
                <strong>📁 新建项目会话</strong>
                <span>绑定本地工作文件夹，直接在项目目录内读写与验证</span>
              </button>
              <button type="button" className="chat-quick-card" onClick={() => setActivePanel('group')}>
                <strong>👥 多角色群聊协作</strong>
                <span>架构、设计、实现与审查多专家接力推进复杂任务</span>
              </button>
              <button type="button" className="chat-quick-card" onClick={() => setActivePanel('workflow')}>
                <strong>⚡ 可视化插件工作流</strong>
                <span>拖拽编排并行 DAG、AI 生图与短片导演流水线</span>
              </button>
            </div>
          </div>
        ) : (
          messages.map((m, idx) => (
            <ChatMessageItem
              key={m._nodeId || idx}
              msg={m}
              idx={idx}
              sib={m._nodeId ? siblingMeta(session, m._nodeId) : null}
              sid={sid}
              onFork={handleForkMessage}
              onRewind={handleRewindMessage}
              onSaveMemory={saveOneSentenceMemory}
            />
          ))
        )}

        {run.error && <div className="chat-error">请求/执行错误：{run.error}</div>}

        <LivingChamber
          phase={run.phase}
          stageLabel={run.stageLabel}
          reasoning={run.reasoning}
          answer={liveParsed.cleanMarkdown}
          cps={run.cps}
          elapsedMs={run.elapsedMs}
          tools={run.tools}
          motionTier={settings.motion}
          onCopy={async (txt) => { await copyText(txt); pushToast('已复制回答', 'ok') }}
          onOpenDiff={() => toggleDock('diff')}
        />

        {liveParsed.specs.length > 0 && (
          <div className="chat-msg" data-role="assistant">
            {liveParsed.specs.map((sp) => (
              <GenerativeView key={sp.specId} spec={sp} onAction={() => pushToast('已复制 UiSpec JSON', 'ok')} />
            ))}
          </div>
        )}
      </div>

      <div className="chat-composer-wrap">
        <InlineApproval request={pendingApproval} onResolve={resolvePendingApproval} />

        {pendingTakeover && (
          <div className="chat-banner" data-tone="warn" role="alert">
            <div className="chat-banner-row">
              <strong>需要人工接管浏览器验证：{pendingTakeover.message}</strong>
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" className="chat-mini-btn" onClick={() => resolvePendingTakeover('continue')}>已完成验证，继续执行</button>
                <button type="button" className="chat-mini-btn" onClick={() => resolvePendingTakeover('abort')}>取消接管</button>
              </div>
            </div>
          </div>
        )}

        {pendingBudgetPause && (
          <div className="chat-banner" data-tone="warn" role="alert">
            <strong>安全熔断暂停：{pendingBudgetPause.detail}</strong>
            <div className="chat-banner-row">
              <button type="button" className="chat-mini-btn" onClick={() => resolveBudgetPause({ action: 'continue' })}>放宽一次继续</button>
              <button type="button" className="chat-mini-btn" onClick={() => resolveBudgetPause({ action: 'readonly' })}>切换只读模式继续</button>
              <button type="button" className="chat-mini-btn" onClick={() => resolveBudgetPause({ action: 'stop' })}>终止并保留上下文</button>
            </div>
          </div>
        )}

        {showResume && (
          <div className="chat-banner" data-tone="primary">
            <div className="chat-banner-row">
              <strong>上次任务中断于半途，可顺手补充一句纠偏指令后原地续跑</strong>
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" className="chat-mini-btn" onClick={() => { const d = resumeDirective.trim(); setResumeDirective(''); resumePausedSession(sid, d) }}>▶ 继续续跑</button>
                <button type="button" className="chat-mini-btn" onClick={() => dismissResumeBanner(sid)}>放弃</button>
              </div>
            </div>
            <input className="chat-banner-input" value={resumeDirective} onChange={(e) => setResumeDirective(e.target.value)}
              placeholder="可选：给续跑补一句纠偏指令（如：跳过第 2 步，直接验证构建）…" />
          </div>
        )}

        {runningSubs.length > 0 && (
          <div className="chat-sub-bar">
            <span>◉ {runningSubs.length} 个隔离子代理正在并行探索：{runningSubs.map((s) => s.task.slice(0, 14)).join(' / ')}</span>
            <button type="button" className="chat-mini-btn" onClick={() => abortAllSubagentsForSession(sid)}>全部级联中止</button>
          </div>
        )}

        {queue.length > 0 && (
          <div className="chat-queue-bar">
            <strong>{queue.length} 条排队待发送（本会话隔离）</strong>
            {queue.map((q) => (
              <div key={q.id} className="chat-queue-row">
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.text}</span>
                <button type="button" className="chat-mini-btn" onClick={() => cancelQueuedMessage(sid, q.id)}>撤回</button>
              </div>
            ))}
          </div>
        )}

        <div className="chat-composer">
          <ComposerMenu items={menu.items} activeIndex={activeMenuIdx} onPick={pickMenuItem} />

          <div className="chat-mode-strip" data-kind={normalizeSessionKind(session)}>
            {normalizeSessionKind(session) === 'project' ? (
              <>
                <span className="chat-mode-label" title={session && session.workspaceDir}>
                  📁 项目会话 · <strong>{shortFolderLabel(session && session.workspaceDir) || '已绑定工作目录'}</strong>
                </span>
                <div className="chat-mode-actions">
                  <select
                    className="chat-mini-btn"
                    aria-label="切换本会话模型"
                    value={(session && session.modelProfileId) || ''}
                    onChange={(e) => setSessionModelOverride(sid, e.target.value)}
                    title="为当前会话单独切换已保存的模型"
                  >
                    <option value="">🧠 模型：默认 ({settings.backendConfig.provider_model || settings.backendConfig.model || 'glm-4.5-flash'})</option>
                    {(settings.savedModels || []).filter((m) => !m.kind || m.kind === 'chat').map((m) => (
                      <option key={m.id} value={m.id}>🧠 {m.label} ({m.model})</option>
                    ))}
                  </select>
                  <button type="button" className="chat-mini-btn" onClick={() => openProjectSessionModal('bind', sid)}>
                    更换目录
                  </button>
                  <button type="button" className="chat-mini-btn" onClick={() => convertSessionToNormal(sid)}>
                    转为普通会话
                  </button>
                </div>
              </>
            ) : (
              <>
                <span className="chat-mode-label">💬 普通会话 · 未绑定专属工作文件夹</span>
                <div className="chat-mode-actions">
                  <select
                    className="chat-mini-btn"
                    aria-label="切换本会话模型"
                    value={(session && session.modelProfileId) || ''}
                    onChange={(e) => setSessionModelOverride(sid, e.target.value)}
                    title="为当前会话单独切换已保存的模型"
                  >
                    <option value="">🧠 模型：默认 ({settings.backendConfig.provider_model || settings.backendConfig.model || 'glm-4.5-flash'})</option>
                    {(settings.savedModels || []).filter((m) => !m.kind || m.kind === 'chat').map((m) => (
                      <option key={m.id} value={m.id}>🧠 {m.label} ({m.model})</option>
                    ))}
                  </select>
                  <button type="button" className="chat-mini-btn" onClick={() => openProjectSessionModal('bind', sid)}>
                    📁 绑定项目文件夹
                  </button>
                </div>
              </>
            )}
          </div>

          {ui.composerTokens.length > 0 && (
            <div className="chat-tokens-row">
              {ui.composerTokens.map((tok) => (
                <span key={tok.id} className="chat-token-chip">
                  <span>✦ {tok.name}</span>
                  <button type="button" className="chat-token-x" onClick={() => removeComposerToken(tok.id)} aria-label="移除专家">×</button>
                </span>
              ))}
            </div>
          )}

          {Number.isInteger(editingIdx) && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--primary)' }}>
              <span>分叉编辑第 {editingIdx + 1} 条提问（将创建新 DAG 兄弟分支）</span>
              <button type="button" className="chat-mini-btn" onClick={() => setEditingIdx(null)}>取消分叉</button>
            </div>
          )}

          <textarea
            className="chat-textarea"
            value={ui.composerDraft}
            onChange={(e) => setComposerDraft(e.target.value)}
            onKeyDown={(e) => {
              if (menu.items.length > 0) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setMenuIdx((i) => (i + 1) % menu.items.length); return }
                if (e.key === 'ArrowUp') { e.preventDefault(); setMenuIdx((i) => (i - 1 + menu.items.length) % menu.items.length); return }
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); pickMenuItem(menu.items[activeMenuIdx]); return }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSubmit()
              }
            }}
            placeholder="输入任务（/ 呼出命令 · @ 引用专家或文件 · Enter 发送 · Ctrl+K 命令面板）…"
          />

          <div className="chat-composer-foot">
            <div className="chat-composer-tools">
              <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={handleAttachFile} />
              <button type="button" className="chat-mini-btn" onClick={() => fileRef.current && fileRef.current.click()}>+ 附件</button>
              <button type="button" className="chat-mini-btn" onClick={(e) => openModal('market', captureTriggerRect(e))}>✦ 选专家</button>
              <DropdownMenu
                align="left"
                direction="up"
                label={ui.webSearchMode === 'visible' ? '👁 前台搜' : (ui.webSearchMode === 'off' ? '⊘ 离线' : '🌐 自动联网')}
                ariaLabel="AI 自主联网模式"
                triggerClassName="chat-mini-btn"
                triggerActive={ui.webSearchMode !== 'off'}
                items={[
                  { section: 'AI 自主联网策略（模型按需调用）' },
                  {
                    id: 'ws-auto',
                    icon: '🌐',
                    label: '自动后台静默搜索（推荐）',
                    hint: '零打扰',
                    active: (ui.webSearchMode || 'auto') === 'auto',
                    onClick: () => setWebSearchMode('auto'),
                  },
                  {
                    id: 'ws-visible',
                    icon: '👁',
                    label: '前台可视浏览器搜索',
                    hint: '实时观看',
                    active: ui.webSearchMode === 'visible',
                    onClick: () => setWebSearchMode('visible'),
                  },
                  {
                    id: 'ws-off',
                    icon: '⊘',
                    label: '关闭联网（纯离线）',
                    active: ui.webSearchMode === 'off',
                    onClick: () => setWebSearchMode('off'),
                  },
                  { divider: true },
                  {
                    id: 'ws-dock',
                    icon: '📡',
                    label: '打开 Agent 联网动态与来源',
                    onClick: () => toggleSearchDock(true),
                  },
                ]}
              />
              <DropdownMenu
                align="left"
                direction="up"
                label="⋯ 更多"
                ariaLabel="对话更多工具"
                triggerClassName="chat-mini-btn"
                items={[
                  { section: '输入与协作偏好' },
                  { id: 'c-shot', icon: '📸', label: '截屏附带到对话', onClick: () => captureScreenshotToComposer() },
                  {
                    id: 'c-ask',
                    icon: ui.askBeforeDesign ? '🎯' : '⚡',
                    label: ui.askBeforeDesign ? '效果先问我（已开启）' : '自主发挥模式',
                    active: ui.askBeforeDesign,
                    onClick: () => setAskBeforeDesign(!ui.askBeforeDesign),
                  },
                  { divider: true },
                  { section: '会话整理与导出' },
                  { id: 'c-compact', icon: '🗜', label: '压缩对话历史', hint: '/compact', onClick: () => compactSessionNow(sid, true) },
                  { id: 'c-export', icon: '⬇', label: '导出 Markdown 纪要', hint: '/export', onClick: () => exportCurrentSessionMarkdown(sid) },
                  { divider: true },
                  { id: 'c-demo', icon: '▶', label: '体验交互动效演示', hint: '/demo', onClick: () => triggerFourActShowcase(sid) },
                ]}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <ContextUsageRing
                usedTokens={estCtxUsed}
                limitTokens={ctxLimit}
                cacheHitRate={Number((runtime.cacheTotals && runtime.cacheTotals.latestHitRate) || 0)}
                onClick={() => compactSessionNow(sid, true)}
              />
              {isBusy ? (
                <button type="button" className="chat-send-btn" data-stop="true" onClick={() => stopSessionRun(sid)}>■ 停止生成</button>
              ) : (
                <button type="button" className="chat-send-btn" onClick={handleSubmit}>发送 ↑</button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
