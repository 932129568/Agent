/**
 * 统一推理参数体系（设置中心、主对话、群聊角色独立覆写共用同一单一事实源）：
 * - 上下文长度（context_window）预设与自由数值；
 * - 最大输出长度（max_tokens）预设与自由数值；
 * - 思考档位：关闭 / 自动 / 低 / 中 / 高 / 超高 / 极致 / 自定义思考（自由 token 预算）；
 * - 按 Provider 自动映射底层字段（OpenAI/DeepSeek/GLM/Anthropic/Ollama）。
 */
export const CONTEXT_WINDOW_PRESETS = Object.freeze([
  { value: 8192, label: '8K（轻量本地）' },
  { value: 32768, label: '32K（标准）' },
  { value: 65536, label: '64K（长任务）' },
  { value: 128000, label: '128K（超长仓库）' },
  { value: 200000, label: '200K（旗舰长文）' },
])

export const MAX_OUTPUT_PRESETS = Object.freeze([
  { value: 2048, label: '2K' },
  { value: 4096, label: '4K' },
  { value: 8192, label: '8K' },
  { value: 16384, label: '16K' },
  { value: 32768, label: '32K' },
])

export const REASONING_TIERS = Object.freeze([
  { id: 'off', label: '关闭', effort: 'none', budget: 0, desc: '直出回答，不消耗思考 Token' },
  { id: 'auto', label: '自动', effort: 'auto', budget: 0, desc: '遵循模型端点默认推理策略' },
  { id: 'low', label: '低', effort: 'low', budget: 1024, desc: '轻量校验与快速问答 (~1K)' },
  { id: 'medium', label: '中', effort: 'medium', budget: 4096, desc: '常规工程与逻辑分析 (~4K)' },
  { id: 'high', label: '高', effort: 'high', budget: 12000, desc: '复杂架构与多步排障 (~12K)' },
  { id: 'xhigh', label: '超高', effort: 'xhigh', budget: 24576, desc: '深层推演与大型重构 (~24K)' },
  { id: 'max', label: '极致', effort: 'max', budget: 49152, desc: '极限预算全深度思考 (~48K)' },
  { id: 'custom', label: '自定义', effort: 'custom', budget: 8192, desc: '自定义思考 Token 预算或原始档位' },
])

export function getReasoningTierMeta(tierId) {
  return REASONING_TIERS.find((t) => t.id === tierId) || REASONING_TIERS[1]
}

export function detectProviderKind(baseUrl = '', model = '') {
  const u = String(baseUrl || '').toLowerCase()
  const m = String(model || '').toLowerCase()
  if (u.includes('bigmodel.cn') || m.startsWith('glm')) return 'glm'
  if (u.includes('anthropic.com') || m.includes('claude')) return 'anthropic'
  if (u.includes('deepseek.com') || m.includes('deepseek')) return 'deepseek'
  if (/127\.0\.0\.1:11434|localhost:11434/.test(u)) return 'ollama'
  return 'openai'
}

/**
 * 将中文多级思考档位 + 自定义预算映射为各模型厂商兼容的请求体字段。
 * 返回 { bodyPatch, summary }，绝不发送非法/冲突字段。
 */
export function buildReasoningRequestParams({
  baseUrl = '',
  model = '',
  tier = 'auto',
  customBudget = 8192,
  customEffort = '',
} = {}) {
  const provider = detectProviderKind(baseUrl, model)
  const meta = getReasoningTierMeta(tier)

  if (meta.id === 'auto') {
    return { provider, bodyPatch: {}, summary: `${provider}: 自动（透传端点默认）` }
  }

  const budget = meta.id === 'custom'
    ? Math.max(0, Math.min(128000, Math.round(Number(customBudget) || 0)))
    : meta.budget

  if (meta.id === 'off') {
    if (provider === 'glm' || provider === 'anthropic') {
      return { provider, bodyPatch: { thinking: { type: 'disabled' } }, summary: `${provider}: thinking=disabled` }
    }
    if (provider === 'ollama') {
      return { provider, bodyPatch: { think: false }, summary: 'ollama: think=false' }
    }
    return { provider, bodyPatch: {}, summary: `${provider}: 关闭思考` }
  }

  // OpenAI / DeepSeek 兼容 effort 档位（超出 high 时保留高档，并在 customEffort 非空时优先透传用户自定义名）
  const effortStr = (meta.id === 'custom' && String(customEffort || '').trim())
    ? String(customEffort).trim()
    : (meta.id === 'xhigh' || meta.id === 'max' ? 'high' : (meta.effort === 'custom' ? 'high' : meta.effort))

  if (provider === 'anthropic') {
    const b = Math.max(1024, budget || 4096)
    return {
      provider,
      bodyPatch: { thinking: { type: 'enabled', budget_tokens: b } },
      summary: `anthropic: thinking.budget_tokens=${b}`,
    }
  }
  if (provider === 'glm') {
    return {
      provider,
      bodyPatch: { thinking: { type: 'enabled' }, reasoning_effort: effortStr },
      summary: `glm: thinking=enabled, reasoning_effort=${effortStr}`,
    }
  }
  if (provider === 'ollama') {
    return {
      provider,
      bodyPatch: { think: true, reasoning_effort: effortStr },
      summary: `ollama: think=true, reasoning_effort=${effortStr}`,
    }
  }
  // OpenAI / DeepSeek / 通用兼容网关
  const patch = { reasoning_effort: effortStr }
  if (meta.id === 'custom' && budget > 0) patch.thinking = { type: 'enabled', budget_tokens: budget }
  return {
    provider,
    bodyPatch: patch,
    summary: `${provider}: reasoning_effort=${effortStr}${budget > 0 && meta.id === 'custom' ? `, budget=${budget}` : ''}`,
  }
}
