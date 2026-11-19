/**
 * R67 · Agent 过程面板（后台任务域）。
 *
 * 这是第一个「数据源 + 渲染」都迁进 React 的域：组件自行轮询全局
 * `getActiveRuns()`（legacy 运行时态，无新增 js_api），用 React state 渲染，
 * 不再由 legacy 的 navRenderBgTasks() 写 innerHTML / appendChild。
 *
 * 落地 architecture-r63.md 的 Agent 重设计三原则中的两条：
 *   ① 一切过程可见 —— 状态点、会话标题、耗时、当前在跑工具实时刷新（400ms）；
 *   ② 失败即接管点 —— paused / failed 的运行显示「接管」，点击切到该会话、
 *      收起通知中心并聚焦输入框，用户可直接改指令/重试，不必干等。
 *
 * 说明：此组件挂在 #bgTaskList（模板里既有容器），由 index.jsx 用独立
 * createRoot 渲染，与 App 静态树互不干扰。
 */
import { useEffect, useState } from 'react'

const STATUS = { working: '运行中', paused: '等待输入', completed: '已完成', failed: '失败' }

const STYLE = {
  empty: { fontSize: 11.5, color: 'var(--text-3)', padding: '2px 0' },
  row: {
    display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
    padding: '5px 6px', border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)', background: 'var(--surface-2)',
    cursor: 'pointer', fontSize: 12, color: 'var(--text)',
  },
  dot: { flex: '0 0 auto', width: 8, height: 8, borderRadius: '50%' },
  label: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  takeover: { flex: '0 0 auto', fontSize: 11, color: 'var(--warn)', fontWeight: 600 },
}

function snapshot() {
  try {
    if (typeof window !== 'undefined' && typeof window.getActiveRuns === 'function') {
      const list = window.getActiveRuns()
      return Array.isArray(list) ? list : []
    }
  } catch (_) { /* 运行时态尚未就绪 */ }
  return []
}

function elapsedText(startedAt, now) {
  if (!startedAt) return ''
  const seconds = Math.max(1, Math.round((now - startedAt) / 1000))
  return seconds >= 60 ? Math.floor(seconds / 60) + 'm' : seconds + 's'
}

/** 失败/挂起即接管：切会话 → 收通知 → 聚焦输入框，用户可直接改指令。 */
function takeOver(run) {
  try {
    if (typeof window !== 'undefined' && typeof window.switchSession === 'function') {
      window.switchSession(run.sessionId)
    }
  } catch (_) {}
  try {
    if (typeof window !== 'undefined' && typeof window.navHideNotify === 'function') {
      window.navHideNotify()
    }
  } catch (_) {}
  try {
    const input = typeof document !== 'undefined' ? document.getElementById('userInput') : null
    if (input && typeof input.focus === 'function') input.focus()
  } catch (_) {}
}

export default function AgentProcessPanel() {
  const [runs, setRuns] = useState(snapshot)
  const [, setClock] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => { setRuns(snapshot()); setClock(x => x + 1) }, 400)
    return () => clearInterval(timer)
  }, [])
  const now = Date.now()
  if (!runs.length) return <div style={STYLE.empty}>无在途任务。</div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {runs.map((run, index) => {
        const needsTakeover = run.status === 'failed' || run.status === 'paused'
        const elapsed = elapsedText(run.startedAt, now)
        return (
          <button key={String(run.sessionId || '') + '-' + index} type="button"
            style={STYLE.row} onClick={() => takeOver(run)}
            title={needsTakeover ? '点击接管该会话（可改指令或重试）' : '点击查看该会话'}>
            <span style={{ ...STYLE.dot,
              background: run.status === 'working' ? 'var(--ok)' : 'var(--warn)' }} />
            <span style={STYLE.label}>
              {(STATUS[run.status] || run.status) + ' · ' + (run.title || '未命名会话')}
              {elapsed ? ' · ' + elapsed : ''}
              {run.currentTool ? ' · ' + run.currentTool : ''}
            </span>
            {needsTakeover ? <span style={STYLE.takeover}>接管</span> : null}
          </button>
        )
      })}
    </div>
  )
}
