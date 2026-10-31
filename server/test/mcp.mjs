import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-mcp-'))
process.env.HARBOR_CONFIG_DIR = path.join(tmp, 'config')
process.env.DATABASE_URL = `file:${path.join(tmp, 'app.db')}`
process.env.LOG_LEVEL = 'silent'
const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(here, 'fixtures', 'mcp-server.mjs')
const mcp = await import('../src/services/mcp.js')
const guard = await import('../src/services/guard.js')
const results = []; const check = (name, fn) => { fn(); results.push(name) }
const config = { command: process.execPath, args: [fixture], enabled: true, callTimeout: 30, tierOverrides: { echo: 'off', add: 'always' } }
const saved = JSON.parse(await mcp.mcpSaveServer('local-test', JSON.stringify(config)))
check('启用前执行真实 stdio 连接预检', () => assert.equal(saved.ok, true, saved.error))
const tested = JSON.parse(await mcp.mcpTestServer('local-test'))
check('tools/list 返回两个工具', () => { assert.equal(tested.ok, true, tested.error); assert.equal(tested.tool_count, 2) })
const listed = JSON.parse(await mcp.mcpListServers())
check('服务器列表包含运行状态与工具数', () => { assert.equal(listed.servers[0].status, 'ok'); assert.equal(listed.servers[0].tool_count, 2) })
const detail = JSON.parse(await mcp.mcpGetServerDetail('local-test'))
check('详情含工具档位覆盖', () => { assert.equal(detail.tierOverrides.echo, 'off'); assert.equal(detail.tools.length, 2) })
const offCall = JSON.parse(await mcp.mcpCallTool('local-test', 'echo', JSON.stringify({ text: 'hello' }), 'allow'))
check('off 工具真实执行并返回 output', () => { assert.equal(offCall.ok, true, offCall.error); assert.equal(offCall.output, 'echo:hello') })
const noToken = JSON.parse(await mcp.mcpCallTool('local-test', 'add', JSON.stringify({ a: 2, b: 3 }), 'allow'))
check('always 工具无 token 拒绝', () => assert.ok(noToken.error.includes('token')))
const args = { a: 2, b: 3 }
const token = JSON.parse(await guard.guardConfirmToken('mcp_call', { server: 'local-test', tool: 'add', arguments: args })).token
const added = JSON.parse(await mcp.mcpCallTool('local-test', 'add', JSON.stringify(args), 'allow', token))
check('always 工具参数绑定 token 后执行', () => { assert.equal(added.ok, true, added.error); assert.equal(added.structuredContent.sum, 5) })
const resources = JSON.parse(await mcp.mcpListResources('local-test'))
check('resources/list 原生能力', () => { assert.equal(resources.supported, true); assert.equal(resources.resources[0].uri, 'memory://greeting') })
const resource = JSON.parse(await mcp.mcpReadResource('local-test', 'memory://greeting'))
check('resources/read 返回文本', () => assert.ok(resource.text.includes('hello-from-mcp-resource')))
const subscriptions = JSON.parse(await mcp.mcpSaveSubscriptions('local-test', JSON.stringify(['memory://greeting'])))
check('资源订阅持久化', () => assert.deepEqual(subscriptions.subscribed, ['memory://greeting']))
const imported = JSON.parse(await mcp.mcpImportClaude(JSON.stringify({ mcpServers: { other: { command: process.execPath, args: [fixture] }, 'local-test': { command: 'ignored' } } })))
check('Claude 导入同名跳过且默认不启用（P0-1c MC8：imported 为名字数组）', () => { assert.deepEqual(imported.imported, ['other']); assert.equal(imported.skipped.length, 1) })
const denied = JSON.parse(await mcp.mcpCallTool('local-test', 'echo', '{}', 'deny'))
check('用户拒绝返回 skipped 且不执行', () => assert.equal(denied.skipped, true))
const shutdown = JSON.parse(await mcp.mcpShutdown())
check('shutdown 关闭全部传输', () => { assert.equal(shutdown.ok, true); assert.ok(shutdown.closed >= 1) })
const removed = JSON.parse(await mcp.mcpDeleteServer('other'))
check('删除服务器配置', () => assert.equal(removed.ok, true))

/* P0-2 T03：MCP env/headers 字段级加密（保存加密 / 详情解密 / 幂等透传） */
const encConfig = { command: process.execPath, args: [fixture], enabled: false,
  env: { API_TOKEN: 'secret-token-🚀', PLAIN: 'x' } }
const encSaved = JSON.parse(await mcp.mcpSaveServer('enc-test', JSON.stringify(encConfig)))
check('T03 加密保存成功', () => assert.equal(encSaved.ok, true))
check('T03 stdio env 以 {__enc__:dpapi:...} 落盘（文件无明文）', () => {
  const file = JSON.parse(fs.readFileSync(path.join(process.env.HARBOR_CONFIG_DIR, 'mcp_servers.json'), 'utf8'))
  const rec = file.mcpServers['enc-test']
  assert.ok(rec.env.API_TOKEN.__enc__.startsWith('dpapi:'))
  assert.ok(rec.env.PLAIN.__enc__.startsWith('dpapi:'))
  assert.ok(!JSON.stringify(rec).includes('secret-token-🚀'))
})
const encDetail = JSON.parse(await mcp.mcpGetServerDetail('enc-test'))
check('T03 详情解密回显明文、decrypt_failed 为空', () => {
  assert.equal(encDetail.config.env.API_TOKEN, 'secret-token-🚀')
  assert.deepEqual(encDetail.decrypt_failed, [])
})
// HTTP 服务器的 headers 字段（url 形态才保留 headers——stdio 仅 env，与 Python 同款）
const httpSaved = JSON.parse(await mcp.mcpSaveServer('enc-http', JSON.stringify({
  url: 'http://127.0.0.1:65535/mcp', enabled: false, headers: { 'X-Key': 'hdr-secret' },
})))
check('T03 HTTP headers 以 {__enc__:dpapi:...} 落盘', () => {
  const file = JSON.parse(fs.readFileSync(path.join(process.env.HARBOR_CONFIG_DIR, 'mcp_servers.json'), 'utf8'))
  const rec = file.mcpServers['enc-http']
  assert.ok(rec.headers['X-Key'].__enc__.startsWith('dpapi:'))
  assert.ok(!JSON.stringify(rec).includes('hdr-secret'))
})
const httpDetail = JSON.parse(await mcp.mcpGetServerDetail('enc-http'))
check('T03 HTTP headers 详情解密回显明文', () => {
  assert.equal(httpDetail.config.headers['X-Key'], 'hdr-secret')
})
const again = JSON.parse(await mcp.mcpSaveServer('enc-test', JSON.stringify(encConfig)))
check('T03 同值再保存幂等（密文透传不重复加密）', () => assert.equal(again.ok, true))
await mcp.mcpDeleteServer('enc-test')
await mcp.mcpDeleteServer('enc-http')
console.log(JSON.stringify({ ok: true, checks: results.length, results }, null, 2))
