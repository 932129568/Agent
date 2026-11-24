/**
 * 模型保存中心纯函数引擎（R21 · 可直接 L1 单测）：
 * - 支持用户自定义添加并持久化多套模型配置（云端 / 本地 / 图片 / 视频，独立 Base URL、API Key、上下文与思考档位）；
 * - 在主对话（单会话独立切换）、顶栏灵动岛、角色群聊成员、DAG 工作流节点与双模协同中统一解析与无缝切换。
 */

export const MODEL_VAULT_PRESETS = Object.freeze([
  {
    id: 'preset_glm_flash',
    label: '智谱 GLM-4.5-Flash（高性价比主力）',
    model: 'glm-4.5-flash',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    kind: 'chat',
    contextWindow: 128000,
    maxTokens: 4096,
    reasoningTier: 'auto',
    notes: '智谱官方免费/高并发主力模型',
  },
  {
    id: 'preset_deepseek_chat',
    label: 'DeepSeek V3 / Chat（代码与推理）',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    kind: 'chat',
    contextWindow: 128000,
    maxTokens: 8192,
    reasoningTier: 'medium',
    notes: '擅长复杂代码重构与工程规划',
  },
  {
    id: 'preset_openai_gpt',
    label: 'OpenAI GPT-4.1（通用旗舰）',
    model: 'gpt-4.1',
    baseUrl: 'https://api.openai.com/v1',
    kind: 'chat',
    contextWindow: 128000,
    maxTokens: 8192,
    reasoningTier: 'auto',
    notes: 'OpenAI 兼容协议标准端点',
  },
  {
    id: 'preset_ollama_qwen',
    label: '本地 Ollama Qwen2.5（零费用离线）',
    model: 'qwen2.5:14b',
    baseUrl: 'http://127.0.0.1:11434/v1',
    kind: 'chat',
    contextWindow: 32768,
    maxTokens: 4096,
    reasoningTier: 'auto',
    notes: '局域网/本机隐私零成本运行',
  },
  {
    id: 'preset_cogview4',
    label: '智谱 CogView-4（高清文生图）',
    model: 'cogview-4-250304',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    kind: 'image',
    contextWindow: 16384,
    maxTokens: 4096,
    reasoningTier: 'auto',
    notes: '支持中文海报与写实插画生成',
  },
  {
    id: 'preset_cogvideox3',
    label: '智谱 CogVideoX-3（文/图生视频）',
    model: 'cogvideox-3',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    kind: 'video',
    contextWindow: 16384,
    maxTokens: 4096,
    reasoningTier: 'auto',
    notes: '支持首帧参考图无缝图生视频 I2V',
  },
])

function isLocalBaseUrl(url = '') {
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(String(url || '').trim())
}

export function normalizeSavedModel(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const model = String(r.model || '').trim()
  const baseUrl = String(r.baseUrl || r.base_url || '').trim()
  const apiKey = String(r.apiKey ?? r.api_key ?? '').trim()
  const kind = ['chat', 'image', 'video'].includes(r.kind) ? r.kind : 'chat'
  const label = String(r.label || '').trim() || model || '自定义模型'
  const id = String(r.id || '').trim() || `mdl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    label,
    model,
    baseUrl,
    apiKey,
    kind,
    isLocal: typeof r.isLocal === 'boolean' ? r.isLocal : isLocalBaseUrl(baseUrl),
    contextWindow: Math.max(4096, Number(r.contextWindow || r.context_window) || 128000),
    maxTokens: Math.max(256, Number(r.maxTokens || r.max_tokens) || 4096),
    reasoningTier: String(r.reasoningTier || r.reasoning_effort || 'auto').trim() || 'auto',
    notes: String(r.notes || '').trim().slice(0, 120),
    updatedAt: Number(r.updatedAt) || Date.now(),
  }
}

export function upsertSavedModel(list = [], rawModel = {}) {
  const arr = Array.isArray(list) ? list.map(normalizeSavedModel) : []
  const item = normalizeSavedModel(rawModel)
  if (!item.model) {
    return { ok: false, error: '模型标识（model）不能为空', items: arr }
  }
  const idx = arr.findIndex((x) => x.id === item.id)
  const next = idx >= 0
    ? arr.map((x, i) => (i === idx ? { ...item, updatedAt: Date.now() } : x))
    : [{ ...item, updatedAt: Date.now() }, ...arr]
  return { ok: true, item, items: next }
}

export function removeSavedModel(list = [], id = '') {
  const arr = Array.isArray(list) ? list : []
  return arr.filter((x) => x && x.id !== id)
}

export function findSavedModel(list = [], idOrModel = '') {
  const q = String(idOrModel || '').trim()
  if (!q || !Array.isArray(list)) return null
  return list.find((m) => m && m.id === q) || list.find((m) => m && m.model === q) || null
}

/**
 * 将模型引用（保存模型 ID 或原始模型名）解析为完整可执行 Endpoint：
 * - 若命中模型保存中心，同时接管其独立 baseUrl、apiKey、context_window、max_tokens、reasoning_effort 与 isLocal；
 * - 若未命中（手填临时模型名），继承 baseEp 的端点与 Key，仅覆写 model 字段。
 */
export function resolveEndpointWithSavedModel(idOrModel, baseEp = {}, savedModels = []) {
  const ref = String(idOrModel || '').trim()
  if (!ref) return { ...baseEp }
  const hit = findSavedModel(savedModels, ref)
  if (!hit) {
    return { ...baseEp, model: ref }
  }
  const resolvedBase = hit.baseUrl || baseEp.baseUrl
  const resolvedKey = hit.apiKey || baseEp.apiKey
  return {
    ...baseEp,
    savedModelId: hit.id,
    savedModelLabel: hit.label,
    model: hit.model || baseEp.model,
    baseUrl: resolvedBase,
    apiKey: resolvedKey,
    isLocal: hit.baseUrl ? isLocalBaseUrl(hit.baseUrl) : Boolean(baseEp.isLocal),
    context_window: hit.contextWindow || baseEp.context_window,
    max_tokens: hit.maxTokens || baseEp.max_tokens,
    reasoning_effort: (hit.reasoningTier && hit.reasoningTier !== 'auto') ? hit.reasoningTier : baseEp.reasoning_effort,
  }
}
