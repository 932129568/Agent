/* v3.4 I29 · 帧预算实测（165Hz 判据的可测部分）
 *
 * 判据（施工总册 I29）：165Hz 满帧流畅，正文阅读面严守稳态不晕字。
 *
 * 本机**不可能**证明 165Hz：
 *   · headless Chromium 通常走软件合成，屏幕刷新率也不是 165Hz；
 *   · 这里测出的 rAF 间隔反映的是"本环境的合成能力"，不是真机面板。
 * 所以本工具**不宣称满帧**，只做三件事：
 *   ① 在真实动画期间采样 rAF 间隔，给出 p50 / p95 / 最大值；
 *   ② 统计"长帧"（> 2 帧预算）比例 —— 这是卡顿的直接指标；
 *   ③ 把结果打成一行可对比的基线，供真机复跑时同一口径比较。
 *
 * 阈值只用来抓**病态**（p95 > 50ms 或长帧 > 20%），不是用来证明流畅。
 * 运行：node tools/probe-frame-budget.mjs
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
  const deltas = []
  let last = performance.now()
  let stop = false
  const tick = (t) => {
    if (stop) return
    deltas.push(t - last)
    last = t
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  // 采样窗口内主动制造动画：开关副屏（含 transform/max-width 过渡）
  await new Promise(r => setTimeout(r, 100))
  try { contextDockOpen() } catch (e) {}
  await new Promise(r => setTimeout(r, 600))
  try { contextDockClose() } catch (e) {}
  await new Promise(r => setTimeout(r, 700))
  stop = true
  const arr = deltas.filter(d => d > 0).sort((a, b) => a - b)
  const q = (p) => arr.length ? +arr[Math.min(arr.length - 1, Math.floor(arr.length * p))].toFixed(2) : 0
  const budget60 = 1000 / 60
  const budget165 = 1000 / 165
  const long = deltas.filter(d => d > budget60 * 2).length
  return {
    samples: deltas.length,
    p50: q(0.5), p95: q(0.95), max: +(arr[arr.length - 1] || 0).toFixed(2),
    longFrames: long, longRatio: +(long / Math.max(1, deltas.length)).toFixed(3),
    budget165ms: +budget165.toFixed(2),
  }
})
await browser.close()

const bad = []
if (r.samples < 30) bad.push('采样帧数不足（' + r.samples + '）')
if (r.p95 > 50) bad.push('p95 帧间隔 ' + r.p95 + 'ms > 50ms（病态卡顿）')
if (r.longRatio > 0.2) bad.push('长帧比例 ' + (r.longRatio * 100).toFixed(1) + '% > 20%（病态卡顿）')
if (errs.length) bad.push('页面异常: ' + errs[0])

const line = JSON.stringify(r)
if (bad.length) {
  console.log('FRAME_BUDGET: FAIL')
  bad.forEach(x => console.log('  - ' + x))
  console.log('  ' + line)
  process.exit(1)
}
console.log('FRAME_BUDGET: 采样完成（本环境非 165Hz，不作满帧结论）')
console.log('  ' + line)
console.log('  说明：判据要求真机 165Hz；本工具只给出同口径基线，真机复跑可直接对比。')
