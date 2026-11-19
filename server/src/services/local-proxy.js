/**
 * 本地模型请求转发器（P0-4 真机缺口补齐）。
 *
 * 背景：Python 时代存在 LocalCorsProxy（127.0.0.1:0 懒启动单例），前端所有
 * chat/completions 请求先落到回环，再由后端进程转发到真实端点。Node 迁移只
 * 保留了 `get_local_proxy` 的 {ok,port,base_url} 响应形状，监听器从未实现 →
 * getLocalProxy() 恒 ok:false → 前端回落直连 → Chromium 读系统代理栈（Clash
 * 等）把请求拦成 "Failed to fetch"，聊天/群聊/生成式 UI 全部不可用。
 *
 * 为什么能绕开系统代理：浏览器只请求 127.0.0.1（回环），而真正的外网请求
 * 由 Node 的 fetch 发出——Node 默认不读 Windows 系统 HTTP 代理设置。
 *
 * 安全口径（受控转发，不是任意 URL 转发器）：
 *   1. 目标 host 必须命中静态官方端点白名单，或服务端 config.json 里已登记的
 *      base_url / local_base_url；回环目标还要求端口在已知本地端口集或配置里；
 *   2. 请求路径只允许白名单后缀（/chat/completions 等），最终 URL 由已验证
 *      URL 对象重建，保留 base_url 的路径前缀（如 /api/paas/v4）；
 *   3. 非回环目标解析到私网/保留地址一律拒绝（防 DNS 重绑定进内网）；
 *   4. CORS 只回显可信来源（harbor://app / null / 回环），绝不输出 ACAO:*；
 *   5. 请求体上限 32MB、转发超时 5 分钟、redirect:manual。
 */
import http from 'node:http'
import dns from 'node:dns'
import { Readable } from 'node:stream'
import { readConfigJson } from './jsonstore.js'

const TARGET_HEADER = 'x-harbor-target'
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
const KNOWN_LOCAL_PORTS = new Set([11434, 1234, 8000, 8080, 1919])
const CLOUD_HOSTS = new Set([
  'open.bigmodel.cn', 'bigmodel.cn', 'api.deepseek.com', 'api.moonshot.cn',
  'dashscope.aliyuncs.com', 'models.github.ai', 'api.openai.com', 'api.anthropic.com',
])
const ALLOWED_PATHS = new Set(['/chat/completions', '/models', '/v1/models', '/api/tags', '/completions'])
const TRUSTED_ORIGINS = new Set(['null', 'harbor://app', 'file://'])
const DYNAMIC_TTL_MS = 1000
const FORWARD_TIMEOUT_MS = 300000
const MAX_BODY = 32 * 1024 * 1024

const dynamicCache = { ts: 0, hosts: [], ports: [] }

function dynamicAllow() {
  const now = Date.now()
  if (now - dynamicCache.ts < DYNAMIC_TTL_MS) return dynamicCache
  const hosts = []
  const ports = []
  try {
    const cfg = readConfigJson('config.json', {})
    // R61e：前端 save_config 写的是 provider_base_url（主端点）、
    // local_base_url（本地端点）；旧实现只读 base_url/local_base_url，
    // 导致用户在设置里切换到自定义端点后，代理持续 403。
    for (const key of ['provider_base_url', 'local_base_url', 'base_url']) {
      try {
        const u = new URL(String(cfg[key] || '').trim())
        const host = (u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
        if (!host) continue
        if (!hosts.includes(host)) hosts.push(host)
        if (LOOPBACK_HOSTS.has(host) && u.port && !ports.includes(Number(u.port))) ports.push(Number(u.port))
      } catch (e) { /* 单键解析失败不阻塞其余 */ }
    }
  } catch (e) { /* 读不到配置不阻塞：静态白名单仍生效 */ }
  dynamicCache.ts = now
  dynamicCache.hosts = hosts
  dynamicCache.ports = ports
  return dynamicCache
}

function isPrivateOrReservedIp(ip) {
  if (String(ip).includes(':')) {
    const v6 = ip.toLowerCase()
    if (v6 === '::1' || v6 === '::') return true
    if (v6.startsWith('fe80:') || v6.startsWith('fc') || v6.startsWith('fd')) return true
    if (v6.startsWith('::ffff:')) return isPrivateOrReservedIp(v6.slice(7))
    return false
  }
  const parts = String(ip).split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) return true
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true
  return false
}

function corsOriginFor(req) {
  const origin = String(req.headers.origin || '')
  if (!origin || TRUSTED_ORIGINS.has(origin)) return origin || 'null'
  try {
    const u = new URL(origin)
    if (LOOPBACK_HOSTS.has((u.hostname || '').toLowerCase())) return origin
  } catch (e) { /* 非法来源不给 ACAO */ }
  return ''
}

function applyCors(req, res) {
  const origin = corsOriginFor(req)
  if (!origin) return
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Harbor-Target')
  res.setHeader('Access-Control-Max-Age', '600')
  // Chromium 私有网络访问（PNA）：harbor://app 安全源 → 127.0.0.1 回环目标，
  // 预检会带 Access-Control-Request-Private-Network，缺此响应头时 fetch 直接
  // 抛 TypeError（表现为 "Failed to fetch"），代理本身完全正常也用不了。
  if (String(req.headers['access-control-request-private-network'] || '').toLowerCase() === 'true') {
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
  }
}

function jsonError(req, res, status, message) {
  // 响应已开始（例如 SSE 流中途出错）时不能再追加 JSON，否则会把错误体
  // 混进已输出的事件流，客户端解析出错。直接结束响应即可。
  if (res.headersSent) {
    try { res.end() } catch (e) { /* 已断 */ }
    return
  }
  applyCors(req, res)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  try { res.end(JSON.stringify({ error: String(message) })) } catch (e) { /* 客户端早断 */ }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { code: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 只由已验证 target + 白名单路径重建上游 URL（保留 base_url 路径前缀）。 */
async function resolveUpstream(rawTarget, rawUrl) {
  if (!rawTarget) return { status: 400, error: '缺少 X-Harbor-Target 请求头（模型端点 base_url）' }
  let base
  try { base = new URL(String(rawTarget).trim()) } catch (e) {
    return { status: 403, error: 'X-Harbor-Target 目标 URL 无效' }
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    return { status: 403, error: 'X-Harbor-Target 仅支持 http/https 目标' }
  }
  const host = base.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const dyn = dynamicAllow()
  let allowed
  if (LOOPBACK_HOSTS.has(host)) {
    const port = Number(base.port || (base.protocol === 'https:' ? 443 : 80))
    allowed = KNOWN_LOCAL_PORTS.has(port) || dyn.ports.includes(port)
  } else {
    allowed = CLOUD_HOSTS.has(host) || dyn.hosts.includes(host)
  }
  if (!allowed) {
    return { status: 403, error: 'X-Harbor-Target 不是已登记的官方端点或本地模型端口' }
  }
  const reqPath = String(rawUrl || '/').split('?')[0]
  if (!ALLOWED_PATHS.has(reqPath)) {
    return { status: 403, error: '仅允许转发模型接口路径（' + [...ALLOWED_PATHS].join(' / ') + '）' }
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    // DNS 重绑定进内网防护：解析成功且命中私网/保留段一律拒绝；解析失败时
    // 交由 fetch 给出真实网络错误，避免代理自己先掐死可用连接。
    try {
      const list = await dns.promises.lookup(host, { all: true, verbatim: true })
      if (Array.isArray(list) && list.length && list.some(({ address }) => isPrivateOrReservedIp(address))) {
        return { status: 403, error: '目标域名解析到私网/保留地址，已拒绝转发' }
      }
    } catch (e) { /* 交由 fetch 报告真实错误 */ }
  }
  const basePath = base.pathname.replace(/\/+$/, '')
  const suffix = basePath.endsWith(reqPath) ? '' : reqPath
  return { url: new URL(base.origin + basePath + suffix) }
}

async function relay(req, res) {
  const target = String(req.headers[TARGET_HEADER] || '').trim()
  const resolved = await resolveUpstream(target, req.url)
  if (!resolved.url) return jsonError(req, res, resolved.status, resolved.error)

  const fwd = {}
  for (const h of ['content-type', 'authorization', 'accept']) {
    if (req.headers[h]) fwd[h] = req.headers[h]
  }
  let body
  try {
    body = await readBody(req)
  } catch (e) {
    return jsonError(req, res, e && e.code === 413 ? 413 : 400,
      e && e.code === 413 ? '请求体过大（上限 32MB）' : '请求体读取失败')
  }
  let upstream
  try {
    upstream = await fetch(resolved.url, {
      method: req.method,
      headers: fwd,
      body: req.method === 'GET' ? undefined : body,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      redirect: 'manual',
    })
  } catch (e) {
    return jsonError(req, res, 502, '模型端点转发失败: ' + ((e && e.message) || e))
  }
  applyCors(req, res)
  const headers = {}
  for (const h of ['content-type', 'cache-control']) {
    const v = upstream.headers.get(h)
    if (v) headers[h] = v
  }
  res.writeHead(upstream.status, headers)
  if (!upstream.body) { res.end(); return }
  const stream = Readable.fromWeb(upstream.body)
  stream.on('error', () => { try { res.end() } catch (e) { /* 已断 */ } })
  stream.pipe(res)
}

let _server = null
let _starting = null

function currentInfo() {
  const port = _server && _server.address() ? _server.address().port : 0
  return { port, base_url: port ? `http://127.0.0.1:${port}` : '' }
}

/** 懒启动单例；返回 {port, base_url}。get_local_proxy 的响应形状保持不变。 */
export async function ensureLocalProxyRunning() {
  if (_server && _server.listening) return currentInfo()
  // 单飞：bridgeDependentInit 的「晚到补偿」可能与正常路径并发调用，
  // 无单飞时两个调用各自 createServer、_server 被覆盖，先起的监听器泄漏。
  if (_starting) return _starting
  _starting = (async () => {
    const server = http.createServer((req, res) => {
      if (req.method === 'OPTIONS') {
        applyCors(req, res)
        res.writeHead(204, { 'Content-Length': '0' })
        res.end()
        return
      }
      if (req.method === 'POST' || req.method === 'GET') {
        relay(req, res).catch(e => jsonError(req, res, 502, '转发内部错误: ' + ((e && e.message) || e)))
        return
      }
      jsonError(req, res, 501, '仅支持 POST/GET/OPTIONS')
    })
    _server = server
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    return currentInfo()
  })()
  try {
    return await _starting
  } catch (e) {
    _server = null
    throw e
  } finally {
    _starting = null
  }
}

/** 停机（app onClose 链；幂等）。 */
export function shutdownLocalProxy() {
  const server = _server
  _server = null
  _starting = null
  if (server) {
    try { server.close() } catch (e) { /* 幂等 */ }
  }
}

/** 测试与诊断用：当前是否已监听。 */
export function localProxyInfo() {
  return { listening: !!(_server && _server.listening), ...currentInfo() }
}
