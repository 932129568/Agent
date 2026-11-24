import { useEffect, useState } from 'react'
import './RelayTrackStage.css'

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

/**
 * 群聊接力现代玻璃拟态光轨舞台：
 * - 支持「主持人统筹规划 (planning) → 动态接力执行 (running) → 完成收束 (done)」全流程可视化；
 * - 每个节点佩戴专属几何 SVG 图标与呼吸光环，连接轨带流体光流与彗星交棒脉冲；
 * - 实时输出窗过滤原始英文内部思考链，仅展示干净中文进展与工具调用胶囊。
 */
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

  useEffect(() => {
    if (status === 'running' || status === 'planning') setExpandDone(false)
  }, [status])

  if (status === 'idle' || !members.length) return null

  const isPlanning = status === 'planning'
  const activeMember = !isPlanning ? (members[activeIndex] || null) : null
  const isHandoff = Boolean(handoffFrom && handoffTo)
  const isCompactDone = status === 'done' && !expandDone

  // 绝不把原始英文思考链泄漏到实时窗：有正文显示干净正文，推演阶段显示中文状态提示
  const cleanLive = String(liveContent || '').trim()
  const previewText = isPlanning
    ? '🎙 主持人正在分析本轮任务意图、动态筛选最匹配专家并规划最优交接顺序…'
    : (cleanLive || (activeMember
      ? `💭 「${activeMember.name}」正在深度推演本棒方案${activeMember.taskBrief ? `（重点：${activeMember.taskBrief.slice(0, 48)}）` : ''}…`
      : '接力推进中…'))

  const statusText = {
    planning: '主持人正在统筹调度与规划交接顺序…',
    running: isHandoff
      ? `交棒中：${handoffFrom} ⟶ ${handoffTo}`
      : (activeMember ? `第 ${activeIndex + 1}/${members.length} 棒 · ${activeMember.name}` : '接力推进中'),
    paused: `已暂停于第 ${Math.min(members.length, Math.max(1, activeIndex + 1))}/${members.length} 棒`,
    done: `全员接力完成（${members.length} 棒）`,
  }[status] || ''

  return (
    <section className="rt-stage" data-status={status} data-compact={String(isCompactDone)} aria-live="polite">
      <div className="rt-top">
        <div className="rt-top-left">
          <span className="rt-badge">
            <span>{status === 'done' ? '✓' : status === 'paused' ? '⏸' : isPlanning ? '🎙' : '⚡'}</span>
            <span>{statusText}</span>
          </span>
          {isCompactDone && (
            <span className="rt-route-summary">
              {members.map((m) => m.name).join(' ⟶ ')}
            </span>
          )}
        </div>
        <div className="rt-top-right">
          <span className="rt-meta">
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
          ⚡ 主持人交接：{handoffFrom} 已完成交付 ⟶ {handoffTo} 接管下一棒
        </div>
      )}

      {status !== 'done' && (
        <div className="rt-telemetry">
          <div className="rt-wave-dots" aria-hidden="true">
            {[0, 1, 2, 3].map((d) => (
              <span
                key={d}
                className="rt-wave-dot"
                style={{ animationDelay: `${d * 180}ms` }}
              />
            ))}
          </div>
          <div className="rt-stream-box">
            <div className="rt-stream-head">
              <strong>
                {isPlanning ? '🎙 主持人 · 智能统筹调度' : (activeMember ? `${activeMember.name} · 实时进度` : '等待接力')}
              </strong>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>
                {activeMember && activeMember.reasoningTier && activeMember.reasoningTier !== 'auto'
                  ? `思考档：${activeMember.reasoningTier}`
                  : (isPlanning ? '动态选人与定序' : '思考档：继承')}
              </span>
            </div>
            {Array.isArray(liveTools) && liveTools.length > 0 && (
              <div className="rt-tools-row">
                {liveTools.slice(-6).map((t) => (
                  <span key={t.id} className="rt-tool-pill" data-status={t.status}>
                    {t.status === 'done' ? '✓' : t.status === 'fail' ? '✗' : '◉'} {t.name}{t.detail ? `(${t.detail})` : ''}
                  </span>
                ))}
              </div>
            )}
            <div className="rt-stream-preview">{previewText.slice(-280)}</div>
          </div>
        </div>
      )}
    </section>
  )
}
