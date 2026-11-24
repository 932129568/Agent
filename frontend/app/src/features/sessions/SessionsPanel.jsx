import { useState } from 'react'
import { useSlice, createNewSession, openProjectSessionModal, selectSession, deleteSession } from '../../state/store.js'
import { normalizeSessionKind, shortFolderLabel } from '../../services/sessionMode.js'
import './Sessions.css'

export default function SessionsPanel() {
  const sessionsState = useSlice('sessions')
  const runtime = useSlice('runtime')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')

  const filtered = sessionsState.items.filter((s) => {
    const r = runtime.runsBySid[s.id]
    const running = r && ['waiting', 'thinking', 'streaming'].includes(r.phase)
    const kind = normalizeSessionKind(s)
    if (filter === 'running' && !running) return false
    if (filter === 'project' && kind !== 'project') return false
    if (filter === 'chat' && kind !== 'chat') return false
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      const hitTitle = String(s.title || '').toLowerCase().includes(q)
      const hitDir = String(s.workspaceDir || '').toLowerCase().includes(q)
      const hitMsg = (s.messages || []).some((m) => String(m.content || '').toLowerCase().includes(q))
      if (!hitTitle && !hitDir && !hitMsg) return false
    }
    return true
  })

  return (
    <section className="ss-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0 }}>会话总览</h2>
          <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-2)' }}>
            共 {sessionsState.items.length} 个会话 · 区分轻量「普通会话」与绑定工作目录的「项目会话」
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="ss-new-btn ss-new-btn-proj" style={{ width: 'auto', padding: '8px 16px' }} onClick={() => openProjectSessionModal('create')}>
            📁 + 新建项目会话
          </button>
          <button type="button" className="ss-new-btn" style={{ width: 'auto', padding: '8px 16px' }} onClick={() => createNewSession('新对话')}>
            + 新建普通会话
          </button>
        </div>
      </div>

      <div className="ss-toolbar">
        <input
          className="ss-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索会话标题、绑定文件夹或消息正文…"
        />
        <button type="button" className="ss-item" data-active={String(filter === 'all')} onClick={() => setFilter('all')}>全部</button>
        <button type="button" className="ss-item" data-active={String(filter === 'project')} onClick={() => setFilter('project')}>📁 项目会话</button>
        <button type="button" className="ss-item" data-active={String(filter === 'chat')} onClick={() => setFilter('chat')}>💬 普通会话</button>
        <button type="button" className="ss-item" data-active={String(filter === 'running')} onClick={() => setFilter('running')}>运行中</button>
      </div>

      <div className="ss-grid">
        {filtered.map((s) => {
          const isProject = normalizeSessionKind(s) === 'project'
          return (
            <div key={s.id} className="ss-card" onClick={() => selectSession(s.id)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>{isProject ? '📁 ' : '💬 '}{s.title || '未命名会话'}</strong>
                <button type="button" className="ss-del" onClick={(e) => { e.stopPropagation(); deleteSession(s.id) }}>×</button>
              </div>
              {isProject && s.workspaceDir && (
                <div style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.workspaceDir}>
                  工作目录：{shortFolderLabel(s.workspaceDir)} ({s.workspaceDir})
                </div>
              )}
              <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                {(s.messages || []).length} 条消息 · 更新于 {new Date(s.updatedAt || Date.now()).toLocaleString()}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
