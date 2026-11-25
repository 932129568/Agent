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
  vrx = null,
  vry = null,
  omega = 24,
  zeta = 0.44,
  maxPx = 6.2,
  maxRot = 0.42,
  maxSc = 0.016,
  maxTilt = 1.65,
  motionTier = 'dynamic',
} = {}) {
  const k = motionScaleForTier(motionTier)
  if (!el || !el.style || k === 0 || typeof requestAnimationFrame !== 'function') return false

  const spPos = createDampedSpring({ omega, zeta, posEps: 0.04, velEps: 0.4 })
  const spRot = createDampedSpring({ omega, zeta, posEps: 0.005, velEps: 0.05 })
  const spSc = createDampedSpring({ omega: omega + 4, zeta: Math.min(0.82, zeta + 0.06), posEps: 0.0002, velEps: 0.002 })

  const spTilt = createDampedSpring({ omega: omega + 2, zeta: Math.min(0.84, zeta + 0.04), posEps: 0.008, velEps: 0.08 })
  let b = _bodies.get(el)
  if (!b) {
    b = {
      x: 0, y: 0, rot: 0, sc: 0, rx: 0, ry: 0,
      vx: 0, vy: 0, vrot: 0, vsc: 0, vrx: 0, vry: 0,
      maxPx, maxRot, maxSc, maxTilt,
      spPos, spRot, spSc, spTilt,
      raf: 0, lastT: 0,
    }
    _bodies.set(el, b)
  } else {
    b.maxPx = maxPx
    b.maxRot = maxRot
    b.maxSc = maxSc
    b.maxTilt = maxTilt
    b.spPos = spPos
    b.spRot = spRot
    b.spSc = spSc
    b.spTilt = spTilt
  }

  const effVrx = Number.isFinite(vrx) ? vrx : (-vy * 0.075)
  const effVry = Number.isFinite(vry) ? vry : (vx * 0.085)

  b.vx = Math.max(-420, Math.min(420, b.vx + vx * k))
  b.vy = Math.max(-420, Math.min(420, b.vy + vy * k))
  b.vrot = Math.max(-24, Math.min(24, b.vrot + vrot * k))
  b.vsc = Math.max(-2.2, Math.min(2.2, b.vsc + vsc * k))
  b.vrx = Math.max(-44, Math.min(44, b.vrx + effVrx * k))
  b.vry = Math.max(-44, Math.min(44, b.vry + effVry * k))

  const tick = (now) => {
    b.raf = 0
    const dt = Math.min(0.05, Math.max(0.001, (now - b.lastT) / 1000))
    b.lastT = now
    const sx = b.spPos(b.x, b.vx, dt)
    const sy = b.spPos(b.y, b.vy, dt)
    const sr = b.spRot(b.rot, b.vrot, dt)
    const ss = b.spSc(b.sc, b.vsc, dt)
    const stx = b.spTilt(b.rx, b.vrx, dt)
    const sty = b.spTilt(b.ry, b.vry, dt)
    b.x = sx.pos; b.vx = sx.vel
    b.y = sy.pos; b.vy = sy.vel
    b.rot = sr.pos; b.vrot = sr.vel
    b.sc = ss.pos; b.vsc = ss.vel
    b.rx = stx.pos; b.vrx = stx.vel
    b.ry = sty.pos; b.vry = sty.vel

    if (sx.settled && sy.settled && sr.settled && ss.settled && stx.settled && sty.settled) {
      el.style.transform = ''
      el.style.willChange = ''
      b.x = b.y = b.rot = b.sc = b.rx = b.ry = 0
      b.vx = b.vy = b.vrot = b.vsc = b.vrx = b.vry = 0
      return
    }
    const cx = softClamp(b.x, b.maxPx)
    const cy = softClamp(b.y, b.maxPx)
    const crot = softClamp(b.rot, b.maxRot)
    const csc = softClamp(b.sc, b.maxSc)
    const rxDeg = softClamp(b.rx, b.maxTilt)
    const ryDeg = softClamp(b.ry, b.maxTilt)
    const shearY = softClamp(cx * 0.042, 0.24)
    const scaleX = 1 + csc
    const scaleY = 1 - csc * 0.42
    el.style.transform =
      `perspective(1200px) translate3d(${cx.toFixed(2)}px,${cy.toFixed(2)}px,0)` +
      ` rotateY(${ryDeg.toFixed(3)}deg) rotateX(${rxDeg.toFixed(3)}deg) rotate(${crot.toFixed(3)}deg)` +
      ` skewY(${shearY.toFixed(3)}deg) scale3d(${scaleX.toFixed(4)},${scaleY.toFixed(4)},1)`
    b.raf = requestAnimationFrame(tick)
  }

  if (!b.raf) {
    el.style.willChange = 'transform'
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
  const sx = dx * 0.68 * k
  const sy = dy * 0.68 * k
  const tilt = dx < 0 ? -2.2 * k : (dx > 0 ? 2.2 * k : 0)
  if (backdropEl && typeof backdropEl.animate === 'function') {
    backdropEl.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 210, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'backwards' }
    )
  }
  cardEl.animate(
    [
      { transform: `translate3d(${sx.toFixed(1)}px,${sy.toFixed(1)}px,0) scale(${(1 - 0.66 * k).toFixed(3)}) rotate(${tilt.toFixed(2)}deg)`, opacity: 0, offset: 0 },
      { transform: `translate3d(${(-dx * 0.012 * k).toFixed(1)}px,${(-dy * 0.012 * k).toFixed(1)}px,0) scale(${(1 + 0.014 * k).toFixed(3)}) rotate(${(-tilt * 0.16).toFixed(2)}deg)`, opacity: 1, offset: 0.72 },
      { transform: 'translate3d(0,0,0) scale(1) rotate(0deg)', opacity: 1, offset: 1 },
    ],
    { duration: 330, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'backwards' }
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

  // R28 窗口关闭「变形胶囊高速撞回原位」过渡：先收束为原位胶囊比例与圆角，再高速撞击目标位置！
  const cr = typeof cardEl.getBoundingClientRect === 'function' ? cardEl.getBoundingClientRect() : null
  const sxCap = (cr && cr.width > 40 && targetRect && targetRect.width > 18)
    ? Math.max(0.14, Math.min(0.45, targetRect.width / cr.width))
    : 0.22
  const syCap = (cr && cr.height > 40 && targetRect && targetRect.height > 18)
    ? Math.max(0.06, Math.min(0.32, targetRect.height / cr.height))
    : 0.12
  const flyTilt = tx < 0 ? -3.6 * k : (tx > 0 ? 3.6 * k : 0)
  const anim = cardEl.animate(
    [
      { transform: 'translate3d(0,0,0) scale(1,1) rotate(0deg)', borderRadius: '22px', opacity: 1, offset: 0 },
      { transform: `translate3d(${(tx * 0.34).toFixed(1)}px,${(ty * 0.34).toFixed(1)}px,0) scale(${(0.56).toFixed(3)},${(0.36).toFixed(3)}) rotate(${(flyTilt * 0.5).toFixed(2)}deg)`, borderRadius: '999px', opacity: 0.94, offset: 0.46 },
      { transform: `translate3d(${tx.toFixed(1)}px,${ty.toFixed(1)}px,0) scale(${sxCap.toFixed(3)},${syCap.toFixed(3)}) rotate(${flyTilt.toFixed(2)}deg)`, borderRadius: '999px', opacity: 0.12, offset: 0.94 },
      { transform: `translate3d(${(tx * 1.04).toFixed(1)}px,${(ty * 1.04).toFixed(1)}px,0) scale(${(sxCap * 0.82).toFixed(3)},${(syCap * 1.18).toFixed(3)}) rotate(0deg)`, borderRadius: '999px', opacity: 0, offset: 1 },
    ],
    { duration: dur + 45, easing: 'cubic-bezier(.34, 0, .82, .28)', fill: 'forwards' }
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


/** 耦合反作用力微回弹：当窗口撞回左侧栏或顶栏时，承重边缘同步产生反向微压缩回弹，增强质量感。 */
export function applySecondaryRecoil(el, { edge = 'left', strength = 'strong', motionTier = 'dynamic' } = {}) {
  const k = motionScaleForTier(motionTier)
  if (!el || k === 0 || typeof el.animate !== 'function') return false
  const amp = (strength === 'strong' ? 3.2 : 2.0) * k
  const dx = edge === 'left' ? -amp : (edge === 'right' ? amp : 0)
  const dy = edge === 'top' ? -amp : (edge === 'bottom' ? amp : 0)
  const horiz = edge === 'left' || edge === 'right'
  const sqX = horiz ? (1 - 0.012 * k) : (1 + 0.005 * k)
  const sqY = horiz ? (1 + 0.006 * k) : (1 - 0.012 * k)
  const rebX = horiz ? (1 + 0.005 * k) : (1 - 0.002 * k)
  const rebY = horiz ? (1 - 0.002 * k) : (1 + 0.005 * k)
  try {
    el.animate(
      [
        { transform: 'translate3d(0,0,0) scale3d(1,1,1)', offset: 0 },
        { transform: `translate3d(${dx.toFixed(2)}px,${dy.toFixed(2)}px,0) scale3d(${sqX.toFixed(4)},${sqY.toFixed(4)},1)`, offset: 0.22 },
        { transform: `translate3d(${(-dx * 0.38).toFixed(2)}px,${(-dy * 0.38).toFixed(2)}px,0) scale3d(${rebX.toFixed(4)},${rebY.toFixed(4)},1)`, offset: 0.62 },
        { transform: 'translate3d(0,0,0) scale3d(1,1,1)', offset: 1 },
      ],
      { duration: 310, easing: 'cubic-bezier(.22, 1, .36, 1)' }
    )
    return true
  } catch {
    return false
  }
}


/**
 * R24 液态玻璃 6 大撞击特效风格与专属弹簧物理人格（全部处于 3.8–6.0px / 0 残余校准包络内）：
 * - mercury：液态水银玻璃（谐波变形液面波 + RGB 色散三环 + 飞溅水珠回吸）
 * - prism：棱镜极光折光（晶体焦散扇形光束 + 7 色彩虹色散折射弧 + 浮游 Bokeh）
 * - ripple：禅意水滴涟漪（3 相位真实水面重力波 + 毛细余波 + 微气泡）
 * - crystal：冰晶星芒切面（透明棱面折射闪光 + 四角钻石星芒 + 清脆高频弹性）
 * - aurora：极光磁流体（珊瑚橙/极光青/暮光紫柔性磁流体丝带 + 柔和丝滑阻尼）
 * - random：灵动变奏（每次撞击自动轮换不同液态玻璃特效，永不单一）
 */
export const IMPACT_STYLES = Object.freeze([
  {
    id: 'mercury',
    label: '🫧 液态水银',
    shortDesc: '谐波液面波 + RGB 色散 + 飞溅水珠',
    omega: 24,
    zeta: 0.43,
    speedMul: 1.0,
    shearMul: 1.0,
  },
  {
    id: 'prism',
    label: '🌈 棱镜折光',
    shortDesc: '扇形晶体焦散光束 + 虹彩折射弧',
    omega: 25,
    zeta: 0.44,
    speedMul: 1.02,
    shearMul: 0.9,
  },
  {
    id: 'ripple',
    label: '💧 禅意涟漪',
    shortDesc: '3 相位清透水波干涉 + 微气泡',
    omega: 22,
    zeta: 0.46,
    speedMul: 0.95,
    shearMul: 1.12,
  },
  {
    id: 'crystal',
    label: '❄️ 冰晶星芒',
    shortDesc: '钻石切面微光 + 四角星芒 + 清脆回弹',
    omega: 27,
    zeta: 0.39,
    speedMul: 1.06,
    shearMul: 0.72,
  },
  {
    id: 'aurora',
    label: '🌌 极光磁液',
    shortDesc: '三色柔性磁流体丝带 + 丝滑浮力',
    omega: 21,
    zeta: 0.47,
    speedMul: 0.96,
    shearMul: 1.2,
  },
  {
    id: 'random',
    label: '✨ 灵动变奏',
    shortDesc: '每次撞击自动切换不同液态光效',
    omega: 24,
    zeta: 0.44,
    speedMul: 1.0,
    shearMul: 1.0,
  },
])

const CONCRETE_IMPACT_IDS = ['mercury', 'prism', 'ripple', 'crystal', 'aurora']

export function resolveImpactStyle(styleId = 'mercury', seq = 0) {
  if (styleId === 'random') {
    const picked = CONCRETE_IMPACT_IDS[Math.abs(Number(seq) || 0) % CONCRETE_IMPACT_IDS.length]
    return IMPACT_STYLES.find((s) => s.id === picked) || IMPACT_STYLES[0]
  }
  return IMPACT_STYLES.find((s) => s.id === styleId) || IMPACT_STYLES[0]
}


/**
 * R25 真实点击位置二维力矩物理引擎：
 * 根据真实点击归一化坐标 (nx, ny) ∈ [0,1]×[0,1] 计算质心杠杆臂 r = (nx - 0.5, ny - 0.5)：
 * - 点右上角 (0.9, 0.1)：线性冲量向左下推开 (vx<0, vy>0)，同时右上角向屏幕纵深压下 (rotateY>0, rotateX>0)；
 * - 点左下角 (0.1, 0.9)：线性冲量向右上推开 (vx>0, vy<0)，左下角压下；
 * - 点正中心 (0.5, 0.5)：零偏心横移，纯粹 Z 轴深压回弹 + 360° 径向液态玻璃折射波。
 */
export function computeDirectionalImpulse({ nx = null, ny = null, edge = 'left', dy = 0, strength = 'strong', stylePreset = null } = {}) {
  const isStrong = strength === 'strong'
  const isLight = strength === 'light'
  const mul = (stylePreset && stylePreset.speedMul) || 1
  const force = (isStrong ? 275 : (isLight ? 115 : 205)) * mul

  // 显式边缘撞击（无具体指针坐标时，兼容弹窗飞回锚点与四向校准按钮）
  if (nx == null || ny == null) {
    const pct = dy ? Math.max(0.16, Math.min(0.84, 0.5 + dy * 0.0012)) : 0.5
    const fallbackCoord = {
      left: { nx: 0.03, ny: pct },
      right: { nx: 0.97, ny: pct },
      top: { nx: 0.5, ny: 0.04 },
      bottom: { nx: 0.5, ny: 0.96 },
    }[edge] || { nx: 0.03, ny: 0.5 }
    const yBias = dy ? Math.max(-68, Math.min(68, dy * 0.22)) : (isStrong ? 28 : 16)
    const vx = edge === 'left' ? force : (edge === 'right' ? -force : 0)
    const vy = edge === 'top' ? force * 0.78 : (edge === 'bottom' ? -force * 0.78 : yBias)
    const vrot = edge === 'left' ? (dy > 40 ? -6.2 : 7.0) : (edge === 'right' ? -7.0 : 0)
    return {
      nx: fallbackCoord.nx,
      ny: fallbackCoord.ny,
      edge: edge || 'left',
      vx,
      vy,
      vrot,
      vsc: isStrong ? -0.62 : (isLight ? -0.22 : -0.34),
      vrx: edge === 'top' ? 24 : (edge === 'bottom' ? -24 : (0.5 - fallbackCoord.ny) * 24),
      vry: edge === 'left' ? -26 : (edge === 'right' ? 26 : 0),
      maxPx: isStrong ? 6.0 : (isLight ? 2.8 : 4.6),
      maxRot: isStrong ? 0.38 : (isLight ? 0.16 : 0.24),
      maxSc: isStrong ? 0.016 : (isLight ? 0.007 : 0.011),
      maxTilt: isStrong ? 1.75 : (isLight ? 0.95 : 1.25),
    }
  }

  const cx = Math.max(0.02, Math.min(0.98, Number(nx)))
  const cy = Math.max(0.02, Math.min(0.98, Number(ny)))
  const armX = cx - 0.5 // [-0.48, +0.48]
  const armY = cy - 0.5
  const dist = Math.hypot(armX, armY)

  // 从点击点向反方向推开（距离中心越远，切向力矩与位移越明显；正中心则纯 Z 轴下压）
  const pushScale = Math.min(1, dist / 0.44)
  const dirX = dist > 0.03 ? (-armX / dist) : 0
  const dirY = dist > 0.03 ? (-armY / dist) : 0
  const vx = dirX * force * (0.28 + 0.72 * pushScale)
  const vy = dirY * force * (0.28 + 0.72 * pushScale)

  // 真实 3D 杠杆力矩：按下哪一角，哪一角向屏幕里下沉（CSS rotateY>0 右侧下沉，rotateX>0 顶部下沉）
  const torqueGain = isStrong ? 62 : (isLight ? 30 : 44)
  const vry = armX * torqueGain
  const vrx = -armY * torqueGain
  const vrot = (armX * dirY - armY * dirX) * (isStrong ? 16 : 8) + (-armX * armY * (isStrong ? 22 : 10))
  const vsc = (isStrong ? -0.64 : (isLight ? -0.24 : -0.38)) * (1 + (1 - pushScale) * 0.28)

  // 确定最近边界用于耦合承重栏回弹
  const derivedEdge = Math.abs(armX) >= Math.abs(armY)
    ? (armX <= 0 ? 'left' : 'right')
    : (armY <= 0 ? 'top' : 'bottom')

  return {
    nx: cx,
    ny: cy,
    edge: derivedEdge,
    vx,
    vy,
    vrot,
    vsc,
    vrx,
    vry,
    maxPx: isStrong ? 6.0 : (isLight ? 2.6 : 4.6),
    maxRot: isStrong ? 0.38 : (isLight ? 0.16 : 0.24),
    maxSc: isStrong ? 0.016 : (isLight ? 0.008 : 0.012),
    maxTilt: isStrong ? 1.85 : (isLight ? 0.95 : 1.35),
  }
}


/**
 * R26 局部玻璃元素定点按压物理（纯数学解算，便于单测验证）：
 * 计算在单个卡片/按钮内局部坐标 (lx, ly) ∈ [0,1]² 按下时的 3D 杠杆倾角与体积守恒微压缩：
 * - 点左侧 (lx < 0.5)：左侧向内下沉 (ry < 0)；点右侧 (lx > 0.5)：右侧向内下沉 (ry > 0)；
 * - 点顶部 (ly < 0.5)：顶部向内下沉 (rx > 0)；点底部 (ly > 0.5)：底部向内下沉 (rx < 0)。
 */
export function computeLocalPressTransform(lx = 0.5, ly = 0.5, scaleFactor = 1) {
  const cx = Math.max(0, Math.min(1, Number.isFinite(lx) ? lx : 0.5)) - 0.5
  const cy = Math.max(0, Math.min(1, Number.isFinite(ly) ? ly : 0.5)) - 0.5
  const k = Math.max(0, Math.min(1.5, Number(scaleFactor) || 0))
  const ry = Number((cx * 9.5 * k).toFixed(2))
  const rx = Number((-cy * 9.5 * k).toFixed(2))
  const tx = Number((cx * 2.4 * k).toFixed(2))
  const ty = Number((cy * 2.4 * k).toFixed(2))
  const sc = Number((1 - 0.022 * k).toFixed(4))
  return { rx, ry, tx, ty, sc }
}

/** 对被点击的单个液态玻璃控件施加真实局部位置下压与液态回弹动画 */
export function applyLocalGlassPress(el, clientX, clientY, motionTier = 'dynamic') {
  const k = motionScaleForTier(motionTier)
  if (!el || k === 0 || typeof el.getBoundingClientRect !== 'function' || typeof el.animate !== 'function') return false
  const rect = el.getBoundingClientRect()
  if (!rect || rect.width < 12 || rect.height < 12 || rect.width > 720) return false
  const lx = (clientX - rect.left) / rect.width
  const ly = (clientY - rect.top) / rect.height
  const p = computeLocalPressTransform(lx, ly, k)
  try {
    el.animate(
      [
        { transform: 'perspective(680px) translate3d(0,0,0) rotateX(0deg) rotateY(0deg) scale(1)', offset: 0 },
        {
          transform: `perspective(680px) translate3d(${p.tx}px,${p.ty}px,0) rotateX(${p.rx}deg) rotateY(${p.ry}deg) scale(${p.sc})`,
          offset: 0.28,
        },
        {
          transform: `perspective(680px) translate3d(${(-p.tx * 0.28).toFixed(2)}px,${(-p.ty * 0.28).toFixed(2)}px,0) rotateX(${(-p.rx * 0.25).toFixed(2)}deg) rotateY(${(-p.ry * 0.25).toFixed(2)}deg) scale(${(1 + 0.006 * k).toFixed(4)})`,
          offset: 0.68,
        },
        { transform: 'perspective(680px) translate3d(0,0,0) rotateX(0deg) rotateY(0deg) scale(1)', offset: 1 },
      ],
      { duration: 300, easing: 'cubic-bezier(.22, 1, .36, 1)' }
    )
    return true
  } catch {
    return false
  }
}


export function computeViewportCoords(clientX, clientY, vw, vh) {
  const w = Math.max(1, Number(vw) || 1)
  const h = Math.max(1, Number(vh) || 1)
  const nx = Math.max(0.01, Math.min(0.99, (Number(clientX) || 0) / w))
  const ny = Math.max(0.01, Math.min(0.99, (Number(clientY) || 0) / h))
  return { nx: Number(nx.toFixed(4)), ny: Number(ny.toFixed(4)) }
}
