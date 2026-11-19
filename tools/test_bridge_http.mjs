/**
 * 前端桥接 HTTP 联调：用**生产 bridge.js 源码** + **真实 fastify 服务**验证。
 *
 * 不依赖浏览器时序（虚拟时间会让探针早于真实网络回包），改为在 Node VM 里
 * 执行 `frontend/src/core/bridge.js`，window 只注入 HARBOR_API_BASE，
 * fetch/AbortController 用 Node 27 原生实现——与 WebView2 中同一代码路径。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-bridge-'))
process.env.HARBOR_CONFIG_DIR = path.join(tmp, 'config')
process.env.DATABASE_URL = `file:${path.join(tmp, 'bridge.db')}`
process.env.LOG_LEVEL = 'silent'

const { buildServer } = await import('../server/src/app.js')
const { disconnectDb } = await import('../server/src/db.js')

// Prisma 运行期需要先有表结构：用官方迁移路径在临时库上建表
const { execFile } = await import('node:child_process')
const { promisify } = await import('node:util')
await promisify(execFile)(process.execPath,
  ['node_modules/prisma/build/index.js', 'db', 'push', '--schema=./prisma/schema.prisma'],
  { cwd: path.join(root, 'server'), env: process.env })

const app = await buildServer()
const base = (await app.listen({ host: '127.0.0.1', port: 0 })).replace(/\/$/, '')

try {
  const sample = [{
    id: 's_bridge_1', title: '桥接验证', createdAt: 1, updatedAt: Date.now(),
    messages: [{ role: 'user', content: '经 fastify 返回' }],
  }]
  await fetch(`${base}/jsapi/save_sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args: [JSON.stringify(sample)] }),
  })

  const sandbox = {
    window: { HARBOR_API_BASE: base },
    fetch, AbortController, setTimeout, clearTimeout, Promise, JSON, console, Error,
  }
  vm.createContext(sandbox)
  const source = fs.readFileSync(path.join(root, 'frontend/src/core/bridge.js'), 'utf8')
  vm.runInContext(source + '\nthis.__callApi = callApi;', sandbox)

  const sessions = await sandbox.__callApi('get_sessions', [])
  const rows = JSON.parse(sessions)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].messages[0].content, '经 fastify 返回')

  const info = JSON.parse(await sandbox.__callApi('get_api_info', []))
  assert.equal(info.version, 'v1.0.0')
  assert.ok(info.methods.includes('get_config'))

  // 文件工具族端到端：经生产桥接在隔离工作区读写，并验证越狱被拒
  await sandbox.__callApi('set_workspace', [tmp])
  await sandbox.__callApi('write_file', ['e2e.txt', 'hello from node backend'])
  const fileRead = JSON.parse(await sandbox.__callApi('read_file', ['e2e.txt']))
  assert.ok(fileRead.content.includes('hello from node backend'), 'HTTP 读取文件内容不符')
  const escape = JSON.parse(await sandbox.__callApi('read_file', ['../escape.txt']))
  assert.ok(escape.error && escape.error.includes('路径越界'), '越狱必须被路径监狱拒绝')

  // 未配置后端地址 + 无 pywebview → 必须报「bridge 未就绪」（保持旧语义）
  sandbox.window.HARBOR_API_BASE = ''
  await assert.rejects(() => sandbox.__callApi('get_sessions', []), /bridge 未就绪/)

  // pywebview 存在时优先走原生桥，HTTP 不应被调用
  let nativeCalls = 0
  sandbox.window.pywebview = { api: { get_sessions: async () => { nativeCalls += 1; return '[]' } } }
  assert.equal(await sandbox.__callApi('get_sessions', []), '[]')
  assert.equal(nativeCalls, 1)

  console.log(JSON.stringify({
    ok: true, node: process.version, backend: base,
    checks: ['get_sessions over HTTP', 'get_api_info over HTTP',
      'write_file/read_file over HTTP（隔离工作区）', '路径越狱被 HTTP 层拒绝',
      'no backend → bridge 未就绪', 'pywebview 优先于 HTTP'],
  }, null, 2))
} finally {
  await app.close()
  await disconnectDb()
}
