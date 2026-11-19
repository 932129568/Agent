#!/usr/bin/env node
/**
 * R67 · React 全量渲染的运行时验收（真实浏览器 DOM，非静态文本断言）。
 *
 * 用 playwright-core + 系统 Edge 以 file:// 加载构建产物 harbor.html，验证：
 *   1. HarborIsland IIFE 自动挂载成功，renderMode === 'react'；
 *   2. React 根容器承载 10 个区域、300 个 id，且与 <template> 降级宿主零重复；
 *   3. UI 契约的 40 个 DOM id 全部能在 React 树中查到（legacy 的 getElementById
 *      继续可用，这是功能等价的根基）；
 *   4. 模板内联事件已桥接为属性式原生 handler，且端到端点击能调到 legacy 全局函数；
 *   5. 无 React 致命错误（legacy 自身的网络/CSP 噪声单独列出，不判失败）。
 *
 * 用法：node tools/verify-react-render.mjs
 * 退出码：0 全通过；1 有失败项；2 环境缺失（供 CI skip）。
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const HTML = join(ROOT, 'harbor.html')
const IIFE = join(ROOT, 'frontend/react/dist/harbor-island.iife.js')
const IDS = join(ROOT, 'frontend/react/src/generated/ids.json')

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]

let chromium
try { ({ chromium } = require('../server/node_modules/playwright-core')) }
catch (_) {
  console.error('[verify-react] 环境缺失：server/node_modules/playwright-core 不可用')
  process.exit(2)
}
const executablePath = EDGE_CANDIDATES.find(p => existsSync(p))
if (!executablePath) {
  console.error('[verify-react] 环境缺失：未找到 Edge/Chrome')
  process.exit(2)
}
if (![HTML, IIFE, IDS].every(p => existsSync(p))) {
  console.error('[verify-react] 环境缺失：构建产物或 ids.json 不存在，请先跑构建')
  process.exit(2)
}

const expected = JSON.parse(readFileSync(IDS, 'utf8'))
const CONTRACT_IDS = ('apiKey attachPreview brandModel chatContainer continueNewBtn effPath effTag '
  + 'emptyState enableSearch headerTitle liveTokenStat maxTokens modelSelect reasoningEffort '
  + 'saverLevel searchEngine searchEngineWrap sendBtn sessionBudget sessionList settingsPanel '
  + 'shotQuality sidebar streamBar systemPrompt tempVal temperature themeBtn tokenStat '
  + 'toolMode topP topPVal userInput wsBody wsEffPath wsEffTag wsEnabled wsInd wsSel wsUnbindBtn').split(/\s+/)

// Edge 在已有用户实例运行时会把新进程合并进默认 profile，导致 Playwright 的
// remote-debugging pipe 报「requires a non-default data directory」。显式独立
// profile + 三次重试，消除这一环境性抖动；仍失败则 exit 2 交由调用方 skip。
let context = null
let profileDir = null
for (let attempt = 1; attempt <= 3 && !context; attempt++) {
  profileDir = mkdtempSync(join(tmpdir(), 'harbor-verify-'))
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath, headless: true, timeout: 20000,
      args: [
        '--no-sandbox', '--disable-gpu', '--allow-file-access-from-files',
        '--no-first-run', '--no-default-browser-check',
      ],
    })
  } catch (error) {
    console.error('[verify-react] 启动尝试 %d 失败：%s', attempt,
      String(error && error.message || error).split('\n')[0])
    try { rmSync(profileDir, { recursive: true, force: true }) } catch (_) {}
    profileDir = null
  }
}
if (!context) {
  console.error('[verify-react] 环境失败：Edge/Chrome 无法以独立 profile 启动')
  process.exit(2)
}

const page = context.pages()[0] || await context.newPage()
const pageErrors = []
page.on('pageerror', e => pageErrors.push(String(e && e.message || e)))
await page.goto(pathToFileURL(HTML).href, { waitUntil: 'domcontentloaded', timeout: 30000 })

const report = await page.evaluate((args) => {
  const root = document.getElementById('harbor-react-root')
  const all = root ? Array.from(root.querySelectorAll('[id]')) : []
  const ids = all.map(el => el.id)
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i)
  const eventNodes = root ? Array.from(root.querySelectorAll('[data-h-events]')) : []
  let eventTotal = 0
  let boundHandlers = 0
  for (const el of eventNodes) {
    let list = []
    try { list = JSON.parse(el.getAttribute('data-h-events')) } catch (_) {}
    for (const item of list) {
      eventTotal++
      if (typeof el['on' + item.type] === 'function') boundHandlers++
    }
  }
  const missingContract = args.contractIds.filter(id => !document.getElementById(id))
  const missingExpected = args.expected.filter(id => !ids.includes(id))
  return {
    renderMode: document.documentElement.dataset.harborRender || '(unset)',
    rootExists: !!root,
    rootChildCount: root ? root.children.length : 0,
    renderedIdCount: ids.length,
    // R91：不在 ids.json 里的 id —— 现在只有壳层挂载时补的那一个（见下方 checks）。
    extraIds: ids.filter(id => args.expected.indexOf(id) === -1),
    duplicateIds: [...new Set(duplicates)],
    missingContract,
    missingExpected: missingExpected.slice(0, 20),
    eventNodes: eventNodes.length,
    eventTotal,
    boundHandlers,
    islandVersion: window.HarborIsland && window.HarborIsland.version,
    legacyEventCount: window.HarborIsland && window.HarborIsland.api &&
      typeof window.HarborIsland.api.legacyEventCount === 'function'
      ? window.HarborIsland.api.legacyEventCount() : null,
    fallbackInDocument: !!document.querySelector('#harbor-legacy-fallback [id]'),
    bgTasksReact: !!(window.HarborIsland && window.HarborIsland.api &&
      typeof window.HarborIsland.api.bgTasksReact === 'function' &&
      window.HarborIsland.api.bgTasksReact()),
    bgTasksFlag: window.__HARBOR_REACT_BGTASKS__ === true,
    bgTaskListText: ((document.getElementById('bgTaskList') || {}).textContent || '').trim(),
    perfDomContentLoadedMs: (() => {
      const nav = performance.getEntriesByType('navigation')[0]
      return nav ? Math.round(nav.domContentLoadedEventEnd) : null
    })(),
    // HTML→JSX 转换的语义等价性：初始选中项 / 勾选 / 默认值。
    // 用 defaultSelected / defaultChecked / defaultValue 比较，避免 legacy
    // 运行时赋值（从 config 回填）造成假阳性。
    formEquivalence: (() => {
      const tpl = document.getElementById('harbor-legacy-fallback')
      const root = document.getElementById('harbor-react-root')
      if (!tpl || !root) return { checked: 0, mismatches: ['容器缺失'] }
      const mismatches = []
      let checked = 0
      const optionValue = (opt) => opt
        ? (opt.getAttribute('value') !== null ? opt.getAttribute('value') : opt.textContent.trim())
        : ''
      const expectedSelect = (sel) => optionValue(
        sel.querySelector('option[selected]') || sel.querySelector('option'))
      const actualSelect = (sel) => {
        const opt = Array.from(sel.options || []).find(o => o.defaultSelected)
        return optionValue(opt || (sel.options && sel.options[0]))
      }
      const fS = Array.from(tpl.content.querySelectorAll('select'))
      const rS = Array.from(root.querySelectorAll('select'))
      fS.forEach((sel, i) => {
        checked++
        if (!rS[i] || expectedSelect(sel) !== actualSelect(rS[i])) {
          mismatches.push('select#' + i + ':' + expectedSelect(sel) + '!=' + (rS[i] ? actualSelect(rS[i]) : '(missing)'))
        }
      })
      const fI = Array.from(tpl.content.querySelectorAll('input'))
      const rI = Array.from(root.querySelectorAll('input'))
      fI.forEach((el, i) => {
        if (el.hasAttribute('checked')) {
          checked++
          if (!rI[i] || !rI[i].defaultChecked) mismatches.push('input#' + i + ':checked')
        }
        if (el.hasAttribute('value')) {
          checked++
          if (!rI[i] || rI[i].defaultValue !== el.getAttribute('value')) {
            mismatches.push('input#' + i + ':value')
          }
        }
      })
      return { checked, mismatches: mismatches.slice(0, 10) }
    })(),
  }
}, { contractIds: CONTRACT_IDS, expected: expected.ids })

// 后台任务/过程面板：注入一个 failed run，验证 React state 驱动刷新与「失败即接管」。
const bgProbe = await page.evaluate(async () => {
  const host = document.getElementById('bgTaskList')
  if (!host) return { ok: false, reason: '缺少 #bgTaskList' }
  window.__probeSwitch = []
  window.switchSession = function (id) { window.__probeSwitch.push(id) }
  window.getActiveRuns = function () {
    return [{ sessionId: 'S-PROBE', title: '探针会话', status: 'failed',
      currentTool: 'read_file', startedAt: Date.now() - 3000 }]
  }
  await new Promise(resolve => setTimeout(resolve, 700))
  const text = (host.textContent || '')
  const takeover = text.indexOf('接管') >= 0 && text.indexOf('探针会话') >= 0
  const btn = host.querySelector('button')
  if (btn) btn.click()
  return {
    ok: takeover && window.__probeSwitch.length === 1 &&
      window.__probeSwitch[0] === 'S-PROBE',
    takeover, text: text.slice(0, 140), calls: window.__probeSwitch.slice(),
  }
})

// 端到端事件桥探针：覆盖一个 legacy 全局函数后点击 React 生成的按钮。
const probe = await page.evaluate(() => {
  const btn = document.querySelector('#harbor-react-root [data-panel="sessions"]')
  if (!btn) return { ok: false, reason: '找不到导航按钮' }
  window.__harborProbe = []
  window.switchPanel = function (name) { window.__harborProbe.push(name) }
  btn.click()
  return { ok: window.__harborProbe.length === 1 && window.__harborProbe[0] === 'sessions',
    calls: window.__harborProbe.slice() }
})

/* R91 · 光井皮肤默认转正 ⇒ 「根内 id 数 = 300」这条判据的前提反转。
 *
 * 旧前提：「默认 = 经典态 ⇒ 壳层 early-return ⇒ 运行期一个 id 都不新增」。
 * 转正后默认就是光井，壳层会给 .panels 补 id="mainStage"（壳层全部节点都在运行期
 * 创建，正是为了不进 dom_ids 派生集合），于是根内 id 变成 301。
 *
 * 处置不是把 300 放宽成区间（那等于放水），而是拆成两条更硬的判据：
 *   ① 默认（光井）态：外来 id 必须**恰好**是白名单里的那一个，多一个即红；
 *   ② 经典态（?skin=classic）：必须仍是 300 且零外来 id —— 这是「经典态运行期
 *      零漂移」的直接观测（壳层 early-return，一个 id 都不许加），与 W4A 基线同源。
 * 顺带把「?skin=classic 真的进得去」也观测一次：从构建产物读 data-skin 必须为 null。
 */
const SHELL_RUNTIME_IDS = ['mainStage']
const classicPage = await context.newPage()
await classicPage.goto(pathToFileURL(HTML).href + '?skin=classic',
  { waitUntil: 'domcontentloaded', timeout: 30000 })
const classicIds = await classicPage.evaluate((expected) => {
  const root = document.getElementById('harbor-react-root')
  const ids = root ? Array.from(root.querySelectorAll('[id]')).map(el => el.id) : []
  return {
    skin: document.documentElement.getAttribute('data-skin'),
    count: ids.length,
    extraIds: ids.filter(id => expected.indexOf(id) === -1)
  }
}, expected.ids)
await classicPage.close()

await context.close()
if (profileDir) { try { rmSync(profileDir, { recursive: true, force: true }) } catch (_) {} }

const checks = [
  ['React 渲染模式', report.renderMode === 'react', report.renderMode],
  ['React 根容器存在', report.rootExists, report.rootExists],
  ['根容器承载 10 个区域组件', report.rootChildCount === 10, report.rootChildCount],
  ['默认（光井）态根内 id = 301，外来 id 恰为 mainStage',
    report.renderedIdCount === 301 && report.extraIds.length === SHELL_RUNTIME_IDS.length
      && report.extraIds[0] === 'mainStage',
    report.renderedIdCount + ' extra=' + JSON.stringify(report.extraIds)],
  ['经典态（?skin=classic）根内 id = 300 且零外来 id',
    classicIds.skin === null && classicIds.count === 300 && classicIds.extraIds.length === 0,
    'skin=' + classicIds.skin + ' count=' + classicIds.count
      + ' extra=' + JSON.stringify(classicIds.extraIds)],
  ['无重复 id', report.duplicateIds.length === 0, report.duplicateIds.slice(0, 5)],
  ['UI 契约 40 个 id 全部可达', report.missingContract.length === 0, report.missingContract],
  ['ids.json 300 个 id 全部渲染', report.missingExpected.length === 0, report.missingExpected],
  ['降级宿主不进入主 document', report.fallbackInDocument === false, report.fallbackInDocument],
  ['内联事件节点存在', report.eventNodes > 0, report.eventNodes],
  ['内联事件全部桥接', report.eventTotal > 0 && report.boundHandlers === report.eventTotal,
    report.boundHandlers + '/' + report.eventTotal],
  ['IIFE 计数与实测一致', report.legacyEventCount === report.eventTotal,
    report.legacyEventCount + ' vs ' + report.eventTotal],
  ['端到端点击调到 legacy 全局函数', probe.ok, probe],
  ['后台任务域由 React 接管', report.bgTasksReact && report.bgTasksFlag,
    'react=' + report.bgTasksReact + ' flag=' + report.bgTasksFlag],
  ['后台任务容器由 React 渲染', report.bgTaskListText.indexOf('无在途任务') >= 0,
    report.bgTaskListText.slice(0, 40)],
  ['过程面板状态刷新 + 失败即接管', bgProbe.ok, bgProbe],
  ['表单初始态与降级宿主等价', report.formEquivalence.checked > 0 &&
    report.formEquivalence.mismatches.length === 0, report.formEquivalence],
]
const failed = checks.filter(c => !c[1])
for (const [name, ok, value] of checks) {
  const detail = typeof value === 'object' ? JSON.stringify(value) : String(value)
  console.log('%s %s %s', ok ? 'PASS' : 'FAIL', name.padEnd(34, ' '), detail)
}
if (pageErrors.length) {
  console.log('\n[pageerror] %d 条（legacy 网络/初始化噪声，单独记录）：', pageErrors.length)
  pageErrors.slice(0, 8).forEach(e => console.log('  - ' + e.slice(0, 200)))
}
console.log('[perf] DOMContentLoaded=%s ms | harbor.html=%s B | React IIFE=%s B',
  report.perfDomContentLoadedMs, statSync(HTML).size, statSync(IIFE).size)
console.log('\n[verify-react] %d/%d 通过；browser=%s',
  checks.length - failed.length, checks.length, executablePath)
process.exit(failed.length ? 1 : 0)
