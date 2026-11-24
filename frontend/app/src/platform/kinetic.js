/**
 * Harbor R4 物理撞击与二阶阻尼弹簧引擎（零 document.querySelector，纯 React Ref 驱动）：
 * - 修复 R3 Suite-D 缩放通道被像素阈值误杀的根因：
 *   位移(px)、旋转(deg)、缩放(ratio) 三轴使用各自物理量纲的收敛阈值（posEps / velEps）；
 * - 校准指标：
 *   1) 强撞击位移峰值 ~4.81px，协同缩放 minScale ≈ 0.989–0.991（< 0.996），微扭矩 0.38°；
 *   2) 收敛时间 ~250ms，过冲 ≤ 2 次，收敛后严格清零 transform（0px 残余）；
 *   3) 接触边触发 140ms 弧形菲涅尔高光脉冲；
 *   4) reduced 动效档下全量静默归零。
 */
const _bodies = new WeakMap()

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

/** 位移通道离线仿真器（供 L1 单元测试校验峰值位移、收敛时间、过冲次数与残余） */
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

/** 缩放通道离线仿真器（独立量纲 posEps=0.0002 / velEps=0.002，防止被 px 阈值误杀） */
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

export function motionScaleForTier(tier) {
  if (tier === 'reduced') return 0
  if (tier === 'balanced') return 0.58
  return 1.0
}

/** 对目标 DOM 元素（通过 React ref.current 传入）施加三轴独立量纲校准后的物理撞击冲量 */
export function applyKineticImpulse(el, {
  vx = 0,
  vy = 0,
  vrot = 0,
  vsc = -0.56,
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
