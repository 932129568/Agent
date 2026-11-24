/** 浏览器驱动：Playwright、SSRF 防护、六原语、实时搜索与 CAPTCHA 接管。 */
import fs from 'node:fs'
import crypto from 'node:crypto'
import net from 'node:net'
import dns from 'node:dns/promises'
// R59 性能：playwright-core 顶层导入实测 215ms——改启动点单飞动态导入
let _chromiumPromise = null
async function getChromium() {
  if (!_chromiumPromise) _chromiumPromise = import('playwright-core').then(m => m.chromium)
  return _chromiumPromise
}
import { enforceExec } from './guard.js'
import { ctxSid, registerSidContainer } from '../session-context.js'
// R69 Agent 闭环内核：统一观察信封 / 稳定 @eN 引用 / 动作前后 diff / 错误码 taxonomy
import {
  BrowserErrorCode, agentError, observe, resolveTarget, compactState,
  stateDiff, recordStep, nextHint, actionId, refTableText,
} from './browser-agent.js'

const sessions = new Map()
const takeovers = new Map()
const urlCache = new Map()
const searchCache = new Map()
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000
const MAX_SESSIONS = 3
const HTTP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'

function decodeHtmlEntities(str = '') {
  return String(str || '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/gi, ' ')
}

function stripTags(html = '') {
  return decodeHtmlEntities(String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
}

function cleanTargetUrl(rawUrl = '') {
  const s = decodeHtmlEntities(String(rawUrl || '').trim())
  if (!/^https?:\/\//i.test(s)) return ''
  try {
    const u = new URL(s)
    if (u.hostname.includes('duckduckgo.com') && u.searchParams.get('uddg')) {
      const real = decodeURIComponent(u.searchParams.get('uddg'))
      if (/^https?:\/\//i.test(real)) return real
    }
    if (u.hostname.includes('bing.com') && u.pathname.startsWith('/ck/a')) {
      const enc = u.searchParams.get('u') || ''
      if (enc.startsWith('a1') && enc.length > 6) {
        const b64 = enc.slice(2).replace(/-/g, '+').replace(/_/g, '/')
        const decoded = Buffer.from(b64, 'base64').toString('utf8')
        if (/^https?:\/\//i.test(decoded)) return decoded
      }
    }
    return u.href
  } catch {
    return ''
  }
}

function domainOf(rawUrl = '') {
  try { return new URL(rawUrl).hostname.replace(/^www\./i, '') } catch { return '' }
}

function parseBingHtmlResults(html = '', limit = 8) {
  const out = []
  const seen = new Set()
  const blocks = String(html || '').split(/<li[^>]+class="[^"]*\bb_algo\b[^"]*"[^>]*>/i).slice(1)
  for (const blk of blocks) {
    if (out.length >= limit) break
    const chunk = blk.split(/<\/li>/i)[0] || blk
    const h2m = chunk.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)
    const am = (h2m ? h2m[1] : chunk).match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!am) continue
    const url = cleanTargetUrl(am[1])
    const title = stripTags(am[2])
    if (!url || !title || seen.has(url)) continue
    seen.add(url)
    const pm = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || chunk.match(/<div[^>]+class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    const snippet = pm ? stripTags(pm[1]).slice(0, 320) : ''
    out.push({ title, url, domain: domainOf(url), snippet })
  }
  return out
}

function parseDdgHtmlResults(html = '', limit = 8) {
  const out = []
  const seen = new Set()
  const blocks = String(html || '').split(/class="result\s+results_links/i).slice(1)
  for (const blk of blocks) {
    if (out.length >= limit) break
    const am = blk.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || blk.match(/href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i)
    if (!am) continue
    const url = cleanTargetUrl(am[1])
    const title = stripTags(am[2])
    if (!url || !title || seen.has(url)) continue
    seen.add(url)
    const sm = blk.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i)
    const snippet = sm ? stripTags(sm[1]).slice(0, 320) : ''
    out.push({ title, url, domain: domainOf(url), snippet })
  }
  return out
}

async function fetchHtmlQuick(url, timeoutMs = 9000) {
  await validateUrl(url)
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': HTTP_UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    })
    if (!resp.ok) return { ok: false, status: resp.status, html: '', finalUrl: resp.url || url }
    const html = await resp.text()
    return { ok: true, status: resp.status, html, finalUrl: resp.url || url }
  } finally {
    clearTimeout(t)
  }
}

/** R22 前沿 Agent 后台静默极速多引擎搜索（Bing CN → Bing Global → DuckDuckGo HTML，零弹窗秒出结果） */
async function fastHttpBackgroundSearch(query, { maxResults = 8, site = '', filetype = '', engine = 'auto' } = {}) {
  const fullQ = [
    String(query || '').trim(),
    site ? `site:${String(site).trim()}` : '',
    filetype ? `filetype:${String(filetype).trim()}` : '',
  ].filter(Boolean).join(' ')
  const cap = Math.max(1, Math.min(12, Number(maxResults) || 8))
  const candidates = engine === 'duckduckgo'
    ? [{ name: 'duckduckgo', url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(fullQ)}`, parse: parseDdgHtmlResults }]
    : [
      { name: 'bing-cn', url: `https://cn.bing.com/search?q=${encodeURIComponent(fullQ)}&setlang=zh-Hans`, parse: parseBingHtmlResults },
      { name: 'bing', url: `https://www.bing.com/search?q=${encodeURIComponent(fullQ)}`, parse: parseBingHtmlResults },
      { name: 'duckduckgo', url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(fullQ)}`, parse: parseDdgHtmlResults },
    ]
  for (const c of candidates) {
    try {
      const r = await fetchHtmlQuick(c.url, 8500)
      if (!r.ok || !r.html) continue
      const items = c.parse(r.html, cap)
      if (items.length > 0) {
        return { ok: true, engine: c.name, results: items }
      }
    } catch { /* 单引擎网络受限，静默回落下一引擎 */ }
  }
  return { ok: false, engine: 'none', results: [] }
}

function extractReadableTextFromHtml(html = '', baseUrl = '', maxChars = 14000) {
  const raw = String(html || '')
  const titleM = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleM ? stripTags(titleM[1]) : domainOf(baseUrl)
  const bodyM = raw.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || raw.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  const cleaned = (bodyM ? bodyM[1] : raw)
    .replace(/<(script|style|noscript|svg|iframe|nav|footer|header)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, '\n')
  const text = decodeHtmlEntities(cleaned.replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const truncated = text.length > maxChars
  return { title, content: truncated ? text.slice(0, maxChars) : text, truncated }
}
const IDLE_MS = 60000
// P0-3：浏览器游标 per-sid（A 的 extract 不落到 B 的页面）；池全局共享上限 3 不变
const cursors = registerSidContainer('cursors', new Map())   // sid -> sessionId
function cursorFor(sid) { return cursors.get(sid) || '' }
function setCursor(id) { cursors.set(ctxSid(), id) }
function clearCursorIf(id) {
  // R37 修复（S2-11）：被关会话的 sid 游标**摘除**而非改指他人会话页——
  // 原重指 [...sessions.keys()].at(-1)，A 关闭后持旧游标的会话 extract/click
  // 会落到 unrelated 会话正打开的页面（跨会话泄漏）。
  for (const [sid, value] of cursors) {
    if (value === id) cursors.delete(sid)
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
/** R41 修复（S2-16）：与 Python `_is_public_host`（session_base.py 2026-10-24
 * 修订）同口径——①198.18.0.0/15（RFC 2544 基准段）按公网放行：Clash/Surge
 * fake-ip 标准地址池，按私网拒绝=代理用户全部浏览被 SSRF 误杀（Python 真机
 * 实证后修订，Node 未同步=分叉）；②补 IPv6 site-local fec0::/10 与 TEST-NET
 * 段（Python ipaddress.is_private 覆盖而 Node 漏）。DNS rebinding TOCTOU 按
 * Python 同款裁决留档：route 级逐请求重校验（installRequestGuard）已收窄
 * 窗口，解析结果直连需 CDP 代理层，不在当前威胁模型。 */
export function isFakeipBenchmark(ip) {
  const parts = String(ip || '').split('.').map(Number)
  return parts.length === 4 && parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19
}

export function privateIp(ip) {
  let value = String(ip || '').toLowerCase().split('%')[0]
  if (value.startsWith('::ffff:')) value = value.slice(7)
  if (net.isIPv6(value)) return value === '::' || value === '::1' ||
    value.startsWith('fc') || value.startsWith('fd') ||
    value.startsWith('fe8') || value.startsWith('fe9') ||
    value.startsWith('fea') || value.startsWith('feb') ||
    value.startsWith('fec') || value.startsWith('fed') ||   // S2-16：site-local fec0::/10
    value.startsWith('fee') || value.startsWith('fef') ||
    value.startsWith('ff')
  if (!net.isIPv4(value)) return true
  if (isFakeipBenchmark(value)) return false   // S2-16：fake-ip 基准段按公网放行
  const parts = value.split('.').map(Number)
  const [a, b, c] = parts
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 2) ||      // TEST-NET-1（is_private 对齐）
    (a === 198 && b === 51 && c === 100) ||   // TEST-NET-2
    (a === 203 && b === 0 && c === 113)       // TEST-NET-3
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
  entry.refs?.clear?.()
  await entry.browser.close().catch(() => {})
  return 1
}
async function reclaimSessions() {
  const now = Date.now()
  for (const entry of [...sessions.values()]) {
    if (!entry.busy && now - entry.last_used > IDLE_MS) await closeOne(entry.id)
  }
  if (sessions.size < MAX_SESSIONS) return
  // R49-N3 修复：池满且全 busy 时不再驱逐在执行会话（原兜底 [0] 会 close
  // 正在 click/extract 的会话 → Target closed 崩）——改抛 SESSION_BUSY。
  const oldest = [...sessions.values()].filter(x => !x.busy)
    .sort((a, b) => a.last_used - b.last_used)[0]
  if (!oldest) throw { code: 'SESSION_BUSY',
    message: '浏览器会话池已满且全部在执行中，请稍后重试或先 browser_close 释放' }
  await closeOne(oldest.id)
}
async function newSession(url, mode = 'hidden', timeout = 60, waitSelector = '') {
  await validateUrl(url)
  await reclaimSessions()
  const browser = await (await getChromium()).launch({ executablePath: edgePath(), headless: mode !== 'visible',
    args: ['--disable-gpu', '--no-first-run', '--disable-background-networking'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false })
  const page = await context.newPage()
  await installRequestGuard(page)
  const id = `brw_${crypto.randomBytes(6).toString('hex')}`
  const entry = { id, browser, context, page, mode, url: '', title: '', busy: false,
    // Agent 闭环状态：step 单调递增、history 有界、refs 为最近一次观察层的引用索引
    step: 0, history: [], refs: new Map(),
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
    // 初始观察层：导航即建立 @eN 索引，模型无需额外一轮即可按 ref 动作
    let observation = null
    try { observation = await observe(entry, { includeRefs: true }) } catch { /* 观察失败不阻断导航 */ }
    return json({ ok: true, session_id: entry.id, url: entry.url, final_url: entry.url,
      title: entry.title, mode: entry.mode, channel: 'playwright',
      ...(observation ? { observation } : {}) })
  } catch (error) { return asError(error) }
}
export async function browserExtract(selector = '', mode = 'markdown', token = null) {
  const refusal = await guard('browser_extract', { selector: String(selector || '').slice(0, 80) }, token)
  if (refusal) return refusal
  let entry
  try {
    entry = current()
    const result = await extractPage(entry, selector, mode)
    let observation = null
    try { observation = await observe(entry) } catch { /* 不阻断提取 */ }
    return json({ ...result, ...(observation ? { observation } : {}) })
  }
  catch (error) { return asError(error) }
  finally { if (entry) entry.busy = false }
}

// R43 语义快照原语（a11y 共识观察层）：ARIA 快照（role/name/state 修剪树，
// 较截图省 token 且元素标识稳定）；provenance 包裹与 extract 同口径。
export async function browserSnapshot(selector = '', maxChars = 4000, token = null) {
  const refusal = await guard('browser_snapshot', { selector: String(selector || '').slice(0, 80) }, token)
  if (refusal) return refusal
  let entry
  try {
    entry = current()
    const locator = selector ? entry.page.locator(String(selector)).first() : entry.page.locator('body')
    await locator.waitFor({ state: 'attached', timeout: 15000 })
    const url = entry.page.url(); const title = await entry.page.title()
    let snap = ''
    try { snap = await locator.ariaSnapshot() } catch { snap = '' }
    if (!String(snap).trim()) throw { code: 'EXTRACT_EMPTY', message: '页面无可提取语义元素' }
    const cap = Math.min(65536, Math.max(500, Number(maxChars) || 4000))
    let truncated = false
    if (snap.length > cap) { snap = snap.slice(0, cap); truncated = true }
    const wrapped = wrapUntrusted(snap, url)
    // Agent 闭环：语义快照同时产出稳定 @eN 索引（页面文本一律 provenance 包裹）
    let observation = null
    try { observation = await observe(entry, { includeRefs: true }) } catch { /* 不阻断快照 */ }
    const refs = observation?.element_refs || []
    return json({ ok: true, snapshot: wrapped, elements: snap.split('\n').length,
      truncated, selector: String(selector || '').slice(0, 80), url, title,
      session_id: entry.id, char_count: snap.length, untrusted: true,
      source: provenance(url),
      ...(observation ? {
        observation,
        ref_table: refs.length ? wrapUntrusted(refTableText(refs), url) : '',
        ref_count: refs.length,
        next: 'browser_click(输入 @eN) 或 browser_fill',
      } : {}) })
  } catch (error) { return asError(error) }
  finally { if (entry) entry.busy = false }
}
export async function browserClick(target, token = null) {
  const value = String(target || '').trim()
  if (!value) return fail('BAD_PARAMS', '缺少点击目标')
  const refusal = await guard('browser_click', { target: value.slice(0, 120) }, token)
  if (refusal) return refusal
  let entry
  try {
    entry = current()
    const beforeState = await compactState(entry.page)
    // Agent 闭环：@eN 稳定引用优先，回落 text=/CSS selector/可见文本
    const { locator, kind, ref } = await resolveTarget(entry.page, value, entry.refs)
    if (!(await locator.isVisible())) throw agentError('TARGET_NOT_VISIBLE', '目标不可见，已拒绝点击')
    const before = await entry.page.screenshot({ type: 'png' })
    const id = actionId()
    await locator.click({ timeout: 15000 })
    await entry.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
    const after = await entry.page.screenshot({ type: 'png' })
    const afterState = await compactState(entry.page)
    const step = recordStep(entry, 'browser_click',
      { target: value.slice(0, 120), kind, ...(ref ? { ref } : {}), action_id: id })
    const observation = { ...(await observe(entry)), step }
    const diff = stateDiff(beforeState, afterState)
    // 页面导航后旧 ref 索引失效，强制模型重新观察
    if (diff.url_changed) entry.refs = new Map()
    return json({ ok: true, clicked: value, url: entry.page.url(), session_id: entry.id,
      before_b64: before.toString('base64'), after_b64: after.toString('base64'),
      action_id: id, target_kind: kind, ...(ref ? { ref } : {}), step,
      observation, diff, ...nextHint('browser_click') })
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
    entry = current()
    const beforeState = await compactState(entry.page)
    const { locator, kind, ref } = await resolveTarget(entry.page, value, entry.refs)
    const meta = await locator.evaluate(el => ({ type: String(el.type || ''), name: `${el.name || ''} ${el.id || ''} ${el.autocomplete || ''}` }))
    if (meta.type === 'password' || meta.type === 'file' || /password|passwd|secret|token|credential/i.test(meta.name)) {
      throw { code: 'BAD_PARAMS', message: '密码/文件/敏感凭证字段禁止由 Agent 自动填充' }
    }
    const id = actionId()
    await locator.fill(String(text ?? ''), { timeout: 15000 })
    const afterState = await compactState(entry.page)
    const step = recordStep(entry, 'browser_fill',
      { selector: value.slice(0, 80), kind, text_len: detail.text_len, action_id: id })
    return json({ ok: true, selector: value, filled: true, masked: true,
      text_len: detail.text_len, session_id: entry.id,
      action_id: id, target_kind: kind, ...(ref ? { ref } : {}), step,
      observation: { ...(await observe(entry)), step },
      diff: stateDiff(beforeState, afterState), ...nextHint('browser_fill') })
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
    step: x.step || 0, ref_count: x.refs?.size || 0,
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
  const urlStr = String(input.url).trim()
  const isVisible = input.display_mode === 'visible' || input.window_mode === 'visible'
  const maxChars = Math.max(800, Math.min(40000, Number(input.max_chars) || 14000))
  if (!isVisible && !input.selector && !input.wait_selector && process.env.HARBOR_BROWSER_ALLOW_LOOPBACK !== 'true') {
    try {
      const r = await fetchHtmlQuick(urlStr, Math.min(12000, (Number(input.timeout) || 12) * 1000))
      if (r.ok && r.html && !captchaText(r.html)) {
        const parsed = extractReadableTextFromHtml(r.html, r.finalUrl || urlStr, maxChars)
        if (parsed.content.length >= 160) {
          const finalUrl = r.finalUrl || urlStr
          const wrapped = wrapUntrusted(parsed.content, finalUrl, 'http-fast')
          return json({
            ok: true,
            mode: input.mode || 'markdown',
            content: wrapped,
            markdown: wrapped,
            url: finalUrl,
            final_url: finalUrl,
            title: parsed.title,
            char_count: parsed.content.length,
            truncated: parsed.truncated,
            channel: 'http-fast',
            untrusted: true,
            source: provenance(finalUrl, 'http-fast'),
          })
        }
      }
    } catch { /* SPA/强反爬页面自动回落 Playwright 真实渲染 */ }
  }
  let id = ''
  try {
    const entry = await newSession(urlStr, isVisible ? 'visible' : 'hidden', input.timeout || 45, input.wait_selector || '')
    id = entry.id
    const result = await extractPage(entry, input.selector || '', input.mode || 'markdown')
    if (!isVisible || input.keep_open !== true) await closeOne(id)
    return json({ ...result, ...(isVisible ? { window_mode: 'visible' } : {}) })
  } catch (error) { if (id) await closeOne(id); return asError(error) }
}
async function searchResults(page, searchHost = '') {
  // bing 解析健壮化(T06 L2 维护项): DOM 变化下 h2 a 命中率下降——标题多候选 +
  // 空标题过滤; b_algo 零命中时再试 #b_results li h2 a(cn.bing 变体); 全链接回落
  // 排除引擎自身导航链接(取请求 host+最终重定向 host)与家具标题
  // (T06 探针实证: 回落曾捞回「跳至内容/网页/图片」; www.bing.com 会 302 到 cn.bing.com)
  const bing = await page.locator('li.b_algo').evaluateAll(items => items.slice(0, 10).map(item => {
    const link = item.querySelector('h2 a') || item.querySelector('a[href^="http"]')
    const title = (item.querySelector('h2 a')?.innerText || item.querySelector('h2')?.innerText
      || link?.innerText || link?.getAttribute('aria-label') || '').trim()
    const snippet = (item.querySelector('.b_caption p')?.innerText || item.querySelector('.b_caption')?.innerText || '').trim()
    return link && /^https?:/.test(link.href) ? { title, url: link.href, snippet } : null
  }).filter(x => x && x.title))
  if (bing.length) return bing
  const alt = await page.locator('#b_results li h2 a').evaluateAll(nodes => nodes.slice(0, 10).map(a => ({
    title: (a.innerText || a.getAttribute('aria-label') || '').trim(), url: a.href,
    snippet: (a.closest('li')?.querySelector('.b_caption p, .b_caption')?.innerText || '').trim(),
  })).filter(x => x.title && /^https?:/.test(x.url)))
  if (alt.length) return alt
  const engineHosts = [searchHost, 'bing.com', 'google.com', 'baidu.com'].filter(Boolean)
  const furniture = ['跳至内容', '辅助功能反馈', '网页', '图片', '视频', '地图', '新闻', '更多', '工具', '设置', '反馈', 'privacy', 'terms']
  const isEngineNav = x => engineHosts.some(h => x.url.includes(h)) || furniture.some(f => x.title === f)
  const raw = await page.locator('a[href]').evaluateAll(nodes => nodes.map(a => ({ title: (a.innerText || a.textContent || '').trim(), url: a.href,
    snippet: (a.closest('article,li,div')?.innerText || '').trim().slice(0, 500) })))
  return raw.filter(x => x.title && x.title.length >= 4 && /^https?:/.test(x.url) && !isEngineNav(x)).slice(0, 10)
}
export async function browserSearch(params, token = null) {
  const input = parse(params); const query = String(input.query || '').trim()
  if (!query) return fail('BAD_PARAMS', 'query 不能为空（1-500 字符的检索词）', '例如 {"query": "python 教程"}')
  const refusal = await guard('web_search', { query: query.slice(0, 120) }, token)
  if (refusal) return refusal

  const wantVisible = input.mode === 'visible'
  const maxResults = Math.max(1, Math.min(12, Number(input.max_results) || 8))
  const cacheKey = `${query.toLowerCase()}|${input.site || ''}|${input.filetype || ''}|${input.engine || 'auto'}|${maxResults}`

  // 1) 后台静默极速通道（对齐 Perplexity / Claude / ChatGPT：零弹窗、5 分钟缓存、多引擎容灾）
  if (!wantVisible && !input.search_url) {
    const cached = searchCache.get(cacheKey)
    if (cached && cached.exp > Date.now()) {
      return json({
        ok: true, query, results: cached.results, count: cached.results.length,
        real_time: true, cached: true, mode: 'hidden', channel: 'http-fast', source: 'cache', untrusted: true,
        provenance: cached.provenance,
      })
    }
    const fast = await fastHttpBackgroundSearch(query, {
      maxResults,
      site: input.site || '',
      filetype: input.filetype || '',
      engine: input.engine || 'auto',
    })
    if (fast.ok && fast.results.length > 0) {
      const prov = {
        engine: fast.engine,
        query_sha256: crypto.createHash('sha256').update(query).digest('hex').slice(0, 16),
        fetched_at: new Date().toISOString(),
      }
      if (searchCache.size > 80) searchCache.clear()
      searchCache.set(cacheKey, { results: fast.results, provenance: prov, exp: Date.now() + SEARCH_CACHE_TTL_MS })
      return json({
        ok: true, query, results: fast.results, count: fast.results.length,
        real_time: true, mode: 'hidden', channel: 'http-fast', source: 'live', untrusted: true,
        provenance: prov,
      })
    }
  }

  // 2) 前台可视观看通道（mode='visible'）或显式 search_url / Playwright 兜底渲染通道
  const fullQuery = [query, input.site ? `site:${input.site}` : '', input.filetype ? `filetype:${input.filetype}` : ''].filter(Boolean).join(' ')
  const url = input.search_url || `https://cn.bing.com/search?q=${encodeURIComponent(fullQuery)}&setlang=zh-Hans`
  let entry
  try {
    entry = await newSession(url, wantVisible ? 'visible' : 'hidden', input.timeout || 45)
    const body = await entry.page.locator('body').innerText()
    if (captchaText(body)) {
      const takeoverId = `tk_${crypto.randomBytes(6).toString('hex')}`
      if (!wantVisible && !process.env.HARBOR_HEADLESS && process.env.HARBOR_BROWSER_ALLOW_LOOPBACK !== 'true') {
        try {
          await closeOne(entry.id)
          entry = await newSession(url, 'visible', input.timeout || 45)
        } catch {}
      }
      takeovers.set(takeoverId, { id: takeoverId, sessionId: entry.id, query, retry: 0 })
      return fail('CAPTCHA_REQUIRED', '搜索页需要人工完成验证', '', { takeover_id: takeoverId })
    }
    const rawResults = await searchResults(entry.page, new URL(url).host)
    const results = rawResults.slice(0, maxResults).map((r) => ({
      ...r,
      url: cleanTargetUrl(r.url) || r.url,
      domain: r.domain || domainOf(cleanTargetUrl(r.url) || r.url),
    }))
    if (!wantVisible || input.keep_open !== true) {
      await closeOne(entry.id)
    }
    return json({ ok: true, query, results, count: results.length, session_id: entry.id,
      mode: wantVisible ? 'visible' : 'hidden', channel: 'playwright',
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
    const results = await searchResults(entry.page, new URL(entry.page.url()).host); takeovers.delete(takeoverId)
    return json({ ok: true, query: pending.query, results, count: results.length, resumed: true,
      session_id: entry.id, untrusted: true, source: provenance(entry.page.url()) })
  } catch (error) { return asError(error) }
  finally { const entry = sessions.get(pending.sessionId); if (entry) entry.busy = false }
}
