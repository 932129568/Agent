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


test('reasoningPresets.js 支持多级中文档位、自定义思考预算与跨厂商协议映射', async () => {
  const { REASONING_TIERS, buildReasoningRequestParams } = await import('../src/services/reasoningPresets.js')
  assert.ok(REASONING_TIERS.some((t) => t.id === 'xhigh' && t.label === '超高'))
  assert.ok(REASONING_TIERS.some((t) => t.id === 'max' && t.label === '极致'))
  const glm = buildReasoningRequestParams({ baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.5', tier: 'high' })
  assert.equal(glm.bodyPatch.thinking.type, 'enabled')
  assert.equal(glm.bodyPatch.reasoning_effort, 'high')
  const ant = buildReasoningRequestParams({ baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-7', tier: 'custom', customBudget: 16384 })
  assert.equal(ant.bodyPatch.thinking.budget_tokens, 16384)
  const off = buildReasoningRequestParams({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', tier: 'off' })
  assert.equal(off.bodyPatch.think, false)
})

test('capabilityRouter.js 识别视频/代码意图、按能力匹配角色并在缺失时诚实预警', async () => {
  const { GROUP_ROSTER_PRESETS, classifyTaskIntent, routeGroupMembers } = await import('../src/services/capabilityRouter.js')
  assert.equal(classifyTaskIntent('帮我做一个 60 秒产品宣传视频分镜脚本').capability, 'video')
  assert.equal(classifyTaskIntent('重构 React 组件和 SQL 接口').capability, 'code')
  const miss = routeGroupMembers('做一个宣传视频分镜', GROUP_ROSTER_PRESETS.engineering.members, 'smart')
  assert.equal(miss.matchedCount, 0)
  assert.ok(miss.missingCapabilityWarning.includes('视频制作'))
  const hit = routeGroupMembers('做一个宣传视频分镜', GROUP_ROSTER_PRESETS.video.members, 'smart')
  assert.equal(hit.matchedCount, 3)
  assert.equal(hit.missingCapabilityWarning, '')
})

test('kinetic.js 校准后的物理撞击曲线：峰值 4.5–6.2px、收敛 <=340ms、过冲 <=2、残余 0px', async () => {
  const { simulateImpactCurve } = await import('../src/platform/kinetic.js')
  const strong = simulateImpactCurve({ v0: 275, omega: 24, zeta: 0.44, maxPx: 6.0 })
  assert.ok(strong.peakAbs >= 4.5 && strong.peakAbs <= 6.0, `peakAbs=${strong.peakAbs}`)
  assert.ok(strong.settleMs >= 160 && strong.settleMs <= 340, `settleMs=${strong.settleMs}`)
  assert.ok(strong.overshoots >= 1 && strong.overshoots <= 2, `overshoots=${strong.overshoots}`)
  assert.equal(strong.residual, 0)
})


test('kinetic.js 缩放通道独立量纲收敛阈值：minScale < 0.996 且残余 0（修复 R3 Suite-D）', async () => {
  const { simulateScaleCurve } = await import('../src/platform/kinetic.js')
  const sc = simulateScaleCurve({ vsc: -0.62, omega: 28, zeta: 0.50, maxSc: 0.016 })
  assert.ok(sc.minScale < 0.996 && sc.minScale > 0.980, `minScale=${sc.minScale}`)
  assert.equal(sc.residual, 0)
})

test('promptCache.js 确定性工具排序、前缀指纹稳定、动态提醒后置与多厂商缓存遥测', async () => {
  const {
    canonicalizeTools,
    computePrefixFingerprint,
    buildDynamicTurnReminder,
    attachReminderToLatestUserTurn,
    applyProviderCacheControl,
    extractCacheUsage,
  } = await import('../src/services/promptCache.js')

  const tA = [
    { type: 'function', function: { name: 'write_file', parameters: { b: 2, a: 1 } } },
    { type: 'function', function: { name: 'read_file', parameters: { x: 1 } } },
  ]
  const tB = [
    { function: { parameters: { x: 1 }, name: 'read_file' }, type: 'function' },
    { function: { parameters: { a: 1, b: 2 }, name: 'write_file' }, type: 'function' },
  ]
  assert.equal(canonicalizeTools(tA)[0].function.name, 'read_file')
  assert.equal(computePrefixFingerprint('STATIC_SYS', tA), computePrefixFingerprint('STATIC_SYS', tB))

  const rem = buildDynamicTurnReminder({ memories: ['偏好 TypeScript'], readonlyMode: true })
  const msgs = [
    { role: 'system', content: 'STATIC_SYS' },
    { role: 'user', content: 'Turn 1' },
    { role: 'assistant', content: 'Ans 1' },
    { role: 'user', content: 'Turn 2' },
  ]
  const attached = attachReminderToLatestUserTurn(msgs, rem)
  assert.equal(attached[0].content, 'STATIC_SYS')
  assert.equal(attached[1].content, 'Turn 1')
  assert.ok(attached[3].content.includes('<system-reminder>') && attached[3].content.includes('偏好 TypeScript'))

  const ant = applyProviderCacheControl({ baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-7', messages: attached, tools: tA, sid: 's1' })
  assert.equal(ant.breakpoints, 3)
  assert.equal(ant.tools[ant.tools.length - 1].cache_control.type, 'ephemeral')
  assert.equal(ant.messages[0].content[0].cache_control.type, 'ephemeral')
  assert.equal(ant.messages[2].content[0].cache_control.type, 'ephemeral')

  const oai = applyProviderCacheControl({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1', messages: attached, tools: tA, sid: 's_abc' })
  assert.equal(oai.extraBody.prompt_cache_key, 'harbor_s_abc')
  assert.equal(oai.extraBody.stream_options.include_usage, true)

  const glm = applyProviderCacheControl({ baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.5', messages: attached, tools: tA, sid: 's1' })
  assert.equal(glm.extraBody.prompt_cache_key, undefined)

  assert.equal(extractCacheUsage({ prompt_tokens: 10000, prompt_tokens_details: { cached_tokens: 8500 } }).hitRate, 85)
  assert.equal(extractCacheUsage({ prompt_tokens: 10000, prompt_cache_hit_tokens: 9000 }).hitRate, 90)
  assert.equal(extractCacheUsage({ input_tokens: 1000, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 }).hitRate, 90)
})


test('headers.js toAsciiJson 将含中文工作区路径编码为纯 ASCII JSON，杜绝 Windows 中文目录报 NON_LATIN1_HEADER', async () => {
  const { toAsciiJson, assertLatin1Headers } = await import('../src/services/headers.js')
  const meta = { v: 2, phase: 'execute', workspace: 'C:\\Users\\测试用户\\桌面\\Harbor项目', prefixHash: 'a1b2c3d4' }
  const encoded = toAsciiJson(meta)
  const hdrs = assertLatin1Headers({ 'X-Harbor-Harness': encoded })
  assert.equal(JSON.parse(hdrs['X-Harbor-Harness']).workspace, meta.workspace)
})

test('platform/markdown.js LRU 缓存命中返回同一对象引用且正确转义 HTML 降级', async () => {
  const { renderSafeMarkdown, clearMarkdownCache } = await import('../src/platform/markdown.js')
  clearMarkdownCache()
  const a = renderSafeMarkdown('# Harbor <script>alert(1)</script>')
  const b = renderSafeMarkdown('# Harbor <script>alert(1)</script>')
  assert.equal(a, b, '相同输入应命中 LRU 缓存返回同一对象')
  assert.ok(!a.__html.includes('<script>'), '脚本标签必须被转义/净化')
})


test('dag.js sanitizeMessagesForApi 严格回放 _wireContent 与 _wireTrail，保证多轮 Append-Only 前缀缓存 90%+ 命中', async () => {
  const { sanitizeMessagesForApi } = await import('../src/services/dag.js')
  const msgs = [
    { role: 'user', content: '查 README', _wireContent: '查 README\n\n<system-reminder>记忆A</system-reminder>' },
    {
      role: 'assistant',
      content: '已读取完成',
      _wireTrail: [
        { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] },
        { role: 'tool', tool_call_id: 'tc1', content: '{"ok":true,"content":"hello"}' },
      ],
    },
    { role: 'user', content: '继续总结' },
  ]
  const wire = sanitizeMessagesForApi(msgs)
  assert.equal(wire.length, 5)
  assert.ok(wire[0].content.includes('<system-reminder>记忆A</system-reminder>'))
  assert.equal(wire[1].tool_calls[0].function.name, 'read_file')
  assert.equal(wire[2].role, 'tool')
  assert.equal(wire[3].content, '已读取完成')
  assert.equal(wire[4].content, '继续总结')
})

test('agentEngine.js buildGuardDetail 与后端 commands.js/guard.js 摘要口径一致', async () => {
  const { buildGuardDetail } = await import('../src/services/agentEngine.js')
  assert.deepEqual(buildGuardDetail('run_command', { command: ' dir ', timeout: 30 }), { cmd: 'dir' })
  assert.deepEqual(buildGuardDetail('run_powershell', { cmd: 'Get-ChildItem', timeout: 60 }), { cmd: 'Get-ChildItem' })
  assert.deepEqual(buildGuardDetail('delete_path', { path: 'a/b.txt', recycle: true }), { path: 'a/b.txt' })
})


test('industryExperts.js 内置 12 个跨行业前沿专家包与热门 Skill，支持按行业与关键词检索', async () => {
  const { CURATED_INDUSTRY_PACKS, EXPERT_CATEGORIES, filterCuratedPacks } = await import('../src/services/industryExperts.js')
  assert.equal(CURATED_INDUSTRY_PACKS.length, 12)
  assert.ok(EXPERT_CATEGORIES.length >= 7)
  assert.ok(CURATED_INDUSTRY_PACKS.every((p) => p.name && p.description && p.prompt && p.skills.length >= 3 && p.sourceRepo))
  const videoHits = filterCuratedPacks({ category: 'video' })
  assert.ok(videoHits.length >= 1 && videoHits[0].id === 'video-director-remotion')
  const officeHits = filterCuratedPacks({ query: 'PPT' })
  assert.ok(officeHits.some((p) => p.id === 'office-doc-studio'))
})

test('kinetic.js computeTargetDelta 按目标按钮坐标计算真实撞击飞行矢量', async () => {
  const { computeTargetDelta } = await import('../src/platform/kinetic.js')
  const fakeModal = { getBoundingClientRect: () => ({ left: 200, top: 100, width: 800, height: 600 }) }
  const leftRailBtn = { cx: 60, cy: 760 }
  const delta = computeTargetDelta(fakeModal, leftRailBtn, 'left')
  assert.equal(delta.dx, -540)
  assert.equal(delta.dy, 360)
})


test('promptCache.js extractCacheUsage 修正聚合网关同时返回 prompt_tokens 与 cache_read_input_tokens 导致 49% 误算', async () => {
  const { extractCacheUsage } = await import('../src/services/promptCache.js')
  // 聚合网关（同时给 prompt_tokens 与 cache_read_input_tokens）：分母不得重复相加！
  const agg = extractCacheUsage({ prompt_tokens: 10000, cache_read_input_tokens: 9500 })
  assert.equal(agg.promptTokens, 10000)
  assert.equal(agg.hitRate, 95)
  // DeepSeek hit + miss 口径
  const ds = extractCacheUsage({ prompt_tokens: 10000, prompt_cache_hit_tokens: 9400, prompt_cache_miss_tokens: 600 })
  assert.equal(ds.hitRate, 94)
  // 原生 Anthropic（无 prompt_tokens，仅 input_tokens + cache_read + cache_creation）
  const ant = extractCacheUsage({ input_tokens: 500, cache_read_input_tokens: 9500, cache_creation_input_tokens: 0 })
  assert.equal(ant.promptTokens, 10000)
  assert.equal(ant.hitRate, 95)
})


test('capabilityRouter.js 智能多意图路由支持复合需求与自定义角色（如 ui设计 + 审查员）全量协同调度', async () => {
  const { GROUP_ROSTER_PRESETS, inferMemberCapabilities, routeGroupMembers } = await import('../src/services/capabilityRouter.js')
  const uiCaps = inferMemberCapabilities('ui设计', '负责界面视觉设计与交互规范')
  assert.ok(uiCaps.includes('vision'), `ui设计应自动推断 vision 能力: ${uiCaps}`)

  const roster = [
    ...GROUP_ROSTER_PRESETS.engineering.members,
    { name: 'ui设计', persona: '负责网页界面视觉与样式设计' },
  ]
  const webRouted = routeGroupMembers('做一个好看的个人主页网页，优化 UI 界面', roster, 'smart')
  const names = webRouted.selected.map((m) => m.name)
  assert.ok(names.includes('架构师') && names.includes('实现工程师') && names.includes('代码审查员') && names.includes('ui设计'),
    `复合网页+UI需求应调度全部 4 位相关角色，实得: ${names.join(' -> ')}`)
  assert.equal(webRouted.missingCapabilityWarning, '')

  // 短续跑指令“继续”也应保持全员协同而非只挑 2 人
  const contRouted = routeGroupMembers('继续', roster, 'smart')
  assert.equal(contRouted.selected.length, 4)
})

test('agentEngine.js 全量覆盖 provider.js 全部 30 个内置工具 + 参数别名容错解析', async () => {
  const { SUPPORTED_BUILTIN_TOOLS, parseToolArgs, dispatchSingleTool } = await import('../src/services/agentEngine.js')
  const expectedAll = [
    'read_more',
    'read_file', 'write_file', 'append_file', 'search_replace', 'list_dir',
    'make_dir', 'delete_path', 'move_path', 'copy_path', 'get_file_info',
    'run_command', 'run_powershell', 'run_admin_command',
    'open_app', 'open_url', 'take_screenshot', 'clipboard_read', 'clipboard_write',
    'list_processes', 'kill_process', 'append_memory',
    'browser_search', 'browser_open', 'software_call',
    'browser_navigate', 'browser_extract', 'browser_snapshot',
    'browser_click', 'browser_fill', 'browser_screenshot', 'browser_close',
    'memory_write', 'memory_search', 'inspect_tool_schema',
  ]
  for (const t of expectedAll) {
    assert.ok(SUPPORTED_BUILTIN_TOOLS.includes(t), `缺少内置工具处理器: ${t}`)
  }

  // 二次转义 JSON 参数容错
  const parsed = parseToolArgs('"{\\"file_path\\":\\"demo.html\\",\\"old_string\\":\\"a\\",\\"new_string\\":\\"b\\"}"')
  assert.equal(parsed.file_path, 'demo.html')

  // 验证 open_url / clipboard_read / search_replace 别名真实分发参数与方法名
  const calls = []
  const mockRaw = async (method, args) => { calls.push({ method, args }); return '{"ok":true}' }
  await dispatchSingleTool({ name: 'open_url', args: { url: 'https://example.com' }, callRaw: mockRaw })
  await dispatchSingleTool({ name: 'clipboard_read', args: {}, callRaw: mockRaw })
  await dispatchSingleTool({ name: 'search_replace', args: { file_path: 'index.html', old_string: '<h1>1</h1>', new_string: '<h1>2</h1>' }, callRaw: mockRaw })
  await dispatchSingleTool({ name: 'run_admin_command', args: { command: 'whoami', timeout: 30 }, callRaw: mockRaw })

  assert.equal(calls[0].method, 'open_url')
  assert.equal(calls[0].args[0], 'https://example.com')
  assert.equal(calls[1].method, 'get_clipboard')
  assert.equal(calls[2].method, 'search_replace')
  assert.deepEqual(calls[2].args, ['index.html', '<h1>1</h1>', '<h1>2</h1>', false])
  assert.equal(calls[3].method, 'run_admin_command')
  assert.equal(calls[3].args[0], 'whoami')
  assert.equal(calls[3].args[2], 30)
})


test('capabilityRouter.js 主持人调度构建与动态重排解析（按工作流阶段而非死板角色表顺序）', async () => {
  const { GROUP_ROSTER_PRESETS, buildModeratorPrompt, parseModeratorPlan } = await import('../src/services/capabilityRouter.js')
  const roster = [
    ...GROUP_ROSTER_PRESETS.engineering.members,
    { id: 'm_ui', name: 'ui设计', persona: '负责界面视觉与CSS设计' },
  ]
  const prompt = buildModeratorPrompt('做一个带漂亮玻璃界面的网页', roster)
  assert.ok(prompt.includes('智能接力主持人') && prompt.includes('m_ui'))

  // 模拟 AI 主持人把原本排在 #4 的 ui设计 动态调度到第 2 棒（架构师 -> ui设计 -> 实现工程师 -> 代码审查员）
  const llmOut = JSON.stringify({
    analysis: '先定架构，再出UI视觉规范，最后工程落地与审查',
    plan: [
      { id: 'm_arch', taskBrief: '规划网页目录与组件结构' },
      { id: 'm_ui', taskBrief: '设计玻璃拟态配色与响应式布局' },
      { id: 'm_dev', taskBrief: '编写 index.html 并落盘' },
      { id: 'm_qa', taskBrief: '验收页面细节与兼容性' },
    ],
  })
  const parsed = parseModeratorPlan(llmOut, roster)
  assert.equal(parsed.source, 'moderator-ai')
  assert.deepEqual(parsed.selected.map((m) => m.name), ['架构师', 'ui设计', '实现工程师', '代码审查员'])
  assert.equal(parsed.selected[1].taskBrief, '设计玻璃拟态配色与响应式布局')

  // 异常输出兜底：拓扑排序也应把 ui设计 排在 实现工程师 和 代码审查员 之前
  const fallback = parseModeratorPlan('not valid json', roster)
  assert.equal(fallback.source, 'topology-fallback')
  const names = fallback.selected.map((m) => m.name)
  assert.ok(names.indexOf('ui设计') < names.indexOf('实现工程师'))
  assert.ok(names.indexOf('实现工程师') < names.indexOf('代码审查员'))
})
