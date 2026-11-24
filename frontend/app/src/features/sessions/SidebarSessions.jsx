import {
  useSlice,
  createNewSession,
  openProjectSessionModal,
  selectSession,
  deleteSession,
  stopSessionRun,
  createNewGroup,
  selectGroup,
  requestDeleteGroup,
} from '../../state/store.js'
import { normalizeSessionKind, shortFolderLabel } from '../../services/sessionMode.js'
import './Sessions.css'

/**
 * 上下文感知侧边栏：
 * - 在「角色群聊」页：自动切换为「+ 新建群聊」与独立隔离群聊列表（点击切换、点 × 弹窗删群并可选清空群文件）；
 * - 在普通对话/其他页：提供「+ 普通会话」与「📁 项目会话」双入口，列表中直观区分普通对话与绑定文件夹的项目会话。
 */
export default function SidebarSessions() {
  const ui = useSlice('ui')
  const sessionsState = useSlice('sessions')
  const group = useSlice('group')
  const runtime = useSlice('runtime')

  if (ui.activePanel === 'group') {
    const groups = Array.isArray(group.items) ? group.items : []
    return (
      <div className="ss-side" data-mode="group">
        <button type="button" className="ss-new-btn" onClick={() => createNewGroup()}>
          + 新建群聊
        </button>

        <div className="ss-list">
          {groups.map((g) => {
            const isActive = g.id === group.activeGroupId
            const isRunning = isActive && group.running
            const msgCount = Array.isArray(g.messages) ? g.messages.length : 0
            return (
              <div
                key={g.id}
                className="ss-item"
                data-active={String(isActive)}
                data-group-id={g.id}
                onClick={() => selectGroup(g.id)}
              >
                <div className="ss-item-main">
                  <span className="ss-item-label">
                    {isRunning ? '◉ ' : '👥 '}{g.title || '未命名群聊'}
                  </span>
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
        {sessionsState.items.map((s) => {
          const isProject = normalizeSessionKind(s) === 'project'
          const folder = shortFolderLabel(s.workspaceDir)
          return (
            <div
              key={s.id}
              className="ss-item"
              data-active={String(s.id === sessionsState.currentId)}
              data-kind={isProject ? 'project' : 'chat'}
              onClick={() => selectSession(s.id)}
            >
              <div className="ss-item-main">
                <span className="ss-item-label">
                  {isProject ? '📁 ' : '💬 '}{s.title || '未命名会话'}
                </span>
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
