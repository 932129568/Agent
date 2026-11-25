import { useEffect, useRef, useState } from 'react'
import { motionScaleForTier } from '../platform/kinetic.js'
import { createOffscreenCanvas } from '../platform/dom.js'
import './LiquidImpactCanvas.css'

const GRID_W = 120
const GRID_H = 72
const MATERIAL_PHYSICS = {
  mercury: { c2: 0.22, damping: 0.966, radius: 4.8, amp: 1.08, specGain: 248, shadowGain: 118, caustic: 0.26, tintWarm: [248, 224, 214], tintCool: [176, 224, 248] },
  prism:   { c2: 0.24, damping: 0.970, radius: 4.3, amp: 1.12, specGain: 254, shadowGain: 110, caustic: 0.74, tintWarm: [255, 168, 138], tintCool: [110, 214, 255] },
  ripple:  { c2: 0.27, damping: 0.980, radius: 3.6, amp: 1.04, specGain: 250, shadowGain: 104, caustic: 0.16, tintWarm: [236, 248, 255], tintCool: [120, 198, 244] },
  crystal: { c2: 0.29, damping: 0.958, radius: 3.4, amp: 1.18, specGain: 255, shadowGain: 122, caustic: 0.46, tintWarm: [242, 250, 255], tintCool: [152, 222, 255] },
  aurora:  { c2: 0.19, damping: 0.972, radius: 5.8, amp: 1.02, specGain: 228, shadowGain: 100, caustic: 0.62, tintWarm: [240, 152, 128], tintCool: [148, 184, 255] },
}

export default function LiquidImpactCanvas({
  seq = 0, nx = 0.04, ny = 0.5, styleId = 'mercury', strength = 'strong', motionTier = 'dynamic', theme = 'light',
}) {
  const canvasRef = useRef(null)
  const simRef = useRef(null)
  const [orb, setOrb] = useState(null)

  useEffect(() => {
    const size = GRID_W * GRID_H
    const offscreen = createOffscreenCanvas(GRID_W, GRID_H)
    const offCtx = offscreen ? offscreen.getContext('2d') : null
    simRef.current = {
      prev: new Float32Array(size), curr: new Float32Array(size), next: new Float32Array(size),
      offscreen, offCtx, imgData: offCtx ? offCtx.createImageData(GRID_W, GRID_H) : null,
      raf: 0, styleId: 'mercury', theme: 'light', k: 1, lenses: [],
    }
    return () => { if (simRef.current && simRef.current.raf) cancelAnimationFrame(simRef.current.raf); simRef.current = null }
  }, [])

  useEffect(() => {
    const k = motionScaleForTier(motionTier)
    const canvas = canvasRef.current
    const sim = simRef.current
    if (!seq || !canvas || !sim || !sim.offCtx || !sim.imgData || k === 0 || typeof requestAnimationFrame !== 'function') return undefined

    sim.styleId = MATERIAL_PHYSICS[styleId] ? styleId : 'mercury'
    sim.theme = theme
    sim.k = k

    const mat = MATERIAL_PHYSICS[sim.styleId]
    const safeNx = Math.max(0.01, Math.min(0.99, Number.isFinite(nx) ? nx : 0.04))
    const safeNy = Math.max(0.01, Math.min(0.99, Number.isFinite(ny) ? ny : 0.5))
    const cx = Math.max(2, Math.min(GRID_W - 3, Math.round(safeNx * (GRID_W - 1))))
    const cy = Math.max(2, Math.min(GRID_H - 3, Math.round(safeNy * (GRID_H - 1))))
    const power = (strength === 'strong' ? 1.1 : (strength === 'light' ? 0.64 : 0.86)) * mat.amp * (0.68 + 0.32 * k)
    const rad = Math.max(2.4, mat.radius * (strength === 'light' ? 0.82 : 1.0))
    const rCeil = Math.ceil(rad * 1.9)

    setOrb({ key: seq, left: `${(safeNx * 100).toFixed(2)}vw`, top: `${(safeNy * 100).toFixed(2)}vh` })
    const clearOrbTimer = setTimeout(() => setOrb((prev) => (prev && prev.key === seq ? null : prev)), 450)

    for (let dy = -rCeil; dy <= rCeil; dy++) {
      const y = cy + dy
      if (y <= 1 || y >= GRID_H - 2) continue
      for (let dx = -rCeil; dx <= rCeil; dx++) {
        const x = cx + dx
        if (x <= 1 || x >= GRID_W - 2) continue
        const d2 = (dx * dx + dy * dy) / (rad * rad)
        if (d2 > 3.6) continue
        const profile = (1 - d2 * 0.74) * Math.exp(-d2 * 1.12)
        const idx = y * GRID_W + x
        sim.curr[idx] = Math.max(-2.9, Math.min(2.9, sim.curr[idx] - profile * 2.15 * power))
        sim.prev[idx] = Math.max(-2.9, Math.min(2.9, sim.prev[idx] - profile * 0.72 * power))
      }
    }

    sim.lenses.push({ nx: safeNx, ny: safeNy, t0: typeof performance !== 'undefined' ? performance.now() : Date.now(), power })
    if (sim.lenses.length > 8) sim.lenses.shift()

    if (!sim.raf) {
      const ctx = canvas.getContext('2d')
      if (ctx) {
        const stepAndDraw = (now) => {
          if (!simRef.current) return
          sim.raf = 0
          const curMat = MATERIAL_PHYSICS[sim.styleId] || MATERIAL_PHYSICS.mercury
          const { prev, curr, next, offscreen, offCtx, imgData } = sim
          let energy = 0
          for (let y = 1; y < GRID_H - 1; y++) {
            const row = y * GRID_W
            for (let x = 1; x < GRID_W - 1; x++) {
              const i = row + x
              const lap = curr[i - 1] + curr[i + 1] + curr[i - GRID_W] + curr[i + GRID_W] - 4 * curr[i]
              const val = (2 * curr[i] - prev[i] + curMat.c2 * lap) * curMat.damping
              next[i] = val
              energy += Math.abs(val)
            }
          }
          for (let x = 1; x < GRID_W - 1; x++) { next[x] = next[GRID_W + x] * 0.76; next[(GRID_H - 1) * GRID_W + x] = next[(GRID_H - 2) * GRID_W + x] * 0.76 }
          for (let y = 1; y < GRID_H - 1; y++) { const r = y * GRID_W; next[r] = next[r + 1] * 0.76; next[r + GRID_W - 1] = next[r + GRID_W - 2] * 0.76 }
          sim.prev = curr; sim.curr = next; sim.next = prev
          sim.lenses = sim.lenses.filter((sp) => (now - sp.t0) < 480)

          const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
          const cw = Math.max(1, canvas.clientWidth)
          const ch = Math.max(1, canvas.clientHeight)
          const tw = Math.round(cw * dpr), th = Math.round(ch * dpr)
          if (canvas.width !== tw || canvas.height !== th) { canvas.width = tw; canvas.height = th }
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
          ctx.clearRect(0, 0, cw, ch)

          if (energy < 0.9 && sim.lenses.length === 0) { sim.prev.fill(0); sim.curr.fill(0); sim.next.fill(0); return }

          const px = imgData.data, hBuf = sim.curr, isDark = sim.theme === 'dark'
          const [wr, wg, wb] = curMat.tintWarm, [cr, cg, cb] = curMat.tintCool
          const specGain = curMat.specGain * (isDark ? 0.95 : 1.0), shadowGain = curMat.shadowGain * (isDark ? 0.92 : 1.0), caustic = curMat.caustic
          for (let y = 1; y < GRID_H - 1; y++) {
            const row = y * GRID_W
            for (let x = 1; x < GRID_W - 1; x++) {
              const i = row + x
              const gx = (hBuf[i + 1] - hBuf[i - 1]) * 2.5, gy = (hBuf[i + GRID_W] - hBuf[i - GRID_W]) * 2.5
              const slope2 = gx * gx + gy * gy, p4 = i * 4
              if (slope2 < 0.0002) { px[p4 + 3] = 0; continue }
              const slope = Math.sqrt(slope2), lightDot = (-gx * -0.66) + (-gy * -0.75), fresnel = Math.min(1, slope * 1.7)
              let r = 255, g = 255, b = 255, a = 0
              if (lightDot > 0) {
                const spec = Math.min(1, Math.pow(Math.min(1, lightDot * 1.55), 1.42))
                const glint = Math.min(1, Math.pow(Math.min(1, lightDot * 1.4), 5.0))
                const cMix = caustic * fresnel * (1 - glint) * 0.42
                r = 255 * (1 - cMix) + wr * cMix; g = 255 * (1 - cMix) + wg * cMix; b = 255 * (1 - cMix) + wb * cMix
                a = Math.min(242, (spec * specGain * 0.58 + glint * specGain * 0.72) * (0.72 + 0.28 * sim.k))
              } else {
                const sh = Math.min(1, Math.pow(Math.min(1, -lightDot * 1.68), 1.3))
                const cMix = caustic * 0.40
                r = (isDark ? 6 : 14) * (1 - cMix) + cr * cMix; g = (isDark ? 16 : 30) * (1 - cMix) + cg * cMix; b = (isDark ? 32 : 56) * (1 - cMix) + cb * cMix
                a = Math.min(172, sh * shadowGain * (0.76 + 0.24 * sim.k))
              }
              px[p4] = r; px[p4 + 1] = g; px[p4 + 2] = b; px[p4 + 3] = a
            }
          }
          offCtx.putImageData(imgData, 0, 0)
          ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
          ctx.drawImage(offscreen, 0, 0, cw, ch)
          for (const sp of sim.lenses) {
            const lt = Math.min(1, Math.max(0, (now - sp.t0) / 460))
            const ease = 1 - Math.pow(1 - lt, 3), fade = Math.pow(1 - lt, 1.5) * sp.power
            const sx = sp.nx * cw, sy = sp.ny * ch, rPx = (12 + 64 * ease) * sp.power
            ctx.save()
            ctx.strokeStyle = `rgba(255,255,255,${(0.82 * fade).toFixed(3)})`
            ctx.lineWidth = Math.max(1, 2.8 * (1 - lt * 0.6))
            ctx.beginPath(); ctx.arc(sx, sy, rPx, Math.PI * 0.84, Math.PI * 1.92); ctx.stroke()
            ctx.strokeStyle = isDark ? `rgba(8,18,36,${(0.58 * fade).toFixed(3)})` : `rgba(14,32,64,${(0.36 * fade).toFixed(3)})`
            ctx.lineWidth = Math.max(1, 2.4 * (1 - lt * 0.6))
            ctx.beginPath(); ctx.arc(sx, sy, Math.max(4, rPx - 1.6), -Math.PI * 0.08, Math.PI * 0.84); ctx.stroke()
            ctx.restore()
          }
          sim.raf = requestAnimationFrame(stepAndDraw)
        }
        sim.raf = requestAnimationFrame(stepAndDraw)
      }
    }
    return () => clearTimeout(clearOrbTimer)
  }, [seq, nx, ny, styleId, strength, motionTier, theme])

  if (motionTier === 'reduced') return null
  return (
    <>
      <svg className="lic-svg-defs" aria-hidden="true" focusable="false">
        <defs>
          <filter id="harbor-liquid-glass-lens" x="-5%" y="-5%" width="110%" height="110%">
            <feTurbulence type="fractalNoise" baseFrequency="0.012 0.018" numOctaves="2" seed="7" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="4.5" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
      </svg>
      <canvas ref={canvasRef} className="lic-canvas" data-impact-style={styleId} data-viewport-fx="true" aria-hidden="true" />
      {orb && <span key={orb.key} className="lic-lens-orb" style={{ left: orb.left, top: orb.top }} aria-hidden="true" />}
    </>
  )
}
