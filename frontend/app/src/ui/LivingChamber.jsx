import { useEffect, useRef, useState } from 'react'
import MarkdownView from './MarkdownView.jsx'
import './LivingChamber.css'

/**
 * 四幕大尺度空间编排组件（Waiting → Thinking → Streaming → Done）：
 * - Canvas 2D 谐波流体波场，波幅与真实 cps 耦合，Done 后 560ms 指数阻尼归零并彻底停 rAF；
 * - 思考展开态由 React useState 独立托管，流式刷帧绝不重置/弹关；
 * - Done 态核心形变为完成印章 + 一次性丝绸扫光 + 海拔沉降 + 操作栏错峰入场。
 */
export default function LivingChamber({
  phase = 'idle',
  stageLabel = '',
  reasoning = '',
  answer = '',
  cps = 0,
  elapsedMs = 0,
  tools = [],
  motionTier = 'dynamic',
  onCopy,
  onOpenDiff,
}) {
  const [userExpanded, setUserExpanded] = useState(null)
  const canvasRef = useRef(null)
  const waterfallRef = useRef(null)

  // 新一轮开始时重置手工折叠覆写；但用户一旦在思考/流式期点击展开或收起，永远尊重用户选择
  useEffect(() => {
    if (phase === 'waiting') setUserExpanded(null)
  }, [phase])

  const isExpanded = userExpanded !== null ? userExpanded : phase === 'thinking'

  // 思考瀑布窗自动贴底（仅展开且流式推演中）
  useEffect(() => {
    const el = waterfallRef.current
    if (el && isExpanded && phase === 'thinking') {
      el.scrollTop = el.scrollHeight
    }
  }, [reasoning, isExpanded, phase])

  // Canvas 谐波流体场 + 完成阻尼衰减（完成后 rAF 严格归零）
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || motionTier === 'reduced' || phase === 'idle') return undefined
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined

    let raf = 0
    let stopped = false
    let t = 0
    let energy = phase === 'done' ? 0.85 : 1.0
    const intensity = motionTier === 'balanced' ? 0.55 : 1.0

    const resize = () => {
      const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
      const w = Math.max(1, canvas.clientWidth)
      const h = Math.max(1, canvas.clientHeight)
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
      return { w, h }
    }

    const draw = () => {
      if (stopped) return
      const { w, h } = resize()
      ctx.clearRect(0, 0, w, h)

      const targetEnergy = phase === 'thinking' ? 1.15 : (phase === 'waiting' ? 0.92 : (phase === 'streaming' ? 0.42 : 0))
      energy += (targetEnergy - energy) * (phase === 'done' ? 0.08 : 0.06)

      if (phase === 'done' && energy < 0.015) {
        ctx.clearRect(0, 0, w, h)
        return
      }

      const speedBoost = 1 + Math.min(2.2, (Number(cps) || 0) / 38)
      t += 0.024 * speedBoost * intensity

      const waves = [
        { amp: 18 * energy * intensity, freq: 0.0085, phaseShift: 0, color: 'rgba(224, 125, 90, 0.22)', yRatio: 0.62 },
        { amp: 13 * energy * intensity, freq: 0.0125, phaseShift: 1.9, color: 'rgba(82, 180, 245, 0.16)', yRatio: 0.50 },
        { amp: 9 * energy * intensity, freq: 0.016, phaseShift: 3.4, color: 'rgba(224, 125, 90, 0.12)', yRatio: 0.72 },
      ]

      for (const wave of waves) {
        ctx.beginPath()
        ctx.moveTo(0, h)
        for (let x = 0; x <= w; x += 12) {
          const y = h * wave.yRatio + Math.sin(x * wave.freq + t + wave.phaseShift) * wave.amp
            + Math.cos(x * wave.freq * 0.5 - t * 0.7) * (wave.amp * 0.45)
          ctx.lineTo(x, y)
        }
        ctx.lineTo(w, h)
        ctx.closePath()
        ctx.fillStyle = wave.color
        ctx.fill()
      }

      // 柔和流动光核晕
      const gx = w * (0.2 + 0.6 * (0.5 + 0.5 * Math.sin(t * 0.55)))
      const gy = h * 0.42
      const grad = ctx.createRadialGradient(gx, gy, 8, gx, gy, Math.max(140, w * 0.36))
      grad.addColorStop(0, `rgba(224, 125, 90, ${(0.18 * energy * intensity).toFixed(3)})`)
      grad.addColorStop(0.55, `rgba(82, 180, 245, ${(0.09 * energy * intensity).toFixed(3)})`)
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, w, h)

      raf = requestAnimationFrame(draw)
    }

    raf = requestAnimationFrame(draw)
    return () => {
      stopped = true
      if (raf) cancelAnimationFrame(raf)
    }
  }, [phase, cps, motionTier])

  if (phase === 'idle') return null

  const secText = (Math.max(0, elapsedMs) / 1000).toFixed(1) + 's'
  const lines = String(reasoning || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const latestThought = lines.length ? lines[lines.length - 1] : ''
  const titleByPhase = {
    waiting: stageLabel || '正在连接模型并装配上下文',
    thinking: '深度推演沉浸中',
    streaming: '推演收束 · 正文生成中',
    done: `已完成深度推演 · 用时 ${secText}`,
  }[phase] || stageLabel

  return (
    <div className="lc-wrap">
      <section className="lc-chamber" data-phase={phase} aria-live="polite">
        <canvas ref={canvasRef} className="lc-canvas" aria-hidden="true" />
        {phase === 'done' && <div className="lc-sheen" aria-hidden="true" />}

        <div className="lc-head" onClick={() => setUserExpanded((prev) => !(prev !== null ? prev : phase === 'thinking'))}>
          <div className="lc-orb-slot" aria-hidden="true">
            {phase === 'done' ? (
              <svg viewBox="0 0 24 24" className="lc-orb-svg">
                <path className="lc-seal-check" d="M5 13l4.2 4.2L19 7.5" />
              </svg>
            ) : (
              <svg viewBox="0 0 36 36" className="lc-orb-svg">
                <circle cx="18" cy="18" r="14" fill="none" stroke="var(--primary)" strokeWidth="1.6" strokeDasharray="34 22" opacity="0.85" />
                <circle cx="18" cy="18" r="8.5" fill="none" stroke="var(--primary-2)" strokeWidth="1.5" strokeDasharray="18 14" opacity="0.8" />
                <circle cx="18" cy="18" r="3.4" fill="var(--primary)" />
              </svg>
            )}
          </div>

          <div className="lc-head-meta">
            <div className="lc-title-row">
              <span key={titleByPhase} className="lc-stage-word">{titleByPhase}</span>
              <span className="lc-metrics">
                {secText}{cps > 0 && phase !== 'done' ? ` · ${Math.round(cps)} 字/秒` : ''}
                {tools.length > 0 ? ` · ${tools.length} 个工具` : ''}
              </span>
            </div>
            <div className="lc-sub">
              {phase === 'waiting'
                ? '正在通过实时流建立推演通道，思考过程到达后将自动展开舞台'
                : (latestThought || '已准备好输出结构化结论')}
            </div>
          </div>

          {(reasoning || tools.length > 0) && (
            <button type="button" className="lc-toggle-btn">
              {isExpanded ? '收起思考' : '展开推演'}
            </button>
          )}
        </div>

        <div className="lc-body-grid" data-open={String(isExpanded && (!!reasoning || tools.length > 0))}>
          <div className="lc-body-inner">
            {reasoning && (
              <div ref={waterfallRef} className="lc-waterfall">
                {reasoning}
              </div>
            )}
            {tools.length > 0 && (
              <div className="lc-tools">
                {tools.map((tool, idx) => (
                  <div
                    key={tool.id || idx}
                    className="lc-tool-pill"
                    data-status={tool.status}
                    style={{ animationDelay: `${idx * 50}ms` }}
                  >
                    <span>{tool.status === 'done' ? '✓' : '◉'}</span>
                    <span>{tool.name}</span>
                    {tool.detail && <span>· {tool.detail}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {answer && (
        <article className="lc-answer-card" data-settled={String(phase === 'done')}>
          {phase === 'done' && <div className="lc-sheen" aria-hidden="true" />}
          <MarkdownView content={answer} className="lc-answer-prose" />
          {phase === 'done' && (
            <div className="lc-actions">
              <button type="button" className="lc-act-btn" style={{ animationDelay: '35ms' }} onClick={() => onCopy && onCopy(answer)}>
                复制回答
              </button>
              <button type="button" className="lc-act-btn" style={{ animationDelay: '70ms' }} onClick={() => onOpenDiff && onOpenDiff()}>
                查看代码 Diff
              </button>
            </div>
          )}
        </article>
      )}
    </div>
  )
}
