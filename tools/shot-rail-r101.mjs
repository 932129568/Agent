// R101 T02 · Rail 目视验收：加载 harbor.html，截图 Rail 与设置窗关闭钮，供人眼核对。
// 用法：node tools/shot-rail-r101.mjs [outDir]
// 依赖：server/node_modules/playwright-core（用其自带的 chrome/edge 通道或系统 Edge）。
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'

// 必须用 fileURLToPath 取真实磁盘路径：URL().pathname 中文会被百分号编码，
// createRequire 拿编码后的路径会 MODULE_NOT_FOUND（本仓实测）。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(pathToFileURL(path.join(ROOT, 'server', 'package.json')).href)
const { chromium } = require('playwright-core')

const outDir = process.argv[2] || path.join(process.env.TEMP || '.', 'r101-shots')
fs.mkdirSync(outDir, { recursive: true })

const fileUrl = pathToFileURL(path.join(ROOT, 'harbor.html')).href

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  env,
  args: ['--allow-file-access-from-files', '--force-device-scale-factor=1'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()) })

await page.goto(fileUrl, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(2500)

const info = await page.evaluate(() => {
  const rail = document.querySelector('#rail')
  const btns = rail ? Array.from(rail.querySelectorAll('button')) : []
  const panels = Array.from(document.querySelectorAll('.panel')).map(p => ({ id: p.id, on: p.classList.contains('on') }))
  return {
    renderMode: document.documentElement.dataset.harborRender || '(none)',
    railFound: !!rail,
    railButtons: btns.map(b => ({
      cls: b.className,
      id: b.id || '',
      panel: b.getAttribute('data-panel') || '',
      tip: b.getAttribute('data-tip') || '',
    })),
    panels,
    setWinClose: document.querySelectorAll('.set-win-close').length,
    sidebarSessionsBtn: !!document.querySelector('.side-actions button[onclick*="sessions"]'),
    analyticsPanelExists: !!document.getElementById('panelAnalytics'),
    sessionsPanelExists: !!document.getElementById('panelSessions'),
  }
})

const rail = await page.$('#rail')
if (rail) await rail.screenshot({ path: path.join(outDir, 'rail.png') })
const side = await page.$('#sidebar')
if (side) await side.screenshot({ path: path.join(outDir, 'sidebar.png') })
await page.screenshot({ path: path.join(outDir, 'full.png'), fullPage: false })

// 点「会话」→ 验证 #panelSessions 真的可达
// ⚠ 注意：React 渲染的 DOM 里没有 onclick 属性（模板 onclick 被 html-to-jsx 转成
// data-h-events，再由 index.jsx 的 bindLegacyEvents 赋给 el.onclick）⇒ 不能用
// [onclick*=...] 选择器，必须按文案定位。这一点会让「用 onclick 属性找按钮」的探针全部失效。
let reach = null
try {
  const btn = page.locator('.side-actions button', { hasText: '会话' }).first()
  await btn.click({ timeout: 5000 })
  await page.waitForTimeout(900)
  reach = await page.evaluate(() => {
    const p = document.getElementById('panelSessions')
    return {
      panelOn: !!p && p.classList.contains('on'),
      filterBtns: document.querySelectorAll('#sessionFilterSeg .seg-btn').length,
      searchInput: !!document.getElementById('sessionSearchInput'),
      statsBar: !!document.getElementById('sessionStatsBar'),
    }
  })
  await page.screenshot({ path: path.join(outDir, 'sessions-panel.png') })
} catch (e) {
  reach = { error: String(e).slice(0, 200) }
}

console.log(JSON.stringify({ outDir, renderMode: info.renderMode, railFound: info.railFound, railButtons: info.railButtons, panels: info.panels, setWinClose: info.setWinClose, analyticsPanelExists: info.analyticsPanelExists, sessionsPanelExists: info.sessionsPanelExists, reachAfterClick: reach, errors: errors.slice(0, 8) }, null, 2))

await browser.close()
