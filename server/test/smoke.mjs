/**
 * 后端冒烟：用 fastify 的 `app.inject()` 走真实路由（不占端口、不发网络请求）。
 *
 * 环境隔离：临时目录接管 HARBOR_CONFIG_DIR / DATABASE_URL / 工作区，
 * 绝不写真实 ~/.glm-chat 或项目内的正式数据库。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-node-smoke-'))
process.env.HARBOR_CONFIG_DIR = path.join(tmp, 'config')
process.env.DATABASE_URL = `file:${path.join(tmp, 'smoke.db')}`
process.env.LOG_LEVEL = 'silent'

const workspace = path.join(tmp, 'ws')
fs.mkdirSync(workspace, { recursive: true })

// 动态 import：确保上面的 env 在模块加载前生效（config 在 import 期解析）
const { buildServer } = await import('../src/app.js')
const { disconnectDb } = await import('../src/db.js')

// 用官方迁移路径建表（而不是手写 SQL 复制 schema）。
// 注意：Windows 上 spawn('npx') 会 ENOENT（.cmd 不经 shell 不可直接执行），
// 因此直接用 process.execPath 调 Prisma CLI 的 JS 入口。
await execFileAsync(process.execPath,
  ['node_modules/prisma/build/index.js', 'db', 'push', '--schema=./prisma/schema.prisma'],
  { cwd: serverRoot, env: process.env })

const results = []
const check = (name, fn) => { fn(); results.push({ name, ok: true }) }

const app = await buildServer()

try {
  const health = await app.inject({ method: 'GET', url: '/health' })
  check('health 200 + ok', () => {
    assert.equal(health.statusCode, 200)
    assert.equal(health.json().ok, true)
  })

  const info = await app.inject({ method: 'POST', url: '/jsapi/get_api_info', payload: { args: [] } })
  check('get_api_info 返回冻结契约版本', () => {
    const body = JSON.parse(info.body)
    assert.equal(body.version, 'v1.0.0')
    assert.ok(body.methods.includes('get_sessions'))
    assert.equal(body.methods.length, 51)
    assert.ok(!body.methods.includes('browser_search'), '隐身方法不得进入公开自省面')
  })

  /* ---------- 会话 ---------- */
  const sample = [{
    id: 's_smoke_1', title: 'Node 后端冒烟', createdAt: 1000, updatedAt: 2000,
    runStatus: 'working', projectId: 'p1', projectName: 'Harbor',
    projectWorkspace: 'C:/work/harbor',
    messages: [{ role: 'user', content: '你好，Node 后端' }],
  }]
  const save = await app.inject({
    method: 'POST', url: '/jsapi/save_sessions', payload: { args: [JSON.stringify(sample)] },
  })
  check('save_sessions 落库', () => assert.equal(save.body, '{"ok":true}'))

  const list = await app.inject({ method: 'POST', url: '/jsapi/get_sessions', payload: { args: [] } })
  check('get_sessions 原文回读（messages 不丢字段）', () => {
    const rows = JSON.parse(list.body)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].messages[0].content, '你好，Node 后端')
    assert.equal(rows[0].projectWorkspace, 'C:/work/harbor')
  })

  /* ---------- 配置 ---------- */
  const cfg0 = await app.inject({ method: 'POST', url: '/jsapi/get_config', payload: { args: [] } })
  check('get_config 缺文件返回 {}', () => assert.equal(cfg0.body, '{}'))

  const badJson = await app.inject({
    method: 'POST', url: '/jsapi/save_config', payload: { args: ['{not-json'] },
  })
  check('save_config 非法 JSON 显式报错', () => {
    assert.ok(JSON.parse(badJson.body).error.includes('解析失败'))
  })

  const notObject = await app.inject({
    method: 'POST', url: '/jsapi/save_config', payload: { args: ['[1,2]'] },
  })
  check('save_config 非对象显式报错', () => {
    assert.ok(JSON.parse(notObject.body).error.includes('JSON 对象'))
  })

  const merged = await app.inject({
    method: 'POST', url: '/jsapi/save_config', payload: { args: ['{"model":"glm-x"}'] },
  })
  check('save_config 合法合并', () => assert.equal(merged.body, '{"ok":true}'))

  const cfg1 = await app.inject({ method: 'POST', url: '/jsapi/get_config', payload: { args: [] } })
  check('get_config 读到合并结果', () => {
    assert.equal(JSON.parse(cfg1.body).model, 'glm-x')
  })

  /* ---------- 工作目录与工作日志 ---------- */
  const cwd = await app.inject({ method: 'POST', url: '/jsapi/get_cwd', payload: { args: [] } })
  check('get_cwd 返回路径字符串', () => assert.ok(cwd.body.length > 0))

  const badWs = await app.inject({
    method: 'POST', url: '/jsapi/set_workspace', payload: { args: [path.join(tmp, 'no-such-dir')] },
  })
  check('set_workspace 不存在目录报错', () => {
    assert.ok(JSON.parse(badWs.body).error.includes('目录不存在'))
  })

  const okWs = await app.inject({
    method: 'POST', url: '/jsapi/set_workspace', payload: { args: [workspace] },
  })
  check('set_workspace 合法目录切换', () => {
    assert.equal(JSON.parse(okWs.body).ok, true)
    assert.equal(JSON.parse(okWs.body).path, workspace)
  })

  await app.inject({ method: 'POST', url: '/jsapi/set_current_sid', payload: { args: ['s_smoke_1'] } })
  const log1 = await app.inject({
    method: 'POST', url: '/jsapi/append_worklog', payload: { args: ['写入文件 a.txt'] },
  })
  check('append_worklog 写入', () => assert.equal(log1.body, '{"ok":true}'))

  const logText = await app.inject({ method: 'POST', url: '/jsapi/get_worklog', payload: { args: [] } })
  check('get_worklog 回读含时间戳与正文', () => {
    assert.ok(logText.body.includes('写入文件 a.txt'))
    assert.match(logText.body, /- \[\d{2}-\d{2} \d{2}:\d{2}\]/)
  })
  check('worklog 落在会话工作区而非全局目录', () => {
    assert.ok(fs.existsSync(path.join(workspace, '_glm_worklog.md')))
  })

  /* ---------- 降级与错误面 ---------- */
  const missing = await app.inject({ method: 'POST', url: '/jsapi/__definitely_unknown__', payload: { args: [] } })
  check('未注册方法返回 NOT_MIGRATED（不打 500）', () => {
    assert.equal(missing.statusCode, 200)
    assert.equal(JSON.parse(missing.body).error.code, 'NOT_MIGRATED')
  })

  const bad = await app.inject({
    method: 'POST', url: '/jsapi/get_sessions',
    payload: 'not-valid', headers: { 'content-type': 'application/json' },
  })
  check('非法 JSON body 被拒（400）', () => assert.equal(bad.statusCode, 400))

  const notFound = await app.inject({ method: 'GET', url: '/no-such-route' })
  check('未知路由 404', () => assert.equal(notFound.statusCode, 404))

  console.log(JSON.stringify({
    ok: true, node: process.version, checks: results.length,
    isolated_dir: tmp, results,
  }, null, 2))
} finally {
  await app.close()
  await disconnectDb()
}
