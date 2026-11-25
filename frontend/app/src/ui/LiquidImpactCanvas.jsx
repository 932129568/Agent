import { useEffect, useRef } from 'react'
import { motionScaleForTier } from '../platform/kinetic.js'
import { createOffscreenCanvas } from '../platform/dom.js'
import './LiquidImpactCanvas.css'

const GRID_W = 96
const GRID_H = 60

const MATERIAL_PHYSICS = {
  mercury: {
    c2: 0.23,       // 波速平方（CFL 稳定 < 0.45）
    damping: 0.962, // 真实厚液态玻璃黏弹性阻尼
    radius: 4.4,
    amp: 1.0,
    specPow: 12,
    specGain: 235,
    shadowGain: 92,
    caustic: 0.42,
    tintWarm: [242, 134, 96],
    tintCool: [94, 198, 250],
  },
  prism: {
    c2: 0.25,
    damping: 0.966,
    radius: 4.0,
    amp: 1.05,
    specPow: 14,
    specGain: 245,
    shadowGain: 88,
    caustic: 0.92,
    tintWarm: [255, 118, 92],
    tintCool: [72, 208, 255],
  },
  ripple: {
    c2: 0.27,
    damping: 0.976, // 低阻尼纯净水波：可真实撞到四边玻璃边界并弹回干涉
    radius: 3.4,
    amp: 0.96,
    specPow: 14,
    specGain: 240,
    shadowGain: 84,
    caustic: 0.24,
    tintWarm: [224, 244, 255],
    tintCool: [64, 180, 244],
  },
  crystal: {
    c2: 0.29,
    damping: 0.954,
    radius: 3.1,
    amp: 1.12,
    specPow: 18,
    specGain: 255,
    shadowGain: 98,
    caustic: 0.65,
    tintWarm: [230, 246, 255],
    tintCool: [125, 211, 252],
  },
  aurora: {
    c2: 0.19,       // 高黏度极光液态凝胶：缓慢厚重、柔润折射
    damping: 0.968,
    radius: 5.4,
    amp: 0.94,
    specPow: 10,
    specGain: 215,
    shadowGain: 80,
    caustic: 0.85,
    tintWarm: [228, 112, 86],
    tintCool: [132, 166, 255],
  },
}

/**
 * R25 真·二维流体波动方程 (2D Shallow-Water PDE) 液态玻璃光学引擎：
 * - 不再画「死板光波圈」：在 96×60 Float32 高度场网格上实时求解二维波动方程；
 * - 连续点击不同位置会同时叠加多组液态玻璃波，并在 4 条玻璃边界真实反射干涉；
 * - 每像素计算 3D 液面法线 N = (-∂h/∂x, -∂h/∂y, 1)，基于左上天光高光 + 背光折射暗影 + 陡坡色散焦散，呈现真实厚玻璃与液态折射体积感；
 * - 能量衰减到阈值立刻停止 rAF 并清屏，闲置 0% CPU。
 */
export default function LiquidImpactCanvas({
  seq = 0,
  nx = 0.04,
  ny = 0.5,
  styleId = 'mercury',
  strength = 'strong',
  motionTier = 'dynamic',
  theme = 'light',
}) {
  const canvasRef = useRef(null)
  const simRef = useRef(null)

  // 初始化持久化的 2D 流体高度场求解器（支持多点击波纹真实叠加与边界反射！）
  useEffect(() => {
    const size = GRID_W * GRID_H
    const offscreen = createOffscreenCanvas(GRID_W, GRID_H)
    const offCtx = offscreen ? offscreen.getContext('2d') : null
    simRef.current = {
      prev: new Float32Array(size),
      curr: new Float32Array(size),
      next: new Float32Array(size),
      offscreen,
      offCtx,
      imgData: offCtx ? offCtx.createImageData(GRID_W, GRID_H) : null,
      raf: 0,
      styleId: 'mercury',
      theme: 'light',
      k: 1,
      splashes: [], // 液态玻璃局部表面张力水珠微高光
    }
    return () => {
      if (simRef.current && simRef.current.raf) cancelAnimationFrame(simRef.current.raf)
      simRef.current = null
    }
  }, [])

  // 每次收到新的点击/撞击信号，在精确 (nx, ny) 注入真实的二维流体下压与折射冲击波
  useEffect(() => {
    const k = motionScaleForTier(motionTier)
    const canvas = canvasRef.current
    const sim = simRef.current
    if (!seq || !canvas || !sim || !sim.offCtx || !sim.imgData || k === 0 || typeof requestAnimationFrame !== 'function') {
      return
    }

    sim.styleId = MATERIAL_PHYSICS[styleId] ? styleId : 'mercury'
    sim.theme = theme
    sim.k = k

    const mat = MATERIAL_PHYSICS[sim.styleId]
    const cx = Math.max(2, Math.min(GRID_W - 3, Math.round((Number.isFinite(nx) ? nx : 0.04) * (GRID_W - 1))))
    const cy = Math.max(2, Math.min(GRID_H - 3, Math.round((Number.isFinite(ny) ? ny : 0.5) * (GRID_H - 1))))
    const power = (strength === 'strong' ? 1.0 : (strength === 'light' ? 0.52 : 0.78)) * mat.amp * (0.65 + 0.35 * k)
    const rad = Math.max(2.2, mat.radius * (strength === 'light' ? 0.78 : 1.0))
    const rCeil = Math.ceil(rad * 1.9)

    // 在精确点击点注入墨西哥帽型物理液面下凹 + 边缘凸起弯月面（瞬间激发真实液态重力波）
    for (let dy = -rCeil; dy <= rCeil; dy++) {
      const y = cy + dy
      if (y <= 1 || y >= GRID_H - 2) continue
      for (let dx = -rCeil; dx <= rCeil; dx++) {
        const x = cx + dx
        if (x <= 1 || x >= GRID_W - 2) continue
        const d2 = (dx * dx + dy * dy) / (rad * rad)
        if (d2 > 3.6) continue
        const profile = (1 - d2 * 0.72) * Math.exp(-d2 * 1.18)
        const idx = y * GRID_W + x
        sim.curr[idx] = Math.max(-2.6, Math.min(2.6, sim.curr[idx] - profile * 1.95 * power))
        sim.prev[idx] = Math.max(-2.6, Math.min(2.6, sim.prev[idx] - profile * 0.65 * power))
      }
    }

    // 记录本次点击点微玻璃焦散闪烁，强化点击瞬间触感反馈
    sim.splashes.push({
      nx: Math.max(0.02, Math.min(0.98, Number.isFinite(nx) ? nx : 0.04)),
      ny: Math.max(0.02, Math.min(0.98, Number.isFinite(ny) ? ny : 0.5)),
      t0: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      power,
      styleId: sim.styleId,
    })
    if (sim.splashes.length > 6) sim.splashes.shift()

    if (sim.raf) return // 求解器已在 60fps 运行，新波自动叠加干涉！

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const stepAndDraw = (now) => {
      if (!simRef.current) return
      sim.raf = 0
      const curMat = MATERIAL_PHYSICS[sim.styleId] || MATERIAL_PHYSICS.mercury
      const { prev, curr, next, offscreen, offCtx, imgData } = sim
      const c2 = curMat.c2
      const damp = curMat.damping

      // 1) 求解 2D 离散波动方程（带四边玻璃墙真实反射边界条件！）
      let energy = 0
      for (let y = 1; y < GRID_H - 1; y++) {
        const row = y * GRID_W
        for (let x = 1; x < GRID_W - 1; x++) {
          const i = row + x
          const lap = curr[i - 1] + curr[i + 1] + curr[i - GRID_W] + curr[i + GRID_W] - 4 * curr[i]
          const val = (2 * curr[i] - prev[i] + c2 * lap) * damp
          next[i] = val
          energy += Math.abs(val)
        }
      }
      // Neumann 自由液面玻璃墙反射边界：波撞到窗口四边真实反弹！
      for (let x = 1; x < GRID_W - 1; x++) {
        next[x] = next[GRID_W + x] * 0.72
        next[(GRID_H - 1) * GRID_W + x] = next[(GRID_H - 2) * GRID_W + x] * 0.72
      }
      for (let y = 1; y < GRID_H - 1; y++) {
        const r = y * GRID_W
        next[r] = next[r + 1] * 0.72
        next[r + GRID_W - 1] = next[r + GRID_W - 2] * 0.72
      }

      // 交换三缓冲（零 GC 分配）
      sim.prev = curr
      sim.curr = next
      sim.next = prev

      // 清理过期点击微焦散
      sim.splashes = sim.splashes.filter((sp) => (now - sp.t0) < 420)

      const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
      const cw = Math.max(1, canvas.clientWidth)
      const ch = Math.max(1, canvas.clientHeight)
      const tw = Math.round(cw * dpr)
      const th = Math.round(ch * dpr)
      if (canvas.width !== tw || canvas.height !== th) {
        canvas.width = tw
        canvas.height = th
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cw, ch)

      // 能量耗尽：清空缓冲并彻底停止 rAF（闲置 0% CPU）
      if (energy < 0.85 && sim.splashes.length === 0) {
        sim.prev.fill(0)
        sim.curr.fill(0)
        sim.next.fill(0)
        return
      }

      // 2) 基于真实 3D 液面法线的液态玻璃光学着色（高光 + 厚度背光暗影 + 菲涅尔微色散）
      const px = imgData.data
      const hBuf = sim.curr
      const isDark = sim.theme === 'dark'
      const [wr, wg, wb] = curMat.tintWarm
      const [cr, cg, cb] = curMat.tintCool
      const specGain = curMat.specGain * (isDark ? 0.92 : 1.0)
      const shadowGain = curMat.shadowGain * (isDark ? 0.85 : 1.0)
      const caustic = curMat.caustic

      for (let y = 1; y < GRID_H - 1; y++) {
        const row = y * GRID_W
        for (let x = 1; x < GRID_W - 1; x++) {
          const i = row + x
          const gx = (hBuf[i + 1] - hBuf[i - 1]) * 2.2
          const gy = (hBuf[i + GRID_W] - hBuf[i - GRID_W]) * 2.2
          const slope2 = gx * gx + gy * gy
          const p4 = i * 4
          if (slope2 < 0.00025) {
            px[p4 + 3] = 0
            continue
          }
          const slope = Math.sqrt(slope2)
          // 左上天光方向 L = (-0.64, -0.72) 与液面法线 (-gx, -gy) 点积
          const lightDot = (-gx * -0.64) + (-gy * -0.72) // 正值：迎光面亮高光；负值：背光面玻璃折射厚影
          const rim = Math.min(1, slope * 1.45)

          let r = 255
          let g = 255
          let b = 255
          let a = 0

          if (lightDot > 0) {
            // 迎光液态玻璃弯月面：清透白亮镜面高光 + 极微妙暖色棱镜色散
            const spec = Math.min(1, Math.pow(Math.min(1, lightDot * 1.45), 1.55))
            const sharp = Math.min(1, Math.pow(Math.min(1, lightDot * 1.3), 4.2))
            const cMix = caustic * rim * (1 - sharp) * 0.52
            r = 255 * (1 - cMix) + wr * cMix
            g = 255 * (1 - cMix) + wg * cMix
            b = 255 * (1 - cMix) + wb * cMix
            a = Math.min(225, (spec * specGain * 0.62 + sharp * specGain * 0.55) * (0.7 + 0.3 * sim.k))
          } else {
            // 背光液态玻璃厚度暗影 + 冷青折射焦散（正是这层明暗对偶赋予真实的「玻璃厚度」和「液态体积感」！）
            const sh = Math.min(1, Math.pow(Math.min(1, -lightDot * 1.55), 1.4))
            const cMix = caustic * 0.55
            const baseR = isDark ? 12 : 24
            const baseG = isDark ? 26 : 44
            const baseB = isDark ? 46 : 72
            r = baseR * (1 - cMix) + cr * cMix
            g = baseG * (1 - cMix) + cg * cMix
            b = baseB * (1 - cMix) + cb * cMix
            a = Math.min(148, sh * shadowGain * (0.75 + 0.25 * sim.k))
          }

          px[p4] = r
          px[p4 + 1] = g
          px[p4 + 2] = b
          px[p4 + 3] = a
        }
      }

      offCtx.putImageData(imgData, 0, 0)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(offscreen, 0, 0, cw, ch)

      // 3) 精确点击点瞬时液态玻璃透镜折射高光（水滴入水那一刻的锐利玻璃微折射点）
      for (const sp of sim.splashes) {
        const lt = Math.min(1, Math.max(0, (now - sp.t0) / 380))
        const fade = Math.pow(1 - lt, 1.8) * sp.power
        const sx = sp.nx * cw
        const sy = sp.ny * ch
        const radPx = (14 + 62 * (1 - Math.pow(1 - lt, 3))) * sp.power
        const g = ctx.createRadialGradient(sx - radPx * 0.16, sy - radPx * 0.16, 1, sx, sy, radPx)
        g.addColorStop(0, `rgba(255,255,255,${(0.62 * fade).toFixed(3)})`)
        g.addColorStop(0.45, `rgba(255,255,255,${(0.16 * fade).toFixed(3)})`)
        g.addColorStop(0.76, `rgba(110,204,255,${(0.14 * fade).toFixed(3)})`)
        g.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(sx, sy, radPx, 0, Math.PI * 2)
        ctx.fill()
      }

      sim.raf = requestAnimationFrame(stepAndDraw)
    }

    sim.raf = requestAnimationFrame(stepAndDraw)
  }, [seq, nx, ny, styleId, strength, motionTier, theme])

  if (motionTier === 'reduced') return null
  return <canvas ref={canvasRef} className="lic-canvas" data-impact-style={styleId} aria-hidden="true" />
}
