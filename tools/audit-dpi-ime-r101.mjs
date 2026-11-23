// R101 T04 · B2 异 DPI / B3 中文 IME —— 网页层实测（CDP，不是合成事件）
//
// 与 BLOCKED.md 的关系：那两份说明写的是「本机取不到」。
// 现在把能取到的部分取到，并把**取不到的部分**继续明确留在 blocked 里：
//   B2：CDP Emulation.setDeviceMetricsOverride 能真实改变 devicePixelRatio 并触发浏览器
//       重排 —— 这覆盖「网页层在 DPI 变化下的布局稳定性」。
//       它**不覆盖** OS 级 per-monitor DPI 切换（WM_DPICHANGED）与原生玻璃层的像素对齐。
//   B3：CDP Input.imeSetComposition / insertText 走的是浏览器**真实输入管线**
//       （不是 dispatch 合成事件），会真实产生 compositionstart/update/end 与输入框重排。
//       它**不覆盖**系统输入法候选窗的绘制与遮挡（那在浏览器进程之外）。
//
// 判据：
//   B2-1 DPR 真的变了（否则后面全是在同一缩放上测，假绿）
//   B2-2 三种 DPR 下都不出现横向溢出（scrollWidth <= clientWidth + 1）
//   B2-3 三种 DPR 下主容器宽度一致（±2px）——DPI 不该改变 CSS 像素尺寸
//   B3-1 组合期间 textarea 高度不跳变（与组合前的差 <= 1px）
//   B3-2 组合事件顺序必须是 start -> update* -> end（乱序即红）
//   B3-3 上屏后输入框内容等于插入的文本，且光标在末尾
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(pathToFileURL(path.join(ROOT, 'server', 'package.json')).href)
const { chromium } = require('playwright-core')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS

const browser = await chromium.launch({ channel: 'msedge', headless: true, env, args: ['--allow-file-access-from-files'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
await page.goto(pathToFileURL(path.join(ROOT, 'harbor.html')).href, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(6500)
const skip = await page.$('#obSkip')
if (skip) { await skip.click(); await page.waitForTimeout(600) }

const checks = []
const push = (ok, name, detail) => checks.push({ ok, name, detail: detail || '' })

// ── B2：DPI 变化下的网页层布局 ─────────────────────────────────────────────
const cdp = await page.context().newCDPSession(page)
const dprSamples = []
for (const dsf of [1, 1.5, 2]) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 860, deviceScaleFactor: dsf, mobile: false,
  })
  await page.waitForTimeout(350)
  const s = await page.evaluate(() => {
    const de = document.documentElement
    const main = document.querySelector('.main') || document.body
    const r = main.getBoundingClientRect()
    return {
      dpr: window.devicePixelRatio,
      overflow: de.scrollWidth - de.clientWidth,
      mainW: Math.round(r.width),
      mainX: Math.round(r.x),
      negOffset: Math.min(0, Math.round(r.left)) ,
    }
  })
  dprSamples.push({ dsf, ...s })
}
const dprs = dprSamples.map((s) => s.dpr)
push(new Set(dprs).size === 3, 'B2-1 DPR 真的按 1/1.5/2 变化', JSON.stringify(dprs))
push(dprSamples.every((s) => s.overflow <= 1), 'B2-2 三种 DPR 下无横向溢出',
  dprSamples.map((s) => 'ovf=' + s.overflow).join(' '))
const widths = dprSamples.map((s) => s.mainW)
push(Math.max(...widths) - Math.min(...widths) <= 2, 'B2-3 主容器 CSS 宽度不随 DPR 变',
  widths.join(' / '))
// 还原
await cdp.send('Emulation.clearDeviceMetricsOverride')
await page.waitForTimeout(250)

// ── B3：真实输入管线的中文组合 ─────────────────────────────────────────────
const ime = await page.evaluate(async () => {
  const out = { events: [], steps: {} }
  const ia = document.getElementById('chatInputArea')
  if (ia) { ia.hidden = false; ia.style.display = '' }
  const ta = document.getElementById('userInput')
  if (!ta) return { fatal: 'no #userInput' }
  ta.focus()
  ta.value = ''
  out.steps.before = Math.round(ta.getBoundingClientRect().height)
  const rec = (t) => out.events.push(t)
  ta.addEventListener('compositionstart', () => rec('start'))
  ta.addEventListener('compositionupdate', () => rec('update'))
  ta.addEventListener('compositionend', () => rec('end'))
  window.__imeProbe = out
  return { ok: true, heightBefore: out.steps.before }
})
if (ime.fatal) {
  push(false, 'B3-0 找到输入框', ime.fatal)
} else {
  // 真实 IME 组合：先起组合，再逐次更新，最后上屏
  await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
  await page.waitForTimeout(120)
  await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 })
  await page.waitForTimeout(120)
  const during = await page.evaluate(() => {
    const ta = document.getElementById('userInput')
    return { h: Math.round(ta.getBoundingClientRect().height), v: ta.value, composing: !!ta.__composing }
  })
  await cdp.send('Input.insertText', { text: '中文' })
  await page.waitForTimeout(150)
  const after = await page.evaluate(() => {
    const ta = document.getElementById('userInput')
    return {
      h: Math.round(ta.getBoundingClientRect().height),
      v: ta.value,
      caret: ta.selectionStart,
      events: (window.__imeProbe && window.__imeProbe.events) || [],
      steps: (window.__imeProbe && window.__imeProbe.steps) || {},
    }
  })
  const startH = after.steps.before
  push(Math.abs(during.h - startH) <= 1, 'B3-1 组合期间输入框高度不跳变',
    `before=${startH} during=${during.h} after=${after.h}`)
  const ev = after.events
  const seqOk = ev.indexOf('start') === 0 &&
    ev.lastIndexOf('end') === ev.length - 1 &&
    ev.filter((x) => x === 'start').length === 1
  push(seqOk, 'B3-2 组合事件顺序 start→update*→end', JSON.stringify(ev))
  push(after.v === '中文' && after.caret === 2, 'B3-3 上屏内容与光标正确',
    JSON.stringify({ v: after.v, caret: after.caret }))
}

const ok = checks.every((c) => c.ok)
for (const c of checks) console.log('%s %s%s', c.ok ? 'PASS' : 'FAIL', c.name, (c.ok || !c.detail) ? '' : ' -> ' + c.detail)
console.log('')
console.log('B2B3_WEBLAYER: %s (%d/%d) 环境=msedge headless 1280x860 单批', ok ? 'PASS' : 'FAIL',
  checks.filter((c) => c.ok).length, checks.length)
console.log('注：本脚本证明的是**网页层**；原生玻璃层像素对齐与系统候选窗遮挡仍为 blocked。')
await browser.close()
process.exit(ok ? 0 : 1)
