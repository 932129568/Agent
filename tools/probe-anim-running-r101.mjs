// R101 T02 · 循环动画运行时普查：证明「静态 26 条」与「实际在跑」不是同一个数。
// 用法：node tools/probe-anim-running-r101.mjs
// 输出：实际存在 infinite 动画的元素清单（tag/class/id/动画名/是否可见）+ 计数。
// 为什么要这一步：A6 的 infinite-loops=26 是**静态声明计数**，
// 而 #auroraBg 在 base.css:16 就 display:none、legacy.css:2393 又清了 .au 的动画
// ⇒ 声明的循环不等于在跑的循环。判据的必要性计数必须用运行时的数核对。
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(pathToFileURL(path.join(ROOT, 'harbor.html')).href, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(2500)

const report = await page.evaluate(() => {
  const out = []
  const all = document.querySelectorAll('*')
  for (const el of all) {
    const anims = el.getAnimations ? el.getAnimations() : []
    for (const a of anims) {
      const eff = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : {}
      if (eff.iterations !== Infinity) continue
      const cs = getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      out.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        cls: (el.className && String(el.className).slice(0, 40)) || '',
        anim: (a.animationName || '') ,
        playState: a.playState,
        display: cs.display,
        visibility: cs.visibility,
        w: Math.round(rect.width), h: Math.round(rect.height),
        hasAmb: !!el.closest('[data-amb]'),
      })
    }
  }
  return { total: out.length, list: out }
})

let afterPause = null
try {
  afterPause = await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
    let stillRunning = 0, pausedCount = 0, ambCount = 0
    for (const el of document.querySelectorAll('*')) {
      const anims = el.getAnimations ? el.getAnimations() : []
      for (const a of anims) {
        const eff = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : {}
        if (eff.iterations !== Infinity) continue
        if (el.closest('[data-amb]')) ambCount++
        if (a.playState === 'paused') pausedCount++
        else stillRunning++
      }
    }
    return { ambCount, pausedCount, stillRunning, attr: document.documentElement.hasAttribute('data-amb-paused') }
  })
} catch (e) { afterPause = { error: String(e).slice(0, 160) } }

console.log(JSON.stringify({ runningInfinite: report.total, elemHasAmb: report.list.filter(x => x.hasAmb).length, list: report.list, afterPause }, null, 2))
await browser.close()
