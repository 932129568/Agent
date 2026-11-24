import { useState } from 'react'
import {
  useSlice,
  createNewSession,
  openProjectSessionModal,
  selectSession,
  deleteSession,
  renameSession,
  stopSessionRun,
  createNewGroup,
  selectGroup,
  renameGroup,
  requestDeleteGroup,
  createNewWorkflow,
  selectWorkflow,
  deleteWorkflowDef,
} from '../../state/store.js'
import { normalizeSessionKind, shortFolderLabel } from '../../services/sessionMode.js'
import './Sessions.css'

export default function SidebarSessions() {
  const ui = useSlice('ui')
  const sessionsState = useSlice('sessions')
  const group = useSlice('group')
  const pluginsState = useSlice('plugins')
  const runtime = useSlice('runtime')
  const [filterText, setFilterText] = useState('')
  const [renamingId, setRenamingId] = useState('')
  const [renameDraft, setRenameDraft] = useState('')

  const q = filterText.trim().toLowerCase()

  const startRename = (id, currentTitle) => {
    setRenamingId(id)
    setRenameDraft(String(currentTitle || ''))
  }

  const commitRename = (kind, id) => {
    const clean = renameDraft.trim()
    setRenamingId('')
    if (!clean) return
    if (kind === 'group') renameGroup(id, clean)
    else renameSession(id, clean)
  }

  if (ui.activePanel === 'workflow') {
    const wfs = (Array.isArray(pluginsState.workflows) ? pluginsState.workflows : []).filter((w) => (
      !q || String(w.name || '').toLowerCase().includes(q)
    ))
    return (
      <div className="ss-side" data-mode="workflow">
        <button type="button" className="ss-new-btn" onClick={() => createNewWorkflow()}>
          + 新建工作流
        </button>

        <input
          className="ss-filter"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder="搜索插件工作流…"
          aria-label="搜索工作流"
        />

        <div className="ss-list">
          {wfs.map((w) => {
            const isActive = w.id === pluginsState.activeWorkflowId
            return (
              <div
                key={w.id}
                className="ss-item"
                data-active={String(isActive)}
                data-workflow-id={w.id}
                onClick={() => selectWorkflow(w.id)}
              >
                <div className="ss-item-main">
                  <span className="ss-item-label">⚡ {w.name}</span>
                  <span className="ss-item-sub">{(w.nodes || []).length} 节点 · {w.builtin ? '插件内置' : '自定义'}</span>
                </div>
                {!w.builtin && (
                  <button
                    type="button"
                    className="ss-del"
                    onClick={(e) => { e.stopPropagation(); deleteWorkflowDef(w.id) }}
                    title="删除自定义工作流"
                  >
                    ×
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  if (ui.activePanel === 'group') {
    const groups = (Array.isArray(group.items) ? group.items : []).filter((g) => (
      !q || String(g.title || '').toLowerCase().includes(q)
    ))
    return (
      <div className="ss-side" data-mode="group">
        <button type="button" className="ss-new-btn" onClick={() => createNewGroup()}>
          + 新建群聊
        </button>

        <input
          className="ss-filter"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder="搜索群聊名称…"
          aria-label="搜索群聊"
        />

        <div className="ss-list">
          {groups.map((g) => {
            const isActive = g.id === group.activeGroupId
            const isRunning = isActive && group.running
            const msgCount = Array.isArray(g.messages) ? g.messages.length : 0
            const isRenaming = renamingId === g.id
            return (
              <div
                key={g.id}
                className="ss-item"
                data-active={String(isActive)}
                data-group-id={g.id}
                onClick={() => selectGroup(g.id)}
                onDoubleClick={(e) => { e.stopPropagation(); startRename(g.id, g.title) }}
                title="单击切换 · 双击重命名"
              >
                <div className="ss-item-main">
                  {isRenaming ? (
                    <input
                      autoFocus
                      className="ss-rename-input"
                      value={renameDraft}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={() => commitRename('group', g.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename('group', g.id)
                        else if (e.key === 'Escape') setRenamingId('')
                      }}
                    />
                  ) : (
                    <span className="ss-item-label">
                      {isRunning ? '◉ ' : '👥 '}{g.title || '未命名群聊'}
                    </span>
                  )}
                  <span className="ss-item-sub">
                    {isRunning ? '接力进行中…' : `${msgCount} 条记录 · 独立群文件`}
                  </span>
                </div>
                <button
                  type="button"
                  className="ss-del"
                  onClick={(e) => { e.stopPropagation(); requestDeleteGroup(g.id) }}
                  title="删除群聊（可选是否同时清空群文件）"
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  const activeRuns = sessionsState.items.filter((s) => {
    const r = runtime.runsBySid[s.id]
    return r && ['waiting', 'thinking', 'streaming'].includes(r.phase)
  })
  const visibleSessions = sessionsState.items.filter((s) => {
    if (!q) return true
    return String(s.title || '').toLowerCase().includes(q) || String(s.workspaceDir || '').toLowerCase().includes(q)
  })

  return (
    <div className="ss-side" data-mode="sessions">
      <div className="ss-new-grid">
        <button type="button" className="ss-new-btn" onClick={() => createNewSession('新对话')}>
          + 普通会话
        </button>
        <button
          type="button"
          className="ss-new-btn ss-new-btn-proj"
          title="绑定一个专属工作文件夹，创建项目会话"
          onClick={() => openProjectSessionModal('create')}
        >
          📁 项目会话
        </button>
      </div>

      <input
        className="ss-filter"
        value={filterText}
        onChange={(e) => setFilterText(e.target.value)}
        placeholder="搜索会话或项目目录…"
        aria-label="搜索会话"
      />

      {activeRuns.length > 0 && (
        <div className="ss-pinboard">
          <div className="ss-pin-title">并行运行中 ({activeRuns.length})</div>
          {activeRuns.map((s) => (
            <div key={s.id} className="ss-pin-row">
              <button type="button" className="ss-item" style={{ padding: '3px 6px' }} onClick={() => selectSession(s.id)}>
                <span className="ss-item-label">◉ {s.title}</span>
              </button>
              <button type="button" className="ss-del" onClick={() => stopSessionRun(s.id)} title="停止">■</button>
            </div>
          ))}
        </div>
      )}

      <div className="ss-list">
        {visibleSessions.map((s) => {
          const isProject = normalizeSessionKind(s) === 'project'
          const folder = shortFolderLabel(s.workspaceDir)
          const isRenaming = renamingId === s.id
          return (
            <div
              key={s.id}
              className="ss-item"
              data-active={String(s.id === sessionsState.currentId)}
              data-kind={isProject ? 'project' : 'chat'}
              onClick={() => selectSession(s.id)}
              onDoubleClick={(e) => { e.stopPropagation(); startRename(s.id, s.title) }}
              title="单击切换 · 双击重命名"
            >
              <div className="ss-item-main">
                {isRenaming ? (
                  <input
                    autoFocus
                    className="ss-rename-input"
                    value={renameDraft}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => commitRename('session', s.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename('session', s.id)
                      else if (e.key === 'Escape') setRenamingId('')
                    }}
                  />
                ) : (
                  <span className="ss-item-label">
                    {isProject ? '📁 ' : '💬 '}{s.title || '未命名会话'}
                  </span>
                )}
                {isProject && folder && (
                  <span className="ss-item-sub" title={s.workspaceDir}>{folder}</span>
                )}
              </div>
              <button
                type="button"
                className="ss-del"
                onClick={(e) => { e.stopPropagation(); deleteSession(s.id) }}
                title="删除会话"
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
