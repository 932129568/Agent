// R101 T04 · APCA 对比度实测（APCA-W3 算法，非截图）
//
// 为什么这个可以"算"而不必"看"：APCA 是给定前景/背景色后的**确定性公式**，
// 不依赖渲染。原生玻璃层还没接，影响的只是「半透明叠加后的实际底色」；
// 而正文压在 --bg / --card-bg 这类**不透明**表面上时，Lc 可以精确算出。
// 所以本脚本解的是「不透明表面上的正文对比度」，不解的是「玻璃层叠加后的对比度」
// ——后者仍标 blocked，不在这里冒充。
//
// 判定：正文（--text 压在 --bg 上）|Lc| >= 75（计划 T04 出口判据）。
// 次级文字（--text-2 / --text-3）不做阈值判定，只报数：它们不是正文，
// 把次级文字硬塞进正文阈值会让这条判据变成"永远红"或"永远绿"。
//
// 环境/样本口径（判据要求写清）：单次运行、本机 Edge(headless) 、视口 1440x900、
// 两套主题各 1 批、每套 4 组色对；颜色一律取 getComputedStyle 解析后的值
// （不是源码里的字面量），因为 var() 链会改变最终颜色。
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(pathToFileURL(path.join(ROOT, 'server', 'package.json')).href)
const { chromium } = require('playwright-core')

// ── APCA-W3 (0.98G-4g) ───────────────────────────────────────────────────────
const MAIN_TRC = 2.4
const R_CO = 0.2126729, G_CO = 0.7151522, B_CO = 0.0721750
const NORM_BG = 0.56, NORM_TXT = 0.57, REV_TXT = 0.62, REV_BG = 0.65
const BLK_THRS = 0.022, BLK_CLMP = 1.414
const SCALE_BOW = 1.14, SCALE_WOB = 1.14
const LO_BOW_OFFSET = 0.027, LO_WOB_OFFSET = 0.027
const DELTA_Y_MIN = 0.0005, LO_CLIP = 0.1

function srgbToY([r, g, b]) {
  const f = (v) => Math.pow(v / 255, MAIN_TRC)
  let y = R_CO * f(r) + G_CO * f(g) + B_CO * f(b)
  // 黑电平钳制：近黑处 sRGB 的显示特性偏离幂函数
  if (y < BLK_THRS) y = y + Math.pow(BLK_THRS - y, BLK_CLMP)
  return y
}

/** 返回带符号的 Lc（正=深字浅底，负=浅字深底）。 */
export function apcaLc(textRgb, bgRgb) {
  const Ytxt = srgbToY(textRgb)
  const Ybg = srgbToY(bgRgb)
  // 两侧都极近黑时直接判 0（差值低于可辨阈值）
  if (Math.abs(Ybg - Ytxt) < DELTA_Y_MIN) return 0
  if (Ybg > Ytxt) {
    const sapc = (Math.pow(Ybg, NORM_BG) - Math.pow(Ytxt, NORM_TXT)) * SCALE_BOW
    return sapc < LO_CLIP ? 0 : (sapc - LO_BOW_OFFSET) * 100
  }
  const sapc = (Math.pow(Ybg, REV_BG) - Math.pow(Ytxt, REV_TXT)) * SCALE_WOB
  return sapc > -LO_CLIP ? 0 : (sapc + LO_WOB_OFFSET) * 100
}

function parseRgb(str) {
  const m = /rgba?\(([^)]+)\)/.exec(String(str || ''))
  if (!m) return null
  const parts = m[1].split(/[,/\s]+/).filter(Boolean).map(Number)
  if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) return null
  // 半透明底色无法用 APCA 直接判（需要先与壁纸合成）——显式拒绝而不是当成实色
  if (parts.length >= 4 && parts[3] < 1) return { rgb: parts.slice(0, 3), alpha: parts[3] }
  return { rgb: parts.slice(0, 3), alpha: 1 }
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS

const browser = await chromium.launch({ channel: 'msedge', headless: true, env, args: ['--allow-file-access-from-files'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(pathToFileURL(path.join(ROOT, 'harbor.html')).href, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(6500)

async function sampleTheme() {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.body)
    const root = getComputedStyle(document.documentElement)
    // 必须**先读 body 再读 root**：主题覆盖写在 body.dark / html[data-skin] 上，
    // 而 :root 上留的是默认值。第一版顺序反了，于是明暗两批读到同一组颜色、
    // 数字一模一样还照样 PASS —— 这是"看起来合理"最典型的假绿。
    const pick = (name) => (cs.getPropertyValue(name) || root.getPropertyValue(name) || '').trim()
    return {
      skin: document.documentElement.getAttribute('data-skin') || 'classic',
      theme: document.body.classList.contains('dark') ? 'dark' : 'light',
      bodyColor: cs.color,
      bodyBg: cs.backgroundColor,
      tokenText: pick('--text'),
      tokenText2: pick('--text-2'),
      tokenText3: pick('--text-3'),
      tokenBg: pick('--bg'),
      tokenCard: pick('--card-bg'),
    }
  })
}

function toCssRgb(v) {
  const s = String(v || '').trim()
  if (!s) return null
  if (s.startsWith('#')) {
    const h = s.slice(1)
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
    const n = parseInt(full.slice(0, 6), 16)
    if (Number.isNaN(n)) return null
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const p = parseRgb(s)
  return p && p.alpha === 1 ? p.rgb : null
}

const results = []
const themes = []
themes.push(await sampleTheme())
// 切到另一套主题再采一批
await page.evaluate(() => { if (typeof toggleTheme === 'function') toggleTheme() })
await page.waitForTimeout(600)
themes.push(await sampleTheme())

for (const t of themes) {
  const bg = toCssRgb(t.tokenBg) || toCssRgb(t.bodyBg)
  const card = toCssRgb(t.tokenCard) || bg
  const pairs = [
    ['正文 --text / --bg', toCssRgb(t.tokenText), bg, true],
    ['正文 --text / --card-bg', toCssRgb(t.tokenText), card, false],
    ['次级 --text-2 / --bg', toCssRgb(t.tokenText2), bg, false],
    ['弱化 --text-3 / --bg', toCssRgb(t.tokenText3), bg, false],
  ]
  for (const [label, fg, bgr, isBody] of pairs) {
    if (!fg || !bgr) { results.push({ theme: t.theme, skin: t.skin, label, lc: null, isBody, note: '色值无法解析或半透明' }); continue }
    const lc = apcaLc(fg, bgr)
    results.push({ theme: t.theme, skin: t.skin, label, lc, isBody, fg, bg: bgr })
  }
}

// 护栏：两批主题的底色必须真的不同，否则说明主题没切过去（等同只测了一遍）
const bgSet = new Set(results.map((r) => (r.bg ? r.bg.join(',') : 'null')))
if (bgSet.size < 2) {
  console.log('APCA_RESULT: FAIL (主题未切换：两批底色相同，等同只测了一个主题)')
  await browser.close()
  process.exit(1)
}

const bodyRows = results.filter((r) => r.isBody)
const bad = bodyRows.filter((r) => r.lc === null || Math.abs(r.lc) < 75)
const fmt = (n) => (n === null ? '  n/a' : String(Math.abs(n).toFixed(1)).padStart(5))

console.log('APCA（APCA-W3 0.98G-4g）· 环境：msedge headless · 视口 1440x900 · 单批 · 2 主题 × 4 色对')
console.log('说明：负号表示「浅字压深底」，判定用绝对值 |Lc| ≥ 75（仅正文两项）')
console.log('')
console.log('  主题/皮肤                       色对                      Lc')
for (const r of results) {
  console.log('  %s  %s  %s%s',
    (r.theme + '/' + r.skin).padEnd(22), r.label.padEnd(26), fmt(r.lc),
    r.note ? '  <- ' + r.note : '')
}
console.log('')
const ok = bad.length === 0
console.log('APCA_RESULT: %s (正文样本 %d 组, 不合格 %d 组, 阈值 |Lc|>=75)', ok ? 'PASS' : 'FAIL', bodyRows.length, bad.length)
if (!ok) {
  for (const r of bad) console.log('  FAIL %s/%s %s |Lc|=%s', r.theme, r.skin, r.label, fmt(r.lc))
}
await browser.close()
process.exit(ok ? 0 : 1)
