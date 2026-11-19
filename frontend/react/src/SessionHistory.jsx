/**
 * 会话历史岛（React 实现）。
 *
 * 渲染口径与 legacy 一致：无 projectId = 任务；有 projectId = 空间内会话；
 * 组可折叠；runStatus 四态状态点。
 *
 * R61：项目空间按样例设计重做——每个项目是独立卡片，标题单独显示
 * 项目文件夹名字（完整、中文安全、两行），整头点击收缩/展开，并用
 * 稳定色条区分不同项目。旧实现把用户手输的短名（如「1」）当标题、
 * 路径行直接渲染后端返回的 U+FFFD，导致「不好区分 + 乱码」。
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

/* ===== R61 路径显示 helper =====
 * 后端 pick_folder 曾把中文路径按 GBK→UTF-8 错解成 U+FFFD；修复后仍可能
 * 有历史残留数据。显示层必须：① 按 Unicode 字符而非字节截断；② 检测到
 * 替换符时给出可读提示，绝不把菱形问号直接铺到界面上。 */
function pathSegments(workspace) {
  return String(workspace || '').replace(/^\uFEFF/, '').split(/[\\/]+/).filter(Boolean)
}
function pathIsCorrupt(workspace) {
  return /\uFFFD/.test(String(workspace || ''))
}
function folderName(workspace) {
  const parts = pathSegments(workspace)
  return parts.length ? parts[parts.length - 1] : ''
}
function projectTitle(project) {
  if (!project) return '项目空间'
  if (pathIsCorrupt(project.workspace)) {
    return String(project.name || '').trim() || '项目空间'
  }
  return folderName(project.workspace) || String(project.name || '').trim() || '项目空间'
}
function shortDir(workspace) {
  const raw = String(workspace || '').replace(/^\uFEFF/, '')
  if (!raw) return '未绑定文件夹'
  if (pathIsCorrupt(raw)) return '路径编码异常，请重新选择文件夹'
  const parts = pathSegments(raw)
  const tail = parts.length > 2 ? parts.slice(-2).join('/') : parts.join('/')
  const label = (parts.length > 2 ? '…/' : '') + tail
  const chars = Array.from(label)
  return chars.length > 34 ? '…' + chars.slice(-33).join('') : label
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

function FolderIcon() {
  return (
    <svg className="i-folder-icon" width="16" height="16" viewBox="0 0 24 24"
         fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h7A1.5 1.5 0 0 1 19 8.5v8A1.5 1.5 0 0 1 17.5 18h-13A1.5 1.5 0 0 1 3 16.5z" />
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
        {/* R61：移除会话卡片上的「并行」按钮——当前运行控制器默认即支持
            多会话同时进行，单独再给一个「并行运行」入口是重复且误导的。
            并行任务状态仍由 ParallelRuns 面板统一展示。 */}
        {typeof window !== 'undefined' && typeof window.deleteSession === 'function' && (
          <button
            type="button"
            className="i-session-del"
            title="删除会话"
            onClick={event => {
              event.stopPropagation()
              window.deleteSession(session.id)
            }}
          >✕</button>
        )}
      </div>
    </div>
  )
}

export default function SessionHistory({ onSelect, onNewSessionInProject, onDeleteProject }) {
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
        <div className="i-group-head i-section-head">
          <span className="i-group-title">空间</span>
          <span className="i-section-count">{spaces.length}</span>
        </div>
      )}

      {spaces.map(({ project, sessions }) => {
        const collapsed = state.collapsedProjects.includes(project.id)
        return (
          <section className={'i-project' + (collapsed ? ' collapsed' : '')} key={project.id}>
            <div className="i-project-head-row">
              <button type="button" className="i-group-head i-project-head"
                      aria-expanded={!collapsed}
                      title={'点击' + (collapsed ? '展开' : '收缩') + '此项目空间'}
                      onClick={() => toggleProjectGroup(project.id)}>
                <Chevron closed={collapsed} />
                <FolderIcon />
                <span className="i-project-copy">
                  <span className="i-project-name" title={project.workspace}>
                    {projectTitle(project)}
                  </span>
                  <span className="i-group-sub" title={project.workspace}>
                    {shortDir(project.workspace)}
                  </span>
                </span>
                <span className="i-group-count">{sessions.length}</span>
              </button>
              <button type="button" className="i-project-del"
                      title="删除此项目空间（对话会保留为普通任务）"
                      aria-label="删除此项目空间"
                      onClick={() => { if (onDeleteProject) onDeleteProject(project) }}>
                ✕
              </button>
            </div>
            {!collapsed && (
              <div className="i-project-body">
                {sessions.length === 0 && <div className="i-empty">暂无对话</div>}
                {sessions.map(session => (
                  <SessionItem key={session.id} session={session}
                               active={session.id === state.currentSessionId} onSelect={select} />
                ))}
                <button type="button" className="i-new-chat inline"
                        onClick={() => { if (onNewSessionInProject) onNewSessionInProject(project) }}>
                  ＋ 在此项目中新建对话
                </button>
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

export { syncSessions }
