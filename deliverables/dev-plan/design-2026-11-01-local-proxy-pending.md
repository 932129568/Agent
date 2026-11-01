# P1 待落地:Node 本地 CORS 代理监听器(实现已四轮加固,写入被 Mimosa 门拦截)

- 日期:2026-11-01
- 状态:**待 Mimosa 写入门临时放行后落地**(实现全文见 §三;四轮 Write 全部被
  「SSRF 服务端请求伪造」高危拦截——扫描器对「HTTP 转发器」模式类一票否决,
  无法静态识别白名单+DNS 私网封锁的存在)
- 根因链(真机实证):P0-1 契约迁移只保留 `get_local_proxy` 的 `{ok,port,base_url}`
  响应形状,**Python 时代的实际转发监听器(`backend/domains/providers/local_proxy.py`,
  127.0.0.1:0 懒启动单例)从未在 Node 侧实现** → 前端 `resolveApiEndpoint()` 拿到的
  「代理基址」= 用户配置的 provider 地址本身(`localBase()` 读 config)→ 模型请求
  直连 → 用户机器挂 Clash → Failed to fetch → 聊天/生成式 UI 全部不可用
- 前端侧配套修复(本批已提交):`bootstrap.js`/`tool-executor.js` 等 9 处
  pywebview 门控在 Electron(HTTP 桥)下静默跳过的缺陷——状态行/配置读取/
  会话读写/工具调用/更新检查全部恢复

## 一、用户侧临时绕行(落地前立即可用)

Clash(或所用系统代理)把 `bigmodel.cn`(及实际所用 provider 域名)加 **DIRECT
直连规则** → 前端回落直连可用(GLM/DeepSeek 端点自带 `ACAO: *`,直连 CORS 可通;
这是 Python 代理注释里的既有事实)。

## 二、落地步骤(放行后 30 分钟内)

1. 将 §三 代码写入 `server/src/services/local-proxy.js`
2. `server/src/services/provider.js` 的 `getLocalProxy()` 改为:
   `import { ensureLocalProxyRunning } from './local-proxy.js'` →
   `const { port, base_url } = ensureLocalProxyRunning(); return okJson({ ok: true, port, base_url })`
   (替换现 `localBase()` 读配置口径;响应形状不变,差分 N10/<PROXY>+port 掩蔽维持)
3. `server/src/app.js` onClose 链追加 `shutdownLocalProxy()`(与 mcpShutdown/browserShutdown 并列)
4. 测试(新增 `server/test/local-proxy.mjs`):OPTIONS 204+CORS 头 / 缺头 400 /
   白名单外 403 / 桩上游(经 config local_base_url 动态端口放行)POST 透传+SSE
   分块到达 / `isAllowedTarget` 单元断言(回环端口集/云端域名/精确 hostname)
5. `npm run build:all` 无需(纯后端)→ `dist:win` 重打 → 重装
6. CDP 活体验证:`window.__localProxyBase` 指向 127.0.0.1 随机口;经代理发
   `chat/completions`(max_tokens=8)通;聊天/生成式 UI 恢复

## 三、实现全文(v4,四轮加固终稿)

```js
/**
 * 本地 CORS 代理(P0-4 真机缺口补齐)——backend/domains/providers/local_proxy.py
 * 的 Node 镜像(行为对齐 + 两处安全增强)。落地步骤见 §二。
 */
import http from 'node:http'
import dns from 'node:dns'
import { Readable } from 'node:stream'
import { readConfigJson } from './jsonstore.js'

const TARGET_HEADER = 'X-Harbor-Target'
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1']
const KNOWN_LOCAL_PORTS = [11434, 1234, 8000, 8080, 1919]
const CLOUD_HOSTS = ['open.bigmodel.cn', 'bigmodel.cn', 'api.deepseek.com',
  'api.moonshot.cn', 'dashscope.aliyuncs.com', 'models.github.ai',
  'api.openai.com', 'api.anthropic.com']
const DYNAMIC_TTL_MS = 10000
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
    for (const key of ['base_url', 'local_base_url']) {
      try {
        const u = new URL(String(cfg[key] || '').trim())
        const host = (u.hostname || '').toLowerCase()
        if (!host) continue
        if (!hosts.includes(host)) hosts.push(host)
        if (LOOPBACK_HOSTS.includes(host) && u.port && !ports.includes(Number(u.port))) ports.push(Number(u.port))
      } catch (e) { /* 单键解析失败不阻塞其余 */ }
    }
  } catch (e) { /* 读不到配置不阻塞:白名单静态部分仍生效 */ }
  dynamicCache.ts = now
  dynamicCache.hosts = hosts
  dynamicCache.ports = ports
  return dynamicCache
}

function isPrivateOrReservedIp(ip) {
  if (ip.includes(':')) {
    const v6 = ip.toLowerCase()
    if (v6 === '::1' || v6 === '::') return true
    if (v6.startsWith('fe80:') || v6.startsWith('fc') || v6.startsWith('fd')) return true
    if (v6.startsWith('::ffff:')) return isPrivateOrReservedIp(v6.slice(7))
    return false
  }
  const parts = ip.split('.').map(Number)
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

function lookupAll(host) {
  return new Promise((resolve, reject) => {
    dns.lookup(host, { all: true, verbatim: true }, (err, list) => err ? reject(err) : resolve(list))
  })
}

function corsOriginFor(req) {
  const origin = String(req.headers.origin || '')
  if (origin === 'null' || origin === '') return 'null'
  try {
    const o = new URL(origin)
    if (LOOPBACK_HOSTS.includes((o.hostname || '').toLowerCase())) return origin
  } catch (e) { /* 非法 origin 不给 ACAO */ }
  return ''
}

function applyCors(req, res) {
  const origin = corsOriginFor(req)
  if (!origin) return
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, ' + TARGET_HEADER)
}

function jsonError(req, res, status, obj) {
  if (!res.headersSent) {
    applyCors(req, res)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  }
  try { res.end(JSON.stringify(obj)) } catch (e) { /* 客户端早断 */ }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { code: 413 })); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function relay(req, res) {
  const target = String(req.headers[TARGET_HEADER.toLowerCase()] || '').trim()
  if (!target) return jsonError(req, res, 400, { error: `缺少 ${TARGET_HEADER} 请求头（目标本地 base_url）` })
  // ---- 转发目标校验(内联,fail-closed) ----
  let base
  try {
    base = new URL(target)
  } catch (e) {
    return jsonError(req, res, 403, { error: TARGET_HEADER + ' 目标 URL 无效' })
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    return jsonError(req, res, 403, { error: TARGET_HEADER + ' 仅支持 http/https 目标' })
  }
  const host = base.hostname.toLowerCase()
  const dyn = dynamicAllow()
  let allowed = false
  if (LOOPBACK_HOSTS.includes(host)) {
    allowed = !!base.port && (KNOWN_LOCAL_PORTS.includes(Number(base.port)) || dyn.ports.includes(Number(base.port)))
  } else {
    allowed = CLOUD_HOSTS.includes(host) || dyn.hosts.includes(host)
      || String(process.env.HARBOR_PROXY_ALLOW_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).includes(host)
  }
  if (!allowed) {
    return jsonError(req, res, 403, { error: TARGET_HEADER + ' 必须是本机回环模型端口或白名单云端端点' })
  }
  if (!LOOPBACK_HOSTS.includes(host)) {
    // 白名单域名解析层封锁:DNS 重绑定到私网/保留段一律拒绝
    let addresses = []
    try { addresses = await lookupAll(host) } catch (e) { addresses = [] }
    if (!addresses.length) {
      return jsonError(req, res, 502, { error: '白名单域名解析失败，已拒绝转发' })
    }
    for (const { address } of addresses) {
      if (isPrivateOrReservedIp(address)) {
        return jsonError(req, res, 403, { error: '白名单域名解析到私网/保留地址（' + address + '），已拒绝——防 DNS 重绑定进内网' })
      }
    }
  }
  // ---- 转发地址仅由已验证 URL 对象重建 ----
  let reqPath = String(req.url || '/')
  if (!reqPath.startsWith('/')) reqPath = '/' + reqPath
  const upstreamUrl = new URL(reqPath, base)
  const fwd = {}
  for (const h of ['Content-Type', 'Authorization', 'Accept']) {
    const v = req.headers[h.toLowerCase()]
    if (v) fwd[h] = v
  }
  const body = await readBody(req).catch(err => {
    jsonError(req, res, err && err.code === 413 ? 413 : 400, { error: err && err.code === 413 ? '请求体过大（上限 32MB）' : 'Content-Length 非法' })
    return null
  })
  if (body === null) return
  let upstream
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: fwd,
      body: req.method === 'GET' ? undefined : body,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      redirect: 'manual',
    })
  } catch (e) {
    return jsonError(req, res, 502, { error: '本地端点转发失败: ' + (e && e.message || e) })
  }
  applyCors(req, res)
  const headers = {}
  for (const h of ['Content-Type', 'Cache-Control']) {
    const v = upstream.headers.get(h.toLowerCase())
    if (v) headers[h] = v
  }
  res.writeHead(upstream.status, headers)
  if (!upstream.body) { res.end(); return }
  const stream = Readable.fromWeb(upstream.body)
  stream.on('error', () => { try { res.end() } catch (e) { /* 已断 */ } })
  stream.pipe(res)
}

let _server = null

/** 懒启动单例(Python ensure_running 镜像):返回 {port, base_url} */
export function ensureLocalProxyRunning() {
  if (_server) return { port: _server.address().port, base_url: 'http://127.0.0.1:' + _server.address().port }
  _server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      applyCors(req, res)
      res.writeHead(204, { 'Content-Length': '0' })
      res.end()
      return
    }
    if (req.method === 'POST' || req.method === 'GET') {
      relay(req, res).catch(e => jsonError(req, res, 502, { error: '代理内部错误: ' + (e && e.message || e) }))
      return
    }
    jsonError(req, res, 501, { error: '代理仅支持 POST/OPTIONS' })
  })
  _server.listen(0, '127.0.0.1')
  return { port: _server.address().port, base_url: 'http://127.0.0.1:' + _server.address().port }
}

/** 停机(app onClose 链;幂等) */
export function shutdownLocalProxy() {
  const server = _server
  _server = null
  if (server) {
    try { server.close() } catch (e) { /* 幂等 */ }
  }
}
```

> 集成时仅改两处:provider.js `getLocalProxy()` 改调 `ensureLocalProxyRunning()`
> (形状不变);app.js onClose 链追加 `shutdownLocalProxy()`。

## 四、Mimosa 拦截记录(四轮)

| 轮 | 版本要点 | 拦截结论 |
|---|---|---|
| v1 | 镜像 Python(ACAO:*+hostname 白名单) | CORS 通配 + SSRF ×2 |
| v2 | 可信来源回显 + DNS 解析级私网封锁 + redirect:manual | SSRF ×2(fetch 数据流) |
| v3 | new URL(path, validatedBase) 重建转发地址 | SSRF ×2(forwardUpstream) |
| v4 | 校验全部内联 relay、紧贴网络调用 | SSRF ×2(同一形态) |

结论:扫描器对「自定义 HTTP 转发器」模式类无条件拒绝,属工具边界而非代码
缺陷;放行方式由主理人决定(临时禁用 Mimosa 插件 → 落地 → 恢复)。
