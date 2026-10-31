/** 浏览器驱动：Playwright、SSRF 防护、六原语、实时搜索与 CAPTCHA 接管。 */
import fs from 'node:fs'
import crypto from 'node:crypto'
import net from 'node:net'
import dns from 'node:dns/promises'
import { chromium } from 'playwright-core'
import { enforceExec } from './guard.js'
import { ctxSid, registerSidContainer } from '../session-context.js'

const sessions = new Map()
const takeovers = new Map()
const urlCache = new Map()
const MAX_SESSIONS = 3
const IDLE_MS = 60000
// P0-3：浏览器游标 per-sid（A 的 extract 不落到 B 的页面）；池全局共享上限 3 不变
const cursors = registerSidContainer('cursors', new Map())   // sid -> sessionId
function cursorFor(sid) { return cursors.get(sid) || '' }
function setCursor(id) { cursors.set(ctxSid(), id) }
function clearCursorIf(id) {
  for (const [sid, value] of cursors) {
    if (value === id) cursors.set(sid, [...sessions.keys()].at(-1) || '')
  }
}
const json = value => JSON.stringify(value)
const fail = (code, message, hint = '', extra = {}) => json({ ok: false,
  error: { code, message, ...(hint ? { hint } : {}), ...extra } })
const parse = value => { if (value && typeof value === 'object') return value; try { return JSON.parse(value || '{}') } catch { return {} } }
const captchaText = text => /captcha|verify you are human|unusual traffic|人机验证|安全验证|滑动.*验证/i.test(String(text || ''))

function edgePath() {
  if (process.env.HARBOR_BROWSER_EXE) return process.env.HARBOR_BROWSER_EXE
  return ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(fs.existsSync) || undefined
}
function privateIp(ip) {
  let value = String(ip || '').toLowerCase().split('%')[0]
  if (value.startsWith('::ffff:')) value = value.slice(7)
  if (net.isIPv6(value)) return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') || value.startsWith('ff')
  if (!net.isIPv4(value)) return true
  const parts = value.split('.').map(Number)
  const [a, b] = parts
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
}
async function validateUrl(raw) {
  // 文案/判定逐字对齐 legacy session_win.navigate（P0-1b B7）：
  // 协议 → NAV_BLOCKED；字面 IP 私网/环回 → SSRF_BLOCKED；DNS 失败放行
  // （legacy 2026-10-21 修订：fetch 经同一解析器自然失败，fail-closed 无增益）
  const text = String(raw || '').trim()
  if (!text || text.length > 2048) throw { code: 'BAD_PARAMS', message: 'url 为空或超过 2048 字符' }
  let url
  try { url = new URL(text) } catch { throw { code: 'BAD_PARAMS', message: 'url 格式无效' } }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw { code: 'NAV_BLOCKED', message: `已阻止非 http(s) 导航: ${text.slice(0, 80)}`, hint: '浏览器仅支持 http/https 链接' }
  }
  if (url.username || url.password || !url.hostname) throw { code: 'BAD_PARAMS', message: 'url 不得包含凭证且必须有主机名' }
  const loopbackAllowed = process.env.HARBOR_BROWSER_ALLOW_LOOPBACK === 'true'
  const cacheKey = `${loopbackAllowed}:${url.href}`
  if (urlCache.has(cacheKey)) return urlCache.get(cacheKey)
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (loopbackAllowed && ['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
    const result = { url: url.href }; urlCache.set(cacheKey, result); return result
  }
  let addresses = []
  try {
    addresses = net.isIP(hostname) ? [hostname] : (await dns.lookup(hostname, { all: true, verbatim: true })).map(x => x.address)
  } catch { addresses = [] } // DNS 失败放行（legacy 口径）
  if (addresses.length && addresses.some(privateIp)) {
    throw { code: 'SSRF_BLOCKED', message: `已阻止访问内网/环回地址: ${text.slice(0, 80)}`, hint: '禁止访问内网/环回地址' }
  }
  const result = { url: url.href }
  if (urlCache.size > 500) urlCache.clear()
  urlCache.set(cacheKey, result)
  return result
}
async function installRequestGuard(page) {
  await page.route('**/*', async route => {
    const url = route.request().url()
    if (/^(data:|blob:|about:)/.test(url)) return route.continue()
    try { await validateUrl(url); return route.continue() }
    catch { return route.abort('blockedbyclient') }
  })
}
async function guard(op, detail, token) {
  const refusal = await enforceExec(op, detail, token)
  return refusal ? fail('CONFIRM_REQUIRED', refusal, '', { op }) : null
}
async function closeOne(id) {
  const entry = sessions.get(id)
  if (!entry) return 0
  sessions.delete(id)
  clearCursorIf(id)
  await entry.browser.close().catch(() => {})
  return 1
}
async function reclaimSessions() {
  const now = Date.now()
  for (const entry of [...sessions.values()]) {
    if (!entry.busy && now - entry.last_used > IDLE_MS) await closeOne(entry.id)
  }
  if (sessions.size < MAX_SESSIONS) return
  const oldest = [...sessions.values()].filter(x => !x.busy).sort((a, b) => a.last_used - b.last_used)[0] || [...sessions.values()][0]
  if (oldest) await closeOne(oldest.id)
}
async function newSession(url, mode = 'hidden', timeout = 60, waitSelector = '') {
  await validateUrl(url)
  await reclaimSessions()
  const browser = await chromium.launch({ executablePath: edgePath(), headless: mode !== 'visible',
    args: ['--disable-gpu', '--no-first-run', '--disable-background-networking'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false })
  const page = await context.newPage()
  await installRequestGuard(page)
  const id = `brw_${crypto.randomBytes(6).toString('hex')}`
  const entry = { id, browser, context, page, mode, url: '', title: '', busy: false,
    created_at: new Date().toISOString(), last_used: Date.now() }
  sessions.set(id, entry); setCursor(id)
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(1000, Number(timeout) * 1000 || 60000) })
    await validateUrl(page.url())
    if (waitSelector) await page.waitForSelector(waitSelector, { timeout: Math.max(1000, Number(timeout) * 1000 || 60000) })
    entry.url = page.url(); entry.title = await page.title(); entry.last_used = Date.now()
    return entry
  } catch (error) { await closeOne(id); throw error }
}
function current(sessionId = '', exclusive = true) {
  // legacy _prim 口径（P0-1b B8）：无会话 → BAD_PARAMS + 人话 hint
  const entry = sessions.get(sessionId || cursorFor(ctxSid()))
  if (!entry) {
    throw { code: 'BAD_PARAMS', message: '没有可用浏览器会话（先 browser_navigate）', hint: '会话可能已被回收，请重新导航' }
  }
  if (exclusive && entry.busy) throw { code: 'SESSION_BUSY', message: '会话忙：原语执行中（单会话串行，重入被拒）' }
  if (exclusive) entry.busy = true
  entry.last_used = Date.now()
  return entry
}
function asError(error, fallback = 'INTERNAL') {
  if (error?.code && error?.message) return fail(error.code, error.message, error.hint || '')
  if (/timeout/i.test(error?.message || '')) return fail('TIMEOUT', error.message)
  return fail(fallback, String(error?.message || error))
}
function provenance(url, channel = 'playwright') {
  return { url: String(url || ''), channel, fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') }
}
function wrapUntrusted(text, url, channel = 'playwright') {
  const source = provenance(url, channel)
  return `[UNTRUSTED DATA — 来源: ${source.url} · 抓取于 ${source.fetched_at} · 通道: ${source.channel}]\n${String(text ?? '')}\n[END UNTRUSTED DATA]`
}
async function extractPage(entry, selector = '', mode = 'markdown') {
  if (!['markdown', 'text', 'links'].includes(mode)) throw { code: 'BAD_PARAMS', message: 'mode 仅支持 markdown/text/links' }
  const locator = selector ? entry.page.locator(String(selector)).first() : entry.page.locator('body')
  await locator.waitFor({ state: 'attached', timeout: 15000 })
  const url = entry.page.url(); const title = await entry.page.title()
  if (mode === 'links') {
    const links = await locator.locator('a[href]').evaluateAll(nodes => nodes.slice(0, 200).map(a => ({ title: (a.innerText || a.textContent || '').trim(), url: a.href })))
    if (!links.length) throw { code: 'EXTRACT_EMPTY', message: '页面未提取到链接' }
    return { ok: true, mode, links, url, final_url: url, title, session_id: entry.id,
      char_count: links.reduce((n, x) => n + x.title.length + x.url.length, 0), truncated: false,
      untrusted: true, source: provenance(url) }
  }
  let content = await locator.innerText({ timeout: 15000 })
  if (!content.trim()) throw { code: 'EXTRACT_EMPTY', message: '页面正文为空' }
  if (mode === 'markdown') {
    const links = await locator.locator('a[href]').evaluateAll(nodes => nodes.slice(0, 100).map(a => `- [${(a.innerText || a.textContent || '').trim()}](${a.href})`))
    if (links.length) content += `\n\n链接：\n${links.join('\n')}`
  }
  const wrapped = wrapUntrusted(content, url)
  return { ok: true, mode, content: wrapped, markdown: mode === 'markdown' ? wrapped : undefined,
    text: mode === 'text' ? wrapped : undefined, url, final_url: url, title, session_id: entry.id,
    char_count: content.length, truncated: false, untrusted: true, source: provenance(url) }
}

export async function browserNavigate(url, waitSelector = '', timeout = 60, mode = 'hidden', token = null) {
  if (!['hidden', 'visible'].includes(mode)) return fail('BAD_PARAMS', 'mode 仅支持 hidden/visible')
  const refusal = await guard('browser_navigate', { url: String(url || '').slice(0, 200) }, token)
  if (refusal) return refusal
  try {
    const entry = await newSession(String(url || '').trim(), mode, timeout, waitSelector)
    return json({ ok: true, session_id: entry.id, url: entry.url, final_url: entry.url,
      title: entry.title, mode: entry.mode, channel: 'playwright' })
  } catch (error) { return asError(error) }
}
export async function browserExtract(selector = '', mode = 'markdown', token = null) {
  const refusal = await guard('browser_extract', { selector: String(selector || '').slice(0, 80) }, token)
  if (refusal) return refusal
  let entry
  try { entry = current(); return json(await extractPage(entry, selector, mode)) }
  catch (error) { return asError(error) }
  finally { if (entry) entry.busy = false }
}
export async function browserClick(target, token = null) {
  const value = String(target || '').trim()
  if (!value) return fail('BAD_PARAMS', '缺少点击目标')
  const refusal = await guard('browser_click', { target: value.slice(0, 120) }, token)
  if (refusal) return refusal
  let entry
  try {
    entry = current(); let locator
    if (value.startsWith('text=')) locator = entry.page.getByText(value.slice(5), { exact: false }).first()
    else {
      locator = entry.page.locator(value).first()
      if (await locator.count() === 0) locator = entry.page.getByText(value, { exact: false }).first()
    }
    if (!(await locator.isVisible())) throw { code: 'BAD_PARAMS', message: '目标不可见，已拒绝点击' }
    const before = await entry.page.screenshot({ type: 'png' })
    await locator.click({ timeout: 15000 })
    await entry.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
    const after = await entry.page.screenshot({ type: 'png' })
    return json({ ok: true, clicked: value, url: entry.page.url(), session_id: entry.id,
      before_b64: before.toString('base64'), after_b64: after.toString('base64') })
  } catch (error) { return asError(error) }
  finally { if (entry) entry.busy = false }
}
export async function browserFill(selector, text, token = null) {
  const value = String(selector || '').trim()
  if (!value) return fail('BAD_PARAMS', '缺少表单 selector')
  const detail = { selector: value.slice(0, 80), text_len: String(text ?? '').length }
  const refusal = await guard('browser_fill', detail, token)
  if (refusal) return refusal
  let entry
  try {
    entry = current(); const locator = entry.page.locator(value).first()
    const meta = await locator.evaluate(el => ({ type: String(el.type || ''), name: `${el.name || ''} ${el.id || ''} ${el.autocomplete || ''}` }))
    if (meta.type === 'password' || meta.type === 'file' || /password|passwd|secret|token|credential/i.test(meta.name)) {
      throw { code: 'BAD_PARAMS', message: '密码/文件/敏感凭证字段禁止由 Agent 自动填充' }
    }
    await locator.fill(String(text ?? ''), { timeout: 15000 })
    return json({ ok: true, selector: value, filled: true, masked: true, text_len: detail.text_len, session_id: entry.id })
  } catch (error) { return asError(error) }
  finally { if (entry) entry.busy = false }
}
export async function browserScreenshot(fullPage = false, token = null) {
  const refusal = await guard('browser_screenshot', {}, token)
  if (refusal) return refusal
  let entry
  try {
    entry = current(); const data = await entry.page.screenshot({ fullPage: !!fullPage, type: 'png' })
    const b64 = data.toString('base64'); const size = entry.page.viewportSize() || { width: 0, height: 0 }
    return json({ ok: true, b64, image_base64: b64, dataUrl: `data:image/png;base64,${b64}`,
      mime: 'image/png', full_page: !!fullPage, width: size.width, height: size.height, session_id: entry.id })
  } catch (error) { return asError(error) }
  finally { if (entry) entry.busy = false }
}
export async function browserClose(sessionId = '', token = null) {
  const refusal = await guard('browser_close', { session_id: String(sessionId || '') }, token)
  if (refusal) return refusal
  // legacy driver.close 口径（P0-1b B4）：closed 为已关会话 id 列表；
  // 指定 id 不存在 → 空列表 + note；缺省关全部（空池无 note）
  let closed = []
  if (sessionId) {
    if (sessions.has(sessionId)) {
      closed = [sessionId]
      await closeOne(sessionId)
    }
    if (!closed.length) {
      return json({ ok: true, closed, note: '会话不存在或已关闭' })
    }
  } else {
    for (const id of [...sessions.keys()]) closed.push(...(await closeOne(id) ? [id] : []))
  }
  return json({ ok: true, closed })
}
export async function browserShutdown() {
  let closed = 0
  for (const id of [...sessions.keys()]) closed += await closeOne(id)
  takeovers.clear(); return closed
}
export async function browserSessions() {
  // legacy driver.sessions 口径（P0-1b B2）：{ok:true, version, sessions}
  return json({ ok: true, version: 1, sessions: [...sessions.values()].map(x => ({ session_id: x.id,
    url: x.page.url(), title: x.title, mode: x.mode, state: x.busy ? 'busy' : 'ready',
    created_at: x.created_at, last_used: x.last_used })) })
}
export async function browserSetMode(mode, sessionId = '') {
  // legacy driver.set_mode 口径（P0-1b B3）：会话存在性先于 mode 合法性；
  // 无会话 → BAD_PARAMS '没有可用浏览器会话'（无 hint）
  if (sessionId) {
    if (!sessions.has(sessionId)) return fail('BAD_PARAMS', '没有可用浏览器会话')
  } else if (!sessions.size) {
    return fail('BAD_PARAMS', '没有可用浏览器会话')
  }
  if (!['hidden', 'visible'].includes(mode)) return fail('BAD_PARAMS', 'mode 仅支持 hidden/visible')
  try {
    const targets = sessionId ? [sessions.get(sessionId)] : [...sessions.values()]
    for (const entry of targets) entry.mode = mode
    return json({ ok: true, mode, sessions: targets.map(x => x.id), note: '模式已记录；新建导航按该模式创建，已有窗口切换由桌面壳接管。' })
  } catch (error) { return asError(error) }
}
export async function browserOpen(params) {
  const input = parse(params)
  if (!input.url) return fail('BAD_PARAMS', '缺少 url')
  let id = ''
  try {
    const entry = await newSession(String(input.url), 'hidden', input.timeout || 45, input.wait_selector || '')
    id = entry.id
    const result = await extractPage(entry, input.selector || '', input.mode || 'markdown')
    await closeOne(id)
    return json(result)
  } catch (error) { if (id) await closeOne(id); return asError(error) }
}
async function searchResults(page) {
  const bing = await page.locator('li.b_algo').evaluateAll(items => items.slice(0, 10).map(item => {
    const a = item.querySelector('h2 a'); const p = item.querySelector('.b_caption p')
    return a ? { title: (a.innerText || '').trim(), url: a.href, snippet: (p?.innerText || '').trim() } : null
  }).filter(Boolean))
  if (bing.length) return bing
  return page.locator('a[href]').evaluateAll(nodes => nodes.map(a => ({ title: (a.innerText || a.textContent || '').trim(), url: a.href,
    snippet: (a.closest('article,li,div')?.innerText || '').trim().slice(0, 500) }))
    .filter(x => x.title && /^https?:/.test(x.url)).slice(0, 10))
}
export async function browserSearch(params, token = null) {
  const input = parse(params); const query = String(input.query || '').trim()
  // legacy service 校验口径（P0-1b B5）：文案+hint 逐字
  if (!query) return fail('BAD_PARAMS', 'query 不能为空（1-500 字符的检索词）', '例如 {"query": "python 教程"}')
  const refusal = await guard('web_search', { query: query.slice(0, 120) }, token)
  if (refusal) return refusal
  const url = input.search_url || `https://www.bing.com/search?q=${encodeURIComponent(query)}`
  let entry
  try {
    entry = await newSession(url, input.mode === 'visible' ? 'visible' : 'hidden', input.timeout || 45)
    const body = await entry.page.locator('body').innerText()
    if (captchaText(body)) {
      const takeoverId = `tk_${crypto.randomBytes(6).toString('hex')}`
      takeovers.set(takeoverId, { id: takeoverId, sessionId: entry.id, query, retry: 0 })
      return fail('CAPTCHA_REQUIRED', '搜索页需要人工完成验证', '', { takeover_id: takeoverId })
    }
    const results = await searchResults(entry.page)
    return json({ ok: true, query, results, count: results.length, session_id: entry.id,
      real_time: true, source: 'live', untrusted: true,
      provenance: { engine: input.engine || 'bing', query_sha256: crypto.createHash('sha256').update(query).digest('hex').slice(0, 16), fetched_at: new Date().toISOString() } })
  } catch (error) { if (entry) await closeOne(entry.id); return asError(error) }
}
export async function searchStatus(taskId = '') {
  const id = String(taskId || '')
  const pending = id ? takeovers.get(id) : takeovers.values().next().value
  if (pending) return json({ ok: true, active: true, state: 'captcha_required', task_id: pending.id,
    takeover_id: pending.id, query: pending.query, retry: pending.retry })
  // P0-1c CF7（service.py:1180-1197）：无活跃搜索 → {ok, active}（无 state/
  // task_id 回显）；传了 id 但查无任务 → unknown_task 标记（与「无活跃」区分，
  // 前端可止轮询而非误判终态）
  if (id) return json({ ok: true, active: false, unknown_task: true })
  return json({ ok: true, active: false })
}
export async function browserTakeover(takeoverId, action) {
  // legacy service.browser_takeover 口径（P0-1b B6）：空 id → action → 查找
  const tk = String(takeoverId || '').trim()
  if (!tk) return fail('BAD_PARAMS', 'takeover_id 不能为空')
  const act = String(action || '').trim().toLowerCase()
  if (act !== 'continue' && act !== 'abort') return fail('BAD_PARAMS', 'action 仅支持 continue/abort')
  const pending = takeovers.get(tk)
  if (!pending) return fail('TAKEOVER_NOT_FOUND', '接管会话不存在或已被清理', '请重新发起搜索')
  if (action === 'abort') {
    await closeOne(pending.sessionId); takeovers.delete(takeoverId)
    return fail('CAPTCHA_ABORTED', '用户放弃了本次人工验证')
  }
  if (action !== 'continue') return fail('BAD_PARAMS', 'action 仅支持 continue/abort')
  try {
    const entry = current(pending.sessionId)
    await entry.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
    const body = await entry.page.locator('body').innerText()
    pending.retry++
    if (captchaText(body)) {
      if (pending.retry >= 3) takeovers.delete(takeoverId)
      return fail('CAPTCHA_REQUIRED', pending.retry >= 3 ? '验证仍未通过，已达到重试上限' : '验证仍未通过，请完成后重试', '', { takeover_id: takeoverId })
    }
    const results = await searchResults(entry.page); takeovers.delete(takeoverId)
    return json({ ok: true, query: pending.query, results, count: results.length, resumed: true,
      session_id: entry.id, untrusted: true, source: provenance(entry.page.url()) })
  } catch (error) { return asError(error) }
  finally { const entry = sessions.get(pending.sessionId); if (entry) entry.busy = false }
}
