/**
 * Agent 浏览器闭环验收门：观察 → 决策 → 动作 → 再观察。
 *
 * 与 browser.mjs（既有 20 项原语兼容性门）互补：
 *   - 稳定 @eN 元素引用、ref 索引与 UNTRUSTED 包裹
 *   - 动作返回 observation / diff / next / step（闭环）
 *   - REF_NOT_FOUND / REF_STALE / TARGET_NOT_VISIBLE 错误码
 *   - 既有返回字段向后兼容
 *
 * 用法：node server/test/browser-agent.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-browser-agent-'))
process.env.HARBOR_CONFIG_DIR = path.join(tmp, 'config')
process.env.DATABASE_URL = `file:${path.join(tmp, 'app.db')}`
process.env.LOG_LEVEL = 'silent'
process.env.HARBOR_BROWSER_ALLOW_LOOPBACK = 'true'

const pageHtml = `<!doctype html><title>Agent Loop Test</title><body>
<h1>闭环测试页</h1>
<input id="name" aria-label="姓名" value="">
<button id="go" onclick="document.querySelector('#out').textContent='clicked:'+document.querySelector('#name').value">提交</button>
<div id="out">ready</div>
<a href="https://example.com/result">结果链接</a>
</body>`
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(pageHtml)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const browser = await import('../src/services/browser.js')
const agent = await import('../src/services/browser-agent.js')
const guard = await import('../src/services/guard.js')
const { mergeConfig } = await import('../src/services/jsonstore.js')
mergeConfig('guard.json', JSON.stringify({ tiers: {
  browser_navigate: 'off', browser_extract: 'off', browser_snapshot: 'off',
  browser_click: 'always', browser_fill: 'off', browser_screenshot: 'off',
  browser_close: 'off', web_search: 'off',
} }))

const results = []
const check = async (name, fn) => { await fn(); results.push(name) }
const run = async fn => JSON.parse(await fn())
const tokenFor = async (op, detail) =>
  JSON.parse(await guard.guardConfirmToken(op, detail)).token

// ---- 1. 错误码 taxonomy（纯单元，不依赖浏览器） ----
await check('BrowserErrorCode 覆盖 Agent 闭环所需码', () => {
  for (const code of ['BAD_PARAMS', 'SSRF_BLOCKED', 'SESSION_BUSY', 'EXTRACT_EMPTY',
    'REF_NOT_FOUND', 'REF_STALE', 'TARGET_NOT_VISIBLE', 'CONFIRM_REQUIRED']) {
    assert.equal(agent.BrowserErrorCode[code], code)
  }
  assert.equal(Object.isFrozen(agent.BrowserErrorCode), true)
})

// ---- 2. resolveTarget 的 ref 分支（fake page，覆盖缺失/失效） ----
const fakePage = {
  locator: () => ({ first: () => ({ count: async () => 0 }) }),
  getByText: () => ({ first: () => ({ count: async () => 0 }) }),
}
await check('未知 @eN 返回 REF_NOT_FOUND', async () => {
  await assert.rejects(
    () => agent.resolveTarget(fakePage, '@e99', new Map()),
    e => e.code === 'REF_NOT_FOUND' && /browser_snapshot/.test(e.hint))
})
await check('ref 指向已从文档移除的元素返回 REF_STALE', async () => {
  const map = new Map([['@e1', { ref: '@e1', selector: '[data-harbor-ref="@e1"]' }]])
  await assert.rejects(
    () => agent.resolveTarget(fakePage, '@e1', map),
    e => e.code === 'REF_STALE')
})

// ---- 3. 导航即建立观察层 ----
const nav = await run(() => browser.browserNavigate(`${base}/`, '', 15, 'hidden'))
await check('导航返回统一观察信封与 @eN 索引', () => {
  assert.equal(nav.ok, true, nav.error)
  assert.equal(nav.observation.step, 0)
  assert.equal(nav.observation.url, `${base}/`)
  assert.equal(nav.observation.title, 'Agent Loop Test')
  assert.ok(nav.observation.element_refs.length >= 3)
  assert.equal(nav.observation.ref_count, nav.observation.element_refs.length)
  assert.equal(nav.observation.untrusted, true)
  assert.ok(nav.observation.source.url)
  // 向后兼容：既有字段仍在
  assert.ok(nav.session_id && nav.url && nav.final_url && nav.title && nav.mode)
})

// ---- 4. 语义快照同时产出可读 ref 索引 ----
const snap = await run(() => browser.browserSnapshot('', 4000))
const buttonRef = snap.observation.element_refs.find(r => r.role === 'button')?.ref
const inputRef = snap.observation.element_refs.find(r => r.tag === 'input')?.ref
await check('快照返回 ref_table（UNTRUSTED 包裹）与结构化 refs', () => {
  assert.equal(snap.ok, true, snap.error)
  assert.ok(snap.ref_table.includes('UNTRUSTED DATA'))
  assert.ok(snap.ref_table.includes('@e1'))
  assert.ok(snap.ref_count >= 3)
  assert.ok(/button|link|heading/.test(snap.snapshot))
  assert.ok(buttonRef && inputRef, '应能找到 button / input 的 @eN')
  assert.equal(snap.next.includes('browser_click'), true)
})

// ---- 5. 按 @eN 动作，返回闭环观察与 diff ----
const filled = await run(() => browser.browserFill(inputRef, 'harbor'))
await check('按 @eN 填充输入框不回显原文且 step 递增', () => {
  assert.equal(filled.ok, true, filled.error)
  assert.equal(filled.masked, true)
  assert.equal(filled.text, undefined)
  assert.equal(filled.ref, inputRef)
  assert.equal(filled.target_kind, 'ref')
  assert.equal(filled.step, 1)
  assert.equal(filled.observation.step, 1)
  assert.ok(filled.diff && typeof filled.diff.url_changed === 'boolean')
  assert.equal(filled.next, 'browser_snapshot')
  assert.ok(filled.action_id.startsWith('act_'))
  // 向后兼容
  assert.ok(filled.selector && filled.filled && filled.session_id)
})

const clickToken = await tokenFor('browser_click', { target: buttonRef })
const clicked = await run(() => browser.browserClick(buttonRef, clickToken))
await check('按 @eN 点击完成观察→动作→再观察闭环', () => {
  assert.equal(clicked.ok, true, clicked.error)
  assert.equal(clicked.clicked, buttonRef)
  assert.equal(clicked.ref, buttonRef)
  assert.equal(clicked.target_kind, 'ref')
  assert.equal(clicked.step, 2)
  assert.equal(clicked.observation.step, 2)
  assert.ok(clicked.observation.url && clicked.observation.ready_state)
  assert.ok(clicked.diff && typeof clicked.diff.elements_delta === 'number')
  assert.equal(clicked.next, 'browser_snapshot')
  assert.ok(clicked.reason.includes('browser_click'))
  // 向后兼容：既有截图审计字段仍在
  assert.ok(clicked.before_b64.length > 100 && clicked.after_b64.length > 100)
  assert.ok(clicked.url && clicked.session_id)
})

await check('点击副作用真实发生且提取带观察信封', async () => {
  const out = await run(() => browser.browserExtract('#out', 'text'))
  assert.ok(out.content.includes('clicked:harbor'))
  assert.ok(out.observation && typeof out.observation.step === 'number')
})

// ---- 6. 未知 ref 在真实原语上返回结构化错误 ----
const badToken = await tokenFor('browser_click', { target: '@e999' })
const bad = await run(() => browser.browserClick('@e999', badToken))
await check('原语层未知 ref 返回 REF_NOT_FOUND', () => {
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'REF_NOT_FOUND')
  assert.ok(bad.error.hint.includes('browser_snapshot'))
})

// ---- 7. 会话投影暴露 step 与 ref_count ----
const sessions = await run(() => browser.browserSessions())
await check('会话投影带 step 与 ref_count', () => {
  assert.equal(sessions.ok, true)
  const s = sessions.sessions.find(x => x.session_id === nav.session_id)
  assert.ok(s)
  assert.equal(s.step, 2)
  assert.ok(typeof s.ref_count === 'number')
})

await browser.browserClose('')
server.close()
console.log(JSON.stringify({ ok: true, checks: results.length, results }, null, 2))
