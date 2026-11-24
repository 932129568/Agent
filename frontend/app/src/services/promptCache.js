/**
 * Harbor 前沿 Agent KV-Cache / Prompt Caching 命中率拉升引擎（纯函数 + 无状态协议适配）：
 *
 * 对齐 Claude Code / Manus / OpenAI / Anthropic / DeepSeek / GLM 前沿实践的六大核心机制：
 *   1. 确定性键排序与工具表冻结（canonicalizeTools）：按 tool name 字母序 + 递归键名排序，
 *      消除 JSON 属性漂移；严禁在只读模式下删改 tools 数组（用尾部状态掩码替代）。
 *   2. 静态前缀绝对冻结（Static Prefix Freeze）：System Prompt 仅放零动态变化的宪章/项目规则/常驻偏好；
 *      随 query 变化的动态记忆、专家指令、只读状态与续跑纠偏一律后置到「最新一轮用户消息」的
 *      `<system-reminder>` 中，保住 `[tools + system + turns 1..N-1]` 100% 逐字节命中！
 *   3. 跨厂商显式缓存断点与路由键（applyProviderCacheControl）：
 *      - Anthropic/Claude：3 个精确 `cache_control: { type: 'ephemeral' }` 滑动断点
 *        （最后一条 tool 定义 + 冻结 system prompt + 历史倒数第二条消息）；
 *      - OpenAI：透传 `prompt_cache_key` 粘性分片路由 + `stream_options.include_usage`；
 *      - DeepSeek：自动隐式前缀缓存 + `stream_options.include_usage`；
 *      - GLM / 自定义网关：保零未知顶层字段（防 400），靠 100% 稳定前缀自动吃满 5× 缓存折扣。
 *   4. 统一多厂商缓存命中遥测（extractCacheUsage）：归一 OpenAI/GLM/vLLM (`cached_tokens`)、
 *      DeepSeek (`prompt_cache_hit_tokens`)、Anthropic (`cache_read_input_tokens`)。
 *   5. 轻量前缀指纹（computePrefixFingerprint）：实时监测前缀是否发生意外漂移。
 */
import { detectProviderKind } from './reasoningPresets.js'

export function canonicalizeValue(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalizeValue)
  const out = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) out[key] = canonicalizeValue(value[key])
  }
  return out
}

/** 确定性工具定义序列化：按函数名排序并递归排序 Schema 键，保证跨轮 0 字节漂移 */
export function canonicalizeTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return []
  return [...tools]
    .filter((t) => t && typeof t === 'object')
    .sort((a, b) => {
      const na = String((a.function && a.function.name) || a.name || '')
      const nb = String((b.function && b.function.name) || b.name || '')
      return na.localeCompare(nb)
    })
    .map(canonicalizeValue)
}

/** 32-bit FNV-1a 轻量指纹，用于在前端监测 [tools + systemPrompt] 前缀稳定性 */
export function computePrefixFingerprint(systemPrompt = '', tools = []) {
  const payload = `${String(systemPrompt || '')}\n@@TOOLS@@\n${JSON.stringify(canonicalizeTools(tools))}`
  let h = 0x811c9dc5
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * 构造动态尾部 `<system-reminder>`：
 * 所有每轮会变化的内容（按 query 检索出的记忆、专家模式切换、只读模式掩码、续跑纠偏）
 * 全部收纳于此，绝不污染 messages[0] 静态前缀！
 */
export function buildDynamicTurnReminder({
  memories = [],
  expertPrompt = '',
  readonlyMode = false,
  correctiveDirective = '',
} = {}) {
  const sections = []
  if (Array.isArray(memories) && memories.length) {
    const lines = memories
      .map((m) => String(typeof m === 'string' ? m : (m && (m.text || m.content || m.value)) || '').trim())
      .filter(Boolean)
      .slice(0, 4)
    if (lines.length) {
      sections.push(`【本轮动态检索记忆（仅供本轮参考）】\n${lines.map((l) => `- ${l}`).join('\n')}`)
    }
  }
  if (String(expertPrompt || '').trim()) {
    sections.push(`【当前激活专家指令】\n${String(expertPrompt).trim()}`)
  }
  if (readonlyMode) {
    sections.push('【状态掩码 · 只读模式】当前已进入只读保护态：严禁调用写文件（write_file / search_replace / delete_path 等）或命令执行工具，只做只读分析并向用户汇报。')
  }
  if (String(correctiveDirective || '').trim()) {
    sections.push(`【用户续跑纠偏指令】\n${String(correctiveDirective).trim()}`)
  }
  if (!sections.length) return ''
  return `<system-reminder>\n${sections.join('\n\n')}\n</system-reminder>`
}

/**
 * 将动态 `<system-reminder>` 无侵入追加到「最新一条 user 消息」尾部，
 * 保证 messages[0..N-2] 的历史前缀 100% 不可变（append-only invariant）。
 */
export function attachReminderToLatestUserTurn(messages, reminder) {
  const list = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : []
  const rem = String(reminder || '').trim()
  if (!rem || !list.length) return list
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].role === 'user') {
      const base = String(list[i].content == null ? '' : list[i].content)
      list[i] = { ...list[i], content: base ? `${base}\n\n${rem}` : rem }
      return list
    }
  }
  list.push({ role: 'user', content: rem })
  return list
}

function asCacheMarkedMessage(msg) {
  if (!msg || typeof msg !== 'object') return msg
  if (Array.isArray(msg.content)) {
    const blocks = msg.content.map((b) => ({ ...b }))
    if (blocks.length) blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } }
    return { ...msg, content: blocks }
  }
  const text = String(msg.content == null ? '' : msg.content)
  if (!text) return msg
  return {
    ...msg,
    content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }],
  }
}

/**
 * 按模型供应商注入最优 Prompt Caching 协议控制字段（零破坏、零未知字段 400 风险）：
 * - Anthropic / Claude：3 个滑动断点（last tool + system[0] + 历史倒数第二条）；
 * - OpenAI：prompt_cache_key 粘性路由 + stream_options.include_usage；
 * - DeepSeek：stream_options.include_usage（隐式自动前缀缓存）；
 * - GLM / Ollama / 其他：严格纯净前缀 + 确定性工具序（绝不塞非标顶层字段）。
 */
export function applyProviderCacheControl({
  baseUrl = '',
  model = '',
  messages = [],
  tools = [],
  sid = '',
  enabled = true,
} = {}) {
  const provider = detectProviderKind(baseUrl, model)
  const canonTools = canonicalizeTools(tools)
  const outMessages = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : []
  const extraBody = {}

  if (!enabled) {
    return { provider, messages: outMessages, tools: canonTools, extraBody, breakpoints: 0 }
  }

  if (provider === 'anthropic') {
    let bp = 0
    // 断点 1：最后一个工具定义（锁死整块 tools Schema）
    const markedTools = canonTools.map((t, idx) => {
      if (idx === canonTools.length - 1) {
        bp++
        return { ...t, cache_control: { type: 'ephemeral' } }
      }
      return t
    })
    // 断点 2：冻结的 system prompt
    if (outMessages.length > 0 && outMessages[0].role === 'system') {
      outMessages[0] = asCacheMarkedMessage(outMessages[0])
      bp++
    }
    // 断点 3：滑动历史断点——标在「最后一条非当前最新提问的历史消息」上，整段历史逐轮递增命中
    if (outMessages.length >= 3) {
      const targetIdx = outMessages.length - 2
      if (outMessages[targetIdx] && outMessages[targetIdx].role !== 'system') {
        outMessages[targetIdx] = asCacheMarkedMessage(outMessages[targetIdx])
        bp++
      }
    }
    return { provider, messages: outMessages, tools: markedTools, extraBody, breakpoints: bp }
  }

  if (provider === 'openai') {
    if (sid) extraBody.prompt_cache_key = `harbor_${String(sid).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48)}`
    extraBody.stream_options = { include_usage: true }
    return { provider, messages: outMessages, tools: canonTools, extraBody, breakpoints: 1 }
  }

  if (provider === 'deepseek') {
    extraBody.stream_options = { include_usage: true }
    return { provider, messages: outMessages, tools: canonTools, extraBody, breakpoints: 1 }
  }

  // GLM / Ollama / 通用 OpenAI 兼容网关：不发送非标字段，全靠确定性冻结前缀吃满隐式前缀缓存
  return { provider, messages: outMessages, tools: canonTools, extraBody, breakpoints: 0 }
}

/**
 * 统一解析各厂商 usage 中的真实缓存命中指标：
 * - OpenAI / GLM / vLLM: usage.prompt_tokens_details.cached_tokens
 * - DeepSeek:            usage.prompt_cache_hit_tokens
 * - Anthropic:           usage.cache_read_input_tokens / usage.cache_creation_input_tokens
 */
export function extractCacheUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return { promptTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, hitRate: 0, hasCacheData: false }
  }
  const details = usage.prompt_tokens_details || usage.input_tokens_details || {}
  const cachedTokens = Math.max(
    0,
    Number(details.cached_tokens)
      || Number(usage.prompt_cache_hit_tokens)
      || Number(usage.cache_read_input_tokens)
      || Number(usage.cached_tokens)
      || 0
  )
  const cacheWriteTokens = Math.max(
    0,
    Number(usage.cache_creation_input_tokens)
      || Number(details.cache_creation_tokens)
      || 0
  )
  const missTokens = Math.max(0, Number(usage.prompt_cache_miss_tokens) || 0)
  const hasOpenAiPrompt = usage.prompt_tokens !== undefined && usage.prompt_tokens !== null
  const isNativeAnthropic = !hasOpenAiPrompt && usage.input_tokens !== undefined && usage.cache_read_input_tokens !== undefined
  const rawPrompt = Math.max(0, Number(usage.prompt_tokens) || Number(usage.input_tokens) || 0)

  // 关键修正：
  // 1) DeepSeek 同时返回 hit + miss 时，hit + miss 为精确总输入分母；
  // 2) OpenAI 兼容网关（含同时透传 prompt_tokens 与 cache_read_input_tokens 的聚合网关）中，
  //    prompt_tokens 已包含 cachedTokens，绝不能重复相加（否则 95% 会被算成 48.7% ≈ 49%！）；
  // 3) 仅原生 Anthropic（无 prompt_tokens、只有 input_tokens）才需要 input_tokens + read + write。
  let denominator = 0
  if (usage.prompt_cache_hit_tokens !== undefined && usage.prompt_cache_miss_tokens !== undefined) {
    denominator = Math.max(rawPrompt, cachedTokens + missTokens)
  } else if (isNativeAnthropic) {
    denominator = rawPrompt + cachedTokens + cacheWriteTokens
  } else {
    denominator = Math.max(rawPrompt, cachedTokens)
  }

  const hitRate = denominator > 0 ? Math.min(100, Math.round((cachedTokens / denominator) * 100)) : 0
  const hasCacheData = cachedTokens > 0
    || cacheWriteTokens > 0
    || missTokens > 0
    || details.cached_tokens !== undefined
    || usage.prompt_cache_hit_tokens !== undefined
    || usage.cache_read_input_tokens !== undefined
  return {
    promptTokens: denominator,
    cachedTokens,
    cacheWriteTokens,
    hitRate,
    hasCacheData,
  }
}
