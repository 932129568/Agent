/**
 * 群聊多能力路由与角色模板库（解决第二轮验收单 #1：「自定义角色/模型 + 如果要做视频怎么办」）：
 * - 声明五种能力标签：text / code / vision / video / long-context；
 * - 按议题自动识别任务意图并匹配具备对应能力的成员按序接力；
 * - 当任务需要 video/vision 而当前名册无对应能力角色时，诚实预警并推荐一键切换模板。
 */
export const CAPABILITY_CATALOG = Object.freeze([
  { id: 'text', label: '文本策划', color: 'primary' },
  { id: 'code', label: '代码工程', color: 'info' },
  { id: 'vision', label: '图像视觉', color: 'warn' },
  { id: 'video', label: '视频制作', color: 'ok' },
  { id: 'long-context', label: '长文深度', color: 'primary' },
])

export const GROUP_ROSTER_PRESETS = Object.freeze({
  engineering: {
    id: 'engineering',
    name: '工程铁三角',
    desc: '架构拆解 → 代码实现 → 严苛审查',
    members: [
      { id: 'm_arch', name: '架构师', persona: '拆解系统边界、识别技术风险并制定模块契约', model: '', baseUrl: '', capabilities: ['text', 'code', 'long-context'], reasoningTier: 'high', maxTokens: 4096, contextWindow: 128000 },
      { id: 'm_dev', name: '实现工程师', persona: '将方案落地为精确、可直接运行的高质量代码', model: '', baseUrl: '', capabilities: ['code', 'text'], reasoningTier: 'medium', maxTokens: 8192, contextWindow: 128000 },
      { id: 'm_qa', name: '代码审查员', persona: '挑出边界缺陷、竞态与未覆盖场景并给出收口结论', model: '', baseUrl: '', capabilities: ['code', 'long-context'], reasoningTier: 'high', maxTokens: 4096, contextWindow: 128000 },
    ],
  },
  video: {
    id: 'video',
    name: '视频制作班底',
    desc: '选题策划 → 分镜脚本与镜头语言 → 视觉/视频提示词与剪辑指导',
    members: [
      { id: 'm_vplan', name: '视频总策划', persona: '定调受众、节奏钩子、三幕结构与完整口播文案', model: '', baseUrl: '', capabilities: ['text', 'video'], reasoningTier: 'medium', maxTokens: 4096, contextWindow: 65536 },
      { id: 'm_vboard', name: '分镜导演', persona: '把文案拆成逐镜景别、运镜、时长、画面主体与转场衔接', model: '', baseUrl: '', capabilities: ['video', 'vision'], reasoningTier: 'high', maxTokens: 6144, contextWindow: 65536 },
      { id: 'm_vprompt', name: 'AIGC 视觉与剪辑指导', persona: '输出可直接投喂视频/图像生成模型的中英文提示词、配乐与剪辑节奏表', model: '', baseUrl: '', capabilities: ['video', 'vision', 'text'], reasoningTier: 'medium', maxTokens: 6144, contextWindow: 65536 },
    ],
  },
  research: {
    id: 'research',
    name: '深度调研与文案组',
    desc: '资料拆解 → 观点对撞 → 终稿润色',
    members: [
      { id: 'm_res', name: '行业研究员', persona: '梳理核心事实、数据结构与关键对比维度', model: '', baseUrl: '', capabilities: ['text', 'long-context'], reasoningTier: 'high', maxTokens: 6144, contextWindow: 128000 },
      { id: 'm_crit', name: '反方质疑官', persona: '专门寻找论证漏洞、反例与隐含假设', model: '', baseUrl: '', capabilities: ['text', 'long-context'], reasoningTier: 'high', maxTokens: 4096, contextWindow: 128000 },
      { id: 'm_edit', name: '主编定稿', persona: '整合并润色为结构清晰、有洞察力的最终交付文稿', model: '', baseUrl: '', capabilities: ['text'], reasoningTier: 'medium', maxTokens: 6144, contextWindow: 65536 },
    ],
  },
})

export function normalizeGroupMember(raw, index = 0) {
  const m = raw && typeof raw === 'object' ? raw : {}
  const caps = Array.isArray(m.capabilities) && m.capabilities.length
    ? m.capabilities.filter((c) => CAPABILITY_CATALOG.some((x) => x.id === c))
    : ['text']
  return {
    id: String(m.id || `m_${Date.now().toString(36)}_${index}`),
    name: String(m.name || `成员 ${index + 1}`).trim(),
    persona: String(m.persona || m.role || '协同完成任务并给出高密度产出').trim(),
    model: String(m.model || '').trim(),
    baseUrl: String(m.baseUrl || '').trim(),
    capabilities: caps.length ? caps : ['text'],
    reasoningTier: String(m.reasoningTier || 'auto'),
    customThinkingBudget: Number(m.customThinkingBudget) || 8192,
    maxTokens: Number(m.maxTokens) || 0,
    contextWindow: Number(m.contextWindow) || 0,
  }
}

export function classifyTaskIntent(topic) {
  const t = String(topic || '')
  if (/视频|分镜|短片|剪辑|运镜|口播|vlog|sora|runway|kling|可灵|即梦|movie|video/i.test(t)) {
    return { capability: 'video', label: '视频制作', reason: '检测到视频/分镜/剪辑关键词' }
  }
  if (/图片|海报|配图|插画|ui图|视觉|截图|图像|design|image|poster|vision/i.test(t)) {
    return { capability: 'vision', label: '图像视觉', reason: '检测到视觉/配图/画面关键词' }
  }
  if (/代码|重构|接口|bug|报错|函数|组件|算法|数据库|react|node|python|css|sql/i.test(t)) {
    return { capability: 'code', label: '代码工程', reason: '检测到代码/架构/工程关键词' }
  }
  if (/长文|整本|全量|万字|财报|论文|合同|规范全文|长文档/i.test(t) || t.length > 600) {
    return { capability: 'long-context', label: '长文深度', reason: '检测到长文档深度分析需求' }
  }
  return { capability: 'text', label: '文本策划', reason: '常规文本协作任务' }
}

/**
 * 按模式筛选参与本轮接力的成员列表：
 * - mode === 'all'：全员按序接力；
 * - mode === 'smart'：优先选出具备对应任务能力的成员，若无命中则诚实返回 warning 并回退全员。
 */
export function routeGroupMembers(topic, members = [], mode = 'smart') {
  const list = (Array.isArray(members) ? members : []).map((m, i) => normalizeGroupMember(m, i))
  const intent = classifyTaskIntent(topic)
  if (mode === 'all' || !list.length) {
    return { intent, selected: list, matchedCount: list.length, missingCapabilityWarning: '' }
  }
  const matched = list.filter((m) => m.capabilities.includes(intent.capability))
  if (matched.length > 0) {
    return { intent, selected: matched, matchedCount: matched.length, missingCapabilityWarning: '' }
  }
  const warn = `当前议题识别为「${intent.label} (${intent.capability})」，名册中暂无声明该能力的角色；已回退全员文本接力（建议一键切换「视频制作班底」或给角色勾选对应能力并指定专用模型）。`
  return { intent, selected: list, matchedCount: 0, missingCapabilityWarning: warn }
}
