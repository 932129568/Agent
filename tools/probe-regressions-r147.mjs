/* 回归探针合集：把 16 项"一次性验证"变成可复跑
 *
 * 背景：v3.4 三十轮里有一批功能当时是用临时探针验的，探针没入库 —— 等于"当时验过、
 * 现在无法复查"。这个文件把它们收进一个命令里，每条都独立 PASS/FAIL。
 *
 * 运行：node tools/probe-regressions-r147.mjs
 * 退出码：0 = 全绿；1 = 有失例（打印明细）
 *
 * 判据选取原则：每条都对着**实现的真实副作用**，不对着记忆里的名字
 * （本仓踩过两次：查 kin-impact class 实际是内部 transform；查 .main 动画条数被常驻动画干扰）。
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

const cases = await page.evaluate(async () => {
  const out = []
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const add = (id, name, ok, detail) => out.push({ id, name, ok: !!ok, detail: detail === undefined ? '' : String(detail) })

  // ── I01 写后缓冲失效（纯函数，六情形） ──
  try {
    const mk = () => new Set(['a.txt@1', 'b.txt@1', 'a.txt.bak@1'])
    let s = mk()
    const r1 = invalidateReadCache(s, 'write_file', { path: 'a.txt' }, '{"ok":true}')
    add('I01', '精确失效（a.txt.bak 不被误伤）', r1 === 1 && s.has('a.txt.bak@1') && !s.has('a.txt@1'))
    s = mk(); const r2 = invalidateReadCache(s, 'write_file', undefined, '{"ok":true}')
    add('I01', 'args 缺失不崩且不失效', r2 === 0 && s.size === 3)
    s = mk(); invalidateReadCache(s, 'write_file', { path: 'a.txt' }, '{"ok":false}')
    add('I01', '失败结果不失效', s.size === 3)
    s = mk(); invalidateReadCache(s, 'run_command', {}, '{"ok":false}')
    add('I01', 'run_command 无条件清空', s.size === 0)
    s = mk(); invalidateReadCache(s, 'read_file', { path: 'a.txt' }, '{"ok":true}')
    add('I01', '非写工具不动缓存', s.size === 3)
  } catch (e) { add('I01', '异常', false, e.message) }

  // ── I13 LCS 还原性 ──
  try {
    let ok = true
    const pairs = [['a\nb\nc', 'a\nb\nc\nd'], ['a\nb\nc', 'a\nc'], ['x\ny', 'p\nq'], ['', 'a\nb']]
    for (const [o, n] of pairs) {
      const rows = guardLineDiff(o, n)
      const olds = rows.filter(r => r.type !== 'add').map(r => r.text).join('\n')
      const news = rows.filter(r => r.type !== 'del').map(r => r.text).join('\n')
      if (o !== '' && olds !== o) ok = false
      if (n !== '' && news !== n) ok = false
    }
    add('I13', 'LCS 往返（same+del 复原、same+add 复新）', ok)
    const c = guardLineDiff('a\r\nb', 'a\nb')
    add('I13', 'CRLF 与 LF 视为同内容', c.every(r => r.type === 'same'))
  } catch (e) { add('I13', '异常', false, e.message) }

  // ── I22 拖放磁吸：只做视觉，不双处理 ──
  try {
    const ia = document.getElementById('chatInputArea')
    if (ia) { ia.hidden = false; ia.style.display = '' }
    const dt = new DataTransfer()
    dt.items.add(new File(['hello'], 'mag.txt', { type: 'text/plain' }))
    const fire = (t, el) => el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }))
    fire('dragenter', document.body); await wait(50)
    add('I22', '拖入显示磁吸', document.body.classList.contains('drop-active') && !!document.getElementById('dropMagnet'))
    fire('dragleave', document.body); await wait(50)
    add('I22', '拖离清除', !document.body.classList.contains('drop-active'))
    fire('dragenter', document.body); await wait(40)
    const before = (typeof attachments !== 'undefined' && Array.isArray(attachments)) ? attachments.length : -1
    fire('drop', document.body); await wait(120)
    const after = (typeof attachments !== 'undefined' && Array.isArray(attachments)) ? attachments.length : -1
    add('I22', '释放后只加 1 份（磁吸层不处理文件）', after - before === 1, before + '→' + after)
  } catch (e) { add('I22', '异常', false, e.message) }

  // ── I20 搜索面板停靠：内容右边界 == 面板左边界 ──
  try {
    spManualOpen(); await wait(250)
    const panel = document.getElementById('searchPanel')
    const main = document.querySelector('.main')
    searchPanelToggleDock(); await wait(200)
    const pr = panel.getBoundingClientRect(), mr = main.getBoundingClientRect()
    const pad = parseFloat(getComputedStyle(main).paddingRight) || 0
    add('I20', '停靠后内容回流不重叠', Math.round(mr.right - pad) <= Math.round(pr.left) + 1,
      'content=' + Math.round(mr.right - pad) + ' panel=' + Math.round(pr.left))
    searchPanelToggleDock(); await wait(150)
    searchPanelClose()
  } catch (e) { add('I20', '异常', false, e.message) }

  // ── I21 灵动岛：忙碌展开 / 零态收缩 ──
  try {
    const el = headerIslandMount()
    const w0 = el ? getComputedStyle(el).maxWidth : ''
    headerIslandSetBusy(true); await wait(120)
    const w1 = el ? getComputedStyle(el).maxWidth : ''
    add('I21', 'busy 时弹性展开', w0 !== w1, w0 + '→' + w1)
    headerIslandSetBusy(false)
  } catch (e) { add('I21', '异常', false, e.message) }

  // ── I25 外观三档 ──
  try {
    const a = appearanceApply('airy'), b = appearanceApply('rich')
    const opA = getComputedStyle(document.documentElement).getPropertyValue('--glass-opacity').trim()
    add('I25', '三档写入真实变量', a === 'airy' && b === 'rich' && parseFloat(opA) > 0.8, 'opacity=' + opA)
    appearanceApply('standard')
  } catch (e) { add('I25', '异常', false, e.message) }

  // ── I11 分支往返 ──
  try {
    const s = { id: 'rb', messages: ['q1', 'a1', 'q2', 'a2'].map((c, i) => ({ role: i % 2 ? 'assistant' : 'user', content: c })) }
    const f = branchFork(s, 1, 'rbA')
    s.messages.push({ role: 'user', content: 'q3N' }, { role: 'assistant', content: 'a3N' })
    const g = branchFork(s, 2, 'rbB')
    const back = branchSwitch(s, f.id)
    add('I11', '二级分叉后切回一级往返精确',
      f.ok && g.ok && back.ok && s.messages.map(m => m.content).join(',') === 'q1,a1,q2,a2')
  } catch (e) { add('I11', '异常', false, e.message) }

  // ── I08 子代理：隔离 + 级联中止 ──
  try {
    const parent = { id: 'sp', messages: [] }
    const runner = (s) => Promise.resolve('结论' + 'x'.repeat(500))
    const h1 = subagentSpawn(parent, 'A', { runner })
    const h2 = subagentSpawn(parent, 'B', { runner })
    const distinct = h1.session.messages !== h2.session.messages
    await Promise.all([h1.promise, h2.promise])
    const summaries = parent.messages.length
    const never = () => new Promise(() => {})
    subagentSpawn(parent, 'C', { runner: never }); subagentSpawn(parent, 'D', { runner: never })
    const c = subagentCancelAll('sp')
    add('I08', '隔离且只回摘要', distinct && summaries === 2, 'summaries=' + summaries)
    add('I08', '级联中止 ≤100ms', c.count === 2 && c.ms <= 100, c.count + ' 个 / ' + c.ms + 'ms')
  } catch (e) { add('I08', '异常', false, e.message) }

  // ── I02 轨迹隔离 ──
  try {
    traceReset('tA'); traceReset('tB')
    traceAddToolRound({ sid: 'tA', toolCalls: [{ name: 'read_file' }], results: ['{}'] })
    traceAddToolRound({ sid: 'tB', toolCalls: [{ name: 'run_command' }, { name: 'mcp__x__y' }], results: ['{}', '{}'] })
    traceAddToolRound({ sid: 'tA', toolCalls: [{ name: 'write_file' }], results: ['{"ok":true}'] })
    add('I02', '两会话轨迹互不串台', traceSnapshot('tA').total === 2 && traceSnapshot('tB').total === 2)
  } catch (e) { add('I02', '异常', false, e.message) }

  // ── I12 步骤检查点 ──
  try {
    stepCkptClear()
    stepCkptNoteWrite('a.txt'); stepCkptNoteWrite('b.txt'); stepCkptNoteWrite('a.txt')
    let got = null
    const r = await stepCkptFlush(async (n, a, t) => { got = { n, a }; return '{"ok":true}' }, 'tk', 3, '')
    add('I12', 'id 形状 + 去重 + 清空',
      r.ok && r.id === 'tk-s3' && got.a[1].join(',') === 'a.txt,b.txt' && stepCkptPending().length === 0)
    const empty = await stepCkptFlush(async () => '{"ok":true}', 'tk', 4, '')
    add('I12', '空待结算不建假点', empty === null)
  } catch (e) { add('I12', '异常', false, e.message) }

  // ── I24 命令面板：静态+动态源 ──
  try {
    AppState.sessions = [{ id: 'pa', title: '面板A', updatedAt: Date.now(), messages: [] }]
    AppState.currentSessionId = 'cur'
    cpPaletteOpen(); await wait(120)
    const rows = document.querySelectorAll('.cp-row').length
    const hasSession = Array.from(document.querySelectorAll('.cp-row')).some(e => /会话：/.test(e.textContent))
    cpPaletteClose()
    add('I24', '命令面板含动态源', rows >= 12 && hasSession, 'rows=' + rows)
  } catch (e) { add('I24', '异常', false, e.message) }

  // ── I17 交接卡 + 副屏预览 ──
  try {
    const host = document.createElement('div'); document.body.appendChild(host)
    groupFullHandoffCard(host, '【交接文档】\n交接给：测试\n前端：完成')
    await wait(60)
    const card = host.querySelector('.gwb-handoff')
    const packet = card && card.querySelector('.gwb-packet')
    const anims = packet ? packet.getAnimations().length : -1
    const btn = card && card.querySelector('.gwb-preview')
    if (btn) btn.click()
    await wait(200)
    const prev = (document.querySelector('.cd-prev') || {}).textContent || ''
    add('I17', '光包在跑 + 一键预览到副屏', anims >= 1 && /交接给/.test(prev), 'anims=' + anims)
    contextDockClose(); host.remove()
  } catch (e) { add('I17', '异常', false, e.message) }

  // ── I23 副屏 4 标签 + 静止 0 轮询 ──
  try {
    contextDockOpen(); await wait(150)
    const root = document.getElementById('contextDock')
    const tabs = root ? root.querySelectorAll('.cd-tab').length : 0
    let polls = 0
    const orig = window.contextDockRefresh
    window.contextDockRefresh = function () { polls++; return orig.apply(this, arguments) }
    await wait(1200)
    window.contextDockRefresh = orig
    add('I23', '4 标签且静止不轮询', tabs === 4 && polls === 0, 'tabs=' + tabs + ' polls=' + polls)
    contextDockClose()
  } catch (e) { add('I23', '异常', false, e.message) }

  // ── I15 置顶区：只有 wait/bad 有纠偏 ──
  try {
    const mk = (id, st) => { const r = RunRegistry.start({ id, title: '会话' + id }); r.status = st }
    mk('pA', 'working'); mk('pB', 'paused'); mk('pC', 'failed')
    runPinboardMount(); await wait(120)
    const rows = Array.from(document.querySelectorAll('#runPinboard .rp-item'))
    const hasFix = rows.map(it => !!it.querySelector('.rp-fix'))
    add('I15', '只有 wait/bad 出纠偏入口', rows.length === 3 && hasFix.filter(Boolean).length === 2,
      JSON.stringify(hasFix))
    RunRegistry.all().forEach(r => { r.cancelled = true }); runPinboardRefresh()
  } catch (e) { add('I15', '异常', false, e.message) }

  // ── I10 锚点摘要 ──
  try {
    const s = { id: 'anc', messages: [
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: '决定采用方案A：先做基线\n改动涉及 run-controller.js\n' + 'x'.repeat(2000) },
      { role: 'user', content: '当前问题' }] }
    await compactHistory(s)
    const digests = s.messages.filter(m => m.__anchorDigest)
    add('I10', '锚点摘要保留决策与路径', digests.length === 1 &&
      /方案A/.test(digests[0].content) && /run-controller\.js/.test(digests[0].content))
    await compactHistory(s)
    add('I10', '二次压缩仍只有 1 条（幂等）', s.messages.filter(m => m.__anchorDigest).length === 1)
  } catch (e) { add('I10', '异常', false, e.message) }

  // ── I03 续跑残留：反序列化与请求双保险 ──
  try {
    const dirty = [{ id: 'x', messages: [
      { role: 'user', content: 'q' },
      { role: 'system', content: '【用户纠偏指令】x', __resumeDirective: true }] }]
    const removed = sanitizeResumeResidue(dirty)
    const msgs = [{ role: 'system', content: 'sys' },
      { role: 'system', content: '【用户纠偏指令】残留', __resumeDirective: true },
      { role: 'user', content: 'q' }]
    const norm = normalizeSystemMessages(msgs)
    add('I03', '残留剔除（两处入口）', removed === 1 && !JSON.stringify(norm).includes('纠偏指令'))
  } catch (e) { add('I03', '异常', false, e.message) }

  // ── I26 速率调速 ──
  try {
    streamRateReset()
    const none = streamRateApply()
    streamRateReset()
    for (let i = 0; i < 8; i++) streamRateSample(20, 5)
    const fast = streamRateApply()
    const mono = [10, 30, 60].map(c => streamRateDuration(c))
    add('I26', '无采样保守 + 快档最短 + 单调',
      none.cps === null && none.dur === 2600 && fast.dur === 320 && mono[0] > mono[1] && mono[1] > mono[2],
      JSON.stringify({ none: none.dur, fast: fast.dur, mono }))
  } catch (e) { add('I26', '异常', false, e.message) }

  return out
})
await browser.close()

const bad = cases.filter(c => !c.ok)
if (errs.length) bad.push({ id: 'PAGE', name: '页面异常', detail: errs[0] })

for (const c of cases) console.log((c.ok ? 'PASS ' : 'FAIL ') + c.id + ' · ' + c.name + (c.detail ? '  [' + c.detail + ']' : ''))
if (errs.length) console.log('PAGEERROR: ' + errs[0])

if (bad.length) {
  console.log('\nREGRESSIONS: FAIL (' + bad.length + '/' + cases.length + ' 失例)')
  process.exit(1)
}
console.log('\nREGRESSIONS: PASS (' + cases.length + ' 项)')
