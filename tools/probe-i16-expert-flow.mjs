/* v3.4 I16 · 专家与协同：主对话框一站式（判据：零跳转设置页）
 *
 * 判据（施工总册 I16）：主对话框一站式跑通，零跳转设置页。
 * 操作化：从 **rail 的能力中心** 选并启用一个专家，全程用 MutationObserver 监听
 * `#settingsPanel` 的 class —— 出现 `.show` 的次数必须为 **0**；
 * 并且启用后当前会话的 token 列表里必须有该专家（一站式要真的"用上了"，不是只弹个提示）。
 *
 * 为什么要 MutationObserver 而不是"结束时看面板是否打开"：
 * 打开再关掉也算"跳转过"，只在结束时读一次会漏掉这种闪跳。
 *
 * 运行：node tools/probe-i16-expert-flow.mjs
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
  const wait = ms => new Promise(res => setTimeout(res, ms))
  const o = {}
  const sp = document.getElementById('settingsPanel')
  // 环境里没有 API Key，bootstrap 会按引导打开设置（bootstrap.js:228）。
  // 这一步先关掉它，模拟"已配置 Key 的正常用户"——我们要测的是专家流程本身。
  o.bootAutoOpened = sp.classList.contains('show')
  if (o.bootAutoOpened) sp.classList.remove('show')
  let opened = 0
  const mo = new MutationObserver(() => { if (sp.classList.contains('show')) opened += 1 })
  mo.observe(sp, { attributes: true, attributeFilter: ['class'] })

  const btn = document.getElementById('expertCenterBtn')
  o.hasRailEntry = !!btn
  if (btn) { btn.click(); await wait(250) }
  const list = hubCatalog().experts || []
  const target = list.find(x => x.id === 'ContentCreator') || list[0]
  o.expertCount = list.length
  o.picked = target && target.id
  hubToggleEnabled('experts', target.id)
  await wait(150)

  // 注意：新应用还没有会话时 currentSessionId 是 null，token 会落在 '' 键下。
  // 所以按"所有会话的 token 里找 expert"来断言，而不是按当前 sid 取（这样写会假失败）。
  const all = []
  try {
    Object.keys(composerTokensBySid || {}).forEach(k => {
      (composerTokensBySid[k] || []).forEach(t => all.push({ key: k, kind: t.kind, id: t.id }))
    })
  } catch (e) {}
  o.sessionIdAtTime = (typeof AppState !== 'undefined') ? AppState.currentSessionId : undefined
  o.tokens = all
  o.settingsOpenedDuringFlow = opened
  o.settingsOpenAtEnd = sp.classList.contains('show')
  mo.disconnect()
  hubToggleEnabled('experts', target.id)   // 复原
  return o
})
await browser.close()

const bad = []
if (!r.hasRailEntry) bad.push('rail 上没有能力中心入口')
if (r.settingsOpenedDuringFlow !== 0) bad.push(`流程中设置面板被打开 ${r.settingsOpenedDuringFlow} 次`)
if (r.settingsOpenAtEnd) bad.push('流程结束时设置面板仍是打开态')
if (!r.tokens || !r.tokens.some(t => t.kind === 'expert')) bad.push('启用后当前会话没有专家 token（一站式没落到发送面）')
if (errs.length) bad.push('页面异常: ' + errs[0])

if (bad.length) {
  console.log('EXPERT_FLOW: FAIL')
  bad.forEach(x => console.log('  - ' + x))
  process.exit(1)
}
console.log(`EXPERT_FLOW: PASS (rail→启用 ${r.picked}，设置面板 0 次打开，token=${JSON.stringify(r.tokens)})`)
