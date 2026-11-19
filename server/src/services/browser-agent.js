/**
 * Agent 浏览器闭环内核（内部模块，不注册 js_api）。
 *
 * 设计意图：把「一组浏览器命令」升级为 Agent 软件的
 *   观察(Observation) → 决策 → 动作(Action) → 再观察 闭环。
 *
 * 三个能力：
 *   1. 稳定元素引用 @eN：模型看完观察层即可按 ref 动作，不必自己猜 selector；
 *   2. 统一观察信封：url/title/ready/step/ref 索引，所有原语同一形状；
 *   3. 动作闭环：每次动作返回 before→after 的结构化 diff 与下一步建议。
 *
 * 约束：不新增/删除 js_api 方法、不改参数元数、既有返回字段全部保留，
 *      本模块只向返回值追加纯增量字段。
 */
import crypto from 'node:crypto'

/** 统一错误码 taxonomy（与 AGENTS.md BrowserErrorCode 口径对齐并补全）。 */
export const BrowserErrorCode = Object.freeze({
  BAD_PARAMS: 'BAD_PARAMS',
  NAV_BLOCKED: 'NAV_BLOCKED',
  SSRF_BLOCKED: 'SSRF_BLOCKED',
  TIMEOUT: 'TIMEOUT',
  SESSION_BUSY: 'SESSION_BUSY',
  SESSION_CLOSED: 'SESSION_CLOSED',
  EXTRACT_EMPTY: 'EXTRACT_EMPTY',
  REF_NOT_FOUND: 'REF_NOT_FOUND',
  REF_STALE: 'REF_STALE',
  TARGET_NOT_VISIBLE: 'TARGET_NOT_VISIBLE',
  CONFIRM_REQUIRED: 'CONFIRM_REQUIRED',
  CAPTCHA_REQUIRED: 'CAPTCHA_REQUIRED',
  CAPTCHA_ABORTED: 'CAPTCHA_ABORTED',
  TAKEOVER_NOT_FOUND: 'TAKEOVER_NOT_FOUND',
  INTERNAL: 'INTERNAL',
})

/** 结构化 Agent 错误（保持 {code,message,hint} 形状，供 browser.js asError 识别）。 */
export function agentError(code, message, hint = '') {
  const err = { code: BrowserErrorCode[code] || code, message }
  if (hint) err.hint = hint
  return err
}

export function isAgentError(error) {
  return !!error && typeof error === 'object' &&
    typeof error.code === 'string' && typeof error.message === 'string'
}

/** provenance 与 browser.js 同口径（单一实现，避免两处漂移）。 */
export function provenance(url, channel = 'playwright') {
  return { url: String(url || ''), channel,
    fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') }
}

/** 页面是 UNTRUSTED DATA：任何进入模型上下文的文本必须包裹来源。 */
export function wrapUntrusted(text, url, channel = 'playwright') {
  const source = provenance(url, channel)
  return `[UNTRUSTED DATA — 来源: ${source.url} · 抓取于 ${source.fetched_at} · 通道: ${source.channel}]\n${String(text ?? '')}\n[END UNTRUSTED DATA]`
}

const INTERACTIVE_SELECTOR = [
  'a[href]', 'button', 'input', 'select', 'textarea',
  '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="checkbox"]',
  '[role="combobox"]', '[role="tab"]', '[role="menuitem"]', '[role="searchbox"]',
].join(',')

/**
 * 建立稳定元素引用：给页面可交互元素注入 data-harbor-ref，返回 ref 索引。
 * 只写 data-* 属性，不改布局/行为；绝不读取 input.value（避免回显用户输入）。
 */
export async function buildRefs(page, limit = 200) {
  const rows = await page.evaluate(({ selector, max }) => {
    const nodes = [...document.querySelectorAll(selector)].slice(0, max)
    return nodes.map((el, i) => {
      const ref = '@e' + (i + 1)
      el.setAttribute('data-harbor-ref', ref)
      const role = el.getAttribute('role') || el.tagName.toLowerCase()
      const name = (el.getAttribute('aria-label') || el.getAttribute('title') ||
        el.getAttribute('placeholder') || el.innerText || '').trim().slice(0, 80)
      return { ref, role, name, tag: el.tagName.toLowerCase(),
        selector: `[data-harbor-ref="${ref}"]` }
    })
  }, { selector: INTERACTIVE_SELECTOR, max: limit })
  const map = new Map()
  for (const row of rows) map.set(row.ref, row)
  return { rows, map }
}

/** ref 索引的可读文本，附在语义快照之后，供模型按 @eN 决策。 */
export function refTableText(rows) {
  if (!rows.length) return ''
  const lines = rows.map(r => `${r.ref} ${r.role}${r.name ? ` "${r.name}"` : ''}`)
  return `\n\n[可操作元素索引 · 用 @eN 作为 browser_click 目标]\n${lines.join('\n')}`
}

/**
 * 解析动作目标：优先 @eN 稳定引用，其次 text=，最后 CSS selector / 可见文本回落。
 * 返回 { locator, kind, ref }；ref 不存在或已失效返回 REF_NOT_FOUND / REF_STALE。
 */
export async function resolveTarget(page, target, refs) {
  const value = String(target || '').trim()
  if (!value) throw agentError('BAD_PARAMS', '缺少点击目标')
  if (/^@e\d+$/.test(value)) {
    const row = refs?.get(value)
    if (!row) throw agentError('REF_NOT_FOUND',
      `${value} 不在当前观察层索引中`, '先调用 browser_snapshot 获取最新 @eN 索引')
    const locator = page.locator(row.selector).first()
    if (await locator.count() === 0) throw agentError('REF_STALE',
      `${value} 对应的元素已不在文档中`, '页面可能已导航，请重新 browser_snapshot')
    return { locator, kind: 'ref', ref: value }
  }
  if (value.startsWith('text=')) {
    return { locator: page.getByText(value.slice(5), { exact: false }).first(),
      kind: 'text' }
  }
  const locator = page.locator(value).first()
  if (await locator.count() === 0) {
    return { locator: page.getByText(value, { exact: false }).first(), kind: 'text' }
  }
  return { locator, kind: 'selector' }
}

/** 紧凑页面状态（不取完整 ARIA 树，动作前后各取一次，开销可控）。 */
export async function compactState(page) {
  let ready_state = 'unknown'
  let element_count = 0
  try {
    const probe = await page.evaluate(() => ({
      ready: document.readyState,
      count: document.querySelectorAll('a[href],button,input,select,textarea,[role]').length,
    }))
    ready_state = probe.ready
    element_count = probe.count
  } catch { /* 页面导航瞬间可能短暂不可用 */ }
  let title = ''
  try { title = await page.title() } catch { /* 同上 */ }
  return { url: page.url(), title, ready_state, element_count }
}

/** 计算 before→after 的结构化变化，供模型判断动作是否生效。 */
export function stateDiff(before, after) {
  return {
    url_changed: before.url !== after.url,
    title_changed: before.title !== after.title,
    elements_delta: after.element_count - before.element_count,
    ready_state: after.ready_state,
  }
}

/**
 * 统一观察信封。所有原语共享同一形状，模型无需按工具分别记忆返回结构。
 * includeRefs=true 时附加完整 ref 索引（snapshot / navigate 使用）。
 */
export async function observe(entry, { includeRefs = false, limit = 200 } = {}) {
  const state = await compactState(entry.page)
  const base = {
    step: entry.step || 0,
    session_id: entry.id,
    ...state,
    untrusted: true,
    source: provenance(state.url),
  }
  if (!includeRefs) return base
  const refs = await buildRefs(entry.page, limit)
  entry.refs = refs.map
  return { ...base, element_refs: refs.rows, ref_count: refs.rows.length }
}

/** 记录一条动作轨迹（有界，避免长会话内存增长）。 */
export function recordStep(entry, action, detail = {}) {
  entry.step = (entry.step || 0) + 1
  if (!entry.history) entry.history = []
  entry.history.push({ step: entry.step, action, at: Date.now(), ...detail })
  if (entry.history.length > 20) entry.history.shift()
  return entry.step
}

/** 给动作结果附加「下一步」建议，形成闭环提示。 */
export function nextHint(action) {
  return {
    next: 'browser_snapshot',
    reason: `${action} 已执行；用最新观察层确认状态变化并获取新 @eN 索引`,
  }
}

/** 生成一次动作的唯一标识，便于日志与轨迹对齐。 */
export function actionId() {
  return 'act_' + crypto.randomBytes(5).toString('hex')
}
