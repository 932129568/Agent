import { useEffect, useRef, useState } from 'react'
import {
  HEAL_HOLD_MS,
  grabGlassBody,
  moveDraggedBody,
  releaseGlassBody,
  recallGlassBody,
  restoreShatteredBody,
  stepGlassSandbox,
} from '../platform/glassSandboxEngine.js'
import {
  ensureGlassElementId,
  findClosestGlassElement,
  setGlassSourceVisibility,
} from '../platform/dom.js'
import { computeViewportCoords } from '../platform/kinetic.js'
import { desktopBridge } from '../platform/libs.js'
import './GlassSandboxOverlay.css'

/**
 * R28 全元素液态玻璃物理沙盒浮层：
 * - 长按任意液态玻璃按钮/卡片 360ms 即可从原位拔起（原位彻底隐身不留残影，显现虚线凹槽）；
 * - 拖动全屏移动、停稳松手缓慢液态滑动不归位、高速甩开弹墙碰撞并裂痕碎裂；
 * - 长按原位凹槽快速吸回浮动方块，或碎裂后长按 2 秒充能液态恢复；
 * - 实时同步渲染 3D 助手啃出的玻璃缺口咬痕与联动修补过渡动画。
 */
export default function GlassSandboxOverlay({
  storeRef,
  motionTier = 'dynamic',
  onGlassImpact,
  onBlockShattered,
  onStateSync,
}) {
  const [, setTick] = useState(0)
  const [holdInfo, setHoldInfo] = useState(null) // { id, progress: 0..1, mode: 'recall' | 'heal' }
  const dragRef = useRef(null)
  const pressTimerRef = useRef(0)
  const holdTimerRef = useRef(0)
  const rafRef = useRef(0)
  const lastTRef = useRef(0)

  const syncDomVisibilities = () => {
    const store = storeRef.current
    if (!store) return
    for (const b of store.bodies.values()) {
      const shouldHideOrigin = b.status === 'dragging' || b.status === 'floating' || b.status === 'escaped' || b.status === 'recalling' || b.status === 'shattered' || (b.status === 'repairing' && b.repairMode === 'shatter')
      setGlassSourceVisibility(b.id, !shouldHideOrigin)
    }
  }

  // 全局监听长按任意液态玻璃元素（360ms 触发抓起，短按仍走原本点击完全不冲突！）
  useEffect(() => {
    if (motionTier === 'reduced') return undefined

    const cancelPendingGrab = () => {
      if (pressTimerRef.current) {
        clearTimeout(pressTimerRef.current)
        pressTimerRef.current = 0
      }
    }

    let pendingStart = null
    let pendingPointerId = -1
    let captureEl = null
    const onPointerDown = (e) => {
      if (e.button !== 0) return
      const el = findClosestGlassElement(e.target)
      if (!el) return
      const id = ensureGlassElementId(el)
      const startX = e.clientX
      const startY = e.clientY
      pendingStart = { x: startX, y: startY }
      pendingPointerId = e.pointerId
      cancelPendingGrab()

      pressTimerRef.current = setTimeout(() => {
        pendingStart = null
        pressTimerRef.current = 0
        const store = storeRef.current
        if (!store) return
        const r = el.getBoundingClientRect()
        if (!r || r.width < 12) return
        const label = (el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent || '液态玻璃').replace(/\s+/g, ' ').trim().slice(0, 24)
        const cs = getComputedStyle(el)
        const body = grabGlassBody(store, {
          id,
          label,
          x: r.left,
          y: r.top,
          w: r.width,
          h: r.height,
          radius: parseFloat(cs.borderRadius) || 14,
        })
        setGlassSourceVisibility(id, false)
        // **必须 setPointerCapture**：否则指针一出窗口，pointermove/up 就不再送达本页，
        // 拖拽冻在窗口边缘 —— 方块永远出不去（用户实测"飞不出去、卡住"）。
        // 捕获后 clientX/clientY 可以越界（负值或超过 innerWidth），逃逸判定才有机会触发。
        try {
          if (el.setPointerCapture) { el.setPointerCapture(pendingPointerId); captureEl = el }
        } catch {}
        dragRef.current = {
          id: body.id,
          offX: startX - r.left,
          offY: startY - r.top,
          samples: [{ x: startX, y: startY, t: performance.now() }],
        }
        setTick((n) => n + 1)
        if (typeof onStateSync === 'function') onStateSync()
      }, 360)
    }

    const onPointerMove = (e) => {
      if (pressTimerRef.current && pendingStart) {
        if (Math.hypot(e.clientX - pendingStart.x, e.clientY - pendingStart.y) > 8) {
          cancelPendingGrab()
          pendingStart = null
        }
        return
      }
      const d = dragRef.current
      if (!d || !storeRef.current) return
      const now = performance.now()
      d.samples.push({ x: e.clientX, y: e.clientY, t: now })
      while (d.samples.length > 6 && (now - d.samples[0].t) > 95) d.samples.shift()
      const first = d.samples[0]
      const dtS = Math.max(0.012, (now - first.t) / 1000)
      const vx = (e.clientX - first.x) / dtS
      const vy = (e.clientY - first.y) / dtS
      moveDraggedBody(storeRef.current, d.id, e.clientX - d.offX, e.clientY - d.offY, vx, vy)
      setTick((n) => n + 1)

      // **拖到窗口边缘就直接逃逸**：不再依赖 pointerup（指针出窗后事件收不到，
      // setPointerCapture 在源元素被隐藏时也会失效 —— 用户实测两次都卡在边缘）。
      // 这里在指针抵达边缘 2px 内时，把方块推到窗外并给足速度，复用引擎 escape。
      const vw = window.innerWidth, vh = window.innerHeight
      const EDGE = 2
      let side = null
      if (e.clientX <= EDGE) side = 'left'
      else if (e.clientX >= vw - EDGE) side = 'right'
      else if (e.clientY <= EDGE) side = 'top'
      else if (e.clientY >= vh - EDGE) side = 'bottom'
      if (side) {
        const b = storeRef.current.bodies.get(d.id)
        if (b) {
          const push = 900
          if (side === 'left') { b.x = -b.w - 4; b.vx = -push }
          else if (side === 'right') { b.x = vw + 4; b.vx = push }
          else if (side === 'top') { b.y = -b.h - 4; b.vy = -push }
          else { b.y = vh + 4; b.vy = push }
          b.status = 'floating'
          dragRef.current = null
        }
      }
    }

    const onPointerUp = (upEvent) => {
      cancelPendingGrab()
      const d = dragRef.current
      if (!d || !storeRef.current) return
      try {
        if (captureEl && pendingPointerId >= 0) captureEl.releasePointerCapture(pendingPointerId)
      } catch {}
      captureEl = null
      pendingPointerId = -1
      dragRef.current = null
      const now = performance.now()
      const recent = d.samples.filter((s) => (now - s.t) <= 110)
      const a = recent[0] || d.samples[0]
      const b = recent[recent.length - 1] || d.samples[d.samples.length - 1]
      const dtS = Math.max(0.016, (b.t - a.t) / 1000)
      const vx = recent.length >= 2 ? (b.x - a.x) / dtS : 0
      const vy = recent.length >= 2 ? (b.y - a.y) / dtS : 0
      const res = releaseGlassBody(storeRef.current, d.id, vx, vy)
      if (res.snapped) setGlassSourceVisibility(d.id, true)
      // R30 的逃逸判定要求 |v| ≥ 680（高速甩），**慢慢拖到边缘松手永远飞不出去**（用户实测"飞不出去、卡住"）。
      // 这里补一条等价语义：松手点已经落在窗口边缘/之外 ⇒ 视为"往外扔"，直接给一个朝外的速度，
      // 复用引擎既有 escape 逻辑（不改物理参数，避免影响正常甩动）。
      if (!res.snapped && upEvent && typeof upEvent.clientX === 'number') {
        const cx = upEvent.clientX; const cy = upEvent.clientY
        const vw = window.innerWidth; const vh = window.innerHeight
        const body = storeRef.current.bodies.get(d.id)
        if (body) {
          const EDGE = 3
          if (cx <= EDGE) body.vx = -760
          else if (cx >= vw - EDGE) body.vx = 760
          else if (cy <= EDGE) body.vy = -760
          else if (cy >= vh - EDGE) body.vy = 760
        }
      }
      setTick((n) => n + 1)
      if (typeof onStateSync === 'function') onStateSync()
    }

    globalThis.addEventListener('pointerdown', onPointerDown, true)
    globalThis.addEventListener('pointermove', onPointerMove, true)
    globalThis.addEventListener('pointerup', onPointerUp, true)
    globalThis.addEventListener('pointercancel', onPointerUp, true)
    return () => {
      cancelPendingGrab()
      globalThis.removeEventListener('pointerdown', onPointerDown, true)
      globalThis.removeEventListener('pointermove', onPointerMove, true)
      globalThis.removeEventListener('pointerup', onPointerUp, true)
      globalThis.removeEventListener('pointercancel', onPointerUp, true)
    }
  }, [motionTier])

  // 物理主循环（仅在存在活动玻璃实体时以 60fps 运行，空沙盒 0% CPU！）
  useEffect(() => {
    const loop = (now) => {
      rafRef.current = 0
      const store = storeRef.current
      if (!store || store.bodies.size === 0) return
      const dt = lastTRef.current ? Math.min(0.035, (now - lastTRef.current) / 1000) : 0.016
      lastTRef.current = now
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
      const prevIds = new Set(store.bodies.keys())
      const events = stepGlassSandbox(store, dt, vw, vh, { allowEscape: true })
      for (const oldId of prevIds) {
        if (!store.bodies.has(oldId)) setGlassSourceVisibility(oldId, true)
      }
      syncDomVisibilities()
      for (const ev of events) {
        const vp = computeViewportCoords(ev.x, ev.y, vw, vh)
        if (typeof onGlassImpact === 'function') {
          onGlassImpact({
            nx: vp.nx,
            ny: vp.ny,
            strength: ev.type === 'shatter' || ev.type === 'crack' ? 'strong' : 'medium',
            edge: ev.side || 'pointer',
          })
        }
        if (ev.type === 'escape' && ev.body) {
          const desk = desktopBridge()
          if (desk && typeof desk.getDesktopMetrics === 'function' && typeof desk.syncDesktopStage === 'function') {
            desk.getDesktopMetrics().then((m) => {
              const wb = (m && m.winBounds) || { x: 100, y: 100 }
              desk.syncDesktopStage({
                addBlock: {
                  id: ev.body.id,
                  label: ev.body.label,
                  x: wb.x + ev.body.x,
                  y: wb.y + ev.body.y,
                  w: ev.body.w,
                  h: ev.body.h,
                  radius: ev.body.radius,
                  vx: ev.vx,
                  vy: ev.vy,
                  hp: ev.body.hp,
                },
              })
            }).catch(() => {})
          }
        }
        if (ev.type === 'shatter' && typeof onBlockShattered === 'function') {
          onBlockShattered(ev.id)
        }
      }
      setTick((n) => n + 1)
      if (store.bodies.size > 0) rafRef.current = requestAnimationFrame(loop)
    }

    const store = storeRef.current
    if (store && store.bodies.size > 0 && !rafRef.current) {
      lastTRef.current = performance.now()
      rafRef.current = requestAnimationFrame(loop)
    }
    const desk = desktopBridge()
    const unsubDesk = desk && typeof desk.onDesktopStageEvent === 'function'
      ? desk.onDesktopStageEvent((ev) => {
        const st = storeRef.current
        if (!ev || !st) return
        if (ev.type === 'block_return' && ev.id) {
          const b = st.bodies.get(ev.id)
          if (b) {
            b.status = 'floating'
            b.x = ev.relX
            b.y = ev.relY
            b.vx = ev.vx || 0
            b.vy = ev.vy || 0
            setTick((n) => n + 1)
          }
        } else if (ev.type === 'block_shattered_desktop' && ev.id) {
          const b = st.bodies.get(ev.id)
          if (b) {
            b.status = 'shattered'
            setTick((n) => n + 1)
            if (typeof onBlockShattered === 'function') onBlockShattered(ev.id)
          }
        }
      })
      : null
    return () => {
      if (typeof unsubDesk === 'function') unsubDesk()
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
    }
  })

  const startFloatingDrag = (e, body) => {
    e.stopPropagation()
    const store = storeRef.current
    if (!store || body.status === 'shattered' || body.status === 'repairing') return
    grabGlassBody(store, { id: body.id, label: body.label, x: body.x, y: body.y, w: body.w, h: body.h, radius: body.radius })
    dragRef.current = {
      id: body.id,
      offX: e.clientX - body.x,
      offY: e.clientY - body.y,
      samples: [{ x: e.clientX, y: e.clientY, t: performance.now() }],
    }
    setTick((n) => n + 1)
  }

  // 长按原位空槽：若方块漂在别处 -> 0.35s 快速磁力吸回；若方块已碎裂消失 -> 长按 2.0s 充能液态凝聚恢复！
  const startSocketHold = (e, body) => {
    e.stopPropagation()
    const isShattered = body.status === 'shattered'
    const targetMs = isShattered ? HEAL_HOLD_MS : 320
    const t0 = performance.now()
    if (holdTimerRef.current) clearInterval(holdTimerRef.current)
    setHoldInfo({ id: body.id, progress: 0.04, mode: isShattered ? 'heal' : 'recall' })
    holdTimerRef.current = setInterval(() => {
      const p = Math.min(1, (performance.now() - t0) / targetMs)
      setHoldInfo({ id: body.id, progress: p, mode: isShattered ? 'heal' : 'recall' })
      if (p >= 1) {
        clearInterval(holdTimerRef.current)
        holdTimerRef.current = 0
        setHoldInfo(null)
        const store = storeRef.current
        if (!store) return
        if (isShattered) {
          restoreShatteredBody(store, body.id)
          setGlassSourceVisibility(body.id, true)
        } else {
          const desk = desktopBridge()
          if (desk && typeof desk.syncDesktopStage === 'function') desk.syncDesktopStage({ removeBlockId: body.id })
          recallGlassBody(store, body.id)
        }
        setTick((n) => n + 1)
        if (typeof onStateSync === 'function') onStateSync()
      }
    }, 32)
  }

  const endSocketHold = () => {
    if (holdTimerRef.current) {
      clearInterval(holdTimerRef.current)
      holdTimerRef.current = 0
    }
    setHoldInfo(null)
  }

  const store = storeRef.current
  const bodies = store ? Array.from(store.bodies.values()) : []
  if (bodies.length === 0) return null

  return (
    <div className="gsb-layer" data-glass-sandbox="true" aria-label="液态玻璃物理沙盒层">
      {/* 1. 原位空槽（仅抓起/漂浮/碎裂/修补碎裂时显示，长按召回或长按 2 秒恢复） */}
      {bodies.filter((b) => b.status !== 'bitten_in_place').map((b) => {
        const holding = holdInfo && holdInfo.id === b.id ? holdInfo : null
        const isShattered = b.status === 'shattered'
        const isRepairing = b.status === 'repairing'
        return (
          <div
            key={`sock_${b.id}`}
            className="gsb-socket"
            data-shattered={String(isShattered)}
            data-repairing={String(isRepairing)}
            style={{
              left: `${b.origin.x}px`,
              top: `${b.origin.y}px`,
              width: `${b.origin.w}px`,
              height: `${b.origin.h}px`,
              borderRadius: `${b.origin.radius}px`,
            }}
            title={isShattered ? '方块已碎裂，长按 2 秒恢复（或等 3D 助手收拾碎片来修补）' : '长按此处将方块磁力吸回原位'}
            onPointerDown={(e) => startSocketHold(e, b)}
            onPointerUp={endSocketHold}
            onPointerLeave={endSocketHold}
            onPointerCancel={endSocketHold}
          >
            {isRepairing
              ? `修补中 ${Math.round(b.repairProgress * 100)}%`
              : (isShattered
                ? (holding ? `恢复 ${Math.round(holding.progress * 100)}%` : '碎裂·长按2s恢复')
                : (b.status === 'escaped'
                  ? (holding ? '召回中…' : '🌌 飞出窗外·长按召回')
                  : (holding ? '磁力吸回…' : '空槽·长按召回')))}
            {(holding || isRepairing) && (
              <svg className="gsb-hold-ring" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
                <rect
                  x="2" y="2" width="96" height="36" rx="12" fill="none"
                  stroke={isRepairing ? '#68D396' : '#D4653E'} strokeWidth="3"
                  strokeDasharray="264"
                  strokeDashoffset={String(Math.round(264 * (1 - (isRepairing ? b.repairProgress : holding.progress))))}
                />
              </svg>
            )}
          </div>
        )
      })}

      {/* 2. 散落在地的碎裂玻璃碎片 */}
      {bodies.filter((b) => b.status === 'shattered').map((b) => (
        b.shards.filter((sh) => !sh.collected).map((sh) => (
          <span
            key={sh.id}
            className="gsb-shard"
            style={{
              width: `${sh.size}px`,
              height: `${sh.size}px`,
              transform: `translate3d(${sh.x.toFixed(1)}px, ${sh.y.toFixed(1)}px, 0) rotate(${sh.rot.toFixed(1)}deg)`,
            }}
          />
        ))
      ))}

      {/* 3. 浮动中的液态玻璃主体 & 原位被助手啃咬的咬痕同步层 */}
      {bodies.filter((b) => b.status !== 'shattered' && b.status !== 'escaped').map((b) => {
        const isInPlaceBite = b.status === 'bitten_in_place' || (b.status === 'repairing' && b.repairMode === 'bite')
        const dentScaleX = 1 - Math.abs(b.dentX) * b.dentAmt * 0.14 + Math.abs(b.dentY) * b.dentAmt * 0.07
        const dentScaleY = 1 - Math.abs(b.dentY) * b.dentAmt * 0.14 + Math.abs(b.dentX) * b.dentAmt * 0.07
        const healShrink = b.status === 'repairing' ? (1 - b.repairProgress) : 1
        return (
          <div
            key={`body_${b.id}`}
            className="gsb-body"
            data-glass-body={b.id}
            data-dragging={String(b.status === 'dragging')}
            data-bitten-in-place={String(isInPlaceBite)}
            style={{
              width: `${b.w}px`,
              height: `${b.h}px`,
              borderRadius: `${b.radius}px`,
              transform: `translate3d(${b.x.toFixed(1)}px, ${b.y.toFixed(1)}px, 0) rotate(${b.rot.toFixed(2)}deg) scale(${dentScaleX.toFixed(3)}, ${dentScaleY.toFixed(3)})`,
            }}
            onPointerDown={(e) => startFloatingDrag(e, b)}
          >
            {!isInPlaceBite && <span className="gsb-body-label">{b.label}</span>}

            {/* 裂痕 SVG + 真实半圆形咬痕缺口（修补时随 repairProgress 实时缩小愈合！） */}
            {(b.cracks.length > 0 || b.biteNotches.length > 0) && (
              <svg className="gsb-svg-fx" viewBox={`0 0 ${b.w} ${b.h}`} aria-hidden="true">
                {b.cracks.map((d, idx) => (
                  <path key={`ck_${idx}`} d={d} fill="none" stroke="rgba(255,255,255,0.92)" strokeWidth="1.5" strokeLinecap="round" opacity={healShrink} />
                ))}
                {b.biteNotches.map((bt, idx) => {
                  const r = bt.size * healShrink
                  if (r < 1) return null
                  const cx = bt.edge === 'left' ? 0 : (bt.edge === 'right' ? b.w : b.w * bt.posFrac)
                  const cy = bt.edge === 'top' ? 0 : (bt.edge === 'bottom' ? b.h : b.h * bt.posFrac)
                  return (
                    <g key={`bt_${idx}`}>
                      <circle cx={cx} cy={cy} r={r} fill="rgba(18, 22, 32, 0.72)" stroke="rgba(255, 255, 255, 0.85)" strokeWidth="1.4" strokeDasharray="3 2" />
                      <circle cx={cx - r * 0.25} cy={cy - r * 0.25} r={r * 0.35} fill="rgba(255, 255, 255, 0.32)" />
                    </g>
                  )
                })}
              </svg>
            )}

            {/* 修补时的液态玻璃流光填充进度（与 3D 助手修补动作 100% 同步！） */}
            {b.status === 'repairing' && (
              <span className="gsb-heal-veil" style={{ transform: `scaleX(${b.repairProgress.toFixed(3)})` }} />
            )}

            {!isInPlaceBite && (
              <span className="gsb-hp-dots" aria-hidden="true">
                {Array.from({ length: b.maxHp }, (_, i) => (
                  <span key={i} className="gsb-hp-dot" data-lost={String(i >= b.hp)} />
                ))}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
