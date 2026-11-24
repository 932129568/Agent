/**
 * 统一多模态图片 / 视频生成兼容引擎（R19）：
 *
 * 多厂商协议自动兼容矩阵：
 *   - 智谱 GLM（bigmodel.cn / cogview-* / cogvideox-*）：
 *       * 图片：POST /images/generations（支持 size / quality / prompt）
 *       * 视频：POST /videos/generations（异步返回 id）→ 轮询 GET /async-result/{id}
 *   - OpenAI / 聚合网关（gpt-image-1 / dall-e-3 / sora-2 / flux / midjourney-proxy）：
 *       * 图片：POST /images/generations（兼容 url 与 b64_json）
 *       * 视频：POST /videos/generations → 兼容同步直出与异步任务轮询（/videos/{id} 或 /tasks/{id}）
 *   - SiliconFlow / 硅基流动（FLUX.1 / Kolors / Wan2.1）：POST /images/generations & /videos/generations
 *   - MiniMax（image-01 / video-01）：POST /images/generations & /video_generation
 *   - 本地网关（ComfyUI / SD-WebUI OpenAI Wrapper / Ollama 扩展）：经本地代理转发零 CORS 阻断
 *
 * 安全与体验保障：
 *   - 统一经 assertLatin1Headers() 校验 Key，自动经本地代理转发；
 *   - 支持 AbortSignal 随时取消异步视频轮询；
 *   - 离线/演示模式（dryRun 或未填云端 Key 且允许预览）可生成高质感 SVG/HTML5 概念分镜预览卡，绝不静默报错。
 */
import { HarborError, isAbort } from './errors.js'
import { assertLatin1Headers, assertLatin1Value } from './headers.js'
import { getLocalProxy } from './bridge.js'

export const MEDIA_PROVIDER_PRESETS = Object.freeze([
  {
    id: 'glm',
    name: '智谱 BigModel (CogView-4 / CogVideoX-3)',
    imageBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    imageModel: 'cogview-4-250304',
    videoBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    videoModel: 'cogvideox-3',
  },
  {
    id: 'openai',
    name: 'OpenAI (GPT-Image-1 / Sora-2)',
    imageBaseUrl: 'https://api.openai.com/v1',
    imageModel: 'gpt-image-1',
    videoBaseUrl: 'https://api.openai.com/v1',
    videoModel: 'sora-2',
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow (FLUX.1 / Wan2.1)',
    imageBaseUrl: 'https://api.siliconflow.cn/v1',
    imageModel: 'black-forest-labs/FLUX.1-schnell',
    videoBaseUrl: 'https://api.siliconflow.cn/v1',
    videoModel: 'Wan-AI/Wan2.1-T2V-14B',
  },
  {
    id: 'minimax',
    name: 'MiniMax 海螺 (image-01 / video-01)',
    imageBaseUrl: 'https://api.minimaxi.com/v1',
    imageModel: 'image-01',
    videoBaseUrl: 'https://api.minimaxi.com/v1',
    videoModel: 'video-01',
  },
])

export const IMAGE_ASPECT_SIZES = Object.freeze({
  '1:1': '1024x1024',
  '16:9': '1344x768',
  '9:16': '768x1344',
  '4:3': '1152x864',
  '3:4': '864x1152',
  '21:9': '1536x640',
})

const sleepAbortable = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) return reject(new HarborError('USER_PAUSED', '已中止生成'))
  const t = setTimeout(() => { cleanup(); resolve() }, ms)
  const onAbort = () => { clearTimeout(t); cleanup(); reject(new HarborError('USER_PAUSED', '已中止生成')) }
  const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort) }
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
})

function isLocalUrl(url) {
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(String(url || ''))
}

export function detectMediaProvider(baseUrl = '', model = '') {
  const u = String(baseUrl || '').toLowerCase()
  const m = String(model || '').toLowerCase()
  if (u.includes('bigmodel.cn') || m.includes('cogview') || m.includes('cogvideo')) return 'glm'
  if (u.includes('siliconflow.cn') || m.includes('flux') || m.includes('kolors') || m.includes('wan-ai')) return 'siliconflow'
  if (u.includes('minimax') || m.startsWith('video-01') || m.startsWith('image-01')) return 'minimax'
  if (u.includes('dashscope.aliyuncs.com') || m.includes('wanx')) return 'dashscope'
  if (isLocalUrl(u)) return 'local'
  return 'openai'
}

export function resolveImageSize(size = '', aspectRatio = '1:1') {
  const cleanSize = String(size || '').trim()
  if (/^\d{3,4}x\d{3,4}$/i.test(cleanSize)) return cleanSize.toLowerCase()
  const ratio = String(aspectRatio || '1:1').trim()
  return IMAGE_ASPECT_SIZES[ratio] || '1024x1024'
}

/** 根据目标厂商构造高兼容的图片生成请求路径与载荷。 */
export function normalizeImageRequest({
  prompt = '',
  model = '',
  size = '',
  aspectRatio = '1:1',
  quality = 'standard',
  style = '',
  n = 1,
  baseUrl = '',
} = {}) {
  const provider = detectMediaProvider(baseUrl, model)
  const finalSize = resolveImageSize(size, aspectRatio)
  const count = Math.max(1, Math.min(4, Math.round(Number(n) || 1)))
  const cleanPrompt = [String(prompt || '').trim(), style ? `Style: ${String(style).trim()}` : ''].filter(Boolean).join('. ')
  const defaultModel = {
    glm: 'cogview-4-250304',
    siliconflow: 'black-forest-labs/FLUX.1-schnell',
    minimax: 'image-01',
    dashscope: 'wanx2.1-t2i-turbo',
    local: 'flux-schnell',
    openai: 'gpt-image-1',
  }[provider] || 'gpt-image-1'

  const finalModel = String(model || '').trim() || defaultModel
  const body = {
    model: finalModel,
    prompt: cleanPrompt,
    size: finalSize,
    n: count,
  }
  if (provider === 'glm') {
    body.quality = quality === 'hd' ? 'hd' : 'standard'
  } else if (provider === 'siliconflow') {
    body.image_size = finalSize
    body.batch_size = count
  } else if (provider === 'openai') {
    if (quality === 'hd' || quality === 'high') body.quality = finalModel.includes('gpt-image') ? 'high' : 'hd'
  }
  return { provider, path: '/images/generations', model: finalModel, size: finalSize, body }
}

/** 根据目标厂商构造高兼容的视频生成请求路径、轮询模板与载荷（支持文生视频 + 图生视频 I2V）。 */
export function normalizeVideoRequest({
  prompt = '',
  model = '',
  duration = 5,
  aspectRatio = '16:9',
  resolution = '1080p',
  fps = 24,
  imageUrl = '',
  withAudio = false,
  baseUrl = '',
} = {}) {
  const provider = detectMediaProvider(baseUrl, model)
  const defaultModel = {
    glm: 'cogvideox-3',
    siliconflow: 'Wan-AI/Wan2.1-T2V-14B',
    minimax: 'video-01',
    dashscope: 'wan2.1-t2v-turbo',
    local: 'cogvideox',
    openai: 'sora-2',
  }[provider] || 'cogvideox-3'

  const finalModel = String(model || '').trim() || defaultModel
  const dur = Math.max(3, Math.min(15, Math.round(Number(duration) || 5)))
  const cleanRatio = String(aspectRatio || '16:9').trim()
  const cleanImage = String(imageUrl || '').trim()

  const body = {
    model: finalModel,
    prompt: String(prompt || '').trim(),
  }
  if (provider === 'glm') {
    body.quality = resolution === '4k' || resolution === '1080p' ? 'quality' : 'speed'
    body.with_audio = !!withAudio
    body.size = cleanRatio === '9:16' ? '1080x1920' : (cleanRatio === '1:1' ? '1024x1024' : '1920x1080')
    body.fps = Number(fps) === 60 ? 60 : 30
    body.duration = dur >= 8 ? 10 : 5
    if (cleanImage) body.image_url = cleanImage
    return {
      provider,
      path: '/videos/generations',
      pollPathForId: (id) => `/async-result/${encodeURIComponent(id)}`,
      model: finalModel,
      body,
    }
  }
  if (provider === 'minimax') {
    body.prompt_optimizer = true
    if (cleanImage) body.first_frame_image = cleanImage
    return {
      provider,
      path: '/video_generation',
      pollPathForId: (id) => `/query/video_generation?task_id=${encodeURIComponent(id)}`,
      model: finalModel,
      body,
    }
  }
  // OpenAI / SiliconFlow / 通用兼容网关
  body.duration = dur
  body.aspect_ratio = cleanRatio
  body.resolution = resolution || '1080p'
  if (cleanImage) body.image_url = cleanImage
  return {
    provider,
    path: '/videos/generations',
    pollPathForId: (id) => `/videos/${encodeURIComponent(id)}`,
    model: finalModel,
    body,
  }
}

/** 统一解析各厂商图片生成响应（兼容 OpenAI data[].url / b64_json、SiliconFlow images[]、DashScope results[]）。 */
export function extractImageResults(payload) {
  if (!payload || typeof payload !== 'object') return []
  const rawList = Array.isArray(payload.data)
    ? payload.data
    : (Array.isArray(payload.images)
      ? payload.images
      : (payload.output && Array.isArray(payload.output.results) ? payload.output.results : []))

  const out = []
  for (let i = 0; i < rawList.length; i++) {
    const item = rawList[i]
    if (!item) continue
    if (typeof item === 'string') {
      out.push({ url: item, revisedPrompt: '', index: i })
      continue
    }
    const url = String(item.url || item.image_url || '').trim()
    const b64 = String(item.b64_json || item.base64 || '').trim()
    const src = url || (b64 ? (b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`) : '')
    if (!src) continue
    out.push({
      url: src,
      isDataUrl: src.startsWith('data:'),
      revisedPrompt: String(item.revised_prompt || '').trim(),
      index: i,
    })
  }
  return out
}

/** 统一解析各厂商视频生成/轮询响应，归一化状态为 done / pending / failed。 */
export function extractVideoResults(payload) {
  if (!payload || typeof payload !== 'object') return { status: 'failed', taskId: '', items: [], error: '空响应' }
  const rawStatus = String(
    payload.task_status || payload.status || (payload.output && payload.output.task_status) || ''
  ).toUpperCase()
  const taskId = String(payload.id || payload.task_id || (payload.output && payload.output.task_id) || '').trim()

  const candidates = []
  if (Array.isArray(payload.video_result)) {
    for (const v of payload.video_result) {
      if (v && v.url) candidates.push({ url: v.url, coverUrl: v.cover_image_url || '' })
    }
  }
  if (Array.isArray(payload.data)) {
    for (const v of payload.data) {
      if (v && (v.url || v.video_url)) candidates.push({ url: v.url || v.video_url, coverUrl: v.cover_image_url || v.thumbnail_url || '' })
    }
  }
  if (payload.video_url || (payload.output && payload.output.video_url)) {
    candidates.push({ url: payload.video_url || payload.output.video_url, coverUrl: payload.cover_image_url || '' })
  }

  if (candidates.length > 0) {
    return { status: 'done', taskId, items: candidates, error: '' }
  }
  if (/FAIL|ERROR|CANCEL/.test(rawStatus)) {
    const errMsg = String((payload.error && (payload.error.message || payload.error)) || payload.message || '视频生成任务失败')
    return { status: 'failed', taskId, items: [], error: errMsg }
  }
  if (taskId || /PROCESS|PEND|QUEUE|RUN|SUBMIT|PREPAR/.test(rawStatus)) {
    return { status: 'pending', taskId, items: [], error: '' }
  }
  return { status: 'failed', taskId, items: [], error: '未解析到视频地址或异步任务 ID' }
}

async function resolveMediaProxyUrl(baseUrl, reqPath) {
  const cleanBase = String(baseUrl || '').trim().replace(/\/+$/, '')
  assertLatin1Value('媒体端点 Base URL', cleanBase)
  try {
    const proxy = await getLocalProxy()
    if (proxy && proxy.ok !== false && proxy.base_url) {
      return {
        url: `${String(proxy.base_url).replace(/\/+$/, '')}${reqPath}`,
        extraHeaders: { 'X-Harbor-Target': cleanBase },
      }
    }
  } catch {}
  return { url: `${cleanBase}${reqPath}`, extraHeaders: {} }
}

/** 构造离线/演示态概念矢量图（SVG Data URL），便于无外部 Key 时完整演练视觉与视频流水线。 */
export function buildConceptSvgDataUrl({ title = 'Harbor Concept', prompt = '', aspectRatio = '16:9', kind = 'image' } = {}) {
  const dims = aspectRatio === '9:16' ? [720, 1280] : (aspectRatio === '1:1' ? [960, 960] : [1280, 720])
  const [w, h] = dims
  const safeTitle = String(title || 'Harbor Visual').replace(/[<>&"]/g, '').slice(0, 42)
  const safePrompt = String(prompt || '').replace(/[<>&"]/g, '').slice(0, 96)
  const badge = kind === 'video' ? 'AI VIDEO STORYBOARD FRAME' : 'AI VISUAL CONCEPT'
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`,
    '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">',
    '<stop offset="0%" stop-color="#141826"/><stop offset="52%" stop-color="#1f2942"/><stop offset="100%" stop-color="#3a2328"/>',
    '</linearGradient><radialGradient id="orb" cx="68%" cy="32%" r="48%">',
    '<stop offset="0%" stop-color="#38bdf8" stop-opacity="0.55"/><stop offset="60%" stop-color="#d4653e" stop-opacity="0.22"/><stop offset="100%" stop-color="#000" stop-opacity="0"/>',
    '</radialGradient></defs>',
    `<rect width="${w}" height="${h}" fill="url(#bg)"/>`,
    `<rect width="${w}" height="${h}" fill="url(#orb)"/>`,
    `<rect x="44" y="44" width="${w - 88}" height="${h - 88}" rx="28" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.2)" stroke-width="2"/>`,
    `<text x="84" y="114" fill="#62bef7" font-size="22" font-family="Segoe UI,PingFang SC,sans-serif" font-weight="700" letter-spacing="2">${badge}</text>`,
    `<text x="84" y="${Math.round(h * 0.48)}" fill="#faf9f5" font-size="44" font-family="Segoe UI,PingFang SC,sans-serif" font-weight="700">${safeTitle}</text>`,
    `<text x="84" y="${Math.round(h * 0.58)}" fill="#d4d1c8" font-size="24" font-family="Segoe UI,PingFang SC,sans-serif">${safePrompt}</text>`,
    `<text x="84" y="${h - 76}" fill="#a5a299" font-size="18" font-family="Consolas,monospace">Harbor Media Engine · ${aspectRatio} (${w}x${h})</text>`,
    '</svg>',
  ].join('')
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** 构造可供 ArtifactCanvas 实时展示的互动图片画廊 / 视频放映厅 HTML 产物。 */
export function buildMediaGalleryArtifact({
  kind = 'image',
  title = 'AI 媒体生成结果',
  prompt = '',
  model = '',
  provider = '',
  items = [],
  aspectRatio = '16:9',
  simulated = false,
} = {}) {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const safeTitle = esc(title)
  const safePrompt = esc(prompt)
  const cards = (Array.isArray(items) ? items : []).map((it, idx) => {
    const url = esc(it.url || '')
    const cover = esc(it.coverUrl || '')
    if (kind === 'video') {
      const isActualVideo = url && !url.startsWith('data:image/')
      return isActualVideo
        ? `<div class="media-card"><video controls playsinline preload="metadata" ${cover ? `poster="${cover}"` : ''} src="${url}"></video><div class="cap">镜头 #${idx + 1} · ${esc(model || provider)}</div></div>`
        : `<div class="media-card"><img src="${url}" alt="${safeTitle}" /><div class="cap">分镜关键帧 #${idx + 1}（演练预览 · 配置视频模型 Key 后直出 MP4）</div></div>`
    }
    return `<div class="media-card"><img src="${url}" alt="${safeTitle} #${idx + 1}" /><div class="cap">成图 #${idx + 1}${it.revisedPrompt ? ` · ${esc(it.revisedPrompt.slice(0, 80))}` : ''}</div></div>`
  }).join('\n')

  const code = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${safeTitle}</title>`,
    '<style>',
    'body{margin:0;padding:20px;font-family:"Segoe UI","PingFang SC",system-ui,sans-serif;background:#131620;color:#f5f4ef;}',
    '.head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap;}',
    '.badge{font-size:11px;padding:3px 10px;border-radius:999px;background:rgba(212,101,62,.2);border:1px solid rgba(212,101,62,.5);color:#f3a384;font-family:monospace;}',
    '.prompt{font-size:12.5px;color:#c7c5bd;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:10px 12px;margin-bottom:16px;line-height:1.55;}',
    '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;}',
    '.media-card{border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);}',
    '.media-card img,.media-card video{width:100%;display:block;max-height:460px;object-fit:contain;background:#0b0d14;}',
    '.cap{padding:9px 12px;font-size:11.5px;color:#b8b6ae;border-top:1px solid rgba(255,255,255,.08);}',
    '</style></head><body>',
    `<div class="head"><h2 style="margin:0;font-size:17px;">${kind === 'video' ? '🎬' : '🎨'} ${safeTitle}</h2><span class="badge">${esc(provider || 'media')} · ${esc(model || 'auto')} · ${esc(aspectRatio)}${simulated ? ' · 预览模式' : ''}</span></div>`,
    `<div class="prompt"><strong>提示词：</strong>${safePrompt}</div>`,
    `<div class="grid">${cards || '<div class="prompt">暂无媒体产物</div>'}</div>`,
    '</body></html>',
  ].join('\n')

  return {
    id: `media_${kind}_${Date.now().toString(36)}`,
    kind: 'html',
    mediaKind: kind,
    lang: 'html',
    title: `${kind === 'video' ? '🎬 ' : '🎨 '}${title}`,
    filename: `${String(title || kind).replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 28) || kind}-preview.html`,
    code,
    items,
  }
}

/** 统一图片生成执行器（支持真实云端/本地生图接口，未配 Key 时优雅给出可执行指引或概念预览）。 */
export async function generateImageMedia({
  prompt,
  model = '',
  size = '',
  aspectRatio = '1:1',
  quality = 'standard',
  style = '',
  n = 1,
  endpointConfig = {},
  dryRun = false,
  signal = null,
} = {}) {
  const cleanPrompt = String(prompt || '').trim()
  if (!cleanPrompt) throw new HarborError('MISSING_PROMPT', '图片生成提示词不能为空')

  const baseUrl = endpointConfig.imageBaseUrl || endpointConfig.baseUrl || ''
  const apiKey = String(endpointConfig.imageApiKey ?? endpointConfig.apiKey ?? '').trim()
  const req = normalizeImageRequest({
    prompt: cleanPrompt,
    model: model || endpointConfig.imageModel || '',
    size,
    aspectRatio,
    quality,
    style,
    n,
    baseUrl,
  })

  if (dryRun || (!baseUrl) || (!isLocalUrl(baseUrl) && !apiKey)) {
    const svgUrl = buildConceptSvgDataUrl({ title: 'AI 视觉概念预览', prompt: cleanPrompt, aspectRatio, kind: 'image' })
    const items = [{ url: svgUrl, isDataUrl: true, revisedPrompt: '当前未配置图片生成 API Key，已生成概念预览卡；前往「设置 → 图片与视频生成」填写端点即可直出高清实图。', index: 0 }]
    return {
      ok: true,
      simulated: true,
      provider: req.provider,
      model: req.model,
      size: req.size,
      aspectRatio,
      items,
      artifact: buildMediaGalleryArtifact({ kind: 'image', title: cleanPrompt.slice(0, 22), prompt: cleanPrompt, model: req.model, provider: req.provider, items, aspectRatio, simulated: true }),
    }
  }

  assertLatin1Value('图片生成 API Key', apiKey)
  const { url, extraHeaders } = await resolveMediaProxyUrl(baseUrl, req.path)
  const headers = assertLatin1Headers({
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...extraHeaders,
  })

  let resp
  try {
    resp = await fetch(url, { method: 'POST', headers, signal, body: JSON.stringify(req.body) })
  } catch (e) {
    if (isAbort(e)) throw new HarborError('USER_PAUSED', '已中止图片生成')
    throw new HarborError('IMAGE_NETWORK_ERROR', `图片生成请求失败：${e && e.message || e}`)
  }

  const rawText = await resp.text().catch(() => '')
  if (!resp.ok) {
    throw new HarborError(`HTTP_${resp.status}`, `图片生成接口返回 HTTP ${resp.status}：${rawText.slice(0, 260)}`)
  }
  let parsed = null
  try { parsed = JSON.parse(rawText) } catch { parsed = null }
  const items = extractImageResults(parsed)
  if (!items.length) {
    throw new HarborError('EMPTY_IMAGE_RESULT', `图片生成成功但未解析到图片地址：${rawText.slice(0, 200)}`)
  }
  return {
    ok: true,
    simulated: false,
    provider: req.provider,
    model: req.model,
    size: req.size,
    aspectRatio,
    items,
    artifact: buildMediaGalleryArtifact({ kind: 'image', title: cleanPrompt.slice(0, 22), prompt: cleanPrompt, model: req.model, provider: req.provider, items, aspectRatio, simulated: false }),
  }
}

/** 统一视频生成执行器（支持同步直出与异步提交+自动轮询，兼容文生视频与图生视频 I2V）。 */
export async function generateVideoMedia({
  prompt,
  model = '',
  duration = 5,
  aspectRatio = '16:9',
  resolution = '1080p',
  fps = 24,
  imageUrl = '',
  withAudio = false,
  endpointConfig = {},
  pollIntervalMs = 2500,
  maxPollAttempts = 40,
  dryRun = false,
  signal = null,
  onProgress = null,
} = {}) {
  const cleanPrompt = String(prompt || '').trim()
  if (!cleanPrompt) throw new HarborError('MISSING_PROMPT', '视频生成提示词不能为空')

  const baseUrl = endpointConfig.videoBaseUrl || endpointConfig.baseUrl || ''
  const apiKey = String(endpointConfig.videoApiKey ?? endpointConfig.apiKey ?? '').trim()
  const req = normalizeVideoRequest({
    prompt: cleanPrompt,
    model: model || endpointConfig.videoModel || '',
    duration,
    aspectRatio,
    resolution,
    fps,
    imageUrl,
    withAudio,
    baseUrl,
  })

  if (dryRun || (!baseUrl) || (!isLocalUrl(baseUrl) && !apiKey)) {
    const frameUrl = String(imageUrl || '').trim() || buildConceptSvgDataUrl({ title: 'AI 视频分镜预览', prompt: cleanPrompt, aspectRatio, kind: 'video' })
    const items = [{ url: frameUrl, coverUrl: frameUrl }]
    return {
      ok: true,
      simulated: true,
      provider: req.provider,
      model: req.model,
      duration,
      aspectRatio,
      items,
      artifact: buildMediaGalleryArtifact({ kind: 'video', title: cleanPrompt.slice(0, 22), prompt: cleanPrompt, model: req.model, provider: req.provider, items, aspectRatio, simulated: true }),
    }
  }

  assertLatin1Value('视频生成 API Key', apiKey)
  const { url, extraHeaders } = await resolveMediaProxyUrl(baseUrl, req.path)
  const headers = assertLatin1Headers({
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...extraHeaders,
  })

  if (typeof onProgress === 'function') onProgress({ phase: 'submitting', message: `正在向 ${req.provider} (${req.model}) 提交视频渲染任务…` })
  let resp
  try {
    resp = await fetch(url, { method: 'POST', headers, signal, body: JSON.stringify(req.body) })
  } catch (e) {
    if (isAbort(e)) throw new HarborError('USER_PAUSED', '已中止视频生成')
    throw new HarborError('VIDEO_NETWORK_ERROR', `视频生成提交失败：${e && e.message || e}`)
  }

  const rawText = await resp.text().catch(() => '')
  if (!resp.ok) {
    throw new HarborError(`HTTP_${resp.status}`, `视频生成接口返回 HTTP ${resp.status}：${rawText.slice(0, 260)}`)
  }
  let parsed = null
  try { parsed = JSON.parse(rawText) } catch { parsed = null }
  let res = extractVideoResults(parsed)

  // 异步视频渲染自动轮询（GLM / OpenAI Sora / MiniMax 统一闭环）
  let attempt = 0
  while (res.status === 'pending' && res.taskId && attempt < maxPollAttempts) {
    attempt++
    if (typeof onProgress === 'function') {
      onProgress({ phase: 'polling', attempt, taskId: res.taskId, message: `视频云端渲染中（任务 ${res.taskId.slice(0, 12)} · 第 ${attempt} 次轮询）…` })
    }
    await sleepAbortable(pollIntervalMs, signal)
    const pollPath = req.pollPathForId(res.taskId)
    const pollTarget = await resolveMediaProxyUrl(baseUrl, pollPath)
    const pollHeaders = assertLatin1Headers({
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...pollTarget.extraHeaders,
    })
    const pResp = await fetch(pollTarget.url, { method: 'GET', headers: pollHeaders, signal })
    const pText = await pResp.text().catch(() => '')
    if (!pResp.ok) throw new HarborError(`HTTP_${pResp.status}`, `轮询视频状态失败 HTTP ${pResp.status}：${pText.slice(0, 220)}`)
    let pJson = null
    try { pJson = JSON.parse(pText) } catch { pJson = null }
    res = extractVideoResults(pJson)
  }

  if (res.status !== 'done' || !res.items.length) {
    throw new HarborError('VIDEO_GEN_FAILED', res.error || '视频渲染超时或未返回播放地址')
  }

  return {
    ok: true,
    simulated: false,
    provider: req.provider,
    model: req.model,
    taskId: res.taskId,
    duration,
    aspectRatio,
    items: res.items,
    artifact: buildMediaGalleryArtifact({ kind: 'video', title: cleanPrompt.slice(0, 22), prompt: cleanPrompt, model: req.model, provider: req.provider, items: res.items, aspectRatio, simulated: false }),
  }
}
