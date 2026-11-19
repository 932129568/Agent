/** 本地模型与 provider HTTP 契约：全部使用本机模拟端点，不访问外网。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-provider-'))
process.env.HARBOR_CONFIG_DIR = path.join(tmp, 'config')
process.env.DATABASE_URL = `file:${path.join(tmp, 'app.db')}`
process.env.LOG_LEVEL = 'silent'
const provider = await import('../src/services/provider.js')
const seen = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    seen.push({ url: req.url, method: req.method, auth: req.headers.authorization || '', body })
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'qwen3.5-9b' }] })); return }
    if (req.url === '/v1/chat/completions') {
      res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] })); return
    }
    if (req.url === '/loading/chat/completions') { res.statusCode = 503; res.end(JSON.stringify({ error: { message: 'model is loading' } })); return }
    res.statusCode = 404; res.end('{}')
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/v1`
const results = []
const check = (name, fn) => { fn(); results.push(name) }
try {
  const models = JSON.parse(await provider.localModels(base, 'secret-test'))
  check('local_models 鉴权拉取并补充模型元数据', () => {
    assert.equal(models.ok, true)
    assert.equal(models.models[0].id, 'qwen3.5-9b')
    assert.equal(models.models[0].ctx_window, 262144)
    assert.equal(models.models[0].tool_capable, true)
    assert.ok(seen.some(x => x.url === '/v1/models' && x.auth === 'Bearer secret-test'))
  })
  const ready = JSON.parse(await provider.localReadiness(base, 'qwen3.5-9b', 'secret-test'))
  check('local_readiness 返回 8 项量表与 full 判定（P0-1c PR4：max=16、项含 name/score/max/ok/detail）', () => {
    assert.equal(ready.max, 16)
    assert.equal(ready.items.length, 8)
    assert.ok(ready.items.every(x => x.max === 2 && typeof x.detail === 'string'))
    assert.equal(ready.verdict, 'full')
    assert.equal(ready.model, 'qwen3.5-9b')
    // 端点可达 + 元数据已识别（estimated=true 按保守估计 1 分）→ model_tagged 非 2
    assert.ok(ready.items.find(x => x.name === 'model_tagged').score === 1)
  })
  const tested = JSON.parse(await provider.testProviderEndpoint(base, 'secret-test', 'qwen3.5-9b', 5, false))
  check('test_provider_endpoint 真实 POST 并解析 reply', () => {
    assert.equal(tested.ok, true, JSON.stringify(tested))
    assert.equal(tested.reply, 'pong')
    assert.equal(tested.url.includes('/chat/completions'), true)  // PR5：成功 {ok,url,model,reply}（无 state 键）
    const call = seen.filter(x => x.url === '/v1/chat/completions').at(-1)
    assert.equal(JSON.parse(call.body).model, 'qwen3.5-9b')
    assert.equal(call.auth, 'Bearer secret-test')
  })
  const loading = JSON.parse(await provider.testProviderEndpoint(`http://127.0.0.1:${server.address().port}/loading`, '', 'm', 5, true))
  check('本地 503 识别为 loading 而非普通失败', () => assert.equal(loading.state, 'loading'))
  const probed = JSON.parse(await provider.localProbe(JSON.stringify([server.address().port])))
  check('local_probe 自定义端口返回 reachable 模型', () => {
    assert.equal(probed.reachable.length, 1)
    assert.deepEqual(probed.reachable[0].models, ['qwen3.5-9b'])
  })
  const badPorts = JSON.parse(await provider.localProbe('not-json'))
  check('local_probe 非 JSON 端口参数显式报错', () => assert.ok(badPorts.error.includes('JSON 数组')))
  const remoteHttp = JSON.parse(await provider.localModels('http://example.com/v1', ''))
  check('非回环明文 http 在发请求前拒绝', () => assert.ok(remoteHttp.error.includes('回环')))
  const noKey = JSON.parse(await provider.testProviderEndpoint('https://example.com/v1', '', 'm', 5, false))
  check('云端端点缺 Key 直接拒绝且不访问网络', () => assert.ok(noKey.error.includes('API Key')))
  console.log(JSON.stringify({ ok: true, checks: results.length, results }, null, 2))
} finally {
  await new Promise(resolve => server.close(resolve))
}
