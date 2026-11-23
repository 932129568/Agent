// R101 T03 · S3 出口判据的自动化用例：思考块展开后，流式 30 帧不得掉 .open
//
// 背景（逐行核实过的缺陷机制）：
//   改前每帧 `reasonHtml(fullReasoning) + renderMdStream(mdBody, fullContent)` 一起
//   写进 mdBody 的 innerHTML，而 markdown.js 的 scheduleRender 结尾正是
//   `el.innerHTML = pending.fn()` ⇒ 思考块节点被销毁重建 ⇒ 用户展开态的
//   `.think-body.open` class 必然丢失。CSS 无法修复（class 附在已被替换的节点上）。
//
// 本用例证明的三件事（缺一不可）：
//   ① 展开后连打 30 帧，`.think-body` 仍是同一个 DOM 节点（不是「重建后重新加上 class」
//      —— 后者会闪烁，文档明确禁止这种补丁式绕法）；
//   ② `.open` class 仍在；
//   ③ 思考正文与预览行确实跟着 30 帧的最新内容更新（不能靠「不更新」换稳定）。
//
// 用法：node tools/probe-think-open-r101.mjs
// 退出码：0 = 三条全过；1 = 任一不过（并打印差异）。
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(pathToFileURL(path.join(ROOT, 'server', 'package.json')).href)
const { chromium } = require('playwright-core')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS

const FRAMES = 30
const browser = await chromium.launch({ channel: 'msedge', headless: true, env, args: ['--allow-file-access-from-files'] })
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
await page.goto(pathToFileURL(path.join(ROOT, 'harbor.html')).href, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(6500)   // 无桥环境要等 window.onload 的 5s 回退走完 loadAll

const result = await page.evaluate((frames) => {
  if (typeof renderReason !== 'function') return { fatal: 'renderReason 未暴露到全局' }
  // 复刻 run-controller 里的宿主结构：aiContent 下 .think-host + .md-body
  const ai = document.createElement('div')
  ai.className = 'msg-ai'
  ai.innerHTML = '<div class="think-host" style="display:none"></div><div class="md-body"></div>'
  document.body.appendChild(ai)
  const host = ai.querySelector('.think-host')
  const mdBody = ai.querySelector('.md-body')

  // 第 0 帧：有思考内容，宿主显形
  renderReason(host, '第一段思考')
  const body = host.querySelector('.think-body')
  const line = host.querySelector('.think-line')
  if (!body || !line) return { fatal: '思考区结构未建立' }

  // 用户点开
  line.classList.add('open')
  body.classList.add('open')
  const bodyNode0 = body
  const frameLog = []
  let lostAt = -1

  // 连打 30 帧：思考内容增长 + 正文增长（正文重建用无条件 innerHTML，
  // 因为「被替换的正是这个容器」才是要验的破坏力来源；renderMdStream 需要
  // 会话上下文，抛错就会让赋值不执行，那样等于没测）。
  for (let i = 1; i <= frames; i++) {
    renderReason(host, '第 ' + i + ' 段思考 ' + 'x'.repeat(i * 3))
    mdBody.innerHTML = '<p>正文第 ' + i + ' 帧</p>'
    const cur = host.querySelector('.think-body')
    const same = cur === bodyNode0
    const open = !!(cur && cur.classList.contains('open'))
    if (!same || !open) { lostAt = i; frameLog.push({ frame: i, sameNode: same, open }); break }
  }

  // ── 反向对照（证明本用例会红，不是恒真）──────────────────────────────
  // 按**改前**的写法：思考块与正文同在一个容器的 innerHTML 里，重建即丢 open。
  // 这一段不依赖被测实现，只复刻旧结构，用来证明判据有分辨力。
  const legacy = document.createElement('div')
  legacy.className = 'md-body'
  document.body.appendChild(legacy)
  // 关键：重建模板里**不含** open —— 这正是旧实现的真实形状。
  // 用户点开产生的 open 只存在于 DOM 节点上，重建后自然消失。
  // （第一版反向对照把 open 写进了模板，重建后当然还在，那是个假对照。）
  const oldHtml = (n) =>
    '<div class="think-line" data-role="think-toggle"><span class="tl-preview">p' + n + '</span></div>' +
    '<div class="think-body" data-role="think-body">思考' + n + '</div>'
  legacy.innerHTML = oldHtml(0)
  legacy.querySelector('.think-line').classList.add('open')
  legacy.querySelector('.think-body').classList.add('open')
  const legacyBody0 = legacy.querySelector('.think-body')
  legacy.innerHTML = oldHtml(1)   // 旧实现每帧就是这么干的
  const legacyBody1 = legacy.querySelector('.think-body')
  const reverse = {
    sameNode: legacyBody1 === legacyBody0,
    stillOpen: !!(legacyBody1 && legacyBody1.classList.contains('open')),
  }

  const finalBody = host.querySelector('.think-body')
  const finalPreview = host.querySelector('.tl-preview')
  return {
    framesRun: lostAt === -1 ? frames : lostAt,
    lostAt,
    sameNode: finalBody === bodyNode0,
    stillOpen: !!(finalBody && finalBody.classList.contains('open')),
    bodyTextUpdated: !!(finalBody && finalBody.textContent.indexOf('第 ' + frames + ' 段思考') === 0),
    // I26 起预览是**滑动尾行**（'…' + 尾部 48 字），不再以首句开头。
    // 判据改为：预览必须反映第 30 帧的最新尾巴（尾部全是第 30 帧的 x），
    // 而不是"以第一句开头"——后者是旧实现的行为，钉住它等于禁止改进。
    previewUpdated: !!(finalPreview && /x{20,}$/.test(finalPreview.textContent)),
    bodyLen: finalBody ? finalBody.textContent.length : 0,
    reverse,
    frameLog,
  }
}, FRAMES)

const checks = []
const push = (ok, name, detail) => checks.push({ ok, name, detail })
if (result.fatal) {
  push(false, '前置：renderReason 可调用', result.fatal)
} else {
  push(result.lostAt === -1, '30 帧内未丢展开态', '在第 ' + result.lostAt + ' 帧丢')
  push(result.sameNode, '思考块是同一个 DOM 节点（未被重建）', '节点被替换')
  push(result.stillOpen, '.think-body.open 仍在', '')
  push(result.bodyTextUpdated, '思考正文跟随最新帧', '正文未更新到第 ' + FRAMES + ' 帧')
  push(result.previewUpdated, '预览行跟随最新帧', '')
}
// 反向对照：旧写法必须「丢 open」。若它也保住了 open，说明本用例根本没有分辨力。
push(result.reverse && result.reverse.sameNode === false,
  '反向对照：旧写法确实会替换节点', JSON.stringify(result.reverse || null))
push(result.reverse && result.reverse.stillOpen === false,
  '反向对照：旧写法确实会丢 .open', JSON.stringify(result.reverse || null))
push(errors.length === 0, '无页面异常', errors.slice(0, 3).join(' | '))

const ok = checks.every(c => c.ok)
for (const c of checks) {
  console.log('%s %s%s', c.ok ? 'PASS' : 'FAIL', c.name, (c.ok || !c.detail) ? '' : ' -> ' + c.detail)
}
console.log('')
console.log('THINK_OPEN: %s (%d/%d) frames=%d bodyLen=%d',
  ok ? 'PASS' : 'FAIL', checks.filter(c => c.ok).length, checks.length,
  result.framesRun || 0, result.bodyLen || 0)
await browser.close()
process.exit(ok ? 0 : 1)
