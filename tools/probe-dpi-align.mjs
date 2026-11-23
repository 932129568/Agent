/* I30 · 网页侧的 DPI 对齐实测（原生层的 480→483px 回读本机做不到，这里测能测的）
 *
 * 手册 I30 要「480→483px 回读对齐」。原生层（窗口物理尺寸 vs 玻璃层像素）需要原生工具链；
 * 网页侧能测的对应物是：**在 DPR 1 / 1.5 / 2 下，关键布局边缘是否落在整数像素上**。
 * 半像素边缘会让 1px 描边变 2px 或消失 —— 这正是"回读不对齐"在 DOM 层的表现。
 *
 * 判据：每个边缘的 |frac| < 0.05（贴近整数）或 > 0.95（贴近下一个整数）。
 * 说明：这是**布局对齐**检验，不等于原生光学层对齐；后者仍 blocked。
 *
 * 运行：node tools/probe-dpi-align.mjs
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

const cdp = await page.context().newCDPSession(page)
const SEL = ['#mainStage', '.header', '#rail', '#chatInputArea', '.main']
const results = []

for (const dpr of [1, 1.5, 2]) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 860, deviceScaleFactor: dpr, mobile: false,
  })
  await page.waitForTimeout(350)
  const r = await page.evaluate((sels) => {
    const nearInt = (v) => { const f = Math.abs(v - Math.round(v)); return f < 0.05 };
    const out = []
    for (const s of sels) {
      const el = document.querySelector(s)
      if (!el) { out.push({ sel: s, missing: true }); continue }
      const b = el.getBoundingClientRect()
      const edges = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
      const bad = Object.keys(edges).filter(k => !nearInt(edges[k]))
      out.push({ sel: s, bad, edges: Object.fromEntries(Object.entries(edges).map(([k, v]) => [k, Math.round(v * 100) / 100])) })
    }
    return { dpr: window.devicePixelRatio, out }
  }, SEL)
  results.push(r)
}
await cdp.send('Emulation.clearDeviceMetricsOverride')
await browser.close()

let bad = []
for (const r of results) {
  for (const item of r.out) {
    if (item.missing) { bad.push('DPR' + r.dpr + ' 缺少元素 ' + item.sel); continue }
    if (item.bad.length) bad.push('DPR' + r.dpr + ' ' + item.sel + ' 半像素边缘: ' + item.bad.join(','))
  }
}
if (errs.length) bad.push('页面异常: ' + errs[0])

for (const r of results) {
  console.log('DPR ' + r.dpr + ': ' + r.out.map(o => o.sel + (o.missing ? '(缺)' : (o.bad.length ? '(' + o.bad.join(',') + ')' : ' ok'))).join(' | '))
}
if (bad.length) {
  console.log('DPI_ALIGN: FAIL')
  bad.forEach(x => console.log('  - ' + x))
  process.exit(1)
}
console.log('DPI_ALIGN: PASS (DPR 1/1.5/2 关键边缘均为整数像素)')
console.log('  说明：仅网页布局对齐；原生光学层 480→483px 回读仍需原生工具链')
