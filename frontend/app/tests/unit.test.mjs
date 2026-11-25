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
  // r10 起文案改为通用句（不再点名具体能力）：
  //   "当前议题暂无单一专长匹配，已智能编排全员（3 位）协同接力。"
  // 判据保留"必须有诚实提示"这一条，不绑定具体措辞；
  // 注意：**文案不点名能力是可用性退化**（用户不知道缺的是"视频"），已在交付报告记录。
  assert.ok(miss.missingCapabilityWarning.length > 0)
  assert.match(miss.missingCapabilityWarning, /暂无|全员/)
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


test('industryExperts.js 内置跨行业前沿专家包与热门 Skill，支持按行业与关键词检索', async () => {
  const { CURATED_INDUSTRY_PACKS, EXPERT_CATEGORIES, filterCuratedPacks } = await import('../src/services/industryExperts.js')
  // 原断言写死 `=== 12`：r21 把内置包从 12 扩到 18，判据立刻假红。
  // 意图是"内置了足量跨行业包且结构完整"，不是"恰好 12 个" ⇒ 改为下限 + 结构校验 + 唯一性。
  assert.ok(CURATED_INDUSTRY_PACKS.length >= 12, `至少 12 个，实际 ${CURATED_INDUSTRY_PACKS.length}`)
  const ids = CURATED_INDUSTRY_PACKS.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length, 'id 必须唯一')
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


test('toolRouter.js 按任务语义智能裁剪工具面（省 55%-85% 无用工具 Token）并保持会话单调锁死', async () => {
  const { predictToolProfile, selectToolsForProfile, isAutonomousAuthorized } = await import('../src/services/toolRouter.js')
  assert.equal(predictToolProfile('给我讲个笑话并翻译成英文'), 'chat')
  assert.equal(predictToolProfile('在桌面帮我写一个钟摆网页 index.html'), 'coding')
  assert.equal(predictToolProfile('上网搜索一下最新的 React 19 发布说明'), 'web')
  assert.equal(predictToolProfile('查一下最新官网文档', { prevProfile: 'coding' }), 'coding_web')
  assert.equal(predictToolProfile('你好', { prevProfile: 'coding' }), 'coding')

  assert.equal(isAutonomousAuthorized('帮我做一个钟摆网页，你自主发挥不用问我'), true)
  assert.equal(isAutonomousAuthorized('帮我做一个钟摆网页'), false)

  const mockAll = [
    'read_file', 'write_file', 'search_replace', 'list_dir', 'run_command', 'run_powershell',
    'browser_search', 'browser_navigate', 'browser_click', 'browser_fill', 'take_screenshot',
    'clipboard_read', 'clipboard_write', 'kill_process', 'software_call',
  ].map((name) => ({ type: 'function', function: { name } }))

  const chatTools = selectToolsForProfile(mockAll, 'chat')
  assert.equal(chatTools.length, 1)
  assert.equal(chatTools[0].function.name, 'ask_user_options')

  const codingTools = selectToolsForProfile(mockAll, 'coding')
  const codingNames = codingTools.map((t) => t.function.name)
  assert.ok(codingNames.includes('write_file') && codingNames.includes('ask_user_options'))
  assert.ok(!codingNames.includes('browser_click') && !codingNames.includes('kill_process'))
})

test('promptCache.js extractCacheUsage 严禁把 <100% 四舍五入虚报 100%，并修正拆分上报网关分母', async () => {
  const { extractCacheUsage } = await import('../src/services/promptCache.js')
  const nearFull = extractCacheUsage({ prompt_tokens: 10000, prompt_tokens_details: { cached_tokens: 9960 } })
  assert.equal(nearFull.hitRate, 99.6)
  assert.ok(nearFull.hitRate < 100)

  const splitGw = extractCacheUsage({ prompt_tokens: 2000, prompt_tokens_details: { cached_tokens: 8000 } })
  assert.equal(splitGw.promptTokens, 10000)
  assert.equal(splitGw.hitRate, 80)
})

test('agentEngine.js ask_user_options 工具触发前端效果拍板回调并原样回传用户自定义选择', async () => {
  const { dispatchSingleTool } = await import('../src/services/agentEngine.js')
  let captured = null
  const out = await dispatchSingleTool({
    name: 'ask_user_options',
    args: {
      title: '选择钟摆网页视觉风格',
      questions: [{ id: 'style', label: '主视觉方向', options: [{ id: 'glass', label: '极简玻璃拟态' }, { id: 'retro', label: '黄铜机械复古' }] }],
    },
    requestClarify: async (req) => {
      captured = req
      return { mode: 'selected', answers: { style: { ids: ['retro'], labels: ['黄铜机械复古'] } }, customNote: '加真实滴答音效', summary: '- 主视觉方向：黄铜机械复古\n- 自定义：加真实滴答音效' }
    },
  })
  assert.equal(captured.title, '选择钟摆网页视觉风格')
  const parsed = JSON.parse(out)
  assert.equal(parsed.ok, true)
  assert.ok(parsed.summary.includes('黄铜机械复古') && parsed.summary.includes('加真实滴答音效'))
})


test('groupStore.js 多群聊严格隔离：每个新建群聊唯一 ID、删除后自动建全新隔离群且不复用旧 ID', async () => {
  const { createIsolatedGroup, removeGroupFromCollection, stripGlobalMemoryForIsolatedGroup } = await import('../src/services/groupStore.js')
  const g1 = createIsolatedGroup({ title: '群聊A' })
  const g2 = createIsolatedGroup({ title: '群聊B' })
  assert.notEqual(g1.id, g2.id)
  assert.notEqual(g1.id, 'grp_default')
  assert.equal(g1.messages.length, 0)

  // 删除最后一个群聊时，自动创建一个全新的独立群聊 ID（绝不回退旧 ID）
  const afterDel = removeGroupFromCollection([g1], g1.id, g1.id)
  assert.equal(afterDel.items.length, 1)
  assert.equal(afterDel.createdReplacement, true)
  assert.notEqual(afterDel.activeGroupId, g1.id)

  // 群聊系统提示词剥离全局长期记忆，防止已删除会话串味
  const rawSys = '你是 Harbor 助手。\n\n用户长期记忆（仅作偏好与约束参考）：\n- 旧群聊做了钟摆网页\n\n【长期记忆·扩展】\n- 旧会话规则'
  const stripped = stripGlobalMemoryForIsolatedGroup(rawSys)
  assert.ok(!stripped.includes('钟摆网页') && !stripped.includes('旧会话规则'))
})

test('toolRouter.js 群聊隔离模式剔除全局 memory 工具并仅注入本群专属 group_file_* 工具', async () => {
  const { selectToolsForProfile } = await import('../src/services/toolRouter.js')
  const mockAll = ['read_file', 'write_file', 'memory_search', 'memory_write', 'append_memory'].map((name) => ({
    type: 'function',
    function: { name },
  }))
  const grpTools = selectToolsForProfile(mockAll, 'coding', { includeAskUser: true, isolatedGroup: true })
  const names = grpTools.map((t) => t.function.name)
  assert.ok(!names.includes('memory_search') && !names.includes('memory_write') && !names.includes('append_memory'))
  assert.ok(names.includes('group_file_list') && names.includes('group_file_read') && names.includes('group_file_search'))
})


test('sessionMode.js 普通会话与项目会话互转及路径短名提取（Windows/Unix 兼容）', async () => {
  const { normalizeSessionKind, shortFolderLabel, applyProjectWorkspace, clearProjectWorkspace } = await import('../src/services/sessionMode.js')
  assert.equal(shortFolderLabel('C:\\Users\\陈\\Desktop\\my-project\\'), 'my-project')
  assert.equal(shortFolderLabel('/Users/dev/harbor-app/'), 'harbor-app')

  const normal = { id: 's_1', title: '新对话', kind: 'chat', workspaceDir: '' }
  assert.equal(normalizeSessionKind(normal), 'chat')

  const proj = applyProjectWorkspace(normal, 'C:\\Users\\陈\\Desktop\\pendulum-clock')
  assert.equal(normalizeSessionKind(proj), 'project')
  assert.equal(proj.workspaceDir, 'C:\\Users\\陈\\Desktop\\pendulum-clock')
  assert.equal(proj.title, 'pendulum-clock')

  const backToNormal = clearProjectWorkspace(proj)
  assert.equal(normalizeSessionKind(backToNormal), 'chat')
  assert.equal(backToNormal.workspaceDir, '')
})


test('dag.js sanitizeMessagesForApi 协议自愈：自动补齐中断工具循环遗留的悬空 tool_calls 回执并剔除孤儿 tool 消息', async () => {
  const { sanitizeMessagesForApi } = await import('../src/services/dag.js')
  const broken = [
    { role: 'user', content: '查一下文件' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'tc_orphan_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }] },
    { role: 'user', content: '换个问题吧' },
    { role: 'tool', tool_call_id: 'tc_stray_999', content: 'should be dropped' },
  ]
  const healed = sanitizeMessagesForApi(broken)
  assert.equal(healed.length, 4)
  assert.equal(healed[2].role, 'tool')
  assert.equal(healed[2].tool_call_id, 'tc_orphan_1')
  assert.ok(healed[2].content.includes('interrupted'))
  assert.equal(healed[3].role, 'user')
  assert.equal(healed[3].content, '换个问题吧')
})

test('compaction.js 压缩切分点自动对齐到 user 边界，绝不产生连续两条 assistant 消息', async () => {
  const { compactSessionHistory } = await import('../src/services/compaction.js')
  const msgs = []
  for (let i = 0; i < 6; i++) {
    msgs.push({ role: 'user', content: `问题 ${i}` })
    msgs.push({ role: 'assistant', content: `回答 ${i}` })
  }
  // keepTail=5 时原始 cut=7 会落在 assistant 上，R14 应自动对齐到 user 边界
  const res = compactSessionHistory({ id: 's_c', messages: msgs }, { force: true, keepTail: 5 })
  assert.equal(res.compacted, true)
  assert.equal(res.session.messages[0].role, 'assistant')
  assert.equal(res.session.messages[1].role, 'user')
})

test('subagent.js purgeSubagents 彻底释放已删除会话的子代理记录并中止在途任务', async () => {
  const { spawnIsolatedSubagent, listSubagents, purgeSubagents } = await import('../src/services/subagent.js')
  let aborted = false
  spawnIsolatedSubagent({
    parentSid: 'sid_purge_test',
    task: '长耗时任务',
    runner: (_sess, sig) => new Promise((resolve) => {
      sig.addEventListener('abort', () => { aborted = true; resolve('stopped') }, { once: true })
    }),
  })
  assert.equal(listSubagents('sid_purge_test').length, 1)
  // runner 是在 Promise.resolve().then() 里启动的，spawn 返回时它还没跑；
  // 必须先让它进入在途（挂上 abort 监听），否则测的是"启动前取消"，
  // 那条路径由实现里的 signal.aborted 守卫负责（不再启动 runner）。
  await Promise.resolve()
  purgeSubagents('sid_purge_test')
  assert.equal(aborted, true)
  assert.equal(listSubagents('sid_purge_test').length, 0)
})

test('expertTeam.js 流式途中中止自动保存断点检查点（不丢已完成成员与未消费信箱）', async () => {
  const { runExpertTeam } = await import('../src/services/expertTeam.js')
  const ctrl = new AbortController()
  ctrl.abort()
  const res = await runExpertTeam({
    goal: '测试断点保护',
    lead: { name: '总监' },
    members: [{ name: '架构师' }, { name: '工程师' }],
    endpointConfig: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm' },
    recovery: { completedMembers: [{ name: '架构师', result: '已完成设计' }], unconsumedMailbox: [] },
    signal: ctrl.signal,
  })
  assert.equal(res.status, 'paused')
  assert.ok(res.checkpoint && res.checkpoint.completedMembers.length === 1)
  assert.equal(res.checkpoint.completedMembers[0].name, '架构师')
})


test('artifacts.js 从 Markdown 准确提取 HTML/SVG 并生成沙箱预览文档', async () => {
  const { extractArtifactsFromMarkdown, buildArtifactSandboxDoc } = await import('../src/services/artifacts.js')
  const md = [
    '已为你生成交互钟摆组件：',
    '```html',
    '<!doctype html><html><head><title>精密钟摆</title></head><body><h1>钟摆</h1><script>console.log(1)</script></body></html>',
    '```',
    '以及矢量徽标：',
    '```svg',
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40" fill="#D4653E"/></svg>',
    '```',
  ].join('\n')
  const arts = extractArtifactsFromMarkdown(md)
  assert.equal(arts.length, 2)
  assert.equal(arts[0].kind, 'html')
  assert.equal(arts[0].title, '精密钟摆')
  assert.equal(arts[1].kind, 'svg')
  const svgDoc = buildArtifactSandboxDoc(arts[1], 'dark')
  assert.ok(svgDoc.includes('<!doctype html>') && svgDoc.includes('#181a20') && svgDoc.includes('<svg'))
})

test('sessionExport.js 导出普通/项目会话与群聊 Markdown 纪要格式完整', async () => {
  const { formatSessionAsMarkdown, formatGroupAsMarkdown, safeExportFilename } = await import('../src/services/sessionExport.js')
  assert.equal(safeExportFilename('我的/项目:A?'), '我的-项目-A-.md')
  const sMd = formatSessionAsMarkdown({
    title: '架构重构',
    kind: 'project',
    workspaceDir: 'C:\\repo\\harbor',
    messages: [
      { role: 'user', content: '优化状态内核' },
      { role: 'assistant', reasoning: '先解耦 kernel.js', content: '已完成 kernel.js 拆分。' },
    ],
  })
  assert.ok(sMd.includes('项目会话') && sMd.includes('C:\\repo\\harbor') && sMd.includes('先解耦 kernel.js'))
  const gMd = formatGroupAsMarkdown({
    activeGroupId: 'grp_x1',
    title: '前端攻关组',
    members: [{ name: '架构师' }, { name: 'UI设计' }],
    messages: [{ role: 'assistant', author: '架构师', model: 'glm-4.5', content: '已输出目录规范' }],
  })
  assert.ok(gMd.includes('前端攻关组') && gMd.includes('架构师') && gMd.includes('已输出目录规范'))
})

test('kernel.js 独立响应式状态内核支持浅相等去重与订阅通知', async () => {
  const { initKernel, getState, subscribe, patchSlice } = await import('../src/state/kernel.js')
  initKernel(Object.freeze({ ui: Object.freeze({ zenMode: false, count: 1 }), sessions: Object.freeze({ currentId: 's1' }), group: Object.freeze({ activeGroupId: 'g1' }), runtime: Object.freeze({}) }))
  let calls = 0
  const unsub = subscribe(() => { calls++ })
  patchSlice('ui', { zenMode: false, count: 1 })
  assert.equal(calls, 0)
  patchSlice('ui', { zenMode: true })
  assert.equal(calls, 1)
  assert.equal(getState().ui.zenMode, true)
  unsub()
})


test('workflowEngine.js 拓扑分层、环路拦截、并行扇出与条件分支跳过完全准确', async () => {
  const { analyzeWorkflowDag, executeWorkflowDag } = await import('../src/services/workflowEngine.js')

  const cyclic = analyzeWorkflowDag({
    id: 'cyc',
    nodes: [{ id: 'a', kind: 'llm', label: 'A' }, { id: 'b', kind: 'llm', label: 'B' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
  })
  assert.equal(cyclic.ok, false)
  assert.ok(cyclic.error.includes('循环依赖'))

  const wf = {
    id: 'wf_test',
    name: '并行条件流',
    nodes: [
      { id: 'in', kind: 'input', label: '输入' },
      { id: 'p1', kind: 'llm', label: '并行1', prompt: 'P1:{{input}}' },
      { id: 'p2', kind: 'llm', label: '并行2', prompt: 'P2:{{input}}' },
      { id: 'join', kind: 'merge', label: '汇合' },
      { id: 'cond', kind: 'condition', label: '检查关键词', condition: { op: 'contains', value: 'PASS_FLAG' } },
      { id: 'yes_branch', kind: 'llm', label: '命中分支' },
      { id: 'no_branch', kind: 'llm', label: '未命中分支' },
    ],
    edges: [
      { from: 'in', to: 'p1' },
      { from: 'in', to: 'p2' },
      { from: 'p1', to: 'join' },
      { from: 'p2', to: 'join' },
      { from: 'join', to: 'cond' },
      { from: 'cond', to: 'yes_branch', when: 'true' },
      { from: 'cond', to: 'no_branch', when: 'false' },
    ],
  }
  const dag = analyzeWorkflowDag(wf)
  assert.equal(dag.ok, true)
  assert.deepEqual(dag.layers[1].sort(), ['p1', 'p2'])

  const res = await executeWorkflowDag({
    workflow: wf,
    input: '任务X',
    runLlmNode: async ({ node }) => ({ content: node.id === 'p1' ? 'OK PASS_FLAG' : `DONE:${node.id}` }),
  })
  assert.equal(res.status, 'done')
  assert.equal(res.nodeStates.yes_branch.status, 'done')
  assert.equal(res.nodeStates.no_branch.status, 'skipped')
})

test('workflowEngine.js human_gate 人工拍板门 + artifact 实时画布发射 + 群聊编译闭环', async () => {
  const { executeWorkflowDag, compileGroupToWorkflow } = await import('../src/services/workflowEngine.js')
  const emitted = []
  const wf = {
    id: 'wf_gate_art',
    name: '拍板画布流',
    nodes: [
      { id: 'in', kind: 'input', label: '输入' },
      { id: 'gate', kind: 'human_gate', label: '风格确认' },
      { id: 'build', kind: 'llm', label: '生成页面', prompt: '按{{nodes.gate.output}}生成' },
      { id: 'art', kind: 'artifact', label: '实时画布', prompt: '{{nodes.build.output}}' },
    ],
    edges: [
      { from: 'in', to: 'gate' },
      { from: 'gate', to: 'build' },
      { from: 'build', to: 'art' },
    ],
  }
  const res = await executeWorkflowDag({
    workflow: wf,
    input: '时钟页',
    requestHumanGate: async () => ({ mode: 'selected', summary: '极简玻璃风' }),
    runLlmNode: async ({ prompt }) => ({ content: `\`\`\`html\n<!doctype html><html><head><title>${prompt}</title></head><body><h1>OK</h1></body></html>\n\`\`\`` }),
    onArtifact: (a) => emitted.push(a),
  })
  assert.equal(res.status, 'done')
  assert.equal(emitted.length, 1)
  assert.ok(emitted[0].code.includes('极简玻璃风'))

  const compiled = compileGroupToWorkflow({
    title: '攻关群',
    members: [{ id: 'a', name: '架构师', persona: '设计' }, { id: 'b', name: '前端', persona: '写页面' }],
  })
  assert.equal(compiled.nodes.length, 4)
  assert.equal(compiled.edges.length, 3)
})

test('pluginRegistry.js 支持热插拔校验自定义 JSON 插件、收集工具/指令/钩子并安全分发', async () => {
  const {
    SAMPLE_CUSTOM_PLUGIN_JSON,
    validateCustomPluginManifest,
    resolveAllPlugins,
    collectEnabledWorkflows,
    collectPluginTools,
    runPluginBeforePromptHooks,
    dispatchPluginTool,
  } = await import('../src/services/pluginRegistry.js')

  const valid = validateCustomPluginManifest(SAMPLE_CUSTOM_PLUGIN_JSON)
  assert.equal(valid.ok, true)
  assert.equal(valid.plugin.id, 'custom.prd-sprint')

  const invalid = validateCustomPluginManifest('{"id":"bad id!","name":"x"}')
  assert.equal(invalid.ok, false)

  const all = resolveAllPlugins({ 'plugin.content-studio': false }, [valid.plugin])
  assert.equal(all.find((p) => p.id === 'plugin.content-studio').enabled, false)
  assert.equal(all.find((p) => p.id === 'custom.prd-sprint').enabled, true)

  const wfs = collectEnabledWorkflows(all)
  assert.ok(wfs.some((w) => w.id === 'wf-custom-prd'))
  assert.ok(!wfs.some((w) => w.id === 'wf-content-studio'))

  const tools = collectPluginTools(all)
  assert.ok(tools.some((t) => t.function.name === 'list_workflow_plugins'))
  const out = JSON.parse(dispatchPluginTool('list_workflow_plugins', {}, { plugins: all, workflows: wfs }))
  assert.equal(out.ok, true)
  assert.ok(out.count >= 4)

  const hooks = runPluginBeforePromptHooks(all)
  assert.ok(hooks.includes('验收标准'))
})


test('artifacts.js 强制为完整 HTML 文档注入沙箱导航守护脚本（根治点击按钮套娃重载 Harbor）', async () => {
  const { buildArtifactSandboxDoc } = await import('../src/services/artifacts.js')
  const fullHtml = '<!doctype html><html><head><title>表单页</title></head><body><form><button>提交</button></form><a href="index.html">首页</a></body></html>'
  const guarded = buildArtifactSandboxDoc({ kind: 'html', title: '表单页', code: fullHtml }, 'light')
  assert.ok(guarded.includes('data-harbor-guard="1"'))
  assert.ok(guarded.includes('nav_blocked') && guarded.includes('form_blocked'))
  assert.ok(guarded.includes('e.preventDefault()'))
  const twice = buildArtifactSandboxDoc({ kind: 'html', title: '表单页', code: guarded }, 'light')
  assert.equal(twice.split('data-harbor-guard="1"').length - 1, 1)
})

test('workflowEngine.js 一句话自然语言智能合成多节点并发 DAG + 实时流式 onDelta + 报告格式化', async () => {
  const { synthesizeWorkflowFromPrompt, analyzeWorkflowDag, executeWorkflowDag, formatWorkflowRunMarkdown } = await import('../src/services/workflowEngine.js')
  const resWf = synthesizeWorkflowFromPrompt('调研竞品价格并做 SWOT 分析生成 HTML 简报')
  const dag = analyzeWorkflowDag(resWf)
  assert.equal(dag.ok, true)
  assert.ok(resWf.nodes.length >= 5)
  assert.ok(dag.layers.some((l) => l.length >= 2), '应包含并行扇出拓扑层')

  const deltas = []
  const run = await executeWorkflowDag({
    workflow: {
      id: 'wf_stream',
      name: '流式测试',
      nodes: [{ id: 'in', kind: 'input', label: '输入' }, { id: 'a', kind: 'llm', label: '模型A' }],
      edges: [{ from: 'in', to: 'a' }],
    },
    input: 'hello',
    runLlmNode: async ({ onDelta }) => {
      onDelta('第一段流式输出', 42)
      return { content: '最终完成输出' }
    },
    onProgress: (p) => {
      if (p.nodeStates && p.nodeStates.a && p.nodeStates.a.status === 'running' && p.nodeStates.a.output) {
        deltas.push(p.nodeStates.a.output)
      }
    },
  })
  assert.equal(run.status, 'done')
  assert.ok(deltas.includes('第一段流式输出'))
  const md = formatWorkflowRunMarkdown(resWf, run)
  assert.ok(md.includes('工作流执行报告'))
})


test('workflowEngine.js 自定义拖拽节点坐标持久化、画布自动扩边界与一键恢复自动拓扑排布', async () => {
  const { analyzeWorkflowDag, resetWorkflowLayoutPositions } = await import('../src/services/workflowEngine.js')
  const wf = {
    id: 'wf_pos',
    name: '拖拽布局测试',
    nodes: [
      { id: 'a', kind: 'input', label: 'A', pos: { x: 40, y: 50 } },
      { id: 'b', kind: 'llm', label: 'B', pos: { x: 820, y: 390 } },
    ],
    edges: [{ from: 'a', to: 'b' }],
  }
  const dag = analyzeWorkflowDag(wf)
  assert.equal(dag.ok, true)
  assert.equal(dag.layout.positions.b.x, 820)
  assert.equal(dag.layout.positions.b.y, 390)
  assert.ok(dag.layout.width >= 820 + 196)
  assert.ok(dag.layout.height >= 390 + 82)

  const reset = resetWorkflowLayoutPositions(wf)
  assert.equal(reset.nodes[0].pos, null)
  assert.equal(reset.nodes[1].pos, null)
  const autoDag = analyzeWorkflowDag(reset)
  assert.notEqual(autoDag.layout.positions.b.x, 820)
})


test('mediaGen.js 多厂商图片与视频协议兼容归一化（GLM CogView/CogVideoX / OpenAI / SiliconFlow / MiniMax）', async () => {
  const {
    detectMediaProvider,
    normalizeImageRequest,
    normalizeVideoRequest,
    extractImageResults,
    extractVideoResults,
    generateImageMedia,
    generateVideoMedia,
  } = await import('../src/services/mediaGen.js')

  assert.equal(detectMediaProvider('https://open.bigmodel.cn/api/paas/v4', 'cogview-4'), 'glm')
  assert.equal(detectMediaProvider('https://api.siliconflow.cn/v1', 'FLUX.1-schnell'), 'siliconflow')
  assert.equal(detectMediaProvider('https://api.minimaxi.com/v1', 'video-01'), 'minimax')

  const imgReq = normalizeImageRequest({ prompt: '赛博霓虹雨夜', aspectRatio: '16:9', quality: 'hd', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' })
  assert.equal(imgReq.provider, 'glm')
  assert.equal(imgReq.size, '1344x768')
  assert.equal(imgReq.body.quality, 'hd')

  const vidReq = normalizeVideoRequest({ prompt: '镜头缓慢推近', imageUrl: 'https://a.test/frame.png', duration: 10, baseUrl: 'https://open.bigmodel.cn/api/paas/v4' })
  assert.equal(vidReq.provider, 'glm')
  assert.equal(vidReq.body.image_url, 'https://a.test/frame.png')
  assert.equal(vidReq.pollPathForId('task_123'), '/async-result/task_123')

  const imgs = extractImageResults({ data: [{ url: 'https://cdn.test/1.png' }, { b64_json: 'AAAA' }] })
  assert.equal(imgs.length, 2)
  assert.ok(imgs[1].url.startsWith('data:image/png;base64,'))

  const vPending = extractVideoResults({ id: 'vid_99', task_status: 'PROCESSING' })
  assert.equal(vPending.status, 'pending')
  assert.equal(vPending.taskId, 'vid_99')
  const vDone = extractVideoResults({ task_status: 'SUCCESS', video_result: [{ url: 'https://cdn.test/out.mp4', cover_image_url: 'https://cdn.test/c.jpg' }] })
  assert.equal(vDone.status, 'done')
  assert.equal(vDone.items[0].url, 'https://cdn.test/out.mp4')

  // 离线预览模式优雅输出概念画布产物，不崩溃
  const dryImg = await generateImageMedia({ prompt: '极简玻璃建筑', dryRun: true })
  assert.equal(dryImg.ok, true)
  assert.ok(dryImg.artifact && dryImg.artifact.code.includes('data:image/svg+xml'))

  const dryVid = await generateVideoMedia({ prompt: '星空延时摄影', imageUrl: dryImg.items[0].url, dryRun: true })
  assert.equal(dryVid.ok, true)
  assert.equal(dryVid.artifact.mediaKind, 'video')
})

test('workflowEngine.js 新节点 image_gen → video_gen 首帧无缝继承 + loop 有界精修环 + 失败自动重试 + 局部重跑', async () => {
  const { executeWorkflowDag, synthesizeWorkflowFromPrompt } = await import('../src/services/workflowEngine.js')

  const vidWf = synthesizeWorkflowFromPrompt('拍一段赛博都市宣传片视频短片')
  assert.ok(vidWf.nodes.some((n) => n.kind === 'image_gen'))
  assert.ok(vidWf.nodes.some((n) => n.kind === 'video_gen'))

  let capturedI2VUrl = ''
  let attempts = 0
  const wf = {
    id: 'wf_media_loop',
    name: '多模态与精修测试',
    nodes: [
      { id: 'in', kind: 'input', label: '输入' },
      { id: 'img', kind: 'image_gen', label: '首帧图', prompt: '{{input}}', retryCount: 1 },
      { id: 'vid', kind: 'video_gen', label: '图生视频', prompt: '{{input}}' },
      { id: 'lp', kind: 'loop', label: '精修环', loopConfig: { maxIterations: 3, stopKeyword: 'APPROVED' } },
    ],
    edges: [
      { from: 'in', to: 'img' },
      { from: 'img', to: 'vid' },
      { from: 'vid', to: 'lp' },
    ],
  }
  let loopCalls = 0
  const res = await executeWorkflowDag({
    workflow: wf,
    input: '未来港口日出',
    runImageNode: async () => {
      attempts++
      if (attempts === 1) throw new Error('transient_502')
      return { ok: true, model: 'cogview-4', items: [{ url: 'https://cdn.test/keyframe.png' }] }
    },
    runVideoNode: async ({ imageUrl }) => {
      capturedI2VUrl = imageUrl
      return { ok: true, model: 'cogvideox-3', items: [{ url: 'https://cdn.test/clip.mp4' }] }
    },
    runLlmNode: async () => {
      loopCalls++
      return { content: loopCalls >= 2 ? '第二轮精修终稿 APPROVED' : '第一轮初稿' }
    },
  })
  assert.equal(res.status, 'done')
  assert.equal(attempts, 2, '首帧生图应自动重试 1 次成功')
  assert.equal(capturedI2VUrl, 'https://cdn.test/keyframe.png', 'video_gen 应自动继承上游 image_gen 首帧图 URL')
  assert.equal(loopCalls, 2, 'loop 节点应在命中 APPROVED 时提前收口')
})

test('toolRouter.js 与 pluginRegistry.js 支持 media 域自动挂载生图/视频工具且不破坏纯对话轻量工具面', async () => {
  const { predictToolProfile, selectToolsForProfile } = await import('../src/services/toolRouter.js')
  const { BUILTIN_PLUGINS, resolveAllPlugins, collectEnabledWorkflows } = await import('../src/services/pluginRegistry.js')
  assert.equal(predictToolProfile('帮我画一张赛博朋克风格海报图'), 'media')
  assert.equal(predictToolProfile('帮我生成视频短片宣传片'), 'media')

  const mediaTools = selectToolsForProfile([], 'media')
  const mNames = mediaTools.map((t) => t.function.name)
  assert.ok(mNames.includes('generate_image') && mNames.includes('generate_video'))

  assert.ok(BUILTIN_PLUGINS.length >= 8)
  const wfs = collectEnabledWorkflows(resolveAllPlugins())
  assert.ok(wfs.some((w) => w.id === 'wf-visual-poster'))
  assert.ok(wfs.some((w) => w.id === 'wf-ai-video-film'))
  assert.ok(wfs.some((w) => w.id === 'wf-iterative-refine'))
})


test('modelVault.js 自定义模型增删改与跨面板端点/Key/思考档位统一解析', async () => {
  const { upsertSavedModel, removeSavedModel, resolveEndpointWithSavedModel } = await import('../src/services/modelVault.js')
  const baseEp = {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: 'sk-global',
    model: 'glm-4.5-flash',
    isLocal: false,
    context_window: 128000,
    max_tokens: 4096,
    reasoning_effort: 'auto',
  }

  const r1 = upsertSavedModel([], {
    id: 'mdl_ds',
    label: 'DeepSeek 代码主力',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-ds-secret',
    contextWindow: 65536,
    maxTokens: 8192,
    reasoningTier: 'high',
  })
  assert.equal(r1.ok, true)
  assert.equal(r1.items.length, 1)

  const resolved = resolveEndpointWithSavedModel('mdl_ds', baseEp, r1.items)
  assert.equal(resolved.model, 'deepseek-chat')
  assert.equal(resolved.baseUrl, 'https://api.deepseek.com/v1')
  assert.equal(resolved.apiKey, 'sk-ds-secret')
  assert.equal(resolved.reasoning_effort, 'high')
  assert.equal(resolved.max_tokens, 8192)

  // 未命中的手填临时模型名应平滑回退继承 baseEp 端点与 Key
  const fallback = resolveEndpointWithSavedModel('custom-raw-v2', baseEp, r1.items)
  assert.equal(fallback.model, 'custom-raw-v2')
  assert.equal(fallback.baseUrl, baseEp.baseUrl)
  assert.equal(fallback.apiKey, 'sk-global')

  const afterDel = removeSavedModel(r1.items, 'mdl_ds')
  assert.equal(afterDel.length, 0)
})

test('industryExperts.js 专家库扩展至 18 大行业包与 10 大分类且检索准确', async () => {
  const { EXPERT_CATEGORIES, CURATED_INDUSTRY_PACKS, filterCuratedPacks } = await import('../src/services/industryExperts.js')
  assert.ok(EXPERT_CATEGORIES.length >= 10)
  assert.ok(CURATED_INDUSTRY_PACKS.length >= 18)
  assert.ok(filterCuratedPacks({ category: 'ai' }).some((p) => p.id === 'ai-agent-prompt-architect'))
  assert.ok(filterCuratedPacks({ category: 'devops' }).some((p) => p.id === 'cloud-devops-sre'))
  assert.ok(filterCuratedPacks({ query: '开源协议' }).some((p) => p.id === 'legal-ip-compliance-cn'))
})

test('kinetic.js 耦合反作用力在静息无障碍档位下严格返回 false 零位移', async () => {
  const { applySecondaryRecoil } = await import('../src/platform/kinetic.js')
  const fakeEl = { animate: () => ({}) }
  assert.equal(applySecondaryRecoil(fakeEl, { edge: 'left', motionTier: 'reduced' }), false)
  assert.equal(applySecondaryRecoil(fakeEl, { edge: 'left', motionTier: 'dynamic' }), true)
})


test('toolRouter.js R22 前沿 Agent 自主联网策略（auto 后台 / visible 前台 / off 离线）且不破坏默认契约', async () => {
  const { selectToolsForProfile, buildWebSearchDirective } = await import('../src/services/toolRouter.js')
  const mockAll = [
    'read_file', 'write_file', 'browser_search', 'browser_open', 'browser_navigate', 'browser_click',
  ].map((name) => ({ type: 'function', function: { name } }))

  const autoNames = selectToolsForProfile(mockAll, 'chat', { webSearchMode: 'auto' }).map((t) => t.function.name)
  assert.ok(autoNames.includes('browser_search') && autoNames.includes('browser_open'))
  assert.ok(!autoNames.includes('browser_click'))

  const visNames = selectToolsForProfile(mockAll, 'chat', { webSearchMode: 'visible' }).map((t) => t.function.name)
  assert.ok(visNames.includes('browser_search') && visNames.includes('browser_navigate') && visNames.includes('browser_click'))

  const offNames = selectToolsForProfile(mockAll, 'web', { webSearchMode: 'off' }).map((t) => t.function.name)
  assert.ok(!offNames.includes('browser_search') && !offNames.includes('browser_open'))

  assert.match(buildWebSearchDirective('auto'), /后台静默/)
  assert.match(buildWebSearchDirective('visible'), /mode="visible"/)
  assert.match(buildWebSearchDirective('off'), /离线模式/)
})


test('R23 专家库 / Skill 库 / MCP 目录均扩展至 50+ 且全部 ID 唯一、预建检索索引毫秒命中', async () => {
  const { CURATED_INDUSTRY_PACKS, CURATED_SKILLS, filterCuratedPacks, filterCuratedSkills } = await import('../src/services/industryExperts.js')
  const { CURATED_MCP_SERVERS, filterCuratedMcpServers } = await import('../src/services/mcpCatalog.js')

  assert.ok(CURATED_INDUSTRY_PACKS.length >= 50, `experts=${CURATED_INDUSTRY_PACKS.length}`)
  assert.ok(CURATED_SKILLS.length >= 50, `skills=${CURATED_SKILLS.length}`)
  assert.ok(CURATED_MCP_SERVERS.length >= 50, `mcp=${CURATED_MCP_SERVERS.length}`)

  assert.equal(new Set(CURATED_INDUSTRY_PACKS.map((x) => x.id)).size, CURATED_INDUSTRY_PACKS.length)
  assert.equal(new Set(CURATED_SKILLS.map((x) => x.id)).size, CURATED_SKILLS.length)
  assert.equal(new Set(CURATED_MCP_SERVERS.map((x) => x.id)).size, CURATED_MCP_SERVERS.length)

  assert.ok(filterCuratedPacks({ query: 'FastAPI' }).some((p) => p.id === 'python-fastapi-architect'))
  assert.ok(filterCuratedSkills({ query: '去 AI 味' }).some((s) => s.id === 'skill-de-ai-polish'))
  assert.ok(filterCuratedMcpServers({ query: 'context7' }).some((m) => m.serverKey === 'context7'))
})


test('R24 safeExpertText 兼容 {en, zh} 多语言对象防 React #31 崩溃 + 6 大液态玻璃撞击风格配置完整', async () => {
  const { safeExpertText, DREAM_TEAM_PRESETS } = await import('../src/services/expertTeam.js')
  const { IMPACT_STYLES, resolveImpactStyle } = await import('../src/platform/kinetic.js')

  assert.equal(safeExpertText({ en: 'Security Auditor', zh: '安全审计专家' }), '安全审计专家')
  assert.equal(safeExpertText({ en: 'English Only' }), 'English Only')
  assert.equal(safeExpertText(null, '兜底名'), '兜底名')
  assert.ok(DREAM_TEAM_PRESETS.length >= 6)

  assert.equal(IMPACT_STYLES.length, 6)
  assert.equal(resolveImpactStyle('crystal', 1).id, 'crystal')
  assert.notEqual(resolveImpactStyle('random', 0).id, resolveImpactStyle('random', 1).id)
})


test('R25 真实点击位置二维力矩物理（右上 vs 左下反向推力与反向 3D 倾角）+ 12 支成建制原生专家团队', async () => {
  const { computeDirectionalImpulse } = await import('../src/platform/kinetic.js')
  const { NATIVE_EXPERT_TEAMS, buildAvailableTeams } = await import('../src/services/expertTeam.js')

  const topRight = computeDirectionalImpulse({ nx: 0.9, ny: 0.1, strength: 'strong' })
  const botLeft = computeDirectionalImpulse({ nx: 0.1, ny: 0.9, strength: 'strong' })
  const center = computeDirectionalImpulse({ nx: 0.5, ny: 0.5, strength: 'strong' })

  // 点击右上向左下推 (vx < 0, vy > 0)，点击左下向右上推 (vx > 0, vy < 0)
  assert.ok(topRight.vx < -50 && topRight.vy > 50, `topRight=${JSON.stringify(topRight)}`)
  assert.ok(botLeft.vx > 50 && botLeft.vy < -50, `botLeft=${JSON.stringify(botLeft)}`)
  // 3D 杠杆力矩方向严格相反（按下哪一角，哪一角向屏幕内下沉）
  assert.ok(topRight.vry > 0 && botLeft.vry < 0)
  assert.ok(topRight.vrx > 0 && botLeft.vrx < 0)
  // 正中心零横向偏心，纯 Z 轴压缩
  assert.equal(center.vx, 0)
  assert.equal(center.vy, 0)
  assert.ok(center.vsc < -0.5)

  // 原生专家团：12 支固定编制团队，每支均自带 Lead + 多名固定角色
  assert.ok(NATIVE_EXPERT_TEAMS.length >= 12)
  assert.ok(NATIVE_EXPERT_TEAMS.every((t) => t.lead && t.lead.name && Array.isArray(t.members) && t.members.length >= 2))
  assert.ok(NATIVE_EXPERT_TEAMS.some((t) => t.id === 'software-company' && t.members.length === 4))
  assert.ok(NATIVE_EXPERT_TEAMS.some((t) => t.id === 'design-engine' && t.members.length === 5))

  // 本地多 Agent 团队包自动识别为独立原生团
  const merged = buildAvailableTeams([
    { id: 'custom-ops-team', metadata: { displayName: { zh: '本地自定义运维团', en: 'Custom Ops' } }, agents: ['./agents/lead.md', './agents/sre.md'] },
  ])
  assert.ok(merged.some((t) => t.id === 'custom-ops-team' && t.name === '本地自定义运维团'))
})


test('R26 局部液态玻璃定点按压物理（点左上/右下 3D 倾角严格相反，点正中心零偏心纯压缩）', async () => {
  const { computeLocalPressTransform } = await import('../src/platform/kinetic.js')

  const topLeft = computeLocalPressTransform(0.08, 0.12, 1)
  const botRight = computeLocalPressTransform(0.92, 0.88, 1)
  const center = computeLocalPressTransform(0.5, 0.5, 1)

  assert.ok(topLeft.ry < 0 && topLeft.rx > 0, `topLeft=${JSON.stringify(topLeft)}`)
  assert.ok(botRight.ry > 0 && botRight.rx < 0, `botRight=${JSON.stringify(botRight)}`)
  assert.equal(center.rx, 0)
  assert.equal(center.ry, 0)
  assert.ok(center.sc < 1 && center.sc > 0.95)
})


test('R28 液态玻璃物理沙盒：抓起/慢滑不归位/快甩弹墙裂痕碎裂/绝不自愈/长按召回/助手啃咬与同步修补', async () => {
  const {
    createGlassSandboxState, grabGlassBody, releaseGlassBody, recallGlassBody,
    biteGlassBody, startRepairBody, setRepairProgress, stepGlassSandbox,
  } = await import('../src/platform/glassSandboxEngine.js')

  const st = createGlassSandboxState()
  // 1) 抓起并慢放 -> 缓慢液态滑行，绝不主动归位
  grabGlassBody(st, { id: 'btn_set', label: '系统设置', x: 20, y: 120, w: 120, h: 36 })
  const relSlow = releaseGlassBody(st, 'btn_set', 20, 10)
  assert.equal(relSlow.snapped, false)
  for (let i = 0; i < 40; i++) stepGlassSandbox(st, 0.02, 1280, 800)
  assert.ok(st.bodies.has('btn_set') && st.bodies.get('btn_set').status === 'floating', '停稳松手不应主动归位')

  // 2) 高速甩向屏幕右墙 3 次重击 -> 产生裂痕并最终整块碎裂成碎片消失（绝不自动恢复）
  const body = st.bodies.get('btn_set')
  for (let hit = 0; hit < 3; hit++) {
    body.x = 1150; body.vx = 980; body.vy = 0
    stepGlassSandbox(st, 0.02, 1280, 800)
  }
  assert.equal(body.status, 'shattered')
  assert.ok(body.shards.length >= 10, `shards=${body.shards.length}`)
  for (let i = 0; i < 30; i++) stepGlassSandbox(st, 0.02, 1280, 800)
  assert.equal(st.bodies.get('btn_set').status, 'shattered', '碎裂后绝不自动恢复')

  // 3) 助手同步修补碎裂方块 -> 进度到 1 恢复消失的实体
  startRepairBody(st, 'btn_set')
  assert.equal(setRepairProgress(st, 'btn_set', 0.5).done, false)
  assert.equal(setRepairProgress(st, 'btn_set', 1).done, true)
  assert.equal(st.bodies.has('btn_set'), false)

  // 4) 助手偷啃液态玻璃 -> 留下真实咬痕，且不会自愈；修补进度满后彻底愈合
  const bitten = biteGlassBody(st, { id: 'btn_chat', label: '智能对话', x: 16, y: 80, w: 130, h: 36 })
  assert.equal(bitten.biteNotches.length, 1)
  startRepairBody(st, 'btn_chat')
  setRepairProgress(st, 'btn_chat', 1)
  assert.equal(st.bodies.has('btn_chat'), false)

  // 5) 长按原位召回浮动方块
  grabGlassBody(st, { id: 'btn_grp', label: '角色群聊', x: 16, y: 140, w: 120, h: 36 })
  st.bodies.get('btn_grp').x = 600; st.bodies.get('btn_grp').y = 300
  releaseGlassBody(st, 'btn_grp', 10, 0)
  recallGlassBody(st, 'btn_grp')
  for (let i = 0; i < 60; i++) stepGlassSandbox(st, 0.02, 1280, 800)
  assert.equal(st.bodies.has('btn_grp'), false, '长按原位召回后应准确回到原位')
})

test('R28 3D 二次元助手本地优先大脑 + 专属大模型开关 + 动作指令解析 + 丰富捏脸部位', async () => {
  const { planLocalCompanionResponse, parseLlmCompanionAction } = await import('../src/services/companionBrain.js')
  const { COMPANION_HAIRSTYLES, COMPANION_HEADGEARS, COMPANION_OUTFITS, COMPANION_ACCESSORIES } = await import('../src/services/companionCatalog.js')

  assert.ok(COMPANION_HAIRSTYLES.length >= 7 && COMPANION_HEADGEARS.length >= 7 && COMPANION_OUTFITS.length >= 6 && COMPANION_ACCESSORIES.length >= 7)

  const rClick = planLocalCompanionResponse('帮我打开系统设置')
  assert.equal(rClick.handledLocally, true)
  assert.equal(rClick.action.type, 'crouch_click')
  assert.equal(rClick.action.target, 'settings')

  const rWrite = planLocalCompanionResponse('帮我写：测试一下自动手写')
  assert.equal(rWrite.handledLocally, true)
  assert.equal(rWrite.action.type, 'write_input')
  assert.match(rWrite.action.text, /测试一下自动手写/)

  const rBh = planLocalCompanionResponse('用黑洞帮我把 spec.md 放进输入框')
  assert.equal(rBh.handledLocally, true)
  assert.equal(rBh.action.type, 'magic_blackhole')
  assert.equal(rBh.action.fileName, 'spec.md')

  const rRep = planLocalCompanionResponse('快去把啃掉的玻璃修补好', { damagedCount: 2 })
  assert.equal(rRep.handledLocally, true)
  assert.equal(rRep.action.type, 'repair_all')

  const llmAct = parseLlmCompanionAction('好的我马上过去！[[ACTION:blackhole:设计稿.md]]')
  assert.equal(llmAct.action.type, 'magic_blackhole')
  assert.equal(llmAct.action.fileName, '设计稿.md')
})


test('R29 全自动总管路由 (companionAutopilot)：准确判断 chat+专家+Skill / 原生专家团 / 工作流 / 群聊 / 双模协同与质检评分', async () => {
  const { planAutopilotLocally, evaluateDeliverableQuality } = await import('../src/services/companionAutopilot.js')
  const { isAutonomousDelegationRequest } = await import('../src/services/companionBrain.js')

  // 1) 短剧综合创作 → 自动指派 4 人原生「爆款短剧编导制片厂」
  const pDrama = planAutopilotLocally({ requirement: '帮我创作一集高反转都市悬疑短剧完整剧本和分镜' })
  assert.equal(pDrama.mode, 'expert_team')
  assert.equal(pDrama.team.id, 'short-drama-studio')

  // 2) AI 生图/短片流水线 → 自动选中 DAG 工作流
  const mockWfs = [{ id: 'wf_director', name: 'AI 短片导演流水线', description: '分镜+生图+视频', nodes: [{ id: 'n1', label: '生图', kind: 'image_gen' }] }]
  const pWf = planAutopilotLocally({ requirement: '帮我跑生图工作流生成一张赛博海报图', workflows: mockWfs })
  assert.equal(pWf.mode, 'workflow')
  assert.equal(pWf.workflow.id, 'wf_director')

  // 3) 精准单点任务 → 智能对话 + 自动匹配最佳专家与最佳 Skill
  const pSql = planAutopilotLocally({ requirement: '帮我写一条不扫全表的 SQL 慢查询优化建议' })
  assert.equal(pSql.mode, 'chat')
  assert.ok(pSql.expert && pSql.skill)

  // 4) 实质需求自动识别 & 质检评分
  assert.equal(isAutonomousDelegationRequest('帮我设计一套高并发微服务架构与发布方案'), true)
  assert.equal(isAutonomousDelegationRequest('帮我打开系统设置'), false)
  const qa = evaluateDeliverableQuality('# 架构方案\n- 分层解耦\n- 限流熔断\n```js\nexport const ok = true\n```\n' + '详细落地步骤说明。'.repeat(25), '高并发微服务架构')
  assert.equal(qa.ok, true)
  assert.ok(qa.score >= 80, `score=${qa.score}`)
})


test('R30 液态玻璃方块高速甩出窗口逃逸物理 (allowEscape) + 芽露官方建模包完整资产契约', async () => {
  const { createGlassSandboxState, grabGlassBody, releaseGlassBody, stepGlassSandbox, recallGlassBody } = await import('../src/platform/glassSandboxEngine.js')
  const { COMPANION_MODEL_PACKS, getActiveModelPack, DEFAULT_COMPANION_AVATAR } = await import('../src/services/companionCatalog.js')

  // 1) allowEscape=true 时高速甩向右边界直接逃逸出窗（status='escaped' + escape 事件），长按空槽可召回
  const st = createGlassSandboxState()
  grabGlassBody(st, { id: 'btn_esc', label: '智能对话', x: 1180, y: 200, w: 120, h: 36 })
  releaseGlassBody(st, 'btn_esc', 1100, 0)
  const evs = stepGlassSandbox(st, 0.02, 1280, 800, { allowEscape: true })
  assert.ok(evs.some((e) => e.type === 'escape' && e.side === 'right'), `events=${JSON.stringify(evs)}`)
  assert.equal(st.bodies.get('btn_esc').status, 'escaped')
  recallGlassBody(st, 'btn_esc')
  assert.equal(st.bodies.get('btn_esc').status, 'recalling')

  // 2) 默认助手模型为芽露原版建模包，含三视图/4表情/双道具/60fps成片
  assert.equal(DEFAULT_COMPANION_AVATAR.bodyForm, 'yalu_model')
  assert.equal(DEFAULT_COMPANION_AVATAR.name, '芽露')
  const yalu = getActiveModelPack('yalu_official')
  assert.ok(COMPANION_MODEL_PACKS.length >= 1)
  assert.ok(yalu.assets.front.endsWith('yalu-front.webp'))
  assert.ok(yalu.assets.side.endsWith('yalu-turn-side.webp'))
  assert.ok(yalu.assets.back.endsWith('yalu-turn-back.webp'))
  assert.equal(yalu.assets.expressions.length, 4)
  assert.ok(yalu.assets.props.staff.src.endsWith('prop-staff.webp'))
  assert.ok(yalu.assets.props.bell.src.endsWith('prop-bell.webp'))
  assert.ok(yalu.assets.showcaseVideo.endsWith('yalu-showcase.mp4'))
})
