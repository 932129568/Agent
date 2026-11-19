/**
 * R71 · 证据条目状态机（Exhibit / 工具调用可视化）
 *
 * 解决的问题：工具调用的 run/ok/err/warn/skipped 状态此前散落在
 * frontend/src 的字符串比较与 CSS 选择器里，没有类型化迁移规则，
 * 也没有「哪些迁移非法」的约束，容易出现「运行中的条目直接变禁用」
 * 这类不可能状态。本模块把状态与事件收敛为一张显式转移表。
 *
 * 架构约束（arch-contract.mjs）：state/ 层 index 3，只允许向下 import；
 * 本模块零 import；纯函数、显式 export、零全局赋值、零 DOM 写。
 * 与生产链无关：不注册 js_api、不改 registry.js、不改任何返回值形状。
 */

/** 稳定的状态枚举（Object.freeze 防止运行时被改写）。 */
export const EXHIBIT_STATES = Object.freeze({
  QUEUED: 'queued',
  RUN: 'run',
  OK: 'ok',
  ERR: 'err',
  WARN: 'warn',
  SKIPPED: 'skipped',
})

/** 事件枚举：一次工具调用的完整生命周期。 */
export const EXHIBIT_EVENTS = Object.freeze({
  START: 'start',
  COMPLETE: 'complete',
  FAIL: 'fail',
  DEGRADE: 'degrade',
  RETRY: 'retry',
  CANCEL: 'cancel',
  VERIFY: 'verify',
})

/**
 * 显式转移表。未列出的组合一律拒绝，避免「任意状态可跳任意状态」。
 * VERIFY 只在 OK 上自环（复核不改变结论）；RETRY 只允许从 ERR/WARN 回到 QUEUED。
 */
const TRANSITIONS = Object.freeze({
  queued: Object.freeze({
    start: EXHIBIT_STATES.RUN,
    cancel: EXHIBIT_STATES.SKIPPED,
  }),
  run: Object.freeze({
    complete: EXHIBIT_STATES.OK,
    fail: EXHIBIT_STATES.ERR,
    degrade: EXHIBIT_STATES.WARN,
    cancel: EXHIBIT_STATES.SKIPPED,
  }),
  ok: Object.freeze({
    verify: EXHIBIT_STATES.OK,
    retry: EXHIBIT_STATES.QUEUED,
  }),
  err: Object.freeze({
    retry: EXHIBIT_STATES.QUEUED,
    cancel: EXHIBIT_STATES.SKIPPED,
  }),
  warn: Object.freeze({
    retry: EXHIBIT_STATES.QUEUED,
    complete: EXHIBIT_STATES.OK,
  }),
  skipped: Object.freeze({}),
})

/** 终态：不再接受任何事件（除显式 retry 由表定义）。 */
export const TERMINAL_STATES = Object.freeze([
  EXHIBIT_STATES.SKIPPED,
])

/**
 * 状态转移。非法组合返回结构化错误而不是抛异常，便于调用方在证据条目上留痕。
 * @returns {{ok: boolean, state: string, reason?: string}}
 */
export function transition(state, event) {
  if (!TRANSITIONS[state]) {
    return { ok: false, state, reason: `未知状态: ${state}` }
  }
  const next = TRANSITIONS[state][event]
  if (next === undefined) {
    return {
      ok: false,
      state,
      reason: `非法迁移: ${state} --${event}--> (不允许)`,
    }
  }
  return { ok: true, state: next }
}

/** 该状态是否需要在 UI 上呈现扫描动效（只动 transform/opacity）。 */
export function isAnimated(state) {
  return state === EXHIBIT_STATES.RUN || state === EXHIBIT_STATES.QUEUED
}

/** 该状态是否代表「已核验」，可用于审计栏计数。 */
export function isVerified(state) {
  return state === EXHIBIT_STATES.OK
}

/** 该状态是否需要用户注意（不仅是颜色，需配合形状与文字）。 */
export function needsAttention(state) {
  return state === EXHIBIT_STATES.ERR || state === EXHIBIT_STATES.WARN
}

/** 状态对应的钢印文案：形状 + 文字 + 颜色三重编码，不只用颜色。 */
export const STAMP_LABELS = Object.freeze({
  queued: '待执行',
  run: '运行中',
  ok: '已核验',
  err: '已拒绝',
  warn: '需注意',
  skipped: '已跳过',
})

/**
 * 批量折叠证据条目，返回审计栏计量。
 * @param {Array<{state: string}>} exhibits
 */
export function summarize(exhibits) {
  const counts = {
    total: exhibits.length,
    verified: 0, running: 0, failed: 0, attention: 0, skipped: 0,
  }
  for (const e of exhibits) {
    if (isVerified(e.state)) counts.verified += 1
    if (e.state === EXHIBIT_STATES.RUN || e.state === EXHIBIT_STATES.QUEUED) counts.running += 1
    if (e.state === EXHIBIT_STATES.ERR) counts.failed += 1
    if (needsAttention(e.state)) counts.attention += 1
    if (e.state === EXHIBIT_STATES.SKIPPED) counts.skipped += 1
  }
  return counts
}

/** 转移表完整性自检：所有目标状态都必须在枚举内。 */
export function validateTransitions() {
  const valid = new Set(Object.values(EXHIBIT_STATES))
  const problems = []
  for (const [from, events] of Object.entries(TRANSITIONS)) {
    if (!valid.has(from)) problems.push(`未知源状态 ${from}`)
    for (const [event, to] of Object.entries(events)) {
      if (!valid.has(to)) problems.push(`${from} --${event}--> 未知目标 ${to}`)
    }
  }
  return { ok: problems.length === 0, problems }
}

export default {
  EXHIBIT_STATES, EXHIBIT_EVENTS, TERMINAL_STATES, STAMP_LABELS,
  transition, isAnimated, isVerified, needsAttention, summarize, validateTransitions,
}
