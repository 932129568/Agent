/**
 * 统一模型 SSE 流式传输层（LAW-03）：
 * - 统一走 assertLatin1Headers() 拦截 API Key / Base URL 非 ASCII 字符；
 * - 自动经本地代理转发本地/非 CORS 端点，或直连云端 OpenAI 兼容端点；
 * - 429 full-jitter 退避（尊重 Retry-After）+ 本地 503 冷加载重试 + AbortSignal 传播；
 * - 实时输出 reasoning / content / toolCalls 增量与真实出字速度 cps。
 */
import { HarborError, isAbort } from './errors.js'
import { assertLatin1Headers, assertLatin1Value } from './headers.js'
import { getLocalProxy } from './bridge.js'
import { buildReasoningRequestParams } from './reasoningPresets.js'

const sleepAbortable = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) return reject(new HarborError('USER_PAUSED', '已中止'))
  const t = setTimeout(() => { cleanup(); resolve() }, ms)
  const onAbort = () => { clearTimeout(t); cleanup(); reject(new HarborError('USER_PAUSED', '已中止')) }
  const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort) }
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
})

function normalizeBaseUrl(baseUrl) {
  const clean = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!clean) throw new HarborError('MISSING_BASE_URL', '请先在「设置 → 模型与推理」配置 Base URL')
  return clean.replace(/\/chat\/completions$/i, '')
}

function buildChatUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`
}

function isLocalEndpoint(url) {
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(String(url || ''))
}

export async function resolveStreamEndpoint(baseUrl, harnessMeta = null) {
  const cleanBase = normalizeBaseUrl(baseUrl)
  const directUrl = buildChatUrl(cleanBase)
  assertLatin1Value('Base URL', cleanBase)
  const local = isLocalEndpoint(cleanBase)
  try {
    const proxy = await getLocalProxy()
    if (proxy && proxy.ok !== false && proxy.base_url) {
      const extraHeaders = {
        'X-Harbor-Target': cleanBase,
        ...(harnessMeta ? { 'X-Harbor-Harness': JSON.stringify(harnessMeta) } : {}),
      }
      return {
        url: `${String(proxy.base_url).replace(/\/+$/, '')}/chat/completions`,
        extraHeaders,
        local,
        targetBase: cleanBase,
      }
    }
  } catch {
    // 代理未就绪时回落直连
  }
  return { url: directUrl, extraHeaders: {}, local, targetBase: cleanBase }
}

export async function streamChatCompletion({
  baseUrl,
  apiKey,
  model,
  messages,
  tools = [],
  temperature = 0.7,
  topP = 0.9,
  maxTokens = 4096,
  reasoningEffort = 'auto',
  thinkingBudget = 0,
  customEffort = '',
  harnessMeta = null,
  signal = null,
  onDelta = null,
}) {
  const key = String(apiKey == null ? '' : apiKey).trim()
  assertLatin1Value('API Key', key, '请到「设置 → 模型与推理」重新粘贴纯英文数字的 API Key')
  const { url, extraHeaders, local, targetBase } = await resolveStreamEndpoint(baseUrl, harnessMeta)
  if (!local && !key) {
    throw new HarborError('MISSING_API_KEY', '尚未填写 API Key，请点右上角「设置」填写模型 API Key')
  }

  const body = {
    model: String(model || 'glm-4.5-flash'),
    messages,
    stream: true,
    temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.7,
    top_p: Number.isFinite(Number(topP)) ? Number(topP) : 0.9,
    max_tokens: Number(maxTokens) > 0 ? Number(maxTokens) : 4096,
  }
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools
    body.tool_choice = 'auto'
  }
  const { bodyPatch } = buildReasoningRequestParams({
    baseUrl,
    model: body.model,
    tier: reasoningEffort || 'auto',
    customBudget: thinkingBudget,
    customEffort,
  })
  Object.assign(body, bodyPatch)

  const headers = assertLatin1Headers({
    'Content-Type': 'application/json',
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
    ...extraHeaders,
  })

  const LOADING_BACKOFF = local ? [2000, 4000, 8000, 15000] : [2000, 4000]
  let loadAttempt = 0
  let rateAttempt = 0
  let resp = null

  while (true) {
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify(body),
      })
    } catch (e) {
      if (isAbort(e)) throw new HarborError('USER_PAUSED', '已中止生成')
      throw new HarborError('NETWORK_ERROR', `模型请求失败（${url} → ${targetBase}）：${e && e.message || e}`, { retryable: true, cause: e })
    }

    if (local && resp.status === 503 && loadAttempt < LOADING_BACKOFF.length) {
      await sleepAbortable(LOADING_BACKOFF[loadAttempt++], signal)
      continue
    }
    if (resp.status === 429 && rateAttempt < 3) {
      const text429 = await resp.clone().text().catch(() => '')
      if (/余额|欠费|arrears|insufficient|quota|billing|充值/i.test(text429)) break
      const ra = Number(resp.headers.get('retry-after'))
      const waitMs = Number.isFinite(ra) && ra > 0
        ? Math.min(60000, ra * 1000) + Math.floor(Math.random() * 800)
        : 1200 + Math.floor(Math.random() * Math.min(20000, 1500 * (2 ** rateAttempt)))
      rateAttempt++
      await sleepAbortable(waitMs, signal)
      continue
    }
    break
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new HarborError(`HTTP_${resp.status}`, `模型返回 HTTP ${resp.status}：${errText.slice(0, 320)}`)
  }
  if (!resp.body || typeof resp.body.getReader !== 'function') {
    const data = await resp.json()
    const choice = data && data.choices && data.choices[0]
    const msg = (choice && choice.message) || {}
    return {
      content: String(msg.content || ''),
      reasoning: String(msg.reasoning_content || ''),
      toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
      usage: data && data.usage || null,
      finishReason: (choice && choice.finish_reason) || 'stop',
    }
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let content = ''
  let reasoning = ''
  let finishReason = 'stop'
  let usage = null
  const tcMap = new Map()
  let lastTick = Date.now()
  let windowChars = 0
  let cps = 0

  const sampleCps = (addedLen) => {
    windowChars += addedLen
    const now = Date.now()
    const dt = now - lastTick
    if (dt >= 180) {
      cps = Math.round((windowChars * 1000) / dt)
      windowChars = 0
      lastTick = now
    }
  }

  try {
    while (true) {
      if (signal && signal.aborted) throw new HarborError('USER_PAUSED', '已中止生成')
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let chunk = null
        try { chunk = JSON.parse(payload) } catch { continue }
        if (chunk.usage) usage = chunk.usage
        const choice = chunk.choices && chunk.choices[0]
        if (!choice) continue
        if (choice.finish_reason) finishReason = choice.finish_reason
        const delta = choice.delta || {}
        const rPart = delta.reasoning_content || delta.reasoning || ''
        const cPart = delta.content || ''
        if (rPart) {
          reasoning += rPart
          sampleCps(rPart.length)
        }
        if (cPart) {
          content += cPart
          sampleCps(cPart.length)
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = Number.isInteger(tc.index) ? tc.index : tcMap.size
            const cur = tcMap.get(idx) || { id: tc.id || `tc_${idx}`, type: 'function', function: { name: '', arguments: '' } }
            if (tc.id) cur.id = tc.id
            if (tc.function && tc.function.name) cur.function.name += tc.function.name
            if (tc.function && tc.function.arguments) cur.function.arguments += tc.function.arguments
            tcMap.set(idx, cur)
          }
        }
        if ((rPart || cPart) && typeof onDelta === 'function') {
          onDelta({ reasoning, content, cps, hasReasoning: reasoning.length > 0, hasContent: content.length > 0 })
        }
      }
    }
  } finally {
    try { reader.releaseLock() } catch {}
  }

  return {
    content,
    reasoning,
    toolCalls: [...tcMap.values()],
    usage,
    finishReason,
  }
}
