import { useEffect, useState } from 'react'
import './RelayTrackStage.css'

const TOOL_LABELS = Object.freeze({
  read_file: '读取文件',
  write_file: '写入文件',
  append_file: '追加文件',
  search_replace: '局部编辑',
  list_dir: '查看目录',
  make_dir: '创建目录',
  delete_path: '删除路径',
  run_command: '运行命令',
  run_powershell: '执行脚本',
  browser_search: '联网检索',
  browser_open: '抓取网页',
  memory_search: '检索记忆',
  ask_user_options: '等待方案确认',
})

function compactDetail(raw = '') {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (/^[a-zA-Z]:[\\/]|^\//.test(s) && !s.includes(' ')) {
    const parts = s.replace(/\\/g, '/').split('/').filter(Boolean)
    return parts.slice(-2).join('/')
  }
  return s.length > 36 ? `${s.slice(0, 36)}…` : s
}

function RoleGlyph({ name = '', done = false }) {
  if (done) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    )
  }
  const s = String(name || '')
  if (/主持|统筹|总监/.test(s)) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="22" />
      </svg>
    )
  }
  if (/ui|ux|设计|视觉|美工/.test(s.toLowerCase())) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
        <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
        <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
        <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
        <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
      </svg>
    )
  }
  if (/架构|策划|分镜/.test(s)) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
      </svg>
    )
  }
  if (/审查|测试|质检|安全/.test(s)) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    )
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  )
}

export default function RelayTrackStage({
  status = 'idle',
  members = [],
  activeIndex = -1,
  handoffFrom = '',
  handoffTo = '',
  liveContent = '',
  liveTools = [],
  cps = 0,
  intentLabel = '',
  motionTier = 'dynamic',
}) {
  const [expandDone, setExpandDone] = useState(false)
  const [expandTools, setExpandTools] = useState(false)

  useEffect(() => {
    if (status === 'running' || status === 'planning') {
      setExpandDone(false)
      setExpandTools(false)
    }
  }, [status, activeIndex])

  if (status === 'idle' || !members.length) return null

  const isPlanning = status === 'planning'
  const activeMember = !isPlanning ? (members[activeIndex] || null) : null
  const isHandoff = Boolean(handoffFrom && handoffTo)
  const isCompactDone = status === 'done' && !expandDone
  const toolsList = Array.isArray(liveTools) ? liveTools : []
  const latestTool = toolsList.length ? toolsList[toolsList.length - 1] : null

  const cleanLive = String(liveContent || '').replace(/\s+/g, ' ').trim()
  const previewText = isPlanning
    ? '主持人正在拆解需求、评估是否需弹出效果确认，并规划最佳协作顺序…'
    : (cleanLive || (activeMember
      ? `正在推进「${activeMember.name}」本棒核心交付${activeMember.taskBrief ? ` · ${activeMember.taskBrief.slice(0, 44)}` : ''}…`
      : '接力推进中…'))

  const statusText = {
    planning: '主持人正在统筹调度…',
    running: isHandoff
      ? `交棒：${handoffFrom} ⟶ ${handoffTo}`
      : (activeMember ? `第 ${activeIndex + 1}/${members.length} 棒 · ${activeMember.name}` : '接力推进中'),
    paused: `已暂停于第 ${Math.min(members.length, Math.max(1, activeIndex + 1))}/${members.length} 棒`,
    done: `接力完成（${members.length} 棒）`,
  }[status] || ''

  return (
    <section className="rt-stage" data-status={status} data-compact={String(isCompactDone)} aria-live="polite">
      {(status === 'running' || isPlanning) && motionTier !== 'reduced' && <div className="rt-aurora" aria-hidden="true" />}

      <div className="rt-top">
        <div className="rt-top-left">
          <span className="rt-badge">
            <span>{status === 'done' ? '✓' : status === 'paused' ? '⏸' : isPlanning ? '🎙' : '✦'}</span>
            <span>{statusText}</span>
          </span>
          {isCompactDone && (
            <span className="rt-route-summary">
              {members.map((m) => m.name).join(' ⟶ ')}
            </span>
          )}
        </div>
        <div className="rt-top-right">
          <span className="rt-meta" title={intentLabel || ''}>
            {intentLabel || ''}
            {(status === 'running' || isPlanning) && cps > 0 ? ` · ${Math.round(cps)} 字/秒` : ''}
          </span>
          {status === 'done' && (
            <button type="button" className="rt-toggle-btn" onClick={() => setExpandDone((v) => !v)}>
              {expandDone ? '收起轨道 ▴' : '查看轨道 ▾'}
            </button>
          )}
        </div>
      </div>

      <div className="rt-track" style={isCompactDone ? { display: 'none' } : undefined}>
        {members.map((m, idx) => {
          const done = status === 'done' || (!isPlanning && idx < activeIndex)
          const active = status === 'running' && idx === activeIndex
          const paused = status === 'paused' && idx === activeIndex
          const nodeState = done ? 'done' : (active ? 'active' : (paused ? 'paused' : 'queued'))
          const batonOnThisRail = isHandoff && idx === activeIndex - 1
          const ignited = isHandoff && idx === activeIndex
          const flowing = status === 'running' && idx === activeIndex
          return (
            <div key={m.id || idx} style={{ display: 'contents' }}>
              <div className="rt-node" data-state={nodeState} data-ignited={String(ignited)}>
                <div className="rt-avatar">
                  <RoleGlyph name={m.name} done={done} />
                </div>
                <div className="rt-node-info">
                  <span className="rt-node-name">{m.name}</span>
                  <span className="rt-node-model">{m.model || '默认模型'}</span>
                </div>
              </div>
              {idx < members.length - 1 && (
                <div className="rt-rail" data-filled={String(done)} data-flowing={String(flowing && motionTier !== 'reduced')}>
                  <div className="rt-rail-fill" />
                  {batonOnThisRail && <div className="rt-baton" />}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {isHandoff && (
        <div key={`${handoffFrom}->${handoffTo}`} className="rt-handoff-banner">
          ✦ 主持人交接：{handoffFrom} 已完成交付 ⟶ {handoffTo} 接管下一棒
        </div>
      )}

      {status !== 'done' && (
        <div className="rt-telemetry">
          <div className="rt-live-row">
            <div className="rt-wave-dots" aria-hidden="true">
              {[0, 1, 2, 3].map((d) => (
                <span key={d} className="rt-wave-dot" style={{ animationDelay: `${d * 160}ms` }} />
              ))}
            </div>
            <div className="rt-stream-box">
              <div className="rt-stream-head">
                <span className="rt-stream-title">
                  {isPlanning ? '🎙 主持人 · 智能统筹调度' : (activeMember ? `${activeMember.name} · 实时进度` : '等待接力')}
                </span>
                <span className="rt-stream-tier">
                  {activeMember && activeMember.reasoningTier && activeMember.reasoningTier !== 'auto'
                    ? `思考：${activeMember.reasoningTier}`
                    : (isPlanning ? '动态选人与定序' : '思考：继承')}
                </span>
              </div>
              <div className="rt-stream-preview">{previewText.slice(-140)}</div>
            </div>
          </div>

          {latestTool && (
            <div className="rt-island-bar">
              <div className="rt-island-main">
                <span className="rt-island-dot" data-status={latestTool.status} />
                <span className="rt-island-text">
                  {latestTool.status === 'running' ? '正在执行 ' : `已完成 ${toolsList.length} 步 · 最新 `}
                  {TOOL_LABELS[latestTool.name] || latestTool.name}
                  {latestTool.detail ? `（${compactDetail(latestTool.detail)}）` : ''}
                </span>
              </div>
              {toolsList.length > 1 && (
                <button type="button" className="rt-island-toggle" onClick={() => setExpandTools((v) => !v)}>
                  {expandTools ? '收起 ▴' : `明细 (${toolsList.length}) ▾`}
                </button>
              )}
            </div>
          )}

          {expandTools && toolsList.length > 0 && (
            <div className="rt-tool-drawer">
              {toolsList.map((t) => (
                <div key={t.id} className="rt-tool-line" data-status={t.status}>
                  <span className="rt-tool-st">{t.status === 'done' ? '✓' : t.status === 'fail' ? '✗' : '◉'}</span>
                  <span className="rt-tool-name">{TOOL_LABELS[t.name] || t.name}</span>
                  <span className="rt-tool-arg">{compactDetail(t.detail) || '—'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
