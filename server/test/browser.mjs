import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-browser-'))
process.env.HARBOR_CONFIG_DIR = path.join(tmp, 'config')
process.env.DATABASE_URL = `file:${path.join(tmp, 'app.db')}`
process.env.LOG_LEVEL = 'silent'
// 仅本测试允许回环页面；生产默认不设置，127.0.0.1/内网地址仍按 SSRF 拦截。
process.env.HARBOR_BROWSER_ALLOW_LOOPBACK = 'true'
let captcha = true
const page = `<!doctype html><title>Harbor Test</title><body><h1>浏览器测试页</h1><input id="name" value=""><button id="go" onclick="document.querySelector('#out').textContent='clicked:'+document.querySelector('#name').value">提交</button><div id="out">ready</div><article><a href="https://example.com/result">Harbor Result</a><p>实时搜索结果摘要</p></article></body>`
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  if (req.url.startsWith('/captcha') && captcha) { res.end('<title>verify</title><body>verify you are human CAPTCHA</body>'); return }
  res.end(page)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const browser = await import('../src/services/browser.js')
const { mergeConfig } = await import('../src/services/jsonstore.js')
const guard = await import('../src/services/guard.js')
mergeConfig('guard.json', JSON.stringify({ tiers: { browser_navigate: 'off', browser_extract: 'off', browser_click: 'always', browser_fill: 'off', browser_screenshot: 'off', browser_close: 'off', web_search: 'off' } }))
const results = []; const check = (name, fn) => { fn(); results.push(name) }

// R41（S2-16）：SSRF 判定与 Python _is_public_host 同口径
check('fake-ip 基准段 198.18.0.0/15 按公网放行', () => {
  assert.equal(browser.privateIp('198.18.0.1'), false)
  assert.equal(browser.privateIp('198.19.255.255'), false)
  assert.equal(browser.isFakeipBenchmark('198.18.5.5'), true)
  assert.equal(browser.isFakeipBenchmark('198.20.0.1'), false)
})
check('site-local fec0::/10 与 TEST-NET 段仍按私网拦截', () => {
  assert.equal(browser.privateIp('fec0::1'), true)
  assert.equal(browser.privateIp('febf::1'), true)
  assert.equal(browser.privateIp('192.0.2.1'), true)
  assert.equal(browser.privateIp('203.0.113.9'), true)
  assert.equal(browser.privateIp('10.1.2.3'), true)
  assert.equal(browser.privateIp('8.8.8.8'), false)
})
const fileBlocked = JSON.parse(await browser.browserNavigate('file:///C:/Windows/win.ini', '', 5, 'hidden'))
check('file 协议返回 NAV_BLOCKED', () => assert.equal(fileBlocked.error.code, 'NAV_BLOCKED'))
process.env.HARBOR_BROWSER_ALLOW_LOOPBACK = 'false'
const ssrfBlocked = JSON.parse(await browser.browserNavigate(`${base}/private`, '', 5, 'hidden'))
process.env.HARBOR_BROWSER_ALLOW_LOOPBACK = 'true'
check('未开测试例外时回环地址返回 SSRF_BLOCKED', () => assert.equal(ssrfBlocked.error.code, 'SSRF_BLOCKED'))
const nav = JSON.parse(await browser.browserNavigate(`${base}/page`, '#go', 30, 'hidden'))
check('后台导航创建会话', () => { assert.equal(nav.ok, true, nav.error); assert.match(nav.session_id, /^brw_/) })
const extracted = JSON.parse(await browser.browserExtract('body', 'text'))
check('正文提取返回真实页面文本且带 UNTRUSTED 来源', () => {
  assert.ok(extracted.content.includes('浏览器测试页'))
  assert.ok(extracted.content.includes('UNTRUSTED DATA'))
  assert.equal(extracted.untrusted, true)
})
const noToken = JSON.parse(await browser.browserClick('#go'))
check('always 点击无 token 返回 CONFIRM_REQUIRED', () => {
  assert.equal(noToken.error.code, 'CONFIRM_REQUIRED')
  assert.ok(noToken.error.message.includes('确认'))
})
const filled = JSON.parse(await browser.browserFill('#name', 'harbor'))
check('普通表单填充成功且不回显原文', () => { assert.equal(filled.ok, true, filled.error); assert.equal(filled.masked, true); assert.equal(filled.text, undefined) })
const token = JSON.parse(await guard.guardConfirmToken('browser_click', { target: '#go' })).token
const clicked = JSON.parse(await browser.browserClick('#go', token))
check('参数绑定 token 后真实点击', () => assert.equal(clicked.ok, true, clicked.error))
const after = JSON.parse(await browser.browserExtract('#out', 'text'))
check('点击副作用已发生', () => assert.ok(after.content.includes('clicked:harbor')))
const shot = JSON.parse(await browser.browserScreenshot(false))
check('页面截图返回 PNG base64', () => { assert.equal(shot.ok, true, shot.error); assert.ok(shot.image_base64.length > 100) })
const sessions = JSON.parse(await browser.browserSessions())
check('会话池投影可见', () => assert.equal(sessions.sessions.length, 1))
const mode = JSON.parse(await browser.browserSetMode('hidden', nav.session_id))
check('后台模式设置幂等', () => assert.equal(mode.ok, true))
const opened = JSON.parse(await browser.browserOpen({ url: `${base}/open`, selector: 'body', mode: 'text' }))
check('browser_open 一次性打开并提取', () => assert.ok(opened.content.includes('浏览器测试页')))
const searched = JSON.parse(await browser.browserSearch({ query: 'Harbor', search_url: `${base}/search` }))
check('实时搜索解析标题链接摘要', () => { assert.equal(searched.ok, true, searched.error); assert.equal(searched.results[0].title, 'Harbor Result'); assert.equal(searched.real_time, true) })
const challenge = JSON.parse(await browser.browserSearch({ query: 'Harbor', search_url: `${base}/captcha` }))
check('CAPTCHA fail-fast 返回 takeover_id', () => { assert.equal(challenge.error.code, 'CAPTCHA_REQUIRED'); assert.ok(challenge.error.takeover_id) })
captcha = false
const resumed = JSON.parse(await browser.browserTakeover(challenge.error.takeover_id, 'continue'))
check('人工接管复检后续跑原搜索', () => { assert.equal(resumed.ok, true, JSON.stringify(resumed)); assert.equal(resumed.resumed, true) })
await browser.browserNavigate(`${base}/pool-1`, '', 15, 'hidden')
await browser.browserNavigate(`${base}/pool-2`, '', 15, 'hidden')
await browser.browserNavigate(`${base}/pool-3`, '', 15, 'hidden')
const capped = JSON.parse(await browser.browserSessions())
check('会话池最多保留 3 个并自动驱逐最旧空闲项', () => assert.ok(capped.sessions.length <= 3))
const closed = JSON.parse(await browser.browserClose(''))
// P0-1b B4：closed 为已关会话 id 列表（legacy driver.close 口径），不再是计数
check('关闭全部浏览器会话（closed 为 id 列表）', () => {
  assert.equal(closed.ok, true)
  assert.ok(Array.isArray(closed.closed))
  assert.ok(closed.closed.length >= 1)
})
await new Promise(resolve => server.close(resolve))
console.log(JSON.stringify({ ok: true, checks: results.length, results }, null, 2))
