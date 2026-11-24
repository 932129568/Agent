import test from 'node:test'
import assert from 'node:assert/strict'
import { findNonLatin1Char, assertLatin1Value, assertLatin1Headers } from '../src/services/headers.js'
import {
  ensureTree,
  appendMessageToSession,
  forkFromMessage,
  switchSibling,
  siblingMeta,
  rewindWithSnapshot,
  undoRewind,
  sanitizeMessagesForApi,
} from '../src/services/dag.js'
import { invalidateCachesAfterTool, extractAndStripDiff } from '../src/services/agentEngine.js'
import { estTokens, compactSessionHistory, computeCompactThreshold } from '../src/services/compaction.js'
import { pickNpmVerifyScript, resolveVerifyCmd, runSelfCheckAfterWrites } from '../src/services/selfCheck.js'
import { spawnIsolatedSubagent, cancelAllSubagents } from '../src/services/subagent.js'
import { createCostDefense, isResumableError, detectTakeoverRequired } from '../src/services/budgetAndResume.js'
import { validateUiSpec, extractUiSpecsFromMarkdown } from '../src/services/generative.js'
import { ExpertMailbox } from '../src/services/expertTeam.js'
import { redactForCloud, normalizeCollaborationConfig } from '../src/services/collaboration.js'

test('headers.js 精准拦截非 ASCII API Key 与请求头', () => {
  assert.equal(findNonLatin1Char('sk-abc123_XYZ'), null)
  assert.equal(findNonLatin1Char('sk-中123').index, 3)
  assert.throws(() => assertLatin1Value('API Key', 'sk-中123'), /第 4 个字符/)
  assert.deepEqual(assertLatin1Headers({ Authorization: 'Bearer sk-ok' }), { Authorization: 'Bearer sk-ok' })
})

test('dag.js 非破坏式分叉、分支切换与回退撤销往返', () => {
  let s = ensureTree({ id: 's1', messages: [] })
  s = appendMessageToSession(s, { role: 'user', content: 'Q1' })
  s = appendMessageToSession(s, { role: 'assistant', content: 'A1' })
  s = forkFromMessage(s, 0, { role: 'user', content: 'Q1-b2' })
  assert.deepEqual(siblingMeta(s, s.messages[0]._nodeId), { index: 2, total: 2 })
  s = switchSibling(s, s.messages[0]._nodeId, -1)
  assert.equal(s.messages.map((m) => m.content).join(','), 'Q1,A1')
  const rw = rewindWithSnapshot(s, 1)
  assert.equal(undoRewind(rw).messages.length, 2)
  assert.equal(sanitizeMessagesForApi([{ role: 'user', content: 'x', _nodeId: 'n1' }, { role: 'system', content: 'tmp', __resumeDirective: true }]).length, 1)
})

test('agentEngine.js 写后反斜杠归一失效缓存 + 剥离 parsed.diff', () => {
  const reads = new Set(['src\\a.js@0', 'src/b.js@0'])
  const dirs = new Set(['.'])
  invalidateCachesAfterTool(reads, dirs, 'write_file', { path: 'src/a.js' }, true)
  assert.equal(reads.has('src\\a.js@0'), false)
  assert.equal(dirs.size, 0)
  const { cleanJson, diff } = extractAndStripDiff('write_file', { path: 'src/a.js' }, JSON.stringify({ ok: true, diff: { before: 'a', after: 'b' } }))
  assert.equal(diff.after, 'b')
  assert.equal(cleanJson.includes('"diff"'), false)
})

test('compaction.js stride 估算、缓存优先放宽阈值与幂等锚点摘要', () => {
  assert.ok(estTokens('中文测试'.repeat(1000)) > estTokens('abcd'.repeat(1000)))
  assert.equal(computeCompactThreshold({ level: 'std', cacheHitRate: 60 }), 135000)
  const msgs = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: i === 1 ? '决定采用方案A，改动涉及 src/app.js' : `消息内容 ${i} ` + 'x'.repeat(200),
  }))
  const r1 = compactSessionHistory({ id: 'c1', messages: msgs }, { force: true, keepTail: 4 })
  assert.equal(r1.compacted, true)
  assert.equal(r1.session.messages.filter((m) => m.__anchorDigest).length, 1)
  assert.ok(r1.session.messages[0].content.includes('方案A'))
  const r2 = compactSessionHistory(r1.session, { force: true, keepTail: 4 })
  assert.equal(r2.session.messages.filter((m) => m.__anchorDigest).length, 1)
})

test('selfCheck.js 三级 verifyCmd 解析与失败回灌消息', async () => {
  assert.equal(pickNpmVerifyScript(JSON.stringify({ scripts: { build: 'x', test: 'y' } })).cmd, 'npm run test')
  const resolved = await resolveVerifyCmd({ readFile: async (p) => (p === '.harbor/verify' ? '# 注释\nnpm run lint\n' : null) })
  assert.equal(resolved.cmd, 'npm run lint')
  const sc = await runSelfCheckAfterWrites({
    session: { __verifyCmd: 'node -c a.js' },
    runCommand: async () => JSON.stringify({ ok: false, exit_code: 1, stderr: 'SyntaxError' }),
  })
  assert.equal(sc.ran, true)
  assert.equal(sc.ok, false)
  assert.ok(sc.feedbackMessage.includes('SyntaxError'))
})

test('subagent.js 隔离上下文 + 毫秒级级联中止', async () => {
  const h1 = spawnIsolatedSubagent({ parentSid: 'p1', task: '探索 A', runner: async () => '结论A' + 'x'.repeat(300) })
  const r1 = await h1.promise
  assert.equal(r1.ok, true)
  assert.ok(r1.summary.length <= 240)
  spawnIsolatedSubagent({ parentSid: 'p2', task: '挂起1', runner: () => new Promise(() => {}) })
  spawnIsolatedSubagent({ parentSid: 'p2', task: '挂起2', runner: () => new Promise(() => {}) })
  const c = cancelAllSubagents('p2')
  assert.equal(c.count, 2)
  assert.ok(c.ms <= 100)
})

test('budgetAndResume.js 预算硬停、循环熔断、可恢复错误与验证码接管', () => {
  const d = createCostDefense({ sessionBudgetRmb: 1.0, pricePer1kTokens: 0.002 })
  assert.equal(d.checkBudget(100000), null)
  assert.equal(d.checkBudget(600000).stop, true)
  assert.equal(d.registerToolSignature('a').loop, false)
  assert.equal(d.registerToolSignature('a').loop, false)
  assert.equal(d.registerToolSignature('a').loop, true)
  assert.equal(isResumableError('HTTP 502 Bad Gateway'), true)
  assert.equal(isResumableError('HTTP 401: Unauthorized'), false)
  assert.equal(detectTakeoverRequired({ error: { code: 'CAPTCHA_REQUIRED', takeover_id: 'tk1' } }).takeoverId, 'tk1')
})

test('generative.js 提取并安全校验 UiSpec v1（未知组件自动降级 EmptyState）', () => {
  const specJson = JSON.stringify({
    schemaVersion: 1,
    specId: 'sp1',
    layout: 'card-grid',
    blocks: [
      { blockId: 'b1', component: 'StatTile', props: { label: 'OK', value: 1 } },
      { blockId: 'b2', component: 'EvilScript', props: {} },
    ],
  })
  const v = validateUiSpec(specJson)
  assert.equal(v.ok, true)
  assert.equal(v.spec.blocks[1].component, 'EmptyState')
  const ex = extractUiSpecsFromMarkdown(`正文\n\`\`\`ui-spec\n${specJson}\n\`\`\``)
  assert.equal(ex.specs.length, 1)
  assert.equal(ex.cleanMarkdown, '正文')
})

test('expertTeam.js 信箱投递消费 + collaboration.js 隐私脱敏与预算归一', () => {
  const mb = new ExpertMailbox()
  mb.deliver({ runId: 'r1', from: 'A', to: 'Lead', subject: 's', body: 'b' })
  assert.equal(mb.unconsumed().length, 1)
  assert.equal(mb.consumeFor('Lead').length, 1)
  assert.equal(mb.unconsumed().length, 0)

  const redacted = redactForCloud('我的 key 是 sk-1234567890abcdefg', 'task_summary_only')
  assert.ok(!redacted.includes('sk-1234567890abcdefg'))
  assert.ok(redacted.includes('[REDACTED_SECRET]'))
  assert.equal(normalizeCollaborationConfig({ cloud_token_budget: 999999 }).cloud_token_budget, 30000)
})


test('local-proxy 契约对齐：modelTransport 发送 /chat/completions 与干净 base_url', async () => {
  const { resolveStreamEndpoint } = await import('../src/services/modelTransport.js')
  const direct = await resolveStreamEndpoint('https://open.bigmodel.cn/api/paas/v4/chat/completions')
  assert.equal(direct.targetBase, 'https://open.bigmodel.cn/api/paas/v4')
  assert.equal(direct.url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions')
})
