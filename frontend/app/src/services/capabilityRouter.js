/**
 * 群聊智能多能力路由与角色自动画像引擎（R9 全面升级版）：
 * - 解决旧版只匹配单一 capability 导致「只调度架构师+实现工程师、跳过 ui设计/审查员」的局限；
 * - 新增 inferMemberCapabilities(name, persona)：添加/编辑角色时自动根据角色名与人设推断能力标签；
 * - 新增 multi-intent + 角色语义相关度联合路由：
 *   1) 自动识别复合任务意图（如“做带好看 UI 的网页”同时命中 vision + code）；
 *   2) 结合历史上下文补全短指令（如“继续”、“按这个做”）；
 *   3) 直接匹配每个成员的 name 与 persona 关键词，确保用户自定义添加的「ui设计」「测试」「文案」等角色被精准调度。
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

/** 根据角色名称与人设自动推断最匹配的能力标签组合（避免新加的「ui设计」被误标成纯 text） */
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
  // 若未显式传 capabilities（或仅默认占位且名字明显指向设计/视频/代码），结合角色名智能补全
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

const CAP_LABEL_MAP = Object.freeze({
  text: '文本策划',
  code: '代码工程',
  vision: 'UI与视觉',
  video: '视频制作',
  'long-context': '长文深度',
})

/** 多维度意图识别：支持复合任务（例如“做一个带好看 UI 的网页”同时命中 vision + code） */
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

  const primary = requiredCaps[0]
  return {
    capability: primary,
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

/**
 * 智能多角色调度器：
 * - mode === 'all'：全员按名册顺序接力；
 * - mode === 'smart'：
 *   1) 识别任务的复合能力集合（intent.capabilities）；
 *   2) 对每位成员计算「能力标签命中分 + 角色名/职责语义关键词命中分」；
 *   3) 凡命中任一所需能力或角色语义匹配度 > 0 的成员全部入选（保持名册自然流水线顺序）；
 *   4) 若无专长命中则诚实预警并回退全员，绝不会莫名其妙只挑 2 个人而丢掉 UI设计 / 审查员！
 */
export function routeGroupMembers(topic, members = [], mode = 'smart', recentContextText = '') {
  const list = (Array.isArray(members) ? members : []).map((m, i) => normalizeGroupMember(m, i))
  const intent = classifyTaskIntent(topic, recentContextText)
  if (mode === 'all' || !list.length) {
    return {
      intent: { ...intent, label: `全员接力 (${list.length} 棒)` },
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
    // 明确点名角色名（如“ui设计”/“审查”）给高权重
    const directNameHit = m.name && promptLower.includes(m.name.toLowerCase()) ? 5 : 0
    const score = capMatches.length * 3 + kwHits.length * 2 + directNameHit
    return { member: m, idx, score, capMatches, kwHits }
  })

  // 如果提示词只是极短通用指令（如“继续”且无历史上下文），默认全员协同执行，而不是只挑 2 人
  const isGenericContinuation = /^(?:继续|接着|开始|好的|执行|go|continue)$/i.test(String(topic || '').trim()) && !String(recentContextText || '').trim()
  if (isGenericContinuation) {
    return {
      intent: { ...intent, label: `全员协同 (${list.length} 棒)` },
      selected: list,
      matchedCount: list.length,
      missingCapabilityWarning: '',
    }
  }

  const matched = scored.filter((x) => x.score > 0).map((x) => x.member)
  if (matched.length > 0) {
    const namesSummary = matched.map((m) => m.name).join('→')
    return {
      intent: { ...intent, label: `${intent.label} (${matched.length}/${list.length} 棒: ${namesSummary})` },
      selected: matched,
      matchedCount: matched.length,
      missingCapabilityWarning: '',
    }
  }

  const needLabels = intent.capabilities.map((c) => CAP_LABEL_MAP[c] || c).join(' / ')
  const warn = `当前议题需要「${needLabels}」，名册中暂无对应专长角色；已自动调度全员（${list.length} 位）协同接力。`
  return {
    intent: { ...intent, label: `全员兜底 (${list.length} 棒)` },
    selected: list,
    matchedCount: 0,
    missingCapabilityWarning: warn,
  }
}
