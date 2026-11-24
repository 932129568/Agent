import './ContextUsageRing.css'

const RADIUS = 8
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

function formatK(tokens) {
  const n = Math.max(0, Number(tokens) || 0)
  return `${(n / 1000).toFixed(1)}K`
}

/**
 * 通用上下文使用量环形指示器（普通对话 + 群聊页面共用）：
 * - 紧凑 30px 环形表盘，不占输入栏宽度；
 * - 悬浮/聚焦平滑弹出气泡：`36.4% · 36.4K / 128.0K 上下文已使用`（超 65% 琥珀预警，超 85% 红色高亮）；
 * - 传入 onClick 时支持点击一键触发 `/compact` 压缩。
 */
export default function ContextUsageRing({
  usedTokens = 0,
  limitTokens = 128000,
  cacheHitRate = 0,
  onClick = null,
}) {
  const limit = Math.max(1000, Number(limitTokens) || 128000)
  const used = Math.max(0, Number(usedTokens) || 0)
  const pct = Math.min(100, (used / limit) * 100)
  const pctText = `${pct.toFixed(1)}%`
  const level = pct >= 85 ? 'danger' : (pct >= 65 ? 'warn' : 'normal')
  // 有使用时至少露出 3% 弧度，视觉上立即可感
  const visualRatio = used > 0 ? Math.max(0.03, Math.min(1, pct / 100)) : 0
  const dashOffset = CIRCUMFERENCE * (1 - visualRatio)
  const summaryLabel = `${pctText} · ${formatK(used)} / ${formatK(limit)} 上下文已使用`

  return (
    <div className="ctx-ring-wrap">
      <button
        type="button"
        className="ctx-ring-btn"
        data-level={level}
        aria-label={summaryLabel}
        onClick={typeof onClick === 'function' ? onClick : undefined}
      >
        <svg className="ctx-ring-svg" viewBox="0 0 20 20" aria-hidden="true">
          <circle className="ctx-ring-track" cx="10" cy="10" r={RADIUS} />
          <circle
            className="ctx-ring-arc"
            cx="10"
            cy="10"
            r={RADIUS}
            strokeDasharray={CIRCUMFERENCE.toFixed(2)}
            strokeDashoffset={dashOffset.toFixed(2)}
          />
        </svg>
      </button>
      <div className="ctx-ring-tip" role="tooltip">
        <span>{summaryLabel}</span>
        {(cacheHitRate > 0 || typeof onClick === 'function') && (
          <span className="ctx-ring-sub">
            {cacheHitRate > 0 ? `缓存命中 ${cacheHitRate}%` : ''}
            {cacheHitRate > 0 && typeof onClick === 'function' ? ' · ' : ''}
            {typeof onClick === 'function' ? '点击立即压缩 /compact' : ''}
          </span>
        )}
      </div>
    </div>
  )
}
