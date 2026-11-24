/**
 * Harbor R7 空间起源动效与三轴阻尼物理撞击引擎（零 document.querySelector，纯 React Ref 驱动）：
 * - 锚点注册表（registerMotionAnchor / captureTriggerRect / pulseMotionAnchor）：
 *   把每个窗口的“归属摆放位置”（如左侧栏「系统设置」「专家市场」「上下文副屏」、顶栏「Ctrl+K」）绑定为真实坐标；
 * - 打开过渡（playModalMorphIn）：useLayoutEffect 同步首帧计算 FLIP 矢量，从触发按钮所在位置平滑弹簧展开（绝不闪开）；
 * - 关闭撞击（playModalFlyOut）：窗口先沿真实矢量向其归属摆放位置加速飞入缩收，撞击瞬间将动量传导至主舞台（峰值 ~4.8–5.8px + scale ~0.989 + 140ms 弧形菲涅尔高光），同时让归属按钮产生一次“接住窗口”的微回弹；
 * - 侧边抽屉（playDrawerSlideIn / playDrawerSlideOut）：副屏与搜索分栏开关皆带弹簧滑入与回撞收起，零硬切；
 * - 无障碍负控：reduced 动效档下所有动效与位移严格归零。
 */
const _bodies = new WeakMap()
const _anchors = new Map() // anchorId -> HTMLElement (via React ref callback)

export function registerMotionAnchor(id, el) {
  if (!id) return
  if (el) _anchors.set(id, el)
  else _anchors.delete(id)
}

export function getMotionAnchorRect(id) {
  const el = id ? _anchors.get(id) : null
  if (!el || typeof el.getBoundingClientRect !== 'function') return null
  const r = el.getBoundingClientRect()
  if (!r || (r.width === 0 && r.height === 0)) return null
  return { x: r.left, y: r.top, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
}

/** 从点击事件或 DOM 元素提取触发起点坐标（用于 FLIP 打开展开） */
export function captureTriggerRect(eventOrEl) {
  const el = eventOrEl && eventOrEl.currentTarget ? eventOrEl.currentTarget : eventOrEl
  if (!el || typeof el.getBoundingClientRect !== 'function') return null
  const r = el.getBoundingClientRect()
  if (!r || (r.width === 0 && r.height === 0)) return null
  return { x: r.left, y: r.top, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
}

export function motionScaleForTier(tier) {
  if (tier === 'reduced') return 0
  if (tier === 'balanced') return 0.58
  return 1.0
}

/** 窗口飞回撞上其归属按钮时，让该按钮产生一次“接住窗口”的弹性回弹微脉冲 */
export function pulseMotionAnchor(anchorId, motionTier = 'dynamic') {
  const k = motionScaleForTier(motionTier)
  const el = anchorId ? _anchors.get(anchorId) : null
  if (!el || k === 0 || typeof el.animate !== 'function') return
  try {
    el.animate(
      [
        { transform: 'scale(1)' },
        { transform: `scale(${(1 - 0.10 * k).toFixed(3)})`, offset: 0.25 },
        { transform: `scale(${(1 + 0.06 * k).toFixed(3)})`, offset: 0.62 },
        { transform: 'scale(1)' },
      ],
      { duration: 280, easing: 'cubic-bezier(.22, 1, .36, 1)' }
    )
  } catch {}
}

export function createDampedSpring({ omega = 24, zeta = 0.44, posEps = 0.04, velEps = 0.4 } = {}) {
  const w = Math.max(4, Number(omega) || 24)
  const z = Math.max(0.15, Math.min(0.98, Number(zeta) || 0.44))
  const wd = w * Math.sqrt(Math.max(0.0001, 1 - z * z))
  const pEps = Math.max(1e-6, Number(posEps) || 0.04)
  const vEps = Math.max(1e-5, Number(velEps) || 0.4)
  return function step(pos, vel, dt) {
    const t = Math.min(0.05, Math.max(0.001, dt))
    const decay = Math.exp(-z * w * t)
    const cos = Math.cos(wd * t)
    const sin = Math.sin(wd * t)
    const c2 = (vel + z * w * pos) / wd
    const nextPos = decay * (pos * cos + c2 * sin)
    const nextVel = decay * (
      (-z * w * pos + wd * c2) * cos
      - (z * w * c2 + wd * pos) * sin
    )
    const settled = Math.abs(nextPos) < pEps && Math.abs(nextVel) < vEps
    return settled ? { pos: 0, vel: 0, settled: true } : { pos: nextPos, vel: nextVel, settled: false }
  }
}

export function simulateImpactCurve({ v0 = 260, omega = 24, zeta = 0.44, maxPx = 6.2, dt = 1 / 60, maxMs = 900 } = {}) {
  const stepper = createDampedSpring({ omega, zeta, posEps: 0.04, velEps: 0.4 })
  let pos = 0
  let vel = v0
  let peakAbs = 0
  let settleMs = 0
  let sign = 0
  let overshoots = 0
  const steps = Math.ceil((maxMs / 1000) / dt)
  for (let i = 1; i <= steps; i++) {
    const r = stepper(pos, vel, dt)
    pos = r.pos
    vel = r.vel
    const clamped = maxPx * Math.tanh(pos / maxPx)
    if (Math.abs(clamped) > peakAbs) peakAbs = Math.abs(clamped)
    if (Math.abs(clamped) >= 0.45) settleMs = Math.round(i * dt * 1000)
    if (Math.abs(clamped) >= 0.2) {
      const s = Math.sign(clamped)
      if (sign && s !== sign) overshoots++
      sign = s
    }
    if (r.settled) break
  }
  return {
    peakAbs: Number(peakAbs.toFixed(2)),
    settleMs,
    overshoots,
    residual: Number(Math.abs(pos).toFixed(3)),
  }
}

export function simulateScaleCurve({ vsc = -0.62, omega = 28, zeta = 0.50, maxSc = 0.016, dt = 1 / 60, maxMs = 900 } = {}) {
  const stepper = createDampedSpring({ omega, zeta, posEps: 0.0002, velEps: 0.002 })
  let sc = 0
  let vel = vsc
  let minScale = 1
  let settleMs = 0
  const steps = Math.ceil((maxMs / 1000) / dt)
  for (let i = 1; i <= steps; i++) {
    const r = stepper(sc, vel, dt)
    sc = r.pos
    vel = r.vel
    const clamped = maxSc * Math.tanh(sc / maxSc)
    const curScale = 1 + clamped
    if (curScale < minScale) minScale = curScale
    if (Math.abs(clamped) >= 0.001) settleMs = Math.round(i * dt * 1000)
    if (r.settled) break
  }
  return {
    minScale: Number(minScale.toFixed(4)),
    settleMs,
    residual: Number(Math.abs(sc).toFixed(5)),
  }
}

function softClamp(v, limit) {
  return limit > 0 ? limit * Math.tanh(v / limit) : 0
}

/** 计算弹窗中心到目标按钮中心（或兜底边方向）的物理位移矢量 */
export function computeTargetDelta(cardEl, rect, fallbackEdge = 'left') {
  if (cardEl && typeof cardEl.getBoundingClientRect === 'function' && rect && Number.isFinite(rect.cx) && Number.isFinite(rect.cy)) {
    const cr = cardEl.getBoundingClientRect()
    const mcx = cr.left + cr.width / 2
    const mcy = cr.top + cr.height / 2
    return {
      dx: Math.max(-620, Math.min(620, rect.cx - mcx)),
      dy: Math.max(-460, Math.min(460, rect.cy - mcy)),
    }
  }
  return {
    left: { dx: -260, dy: 40 },
    right: { dx: 260, dy: 40 },
    top: { dx: 0, dy: -200 },
    bottom: { dx: 0, dy: 200 },
  }[fallbackEdge] || { dx: -240, dy: 0 }
}

/** 对目标 DOM 元素（React ref）施加三轴独立量纲物理撞击冲量 */
export function applyKineticImpulse(el, {
  vx = 0,
  vy = 0,
  vrot = 0,
  vsc = -0.62,
  omega = 24,
  zeta = 0.44,
  maxPx = 6.2,
  maxRot = 0.42,
  maxSc = 0.016,
  motionTier = 'dynamic',
} = {}) {
  const k = motionScaleForTier(motionTier)
  if (!el || !el.style || k === 0 || typeof requestAnimationFrame !== 'function') return false

  const spPos = createDampedSpring({ omega, zeta, posEps: 0.04, velEps: 0.4 })
  const spRot = createDampedSpring({ omega, zeta, posEps: 0.005, velEps: 0.05 })
  const spSc = createDampedSpring({ omega: omega + 4, zeta: Math.min(0.82, zeta + 0.06), posEps: 0.0002, velEps: 0.002 })

  let b = _bodies.get(el)
  if (!b) {
    b = {
      x: 0, y: 0, rot: 0, sc: 0,
      vx: 0, vy: 0, vrot: 0, vsc: 0,
      maxPx, maxRot, maxSc,
      spPos, spRot, spSc,
      raf: 0, lastT: 0,
    }
    _bodies.set(el, b)
  } else {
    b.maxPx = maxPx
    b.maxRot = maxRot
    b.maxSc = maxSc
    b.spPos = spPos
    b.spRot = spRot
    b.spSc = spSc
  }

  b.vx = Math.max(-420, Math.min(420, b.vx + vx * k))
  b.vy = Math.max(-420, Math.min(420, b.vy + vy * k))
  b.vrot = Math.max(-24, Math.min(24, b.vrot + vrot * k))
  b.vsc = Math.max(-2.2, Math.min(2.2, b.vsc + vsc * k))

  const tick = (now) => {
    b.raf = 0
    const dt = Math.min(0.05, Math.max(0.001, (now - b.lastT) / 1000))
    b.lastT = now
    const sx = b.spPos(b.x, b.vx, dt)
    const sy = b.spPos(b.y, b.vy, dt)
    const sr = b.spRot(b.rot, b.vrot, dt)
    const ss = b.spSc(b.sc, b.vsc, dt)
    b.x = sx.pos; b.vx = sx.vel
    b.y = sy.pos; b.vy = sy.vel
    b.rot = sr.pos; b.vrot = sr.vel
    b.sc = ss.pos; b.vsc = ss.vel

    if (sx.settled && sy.settled && sr.settled && ss.settled) {
      el.style.transform = ''
      b.x = b.y = b.rot = b.sc = b.vx = b.vy = b.vrot = b.vsc = 0
      return
    }
    el.style.transform =
      `translate3d(${softClamp(b.x, b.maxPx).toFixed(2)}px,${softClamp(b.y, b.maxPx).toFixed(2)}px,0)` +
      ` rotate(${softClamp(b.rot, b.maxRot).toFixed(3)}deg)` +
      ` scale(${(1 + softClamp(b.sc, b.maxSc)).toFixed(4)})`
    b.raf = requestAnimationFrame(tick)
  }

  if (!b.raf) {
    b.lastT = typeof performance !== 'undefined' ? performance.now() : Date.now()
    b.raf = requestAnimationFrame(tick)
  }
  return true
}

/**
 * 浮层打开：从触发按钮（或归属按钮）真实位置平滑弹簧展开（FLIP 起源，绝不闪开）。
 */
export function playModalMorphIn(cardEl, backdropEl, sourceRect, fallbackEdge = 'left', motionTier = 'dynamic') {
  const k = motionScaleForTier(motionTier)
  if (!cardEl || k === 0 || typeof cardEl.animate !== 'function') return
  const { dx, dy } = computeTargetDelta(cardEl, sourceRect, fallbackEdge)
  const sx = dx * 0.72 * k
  const sy = dy * 0.72 * k
  if (backdropEl && typeof backdropEl.animate === 'function') {
    backdropEl.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 220, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'backwards' }
    )
  }
  cardEl.animate(
    [
      { transform: `translate3d(${sx.toFixed(1)}px,${sy.toFixed(1)}px,0) scale(${(1 - 0.72 * k).toFixed(3)})`, opacity: 0, offset: 0 },
      { transform: `translate3d(${(-dx * 0.014 * k).toFixed(1)}px,${(-dy * 0.014 * k).toFixed(1)}px,0) scale(${(1 + 0.016 * k).toFixed(3)})`, opacity: 1, offset: 0.72 },
      { transform: 'translate3d(0,0,0) scale(1)', opacity: 1, offset: 1 },
    ],
    { duration: 320, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'backwards' }
  )
}

/**
 * 浮层关闭：平滑加速飞向「该窗口摆放归属的按钮位置」，抵达撞击点触发主壳冲击波与目标按钮微回弹。
 */
export function playModalFlyOut(cardEl, edge = 'left', motionTier = 'dynamic', onImpact, onFinish, opts = {}) {
  const k = motionScaleForTier(motionTier)
  const { backdropEl = null, targetRect = null, anchorId = '' } = opts || {}
  if (!cardEl || k === 0 || typeof cardEl.animate !== 'function') {
    if (typeof onImpact === 'function') onImpact({ dx: 0, dy: 0 })
    if (typeof onFinish === 'function') onFinish()
    return
  }

  const { dx, dy } = computeTargetDelta(cardEl, targetRect, edge)
  const tx = dx * 0.88 * k
  const ty = dy * 0.88 * k
  const dur = 210
  let impacted = false
  let done = false

  const fireImpact = () => {
    if (impacted) return
    impacted = true
    if (anchorId) pulseMotionAnchor(anchorId, motionTier)
    if (typeof onImpact === 'function') onImpact({ dx, dy })
  }
  const settle = () => {
    if (done) return
    done = true
    fireImpact()
    if (typeof onFinish === 'function') onFinish()
  }

  if (backdropEl && typeof backdropEl.animate === 'function') {
    backdropEl.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: dur, easing: 'cubic-bezier(.32, 0, .67, 0)', fill: 'forwards' }
    )
  }

  const anim = cardEl.animate(
    [
      { transform: 'translate3d(0,0,0) scale(1)', opacity: 1, offset: 0 },
      { transform: `translate3d(${(tx * 0.35).toFixed(1)}px,${(ty * 0.35).toFixed(1)}px,0) scale(0.84)`, opacity: 0.92, offset: 0.45 },
      { transform: `translate3d(${tx.toFixed(1)}px,${ty.toFixed(1)}px,0) scale(0.22)`, opacity: 0, offset: 1 },
    ],
    { duration: dur, easing: 'cubic-bezier(.36, 0, .84, .32)', fill: 'forwards' }
  )
  setTimeout(fireImpact, Math.round(dur * 0.82))
  anim.onfinish = settle
  anim.oncancel = settle
  setTimeout(settle, dur + 55)
}

/** 侧边副屏 / 搜索分栏平滑展开（绝不闪开） */
export function playDrawerSlideIn(el, motionTier = 'dynamic') {
  const k = motionScaleForTier(motionTier)
  if (!el || k === 0 || typeof el.animate !== 'function') return
  el.animate(
    [
      { transform: `translate3d(${(56 * k).toFixed(1)}px,0,0) scale(${(1 - 0.04 * k).toFixed(3)})`, opacity: 0, offset: 0 },
      { transform: `translate3d(${(-4 * k).toFixed(1)}px,0,0) scale(1.004)`, opacity: 1, offset: 0.74 },
      { transform: 'translate3d(0,0,0) scale(1)', opacity: 1, offset: 1 },
    ],
    { duration: 290, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'backwards' }
  )
}

/** 侧边副屏 / 搜索分栏平滑收回并撞击右侧边缘 */
export function playDrawerSlideOut(el, motionTier = 'dynamic', onImpact, onFinish, anchorId = '') {
  const k = motionScaleForTier(motionTier)
  if (!el || k === 0 || typeof el.animate !== 'function') {
    if (typeof onImpact === 'function') onImpact()
    if (typeof onFinish === 'function') onFinish()
    return
  }
  const dur = 190
  let impacted = false
  let done = false
  const fire = () => {
    if (impacted) return
    impacted = true
    if (anchorId) pulseMotionAnchor(anchorId, motionTier)
    if (typeof onImpact === 'function') onImpact()
  }
  const end = () => {
    if (done) return
    done = true
    fire()
    if (typeof onFinish === 'function') onFinish()
  }
  const anim = el.animate(
    [
      { transform: 'translate3d(0,0,0) scale(1)', opacity: 1 },
      { transform: `translate3d(${(88 * k).toFixed(1)}px,0,0) scale(0.94)`, opacity: 0 },
    ],
    { duration: dur, easing: 'cubic-bezier(.36, 0, .84, .32)', fill: 'forwards' }
  )
  setTimeout(fire, Math.round(dur * 0.80))
  anim.onfinish = end
  anim.oncancel = end
  setTimeout(end, dur + 50)
}
