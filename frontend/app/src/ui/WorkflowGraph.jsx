import './WorkflowGraph.css'

const KIND_BADGES = Object.freeze({
  input: 'IN',
  llm: 'LLM',
  tool: 'TOOL',
  human_gate: 'GATE',
  condition: 'IF',
  merge: 'JOIN',
  artifact: 'UI',
})

const STATUS_TEXT = Object.freeze({
  pending: '待命',
  running: '◉ 执行中',
  waiting_human: '🎯 待拍板',
  done: '✓ 完成',
  skipped: '↷ 跳过',
  error: '✗ 异常',
})

/**
 * 纯展示可视化 DAG 节点图画布（R16）：
 * - 接收上层已算好的 `layout`（坐标）与 `nodeStates` / `activeEdges`，零状态或服务层耦合；
 * - SVG 三次贝塞尔曲线 + 活跃态流光脉冲 + 可点击检视的玻璃节点卡片。
 */
export default function WorkflowGraph({
  nodes = [],
  edges = [],
  layout = { width: 720, height: 260, positions: {} },
  nodeStates = {},
  activeEdges = [],
  selectedNodeId = '',
  zoom = 1,
  onSelectNode,
}) {
  const positions = (layout && layout.positions) || {}
  const activeSet = new Set(Array.isArray(activeEdges) ? activeEdges : [])

  const scale = Number.isFinite(Number(zoom)) ? Math.max(0.65, Math.min(1.4, Number(zoom))) : 1
  const baseW = Math.max(620, layout.width || 620)
  const baseH = Math.max(250, layout.height || 250)
  return (
    <div className="wg-viewport" role="region" aria-label="DAG 工作流可视化画布">
      <div className="wg-zoom-wrap" style={{ width: Math.round(baseW * scale), height: Math.round(baseH * scale) }}>
        <div
          className="wg-canvas"
          style={{ width: baseW, height: baseH, transform: `scale(${scale})`, transformOrigin: 'top left' }}
        >
        <svg className="wg-svg" width={layout.width || 620} height={layout.height || 250}>
          <defs>
            <marker id="wg-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="currentColor" opacity="0.55" />
            </marker>
          </defs>
          {(Array.isArray(edges) ? edges : []).map((e) => {
            const p1 = positions[e.from]
            const p2 = positions[e.to]
            if (!p1 || !p2) return null
            const x1 = p1.x + p1.width
            const y1 = p1.y + p1.height / 2
            const x2 = p2.x
            const y2 = p2.y + p2.height / 2
            const dx = Math.max(36, (x2 - x1) * 0.5)
            const pathD = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
            const isActive = activeSet.has(e.id)
            const isDone = nodeStates[e.from] && nodeStates[e.from].status === 'done'
              && nodeStates[e.to] && nodeStates[e.to].status === 'done'
            const mx = (x1 + x2) / 2
            const my = (y1 + y2) / 2 - 6
            return (
              <g key={e.id}>
                <path
                  className="wg-edge-base"
                  d={pathD}
                  data-active={String(isActive)}
                  data-done={String(isDone)}
                  markerEnd="url(#wg-arrow)"
                />
                {isActive && <path className="wg-edge-pulse" d={pathD} />}
                {(e.label || e.when !== 'always') && (
                  <text className="wg-edge-label" x={mx} y={my} textAnchor="middle">
                    {e.label || (e.when === 'true' ? 'TRUE' : 'FALSE')}
                  </text>
                )}
              </g>
            )
          })}
        </svg>

        {(Array.isArray(nodes) ? nodes : []).map((n) => {
          const pos = positions[n.id]
          if (!pos) return null
          const st = (nodeStates && nodeStates[n.id]) || { status: 'pending', ms: 0, summary: '' }
          const sub = st.summary
            || (n.kind === 'tool' ? `工具：${n.toolName || '未配置'}`
              : (n.kind === 'llm' ? (n.model || n.role || '继承默认模型')
                : (n.kind === 'condition' ? `${(n.condition && n.condition.op) || 'always'}` : n.kind)))
          return (
            <button
              key={n.id}
              type="button"
              className="wg-node"
              data-node-id={n.id}
              data-kind={n.kind}
              data-status={st.status || 'pending'}
              data-selected={String(selectedNodeId === n.id)}
              style={{ left: pos.x, top: pos.y, width: pos.width, height: pos.height }}
              onClick={() => typeof onSelectNode === 'function' && onSelectNode(n.id)}
            >
              <div className="wg-node-top">
                <span className="wg-kind-pill">{KIND_BADGES[n.kind] || n.kind}</span>
                <span className="wg-status-dot">
                  {STATUS_TEXT[st.status || 'pending'] || st.status}
                  {st.status === 'running' && st.cps > 0 ? ` ${st.cps}字/s` : (st.ms > 0 ? ` ${st.ms}ms` : '')}
                </span>
              </div>
              <div className="wg-node-title">{n.label}</div>
              <div className="wg-node-sub">{sub}</div>
            </button>
          )
        })}
        </div>
      </div>
    </div>
  )
}
