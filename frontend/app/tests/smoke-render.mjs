#!/usr/bin/env node
/**
 * R68 · 骨架运行时冒烟：证明 frontend/app/dist/harbor-app.iife.js 不只是能编译，
 * 而是能在真实浏览器 DOM 中挂载、由单一 store 驱动渲染出 10 个区域。
 *
 * 与生产链完全隔离：用 page.setContent 建一个临时页面，注入 bundle 后显式调用
 * HarborApp.bootstrap()；不加载 harbor.html、不启动应用、不写任何项目文件。
 *
 * 退出码：0 全通过；1 渲染断言失败；2 环境缺失（供 CI skip）。
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const BUNDLE = resolve(HERE, '../dist/harbor-app.iife.js')

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(p => existsSync(p))

let chromium
try { ({ chromium } = require(join(ROOT, 'server/node_modules/playwright-core'))) }
catch (_) { console.error('[app-smoke] 环境缺失：playwright-core'); process.exit(2) }
if (!EDGE || !existsSync(BUNDLE)) {
  console.error('[app-smoke] 环境缺失：Edge 或骨架 bundle（先跑 node frontend/app/build.mjs）')
  process.exit(2)
}

let context = null
let profile = null
for (let i = 1; i <= 3 && !context; i++) {
  profile = mkdtempSync(join(tmpdir(), 'harbor-app-smoke-'))
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: EDGE, headless: true, timeout: 20000,
      args: ['--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check'],
    })
  } catch (e) {
    console.error('[app-smoke] 启动尝试 %d 失败：%s', i, String(e.message || e).split('\n')[0])
    try { rmSync(profile, { recursive: true, force: true }) } catch (_) {}
    profile = null
  }
}
if (!context) { console.error('[app-smoke] 环境失败：浏览器无法启动'); process.exit(2) }

const page = context.pages()[0] || await context.newPage()
const pageErrors = []
page.on('pageerror', e => pageErrors.push(String(e && e.message || e)))
await page.setContent('<!doctype html><html><body><div id="harbor-app-root"></div></body></html>',
  { waitUntil: 'domcontentloaded' })
await page.addScriptTag({ content: readFileSync(BUNDLE, 'utf8') })

const report = await page.evaluate(() => {
  const api = window.HarborApp
  if (!api || typeof api.bootstrap !== 'function') {
    return { bootstrapped: false, reason: 'HarborApp.bootstrap 未导出' }
  }
  const result = api.bootstrap()
  const host = document.getElementById('harbor-app-root')
  return {
    bootstrapped: !!result,
    hasStore: !!(result && result.store && typeof result.store.update === 'function'),
    areas: host.querySelectorAll('[data-area]').length,
    statusText: (host.querySelector('.harbor-app-status') || {}).textContent || '',
    globalBusinessSymbols: ['switchPanel', 'sendMessage', 'getActiveRuns']
      .filter(k => typeof window[k] !== 'undefined'),
  }
})

await context.close()
if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch (_) {} }

const checks = [
  ['bundle 暴露 bootstrap 并挂载成功', report.bootstrapped, report.bootstrapped],
  ['store 实例可用（单一状态源）', report.hasStore, report.hasStore],
  ['渲染 10 个布局区域', report.areas === 10, report.areas],
  ['状态栏由 store 派生', /在途任务 0 · 待接管 0/.test(report.statusText), report.statusText],
  ['零业务全局符号', report.globalBusinessSymbols.length === 0, report.globalBusinessSymbols],
  ['无未捕获页面异常', pageErrors.length === 0, pageErrors.slice(0, 3)],
]
const failed = checks.filter(c => !c[1])
for (const [name, ok, value] of checks) {
  console.log('%s %s %s', ok ? 'PASS' : 'FAIL', name.padEnd(36, ' '),
    typeof value === 'object' ? JSON.stringify(value) : String(value))
}
console.log('\n[app-smoke] %d/%d 通过', checks.length - failed.length, checks.length)
process.exit(failed.length ? 1 : 0)
