import { useEffect, useRef } from 'react'

const HAIR_PALETTES = {
  ocean:    { base: '#4B8BF5', shade: '#214CA8', light: '#A8D4FF', deep: '#17367A' },
  sky:      { base: '#6BC6FA', shade: '#2D7EC4', light: '#D2F1FF', deep: '#1D5994' },
  sakura:   { base: '#F7A1C4', shade: '#C55989', light: '#FFE0EE', deep: '#913862' },
  silver:   { base: '#DCE6F5', shade: '#92A4C2', light: '#FFFFFF', deep: '#647594' },
  honey:    { base: '#F8D072', shade: '#C48A2A', light: '#FFF4CC', deep: '#8F6118' },
  obsidian: { base: '#323C52', shade: '#161C29', light: '#7A8CB0', deep: '#0C101A' },
  mint:     { base: '#6FE5C6', shade: '#299E83', light: '#D4FFF3', deep: '#1A6E5A' },
  lilac:    { base: '#BD9FFA', shade: '#7456C6', light: '#ECE2FF', deep: '#4E378F' },
  coral:    { base: '#F49772', shade: '#C45B38', light: '#FFD8C7', deep: '#8F3C22' },
}

const EYE_PALETTES = {
  sapphire: { top: '#13377A', mid: '#257BE8', bot: '#7ED4FF' },
  cyan:     { top: '#0D5263', mid: '#14B8C4', bot: '#9CF9FF' },
  amber:    { top: '#733B08', mid: '#E69A28', bot: '#FFE89E' },
  rose:     { top: '#75183F', mid: '#E85C8B', bot: '#FFC7DC' },
  emerald:  { top: '#0E5238', mid: '#22A874', bot: '#9CF6D4' },
  violet:   { top: '#3B1D80', mid: '#8A5CF6', bot: '#DAC9FF' },
  crimson:  { top: '#6E1318', mid: '#DF4545', bot: '#FFBCBC' },
  hetero:   { top: '#13377A', mid: '#257BE8', bot: '#7ED4FF', rTop: '#733B08', rMid: '#F09826', rBot: '#FFE594' },
}

const OUTFIT_PALETTES = {
  maid:   { primary: '#263352', shade: '#172036', accent: '#FFFFFF', trim: '#60BDF8', ribbon: '#F26B8A' },
  sailor: { primary: '#2D62C9', shade: '#1C4191', accent: '#FFFFFF', trim: '#7CC6FF', ribbon: '#F26450' },
  cyber:  { primary: '#1E273B', shade: '#111724', accent: '#38BDF8', trim: '#A78BFA', ribbon: '#38BDF8' },
  mage:   { primary: '#563DB8', shade: '#35227A', accent: '#F8D064', trim: '#C4B5FD', ribbon: '#F8D064' },
  pajama: { primary: '#78C5F5', shade: '#4794CC', accent: '#FFFDF7', trim: '#F79EC2', ribbon: '#F79EC2' },
  hanfu:  { primary: '#E86E58', shade: '#B54534', accent: '#FFF4E8', trim: '#F6C860', ribbon: '#F6C860' },
}

const SKIN_PALETTES = {
  porcelain: { base: '#FFF2E8', shade: '#F2CCBC', blush: 'rgba(255,132,158,0.44)' },
  peach:     { base: '#FFE5D2', shade: '#E8B59B', blush: 'rgba(250,126,142,0.48)' },
  warm:      { base: '#F8D6BC', shade: '#D9A786', blush: 'rgba(240,120,126,0.42)' },
  cool:      { base: '#FCF6F9', shade: '#DFCED9', blush: 'rgba(255,140,172,0.40)' },
}

function drawSparkle(ctx, x, y, r, color = '#FFF5B8', alpha = 1) {
  ctx.save()
  ctx.translate(x, y)
  ctx.globalAlpha = alpha
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

function drawHeart(ctx, x, y, s, color = '#FF6E97', alpha = 1) {
  ctx.save()
  ctx.translate(x, y)
  ctx.globalAlpha = alpha
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(0, s * 0.35)
  ctx.bezierCurveTo(-s * 0.9, -s * 0.3, -s * 0.5, -s * 0.95, 0, -s * 0.35)
  ctx.bezierCurveTo(s * 0.5, -s * 0.95, s * 0.9, -s * 0.3, 0, s * 0.35)
  ctx.fill()
  ctx.restore()
}

/** 精致日系宝石渐变二次元大眼（含睫毛、虹膜环、双高光、情绪表情变化） */
function drawAnimeEye(ctx, cx, cy, rx, ry, pal, eyeStyle, lookX, lookY, blink, expr, isRight = false) {
  ctx.save()
  ctx.translate(cx, cy)

  // 情绪闭眼 / 晕眩 / 笑眼
  if (expr === 'grabbed' || expr === 'thrown') {
    ctx.strokeStyle = '#252B3B'
    ctx.lineWidth = 2.6
    ctx.lineCap = 'round'
    ctx.beginPath()
    if (!isRight) {
      ctx.moveTo(-rx * 0.72, -ry * 0.45)
      ctx.lineTo(rx * 0.55, 0)
      ctx.lineTo(-rx * 0.72, ry * 0.45)
    } else {
      ctx.moveTo(rx * 0.72, -ry * 0.45)
      ctx.lineTo(-rx * 0.55, 0)
      ctx.lineTo(rx * 0.72, ry * 0.45)
    }
    ctx.stroke()
    ctx.restore()
    return
  }

  if (expr === 'sleep') {
    ctx.strokeStyle = '#333C52'
    ctx.lineWidth = 2.4
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.arc(0, -ry * 0.1, rx * 0.75, Math.PI * 0.15, Math.PI * 0.85)
    ctx.stroke()
    ctx.restore()
    return
  }

  if (expr === 'pat' || expr === 'happy' || expr === 'deliver' || expr === 'dance') {
    ctx.strokeStyle = '#262C3D'
    ctx.lineWidth = 2.7
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.arc(0, ry * 0.22, rx * 0.78, Math.PI * 1.12, Math.PI * 1.88)
    ctx.stroke()
    ctx.restore()
    return
  }

  if (blink > 0.86) {
    ctx.strokeStyle = '#262C3D'
    ctx.lineWidth = 2.4
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(-rx * 0.85, 0)
    ctx.quadraticCurveTo(0, ry * 0.35, rx * 0.85, 0)
    ctx.stroke()
    ctx.restore()
    return
  }

  // 眼白底（带顶部微阴影）
  const whiteG = ctx.createLinearGradient(0, -ry, 0, ry)
  whiteG.addColorStop(0, '#E4ECFA')
  whiteG.addColorStop(0.32, '#FFFFFF')
  whiteG.addColorStop(1, '#FFFFFF')
  ctx.fillStyle = whiteG
  ctx.beginPath()
  ctx.ellipse(0, 0, rx, ry * (eyeStyle === 'gentle' || eyeStyle === 'cool' ? 0.84 : 1.0), 0, 0, Math.PI * 2)
  ctx.fill()

  // 宝石渐变虹膜
  const ix = lookX * rx * 0.24
  const iy = lookY * ry * 0.20
  const irx = rx * 0.76
  const iry = ry * 0.84
  const topC = isRight && pal.rTop ? pal.rTop : pal.top
  const midC = isRight && pal.rMid ? pal.rMid : pal.mid
  const botC = isRight && pal.rBot ? pal.rBot : pal.bot

  const irisG = ctx.createLinearGradient(ix, iy - iry, ix, iy + iry)
  irisG.addColorStop(0, topC)
  irisG.addColorStop(0.54, midC)
  irisG.addColorStop(1, botC)
  ctx.fillStyle = irisG
  ctx.beginPath()
  ctx.ellipse(ix, iy + 0.5, irx, iry, 0, 0, Math.PI * 2)
  ctx.fill()

  // 底部反光月牙
  ctx.fillStyle = 'rgba(255,255,255,0.42)'
  ctx.beginPath()
  ctx.ellipse(ix, iy + iry * 0.52, irx * 0.62, iry * 0.24, 0, 0, Math.PI * 2)
  ctx.fill()

  // 瞳孔
  ctx.fillStyle = '#141928'
  ctx.beginPath()
  if (eyeStyle === 'cat') {
    ctx.ellipse(ix, iy + 0.5, irx * 0.28, iry * 0.62, 0, 0, Math.PI * 2)
  } else {
    ctx.ellipse(ix, iy + 0.5, irx * 0.42, iry * 0.46, 0, 0, Math.PI * 2)
  }
  ctx.fill()

  // 主高光 + 次高光 + 星光/爱心微光
  ctx.fillStyle = '#FFFFFF'
  ctx.beginPath()
  ctx.ellipse(ix - irx * 0.34, iy - iry * 0.36, irx * 0.32, iry * 0.26, -0.35, 0, Math.PI * 2)
  ctx.fill()
  ctx.beginPath()
  ctx.arc(ix + irx * 0.34, iy + iry * 0.26, irx * 0.15, 0, Math.PI * 2)
  ctx.fill()
  if (eyeStyle === 'star') drawSparkle(ctx, ix + irx * 0.28, iy - iry * 0.26, irx * 0.32, '#FFF9D6', 0.95)
  if (eyeStyle === 'heart') drawHeart(ctx, ix, iy + iry * 0.35, irx * 0.38, '#FFFFFF', 0.85)

  // 精细弯曲上睫毛（灵动二次元轮廓）
  ctx.strokeStyle = '#1E2434'
  ctx.lineWidth = Math.max(2.2, rx * 0.24)
  ctx.lineCap = 'round'
  ctx.beginPath()
  const lashLift = eyeStyle === 'cool' ? -ry * 0.12 : 0
  ctx.moveTo(-rx * 1.06, -ry * 0.12 + lashLift)
  ctx.quadraticCurveTo(0, -ry * 1.24, rx * 1.06, -ry * 0.12 - lashLift)
  ctx.stroke()

  // 眼尾俏皮小翘睫
  ctx.lineWidth = 1.6
  ctx.beginPath()
  const side = isRight ? 1 : -1
  ctx.moveTo(side * rx * 0.96, -ry * 0.2)
  ctx.lineTo(side * rx * 1.18, -ry * 0.48)
  ctx.stroke()

  ctx.restore()
}

/** 精致头饰（大肥鱼喷水柱 / 皇冠 / 水手贝雷帽 / 猫耳 / 兔耳 / 蝴蝶结 / 光环 / 耳机） */
function drawHeadgear(ctx, headgear, x, y, scale, t, hairPal) {
  if (!headgear || headgear === 'none') return
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(scale, scale)

  if (headgear === 'whale_spout') {
    // 大肥鱼标志性灵动小喷水柱！
    const pulse = Math.sin(t * 5.2)
    ctx.strokeStyle = 'rgba(135, 218, 255, 0.92)'
    ctx.lineWidth = 3.2
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(0, 2)
    ctx.quadraticCurveTo(-4, -14 - pulse * 2, -14, -18 - pulse * 3)
    ctx.moveTo(0, 2)
    ctx.quadraticCurveTo(4, -14 - pulse * 2, 14, -18 - pulse * 3)
    ctx.stroke()
    ctx.fillStyle = '#E0F7FF'
    ctx.beginPath()
    ctx.arc(-16, -15 + pulse * 2.5, 3.0, 0, Math.PI * 2)
    ctx.arc(16, -15 - pulse * 2.5, 3.0, 0, Math.PI * 2)
    ctx.arc(0, -21 - pulse * 2, 2.4, 0, Math.PI * 2)
    ctx.fill()
  } else if (headgear === 'crown') {
    const g = ctx.createLinearGradient(0, -18, 0, 2)
    g.addColorStop(0, '#FFF09E')
    g.addColorStop(0.6, '#F5B83D')
    g.addColorStop(1, '#C98316')
    ctx.fillStyle = g
    ctx.strokeStyle = '#9C620C'
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.moveTo(-15, 2)
    ctx.lineTo(-17, -13)
    ctx.lineTo(-6, -5)
    ctx.lineTo(0, -17)
    ctx.lineTo(6, -5)
    ctx.lineTo(17, -13)
    ctx.lineTo(15, 2)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#56C2FF'
    ctx.beginPath()
    ctx.arc(0, -4, 3.0, 0, Math.PI * 2)
    ctx.fill()
  } else if (headgear === 'sailor_hat') {
    ctx.rotate(-0.12)
    ctx.fillStyle = '#FFFFFF'
    ctx.strokeStyle = '#3B6FD8'
    ctx.lineWidth = 1.8
    ctx.beginPath()
    ctx.ellipse(0, -5, 22, 10, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#2B5EC4'
    ctx.fillRect(-16, -3, 32, 6)
    ctx.fillStyle = '#F7C948'
    ctx.beginPath()
    ctx.arc(0, -14, 3.6, 0, Math.PI * 2)
    ctx.fill()
  } else if (headgear === 'cat_ears') {
    for (const s of [-1, 1]) {
      ctx.save()
      ctx.translate(s * 24, 10)
      ctx.rotate(s * 0.24)
      ctx.fillStyle = hairPal.base
      ctx.strokeStyle = hairPal.deep
      ctx.lineWidth = 1.6
      ctx.beginPath()
      ctx.moveTo(-11, 6)
      ctx.quadraticCurveTo(-2, -18, 0, -18)
      ctx.quadraticCurveTo(6, -12, 11, 6)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = '#FFB6CC'
      ctx.beginPath()
      ctx.moveTo(-6, 4)
      ctx.lineTo(0, -10)
      ctx.lineTo(6, 4)
      ctx.closePath()
      ctx.fill()
      ctx.restore()
    }
  } else if (headgear === 'bunny_ears') {
    for (const s of [-1, 1]) {
      const flop = Math.sin(t * 3 + s) * 0.08
      ctx.save()
      ctx.translate(s * 18, 4)
      ctx.rotate(s * (0.28 + flop))
      ctx.fillStyle = '#FFF9FC'
      ctx.strokeStyle = '#E0BCCB'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.ellipse(0, -18, 7.5, 20, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = '#FFB6CC'
      ctx.beginPath()
      ctx.ellipse(0, -16, 3.8, 13, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
  } else if (headgear === 'ribbon') {
    ctx.fillStyle = '#F26B8A'
    ctx.strokeStyle = '#B8395B'
    ctx.lineWidth = 1.4
    for (const s of [-1, 1]) {
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.bezierCurveTo(s * 18, -14, s * 26, 6, s * 14, 10)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
    }
    ctx.fillStyle = '#FFD1DF'
    ctx.beginPath()
    ctx.arc(0, 1, 5.2, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  } else if (headgear === 'halo') {
    const hover = Math.sin(t * 3.5) * 2.5
    ctx.strokeStyle = '#FFE066'
    ctx.lineWidth = 3.2
    ctx.shadowColor = 'rgba(255, 224, 102, 0.85)'
    ctx.shadowBlur = 10
    ctx.beginPath()
    ctx.ellipse(0, -16 + hover, 22, 5.8, 0, 0, Math.PI * 2)
    ctx.stroke()
    ctx.shadowBlur = 0
  } else if (headgear === 'headphones') {
    ctx.strokeStyle = '#252E42'
    ctx.lineWidth = 4.5
    ctx.beginPath()
    ctx.arc(0, 26, 34, Math.PI * 1.12, Math.PI * 1.88)
    ctx.stroke()
    for (const s of [-1, 1]) {
      ctx.fillStyle = '#252E42'
      ctx.beginPath()
      ctx.roundRect(s * 30 - 5, 16, 10, 18, 5)
      ctx.fill()
      ctx.fillStyle = '#38BDF8'
      ctx.beginPath()
      ctx.arc(s * 30, 25, 3.2, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.restore()
}

/** 形态 1：大肥鱼·胖鲸鱼本尊（高光瓷感 Q 弹胖鲸鱼 + 尾鳍拍打 + 喷水 + 拟人表情！） */
function drawDaFeiYuWhale(ctx, { t, avatar, hairPal, eyePal, actionState, lookX, lookY, blink, dragTilt }) {
  const isGrabbed = actionState === 'grabbed' || actionState === 'thrown'
  const isRun = actionState === 'run' || actionState === 'collect_shards'
  const isSleep = actionState === 'sleep'
  const isEating = actionState === 'eat_snack' || actionState === 'sneak_eat'
  const isDance = actionState === 'dance'
  const isSupervising = actionState === 'supervising'

  const bob = isGrabbed ? 0 : (isSleep ? Math.sin(t * 1.8) * 1.5 : Math.sin(t * (isRun ? 11 : 3.2)) * (isRun ? 4.5 : 3.2))
  const squashX = isGrabbed ? 0.88 : (actionState === 'bounce' ? 1.14 : (actionState === 'poke' ? 1.10 + Math.sin(t * 20) * 0.05 : 1 + Math.sin(t * 3.2) * 0.025))
  const squashY = isGrabbed ? 1.16 : (actionState === 'bounce' ? 0.86 : (actionState === 'poke' ? 0.90 - Math.sin(t * 20) * 0.05 : 1 - Math.sin(t * 3.2) * 0.025))
  const tilt = isGrabbed
    ? Math.max(-0.45, Math.min(0.45, dragTilt)) + Math.sin(t * 16) * 0.06
    : (isDance ? Math.sin(t * 10) * 0.22 : (isRun ? Math.sin(t * 11) * 0.08 : Math.sin(t * 2.1) * 0.03))

  // 柔和地面投影
  if (!isGrabbed) {
    ctx.fillStyle = 'rgba(20, 42, 84, 0.14)'
    ctx.beginPath()
    ctx.ellipse(0, 46, 36 - bob * 0.6, 8.5, 0, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.save()
  ctx.translate(0, 6 + bob)
  ctx.rotate(tilt)
  ctx.scale(squashX, squashY)

  // 1) 后方摇摆大鲸尾（被拎起或奔跑时疯狂扑腾！）
  const tailWag = Math.sin(t * (isGrabbed ? 22 : (isRun ? 14 : 4.2))) * (isGrabbed ? 0.42 : 0.22)
  ctx.save()
  ctx.translate(32, 6)
  ctx.rotate(tailWag)
  const tailG = ctx.createLinearGradient(0, -18, 22, 18)
  tailG.addColorStop(0, hairPal.base)
  tailG.addColorStop(1, hairPal.shade)
  ctx.fillStyle = tailG
  ctx.strokeStyle = hairPal.deep
  ctx.lineWidth = 1.8
  ctx.beginPath()
  ctx.moveTo(-4, 0)
  ctx.bezierCurveTo(10, -6, 16, -24, 28, -22)
  ctx.bezierCurveTo(22, -6, 18, 0, 14, 2)
  ctx.bezierCurveTo(20, 6, 26, 20, 16, 24)
  ctx.bezierCurveTo(6, 18, 2, 10, -4, 6)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.restore()

  // 2) 圆滚滚高光瓷感胖鲸鱼主体
  const bodyG = ctx.createRadialGradient(-16, -22, 6, 0, 2, 54)
  bodyG.addColorStop(0, hairPal.light)
  bodyG.addColorStop(0.38, hairPal.base)
  bodyG.addColorStop(0.86, hairPal.shade)
  bodyG.addColorStop(1, hairPal.deep)
  ctx.fillStyle = bodyG
  ctx.strokeStyle = hairPal.deep
  ctx.lineWidth = 2.0
  ctx.beginPath()
  ctx.moveTo(-42, 6)
  ctx.bezierCurveTo(-44, -32, -12, -40, 12, -34)
  ctx.bezierCurveTo(36, -28, 44, -6, 38, 16)
  ctx.bezierCurveTo(30, 36, -28, 38, -42, 16)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // 3) 软萌奶油白大肚皮（经典大肥鱼腹纹！）
  const bellyG = ctx.createLinearGradient(0, 6, 0, 36)
  bellyG.addColorStop(0, '#FFFFFF')
  bellyG.addColorStop(1, '#E6F0FC')
  ctx.fillStyle = bellyG
  ctx.beginPath()
  ctx.moveTo(-39, 12)
  ctx.bezierCurveTo(-18, 4, 16, 6, 35, 16)
  ctx.bezierCurveTo(26, 34, -24, 36, -39, 15)
  ctx.closePath()
  ctx.fill()
  // 肚皮细微条纹
  ctx.strokeStyle = 'rgba(75, 139, 245, 0.22)'
  ctx.lineWidth = 1.4
  for (let i = -20; i <= 16; i += 9) {
    ctx.beginPath()
    ctx.moveTo(i, 16)
    ctx.quadraticCurveTo(i + 2, 24, i + 4, 30)
    ctx.stroke()
  }

  // 4) 液态瓷感顶部高光带（让胖鲸鱼晶莹圆润，绝不扁平！）
  ctx.fillStyle = 'rgba(255, 255, 255, 0.56)'
  ctx.beginPath()
  ctx.ellipse(-10, -24, 18, 6.5, -0.22, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = 'rgba(255, 255, 255, 0.82)'
  ctx.beginPath()
  ctx.ellipse(-22, -18, 5, 2.8, -0.5, 0, Math.PI * 2)
  ctx.fill()

  // 5) 两侧会拍打的呆萌小胸鳍
  const finFlap = Math.sin(t * (isGrabbed ? 24 : (isRun ? 13 : 3.8))) * (isGrabbed ? 0.55 : 0.24)
  for (const s of [-1, 1]) {
    ctx.save()
    ctx.translate(s === -1 ? -34 : 18, 16)
    ctx.rotate(s * (0.35 + finFlap))
    ctx.fillStyle = hairPal.base
    ctx.strokeStyle = hairPal.deep
    ctx.lineWidth = 1.6
    ctx.beginPath()
    ctx.ellipse(s * 6, 4, 12, 6.5, s * 0.25, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.restore()
  }

  // 6) 超大水汪汪星光二次元大眼 + 红晕腮红 + 呆萌嘴巴
  const eyeY = -2
  drawAnimeEye(ctx, -20, eyeY, 8.8, 9.8, eyePal, avatar.eyeStyle, lookX, lookY, blink, actionState, false)
  drawAnimeEye(ctx, 4, eyeY, 8.8, 9.8, eyePal, avatar.eyeStyle, lookX, lookY, blink, actionState, true)

  // 软萌腮红
  ctx.fillStyle = 'rgba(255, 122, 156, 0.45)'
  ctx.beginPath()
  ctx.ellipse(-30, 8, 6.2, 3.4, 0, 0, Math.PI * 2)
  ctx.ellipse(14, 8, 6.2, 3.4, 0, 0, Math.PI * 2)
  ctx.fill()

  // 表情嘴巴
  ctx.strokeStyle = '#25314D'
  ctx.lineWidth = 2.0
  ctx.lineCap = 'round'
  if (isEating) {
    const chomp = 4 + Math.abs(Math.sin(t * 14)) * 5.5
    ctx.fillStyle = '#FF7E98'
    ctx.beginPath()
    ctx.ellipse(-8, 10, 6.5, chomp, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  } else if (isGrabbed) {
    ctx.beginPath()
    ctx.moveTo(-13, 12)
    ctx.quadraticCurveTo(-8, 6, -3, 12)
    ctx.stroke()
  } else if (actionState === 'guilty') {
    ctx.beginPath()
    ctx.moveTo(-13, 10)
    ctx.quadraticCurveTo(-10, 13, -8, 10)
    ctx.quadraticCurveTo(-6, 13, -3, 10)
    ctx.stroke()
  } else {
    // 经典大肥鱼「ω」呆萌小嘴
    ctx.beginPath()
    ctx.moveTo(-14, 9)
    ctx.quadraticCurveTo(-11, 13.5, -8, 9.5)
    ctx.quadraticCurveTo(-5, 13.5, -2, 9)
    ctx.stroke()
  }

  // 监工圆眼镜（监工/配饰开启时）
  if (isSupervising || avatar.accessory === 'glasses') {
    ctx.strokeStyle = isSupervising ? '#F59E0B' : '#334155'
    ctx.lineWidth = 1.9
    ctx.beginPath()
    ctx.arc(-20, eyeY, 11.2, 0, Math.PI * 2)
    ctx.moveTo(-9, eyeY)
    ctx.lineTo(-7, eyeY)
    ctx.arc(4, eyeY, 11.2, 0, Math.PI * 2)
    ctx.stroke()
  }

  // 手写发光笔 / 小鱼干零食 / 魔法棒
  if (actionState === 'write_input' || avatar.accessory === 'stylus') {
    ctx.save()
    ctx.translate(-34, 14)
    ctx.rotate(actionState === 'write_input' ? -0.6 + Math.sin(t * 16) * 0.25 : -0.35)
    ctx.fillStyle = '#F59E0B'
    ctx.fillRect(-3, -18, 5, 22)
    ctx.fillStyle = '#38BDF8'
    ctx.beginPath()
    ctx.moveTo(-3, 4)
    ctx.lineTo(2, 4)
    ctx.lineTo(-0.5, 10)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  } else if (actionState === 'eat_snack') {
    ctx.fillStyle = '#F5A642'
    ctx.beginPath()
    ctx.ellipse(-8, 12, 7, 3.8, 0.2, 0, Math.PI * 2)
    ctx.fill()
  }

  // 头饰（默认喷水小浪花）
  drawHeadgear(ctx, avatar.headgear || 'whale_spout', -6, -34, 0.92, t, hairPal)

  ctx.restore()
}

/** 形态 2 & 3：大肥鱼·鲸鱼娘 & 星见二次元萌娘（精致 2.2 头身粘土人赛璐璐立体建模！） */
function drawAnimeChibi(ctx, { t, avatar, hairPal, eyePal, outfitPal, skinPal, actionState, lookX, lookY, blink, dragTilt, isWhaleGirl }) {
  const isGrabbed = actionState === 'grabbed' || actionState === 'thrown'
  const isRun = actionState === 'run' || actionState === 'collect_shards'
  const isSleep = actionState === 'sleep'
  const isEating = actionState === 'eat_snack' || actionState === 'sneak_eat'
  const isDance = actionState === 'dance'
  const isCrouch = actionState === 'crouch_click' || actionState === 'repair_glass'
  const isSupervising = actionState === 'supervising'

  const bob = isGrabbed ? 0 : (isCrouch ? 8 : Math.sin(t * (isRun ? 13 : 3.1)) * (isRun ? 3.5 : 2.2))
  const tilt = isGrabbed
    ? Math.max(-0.42, Math.min(0.42, dragTilt)) + Math.sin(t * 14) * 0.05
    : (isDance ? Math.sin(t * 9) * 0.16 : (isRun ? 0.06 : Math.sin(t * 2) * 0.02))
  const sx = isGrabbed ? 0.92 : (actionState === 'bounce' ? 1.12 : 1)
  const sy = isGrabbed ? 1.09 : (actionState === 'bounce' ? 0.89 : 1)

  // 柔和地面阴影
  if (!isGrabbed) {
    ctx.fillStyle = 'rgba(20, 32, 62, 0.14)'
    ctx.beginPath()
    ctx.ellipse(0, 56, 26, 6.5, 0, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.save()
  ctx.translate(0, bob)
  ctx.rotate(tilt)
  ctx.scale(sx, sy)

  // 0) 背后漂浮大鲸鱼尾（鲸鱼娘专属标志！）或小精灵翼
  if (isWhaleGirl || avatar.accessory === 'ribbon_tail') {
    const wag = Math.sin(t * (isGrabbed ? 20 : 4.2)) * 0.25
    ctx.save()
    ctx.translate(16, 30)
    ctx.rotate(wag)
    const tg = ctx.createLinearGradient(0, -14, 24, 14)
    tg.addColorStop(0, hairPal.light)
    tg.addColorStop(0.5, hairPal.base)
    tg.addColorStop(1, hairPal.shade)
    ctx.fillStyle = tg
    ctx.strokeStyle = hairPal.deep
    ctx.lineWidth = 1.6
    ctx.beginPath()
    ctx.moveTo(-4, 0)
    ctx.bezierCurveTo(10, -4, 16, -20, 26, -18)
    ctx.bezierCurveTo(20, -4, 16, 2, 13, 4)
    ctx.bezierCurveTo(20, 8, 22, 20, 12, 21)
    ctx.bezierCurveTo(4, 14, 0, 8, -4, 4)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    ctx.restore()
  } else if (avatar.accessory === 'wings') {
    const flap = Math.sin(t * 8) * 0.18
    for (const s of [-1, 1]) {
      ctx.save()
      ctx.translate(s * 14, 22)
      ctx.rotate(s * (0.25 + flap))
      ctx.fillStyle = 'rgba(220, 244, 255, 0.68)'
      ctx.strokeStyle = 'rgba(130, 204, 255, 0.85)'
      ctx.lineWidth = 1.3
      ctx.beginPath()
      ctx.ellipse(s * 14, -4, 16, 9, s * -0.25, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      ctx.restore()
    }
  }

  // 1) 后发体积层（随动作柔和摆动）
  const hairSway = Math.sin(t * 3.4) * 2.5 + (isGrabbed ? -dragTilt * 16 : 0)
  const hs = avatar.hairStyle || 'long'
  const backHairG = ctx.createLinearGradient(0, -44, 0, 38)
  backHairG.addColorStop(0, hairPal.base)
  backHairG.addColorStop(0.65, hairPal.shade)
  backHairG.addColorStop(1, hairPal.deep)
  ctx.fillStyle = backHairG
  ctx.strokeStyle = hairPal.deep
  ctx.lineWidth = 1.7

  if (hs === 'twintails' || hs === 'drill') {
    for (const s of [-1, 1]) {
      ctx.save()
      ctx.translate(s * 28, -16)
      ctx.rotate(s * (0.14 + Math.sin(t * 4.5 + s) * 0.08) + (isGrabbed ? -dragTilt * 0.4 : 0))
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.bezierCurveTo(s * 18, 6, s * 22, 34, s * 10, 48)
      ctx.bezierCurveTo(s * 2, 42, -s * 2, 24, -s * 4, 8)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      // 蝴蝶结发圈
      ctx.fillStyle = outfitPal.ribbon
      ctx.beginPath()
      ctx.arc(s * 2, 2, 4.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = backHairG
      ctx.restore()
    }
  } else if (hs === 'buns') {
    for (const s of [-1, 1]) {
      ctx.beginPath()
      ctx.arc(s * 28, -28, 12.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
  } else if (hs === 'long' || hs === 'hime') {
    ctx.beginPath()
    ctx.moveTo(-32, -16)
    ctx.bezierCurveTo(-38, 10, -34 + hairSway * 0.4, 38, -20 + hairSway, 46)
    ctx.quadraticCurveTo(hairSway * 0.6, 40, 20 + hairSway, 46)
    ctx.bezierCurveTo(34 + hairSway * 0.4, 38, 38, 10, 32, -16)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
  } else if (hs === 'sidetail') {
    ctx.beginPath()
    ctx.moveTo(24, -18)
    ctx.bezierCurveTo(44, -4, 46 + hairSway, 28, 30 + hairSway, 44)
    ctx.bezierCurveTo(20, 32, 20, 12, 18, -8)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
  }

  // 2) Q 版精致身躯与服装（含小腿、裙摆褶皱、领结与双手动画）
  const legSwing = isGrabbed ? Math.sin(t * 24) * 0.48 : (isRun ? Math.sin(t * 14) * 0.36 : 0)
  for (const s of [-1, 1]) {
    ctx.save()
    ctx.translate(s * 7.5, 38)
    ctx.rotate(s * legSwing)
    ctx.fillStyle = skinPal.base
    ctx.beginPath()
    ctx.roundRect(-4.2, 0, 8.4, 11, 4)
    ctx.fill()
    // 过膝白袜 + 玛丽珍小皮鞋
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(-4.2, 5, 8.4, 6)
    ctx.fillStyle = outfitPal.primary
    ctx.strokeStyle = outfitPal.shade
    ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.roundRect(-5, 10, 10, 6.5, 3.2)
    ctx.fill()
    ctx.stroke()
    ctx.restore()
  }

  // 立体连衣裙/水手服/女仆装躯干
  const dressG = ctx.createLinearGradient(-16, 12, 16, 44)
  dressG.addColorStop(0, outfitPal.primary)
  dressG.addColorStop(1, outfitPal.shade)
  ctx.fillStyle = dressG
  ctx.strokeStyle = outfitPal.shade
  ctx.lineWidth = 1.6
  ctx.beginPath()
  ctx.moveTo(-11, 13)
  ctx.lineTo(11, 13)
  ctx.bezierCurveTo(18, 24, 24, 34, 22, 42)
  ctx.quadraticCurveTo(0, 46, -22, 42)
  ctx.bezierCurveTo(-24, 34, -18, 24, -11, 13)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // 白色围裙 / 水手领片 + 胸口蝴蝶结
  ctx.fillStyle = outfitPal.accent
  if (avatar.outfit === 'maid') {
    ctx.beginPath()
    ctx.moveTo(-8, 16)
    ctx.lineTo(8, 16)
    ctx.lineTo(13, 41)
    ctx.quadraticCurveTo(0, 44, -13, 41)
    ctx.closePath()
    ctx.fill()
  } else {
    ctx.beginPath()
    ctx.moveTo(-12, 13)
    ctx.lineTo(0, 24)
    ctx.lineTo(12, 13)
    ctx.closePath()
    ctx.fill()
  }
  ctx.fillStyle = outfitPal.ribbon
  ctx.beginPath()
  ctx.moveTo(0, 21)
  ctx.lineTo(-7, 17)
  ctx.lineTo(-7, 25)
  ctx.closePath()
  ctx.moveTo(0, 21)
  ctx.lineTo(7, 17)
  ctx.lineTo(7, 25)
  ctx.closePath()
  ctx.fill()
  ctx.beginPath()
  ctx.arc(0, 21, 2.8, 0, Math.PI * 2)
  ctx.fill()

  // 灵动小手臂（拎起乱挥 / 手写 / 施法）
  const armWave = isGrabbed ? Math.sin(t * 22) * 0.7 : (isDance ? Math.sin(t * 10) * 0.65 : Math.sin(t * 3.5) * 0.12)
  for (const s of [-1, 1]) {
    ctx.save()
    ctx.translate(s * 14, 17)
    const raise = (isGrabbed || actionState === 'magic_blackhole' || actionState === 'deliver') ? -1.1 : (actionState === 'write_input' && s === 1 ? -0.75 : 0.25)
    ctx.rotate(s * (raise + armWave))
    ctx.fillStyle = outfitPal.accent
    ctx.strokeStyle = outfitPal.shade
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.roundRect(-4.2, 0, 8.4, 14, 4.2)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = skinPal.base
    ctx.beginPath()
    ctx.arc(0, 14.5, 4.2, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  // 3) 精致粘土人小脸（圆润脸颊 + 细腻小下巴 + 奶油肌渐变）
  const headY = -14
  const faceG = ctx.createRadialGradient(-8, headY - 10, 4, 0, headY, 34)
  faceG.addColorStop(0, '#FFFFFF')
  faceG.addColorStop(0.28, skinPal.base)
  faceG.addColorStop(0.88, skinPal.base)
  faceG.addColorStop(1, skinPal.shade)
  ctx.fillStyle = faceG
  ctx.strokeStyle = 'rgba(130, 88, 76, 0.42)'
  ctx.lineWidth = 1.6
  ctx.beginPath()
  ctx.moveTo(-28, headY - 6)
  ctx.bezierCurveTo(-29, headY - 34, 29, headY - 34, 28, headY - 6)
  ctx.bezierCurveTo(28, headY + 18, 12, headY + 28, 0, headY + 29)
  ctx.bezierCurveTo(-12, headY + 28, -28, headY + 18, -28, headY - 6)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // 4) 宝石渐变二次元大眼 + 软萌腮红 + 精致小嘴
  drawAnimeEye(ctx, -12.5, headY + 4, 7.6, 8.8, eyePal, avatar.eyeStyle, lookX, lookY, blink, actionState, false)
  drawAnimeEye(ctx, 12.5, headY + 4, 7.6, 8.8, eyePal, avatar.eyeStyle, lookX, lookY, blink, actionState, true)

  ctx.fillStyle = skinPal.blush
  ctx.beginPath()
  ctx.ellipse(-19, headY + 13.5, 5.4, 2.8, 0, 0, Math.PI * 2)
  ctx.ellipse(19, headY + 13.5, 5.4, 2.8, 0, 0, Math.PI * 2)
  ctx.fill()

  ctx.strokeStyle = '#8F4C4C'
  ctx.lineWidth = 1.8
  ctx.lineCap = 'round'
  if (isEating) {
    ctx.fillStyle = '#FF7E98'
    ctx.beginPath()
    ctx.ellipse(0, headY + 17.5, 4.8, 3.2 + Math.abs(Math.sin(t * 14)) * 3, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  } else if (isGrabbed) {
    ctx.beginPath()
    ctx.ellipse(0, headY + 18, 3.4, 4.2, 0, 0, Math.PI * 2)
    ctx.stroke()
  } else {
    ctx.beginPath()
    ctx.moveTo(-4.5, headY + 16.5)
    ctx.quadraticCurveTo(0, headY + 20.5, 4.5, headY + 16.5)
    ctx.stroke()
  }

  // 5) 赛璐璐蓬松前刘海 + 侧鬓角 + 标志性二次元天使高光环！
  const frontHairG = ctx.createLinearGradient(0, headY - 34, 0, headY + 12)
  frontHairG.addColorStop(0, hairPal.light)
  frontHairG.addColorStop(0.32, hairPal.base)
  frontHairG.addColorStop(1, hairPal.shade)
  ctx.fillStyle = frontHairG
  ctx.strokeStyle = hairPal.deep
  ctx.lineWidth = 1.65

  // 顶部发冠 + 多缕层次感刘海
  ctx.beginPath()
  ctx.moveTo(-31, headY - 2)
  ctx.bezierCurveTo(-35, headY - 36, -12, headY - 40, 0, headY - 40)
  ctx.bezierCurveTo(12, headY - 40, 35, headY - 36, 31, headY - 2)
  // 锯齿有机发束刘海
  ctx.lineTo(24, headY + 14)
  ctx.quadraticCurveTo(21, headY - 2, 16, headY - 6)
  ctx.lineTo(10, headY + 1)
  ctx.quadraticCurveTo(5, headY - 9, 0, headY - 1)
  ctx.quadraticCurveTo(-5, headY - 9, -10, headY + 1)
  ctx.lineTo(-16, headY - 6)
  ctx.quadraticCurveTo(-21, headY - 2, -24, headY + 14)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // 呆毛（随动作弹跳！）
  ctx.save()
  ctx.translate(0, headY - 39)
  ctx.rotate(Math.sin(t * 5) * 0.14)
  ctx.strokeStyle = hairPal.deep
  ctx.lineWidth = 2.4
  ctx.beginPath()
  ctx.moveTo(0, 2)
  ctx.bezierCurveTo(-4, -10, 10, -14, 14, -6)
  ctx.stroke()
  ctx.restore()

  // 二次元天使高光环（发丝灵魂！）
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)'
  ctx.lineWidth = 3.2
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.arc(0, headY - 12, 23, Math.PI * 1.18, Math.PI * 1.42)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(0, headY - 12, 23, Math.PI * 1.56, Math.PI * 1.82)
  ctx.stroke()

  // 监工眼镜
  if (isSupervising || avatar.accessory === 'glasses') {
    ctx.strokeStyle = isSupervising ? '#F59E0B' : '#334155'
    ctx.lineWidth = 1.7
    ctx.beginPath()
    ctx.arc(-12.5, headY + 4, 9.5, 0, Math.PI * 2)
    ctx.moveTo(-3, headY + 4)
    ctx.lineTo(3, headY + 4)
    ctx.arc(12.5, headY + 4, 9.5, 0, Math.PI * 2)
    ctx.stroke()
  }

  // 头饰
  drawHeadgear(ctx, avatar.headgear || (isWhaleGirl ? 'sailor_hat' : 'cat_ears'), 0, headY - 35, 0.96, t, hairPal)

  ctx.restore()
}

/** 形态 4：液态玻璃星核喵（半透明 Apple Liquid Glass 质感小团子猫！） */
function drawLiquidGlassCat(ctx, { t, avatar, hairPal, eyePal, actionState, lookX, lookY, blink, dragTilt }) {
  const isGrabbed = actionState === 'grabbed' || actionState === 'thrown'
  const bob = isGrabbed ? 0 : Math.sin(t * 3.4) * 3.5
  const tilt = isGrabbed ? Math.max(-0.42, Math.min(0.42, dragTilt)) : Math.sin(t * 2.2) * 0.04

  if (!isGrabbed) {
    ctx.fillStyle = 'rgba(20, 42, 84, 0.13)'
    ctx.beginPath()
    ctx.ellipse(0, 44, 30, 7.5, 0, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.save()
  ctx.translate(0, 4 + bob)
  ctx.rotate(tilt)
  ctx.scale(isGrabbed ? 0.90 : 1, isGrabbed ? 1.14 : 1)

  // 背后发光液态星环
  ctx.strokeStyle = 'rgba(130, 212, 255, 0.65)'
  ctx.lineWidth = 2.4
  ctx.beginPath()
  ctx.ellipse(0, 4, 46, 12, -0.25 + Math.sin(t * 2) * 0.08, 0, Math.PI * 2)
  ctx.stroke()

  // 摇摆玻璃猫尾
  ctx.save()
  ctx.translate(26, 20)
  ctx.rotate(Math.sin(t * (isGrabbed ? 20 : 4.5)) * 0.35)
  ctx.strokeStyle = hairPal.base
  ctx.lineWidth = 7
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.quadraticCurveTo(18, -8, 16, -24)
  ctx.stroke()
  ctx.restore()

  // 半透明液态玻璃团子身体 + 猫耳
  const catG = ctx.createRadialGradient(-14, -22, 4, 0, 4, 46)
  catG.addColorStop(0, 'rgba(255, 255, 255, 0.96)')
  catG.addColorStop(0.45, hairPal.light)
  catG.addColorStop(0.82, hairPal.base)
  catG.addColorStop(1, hairPal.shade)
  ctx.fillStyle = catG
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)'
  ctx.lineWidth = 2.2
  ctx.beginPath()
  ctx.moveTo(-30, -10)
  ctx.lineTo(-28, -36)
  ctx.lineTo(-10, -24)
  ctx.quadraticCurveTo(0, -27, 10, -24)
  ctx.lineTo(28, -36)
  ctx.lineTo(30, -10)
  ctx.bezierCurveTo(38, 10, 34, 34, 0, 35)
  ctx.bezierCurveTo(-34, 34, -38, 10, -30, -10)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // 粉嫩内耳
  ctx.fillStyle = 'rgba(255, 160, 194, 0.65)'
  for (const s of [-1, 1]) {
    ctx.beginPath()
    ctx.moveTo(s * 24, -29)
    ctx.lineTo(s * 14, -21)
    ctx.lineTo(s * 25, -14)
    ctx.closePath()
    ctx.fill()
  }

  // 玻璃镜面弯月高光
  ctx.fillStyle = 'rgba(255,255,255,0.62)'
  ctx.beginPath()
  ctx.ellipse(-12, -12, 11, 5, -0.35, 0, Math.PI * 2)
  ctx.fill()

  drawAnimeEye(ctx, -13, 2, 7.8, 8.8, eyePal, avatar.eyeStyle || 'cat', lookX, lookY, blink, actionState, false)
  drawAnimeEye(ctx, 13, 2, 7.8, 8.8, eyePal, avatar.eyeStyle || 'cat', lookX, lookY, blink, actionState, true)

  ctx.strokeStyle = '#334155'
  ctx.lineWidth = 1.9
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(-5, 14)
  ctx.quadraticCurveTo(-2.5, 17, 0, 14)
  ctx.quadraticCurveTo(2.5, 17, 5, 14)
  ctx.stroke()

  drawHeadgear(ctx, avatar.headgear === 'cat_ears' ? 'halo' : avatar.headgear, 0, -28, 0.88, t, hairPal)
  ctx.restore()
}

export default function Companion3DCanvas({
  avatar = {},
  actionState = 'idle',
  facing = -1,
  lookX = 0,
  lookY = 0,
  dragTilt = 0,
  size = 148,
  spinPreview = false,
}) {
  const canvasRef = useRef(null)
  const propsRef = useRef({ avatar, actionState, facing, lookX, lookY, dragTilt, spinPreview })
  propsRef.current = { avatar, actionState, facing, lookX, lookY, dragTilt, spinPreview }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof requestAnimationFrame !== 'function') return undefined
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined

    let raf = 0
    let stopped = false
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()

    const render = (now) => {
      if (stopped) return
      if (typeof document !== 'undefined' && document.hidden) {
        raf = requestAnimationFrame(render)
        return
      }
      const { avatar: av, actionState: act, facing: fc, lookX: lx, lookY: ly, dragTilt: dtilt, spinPreview: spin } = propsRef.current
      const t = (now - t0) / 1000
      const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
      const pxSize = Math.round(size * dpr)
      if (canvas.width !== pxSize || canvas.height !== pxSize) {
        canvas.width = pxSize
        canvas.height = pxSize
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size, size)

      const hairPal = HAIR_PALETTES[av.hairColor] || HAIR_PALETTES.ocean
      const eyePal = EYE_PALETTES[av.eyeColor] || EYE_PALETTES.sapphire
      const outfitPal = OUTFIT_PALETTES[av.outfit] || OUTFIT_PALETTES.maid
      const skinPal = SKIN_PALETTES[av.skin] || SKIN_PALETTES.porcelain

      // 自然周期眨眼
      const blinkPhase = t % 4.3
      const blink = blinkPhase > 4.14 ? Math.sin(((blinkPhase - 4.14) / 0.16) * Math.PI) : 0

      ctx.save()
      ctx.translate(size / 2, size * 0.56)
      const baseScale = (size / 142) * Math.max(0.75, Math.min(1.25, Number(av.scale) || 1))
      const spinScaleX = spin ? (0.94 + Math.cos(t * 1.4) * 0.06) : 1
      ctx.scale(baseScale * (fc < 0 ? 1 : -1) * spinScaleX, baseScale)

      const drawOpts = {
        t,
        avatar: av,
        hairPal,
        eyePal,
        outfitPal,
        skinPal,
        actionState: act,
        lookX: (fc < 0 ? lx : -lx),
        lookY: ly,
        blink,
        dragTilt: fc < 0 ? dtilt : -dtilt,
      }

      const form = av.bodyForm || 'dafeiyu'
      if (form === 'dafeiyu') drawDaFeiYuWhale(ctx, drawOpts)
      else if (form === 'liquid_cat') drawLiquidGlassCat(ctx, drawOpts)
      else drawAnimeChibi(ctx, { ...drawOpts, isWhaleGirl: form === 'whale_girl' })

      // 特殊动作与互动情绪特效层（黑洞 / 监工雷达 / 摸头爱心 / 交稿星光 / 睡觉 Zzz / 拎起汗滴）
      if (act === 'magic_blackhole') {
        ctx.save()
        ctx.translate(-46, 0)
        const bhG = ctx.createRadialGradient(0, 0, 4, 0, 0, 26)
        bhG.addColorStop(0, '#090D18')
        bhG.addColorStop(0.55, '#5B3DF5')
        bhG.addColorStop(0.82, '#38BDF8')
        bhG.addColorStop(1, 'rgba(56,189,248,0)')
        ctx.fillStyle = bhG
        ctx.beginPath()
        ctx.arc(0, 0, 24 + Math.sin(t * 10) * 3, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
      } else if (act === 'supervising') {
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.72)'
        ctx.lineWidth = 1.8
        ctx.setLineDash([4, 4])
        ctx.beginPath()
        ctx.arc(0, -10, 48 + Math.sin(t * 4) * 3, 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])
        drawSparkle(ctx, -38, -36, 7, '#38BDF8', 0.9)
      } else if (act === 'pat' || act === 'happy') {
        const up = (t * 28) % 26
        drawHeart(ctx, -28, -32 - up * 0.6, 8, '#FF6E97', 1 - up / 28)
        drawHeart(ctx, 26, -24 - ((up + 12) % 26) * 0.6, 6.5, '#FF9AB8', 0.9)
      } else if (act === 'deliver' || act === 'dance') {
        drawSparkle(ctx, -36, -34 + Math.sin(t * 6) * 5, 9, '#FFD54F', 0.95)
        drawSparkle(ctx, 36, -28 - Math.sin(t * 6) * 5, 8, '#7ED4FF', 0.95)
        drawSparkle(ctx, 0, -54, 7, '#FF8CB4', 0.9)
      } else if (act === 'grabbed' || act === 'thrown') {
        // 慌张大汗滴
        ctx.fillStyle = '#7ED4FF'
        ctx.beginPath()
        ctx.moveTo(32, -32)
        ctx.quadraticCurveTo(37, -22, 32, -19)
        ctx.quadraticCurveTo(27, -22, 32, -32)
        ctx.fill()
      } else if (act === 'sleep') {
        ctx.fillStyle = '#60A5FA'
        ctx.font = '700 13px sans-serif'
        const drift = (t * 16) % 22
        ctx.globalAlpha = 1 - drift / 24
        ctx.fillText('Z', 24 + drift * 0.3, -28 - drift)
        ctx.font = '700 10px sans-serif'
        ctx.fillText('z', 34 + drift * 0.4, -38 - drift * 0.8)
        ctx.globalAlpha = 1
      }

      ctx.restore()
      raf = requestAnimationFrame(render)
    }

    raf = requestAnimationFrame(render)
    return () => {
      stopped = true
      if (raf) cancelAnimationFrame(raf)
    }
  }, [size])

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size, display: 'block', pointerEvents: 'none' }}
      aria-hidden="true"
    />
  )
}
