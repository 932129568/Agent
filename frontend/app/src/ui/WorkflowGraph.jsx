import { useEffect, useRef, useState } from 'react'
import './WorkflowGraph.css'

const KIND_BADGES = Object.freeze({
  input: 'IN',
  llm: 'LLM',
  image_gen: 'IMG',
  video_gen: 'VID',
  loop: 'LOOP',
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
 * 可交互可视化 DAG 画布（R18）：
 * - 鼠标拖拽节点自由定位（60fps 跟随重绘贝塞尔连线，松手持久化坐标）；
 * - 从右侧输出端口 `●` 拖出橡皮筋光束连线至任意目标节点左侧输入口 `○` 即时建立连接；
 * - 悬浮连线中点 `×` 一键断开连线；
 * - 100% 纯展示组件（零 state/services/document.querySelector 耦合，严守 LAW-01 / LAW-07）。
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
  onMoveNode,
  onConnectNodes,
  onRemoveEdge,
}) {
  const scale = Number.isFinite(Number(zoom)) ? Math.max(0.65, Math.min(1.4, Number(zoom))) : 1
  const canvasRef = useRef(null)
  const dragRef = useRef(null)
  const connectRef = useRef(null)

  const [dragPreview, setDragPreview] = useState(null) // { nodeId, x, y }
  const [wireDraft, setWireDraft] = useState(null)     // { fromId, x1, y1, x2, y2, hoverId }

  const rawPositions = (layout && layout.positions) || {}
  const effectivePositions = dragPreview
    ? {
      ...rawPositions,
      [dragPreview.nodeId]: {
        ...(rawPositions[dragPreview.nodeId] || { width: 196, height: 82 }),
        x: dragPreview.x,
        y: dragPreview.y,
      },
    }
    : rawPositions

  const toCanvasCoords = (clientX, clientY) => {
    const rect = canvasRef.current ? canvasRef.current.getBoundingClientRect() : { left: 0, top: 0 }
    return {
      x: (clientX - rect.left) / scale,
      y: (clientY - rect.top) / scale,
    }
  }

  const findHitNodeId = (cx, cy, excludeId) => {
    for (const [nid, p] of Object.entries(effectivePositions)) {
      if (nid === excludeId || !p) continue
      if (cx >= p.x - 18 && cx <= p.x + p.width + 18 && cy >= p.y - 14 && cy <= p.y + p.height + 14) {
        return nid
      }
    }
    return ''
  }

  useEffect(() => {
    const onMove = (ev) => {
      if (dragRef.current) {
        const d = dragRef.current
        const dx = (ev.clientX - d.startClientX) / scale
        const dy = (ev.clientY - d.startClientY) / scale
        if (!d.moved && Math.hypot(dx, dy) < 4) return
        d.moved = true
        const nx = Math.max(12, Math.round(d.origX + dx))
        const ny = Math.max(12, Math.round(d.origY + dy))
        d.curX = nx
        d.curY = ny
        setDragPreview({ nodeId: d.nodeId, x: nx, y: ny })
      } else if (connectRef.current) {
        const c = connectRef.current
        const pt = toCanvasCoords(ev.clientX, ev.clientY)
        const hoverId = findHitNodeId(pt.x, pt.y, c.fromId)
        c.hoverId = hoverId
        setWireDraft({ fromId: c.fromId, x1: c.x1, y1: c.y1, x2: pt.x, y2: pt.y, hoverId })
      }
    }

    const onUp = () => {
      if (dragRef.current) {
        const d = dragRef.current
        dragRef.current = null
        setDragPreview(null)
        if (d.moved && typeof onMoveNode === 'function') {
          onMoveNode(d.nodeId, { x: d.curX, y: d.curY })
        }
      }
      if (connectRef.current) {
        const c = connectRef.current
        connectRef.current = null
        setWireDraft(null)
        if (c.hoverId && c.hoverId !== c.fromId && typeof onConnectNodes === 'function') {
          onConnectNodes(c.fromId, c.hoverId)
        }
      }
    }

    globalThis.addEventListener('pointermove', onMove)
    globalThis.addEventListener('pointerup', onUp)
    return () => {
      globalThis.removeEventListener('pointermove', onMove)
      globalThis.removeEventListener('pointerup', onUp)
    }
  }, [scale, effectivePositions, onMoveNode, onConnectNodes])

  const startNodeDrag = (ev, nodeId) => {
    if (ev.button !== 0) return
    const p = effectivePositions[nodeId]
    if (!p) return
    dragRef.current = {
      nodeId,
      startClientX: ev.clientX,
      startClientY: ev.clientY,
      origX: p.x,
      origY: p.y,
      curX: p.x,
      curY: p.y,
      moved: false,
    }
  }

  const startPortConnect = (ev, fromId) => {
    ev.stopPropagation()
    ev.preventDefault()
    const p = effectivePositions[fromId]
    if (!p) return
    const x1 = p.x + p.width
    const y1 = p.y + p.height / 2
    connectRef.current = { fromId, x1, y1, hoverId: '' }
    setWireDraft({ fromId, x1, y1, x2: x1 + 24, y2: y1, hoverId: '' })
  }

  const activeSet = new Set(Array.isArray(activeEdges) ? activeEdges : [])
  const baseW = Math.max(660, (layout && layout.width) || 660, dragPreview ? dragPreview.x + 240 : 0)
  const baseH = Math.max(270, (layout && layout.height) || 270, dragPreview ? dragPreview.y + 120 : 0)

  const edgeGeom = (Array.isArray(edges) ? edges : []).map((e) => {
    const p1 = effectivePositions[e.from]
    const p2 = effectivePositions[e.to]
    if (!p1 || !p2) return null
    const x1 = p1.x + p1.width
    const y1 = p1.y + p1.height / 2
    const x2 = p2.x
    const y2 = p2.y + p2.height / 2
    const dx = Math.max(36, Math.abs(x2 - x1) * 0.5)
    return {
      edge: e,
      pathD: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
      mx: (x1 + x2) / 2,
      my: (y1 + y2) / 2,
    }
  }).filter(Boolean)

  return (
    <div className="wg-viewport" role="region" aria-label="DAG 工作流可视化画布">
      <div className="wg-zoom-wrap" style={{ width: Math.round(baseW * scale), height: Math.round(baseH * scale) }}>
        <div
          ref={canvasRef}
          className="wg-canvas"
          style={{ width: baseW, height: baseH, transform: `scale(${scale})`, transformOrigin: 'top left' }}
        >
          <svg className="wg-svg" width={baseW} height={baseH}>
            <defs>
              <marker id="wg-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="currentColor" opacity="0.55" />
              </marker>
            </defs>
            {edgeGeom.map(({ edge: e, pathD, mx, my }) => {
              const isActive = activeSet.has(e.id)
              const isDone = nodeStates[e.from] && nodeStates[e.from].status === 'done'
                && nodeStates[e.to] && nodeStates[e.to].status === 'done'
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
                    <text className="wg-edge-label" x={mx} y={my - 10} textAnchor="middle">
                      {e.label || (e.when === 'true' ? 'TRUE' : 'FALSE')}
                    </text>
                  )}
                </g>
              )
            })}
            {wireDraft && (
              <path
                className="wg-edge-draft"
                d={`M ${wireDraft.x1} ${wireDraft.y1} C ${wireDraft.x1 + 54} ${wireDraft.y1}, ${wireDraft.x2 - 54} ${wireDraft.y2}, ${wireDraft.x2} ${wireDraft.y2}`}
              />
            )}
          </svg>

          {typeof onRemoveEdge === 'function' && edgeGeom.map(({ edge: e, mx, my }) => (
            <button
              key={`del_${e.id}`}
              type="button"
              className="wg-edge-del"
              style={{ left: mx, top: my }}
              title="点击断开此连线"
              aria-label={`断开连线 ${e.from} 到 ${e.to}`}
              onClick={(ev) => { ev.stopPropagation(); onRemoveEdge(e.id) }}
            >
              ×
            </button>
          ))}

          {(Array.isArray(nodes) ? nodes : []).map((n) => {
            const pos = effectivePositions[n.id]
            if (!pos) return null
            const st = (nodeStates && nodeStates[n.id]) || { status: 'pending', ms: 0, summary: '' }
            const sub = st.summary
              || (n.kind === 'image_gen' ? `生图 · ${(n.mediaConfig && n.mediaConfig.aspectRatio) || '1:1'} ${n.model || ''}`.trim()
                : (n.kind === 'video_gen' ? `视频 · ${(n.mediaConfig && n.mediaConfig.duration) || 5}s ${(n.mediaConfig && n.mediaConfig.aspectRatio) || '16:9'}`
                  : (n.kind === 'loop' ? `迭代 ≤${(n.loopConfig && n.loopConfig.maxIterations) || 3} 轮`
                    : (n.kind === 'tool' ? `工具：${n.toolName || '未配置'}`
                      : (n.kind === 'llm' ? (n.model || n.role || '继承默认模型')
                        : (n.kind === 'condition' ? `${(n.condition && n.condition.op) || 'always'}` : n.kind))))))
            const isDragging = Boolean(dragPreview && dragPreview.nodeId === n.id)
            const isDropTarget = Boolean(wireDraft && wireDraft.hoverId === n.id)
            return (
              <div
                key={n.id}
                role="button"
                tabIndex={0}
                className="wg-node"
                data-node-id={n.id}
                data-kind={n.kind}
                data-status={st.status || 'pending'}
                data-selected={String(selectedNodeId === n.id)}
                data-dragging={String(isDragging)}
                data-drop-target={String(isDropTarget)}
                style={{ left: pos.x, top: pos.y, width: pos.width, height: pos.height }}
                onPointerDown={(ev) => startNodeDrag(ev, n.id)}
                onClick={() => typeof onSelectNode === 'function' && onSelectNode(n.id)}
                onKeyDown={(ev) => { if (ev.key === 'Enter' && typeof onSelectNode === 'function') onSelectNode(n.id) }}
              >
                {n.kind !== 'input' && (
                  <span className="wg-port wg-port-in" data-port-in={n.id} title="输入端口（拖入连线到此）" />
                )}
                <div className="wg-node-top">
                  <span className="wg-kind-pill">{KIND_BADGES[n.kind] || n.kind}</span>
                  <span className="wg-status-dot">
                    {STATUS_TEXT[st.status || 'pending'] || st.status}
                    {st.status === 'running' && st.cps > 0 ? ` ${st.cps}字/s` : (st.ms > 0 ? ` ${st.ms}ms` : '')}
                  </span>
                </div>
                <div className="wg-node-title">{n.label}</div>
                <div className="wg-node-sub">{sub}</div>
                <button
                  type="button"
                  className="wg-port wg-port-out"
                  data-port-out={n.id}
                  title="拖拽此圆点到目标节点以建立连线"
                  aria-label={`从 ${n.label} 拖出连线`}
                  onPointerDown={(ev) => startPortConnect(ev, n.id)}
                  onClick={(ev) => ev.stopPropagation()}
                />
              </div>
            )
          })}
        </div>
      </div>
      <div className="wg-hint">拖拽卡片自由定位 · 拖右侧橙点 ● 到目标节点建立连线 · 点连线 × 断开</div>
    </div>
  )
}
