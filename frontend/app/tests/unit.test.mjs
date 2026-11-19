/**
 * L1 单元测试（规范 §8.1）：纯函数、状态 slice、服务归一化。
 * 零 DOM、零网络、零 React 运行时，确定性可复跑。
 * 运行：node --test frontend/app/tests/unit.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../src/state/createStore.js'
import { initialSlices, emptySlices } from '../src/state/slices.js'
import { selectCurrentSession, selectTakeoverCandidates, selectCurrentPick } from '../src/state/selectors.js'
import { sessionActions } from '../src/state/actions/sessionActions.js'
import { uiActions } from '../src/state/actions/uiActions.js'
import { runtimeActions } from '../src/state/actions/runtimeActions.js'
import { HarborError, normalizeError, isAbort } from '../src/services/errors.js'
import { createCache, createSingleFlight, withRetry } from '../src/services/cache.js'
import { guardKindOf, createToolExecutor } from '../src/services/tools.js'
import { escapeText, renderMarkdown } from '../src/services/sanitize.js'
import { setLibsForTest, resetLibsCache } from '../src/platform/libs.js'
import { storageKey } from '../src/platform/storage.js'
import { appVersion } from '../src/platform/env.js'
import {
  TOKEN_NAMES, THEMES, SHARED, toCssVars, validateTokens, tokenOf,
} from '../src/ui/DossierTokens.js'
import {
  EXHIBIT_STATES, EXHIBIT_EVENTS, STAMP_LABELS,
  transition, isAnimated, isVerified, needsAttention, summarize, validateTransitions,
} from '../src/state/ExhibitState.js'

test('store：update 产生新快照并通知订阅者', () => {
  const store = createStore(emptySlices())
  let calls = 0
  store.subscribe(() => { calls++ })
  assert.equal(store.update({ uiSlice: p => ({ ...p, panel: 'sessions' }) }), true)
  assert.equal(store.getSnapshot().uiSlice.panel, 'sessions')
  assert.equal(calls, 1)
  assert.equal(store.update({ uiSlice: store.getSnapshot().uiSlice }), false)
  assert.equal(calls, 1)
  assert.equal(typeof store.slice('uiSlice').getSnapshot, 'function')
  assert.throws(() => store.update({ nope: {} }), /未知 slice/)
  assert.equal(initialSlices.uiSlice.panel, 'chat', 'initialSlices 不被测试污染')
})

test('actions：会话/UI/运行时写入均经 update，键控 sid', () => {
  const store = createStore(emptySlices())
  sessionActions.setSessions(store, [{ id: 'S1', title: 'A' }])
  sessionActions.setCurrent(store, 'S1')
  assert.equal(selectCurrentSession(store.getSnapshot()).title, 'A')
  sessionActions.setRunStatus(store, 'S1', 'paused')
  assert.equal(store.getSnapshot().sessionSlice.runStatusBySid.S1, 'paused')
  uiActions.setPick(store, 'S1', { kind: 'experts', id: 'x' })
  assert.equal(selectCurrentPick(store.getSnapshot()).id, 'x')
  runtimeActions.setActiveRuns(store, [
    { sessionId: 'S1', status: 'failed' }, { sessionId: 'S2', status: 'working' },
  ])
  assert.equal(selectTakeoverCandidates(store.getSnapshot()).length, 1)
  runtimeActions.clearTakeover(store, 'S1')
  assert.ok(store.getSnapshot().runtimeSlice.takeoverBySid !== undefined)
})

test('错误模型：HarborError / normalizeError / isAbort', () => {
  const e = new HarborError('E1', 'msg', { hint: 'h', retryable: true })
  assert.equal(normalizeError(e), e)
  assert.equal(normalizeError({ ok: false, error: { code: 'C', message: 'M' } }).code, 'C')
  assert.equal(normalizeError(new Error('x'), 'F').code, 'F')
  assert.equal(normalizeError('boom').message, 'boom')
  assert.equal(isAbort({ name: 'AbortError' }), true)
  assert.equal(isAbort(new HarborError('USER_PAUSED', 'p')), true)
  assert.equal(isAbort(new Error('x')), false)
})

test('cache：TTL / 单飞 / 有界重试（中止不重试）', async () => {
  const cache = createCache({ ttlMs: 50, maxEntries: 2 })
  cache.set('a', 1)
  assert.equal(cache.get('a'), 1)
  cache.set('b', 2); cache.set('c', 3)
  assert.equal(cache.size, 2)
  cache.invalidate()
  assert.equal(cache.get('a'), undefined)

  let produced = 0
  const single = createSingleFlight()
  const producer = () => { produced++; return Promise.resolve('v') }
  const [x, y] = await Promise.all([single('k', producer), single('k', producer)])
  assert.equal(x, 'v'); assert.equal(y, 'v'); assert.equal(produced, 1)

  let attempts = 0
  const value = await withRetry(async () => {
    attempts++
    if (attempts < 2) throw new Error('5xx')
    return 'ok'
  }, { retries: 2, baseDelayMs: 0 })
  assert.equal(value, 'ok'); assert.equal(attempts, 2)

  await assert.rejects(
    () => withRetry(async () => { throw new HarborError('USER_PAUSED', 'stop') },
      { retries: 3, baseDelayMs: 0 }),
    /stop/,
  )
})

test('工具类别与执行器：护栏档位 + 进度回调', async () => {
  assert.equal(guardKindOf('read_file'), 'file')
  assert.equal(guardKindOf('run_command'), 'command')
  assert.equal(guardKindOf('browser_click'), 'browser')
  assert.equal(guardKindOf('mcp__x__y'), 'mcp')
  const phases = []
  const executor = createToolExecutor({ onProgress: p => phases.push(p.phase) })
  await assert.rejects(() => executor.execute('read_file', [], {}), /BRIDGE_UNAVAILABLE|前端桥未就绪/)
  assert.ok(phases.includes('start') && phases.includes('error'))
})

test('净化：转义 + 缺库时宁可空串也不放行未净化 HTML', () => {
  assert.equal(escapeText('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;')
  resetLibsCache()
  assert.throws(() => renderMarkdown('# hi'), /Markdown 引擎未就绪/)
  setLibsForTest({ marked: { parse: () => '<b>x</b>' }, purify: { sanitize: s => s } })
  assert.equal(renderMarkdown('# hi').__html, '<b>x</b>')
  resetLibsCache()
})

test('平台：config.json 零污染 + 版本读取不抛错', () => {
  assert.equal(storageKey('theme'), 'harbor_app_theme')
  assert.throws(() => storageKey('config.json'), /禁止写入/)
  assert.equal(typeof appVersion(), 'string')
})

/* ======================== R71 · 设计令牌单一事实源 ======================== */
test('R71 令牌：两套主题齐备、无纯黑白、强调色唯一且有效', () => {
  const v = validateTokens()
  assert.equal(v.ok, true, v.problems.join(' | '))
  assert.deepEqual(Object.keys(THEMES).sort(), ['dark', 'light'])
  assert.notEqual(THEMES.light['color-accent'], THEMES.dark['color-accent'],
    '暗色强调色须提亮以满足对比度')
  assert.notEqual(THEMES.light['color-bg'], '#FFFFFF')
  assert.notEqual(THEMES.dark['color-bg'], '#000000')
})

test('R71 令牌：TOKEN_NAMES 全部可解析，CSS 变量声明完整', () => {
  assert.ok(TOKEN_NAMES.length >= 40, '令牌清单应覆盖色彩/字阶/间距/动效/可访问性')
  assert.equal(new Set(TOKEN_NAMES).size, TOKEN_NAMES.length, '令牌名不得重复')
  for (const theme of ['light', 'dark']) {
    const css = toCssVars(theme, '[data-theme="' + theme + '"]')
    assert.ok(css.startsWith('[data-theme="' + theme + '"] {'))
    for (const name of TOKEN_NAMES) {
      assert.ok(css.includes('--' + name + ':'), `${theme} 缺令牌 ${name}`)
    }
    assert.ok(!css.includes('undefined'), `${theme} 不得出现未定义值`)
  }
  assert.throws(() => toCssVars('nope'), /未知主题/)
})

test('R71 令牌：结构令牌跨主题一致，展示字非默认无衬线', () => {
  assert.equal(tokenOf('font-display', 'light'), tokenOf('font-display', 'dark'))
  assert.match(SHARED['font-display'], /Georgia|Cambria|Noto Serif SC/)
  assert.doesNotMatch(SHARED['font-display'], /Inter|Roboto|Arial|system-ui/)
  assert.equal(tokenOf('target'), '44px', '可访问性目标下限')
  assert.equal(tokenOf('focus-ring-w'), '2px')
  assert.equal(tokenOf('color-accent', 'light'), '#B8412A')
  assert.equal(tokenOf('color-accent', 'dark'), '#E0674A')
  assert.equal(tokenOf('__missing__'), undefined, '未知令牌返回 undefined 而非抛错')
})

/* ======================== R71 · 证据条目状态机 ======================== */
test('R71 状态机：转移表完整，所有目标状态在枚举内', () => {
  const v = validateTransitions()
  assert.equal(v.ok, true, v.problems.join(' | '))
  assert.equal(Object.keys(EXHIBIT_STATES).length, 6)
  assert.equal(Object.keys(EXHIBIT_EVENTS).length, 7)
  assert.equal(Object.keys(STAMP_LABELS).length, 6, '每个状态都有文字钢印（三重编码）')
})

test('R71 状态机：合法迁移与非法迁移均可判别', () => {
  assert.deepEqual(transition(EXHIBIT_STATES.QUEUED, EXHIBIT_EVENTS.START),
    { ok: true, state: 'run' })
  assert.deepEqual(transition(EXHIBIT_STATES.RUN, EXHIBIT_EVENTS.COMPLETE),
    { ok: true, state: 'ok' })
  assert.deepEqual(transition(EXHIBIT_STATES.ERR, EXHIBIT_EVENTS.RETRY),
    { ok: true, state: 'queued' })
  assert.deepEqual(transition(EXHIBIT_STATES.OK, EXHIBIT_EVENTS.VERIFY),
    { ok: true, state: 'ok' }, '复核自环不改变结论')
  // 非法：跳过态是终态、运行中不能直接跳过、未知状态
  assert.equal(transition(EXHIBIT_STATES.SKIPPED, EXHIBIT_EVENTS.START).ok, false)
  assert.equal(transition(EXHIBIT_STATES.RUN, EXHIBIT_EVENTS.VERIFY).ok, false)
  assert.equal(transition('nope', EXHIBIT_EVENTS.START).ok, false)
  assert.match(transition(EXHIBIT_STATES.RUN, EXHIBIT_EVENTS.VERIFY).reason, /非法迁移/)
})

test('R71 状态机：计量与语义判定不得混淆', () => {
  assert.equal(isAnimated('run'), true)
  assert.equal(isAnimated('ok'), false)
  assert.equal(isVerified('ok'), true)
  assert.equal(isVerified('warn'), false)
  assert.equal(needsAttention('err'), true)
  assert.equal(needsAttention('warn'), true)
  assert.equal(needsAttention('ok'), false)
  const s = summarize([
    { state: 'ok' }, { state: 'ok' }, { state: 'run' },
    { state: 'err' }, { state: 'skipped' },
  ])
  assert.deepEqual(s, { total: 5, verified: 2, running: 1, failed: 1, attention: 1, skipped: 1 })
})
