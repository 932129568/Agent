import { useEffect, useRef } from 'react'
const COMPANION_HAIR_COLORS = [
  { id: 'sakura', hex: '#F6A6C1', shade: '#C96B8D' },
  { id: 'sky', hex: '#7BC8F6', shade: '#3B8CC4' },
  { id: 'silver', hex: '#DCE3F0', shade: '#99A7C2' },
  { id: 'honey', hex: '#F7D07A', shade: '#C9963A' },
  { id: 'obsidian', hex: '#2F3647', shade: '#171B26' },
  { id: 'mint', hex: '#7AE3C3', shade: '#39A889' },
  { id: 'lilac', hex: '#BCA3F7', shade: '#7E64C7' },
  { id: 'coral', hex: '#F49772', shade: '#C45B38' },
]
const COMPANION_EYE_COLORS = [
  { id: 'sapphire', hex: '#2B8BE6' },
  { id: 'amber', hex: '#E69A28' },
  { id: 'rose', hex: '#E85C8B' },
  { id: 'emerald', hex: '#22A874' },
  { id: 'violet', hex: '#8A5CF6' },
  { id: 'crimson', hex: '#DF4545' },
  { id: 'cyan', hex: '#14B8C4' },
  { id: 'hetero', hex: '#2B8BE6', rightHex: '#E69A28' },
]
const COMPANION_OUTFITS = [
  { id: 'sailor', primary: '#3B6FD8', accent: '#FFFFFF' },
  { id: 'cyber', primary: '#252E42', accent: '#38BDF8' },
  { id: 'maid', primary: '#2C2A35', accent: '#F9D8E6' },
  { id: 'mage', primary: '#5B42B8', accent: '#F7C95C' },
  { id: 'pajama', primary: '#F5B5C8', accent: '#FFF8EB' },
  { id: 'labcoat', primary: '#F4F7FB', accent: '#D4653E' },
]
const COMPANION_SKINS = [
  { id: 'porcelain', hex: '#FFF0E6', shade: '#E8C5B3' },
  { id: 'peach', hex: '#FFE6D8', shade: '#E3B6A0' },
  { id: 'warm', hex: '#F6D5BC', shade: '#D4A586' },
  { id: 'honey', hex: '#E3B48D', shade: '#BA855E' },
]

function pickById(list, id) {
  return list.find((x) => x.id === id) || list[0]
}

/** 3D 球体软体着色彩绘（带左上主光、次表面暖光与菲涅尔 3D 立体边缘高光） */
function drawSphere3D(ctx, x, y, r, color, shadeColor, rimAlpha = 0.45) {
  const g = ctx.createRadialGradient(x - r * 0.34, y - r * 0.36, r * 0.08, x, y, r)
  g.addColorStop(0, '#FFFFFF')
  g.addColorStop(0.22, color)
  g.addColorStop(0.78, color)
  g.addColorStop(1, shadeColor)
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y, Math.max(1, r), 0, Math.PI * 2)
  ctx.fill()
  if (rimAlpha > 0) {
    ctx.strokeStyle = `rgba(255,255,255,${rimAlpha.toFixed(2)})`
    ctx.lineWidth = Math.max(0.8, r * 0.06)
    ctx.beginPath()
    ctx.arc(x, y, Math.max(1, r - 0.6), Math.PI * 0.95, Math.PI * 1.75)
    ctx.stroke()
  }
}

function drawCapsule3D(ctx, x1, y1, x2, y2, r, color, shadeColor) {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.strokeStyle = shadeColor
  ctx.lineWidth = r * 2 + 2
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
  ctx.strokeStyle = color
  ctx.lineWidth = r * 2
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
  ctx.strokeStyle = 'rgba(255,255,255,0.34)'
  ctx.lineWidth = Math.max(1, r * 0.55)
  ctx.beginPath(); ctx.moveTo(x1 - r * 0.25, y1 - r * 0.2); ctx.lineTo(x2 - r * 0.25, y2 - r * 0.2); ctx.stroke()
  ctx.restore()
}

/**
 * R28 纯程序化 3D 可爱二次元 Q 版角色渲染器（零外部 3D 库依赖、60fps HiDPI、100% 兼容 Electron/Chromium）：
 * - 真实 3D 旋转投影（yaw/pitch 跟随鼠标视线 + 身体呼吸/跑步/蹲下点击/拿笔手写/啃玻璃/修补/召唤黑洞骨骼动画）；
 * - 完整渲染 7 发型 / 8 发色 / 6 眼型 / 8 瞳色 / 7 头饰兽耳 / 6 服装 / 7 配饰 / 4 肤色。
 */
export default function Companion3DCanvas({
  avatar,
  actionState = 'idle', // 'idle' | 'run' | 'crouch_click' | 'write_input' | 'magic_blackhole' | 'sneak_eat' | 'collect_shards' | 'repair_glass' | 'happy' | 'guilty'
  facing = 1,           // 1 = right, -1 = left
  lookX = 0,            // [-1, 1]
  lookY = 0,            // [-1, 1]
  size = 136,
  spinPreview = false,  // 捏脸工坊 360° 展示微旋转
}) {
  const canvasRef = useRef(null)
  const propsRef = useRef({ avatar, actionState, facing, lookX, lookY, spinPreview })
  propsRef.current = { avatar, actionState, facing, lookX, lookY, spinPreview }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof requestAnimationFrame !== 'function') return undefined
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined

    let raf = 0
    let stopped = false
    const t0 = performance.now()

    const draw = (now) => {
      if (stopped) return
      if (typeof document !== 'undefined' && document.hidden) {
        raf = requestAnimationFrame(draw)
        return
      }
      const { avatar: av, actionState: act, facing: face, lookX: lx, lookY: ly, spinPreview: spin } = propsRef.current
      const t = (now - t0) / 1000
      const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
      const w = size
      const h = size
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      const hairCol = pickById(COMPANION_HAIR_COLORS, av.hairColor)
      const eyeCol = pickById(COMPANION_EYE_COLORS, av.eyeColor)
      const outfit = pickById(COMPANION_OUTFITS, av.outfit)
      const skin = pickById(COMPANION_SKINS, av.skin)
      const sc = (w / 140) * (Number(av.scale) || 1)

      // 动作状态机骨骼参数（生动、带二次惯性与弹簧起伏）
      const isRun = act === 'run' || act === 'collect_shards'
      const isCrouch = act === 'crouch_click' || act === 'repair_glass'
      const isWrite = act === 'write_input'
      const isMagic = act === 'magic_blackhole'
      const isEat = act === 'sneak_eat'
      const isHappy = act === 'happy'

      const breathe = Math.sin(t * 2.8) * 1.8
      const runCycle = isRun ? Math.sin(t * 14) : 0
      const jumpBob = isRun ? Math.abs(Math.sin(t * 14)) * -8.5 : (isHappy ? Math.abs(Math.sin(t * 7)) * -10 : 0)
      const crouchY = isCrouch ? 12 : (isEat ? 6 : 0)
      const yaw = spin ? Math.sin(t * 1.3) * 0.42 : (lx * 0.28 + (face < 0 ? -0.14 : 0.14))
      const pitch = ly * 0.18 + (isCrouch ? 0.15 : (isMagic ? -0.12 : 0))
      const hairSway = Math.sin(t * (isRun ? 11 : 3.2)) * (isRun ? 7 : 2.8)

      const cx = w * 0.5
      const baseY = h * 0.88

      // 1) 地面柔和接触投影（随跳跃缩放）
      const shadowScale = Math.max(0.55, 1 + jumpBob * 0.025)
      ctx.save()
      ctx.fillStyle = 'rgba(15, 23, 42, 0.22)'
      ctx.beginPath()
      ctx.ellipse(cx, baseY + 2, 28 * sc * shadowScale, 7.5 * sc * shadowScale, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()

      // 2) 黑洞魔法阵 / 跑步尘土 / 修补光尘背景层
      if (isMagic) {
        const bhX = cx + face * 40 * sc
        const bhY = baseY - 52 * sc
        ctx.save()
        // 旋转星穹魔法阵
        ctx.translate(cx, baseY - 4 * sc)
        ctx.scale(1, 0.32)
        ctx.rotate(t * 2.4)
        ctx.strokeStyle = 'rgba(167, 139, 250, 0.85)'
        ctx.lineWidth = 2.2
        ctx.beginPath(); ctx.arc(0, 0, 38 * sc, 0, Math.PI * 2); ctx.stroke()
        ctx.strokeStyle = 'rgba(250, 204, 21, 0.72)'
        ctx.setLineDash([6, 4])
        ctx.beginPath(); ctx.arc(0, 0, 29 * sc, 0, Math.PI * 2); ctx.stroke()
        ctx.restore()

        // 真实旋转微型黑洞事件视界 + 吸积盘！
        ctx.save()
        const bhG = ctx.createRadialGradient(bhX, bhY, 4 * sc, bhX, bhY, 26 * sc)
        bhG.addColorStop(0, '#070412')
        bhG.addColorStop(0.42, '#1A0B3B')
        bhG.addColorStop(0.68, 'rgba(139, 92, 246, 0.85)')
        bhG.addColorStop(0.84, 'rgba(56, 189, 248, 0.45)')
        bhG.addColorStop(1, 'rgba(56, 189, 248, 0)')
        ctx.fillStyle = bhG
        ctx.beginPath(); ctx.arc(bhX, bhY, 26 * sc, 0, Math.PI * 2); ctx.fill()
        // 旋转吸积光丝
        ctx.translate(bhX, bhY)
        ctx.rotate(t * 5.2)
        ctx.strokeStyle = 'rgba(250, 224, 140, 0.82)'
        ctx.lineWidth = 1.6
        ctx.beginPath(); ctx.ellipse(0, 0, 20 * sc, 7 * sc, 0.4, 0, Math.PI * 1.6); ctx.stroke()
        ctx.restore()
      }

      if (isRun) {
        const puffPhase = (t * 6) % 1
        ctx.fillStyle = `rgba(255, 255, 255, ${(0.55 * (1 - puffPhase)).toFixed(2)})`
        ctx.beginPath()
        ctx.arc(cx - face * (18 + puffPhase * 18) * sc, baseY - puffPhase * 8 * sc, (4 + puffPhase * 5) * sc, 0, Math.PI * 2)
        ctx.fill()
      }

      const bodyY = baseY - 34 * sc + breathe * sc + jumpBob * sc + crouchY * sc
      const headX = cx + Math.sin(yaw) * 4 * sc
      const headY = bodyY - 36 * sc + pitch * 8 * sc

      // 3) 后景配饰：迷你光翼 / 浮游魔导书 / 后发长发与马尾
      if (av.accessory === 'wings') {
        const flap = Math.sin(t * 6.5) * 0.25
        for (const side of [-1, 1]) {
          ctx.save()
          ctx.translate(cx + side * 14 * sc, bodyY - 4 * sc)
          ctx.rotate(side * (0.4 + flap))
          ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
          ctx.strokeStyle = 'rgba(96, 194, 250, 0.8)'
          ctx.lineWidth = 1.3
          ctx.beginPath()
          ctx.ellipse(side * 16 * sc, 0, 17 * sc, 7.5 * sc, 0, 0, Math.PI * 2)
          ctx.fill(); ctx.stroke()
          ctx.restore()
        }
      }

      // 后层头发（长发 / 双马尾 / 双螺旋 / 侧马尾 / 双丸子）
      if (av.hairstyle === 'long') {
        drawCapsule3D(ctx, headX - 18 * sc, headY + 4 * sc, headX - 24 * sc + hairSway * 0.5, bodyY + 18 * sc, 11 * sc, hairCol.hex, hairCol.shade)
        drawCapsule3D(ctx, headX + 18 * sc, headY + 4 * sc, headX + 24 * sc + hairSway * 0.5, bodyY + 18 * sc, 11 * sc, hairCol.hex, hairCol.shade)
      } else if (av.hairstyle === 'twintails' || av.hairstyle === 'drill') {
        for (const s of [-1, 1]) {
          const tx = headX + s * 28 * sc + hairSway * 0.7
          const ty = headY + 26 * sc
          drawCapsule3D(ctx, headX + s * 22 * sc, headY - 4 * sc, tx, ty, (av.hairstyle === 'drill' ? 9.5 : 8) * sc, hairCol.hex, hairCol.shade)
          drawSphere3D(ctx, tx, ty + 3 * sc, (av.hairstyle === 'drill' ? 9 : 6.5) * sc, hairCol.hex, hairCol.shade, 0.3)
        }
      } else if (av.hairstyle === 'buns') {
        drawSphere3D(ctx, headX - 24 * sc, headY - 22 * sc, 11 * sc, hairCol.hex, hairCol.shade, 0.4)
        drawSphere3D(ctx, headX + 24 * sc, headY - 22 * sc, 11 * sc, hairCol.hex, hairCol.shade, 0.4)
      } else if (av.hairstyle === 'sidetail') {
        drawCapsule3D(ctx, headX + 22 * sc, headY - 6 * sc, headX + 34 * sc + hairSway, headY + 24 * sc, 9 * sc, hairCol.hex, hairCol.shade)
      }

      // 4) 3D Q版双腿（跑步摆动 / 蹲下曲腿）
      const legLSwing = isRun ? runCycle * 11 * sc : 0
      const legRSwing = isRun ? -runCycle * 11 * sc : 0
      const footY = baseY - 2 * sc + jumpBob * sc * 0.65
      drawCapsule3D(ctx, cx - 8 * sc, bodyY + 14 * sc, cx - 9 * sc + legLSwing, footY, 5.2 * sc, skin.hex, skin.shade)
      drawCapsule3D(ctx, cx + 8 * sc, bodyY + 14 * sc, cx + 9 * sc + legRSwing, footY, 5.2 * sc, skin.hex, skin.shade)
      // 小皮鞋
      drawSphere3D(ctx, cx - 9 * sc + legLSwing, footY + 1 * sc, 5.8 * sc, outfit.primary, '#1E2433', 0.3)
      drawSphere3D(ctx, cx + 9 * sc + legRSwing, footY + 1 * sc, 5.8 * sc, outfit.primary, '#1E2433', 0.3)

      // 5) 3D 躯干与服装（6 种风格细节）
      ctx.save()
      const torsoG = ctx.createRadialGradient(cx - 6 * sc, bodyY - 6 * sc, 3 * sc, cx, bodyY + 4 * sc, 24 * sc)
      torsoG.addColorStop(0, outfit.accent)
      torsoG.addColorStop(0.26, outfit.primary)
      torsoG.addColorStop(1, '#1A2030')
      ctx.fillStyle = torsoG
      ctx.beginPath()
      ctx.moveTo(cx - 13 * sc, bodyY - 12 * sc)
      ctx.lineTo(cx + 13 * sc, bodyY - 12 * sc)
      ctx.quadraticCurveTo(cx + 22 * sc, bodyY + 16 * sc, cx + 17 * sc, bodyY + 18 * sc)
      ctx.lineTo(cx - 17 * sc, bodyY + 18 * sc)
      ctx.quadraticCurveTo(cx - 22 * sc, bodyY + 16 * sc, cx - 13 * sc, bodyY - 12 * sc)
      ctx.closePath()
      ctx.fill()
      // 领结 / 徽章高光细节
      ctx.fillStyle = outfit.accent
      ctx.beginPath()
      ctx.moveTo(cx - 9 * sc, bodyY - 11 * sc)
      ctx.lineTo(cx, bodyY - 2 * sc)
      ctx.lineTo(cx + 9 * sc, bodyY - 11 * sc)
      ctx.closePath()
      ctx.fill()
      ctx.fillStyle = '#F45D7E'
      ctx.beginPath(); ctx.arc(cx, bodyY - 3 * sc, 3.6 * sc, 0, Math.PI * 2); ctx.fill()
      if (av.accessory === 'scarf') {
        drawCapsule3D(ctx, cx - 13 * sc, bodyY - 11 * sc, cx + 13 * sc, bodyY - 11 * sc, 4.2 * sc, '#EF5B4C', '#B6372B')
      }
      ctx.restore()

      // 6) 3D 关节手臂 + 专属工作道具（点击手势 / 手写发光笔 / 修补魔杖 / 伸进黑洞掏文件！）
      const armWave = Math.sin(t * 9) * 6 * sc
      let lHandX = cx - 22 * sc, lHandY = bodyY + 4 * sc + (isRun ? -runCycle * 8 * sc : 0)
      let rHandX = cx + 22 * sc, rHandY = bodyY + 4 * sc + (isRun ? runCycle * 8 * sc : 0)

      if (isCrouch) {
        rHandX = cx + face * 28 * sc
        rHandY = bodyY + 8 * sc + Math.sin(t * 14) * 3.5 * sc
      } else if (isWrite) {
        rHandX = cx + face * 26 * sc + Math.cos(t * 15) * 4 * sc
        rHandY = bodyY - 4 * sc + Math.sin(t * 19) * 3.5 * sc
      } else if (isMagic) {
        // 伸手进入黑洞掏出文件光球！
        rHandX = cx + face * (34 + Math.sin(t * 4) * 5) * sc
        rHandY = baseY - 50 * sc
        lHandX = cx - face * 20 * sc
        lHandY = bodyY - 14 * sc
      } else if (isEat) {
        lHandX = cx - 10 * sc; lHandY = headY + 12 * sc
        rHandX = cx + 10 * sc; rHandY = headY + 12 * sc
      } else if (isHappy) {
        lHandX = cx - 24 * sc; lHandY = bodyY - 14 * sc + armWave * 0.5
        rHandX = cx + 24 * sc; rHandY = bodyY - 14 * sc - armWave * 0.5
      }

      drawCapsule3D(ctx, cx - 13 * sc, bodyY - 6 * sc, lHandX, lHandY, 4.6 * sc, outfit.primary, '#1E2433')
      drawCapsule3D(ctx, cx + 13 * sc, bodyY - 6 * sc, rHandX, rHandY, 4.6 * sc, outfit.primary, '#1E2433')
      drawSphere3D(ctx, lHandX, lHandY, 4.8 * sc, skin.hex, skin.shade, 0.25)
      drawSphere3D(ctx, rHandX, rHandY, 4.8 * sc, skin.hex, skin.shade, 0.25)

      // 道具：手写笔 / 液态玻璃修补魔杖 / 黑洞掏出的发光文件球 / 抱着的玻璃碎片
      if (isWrite) {
        drawCapsule3D(ctx, rHandX, rHandY, rHandX + face * 14 * sc, rHandY - 12 * sc, 2.2 * sc, '#38BDF8', '#0284C7')
        ctx.fillStyle = '#FDE047'
        ctx.beginPath(); ctx.arc(rHandX + face * 15 * sc, rHandY - 13 * sc, 3 * sc, 0, Math.PI * 2); ctx.fill()
      } else if (act === 'repair_glass') {
        drawCapsule3D(ctx, rHandX, rHandY, rHandX + face * 16 * sc, rHandY - 10 * sc, 2.3 * sc, '#68D396', '#1E7A4C')
        const spR = (4 + Math.sin(t * 16) * 2.2) * sc
        ctx.fillStyle = 'rgba(104, 211, 150, 0.85)'
        ctx.beginPath(); ctx.arc(rHandX + face * 17 * sc, rHandY - 11 * sc, spR, 0, Math.PI * 2); ctx.fill()
      } else if (isMagic) {
        drawSphere3D(ctx, rHandX, rHandY, 7.5 * sc, '#7DD3FC', '#6366F1', 0.8)
      } else if (act === 'collect_shards') {
        drawSphere3D(ctx, cx + face * 8 * sc, bodyY + 2 * sc, 7 * sc, '#E0F2FE', '#38BDF8', 0.85)
      }

      // 7) 3D Q 版大头（核心萌点！）
      const headR = 27.5 * sc
      drawSphere3D(ctx, headX, headY, headR, skin.hex, skin.shade, 0.35)

      // 脸部朝向偏移（3D 球面投影感）
      const fx = headX + Math.sin(yaw) * 10 * sc
      const fy = headY + pitch * 8 * sc

      // 甜美腮红
      ctx.fillStyle = isEat || act === 'guilty' ? 'rgba(244, 102, 130, 0.56)' : 'rgba(244, 130, 152, 0.36)'
      ctx.beginPath(); ctx.ellipse(fx - 13 * sc, fy + 8 * sc, 5.2 * sc, 3 * sc, 0, 0, Math.PI * 2); ctx.fill()
      ctx.beginPath(); ctx.ellipse(fx + 13 * sc, fy + 8 * sc, 5.2 * sc, 3 * sc, 0, 0, Math.PI * 2); ctx.fill()

      // 8) 灵动眼睛（自动眨眼 + 视线追踪 + 6 眼型 + 8 瞳色含异色瞳！）
      const blinkCycle = (t % 3.8)
      const isBlinking = blinkCycle > 3.64
      const eyeGap = 10.5 * sc
      for (const s of [-1, 1]) {
        const ex = fx + s * eyeGap
        const ey = fy + 1.5 * sc
        const curEyeHex = (s > 0 && eyeCol.rightHex) ? eyeCol.rightHex : eyeCol.hex
        if (isBlinking || isHappy || av.eyeStyle === 'gentle') {
          ctx.strokeStyle = '#2A2230'
          ctx.lineWidth = 2.4 * sc
          ctx.lineCap = 'round'
          ctx.beginPath()
          ctx.arc(ex, ey + 2 * sc, 5.5 * sc, Math.PI * 1.15, Math.PI * 1.85)
          ctx.stroke()
        } else {
          // 眼白
          ctx.fillStyle = '#FFFFFF'
          ctx.beginPath(); ctx.ellipse(ex, ey, 6.2 * sc, 7.2 * sc, 0, 0, Math.PI * 2); ctx.fill()
          // 虹膜（跟随视线微偏）
          const px = ex + lx * 2.2 * sc
          const py = ey + ly * 1.6 * sc
          const eg = ctx.createRadialGradient(px, py - 2 * sc, 1 * sc, px, py, 5.8 * sc)
          eg.addColorStop(0, curEyeHex)
          eg.addColorStop(0.75, curEyeHex)
          eg.addColorStop(1, '#1A1526')
          ctx.fillStyle = eg
          ctx.beginPath(); ctx.ellipse(px, py, (av.eyeStyle === 'cat' ? 3.8 : 4.8) * sc, 5.8 * sc, 0, 0, Math.PI * 2); ctx.fill()
          // 瞳孔与双层动漫高光
          ctx.fillStyle = '#181422'
          ctx.beginPath(); ctx.ellipse(px, py + 0.5 * sc, (av.eyeStyle === 'cat' ? 1.5 : 2.3) * sc, 3 * sc, 0, 0, Math.PI * 2); ctx.fill()
          ctx.fillStyle = '#FFFFFF'
          ctx.beginPath(); ctx.arc(px - 2 * sc, py - 2.3 * sc, 2.0 * sc, 0, Math.PI * 2); ctx.fill()
          ctx.beginPath(); ctx.arc(px + 1.8 * sc, py + 2.2 * sc, 1.0 * sc, 0, Math.PI * 2); ctx.fill()
          if (av.eyeStyle === 'star') {
            ctx.fillStyle = '#FEF08A'
            ctx.beginPath(); ctx.arc(px, py + 2.5 * sc, 1.4 * sc, 0, Math.PI * 2); ctx.fill()
          } else if (av.eyeStyle === 'heart') {
            ctx.fillStyle = '#F9A8D4'
            ctx.beginPath(); ctx.arc(px, py + 2.2 * sc, 1.5 * sc, 0, Math.PI * 2); ctx.fill()
          }
          // 上睫毛弧线
          ctx.strokeStyle = '#231C2B'
          ctx.lineWidth = (av.eyeStyle === 'cool' ? 2.8 : 2.2) * sc
          ctx.beginPath(); ctx.arc(ex, ey + 0.5 * sc, 6.4 * sc, Math.PI * 1.12, Math.PI * 1.88); ctx.stroke()
        }
      }

      // 表情嘴巴（啃玻璃大口咀嚼 / 开心笑 / 心虚波浪嘴 / 正常微笑）
      ctx.strokeStyle = '#8F4C54'
      ctx.lineWidth = 1.8 * sc
      ctx.lineCap = 'round'
      if (isEat) {
        const chomp = 2.5 + Math.abs(Math.sin(t * 14)) * 3.8
        ctx.fillStyle = '#F4728A'
        ctx.beginPath(); ctx.ellipse(fx, fy + 12 * sc, 4.5 * sc, chomp * sc, 0, 0, Math.PI * 2); ctx.fill()
        // 嘴边咬碎的液态玻璃亮片
        ctx.fillStyle = 'rgba(186, 234, 255, 0.92)'
        ctx.fillRect(fx + 5 * sc, fy + 10 * sc, 4.5 * sc, 4.5 * sc)
      } else if (act === 'guilty') {
        ctx.beginPath(); ctx.moveTo(fx - 4 * sc, fy + 12 * sc); ctx.quadraticCurveTo(fx, fy + 9 * sc, fx + 4 * sc, fy + 12 * sc); ctx.stroke()
      } else if (isHappy || isMagic) {
        ctx.fillStyle = '#F4728A'
        ctx.beginPath(); ctx.arc(fx, fy + 11 * sc, 4.2 * sc, 0, Math.PI); ctx.fill()
      } else {
        ctx.beginPath(); ctx.arc(fx, fy + 10.5 * sc, 3.6 * sc, 0.2, Math.PI - 0.2); ctx.stroke()
      }

      // 9) 前发刘海 + 顶部 3D 头发光泽环（天使环高光！）
      ctx.save()
      const hairG = ctx.createLinearGradient(headX, headY - headR, headX, headY + 6 * sc)
      hairG.addColorStop(0, hairCol.hex)
      hairG.addColorStop(1, hairCol.shade)
      ctx.fillStyle = hairG
      ctx.beginPath()
      ctx.arc(headX, headY - 2 * sc, headR * 1.04, Math.PI * 1.02, Math.PI * 1.98)
      // 锯齿状柔和二次元刘海
      ctx.lineTo(headX + headR * 0.88, headY - 1 * sc)
      ctx.quadraticCurveTo(fx + 12 * sc, headY - 6 * sc, fx + 6 * sc, headY + 2 * sc)
      ctx.quadraticCurveTo(fx, headY - 10 * sc, fx - 5 * sc, headY + 1 * sc)
      ctx.quadraticCurveTo(fx - 14 * sc, headY - 7 * sc, headX - headR * 0.92, headY)
      ctx.closePath()
      ctx.fill()
      // 动漫天使发环高光
      ctx.strokeStyle = 'rgba(255,255,255,0.52)'
      ctx.lineWidth = 3 * sc
      ctx.beginPath(); ctx.arc(headX, headY - 4 * sc, headR * 0.78, Math.PI * 1.18, Math.PI * 1.82); ctx.stroke()
      ctx.restore()

      // 10) 头饰与兽耳（7 款可自由切换！）
      if (av.headgear === 'cat_ears') {
        for (const s of [-1, 1]) {
          ctx.fillStyle = hairCol.hex
          ctx.beginPath()
          ctx.moveTo(headX + s * 22 * sc, headY - 16 * sc)
          ctx.lineTo(headX + s * 19 * sc, headY - 38 * sc)
          ctx.lineTo(headX + s * 6 * sc, headY - 24 * sc)
          ctx.closePath(); ctx.fill()
          ctx.fillStyle = '#F9A8C9'
          ctx.beginPath()
          ctx.moveTo(headX + s * 19 * sc, headY - 19 * sc)
          ctx.lineTo(headX + s * 18 * sc, headY - 32 * sc)
          ctx.lineTo(headX + s * 10 * sc, headY - 23 * sc)
          ctx.closePath(); ctx.fill()
        }
      } else if (av.headgear === 'bunny_ears') {
        for (const s of [-1, 1]) {
          drawCapsule3D(ctx, headX + s * 12 * sc, headY - 24 * sc, headX + s * 18 * sc + hairSway * 0.3, headY - 48 * sc, 5.5 * sc, '#FFFFFF', '#E2E8F0')
          drawCapsule3D(ctx, headX + s * 12 * sc, headY - 26 * sc, headX + s * 17 * sc + hairSway * 0.3, headY - 44 * sc, 2.5 * sc, '#F9A8C9', '#F472B6')
        }
      } else if (av.headgear === 'halo') {
        ctx.strokeStyle = '#FDE047'
        ctx.lineWidth = 3 * sc
        ctx.beginPath(); ctx.ellipse(headX, headY - 36 * sc + Math.sin(t * 4) * 2 * sc, 18 * sc, 5 * sc, 0, 0, Math.PI * 2); ctx.stroke()
      } else if (av.headgear === 'devil_horns') {
        for (const s of [-1, 1]) {
          ctx.fillStyle = '#3B1D3B'
          ctx.beginPath()
          ctx.moveTo(headX + s * 16 * sc, headY - 22 * sc)
          ctx.quadraticCurveTo(headX + s * 26 * sc, headY - 36 * sc, headX + s * 14 * sc, headY - 40 * sc)
          ctx.lineTo(headX + s * 9 * sc, headY - 25 * sc)
          ctx.closePath(); ctx.fill()
        }
      } else if (av.headgear === 'ribbon') {
        ctx.fillStyle = '#F45D7E'
        ctx.beginPath(); ctx.ellipse(headX - 10 * sc, headY - 27 * sc, 10 * sc, 6 * sc, -0.3, 0, Math.PI * 2); ctx.fill()
        ctx.beginPath(); ctx.ellipse(headX + 10 * sc, headY - 27 * sc, 10 * sc, 6 * sc, 0.3, 0, Math.PI * 2); ctx.fill()
        drawSphere3D(ctx, headX, headY - 27 * sc, 4.5 * sc, '#FB7185', '#BE123C', 0.4)
      } else if (av.headgear === 'headphones') {
        ctx.strokeStyle = '#38BDF8'; ctx.lineWidth = 3.5 * sc
        ctx.beginPath(); ctx.arc(headX, headY - 2 * sc, headR * 1.12, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke()
        drawSphere3D(ctx, headX - headR * 1.04, headY + 2 * sc, 7 * sc, '#1E293B', '#0F172A', 0.5)
        drawSphere3D(ctx, headX + headR * 1.04, headY + 2 * sc, 7 * sc, '#1E293B', '#0F172A', 0.5)
      }

      // 11) 前景配饰：圆框金丝眼镜 / 创可贴 / 星光发夹 / 浮游魔导书
      if (av.accessory === 'glasses') {
        ctx.strokeStyle = '#D99B38'; ctx.lineWidth = 1.6 * sc
        ctx.beginPath(); ctx.arc(fx - eyeGap, fy + 2 * sc, 7.6 * sc, 0, Math.PI * 2); ctx.stroke()
        ctx.beginPath(); ctx.arc(fx + eyeGap, fy + 2 * sc, 7.6 * sc, 0, Math.PI * 2); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(fx - 3 * sc, fy + 2 * sc); ctx.lineTo(fx + 3 * sc, fy + 2 * sc); ctx.stroke()
      } else if (av.accessory === 'star_clip') {
        ctx.fillStyle = '#FDE047'
        ctx.beginPath(); ctx.arc(headX + 16 * sc, headY - 12 * sc, 4 * sc, 0, Math.PI * 2); ctx.fill()
      } else if (av.accessory === 'bandaid') {
        ctx.fillStyle = '#FCD9B6'
        ctx.fillRect(fx + 10 * sc, fy + 7 * sc, 8 * sc, 3.2 * sc)
      } else if (av.accessory === 'grimoire') {
        const bx = cx - face * 42 * sc
        const by = bodyY - 18 * sc + Math.sin(t * 3.5) * 5 * sc
        ctx.fillStyle = '#5B42B8'
        ctx.fillRect(bx - 8 * sc, by - 10 * sc, 16 * sc, 20 * sc)
        ctx.strokeStyle = '#FDE047'; ctx.lineWidth = 1.4
        ctx.strokeRect(bx - 8 * sc, by - 10 * sc, 16 * sc, 20 * sc)
      }

      raf = requestAnimationFrame(draw)
    }

    raf = requestAnimationFrame(draw)
    return () => { stopped = true; if (raf) cancelAnimationFrame(raf) }
  }, [size])

  return <canvas ref={canvasRef} width={size} height={size} style={{ width: size, height: size, display: 'block', pointerEvents: 'none' }} aria-hidden="true" />
}
