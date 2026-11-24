import { useEffect, useState } from 'react'
import './RelayTrackStage.css'

const BAR_COUNT = 16

/**
 * 群聊接力专属「横向轨道 + 实体光梭交棒 + 16 柱示波器」舞台：
 * - 运行/暂停期间展示完整轨道与实时流；
 * - 完成后自动收束为 40px 精致单行摘要条，把宝贵垂直空间全部让给交付消息流（点按钮可随时展开复看轨道）。
 */
export default function RelayTrackStage({
  status = 'idle',
  members = [],
  activeIndex = -1,
  handoffFrom = '',
  handoffTo = '',
  liveContent = '',
  liveReasoning = '',
  liveTools = [],
  cps = 0,
  intentLabel = '',
  motionTier = 'dynamic',
}) {
  const [bars, setBars] = useState(() => Array.from({ length: BAR_COUNT }, () => 4))
  const [expandDone, setExpandDone] = useState(false)

  useEffect(() => {
    if (status === 'running') setExpandDone(false)
  }, [status])

  useEffect(() => {
    if (status !== 'running' || motionTier === 'reduced') {
      setBars(Array.from({ length: BAR_COUNT }, () => (status === 'paused' ? 6 : 4)))
      return undefined
    }
    let phase = 0
    const ampScale = motionTier === 'balanced' ? 0.6 : 1.0
    const timer = setInterval(() => {
      phase += 0.45 + Math.min(0.8, (Number(cps) || 12) / 55)
      const next = []
      for (let i = 0; i < BAR_COUNT; i++) {
        const wave = 0.5 + 0.5 * Math.sin(phase + i * 0.55) * Math.cos(phase * 0.6 - i * 0.3)
        const boost = Math.min(1.0, 0.38 + (Number(cps) || 14) / 70)
        next.push(Math.round(4 + wave * 20 * boost * ampScale))
      }
      setBars(next)
    }, 90)
    return () => clearInterval(timer)
  }, [status, cps, motionTier])

  if (status === 'idle' || !members.length) return null

  const activeMember = members[activeIndex] || null
  const isHandoff = Boolean(handoffFrom && handoffTo)
  const isCompactDone = status === 'done' && !expandDone
  const previewText = liveContent || liveReasoning || (activeMember ? `正在唤醒「${activeMember.name}」分析前序上下文…` : '')

  const statusText = {
    running: isHandoff
      ? `光梭交棒：${handoffFrom} ⟶ ${handoffTo}`
      : (activeMember ? `第 ${activeIndex + 1}/${members.length} 棒 · ${activeMember.name}` : '接力推进中'),
    paused: `已暂停于第 ${Math.min(members.length, Math.max(1, activeIndex + 1))}/${members.length} 棒`,
    done: `全员接力完成（${members.length} 棒）`,
  }[status] || ''

  return (
    <section className="rt-stage" data-status={status} data-compact={String(isCompactDone)} aria-live="polite">
      <div className="rt-top">
        <div className="rt-top-left">
          <span className="rt-badge">
            <span>{status === 'done' ? '✓' : status === 'paused' ? '⏸' : '⚡'}</span>
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
            {status === 'running' && cps > 0 ? ` · ${Math.round(cps)} 字/秒` : ''}
          </span>
          {status === 'done' && (
            <button type="button" className="rt-toggle-btn" onClick={() => setExpandDone((v) => !v)}>
              {expandDone ? '收起轨道 ▴' : '查看轨道 ▾'}
            </button>
          )}
        </div>
      </div>

      {/* 完成收束态仍保留语义化节点供可访问性与状态核验，展开时以完整横向轨道呈现 */}
      <div className="rt-track" style={isCompactDone ? { display: 'none' } : undefined}>
        {members.map((m, idx) => {
          const done = status === 'done' || idx < activeIndex
          const active = status === 'running' && idx === activeIndex
          const paused = status === 'paused' && idx === activeIndex
          const nodeState = done ? 'done' : (active ? 'active' : (paused ? 'paused' : 'queued'))
          const batonOnThisRail = isHandoff && idx === activeIndex - 1
          const ignited = isHandoff && idx === activeIndex
          return (
            <div key={m.id || idx} style={{ display: 'contents' }}>
              <div className="rt-node" data-state={nodeState} data-ignited={String(ignited)}>
                <div className="rt-avatar">{done ? '✓' : (m.name || '?').slice(0, 1)}</div>
                <div className="rt-node-info">
                  <span className="rt-node-name">{m.name}</span>
                  <span className="rt-node-model">{m.model || '默认模型'}</span>
                </div>
              </div>
              {idx < members.length - 1 && (
                <div className="rt-rail" data-filled={String(done)}>
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
          ⚡ 接力交棒：{handoffFrom} 已交付产出 ⟶ {handoffTo} 接管下一棒
        </div>
      )}

      {status !== 'done' && (
        <div className="rt-telemetry">
          <div className="rt-eq" aria-hidden="true">
            {bars.map((h, i) => (
              <div key={i} className="rt-eq-bar" style={{ height: `${h}px` }} />
            ))}
          </div>
          <div className="rt-stream-box">
            <div className="rt-stream-head">
              <strong>{activeMember ? `${activeMember.name} · 实时输出流` : '等待接力'}</strong>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>
                {activeMember && activeMember.reasoningTier && activeMember.reasoningTier !== 'auto'
                  ? `思考档：${activeMember.reasoningTier}`
                  : '思考档：继承'}
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
            <div className="rt-stream-preview">{previewText.slice(-320)}</div>
          </div>
        </div>
      )}
    </section>
  )
}
