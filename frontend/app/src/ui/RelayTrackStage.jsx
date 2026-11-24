import { useEffect, useState } from 'react'
import './RelayTrackStage.css'

const BAR_COUNT = 16

/**
 * 群聊接力专属「横向轨道 + 实体光梭交棒 + 16 柱频谱示波器」动画舞台。
 * 刻意与主对话 <LivingChamber> 的暖色液态流体波区分开（冷色调多节点轨道语言），彻底消除视觉疲劳。
 */
export default function RelayTrackStage({
  status = 'idle',        // 'idle' | 'running' | 'paused' | 'done'
  members = [],
  activeIndex = -1,
  handoffFrom = '',
  handoffTo = '',
  liveContent = '',
  liveReasoning = '',
  cps = 0,
  intentLabel = '',
  motionTier = 'dynamic',
}) {
  const [bars, setBars] = useState(() => Array.from({ length: BAR_COUNT }, () => 4))

  // 实时响应 cps 出字速度的 16 柱示波器（暂停/完成后立刻停止，0% 后台空转）
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
        next.push(Math.round(4 + wave * 22 * boost * ampScale))
      }
      setBars(next)
    }, 90)
    return () => clearInterval(timer)
  }, [status, cps, motionTier])

  if (status === 'idle' || !members.length) return null

  const activeMember = members[activeIndex] || null
  const isHandoff = Boolean(handoffFrom && handoffTo)
  const previewText = liveContent || liveReasoning || (activeMember ? `正在唤醒「${activeMember.name}」分析前序上下文…` : '')

  const statusText = {
    running: isHandoff
      ? `光梭交棒中：${handoffFrom} ⟶ ${handoffTo}`
      : (activeMember ? `正在接力：${activeMember.name}（第 ${activeIndex + 1}/${members.length} 棒）` : '接力推进中'),
    paused: `接力已暂停于第 ${Math.min(members.length, Math.max(1, activeIndex + 1))}/${members.length} 棒（可随时继续）`,
    done: `全员接力完成（共 ${members.length} 棒交付完毕）`,
  }[status] || ''

  return (
    <section className="rt-stage" data-status={status} aria-live="polite">
      <div className="rt-top">
        <span className="rt-badge">
          <span>{status === 'done' ? '✓' : status === 'paused' ? '⏸' : '⚡'}</span>
          <span>{statusText}</span>
        </span>
        <span className="rt-meta">
          {intentLabel ? `能力路由：${intentLabel}` : ''}
          {status === 'running' && cps > 0 ? ` · ${Math.round(cps)} 字/秒` : ''}
        </span>
      </div>

      <div className="rt-track">
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
            <div className="rt-stream-preview">{previewText.slice(-360)}</div>
          </div>
        </div>
      )}
    </section>
  )
}
