import { useEffect, useRef } from 'react'
import { motionScaleForTier } from '../platform/kinetic.js'
import './LiquidImpactCanvas.css'

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3) }
function easeOutQuart(t) { return 1 - Math.pow(1 - t, 4) }

function originForEdge(edge, w, h, impactPct) {
  const frac = Math.max(0.14, Math.min(0.86, (Number(impactPct) || 50) / 100))
  if (edge === 'right') return { ox: w, oy: h * frac, nx: -1, ny: 0 }
  if (edge === 'top') return { ox: w * frac, oy: 0, nx: 0, ny: 1 }
  if (edge === 'bottom') return { ox: w * frac, oy: h, nx: 0, ny: -1 }
  return { ox: 0, oy: h * frac, nx: 1, ny: 0 }
}

function drawHarmonicArc(ctx, ox, oy, radius, startA, endA, phase, wobbleAmp, seed) {
  const steps = 44
  ctx.beginPath()
  for (let i = 0; i <= steps; i++) {
    const u = i / steps
    const a = startA + (endA - startA) * u
    const env = Math.sin(u * Math.PI)
    const wobble = wobbleAmp * env * (
      Math.sin(a * 4 + phase * 6 + seed) * 0.6
      + Math.cos(a * 7 - phase * 9 + seed * 1.7) * 0.4
    )
    const r = Math.max(4, radius + wobble)
    const px = ox + Math.cos(a) * r
    const py = oy + Math.sin(a) * r
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.stroke()
}

function drawFourPointStar(ctx, x, y, r, rot, alpha, color) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(rot)
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha))
  ctx.fillStyle = color
  ctx.beginPath()
  const inner = r * 0.24
  for (let i = 0; i < 8; i++) {
    const rad = i % 2 === 0 ? r : inner
    const ang = (i * Math.PI) / 4
    const px = Math.cos(ang) * rad
    const py = Math.sin(ang) * rad
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/**
 * R24 实时液态玻璃撞击 Canvas 2D 光学物理引擎：
 * - 闲置 0% CPU（仅撞击瞬间唤醒 640ms，结束立刻清屏并终止 rAF）；
 * - 支持 5 大迥异液态玻璃光学风格（mercury / prism / ripple / crystal / aurora）；
 * - 严格服从无障碍降级（motionTier='reduced' 时完全不渲染）。
 */
export default function LiquidImpactCanvas({
  seq = 0,
  edge = 'left',
  impactPct = 50,
  styleId = 'mercury',
  strength = 'strong',
  motionTier = 'dynamic',
  theme = 'light',
}) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const k = motionScaleForTier(motionTier)
    const canvas = canvasRef.current
    if (!seq || !canvas || k === 0 || typeof requestAnimationFrame !== 'function') return undefined

    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined

    const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
    const w = Math.max(1, canvas.clientWidth)
    const h = Math.max(1, canvas.clientHeight)
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const { ox, oy, nx, ny } = originForEdge(edge, w, h, impactPct)
    const baseAngle = Math.atan2(ny, nx)
    const spread = Math.PI * 0.54
    const maxR = Math.min(w, h) * (strength === 'strong' ? 0.56 : 0.42) * (0.75 + 0.25 * k)
    const isDark = theme === 'dark'
    const seed = (seq * 1.6180339) % 10

    // 预生成确定性轻量化微粒子（水珠 / 棱镜微光 / 冰晶切面 / 气泡）
    const pCount = strength === 'strong' ? 14 : 9
    const particles = Array.from({ length: pCount }, (_, i) => {
      const frac = pCount > 1 ? (i / (pCount - 1)) - 0.5 : 0
      const jitter = Math.sin(seed * 13 + i * 7.3) * 0.16
      const ang = baseAngle + (frac * 1.55 + jitter) * (Math.PI * 0.48)
      const spd = (0.38 + Math.abs(Math.cos(seed + i * 2.1)) * 0.72) * maxR
      const size = 2.6 + (i % 4) * 1.7
      const delay = (i % 3) * 0.045
      const hueShift = i % 3
      return { ang, spd, size, delay, hueShift, spin: (i % 2 ? 1 : -1) * (1.2 + (i % 3) * 0.9) }
    })

    const durMs = styleId === 'ripple' ? 680 : (styleId === 'aurora' ? 660 : 580)
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
    let raf = 0
    let stopped = false

    const render = (now) => {
      if (stopped) return
      const rawT = Math.min(1, Math.max(0, (now - t0) / durMs))
      ctx.clearRect(0, 0, w, h)

      if (rawT >= 1) return

      const p = easeOutCubic(rawT)
      const p4 = easeOutQuart(rawT)
      const fade = Math.pow(1 - rawT, 1.35) * (0.65 + 0.35 * k)

      if (styleId === 'mercury') {
        // 1) 受冲边缘液态玻璃弯月面压缩光垫
        const cushionR = maxR * (0.34 + 0.28 * p)
        const grad = ctx.createRadialGradient(ox, oy, 2, ox, oy, cushionR)
        grad.addColorStop(0, isDark ? `rgba(255,255,255,${(0.46 * fade).toFixed(3)})` : `rgba(255,255,255,${(0.72 * fade).toFixed(3)})`)
        grad.addColorStop(0.32, `rgba(235,133,98,${(0.30 * fade).toFixed(3)})`)
        grad.addColorStop(0.65, `rgba(56,189,248,${(0.22 * fade).toFixed(3)})`)
        grad.addColorStop(1, 'rgba(56,189,248,0)')
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.arc(ox, oy, cushionR, baseAngle - Math.PI * 0.55, baseAngle + Math.PI * 0.55)
        ctx.closePath()
        ctx.fill()

        // 2) RGB 色散三折射谐波液面波（不同折射率产生真实液态玻璃彩边）
        const rings = [
          { r: maxR * (0.14 + 0.86 * p4), col: `rgba(255,126,95,${(0.46 * fade).toFixed(3)})`, lw: 2.8, wob: 10 },
          { r: maxR * (0.12 + 0.80 * p), col: `rgba(255,255,255,${(0.78 * fade).toFixed(3)})`, lw: 3.4, wob: 8 },
          { r: maxR * (0.10 + 0.74 * p), col: `rgba(56,189,248,${(0.52 * fade).toFixed(3)})`, lw: 2.4, wob: 11 },
          { r: maxR * (0.06 + 0.58 * p), col: `rgba(167,139,250,${(0.36 * fade).toFixed(3)})`, lw: 1.8, wob: 7 },
        ]
        for (const rg of rings) {
          ctx.strokeStyle = rg.col
          ctx.lineWidth = Math.max(0.8, rg.lw * (1 - rawT * 0.55))
          drawHarmonicArc(ctx, ox, oy, rg.r, baseAngle - spread, baseAngle + spread, rawT, rg.wob * (1 - rawT * 0.5), seed)
        }

        // 3) 飞溅液态玻璃微水珠（带表面张力白亮高光，末段平滑被玻璃回吸）
        for (const pt of particles) {
          const lt = Math.max(0, Math.min(1, (rawT - pt.delay) / (1 - pt.delay)))
          if (lt <= 0 || lt >= 1) continue
          const dist = pt.spd * easeOutQuart(lt) * (1 - lt * 0.14)
          const px = ox + Math.cos(pt.ang) * dist
          const py = oy + Math.sin(pt.ang) * dist + (lt * lt * 12)
          const rad = pt.size * Math.sin(lt * Math.PI) * (0.7 + 0.3 * k)
          if (rad < 0.6) continue
          const a = Math.sin(lt * Math.PI) * 0.85
          const dg = ctx.createRadialGradient(px - rad * 0.3, py - rad * 0.3, rad * 0.1, px, py, rad)
          dg.addColorStop(0, `rgba(255,255,255,${a.toFixed(3)})`)
          dg.addColorStop(0.55, pt.hueShift === 0 ? `rgba(120,210,255,${(a * 0.72).toFixed(3)})` : `rgba(244,148,112,${(a * 0.68).toFixed(3)})`)
          dg.addColorStop(1, 'rgba(255,255,255,0)')
          ctx.fillStyle = dg
          ctx.beginPath()
          ctx.arc(px, py, rad, 0, Math.PI * 2)
          ctx.fill()
        }
      } else if (styleId === 'prism') {
        // 棱镜极光折光：扇形晶体焦散光线 + 7 色彩虹折射弧 + Bokeh 光尘
        const spectral = [
          'rgba(244, 108, 86, ',
          'rgba(251, 186, 84, ',
          'rgba(116, 224, 166, ',
          'rgba(56, 189, 248, ',
          'rgba(147, 130, 255, ',
        ]
        // 扇形焦散光束
        const rayCount = 9
        for (let i = 0; i < rayCount; i++) {
          const u = (i / (rayCount - 1)) - 0.5
          const ang = baseAngle + u * Math.PI * 0.88 + Math.sin(rawT * 3 + i) * 0.04
          const len = maxR * (0.55 + 0.55 * p4) * (1 - Math.abs(u) * 0.35)
          const ex = ox + Math.cos(ang) * len
          const ey = oy + Math.sin(ang) * len
          const colBase = spectral[i % spectral.length]
          const lg = ctx.createLinearGradient(ox, oy, ex, ey)
          lg.addColorStop(0, `${colBase}${(0.44 * fade).toFixed(3)})`)
          lg.addColorStop(0.45, `rgba(255,255,255,${(0.32 * fade).toFixed(3)})`)
          lg.addColorStop(1, `${colBase}0)`)
          ctx.strokeStyle = lg
          ctx.lineWidth = (6.5 - Math.abs(u) * 3.5) * (1 - rawT * 0.4)
          ctx.beginPath()
          ctx.moveTo(ox, oy)
          ctx.lineTo(ex, ey)
          ctx.stroke()
        }
        // 光谱色散折射弧
        spectral.forEach((colBase, idx) => {
          const r = maxR * (0.16 + 0.78 * p) - idx * 6.5
          if (r < 6) return
          ctx.strokeStyle = `${colBase}${(0.42 * fade).toFixed(3)})`
          ctx.lineWidth = 3.2 * (1 - rawT * 0.45)
          ctx.beginPath()
          ctx.arc(ox, oy, r, baseAngle - spread, baseAngle + spread)
          ctx.stroke()
        })
        // 浮游光尘 Bokeh
        for (const pt of particles) {
          const lt = Math.max(0, Math.min(1, (rawT - pt.delay) / (1 - pt.delay)))
          if (lt <= 0 || lt >= 1) continue
          const dist = pt.spd * 0.92 * easeOutCubic(lt)
          const px = ox + Math.cos(pt.ang) * dist
          const py = oy + Math.sin(pt.ang) * dist
          const rad = pt.size * 1.35 * Math.sin(lt * Math.PI)
          ctx.fillStyle = `${spectral[pt.hueShift % spectral.length]}${(0.45 * Math.sin(lt * Math.PI)).toFixed(3)})`
          ctx.beginPath()
          ctx.arc(px, py, Math.max(1, rad), 0, Math.PI * 2)
          ctx.fill()
        }
      } else if (styleId === 'ripple') {
        // 禅意水滴涟漪：3 相位真实水面重力波 + 毛细余波 + 微气泡
        const waves = [
          { delay: 0.0, scale: 1.0, lw: 3.4, alpha: 0.82 },
          { delay: 0.14, scale: 0.82, lw: 2.4, alpha: 0.62 },
          { delay: 0.28, scale: 0.62, lw: 1.7, alpha: 0.44 },
        ]
        for (const wv of waves) {
          const lt = Math.max(0, Math.min(1, (rawT - wv.delay) / (1 - wv.delay)))
          if (lt <= 0) continue
          const r = maxR * wv.scale * easeOutCubic(lt)
          const wa = Math.pow(1 - lt, 1.3) * wv.alpha * (0.65 + 0.35 * k)
          // 亮波峰
          ctx.strokeStyle = `rgba(255,255,255,${wa.toFixed(3)})`
          ctx.lineWidth = Math.max(0.8, wv.lw * (1 - lt * 0.5))
          drawHarmonicArc(ctx, ox, oy, r, baseAngle - spread * 1.08, baseAngle + spread * 1.08, lt, 3.2, seed)
          // 暗波谷折射投影
          ctx.strokeStyle = isDark ? `rgba(56,189,248,${(wa * 0.55).toFixed(3)})` : `rgba(18,130,200,${(wa * 0.42).toFixed(3)})`
          ctx.lineWidth = Math.max(0.7, wv.lw * 0.75)
          drawHarmonicArc(ctx, ox, oy, Math.max(4, r - 4.5), baseAngle - spread * 1.05, baseAngle + spread * 1.05, lt, 2.8, seed)
        }
        // 微气泡柔和上浮
        for (const pt of particles.slice(0, 8)) {
          const lt = Math.max(0, Math.min(1, (rawT - pt.delay) / (1 - pt.delay)))
          if (lt <= 0 || lt >= 1) continue
          const dist = pt.spd * 0.45 * easeOutCubic(lt)
          const px = ox + Math.cos(pt.ang) * dist
          const py = oy + Math.sin(pt.ang) * dist - lt * 26
          const rad = pt.size * 0.9 * Math.sin(lt * Math.PI)
          if (rad < 0.8) continue
          ctx.strokeStyle = `rgba(255,255,255,${(0.72 * Math.sin(lt * Math.PI)).toFixed(3)})`
          ctx.lineWidth = 1.2
          ctx.beginPath()
          ctx.arc(px, py, rad, 0, Math.PI * 2)
          ctx.stroke()
        }
      } else if (styleId === 'crystal') {
        // 冰晶星芒切面：多边形折光菱面 + 旋转四角钻石星芒
        const facetR = maxR * (0.16 + 0.72 * p4)
        ctx.strokeStyle = `rgba(210,242,255,${(0.74 * fade).toFixed(3)})`
        ctx.lineWidth = 2.4 * (1 - rawT * 0.5)
        ctx.beginPath()
        const sides = 7
        for (let i = 0; i <= sides; i++) {
          const u = i / sides
          const ang = baseAngle - spread + spread * 2 * u
          const px = ox + Math.cos(ang) * facetR
          const py = oy + Math.sin(ang) * facetR
          if (i === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        }
        ctx.stroke()

        // 透明折射菱面 + 星芒迸射
        for (const pt of particles) {
          const lt = Math.max(0, Math.min(1, (rawT - pt.delay * 0.6) / (1 - pt.delay * 0.6)))
          if (lt <= 0 || lt >= 1) continue
          const dist = pt.spd * 0.88 * easeOutQuart(lt)
          const px = ox + Math.cos(pt.ang) * dist
          const py = oy + Math.sin(pt.ang) * dist
          const alpha = Math.sin(lt * Math.PI) * 0.92
          const starCol = pt.hueShift === 0 ? '#FFFFFF' : (pt.hueShift === 1 ? '#7DD3FC' : '#FCD34D')
          drawFourPointStar(ctx, px, py, pt.size * 1.9 * Math.sin(lt * Math.PI), pt.spin * lt * 2.4, alpha, starCol)
        }
      } else {
        // aurora：极光磁流体（三色柔和磁流体丝带波浪舒展）
        const ribbons = [
          { col: `rgba(212,101,62,${(0.46 * fade).toFixed(3)})`, off: 0, amp: 18, lw: 10 },
          { col: `rgba(56,189,248,${(0.42 * fade).toFixed(3)})`, off: 14, amp: 24, lw: 8 },
          { col: `rgba(167,139,250,${(0.36 * fade).toFixed(3)})`, off: 26, amp: 15, lw: 6 },
        ]
        const horiz = edge === 'left' || edge === 'right'
        for (const rb of ribbons) {
          ctx.strokeStyle = rb.col
          ctx.lineWidth = Math.max(1.5, rb.lw * (1 - rawT * 0.55))
          ctx.lineCap = 'round'
          ctx.beginPath()
          const segs = 30
          for (let i = 0; i <= segs; i++) {
            const u = i / segs
            const bell = Math.sin(u * Math.PI)
            const wave = Math.sin(u * Math.PI * 3 - rawT * 7 + seed) * rb.amp * bell * (1 - rawT * 0.35)
            const push = (maxR * 0.34 * p + rb.off) * bell
            if (horiz) {
              const py = h * (0.08 + 0.84 * u)
              const px = ox + nx * (push + wave)
              if (i === 0) ctx.moveTo(px, py)
              else ctx.lineTo(px, py)
            } else {
              const px = w * (0.08 + 0.84 * u)
              const py = oy + ny * (push + wave)
              if (i === 0) ctx.moveTo(px, py)
              else ctx.lineTo(px, py)
            }
          }
          ctx.stroke()
        }
      }

      raf = requestAnimationFrame(render)
    }

    raf = requestAnimationFrame(render)
    return () => {
      stopped = true
      if (raf) cancelAnimationFrame(raf)
      ctx.clearRect(0, 0, w, h)
    }
  }, [seq, edge, impactPct, styleId, strength, motionTier, theme])

  if (motionTier === 'reduced') return null
  return <canvas ref={canvasRef} className="lic-canvas" data-impact-style={styleId} aria-hidden="true" />
}
