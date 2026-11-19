/**
 * 本地 CORS 代理回归测试（R61c / P0-4 真机缺口）。
 * 运行：node server/test/local-proxy.mjs
 *
 * 用临时 CONFIG_DIR + 本地桩上游，验证：懒启动 / 预检 CORS / 缺头与白名单
 * 拒绝 / POST 透传 / SSE 分块 / **base_url 路径前缀保留**（GLM 的
 * /api/paas/v4 若被丢掉会 404）/ 可信 Origin 回显。
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

// CONFIG_DIR 由 paths.js 在模块加载时读 env，必须先设置再动态 import
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-lp-'))
process.env.HARBOR_CONFIG_DIR = tmp

const { ensureLocalProxyRunning, shutdownLocalProxy, localProxyInfo } =
  await import('../src/services/local-proxy.js')

const stubPaths = []
const stubBodies = []
const stub = http.createServer((req, res) => {
  stubPaths.push(req.url)
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    stubBodies.push(body)
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    })
    res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n')
    setTimeout(() => {
      res.write('data: [DONE]\n\n')
      res.end()
    }, 20)
  })
})
await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve))
const stubPort = stub.address().port
const target = `http://127.0.0.1:${stubPort}/v1`
// 模拟用户在设置里保存的主端点键（R61e：save_config 实际写 provider_base_url，
// 旧代理只读 base_url/local_base_url 会把自定义端点全部误判为 403）
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ provider_base_url: target }))

// 并发首次启动必须单飞：三个调用拿到同一端口，不泄漏多余的监听器
const starts = await Promise.all([
  ensureLocalProxyRunning(), ensureLocalProxyRunning(), ensureLocalProxyRunning(),
])
const { port, base_url } = starts[0]
assert.ok(starts.every(x => x.port === port && x.base_url === base_url), '并发启动必须复用同一监听器')
assert.ok(port > 0 && base_url === `http://127.0.0.1:${port}`, '代理应在回环随机端口监听')
assert.equal(localProxyInfo().listening, true)

const baseHeaders = { Origin: 'harbor://app', 'Content-Type': 'application/json' }
const url = base_url + '/chat/completions'

// 1) 预检
const pre = await fetch(url, {
  method: 'OPTIONS',
  headers: {
    Origin: 'harbor://app',
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'x-harbor-target, authorization, content-type',
    'Access-Control-Request-Private-Network': 'true',
  },
})
assert.equal(pre.status, 204, '预检应返回 204')
assert.equal(pre.headers.get('access-control-allow-origin'), 'harbor://app')
assert.equal(pre.headers.get('access-control-allow-private-network'), 'true', 'PNA 预检必须放行')
assert.match(pre.headers.get('access-control-allow-headers') || '', /X-Harbor-Target/i)

// 2) 缺目标头
const noHeader = await fetch(url, { method: 'POST', headers: baseHeaders, body: '{}' })
assert.equal(noHeader.status, 400)
await noHeader.text()

// 3) 白名单外目标
const evil = await fetch(url, {
  method: 'POST',
  headers: { ...baseHeaders, 'X-Harbor-Target': 'http://evil.invalid/v1' },
  body: '{}',
})
assert.equal(evil.status, 403)
await evil.text()

// 4) 非白名单路径
const badPath = await fetch(base_url + '/etc/passwd', {
  method: 'POST',
  headers: { ...baseHeaders, 'X-Harbor-Target': target },
  body: '{}',
})
assert.equal(badPath.status, 403)
await badPath.text()

// 5) 合法转发：路径前缀必须保留
const payload = JSON.stringify({ model: 'stub', messages: [{ role: 'user', content: 'hi' }] })
const ok = await fetch(url, {
  method: 'POST',
  headers: { ...baseHeaders, 'X-Harbor-Target': target, Authorization: 'Bearer stub-key' },
  body: payload,
})
assert.equal(ok.status, 200)
assert.equal(ok.headers.get('access-control-allow-origin'), 'harbor://app')
const text = await ok.text()
assert.match(text, /data: .*hello/)
assert.match(text, /data: \[DONE\]/)
assert.equal(stubPaths[0], '/v1/chat/completions', 'base_url 路径前缀 /v1 必须保留')
assert.equal(JSON.parse(stubBodies[0]).model, 'stub', '请求体应原样透传')

// 6) 契约面：get_local_proxy 返回 ok:true 且与同一监听器端口一致
const provider = await import('../src/services/provider.js')
const apiInfo = JSON.parse(await provider.getLocalProxy())
assert.equal(apiInfo.ok, true, 'get_local_proxy 应报告代理可用')
assert.equal(apiInfo.base_url, base_url, '前端拿到的基址应与监听器同端口')
assert.equal(apiInfo.port, port)

shutdownLocalProxy()
await new Promise(resolve => stub.close(resolve))
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (e) { /* 临时目录清理失败不影响结论 */ }

console.log(JSON.stringify({
  ok: true,
  checks: ['listen', 'concurrent-single-flight', 'provider-base-url-allowlist', 'options-cors', 'missing-header-400', 'host-allowlist-403',
    'path-allowlist-403', 'post-relay', 'sse-chunks', 'base-path-prefix', 'body-passthrough'],
  upstreamPath: stubPaths[0],
  proxyPort: port,
}, null, 2))
console.log('LOCAL_PROXY_TEST: PASS')
