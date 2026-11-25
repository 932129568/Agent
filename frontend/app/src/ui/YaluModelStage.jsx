import { useEffect, useRef, useState } from 'react'
import YaluModel3D from './YaluModel3D.jsx'
import './YaluModelStage.css'

const AURA_GLOW = {
  natural:  'rgba(174, 215, 162, 0.36)',
  amethyst: 'rgba(134, 84, 148, 0.40)',
  crimson:  'rgba(150, 19, 44, 0.34)',
  glass:    'rgba(255, 255, 255, 0.48)',
}

const DEFAULT_ASSETS = {
  front: './assets/yalu/yalu-front.webp',
  side: './assets/yalu/yalu-turn-side.webp',
  back: './assets/yalu/yalu-turn-back.webp',
  animIdleStrip: './assets/yalu/yalu-anim-idle.webp',
  animActionStrip: './assets/yalu/yalu-anim-action.webp',
  animFrames: 16,
  showcaseVideo: './assets/yalu/yalu-showcase.mp4',
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

function drawSparkle(ctx, x, y, r, color = '#FCDA75', alpha = 1) {
  ctx.save()
  ctx.translate(x, y)
  ctx.globalAlpha = clamp(alpha, 0, 1)
  ctx.fillStyle = color
  ctx.beginPath()
  for (let i = 0; i < 8; i++) {
    const rad = i % 2 === 0 ? r : r * 0.24
    const a = (i * Math.PI) / 4
    const px = Math.cos(a) * rad
    const py = Math.sin(a) * rad
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/** 芽露原版道具：露芽杖（严格按三视图配色：嫩芽绿叶 #AED7A2/#D4EDC4 + 金露核心 #FCDA75 + 暖象牙杖身 #F5E8D6 + 紫晶尾托 #80679D，仅自然握于右手！） */
function drawDewSproutStaff(ctx, glowPower = 0.6, t = 0) {
  ctx.save()
  // 暖象牙木质杖身
  const shaftG = ctx.createLinearGradient(-2.6, -42, 2.6, 36)
  shaftG.addColorStop(0, '#F5E8D6')
  shaftG.addColorStop(0.55, '#E5D6C5')
  shaftG.addColorStop(1, '#CEBEB0')
  ctx.fillStyle = shaftG
  ctx.strokeStyle = '#7D6A62'
  ctx.lineWidth = 1.2
  ctx.beginPath()
  ctx.roundRect(-2.4, -36, 4.8, 68, 2.4)
  ctx.fill()
  ctx.stroke()

  // 底部紫晶装饰尾托 (#80679D / #AB8DC2)
  ctx.fillStyle = '#80679D'
  ctx.strokeStyle = '#4B3466'
  ctx.lineWidth = 1.1
  ctx.beginPath()
  ctx.moveTo(-4, 30)
  ctx.lineTo(4, 30)
  ctx.lineTo(0, 39)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // 杖顶双瓣嫩芽叶托 (#AED7A2 / #D4EDC4 / #8EBF8E)
  const leafG = ctx.createLinearGradient(-12, -52, 12, -32)
  leafG.addColorStop(0, '#D4EDC4')
  leafG.addColorStop(0.55, '#AED7A2')
  leafG.addColorStop(1, '#7CAD7E')
  ctx.fillStyle = leafG
  ctx.strokeStyle = '#537E59'
  ctx.lineWidth = 1.2
  // 左嫩芽
  ctx.beginPath()
  ctx.moveTo(0, -34)
  ctx.bezierCurveTo(-13, -38, -14, -52, -3, -55)
  ctx.bezierCurveTo(-6, -46, -4, -39, 0, -36)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  // 右嫩芽
  ctx.beginPath()
  ctx.moveTo(0, -34)
  ctx.bezierCurveTo(13, -38, 14, -52, 3, -55)
  ctx.bezierCurveTo(6, -46, 4, -39, 0, -36)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // 中央发光晨露金珠 (#FCDA75 / #F0B648)
  const pulse = 0.88 + Math.sin(t * 5.2) * 0.14
  if (glowPower > 0.1) {
    const aura = ctx.createRadialGradient(0, -45, 2, 0, -45, 16 * glowPower * pulse)
    aura.addColorStop(0, `rgba(252, 218, 117, ${(0.72 * glowPower).toFixed(3)})`)
    aura.addColorStop(0.55, `rgba(174, 215, 162, ${(0.36 * glowPower).toFixed(3)})`)
    aura.addColorStop(1, 'rgba(174, 215, 162, 0)')
    ctx.fillStyle = aura
    ctx.beginPath()
    ctx.arc(0, -45, 16 * glowPower * pulse, 0, Math.PI * 2)
    ctx.fill()
  }
  const dewG = ctx.createRadialGradient(-1.8, -47, 1, 0, -45, 5.8)
  dewG.addColorStop(0, '#FFFBEB')
  dewG.addColorStop(0.5, '#FCDA75')
  dewG.addColorStop(1, '#E09F2E')
  ctx.fillStyle = dewG
  ctx.beginPath()
  ctx.arc(0, -45, 5.4, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/** 芽露原版随身道具：酒红铃铛（严格按三视图配色：#96132C / #610111 / #D0708A，自然穿戴在腰间丝带处随物理摇摆！） */
function drawWaistWineBell(ctx, x, y, swingRad, ringing, t) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(swingRad)
  // 上方小丝带结
  ctx.fillStyle = '#9E233A'
  ctx.beginPath()
  ctx.ellipse(-4.2, -1.5, 4.2, 2.4, -0.3, 0, Math.PI * 2)
  ctx.ellipse(4.2, -1.5, 4.2, 2.4, 0.3, 0, Math.PI * 2)
  ctx.fill()
  // 铃铛球体（光泽酒红漆面）
  const bg = ctx.createRadialGradient(-2.2, 2.6, 1, 0, 5.2, 7.2)
  bg.addColorStop(0, '#D46883')
  bg.addColorStop(0.32, '#96132C')
  bg.addColorStop(0.78, '#610111')
  bg.addColorStop(1, '#43020C')
  ctx.fillStyle = bg
  ctx.strokeStyle = '#38010A'
  ctx.lineWidth = 1.05
  ctx.beginPath()
  ctx.arc(0, 5.2, 6.2, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  // 铃铛高光与下方开口缝
  ctx.fillStyle = 'rgba(255, 224, 232, 0.72)'
  ctx.beginPath()
  ctx.ellipse(-2.2, 2.8, 1.8, 1.0, -0.4, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = '#320108'
  ctx.lineWidth = 1.1
  ctx.beginPath()
  ctx.moveTo(-4.2, 7.8)
  ctx.quadraticCurveTo(0, 9.4, 4.2, 7.8)
  ctx.stroke()
  // 摇铃时的清脆音符微光
  if (ringing) {
    drawSparkle(ctx, 9, 4 + Math.sin(t * 18) * 2, 4.5, '#FCDA75', 0.9)
    drawSparkle(ctx, -9, 6 - Math.sin(t * 18) * 2, 3.8, '#F6A6C1', 0.85)
  }
  ctx.restore()
}

/** 芽露 3D 骨骼眼睛（忠实于原版紫晶星芒大眼 + 实时视线追踪 + 自然眨眼 + 全情绪表情） */
function drawYaluEye(ctx, cx, cy, rx, ry, lookX, lookY, blink, actionState, isRight) {
  ctx.save()
  ctx.translate(cx, cy)

  if (actionState === 'grabbed' || actionState === 'thrown') {
    ctx.strokeStyle = '#3A214A'
    ctx.lineWidth = 2.2
    ctx.lineCap = 'round'
    ctx.beginPath()
    if (!isRight) { ctx.moveTo(-rx * 0.7, -ry * 0.4); ctx.lineTo(rx * 0.5, 0); ctx.lineTo(-rx * 0.7, ry * 0.4) }
    else { ctx.moveTo(rx * 0.7, -ry * 0.4); ctx.lineTo(-rx * 0.5, 0); ctx.lineTo(rx * 0.7, ry * 0.4) }
    ctx.stroke()
    ctx.restore()
    return
  }
  if (actionState === 'sleep') {
    ctx.strokeStyle = '#4B2D5E'
    ctx.lineWidth = 2.0
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.arc(0, -1, rx * 0.72, Math.PI * 0.14, Math.PI * 0.86)
    ctx.stroke()
    ctx.restore()
    return
  }
  if (actionState === 'pat' || actionState === 'happy' || actionState === 'deliver' || actionState === 'dance' || actionState === 'bell_play') {
    ctx.strokeStyle = '#3C224F'
    ctx.lineWidth = 2.3
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.arc(0, ry * 0.25, rx * 0.76, Math.PI * 1.12, Math.PI * 1.88)
    ctx.stroke()
    ctx.restore()
    return
  }
  if (blink > 0.84) {
    ctx.strokeStyle = '#3A214A'
    ctx.lineWidth = 2.1
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(-rx * 0.82, 0)
    ctx.quadraticCurveTo(0, ry * 0.34, rx * 0.82, 0)
    ctx.stroke()
    ctx.restore()
    return
  }

  // 眼白
  const wg = ctx.createLinearGradient(0, -ry, 0, ry)
  wg.addColorStop(0, '#E8DFF2')
  wg.addColorStop(0.32, '#FFFFFF')
  wg.addColorStop(1, '#FFFFFF')
  ctx.fillStyle = wg
  ctx.beginPath()
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2)
  ctx.fill()

  // 紫晶晨露渐变虹膜（呼应芽露紫发 + 晨露青金反光）
  const ix = lookX * rx * 0.24
  const iy = lookY * ry * 0.18
  const irx = rx * 0.76
  const iry = ry * 0.84
  const ig = ctx.createLinearGradient(ix, iy - iry, ix, iy + iry)
  ig.addColorStop(0, '#3D1E57')
  ig.addColorStop(0.52, '#7E4BA3')
  ig.addColorStop(0.84, '#B589D6')
  ig.addColorStop(1, '#D7EEC8')
  ctx.fillStyle = ig
  ctx.beginPath()
  ctx.ellipse(ix, iy + 0.5, irx, iry, 0, 0, Math.PI * 2)
  ctx.fill()

  // 瞳孔
  ctx.fillStyle = '#241133'
  ctx.beginPath()
  ctx.ellipse(ix, iy + 0.4, irx * 0.42, iry * 0.46, 0, 0, Math.PI * 2)
  ctx.fill()

  // 主/次高光
  ctx.fillStyle = '#FFFFFF'
  ctx.beginPath()
  ctx.ellipse(ix - irx * 0.34, iy - iry * 0.36, irx * 0.30, iry * 0.24, -0.35, 0, Math.PI * 2)
  ctx.fill()
  ctx.beginPath()
  ctx.arc(ix + irx * 0.32, iy + iry * 0.28, irx * 0.15, 0, Math.PI * 2)
  ctx.fill()

  // 精细紫褐上睫毛
  ctx.strokeStyle = '#331A45'
  ctx.lineWidth = Math.max(2.0, rx * 0.25)
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(-rx * 1.04, -ry * 0.10)
  ctx.quadraticCurveTo(0, -ry * 1.20, rx * 1.04, -ry * 0.10)
  ctx.stroke()

  ctx.restore()
}

/**
 * 芽露 3D 骨骼模型 60fps 绘制器：
 * 具备真实 3D 偏航角 (yaw)、呼吸、步态腿臂交替摆动、头发/披风/裙摆/腰间酒红铃铛二次物理弹簧、
 * 以及 16 套鲜活自然的逐帧角色动作。
 */
function drawYalu3DSkeleton(ctx, { t, w, h, actionState, facing, lookX, lookY, dragTilt, auraTheme, scale, phys }) {
  const isWalk = actionState === 'run' || actionState === 'walk' || actionState === 'collect_shards'
  const isGrab = actionState === 'grabbed' || actionState === 'thrown'
  const isSit = actionState === 'sit_edge'
  const isSleep = actionState === 'sleep'
  const isCrouch = actionState === 'crouch_click' || actionState === 'repair_glass' || actionState === 'sneak_eat'
  const isStretch = actionState === 'stretch'
  const isBellPlay = actionState === 'bell_play' || actionState === 'deliver'
  const isCast = actionState === 'magic_blackhole' || actionState === 'supervising' || actionState === 'write_input' || actionState === 'repair_glass'
  const isDance = actionState === 'dance'
  const isPeek = actionState === 'peek_edge'
  const showBackView = actionState === 'repair_glass' || actionState === 'write_input'

  // 平滑更新 3D 物理弹簧（偏航、发丝、腰间酒红铃铛）
  const targetYaw = showBackView ? 0 : clamp((facing > 0 ? 0.22 : -0.22) + lookX * 0.28 + (isPeek ? (facing > 0 ? 0.35 : -0.35) : 0), -0.58, 0.58)
  phys.yaw += (targetYaw - phys.yaw) * 0.12
  const targetBell = (isGrab ? dragTilt * 1.4 : 0) + (isWalk ? Math.sin(t * 11) * 0.28 : 0) + (isBellPlay ? Math.sin(t * 22) * 0.55 : Math.sin(t * 2.4) * 0.05)
  phys.bellVel += (targetBell - phys.bellAng) * 0.22
  phys.bellVel *= 0.80
  phys.bellAng = clamp(phys.bellAng + phys.bellVel, -0.75, 0.75)

  const targetHair = (isGrab ? -dragTilt * 16 : 0) + (isWalk ? -facing * 5 + Math.sin(t * 11) * 3.5 : Math.sin(t * 2.2) * 2.6)
  phys.hairVel += (targetHair - phys.hairSway) * 0.18
  phys.hairVel *= 0.82
  phys.hairSway += phys.hairVel

  // 眨眼周期
  const blinkPhase = t % 4.1
  const blink = blinkPhase > 3.94 ? Math.sin(((blinkPhase - 3.94) / 0.16) * Math.PI) : 0

  const breath = Math.sin(t * (isSleep ? 1.7 : 2.9))
  const walkPhase = t * 11.5
  const bobY = isGrab
    ? Math.sin(t * 12) * 2.2
    : (isWalk
      ? -Math.abs(Math.sin(walkPhase)) * 7.5
      : (isDance ? -Math.abs(Math.sin(t * 7.5)) * 11 : (isCrouch ? 12 : (isSleep ? 16 + breath * 1.5 : (isSit ? 10 : breath * 2.4)))))

  const bodyTilt = isGrab
    ? clamp(dragTilt * 0.85, -0.45, 0.45) + Math.sin(t * 15) * 0.05
    : (isPeek ? (facing > 0 ? 0.18 : -0.18) : (isDance ? Math.sin(t * 7.5) * 0.14 : (isWalk ? (facing > 0 ? 0.06 : -0.06) : breath * 0.015)))

  const unit = (Math.min(w * 1.15, h) / 192) * clamp(scale || 1, 0.75, 1.35)
  const cx = w / 2
  const groundY = h - 14 * unit

  // 柔和地面投影 + 晨露微光晕
  if (!isGrab) {
    const glow = AURA_GLOW[auraTheme] || AURA_GLOW.natural
    const gRad = ctx.createRadialGradient(cx, groundY, 2, cx, groundY, 36 * unit)
    gRad.addColorStop(0, glow)
    gRad.addColorStop(0.55, 'rgba(30, 42, 72, 0.14)')
    gRad.addColorStop(1, 'rgba(30, 42, 72, 0)')
    ctx.fillStyle = gRad
    ctx.beginPath()
    ctx.ellipse(cx, groundY, 36 * unit, 9 * unit, 0, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.save()
  ctx.translate(cx, groundY - 78 * unit + bobY * unit)
  ctx.scale(unit, unit)
  ctx.rotate(bodyTilt)

  // 3D 透视偏航偏移量（让头、五官、发丝与肩膀产生真实立体纵深感！）
  const yawX = phys.yaw * 10
  const yawSq = 1 - Math.abs(phys.yaw) * 0.12

  // 监工雷达星环 / 魔法黑洞
  if (actionState === 'supervising') {
    ctx.save()
    ctx.strokeStyle = 'rgba(174, 215, 162, 0.72)'
    ctx.lineWidth = 1.6
    ctx.setLineDash([5, 5])
    ctx.beginPath()
    ctx.ellipse(0, -4, 54, 14, Math.sin(t * 2) * 0.08, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
    drawSparkle(ctx, -42, -48 + Math.sin(t * 5) * 4, 6.5, '#FCDA75', 0.9)
    ctx.restore()
  } else if (actionState === 'magic_blackhole') {
    ctx.save()
    const bhX = facing > 0 ? 48 : -48
    const bhG = ctx.createRadialGradient(bhX, -14, 3, bhX, -14, 26)
    bhG.addColorStop(0, '#090D18')
    bhG.addColorStop(0.52, '#69407A')
    bhG.addColorStop(0.82, '#8CB5D3')
    bhG.addColorStop(1, 'rgba(140, 181, 211, 0)')
    ctx.fillStyle = bhG
    ctx.beginPath()
    ctx.arc(bhX, -14, 24 + Math.sin(t * 10) * 2.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  // ============================================================================
  // 1) 后层长卷紫发 (#69407A / #643A76 / #492659) — 带 3D 视差反移与柔软弹簧摆动
  // ============================================================================
  const hs = phys.hairSway
  const backHairG = ctx.createLinearGradient(0, -68, 0, 42)
  backHairG.addColorStop(0, '#865494')
  backHairG.addColorStop(0.45, '#69407A')
  backHairG.addColorStop(1, '#4C2A5E')
  ctx.fillStyle = backHairG
  ctx.strokeStyle = '#3B1E4C'
  ctx.lineWidth = 1.6
  ctx.beginPath()
  ctx.moveTo(-29 - yawX * 0.35, -36)
  ctx.bezierCurveTo(-39, -6, -40 + hs * 0.5, 22, -26 + hs, 40)
  ctx.quadraticCurveTo(-12 + hs * 0.7, 34, -4 + hs * 0.5, 42)
  ctx.quadraticCurveTo(8 + hs * 0.7, 34, 26 + hs, 40)
  ctx.bezierCurveTo(40 + hs * 0.5, 22, 39, -6, 29 - yawX * 0.35, -36)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // ============================================================================
  // 2) 双腿（暖奶白长袜 #F3E6E3 + 酒红滚边 #9E384C + 晴蓝深海小鞋 #92B3DB/#2D4876）
  // ============================================================================
  const legL = isGrab ? Math.sin(t * 22) * 0.52
    : (isWalk ? Math.sin(walkPhase) * 0.42
      : (isSit ? -0.95 + Math.sin(t * 4.5) * 0.22
        : (isSleep ? -0.45 : (isDance ? Math.sin(t * 7.5) * 0.25 : 0))))
  const legR = isGrab ? -Math.sin(t * 22) * 0.52
    : (isWalk ? -Math.sin(walkPhase) * 0.42
      : (isSit ? -0.95 - Math.sin(t * 4.5) * 0.22
        : (isSleep ? -0.35 : (isDance ? -Math.sin(t * 7.5) * 0.25 : 0))))

  for (const [side, ang] of [[-1, legL], [1, legR]]) {
    ctx.save()
    ctx.translate(side * 9.5 * yawSq, 36)
    ctx.rotate(ang)
    // 大腿皮肤
    ctx.fillStyle = '#F2CDC0'
    ctx.beginPath()
    ctx.roundRect(-4.6, 0, 9.2, 13, 4)
    ctx.fill()
    // 奶白长筒袜 (#F3E6E3 / #E1D3D4)
    const sockG = ctx.createLinearGradient(-4.6, 10, 4.6, 36)
    sockG.addColorStop(0, '#F8ECEA')
    sockG.addColorStop(1, '#E2D4D6')
    ctx.fillStyle = sockG
    ctx.strokeStyle = '#9C8B94'
    ctx.lineWidth = 1.0
    ctx.beginPath()
    ctx.roundRect(-4.6, 10, 9.2, 24, 3.5)
    ctx.fill()
    ctx.stroke()
    // 袜口酒红细边 (#9E384C)
    ctx.fillStyle = '#9E384C'
    ctx.fillRect(-4.7, 10.5, 9.4, 2.4)
    // 雾蓝/深海小鞋 (#92B3DB / #2D4876)
    const shoeG = ctx.createLinearGradient(0, 31, 0, 40)
    shoeG.addColorStop(0, '#92B3DB')
    shoeG.addColorStop(1, '#2D4876')
    ctx.fillStyle = shoeG
    ctx.strokeStyle = '#1E3254'
    ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.roundRect(-5.6, 31, 11.4, 8.6, 4.2)
    ctx.fill()
    ctx.stroke()
    ctx.restore()
  }

  // ============================================================================
  // 3) 深紫褶皱连衣裙 (#6F5790 / #785492) + 嫩芽米青披肩上衣 (#D3DAC6 / #E5DECA / #9BAE92)
  // ============================================================================
  const skirtSway = hs * 0.25
  const skirtG = ctx.createLinearGradient(0, 12, 0, 46)
  skirtG.addColorStop(0, '#7B5B99')
  skirtG.addColorStop(0.65, '#644882')
  skirtG.addColorStop(1, '#4C3466')
  ctx.fillStyle = skirtG
  ctx.strokeStyle = '#3B2552'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(-14 * yawSq, 12)
  ctx.lineTo(14 * yawSq, 12)
  ctx.bezierCurveTo(22, 24, 29 + skirtSway * 0.4, 36, 28 + skirtSway, 44)
  ctx.quadraticCurveTo(skirtSway * 0.4, 49, -28 + skirtSway, 44)
  ctx.bezierCurveTo(-29 + skirtSway * 0.4, 36, -22, 24, -14 * yawSq, 12)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // 裙摆淡粉米白花边 (#DFD8D2)
  ctx.strokeStyle = '#EDE4E2'
  ctx.lineWidth = 2.2
  ctx.beginPath()
  ctx.moveTo(-25 + skirtSway, 42)
  ctx.quadraticCurveTo(skirtSway * 0.4, 46.5, 25 + skirtSway, 42)
  ctx.stroke()

  // 上身淡青米色披肩斗篷 (#D3DAC6 / #E5DECA / #9BAE92)
  const capeG = ctx.createLinearGradient(-20, -8, 20, 22)
  capeG.addColorStop(0, '#EEF0E2')
  capeG.addColorStop(0.55, '#D3DAC6')
  capeG.addColorStop(1, '#9BAE92')
  ctx.fillStyle = capeG
  ctx.strokeStyle = '#6C806A'
  ctx.lineWidth = 1.4
  ctx.beginPath()
  ctx.moveTo(-11 * yawSq, -8)
  ctx.lineTo(11 * yawSq, -8)
  ctx.bezierCurveTo(24, 0, 26, 13, 21 + skirtSway * 0.3, 19)
  ctx.quadraticCurveTo(0, 23, -21 + skirtSway * 0.3, 19)
  ctx.bezierCurveTo(-26, 13, -24, 0, -11 * yawSq, -8)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // 领口金色晨露扣 (#BBA654) 与 雾蓝小领饰 (#8CB5D3)
  if (!showBackView) {
    ctx.fillStyle = '#8CB5D3'
    ctx.beginPath()
    ctx.moveTo(yawX * 0.4, -2)
    ctx.lineTo(-6 + yawX * 0.4, 7)
    ctx.lineTo(6 + yawX * 0.4, 7)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#E5C66B'
    ctx.strokeStyle = '#8F762A'
    ctx.lineWidth = 1.0
    ctx.beginPath()
    ctx.arc(yawX * 0.4, -2, 3.2, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()

    // ★ 原版随身「酒红铃铛」直接佩戴在芽露腰间右侧丝带上，随物理弹簧自然摆动！（绝不飘在体外！）
    drawWaistWineBell(
      ctx,
      11.5 * yawSq + yawX * 0.45,
      16.5,
      phys.bellAng,
      isBellPlay || actionState === 'happy' || actionState === 'dance',
      t
    )
  }

  // ============================================================================
  // 4) 灵动双臂 + 右手自然握持「露芽杖」（施法/手写/监工/修补/伸懒腰时执杖，平时收起！）
  // ============================================================================
  const holdStaff = isCast || isStretch
  const armL = isGrab ? -2.2 + Math.sin(t * 20) * 0.45
    : (isStretch ? -2.45
      : (isWalk ? -Math.sin(walkPhase) * 0.46
        : (isDance ? -1.4 + Math.sin(t * 8) * 0.5 : (actionState === 'magic_blackhole' ? -1.8 : 0.24 + breath * 0.05))))
  const armR = isGrab ? 2.2 - Math.sin(t * 20) * 0.45
    : (isStretch ? 2.45
      : (isBellPlay ? 0.55 + Math.sin(t * 18) * 0.22
        : (actionState === 'write_input' ? -0.65 + Math.sin(t * 14) * 0.24
          : (actionState === 'magic_blackhole' ? -2.0 + Math.sin(t * 8) * 0.15
            : (isCast ? -0.95 + Math.sin(t * 4) * 0.14
              : (isWalk ? Math.sin(walkPhase) * 0.46 : -0.24 - breath * 0.05))))))

  // 左臂
  ctx.save()
  ctx.translate(-16 * yawSq, 0)
  ctx.rotate(armL)
  ctx.fillStyle = '#E5DECA'
  ctx.strokeStyle = '#7C8C78'
  ctx.lineWidth = 1.25
  ctx.beginPath()
  ctx.roundRect(-4.2, 0, 8.4, 18, 4.2)
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = '#F2CDC0'
  ctx.beginPath()
  ctx.arc(0, 19.5, 4.0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  // 右臂（执露芽杖之手）
  ctx.save()
  ctx.translate(16 * yawSq, 0)
  ctx.rotate(armR)
  ctx.fillStyle = '#E5DECA'
  ctx.strokeStyle = '#7C8C78'
  ctx.lineWidth = 1.25
  ctx.beginPath()
  ctx.roundRect(-4.2, 0, 8.4, 18, 4.2)
  ctx.fill()
  ctx.stroke()
  // 施法/工作/伸懒腰时，右手真实紧握露芽杖！
  if (holdStaff) {
    ctx.save()
    ctx.translate(1.5, 19)
    ctx.rotate(actionState === 'write_input' ? 0.45 : (actionState === 'magic_blackhole' ? -0.25 : 0.2))
    drawDewSproutStaff(ctx, isCast ? 1.0 : 0.55, t)
    ctx.restore()
  }
  ctx.fillStyle = '#F2CDC0'
  ctx.beginPath()
  ctx.arc(0, 19.5, 4.0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  // ============================================================================
  // 5) 3D 立体头部（圆润奶油桃肌 #F2CDC0 + 紫晶层次刘海 + 嫩芽发饰 + 实时视线追踪五官）
  // ============================================================================
  const headBob = breath * 1.2 + (isSleep ? 5 : 0)
  const headTilt = isPeek ? (facing > 0 ? 0.14 : -0.14) : (isBellPlay ? 0.10 : lookX * 0.08)
  ctx.save()
  ctx.translate(yawX * 0.35, -34 + headBob)
  ctx.rotate(headTilt)

  // 脸颊底型
  const faceG = ctx.createRadialGradient(-7 + yawX * 0.4, -8, 4, 0, 0, 32)
  faceG.addColorStop(0, '#FFF4ED')
  faceG.addColorStop(0.32, '#F6D5C8')
  faceG.addColorStop(0.88, '#F2CDC0')
  faceG.addColorStop(1, '#DDAFA0')
  ctx.fillStyle = faceG
  ctx.strokeStyle = 'rgba(128, 82, 86, 0.45)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(-26 * yawSq, -6)
  ctx.bezierCurveTo(-27 * yawSq, -32, 27 * yawSq, -32, 26 * yawSq, -6)
  ctx.bezierCurveTo(26 * yawSq, 16, 11 * yawSq, 26, yawX * 0.3, 27)
  ctx.bezierCurveTo(-11 * yawSq, 26, -26 * yawSq, 16, -26 * yawSq, -6)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  if (!showBackView) {
    // 紫晶星光双眸（随 3D yaw 透视偏移）
    const eyeSpan = 11.8 * yawSq
    const eyeY = 3.5 + lookY * 1.6
    drawYaluEye(ctx, -eyeSpan + yawX * 0.72, eyeY, 6.8 * yawSq, 7.9, lookX, lookY, blink, actionState, false)
    drawYaluEye(ctx, eyeSpan + yawX * 0.72, eyeY, 6.8 * yawSq, 7.9, lookX, lookY, blink, actionState, true)

    // 玫瑰红晕 (#BB8483)
    ctx.fillStyle = 'rgba(218, 128, 140, 0.42)'
    ctx.beginPath()
    ctx.ellipse(-17.5 * yawSq + yawX * 0.65, 12, 4.8, 2.4, 0, 0, Math.PI * 2)
    ctx.ellipse(17.5 * yawSq + yawX * 0.65, 12, 4.8, 2.4, 0, 0, Math.PI * 2)
    ctx.fill()

    // 精致小嘴（随动作表情自然变化）
    ctx.strokeStyle = '#8F4C54'
    ctx.lineWidth = 1.65
    ctx.lineCap = 'round'
    const mx = yawX * 0.75
    if (actionState === 'grabbed' || actionState === 'thrown') {
      ctx.beginPath()
      ctx.ellipse(mx, 16.5, 3.0, 3.8, 0, 0, Math.PI * 2)
      ctx.stroke()
    } else if (actionState === 'sneak_eat') {
      ctx.fillStyle = '#E8768C'
      ctx.beginPath()
      ctx.ellipse(mx, 16, 4.5, 3 + Math.abs(Math.sin(t * 14)) * 2.5, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    } else if (actionState === 'supervising') {
      ctx.beginPath()
      ctx.moveTo(mx - 3.5, 16.5)
      ctx.lineTo(mx + 3.5, 16.0)
      ctx.stroke()
    } else {
      ctx.beginPath()
      ctx.moveTo(mx - 4.2, 15.5)
      ctx.quadraticCurveTo(mx, 19.2, mx + 4.2, 15.5)
      ctx.stroke()
    }
  }

  // 蓬松紫晶前刘海 & 侧脸鬓角 (#69407A / #865494 / #A271AE)
  const hairG = ctx.createLinearGradient(0, -36, 0, 14)
  hairG.addColorStop(0, '#A878B6')
  hairG.addColorStop(0.38, '#7F4E91')
  hairG.addColorStop(1, '#5A326B')
  ctx.fillStyle = hairG
  ctx.strokeStyle = '#3B1E4C'
  ctx.lineWidth = 1.55

  if (showBackView) {
    // 背面完整紫发覆盖
    ctx.beginPath()
    ctx.arc(0, -4, 30, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  } else {
    ctx.beginPath()
    ctx.moveTo(-29 * yawSq, -2)
    ctx.bezierCurveTo(-33 * yawSq, -34, -10, -37, 0, -37)
    ctx.bezierCurveTo(10, -37, 33 * yawSq, -34, 29 * yawSq, -2)
    // 优雅不规则垂坠鬓角与空气刘海
    ctx.lineTo(24 * yawSq + hs * 0.15, 22)
    ctx.quadraticCurveTo(20 * yawSq, 4, 15 * yawSq + yawX * 0.4, -5)
    ctx.lineTo(9 + yawX * 0.5, 3)
    ctx.quadraticCurveTo(4 + yawX * 0.5, -8, yawX * 0.5, 1)
    ctx.quadraticCurveTo(-4 + yawX * 0.5, -8, -9 + yawX * 0.5, 3)
    ctx.lineTo(-15 * yawSq + yawX * 0.4, -5)
    ctx.quadraticCurveTo(-20 * yawSq, 4, -24 * yawSq + hs * 0.15, 22)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()

    // 紫发丝天使光环高光
    ctx.strokeStyle = 'rgba(242, 220, 255, 0.65)'
    ctx.lineWidth = 2.8
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.arc(yawX * 0.2, -11, 21.5, Math.PI * 1.18, Math.PI * 1.44)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(yawX * 0.2, -11, 21.5, Math.PI * 1.56, Math.PI * 1.82)
    ctx.stroke()
  }

  // 头顶标志性嫩芽小呆毛 / 嫩芽发饰 (#AED7A2 / #D4EDC4)
  ctx.save()
  ctx.translate(yawX * 0.2, -35)
  ctx.rotate(Math.sin(t * 4.2) * 0.12 + hs * 0.015)
  ctx.fillStyle = '#AED7A2'
  ctx.strokeStyle = '#4E7A56'
  ctx.lineWidth = 1.25
  ctx.beginPath()
  ctx.moveTo(0, 2)
  ctx.bezierCurveTo(-9, -4, -10, -14, -2, -14)
  ctx.bezierCurveTo(-1, -7, 0, -3, 0, 2)
  ctx.moveTo(0, 2)
  ctx.bezierCurveTo(9, -3, 12, -12, 4, -14)
  ctx.bezierCurveTo(2, -7, 1, -3, 0, 2)
  ctx.fill()
  ctx.stroke()
  ctx.restore()

  // 情绪浮动微光
  if (actionState === 'pat' || actionState === 'happy') {
    drawSparkle(ctx, -28, -24 - ((t * 18) % 14), 5.5, '#FF8CB4', 0.9)
    drawSparkle(ctx, 26, -18 - (((t * 18) + 7) % 14), 4.5, '#FCDA75', 0.85)
  } else if (actionState === 'sleep') {
    ctx.fillStyle = '#8CB5D3'
    ctx.font = '700 12px sans-serif'
    const dr = (t * 14) % 18
    ctx.globalAlpha = 1 - dr / 20
    ctx.fillText('Z', 24 + dr * 0.2, -22 - dr)
    ctx.font = '700 9px sans-serif'
    ctx.fillText('z', 33 + dr * 0.3, -30 - dr * 0.8)
    ctx.globalAlpha = 1
  } else if (actionState === 'grabbed' || actionState === 'thrown') {
    ctx.fillStyle = '#8CB5D3'
    ctx.beginPath()
    ctx.moveTo(28, -18)
    ctx.quadraticCurveTo(32, -9, 28, -6)
    ctx.quadraticCurveTo(24, -9, 28, -18)
    ctx.fill()
  }

  ctx.restore() // head
  ctx.restore() // body
}

/**
 * R31 芽露（Yalu）活体 3D / 原片逐帧统一舞台（零体外漂浮道具贴纸！）：
 * - `renderMode='yalu_3d'`（默认）：全关节 60fps 3D 骨骼模型，忠实还原芽露原版配色、腰间酒红铃铛与右手执露芽杖；
 * - `renderMode='yalu_film'`：直接播放从 60fps 原版成片提取的 16 帧透明动态精灵带（自然循环 + 3D 视差倾角）；
 * - `viewAngle='front'|'side'|'back'|'video'`：工坊内原版三视图与 60fps 成片高清鉴赏。
 */
export default function YaluModelStage({
  assets = null,
  renderMode = 'yalu_3d',
  actionState = 'idle',
  facing = -1,
  lookX = 0,
  lookY = 0,
  dragTilt = 0,
  auraTheme = 'natural',
  viewAngle = 'auto',
  scale = 1,
  width = 136,
  height = 186,
}) {
  const res = { ...DEFAULT_ASSETS, ...(assets || {}) }
  const canvasRef = useRef(null)
  const physRef = useRef({ yaw: 0, bellAng: 0, bellVel: 0, hairSway: 0, hairVel: 0 })
  const stripsRef = useRef({ idle: null, action: null })
  // 3D 是否已就绪：就绪才撤掉 2D 精灵（兜底），失败则一直保留 2D
  const [ready3d, setReady3d] = useState(false)
  const propsRef = useRef({ renderMode, actionState, facing, lookX, lookY, dragTilt, auraTheme, scale, res })
  propsRef.current = { renderMode, actionState, facing, lookX, lookY, dragTilt, auraTheme, scale, res }

  // 预加载原版 60fps 透明逐帧动画带（供 yalu_film 模式 0 闪烁切换）
  useEffect(() => {
    if (typeof Image === 'undefined') return
    const loadImg = (url, key) => {
      if (!url) return
      const im = new Image()
      im.onload = () => { stripsRef.current[key] = im }
      im.src = url
    }
    loadImg(res.animIdleStrip, 'idle')
    loadImg(res.animActionStrip, 'action')
  }, [res.animIdleStrip, res.animActionStrip])

  useEffect(() => {
    if (viewAngle !== 'auto') return undefined
    const canvas = canvasRef.current
    if (!canvas || typeof requestAnimationFrame !== 'function') return undefined
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined

    let raf = 0
    let stopped = false
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()

    const frame = (now) => {
      if (stopped) return
      if (typeof document !== 'undefined' && document.hidden) {
        raf = requestAnimationFrame(frame)
        return
      }
      const p = propsRef.current
      const t = (now - t0) / 1000
      const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
      const pw = Math.round(width * dpr)
      const ph = Math.round(height * dpr)
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw
        canvas.height = ph
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)

      const activeFilm = p.renderMode === 'yalu_film'
      const isActionStrip = p.actionState === 'run' || p.actionState === 'magic_blackhole' || p.actionState === 'supervising' || p.actionState === 'deliver' || p.actionState === 'dance' || p.actionState === 'stretch'
      const stripImg = activeFilm ? (isActionStrip ? (stripsRef.current.action || stripsRef.current.idle) : stripsRef.current.idle) : null

      if (activeFilm && stripImg && stripImg.naturalWidth > 0) {
        const nFrames = p.res.animFrames || 16
        const cellW = stripImg.naturalWidth / nFrames
        const cellH = stripImg.naturalHeight
        // 平滑往返 ping-pong 播放（零跳帧！）
        const cycle = (t * (isActionStrip ? 11 : 7.5)) % (nFrames * 2 - 2)
        const idx = cycle < nFrames ? Math.floor(cycle) : Math.floor((nFrames * 2 - 2) - cycle)
        const sc = Math.min((width - 8) / cellW, (height - 8) / cellH) * clamp(p.scale || 1, 0.75, 1.35)
        const dw = cellW * sc
        const dh = cellH * sc
        const flip = p.facing > 0 ? -1 : 1
        const tilt = clamp(p.dragTilt * 0.7, -0.4, 0.4) + (p.actionState === 'run' ? Math.sin(t * 11) * 0.04 : 0)
        const hop = p.actionState === 'run' ? -Math.abs(Math.sin(t * 11)) * 6 : 0

        ctx.save()
        ctx.translate(width / 2 + clamp(p.lookX * 3, -3, 3), height - 4 + hop)
        ctx.rotate(tilt)
        ctx.scale(flip, 1)
        ctx.drawImage(stripImg, idx * cellW, 0, cellW, cellH, -dw / 2, -dh, dw, dh)
        ctx.restore()
      } else {
        drawYalu3DSkeleton(ctx, {
          t,
          w: width,
          h: height,
          actionState: p.actionState,
          facing: p.facing,
          lookX: p.lookX,
          lookY: p.lookY,
          dragTilt: p.dragTilt,
          auraTheme: p.auraTheme,
          scale: p.scale,
          phys: physRef.current,
        })
      }

      raf = requestAnimationFrame(frame)
    }

    raf = requestAnimationFrame(frame)
    return () => {
      stopped = true
      if (raf) cancelAnimationFrame(raf)
    }
  }, [viewAngle, width, height])

  if (viewAngle === 'video') {
    return (
      <div className="yms-stage" style={{ width, height, pointerEvents: 'auto' }} data-yalu-stage="video">
        <video className="yms-video" src={res.showcaseVideo} autoPlay loop muted playsInline controls />
      </div>
    )
  }

  if (viewAngle === 'front' || viewAngle === 'side' || viewAngle === 'back') {
    const src = viewAngle === 'side' ? res.side : (viewAngle === 'back' ? res.back : res.front)
    return (
      <div className="yms-stage" style={{ width, height }} data-yalu-stage={viewAngle}>
        <img className="yms-ref-img" src={src} alt={`芽露 ${viewAngle}`} draggable={false} />
      </div>
    )
  }

  // 真三维路径：模型来自用户设计稿（已减面到 ~3.3 万面 / 贴图 1024 / 合计 14MB）。
  // 注意 e2e 断言 `[data-yalu-stage="yalu_3d"] canvas.yms-canvas` 恰好 1 个，
  // 所以两条路径互斥，且三维 canvas 也复用 yms-canvas 类名。
  const want3d = renderMode === 'yalu_3d'

  return (
    <div className="yms-stage" style={{ width, height }} data-yalu-stage={renderMode}>
      {/* 2D 精灵是兜底：3D 未就绪/失败时它就是主角，绝不让舞台空着 */}
      {!ready3d && <canvas ref={canvasRef} className="yms-canvas" aria-hidden="true" />}
      {want3d && (
        <YaluModel3D
          actionState={actionState}
          facing={facing}
          viewAngle="auto"
          lookX={lookX}
          lookY={lookY}
          dragTilt={dragTilt}
          width={width}
          height={height}
          scale={scale}
          onReady={(ok) => setReady3d(Boolean(ok))}
        />
      )}
    </div>
  )
}
