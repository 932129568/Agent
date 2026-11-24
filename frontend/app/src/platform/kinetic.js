/**
 * Harbor R3 物理撞击与二阶阻尼弹簧引擎（零 document.querySelector，纯 React Ref 驱动）：
 * - 校准目标（对齐第二轮验收单 #4）：
 *   1) 峰值位移 4.5–6.0px（面板切换 ~4.6px，浮层撞回 ~5.6px），协同 scale(0.988) 与微扭矩 0.35deg；
 *   2) 收敛时间 250–310ms，过冲 1–2 次，收敛后严格清零 transform（0px 残余）；
 *   3) 撞击瞬间在接触边触发 140ms 弧形菲涅尔高光脉冲（由 CSS data-impact-edge 驱动，绝非硬边直线胶带）；
 *   4) reduced 动效档下全量静默归零。
 */
const _bodies = new WeakMap()

export function createDampedSpring({ omega = 24, zeta = 0.44 } = {}) {
  const w = Math.max(4, Number(omega) || 24)
  const z = Math.max(0.15, Math.min(0.98, Number(zeta) || 0.44))
  const wd = w * Math.sqrt(Math.max(0.0001, 1 - z * z))
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
    const settled = Math.abs(nextPos) < 0.04 && Math.abs(nextVel) < 0.4
    return settled ? { pos: 0, vel: 0, settled: true } : { pos: nextPos, vel: nextVel, settled: false }
  }
}

/** 纯数学离线仿真器（供 L1 单元测试验证峰值位移、过冲次数、收敛时间与残余位移） */
export function simulateImpactCurve({ v0 = 260, omega = 24, zeta = 0.44, maxPx = 6.2, dt = 1 / 60, maxMs = 900 } = {}) {
  const stepper = createDampedSpring({ omega, zeta })
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

function softClamp(v, limit) {
  return limit > 0 ? limit * Math.tanh(v / limit) : 0
}

export function motionScaleForTier(tier) {
  if (tier === 'reduced') return 0
  if (tier === 'balanced') return 0.58
  return 1.0
}

/** 对目标 DOM 元素（通过 React ref.current 传入）施加校准后的物理撞击冲量 */
export function applyKineticImpulse(el, {
  vx = 0,
  vy = 0,
  vrot = 0,
  vsc = -0.34,
  omega = 24,
  zeta = 0.44,
  maxPx = 6.2,
  maxRot = 0.42,
  maxSc = 0.015,
  motionTier = 'dynamic',
} = {}) {
  const k = motionScaleForTier(motionTier)
  if (!el || !el.style || k === 0 || typeof requestAnimationFrame !== 'function') return false

  let b = _bodies.get(el)
  if (!b) {
    b = {
      x: 0, y: 0, rot: 0, sc: 0,
      vx: 0, vy: 0, vrot: 0, vsc: 0,
      maxPx, maxRot, maxSc,
      spPos: createDampedSpring({ omega, zeta }),
      spSc: createDampedSpring({ omega: omega + 4, zeta: Math.min(0.82, zeta + 0.08) }),
      raf: 0, lastT: 0,
    }
    _bodies.set(el, b)
  } else {
    b.maxPx = maxPx
    b.maxRot = maxRot
    b.maxSc = maxSc
    b.spPos = createDampedSpring({ omega, zeta })
    b.spSc = createDampedSpring({ omega: omega + 4, zeta: Math.min(0.82, zeta + 0.08) })
  }

  b.vx = Math.max(-420, Math.min(420, b.vx + vx * k))
  b.vy = Math.max(-420, Math.min(420, b.vy + vy * k))
  b.vrot = Math.max(-24, Math.min(24, b.vrot + vrot * k))
  b.vsc = Math.max(-1.8, Math.min(1.8, b.vsc + vsc * k))

  const tick = (now) => {
    b.raf = 0
    const dt = Math.min(0.05, Math.max(0.001, (now - b.lastT) / 1000))
    b.lastT = now
    const sx = b.spPos(b.x, b.vx, dt)
    const sy = b.spPos(b.y, b.vy, dt)
    const sr = b.spPos(b.rot, b.vrot, dt)
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

/** 浮层关闭弹射飞出动画（130ms WAAPI，飞向撞击边后触发回调，reduced 模式立即回调） */
export function playModalFlyOut(cardEl, edge = 'left', motionTier = 'dynamic', onImpact, onFinish) {
  const k = motionScaleForTier(motionTier)
  if (!cardEl || k === 0 || typeof cardEl.animate !== 'function') {
    if (typeof onImpact === 'function') onImpact()
    if (typeof onFinish === 'function') onFinish()
    return
  }
  const vec = {
    left: { dx: -180, dy: -20 },
    right: { dx: 180, dy: -20 },
    top: { dx: 0, dy: -120 },
    bottom: { dx: 0, dy: 120 },
  }[edge] || { dx: -160, dy: 0 }

  const dur = 130
  let impacted = false
  let done = false
  const fireImpact = () => {
    if (impacted) return
    impacted = true
    if (typeof onImpact === 'function') onImpact()
  }
  const settle = () => {
    if (done) return
    done = true
    fireImpact()
    if (typeof onFinish === 'function') onFinish()
  }

  const anim = cardEl.animate(
    [
      { transform: 'translate3d(0,0,0) scale(1)', opacity: 1 },
      { transform: `translate3d(${vec.dx * k}px,${vec.dy * k}px,0) scale(0.84)`, opacity: 0 },
    ],
    { duration: dur, easing: 'cubic-bezier(.42, 0, 1, .68)', fill: 'forwards' }
  )
  setTimeout(fireImpact, Math.round(dur * 0.78))
  anim.onfinish = settle
  anim.oncancel = settle
  setTimeout(settle, dur + 50)
}
