import {
  useSlice,
  createNewSession,
  selectSession,
  deleteSession,
  stopSessionRun,
} from '../../state/store.js'
import './Sessions.css'

export default function SidebarSessions() {
  const sessionsState = useSlice('sessions')
  const runtime = useSlice('runtime')

  const activeRuns = sessionsState.items.filter((s) => {
    const r = runtime.runsBySid[s.id]
    return r && ['waiting', 'thinking', 'streaming'].includes(r.phase)
  })

  return (
    <div className="ss-side">
      <button type="button" className="ss-new-btn" onClick={() => createNewSession('新对话')}>
        + 新建对话
      </button>

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
        {sessionsState.items.map((s) => (
          <div
            key={s.id}
            className="ss-item"
            data-active={String(s.id === sessionsState.currentId)}
            onClick={() => selectSession(s.id)}
          >
            <span className="ss-item-label">{s.title || '未命名会话'}</span>
            <button
              type="button"
              className="ss-del"
              onClick={(e) => { e.stopPropagation(); deleteSession(s.id) }}
              title="删除会话"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
