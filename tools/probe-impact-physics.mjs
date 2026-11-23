/* I28 · 碰撞余震的**物理量**实测（不靠人眼"手感"）
 *
 * 手册 I28 要求「四级质量体、动量传导、tanh 软限幅与防眩晕铁律」。
 * "手感"不能自动判，但它的**可观测后果**可以：
 *   ① 峰值位移必须被软限幅夹住（≤ preset.maxPx + 容差）
 *   ② 必须在有限时间内收敛（< 900ms 回到亚像素）
 *   ③ 过冲次数受限（防眩晕：来回摆动次数 ≤ 2）
 *   ④ 不得留下残余位移（收敛后 |offset| < 0.5px）
 *
 * 采法：切一次面板触发 impulse，用 rAF 逐帧读 .main 的 computed transform matrix，
 * 取 translate 分量作为位移曲线。
 *
 * 运行：node tools/probe-impact-physics.mjs
 */
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'

const ROOT = 'C:/v4h/proj'
const require = createRequire(pathToFileURL(path.join(ROOT, 'server', 'package.json')).href)
const { chromium } = require('playwright-core')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS

const browser = await chromium.launch({ channel: 'msedge', headless: true, env, args: ['--allow-file-access-from-files'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
const errs = []
page.on('pageerror', e => errs.push(e.message))
await page.goto(pathToFileURL(path.join(ROOT, 'harbor.html')).href, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(6500)

const r = await page.evaluate(async () => {
  // 读 #mainStage：.main 有 v4ChipIn(fill:both)，会覆盖内联 transform，
  // 在 .main 上测永远得到 identity（第一版就是这么测出"没动"的假结论）。
  const main = document.getElementById('mainStage') || document.querySelector('.main')
  // translate3d 在 computed style 里是 matrix3d（t_x 在索引 12），
  // 只匹配 matrix( 会得到恒 0 —— 我第一次就是这么测出"没动"的假结论。
  const readX = () => {
    const t = getComputedStyle(main).transform
    if (!t || t === 'none') return 0
    const m3 = t.match(/matrix3d\(([^)]+)\)/)
    if (m3) { const v = m3[1].split(',').map(Number); return Number.isFinite(v[12]) ? v[12] : 0 }
    const m2 = t.match(/matrix\(([^)]+)\)/)
    if (m2) { const v = m2[1].split(',').map(Number); return Number.isFinite(v[4]) ? v[4] : 0 }
    return 0
  }
  const samples = []
  let stop = false
  const t0 = performance.now()
  const tick = () => {
    if (stop) return
    samples.push({ t: performance.now() - t0, x: readX() })
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  await new Promise(r => setTimeout(r, 60))
  switchPanel('analytics')
  await new Promise(r => setTimeout(r, 1200))
  stop = true

  const xs = samples.map(s => s.x)
  const peak = xs.reduce((a, b) => Math.abs(b) > Math.abs(a) ? b : a, 0)
  // 过冲：符号变化次数（去掉零值噪声，阈值 0.15px）
  let sign = 0, overshoot = 0
  for (const x of xs) {
    if (Math.abs(x) < 0.15) continue
    const s = Math.sign(x)
    if (sign && s !== sign) overshoot++
    sign = s
  }
  // 收敛时间：最后一次 |x| >= 0.5px 的时刻
  let settleAt = 0
  samples.forEach(s => { if (Math.abs(s.x) >= 0.5) settleAt = s.t })
  const last = xs.length ? xs[xs.length - 1] : 0
  return {
    frames: samples.length,
    peakAbs: Math.round(Math.abs(peak) * 100) / 100,
    overshoot,
    settleMs: Math.round(settleAt),
    residual: Math.round(Math.abs(last) * 100) / 100,
    // 软限幅配置（panels.js 里 preset.maxPx: 5）
    presetMaxPx: 5,
  }
})
await browser.close()

const bad = []
if (r.frames < 20) bad.push('采样帧数不足: ' + r.frames)
if (r.peakAbs > r.presetMaxPx + 1) bad.push('峰值位移 ' + r.peakAbs + 'px 超出软限幅 ' + r.presetMaxPx + 'px')
if (r.peakAbs < 0.3) bad.push('峰值位移 ' + r.peakAbs + 'px 过小（等于没动）')
if (r.settleMs > 900) bad.push('收敛时间 ' + r.settleMs + 'ms > 900ms')
if (r.overshoot > 2) bad.push('过冲次数 ' + r.overshoot + ' > 2（防眩晕铁律）')
if (r.residual >= 0.5) bad.push('残留位移 ' + r.residual + 'px 未归零')
if (errs.length) bad.push('页面异常: ' + errs[0])

console.log(JSON.stringify(r))
if (bad.length) {
  console.log('IMPACT_PHYSICS: FAIL')
  bad.forEach(x => console.log('  - ' + x))
  process.exit(1)
}
console.log('IMPACT_PHYSICS: PASS (峰值 ' + r.peakAbs + 'px ≤ 限幅 ' + r.presetMaxPx +
  ' · 收敛 ' + r.settleMs + 'ms · 过冲 ' + r.overshoot + ' 次 · 残余 ' + r.residual + 'px)')
