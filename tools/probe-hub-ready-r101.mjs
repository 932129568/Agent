/* v3.4 I18 · 能力中心「已就绪项 100% 真可用」回归探针
 *
 * 判据（施工总册 I18）：已就绪项 100% 真可用，零落差弹窗。
 *
 * 为什么要这个探针：2026-11-23 实测 50 项 connector 全为 link='ready'，
 * 逐项启用都成功、零 warn/err toast —— 也就是说这条判据**当前已成立**。
 * 已成立的判据更需要锁死：任何一次目录/开关重构都可能悄悄把它弄坏，
 * 而"点启用才报无配置"这种事，用户是先看到按钮再看到报错的，事后很难归因。
 *
 * 判据三条（每条都有反例意义）：
 *   ① 目录里每个 connector 的 link 必须是 'ready'（出现非 ready 即意味着市场里
 *      会混进"点了才失败"的项 ⇒ FAIL）；
 *   ② 逐项启用：hubIsEnabled 必须为 true，且出现在 hubEnabledItems 里
 *      （只写 localStorage 但读不出来，同样是假可用）；
 *   ③ 全程不得出现 warn/err 级 toast（"无配置/请先授权"这类落差都会走到这里）。
 *
 * 运行：node tools/probe-hub-ready-r101.mjs
 * 退出码：0 = 全绿；1 = 有失例（打印明细）。
 */
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'

// 必须用 junction 路径：真实目录名含同形字，fileURLToPath 会给出 %E9 百分号编码路径，
// 那里找不到 server/node_modules（实测 playwright-core 解析失败）。
const ROOT = 'C:/v4h/proj'
const require = createRequire(pathToFileURL(path.join(ROOT, 'server', 'package.json')).href)
const { chromium } = require('playwright-core')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS

const browser = await chromium.launch({
  channel: 'msedge', headless: true, env, args: ['--allow-file-access-from-files'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
const errs = []
page.on('pageerror', e => errs.push(e.message))
await page.goto(pathToFileURL(path.join(ROOT, 'harbor.html')).href, { waitUntil: 'load', timeout: 30000 })
// 首次引导 + 懒挂载：等足够久（与既有探针同口径）
await page.waitForTimeout(6500)

const r = await page.evaluate(() => {
  const out = { fails: [], warns: [] }
  const origToast = (typeof window.toast === 'function') ? window.toast : null
  window.toast = function (msg, kind) {
    if (kind === 'warn' || kind === 'err') out.warns.push(String(msg).slice(0, 80))
    if (origToast) { try { origToast.apply(null, arguments) } catch (e) {} }
  }
  const cat = hubCatalog()
  const list = cat.connectors || []
  out.total = list.length
  // ① link 必须是 ready
  out.notReady = list.filter(x => (x.link || '') !== 'ready').map(x => ({ id: x.id, link: x.link }))
  // ② 逐项启用
  hubEnabledSave({ experts: [], teams: [], skills: [], connectors: [] })
  for (const it of list) {
    try {
      hubToggleEnabled('connectors', it.id)
      const on = hubIsEnabled('connectors', it.id)
      const inItems = hubEnabledItems('connectors').some(x => x.id === it.id)
      if (!on || !inItems) out.fails.push({ id: it.id, on, inItems })
    } catch (e) {
      out.fails.push({ id: it.id, err: String(e).slice(0, 80) })
    }
  }
  out.enabled = hubEnabledCount()
  hubEnabledSave({ experts: [], teams: [], skills: [], connectors: [] })   // 复原
  window.toast = origToast
  return out
})
await browser.close()

const bad = []
if (!r.total) bad.push('目录为空（0 项 connector）')
if (r.notReady.length) bad.push(`${r.notReady.length} 项 link≠ready: ${JSON.stringify(r.notReady.slice(0, 3))}`)
if (r.fails.length) bad.push(`${r.fails.length} 项启用后不可见: ${JSON.stringify(r.fails.slice(0, 3))}`)
if (r.warns.length) bad.push(`出现 ${r.warns.length} 条 warn/err toast: ${JSON.stringify(r.warns.slice(0, 3))}`)
if (r.enabled !== r.total) bad.push(`启用计数 ${r.enabled} ≠ 目录 ${r.total}`)
if (errs.length) bad.push(`页面异常: ${errs[0]}`)

if (bad.length) {
  console.log('HUB_READY: FAIL')
  bad.forEach(x => console.log('  - ' + x))
  process.exit(1)
}
console.log(`HUB_READY: PASS (${r.total} 项 ready，逐项启用可见，零落差 toast)`)
