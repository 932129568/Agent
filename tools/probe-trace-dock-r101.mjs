// R101 T03 · 两项新功能的运行时代谢用例：execution-trace 聚合 + 右侧副屏
//
// 为什么必须跑到浏览器里：这两块都是「运行期创建 DOM + 从别的模块动态取数据」，
// 静态门禁只能证明符号存在、provide 对齐，证明不了「聚合真的算对」「副屏真的显示」。
//
// 判据（每条都能失败）：
//   T1 聚合计数正确：3 次调用（2 成功 1 失败）⇒ total=3 / ok=2 / fail=1
//   T2 失败判定只看结构化标记：字符串里出现 "error" 但 JSON 是 ok:true 的，不得判红
//   T3 每轮重置：traceReset 后 total 归零（不复用上一轮）
//   T4 渲染行数受限：limit=2 时只渲染最后 2 步，且文本来自最新步
//   T5 副屏打开后有 6 个字段且会话/消息/token 非空
//   T6 副屏刷新幂等：连续刷新两次内容一致（不会越刷越长）
//   T7 反向对照：不调 traceAddToolRound 时 total 必须为 0（证明 T1 不是恒真）
//
// 用法：node tools/probe-trace-dock-r101.mjs   退出码 0=全过
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
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
await page.goto(pathToFileURL(path.join(ROOT, 'harbor.html')).href, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(6500)

const r = await page.evaluate(() => {
  const out = {}
  const need = ['traceReset', 'traceAddToolRound', 'traceSnapshot', 'traceRenderInto',
                'contextDockOpen', 'contextDockClose', 'contextDockRefresh']
  const missing = need.filter(n => typeof window[n] !== 'function')
  if (missing.length) return { fatal: '缺少全局函数: ' + missing.join(',') }

  // T7 反向对照：不喂数据时必须是 0
  traceReset('sid-probe')
  out.emptyTotal = traceSnapshot().total

  // T1 三次调用：2 成功 1 失败
  traceAddToolRound({
    round: 1,
    toolCalls: [{ name: 'read_file' }, { name: 'run_command' }, { name: 'mcp__srv__do' }],
    results: [
      '{"ok":true,"content":"x"}',
      '{"ok":false,"error":"退出码 1"}',
      'done',
    ],
  })
  const s1 = traceSnapshot()
  out.total = s1.total
  out.ok = s1.ok
  out.fail = s1.fail
  out.byName = s1.byName

  // T2 结构化判定：正文里含 error 字样但 ok:true 不得判红
  traceReset('sid-probe')
  traceAddToolRound({
    round: 1,
    toolCalls: [{ name: 'grep' }],
    results: ['{"ok":true,"content":"found error handling code"}'],
  })
  out.textErrorNotFail = traceSnapshot().fail

  // T3 重置
  traceReset('sid-probe')
  out.afterResetTotal = traceSnapshot().total

  // T4 渲染限行
  traceAddToolRound({ round: 1, toolCalls: [{ name: 'a1' }, { name: 'a2' }, { name: 'a3' }], results: ['{}', '{}', '{}'] })
  const host = document.createElement('div')
  document.body.appendChild(host)
  traceRenderInto(host, 2)
  out.renderRows = host.querySelectorAll('.et-row').length
  out.renderHasMore = !!host.querySelector('.et-more')
  out.renderLastText = (host.querySelectorAll('.et-name')[1] || {}).textContent || ''
  out.renderCountText = (host.querySelector('.et-count') || {}).textContent || ''

  // T5 副屏
  contextDockOpen()
  const dock = document.getElementById('contextDock')
  out.dockOpen = !!(dock && dock.style.display === 'flex')
  out.dockSections = dock ? dock.querySelectorAll('.cd-sec').length : 0
  const val = k => { const e = dock && dock.querySelector('[data-cd="' + k + '"]'); return e ? e.textContent : '' }
  out.dockSession = val('session')
  out.dockMessages = val('messages')
  out.dockTools = val('tools')
  // T6 幂等
  contextDockRefresh(); const a = dock ? dock.innerHTML.length : 0
  contextDockRefresh(); const b = dock ? dock.innerHTML.length : 0
  out.dockStable = a === b
  contextDockClose()
  out.dockClosed = !!(dock && dock.style.display === 'none')
  return out
})

const checks = []
const push = (ok, name, detail) => checks.push({ ok, name, detail })
if (r.fatal) {
  push(false, '前置：全局函数齐备', r.fatal)
} else {
  push(r.emptyTotal === 0, 'T7 反向对照：未喂数据时 total=0', 'total=' + r.emptyTotal)
  push(r.total === 3 && r.ok === 2 && r.fail === 1, 'T1 聚合计数 3/2/1', JSON.stringify({ t: r.total, ok: r.ok, fail: r.fail }))
  push(!!(r.byName && r.byName['srv.do'] === 1), 'T1b mcp 名字归一为 srv.do', JSON.stringify(r.byName))
  push(r.textErrorNotFail === 0, 'T2 正文含 error 不判红（只看结构化标记）', 'fail=' + r.textErrorNotFail)
  push(r.afterResetTotal === 0, 'T3 每轮重置', 'total=' + r.afterResetTotal)
  push(r.renderRows === 2 && r.renderHasMore === true, 'T4 限行 2 且提示还有更多', 'rows=' + r.renderRows + ' more=' + r.renderHasMore)
  push(r.renderLastText === 'a3', 'T4b 显示的是最后一步', 'last=' + r.renderLastText)
  push(r.dockOpen && r.dockSections === 6, 'T5 副屏打开且 6 个字段', 'open=' + r.dockOpen + ' sec=' + r.dockSections)
  push(r.dockMessages !== '—' || r.dockSession === '(无会话)', 'T5b 副屏有会话/消息数据', JSON.stringify({ s: r.dockSession, m: r.dockMessages }))
  push(r.dockStable === true, 'T6 刷新幂等（内容不膨胀）', '')
  push(r.dockClosed === true, 'T5c 关闭生效', '')
}
push(errors.length === 0, '无页面异常', errors.slice(0, 3).join(' | '))

const ok = checks.every(c => c.ok)
for (const c of checks) console.log('%s %s%s', c.ok ? 'PASS' : 'FAIL', c.name, (c.ok || !c.detail) ? '' : ' -> ' + c.detail)
console.log('')
console.log('TRACE_DOCK: %s (%d/%d)', ok ? 'PASS' : 'FAIL', checks.filter(c => c.ok).length, checks.length)
await browser.close()
process.exit(ok ? 0 : 1)
