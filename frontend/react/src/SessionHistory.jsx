/**
 * 会话历史岛（React 实现）。
 *
 * 渲染口径与 legacy 一致：无 projectId = 任务；有 projectId = 空间内会话；
 * 组可折叠；runStatus 四态状态点。
 */
import { useMemo } from 'react'
import {
  getState, subscribe, syncSessions, toggleTaskGroup, toggleProjectGroup, sortedSessions,
} from './store.js'
import { useSyncExternalStore } from 'react'

const STATUS_LABEL = {
  working: '进行中',
  completed: '已完成',
  paused: '已暂停',
  failed: '运行失败',
}

function formatTime(ts) {
  const t = Number(ts)
  if (!t) return ''
  const d = new Date(t)
  const now = new Date()
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(d, now)) {
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  }
  return (d.getMonth() + 1) + '/' + d.getDate()
}

function shortDir(workspace) {
  const path = String(workspace || '')
  if (!path) return '未绑定文件夹'
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : path
}

function Chevron({ closed }) {
  return (
    <svg className={'i-chevron' + (closed ? ' closed' : '')} width="12" height="12"
         viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" aria-hidden="true">
      <path d="m7 10 5 5 5-5" />
    </svg>
  )
}

function SessionItem({ session, active, onSelect }) {
  return (
    <div
      className={'i-session' + (active ? ' active' : '')}
      role="button"
      tabIndex={0}
      data-sid={session.id}
      onClick={() => onSelect(session.id)}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect(session.id)
        }
      }}
    >
      <div className="i-session-title">{session.title || '新对话'}</div>
      <div className="i-session-meta">
        <span>{formatTime(session.updatedAt)}</span>
        {session.runStatus && (
          <span className={'i-status ' + session.runStatus}>
            <i className="i-status-dot" aria-hidden="true" />
            {session.runStatus === 'working' && <span>{STATUS_LABEL[session.runStatus]}</span>}
          </span>
        )}
      </div>
    </div>
  )
}

export default function SessionHistory({ onSelect, onNewSessionInProject }) {
  const state = useSyncExternalStore(subscribe, getState, getState)

  const { tasks, spaces } = useMemo(() => {
    const sorted = sortedSessions(state.sessions)
    const known = new Map(state.projects.map(project => [project.id, project]))
    sorted.forEach(session => {
      if (session.projectId && !known.has(session.projectId)) {
        known.set(session.projectId, {
          id: session.projectId,
          name: session.projectName || '项目空间',
          workspace: session.projectWorkspace || '',
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        })
      }
    })
    const groups = [...known.values()]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map(project => ({ project, sessions: sorted.filter(s => s.projectId === project.id) }))
    return { tasks: sorted.filter(s => !s.projectId), spaces: groups }
  }, [state.sessions, state.projects])

  const select = id => { if (onSelect) onSelect(id) }

  return (
    <div className="i-history-list">
      <button type="button" className="i-group-head"
              aria-expanded={!state.collapsedTaskGroup} onClick={() => toggleTaskGroup()}>
        <Chevron closed={state.collapsedTaskGroup} />
        <span className="i-group-title">任务</span>
        <span className="i-group-count">{tasks.length}</span>
      </button>
      {!state.collapsedTaskGroup && (
        <div>
          {tasks.length === 0 && <div className="i-empty">暂无任务</div>}
          {tasks.map(session => (
            <SessionItem key={session.id} session={session}
                         active={session.id === state.currentSessionId} onSelect={select} />
          ))}
        </div>
      )}

      {spaces.length > 0 && (
        <div className="i-group-head" style={{ cursor: 'default' }}>
          <span className="i-group-title">空间</span>
        </div>
      )}

      {spaces.map(({ project, sessions }) => {
        const collapsed = state.collapsedProjects.includes(project.id)
        return (
          <div className="i-project" key={project.id}>
            <button type="button" className="i-group-head" aria-expanded={!collapsed}
                    onClick={() => toggleProjectGroup(project.id)}>
              <Chevron closed={collapsed} />
              <span className="i-group-title">
                {project.name}
                <span className="i-group-sub" title={project.workspace}>
                  {shortDir(project.workspace)}
                </span>
              </span>
              <span className="i-group-count">{sessions.length}</span>
            </button>
            {!collapsed && (
              <div>
                {sessions.length === 0 && <div className="i-empty">暂无对话</div>}
                {sessions.map(session => (
                  <SessionItem key={session.id} session={session}
                               active={session.id === state.currentSessionId} onSelect={select} />
                ))}
                <button type="button" className="i-new-chat"
                        style={{ margin: '4px 8px 8px', height: 30, fontSize: 12 }}
                        onClick={() => { if (onNewSessionInProject) onNewSessionInProject(project) }}>
                  ＋ 在此项目中新建对话
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export { syncSessions }
