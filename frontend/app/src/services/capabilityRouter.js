/**
 * 群聊主持人智能统筹与动态交接路由引擎（R10 升级版）：
 * - 告别死板的“按角色表顺序机械接力”：
 *   1) buildModeratorPrompt(topic, members, recentContext)：构建主持人统筹调度指令，
 *      让 AI 主持人根据任务类型动态筛选最匹配的专家、重排最优协作顺序（如 架构 → UI设计 → 实现 → 审查），
 *      并为每位入选角色定制专属任务书与交接方向；
 *   2) parseModeratorPlan(rawText, members)：从主持人输出中解析结构化调度计划，
 *      严格校验成员归属、去重、补齐定制 taskBrief，并在任何解析异常时平滑降级为本地拓扑智能编排；
 *   3) inferMemberCapabilities(name, persona)：添加/编辑角色时自动推断能力标签。
 */
export const CAPABILITY_CATALOG = Object.freeze([
  { id: 'text', label: '文本策划', color: 'primary' },
  { id: 'code', label: '代码工程', color: 'info' },
  { id: 'vision', label: 'UI与视觉', color: 'warn' },
  { id: 'video', label: '视频制作', color: 'ok' },
  { id: 'long-context', label: '长文深度', color: 'primary' },
])

export const GROUP_ROSTER_PRESETS = Object.freeze({
  engineering: {
    id: 'engineering',
    name: '工程铁三角',
    desc: '架构拆解 → 代码实现 → 严苛审查',
    members: [
      { id: 'm_arch', name: '架构师', persona: '拆解系统边界、识别技术风险并制定模块契约', model: '', baseUrl: '', capabilities: ['text', 'code', 'long-context'], reasoningTier: 'high', maxTokens: 4096, contextWindow: 128000, allowTools: true },
      { id: 'm_dev', name: '实现工程师', persona: '将方案落地为精确、可直接运行的高质量代码', model: '', baseUrl: '', capabilities: ['code', 'text'], reasoningTier: 'medium', maxTokens: 8192, contextWindow: 128000, allowTools: true },
      { id: 'm_qa', name: '代码审查员', persona: '挑出边界缺陷、竞态与未覆盖场景并给出收口结论', model: '', baseUrl: '', capabilities: ['code', 'long-context'], reasoningTier: 'high', maxTokens: 4096, contextWindow: 128000, allowTools: true },
    ],
  },
  video: {
    id: 'video',
    name: '视频制作班底',
    desc: '选题策划 → 分镜脚本与镜头语言 → 视觉/视频提示词与剪辑指导',
    members: [
      { id: 'm_vplan', name: '视频总策划', persona: '定调受众、节奏钩子、三幕结构与完整口播文案', model: '', baseUrl: '', capabilities: ['text', 'video'], reasoningTier: 'medium', maxTokens: 4096, contextWindow: 65536, allowTools: true },
      { id: 'm_vboard', name: '分镜导演', persona: '把文案拆成逐镜景别、运镜、时长、画面主体与转场衔接', model: '', baseUrl: '', capabilities: ['video', 'vision'], reasoningTier: 'high', maxTokens: 6144, contextWindow: 65536, allowTools: true },
      { id: 'm_vprompt', name: 'AIGC 视觉与剪辑指导', persona: '输出可直接投喂视频/图像生成模型的中英文提示词、配乐与剪辑节奏表', model: '', baseUrl: '', capabilities: ['video', 'vision', 'text'], reasoningTier: 'medium', maxTokens: 6144, contextWindow: 65536, allowTools: true },
    ],
  },
  research: {
    id: 'research',
    name: '深度调研与文案组',
    desc: '资料拆解 → 观点对撞 → 终稿润色',
    members: [
      { id: 'm_res', name: '行业研究员', persona: '梳理核心事实、数据结构与关键对比维度', model: '', baseUrl: '', capabilities: ['text', 'long-context'], reasoningTier: 'high', maxTokens: 6144, contextWindow: 128000, allowTools: true },
      { id: 'm_crit', name: '反方质疑官', persona: '专门寻找论证漏洞、反例与隐含假设', model: '', baseUrl: '', capabilities: ['text', 'long-context'], reasoningTier: 'high', maxTokens: 4096, contextWindow: 128000, allowTools: true },
      { id: 'm_edit', name: '主编定稿', persona: '整合并润色为结构清晰、有洞察力的最终交付文稿', model: '', baseUrl: '', capabilities: ['text'], reasoningTier: 'medium', maxTokens: 6144, contextWindow: 65536, allowTools: true },
    ],
  },
})

export function inferMemberCapabilities(name = '', persona = '') {
  const hay = `${String(name || '')} ${String(persona || '')}`
  const caps = new Set()
  if (/ui|ux|设计|视觉|美工|界面|交互|样式|figma|设计系统|前端美学|海报|插画|图像/i.test(hay)) {
    caps.add('vision')
  }
  if (/前端|后端|全栈|开发|工程|架构|代码|审查|测试|qa|运维|算法|数据|sql|security|安全/i.test(hay)) {
    caps.add('code')
  }
  if (/视频|分镜|导演|剪辑|动画|remotion|短片|aigc|口播/i.test(hay)) {
    caps.add('video')
    caps.add('vision')
  }
  if (/架构|审查|研究|调研|长文|文档|合同|财务|分析|统筹|总监/i.test(hay)) {
    caps.add('long-context')
  }
  if (/策划|文案|产品|运营|编辑|主编|写作|公文|汇报|增长|seo/i.test(hay) || caps.size === 0) {
    caps.add('text')
  }
  return [...caps]
}

export function normalizeGroupMember(raw, index = 0) {
  const m = raw && typeof raw === 'object' ? raw : {}
  const name = String(m.name || `成员 ${index + 1}`).trim()
  const persona = String(m.persona || m.role || '协同完成任务并给出高密度产出').trim()
  const validCaps = Array.isArray(m.capabilities)
    ? m.capabilities.filter((c) => CAPABILITY_CATALOG.some((x) => x.id === c))
    : []
  const inferred = inferMemberCapabilities(name, persona)
  let caps = validCaps.length ? [...validCaps] : inferred
  if (validCaps.length === 1 && validCaps[0] === 'text' && inferred.some((c) => c !== 'text')) {
    caps = [...new Set([...validCaps, ...inferred])]
  }
  return {
    id: String(m.id || `m_${Date.now().toString(36)}_${index}`),
    name,
    persona,
    model: String(m.model || '').trim(),
    baseUrl: String(m.baseUrl || '').trim(),
    capabilities: caps.length ? caps : ['text'],
    reasoningTier: String(m.reasoningTier || 'auto'),
    customThinkingBudget: Number(m.customThinkingBudget) || 8192,
    maxTokens: Number(m.maxTokens) || 0,
    contextWindow: Number(m.contextWindow) || 0,
    allowTools: m.allowTools !== false,
  }
}

/** 工作流拓扑阶段权重（确保设计/规划在编码实现之前，审查/定稿在实现之后，而非死板按表顺序） */
function workflowStageRank(member) {
  const hay = `${member.name} ${member.persona}`.toLowerCase()
  if (/策划|产品|需求|调研|研究|总监|统筹/.test(hay)) return 10
  if (/架构|结构|分镜/.test(hay)) return 20
  if (/ui|ux|设计|视觉|美工|界面|样式/.test(hay)) return 30
  if (/实现|开发|工程|前端|后端|全栈|制片/.test(hay)) return 40
  if (/审查|测试|qa|质检|反方|质疑|安全/.test(hay)) return 50
  if (/主编|定稿|总结|交付/.test(hay)) return 60
  return 35
}

export function classifyTaskIntent(topic, recentContextText = '') {
  const raw = String(topic || '').trim()
  const isFollowUp = /^(?:继续|接着|开始|好的|可以|按这个|执行|落地|go|continue)$/i.test(raw) || raw.length <= 4
  const combined = isFollowUp && recentContextText ? `${recentContextText}\n${raw}` : raw

  const requiredCaps = []
  const reasons = []

  if (/视频|分镜|短片|剪辑|运镜|口播|vlog|sora|runway|kling|可灵|即梦|remotion|movie|video/i.test(combined)) {
    requiredCaps.push('video')
    reasons.push('视频制作')
  }
  if (/ui|ux|设计|界面|视觉|美观|好看|样式|配色|排版|交互|玻璃|动画|动效|网页|页面|前端|落地页|图标|海报|配图|插画|截图|图像|design|image|poster|vision|css|html/i.test(combined)) {
    requiredCaps.push('vision')
    reasons.push('UI与视觉')
  }
  if (/网页|网站|代码|重构|接口|bug|报错|函数|组件|算法|数据库|前端|后端|工程|架构|审查|测试|脚本|react|node|python|css|html|sql|api/i.test(combined)) {
    requiredCaps.push('code')
    reasons.push('代码工程')
  }
  if (/长文|整本|全量|万字|财报|论文|合同|规范全文|长文档|全面|深度|系统/i.test(combined) || combined.length > 500) {
    requiredCaps.push('long-context')
    reasons.push('长文深度')
  }
  if (/文案|策划|方案|报告|公文|总结|prd|需求|调研|分析|写作|文章|手册/i.test(combined) || requiredCaps.length === 0) {
    requiredCaps.push('text')
    if (reasons.length === 0) reasons.push('文本策划')
  }

  return {
    capability: requiredCaps[0],
    capabilities: [...new Set(requiredCaps)],
    label: reasons.slice(0, 3).join(' + '),
    reason: `识别任务需求：${reasons.join('、')}`,
  }
}

function extractKeywords(text) {
  const s = String(text || '').toLowerCase()
  const tokens = s.match(/[a-z0-9_-]{2,}|[\u4e00-\u9fa5]{2,4}/g) || []
  const stop = new Set(['我们', '需要', '进行', '一个', '这个', '那个', '负责', '协同', '完成', '任务', '输出', '工作', '相关', '默认', '成员'])
  return [...new Set(tokens.filter((t) => !stop.has(t)))]
}

/** 构造发给 AI 主持人的调度提示词，要求输出严格的 JSON 选人与动态交接顺序 */
export function buildModeratorPrompt(topic, members = [], recentContextText = '') {
  const list = (Array.isArray(members) ? members : []).map((m, i) => normalizeGroupMember(m, i))
  const rosterLines = list.map((m) =>
    `- id="${m.id}" | 角色名="${m.name}" | 能力=[${m.capabilities.join(',')}] | 职责="${m.persona}"`
  ).join('\n')

  return [
    '你是本群聊的「智能接力主持人（Moderator）」。你的唯一任务是根据用户当前需求与近期上下文，从下方名册中**动态挑选最合适的成员、决定最合理的先后交接顺序（不要死板照抄名册顺序！）**，并为每位入选成员分配具体的本棒任务与交接重点。',
    '',
    '【调度铁律】',
    '1. 按真实工作流逻辑排顺序：例如做网页/产品时，应先「架构/策划」→ 再「UI/视觉设计」→ 再「实现工程师写代码落地」→ 最后「代码审查/测试验收」；如果是纯文案/调研任务，只选文案/调研相关角色，不要硬塞无关角色；如果用户明确点名某角色，必须入选。',
    '2. 只输出一个合法的 JSON 对象，不要输出多余寒暄或解释文字：',
    '```json',
    '{',
    '  "analysis": "一句话说明你的调度策略与为什么按此顺序交接",',
    '  "plan": [',
    '    { "id": "成员id", "taskBrief": "给该成员的具体本棒指令与交付要求" }',
    '  ]',
    '}',
    '```',
    '',
    '【当前可选角色名册】',
    rosterLines,
    ...(recentContextText ? ['', '【近期对话摘要】', recentContextText.slice(0, 800)] : []),
    '',
    `【用户本轮需求】\n${String(topic || '').trim()}`,
  ].join('\n')
}

/** 解析 AI 主持人返回的 JSON 调度单，失败时平滑降级为本地拓扑智能编排 */
export function parseModeratorPlan(rawText, members = [], fallbackRouted = null) {
  const list = (Array.isArray(members) ? members : []).map((m, i) => normalizeGroupMember(m, i))
  const byId = new Map(list.map((m) => [m.id, m]))
  const byName = new Map(list.map((m) => [m.name.toLowerCase(), m]))

  let parsed = null
  const str = String(rawText || '').trim()
  const fenceMatch = str.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [
    fenceMatch ? fenceMatch[1].trim() : '',
    str,
    (() => {
      const s = str.indexOf('{')
      const e = str.lastIndexOf('}')
      return (s >= 0 && e > s) ? str.slice(s, e + 1) : ''
    })(),
  ].filter(Boolean)

  for (const cand of candidates) {
    try {
      const obj = JSON.parse(cand)
      if (obj && typeof obj === 'object' && Array.isArray(obj.plan)) {
        parsed = obj
        break
      }
    } catch {}
  }

  if (parsed && parsed.plan.length > 0) {
    const picked = []
    const seen = new Set()
    for (const step of parsed.plan) {
      if (!step || typeof step !== 'object') continue
      const rawId = String(step.id || '').trim()
      const rawName = String(step.name || '').trim().toLowerCase()
      const member = byId.get(rawId) || byName.get(rawName)
      if (!member || seen.has(member.id)) continue
      seen.add(member.id)
      picked.push({
        ...member,
        taskBrief: String(step.taskBrief || step.brief || member.persona).trim(),
      })
    }
    if (picked.length > 0) {
      const routeChain = picked.map((m) => m.name).join(' ⟶ ')
      return {
        source: 'moderator-ai',
        analysis: String(parsed.analysis || `主持人已根据任务特征动态编排 ${picked.length} 棒协作流`).trim(),
        selected: picked,
        intentLabel: `主持人调度 (${picked.length}/${list.length} 棒: ${picked.map((m) => m.name).join('→')})`,
        routeChain,
      }
    }
  }

  // 兜底：使用本地拓扑智能排序（规划 → UI设计 → 实现 → 审查）
  const fb = fallbackRouted || routeGroupMembers('', list, 'smart', '')
  const fbSelected = fb.selected.map((m) => ({
    ...m,
    taskBrief: m.taskBrief || m.persona,
  }))
  return {
    source: 'topology-fallback',
    analysis: `按工作流阶段自动编排协作顺序：${fbSelected.map((m) => m.name).join(' ⟶ ')}`,
    selected: fbSelected,
    intentLabel: fb.intent.label,
    routeChain: fbSelected.map((m) => m.name).join(' ⟶ '),
  }
}

/**
 * 智能多角色拓扑路由（作为主持人前置初筛 + 离线/单元测试确定性调度器）：
 * 不仅按能力匹配，还会按工作流阶段权重（规划/架构 → UI设计 → 实现 → 审查）动态重排顺序！
 */
export function routeGroupMembers(topic, members = [], mode = 'smart', recentContextText = '') {
  const list = (Array.isArray(members) ? members : []).map((m, i) => normalizeGroupMember(m, i))
  const intent = classifyTaskIntent(topic, recentContextText)
  if (mode === 'all' || !list.length) {
    return {
      intent: { ...intent, label: `全员按序 (${list.length} 棒)` },
      selected: list,
      matchedCount: list.length,
      missingCapabilityWarning: '',
    }
  }

  const promptLower = `${String(topic || '')} ${String(recentContextText || '')}`.toLowerCase()
  const scored = list.map((m, idx) => {
    const capMatches = intent.capabilities.filter((c) => m.capabilities.includes(c))
    const roleTokens = extractKeywords(`${m.name} ${m.persona}`)
    const kwHits = roleTokens.filter((kw) => promptLower.includes(kw))
    const directNameHit = m.name && promptLower.includes(m.name.toLowerCase()) ? 5 : 0
    const score = capMatches.length * 3 + kwHits.length * 2 + directNameHit
    return { member: m, idx, score, stage: workflowStageRank(m) }
  })

  const sortByWorkflow = (arr) => [...arr].sort((a, b) => (a.stage - b.stage) || (a.idx - b.idx)).map((x) => x.member)

  const isGenericContinuation = /^(?:继续|接着|开始|好的|执行|go|continue)$/i.test(String(topic || '').trim()) && !String(recentContextText || '').trim()
  if (isGenericContinuation) {
    const ordered = sortByWorkflow(scored)
    return {
      intent: { ...intent, label: `智能协同 (${ordered.length} 棒)` },
      selected: ordered,
      matchedCount: ordered.length,
      missingCapabilityWarning: '',
    }
  }

  const matchedItems = scored.filter((x) => x.score > 0)
  if (matchedItems.length > 0) {
    const ordered = sortByWorkflow(matchedItems)
    const namesSummary = ordered.map((m) => m.name).join('→')
    return {
      intent: { ...intent, label: `${intent.label} (${ordered.length}/${list.length} 棒: ${namesSummary})` },
      selected: ordered,
      matchedCount: ordered.length,
      missingCapabilityWarning: '',
    }
  }

  const orderedAll = sortByWorkflow(scored)
  const warn = `当前议题暂无单一专长匹配，已智能编排全员（${orderedAll.length} 位）协同接力。`
  return {
    intent: { ...intent, label: `全员协同 (${orderedAll.length} 棒)` },
    selected: orderedAll,
    matchedCount: 0,
    missingCapabilityWarning: warn,
  }
}
