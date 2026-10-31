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

  /* ---------- 独立配置族（P0-1c T04 CF1-CF7：规格化配置面端到端） ---------- */
  const hybridDefault = await app.inject({ method: 'POST', url: '/jsapi/hybrid_get_config', payload: { args: [] } })
  check('CF1 hybrid_get_config 默认 {ok, config(5键), source}', () => {
    const body = JSON.parse(hybridDefault.body)
    assert.equal(body.ok, true)
    assert.equal(body.source, 'default')
    assert.deepEqual(body.config, {
      strategy: 'auto', local_budget_understand_s: 5, local_budget_validate_s: 3,
      confidence_gate: 0.7, cost_split_display: true,
    })
  })
  const hybridBad = await app.inject({
    method: 'POST', url: '/jsapi/hybrid_save_config',
    payload: { args: ['{"strategy": "bogus"}'] },
  })
  check('CF1 hybrid 非法 strategy → BAD_PARAMS + hint 且不落盘', () => {
    const body = JSON.parse(hybridBad.body)
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'BAD_PARAMS')
    assert.equal(body.error.message, "字段 strategy 的值 'bogus' 不合法")
    assert.ok(body.error.hint.startsWith('字段 strategy 合法域：'))
    // 默认值已由 c01 读取顺带落盘；非法保存不得污染（内容仍是全量默认）
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'config', 'hybrid.json'), 'utf8'))
    assert.equal(onDisk.strategy, 'auto')
  })
  const hybridOk = await app.inject({
    method: 'POST', url: '/jsapi/hybrid_save_config',
    payload: { args: ['{"strategy": "quality"}'] },
  })
  check('CF1 hybrid 合法保存 → {ok, config} 全量归一', () => {
    const body = JSON.parse(hybridOk.body)
    assert.equal(body.ok, true)
    assert.equal(body.config.strategy, 'quality')
    assert.equal(body.config.confidence_gate, 0.7)
  })

  const prefsDefault = await app.inject({ method: 'POST', url: '/jsapi/model_prefs_get', payload: { args: [] } })
  check('CF2 model_prefs_get 默认 {thinking, ctx_k, ok}', () => {
    assert.deepEqual(JSON.parse(prefsDefault.body), { thinking: 'auto', ctx_k: 0, ok: true })
  })
  const prefsBad = await app.inject({
    method: 'POST', url: '/jsapi/model_prefs_save', payload: { args: ['{"thinking": "bogus"}'] },
  })
  check('CF2 model_prefs 非法 thinking → flat error 且不落盘', () => {
    assert.deepEqual(JSON.parse(prefsBad.body), { error: 'thinking 仅支持 auto/off/low/medium/high' })
    assert.equal(fs.existsSync(path.join(tmp, 'config', 'model_prefs.json')), false)
  })
  const prefsOk = await app.inject({
    method: 'POST', url: '/jsapi/model_prefs_save', payload: { args: ['{"thinking": "high", "ctx_k": 128}'] },
  })
  check('CF2 model_prefs 合法保存 → {ok, thinking, ctx_k}；文件带 version:1', () => {
    assert.deepEqual(JSON.parse(prefsOk.body), { ok: true, thinking: 'high', ctx_k: 128 })
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'config', 'model_prefs.json'), 'utf8'))
    assert.deepEqual(onDisk, { thinking: 'high', ctx_k: 128, version: 1 })
  })

  const readerDefault = await app.inject({ method: 'POST', url: '/jsapi/reader_config_get', payload: { args: [] } })
  check('CF3 reader_config_get 裸 8 键 dict（无 ok）', () => {
    const body = JSON.parse(readerDefault.body)
    assert.equal(body.ok, undefined)
    assert.equal(body.budget_s, 10)
    assert.equal(body.version, 1)
  })
  const readerBad = await app.inject({
    method: 'POST', url: '/jsapi/reader_config_save', payload: { args: ['{"budget_s": 999}'] },
  })
  check('CF3 reader 越界 budget → flat error 且不落盘', () => {
    assert.deepEqual(JSON.parse(readerBad.body), { error: 'budget_s 需为 1-60 的整数' })
    assert.equal(fs.existsSync(path.join(tmp, 'config', 'reader.json')), false)
  })
  const readerOk = await app.inject({
    method: 'POST', url: '/jsapi/reader_config_save', payload: { args: ['{"budget_s": 30}'] },
  })
  check('CF3 reader 合法保存 → {ok, config} 全量归一', () => {
    const body = JSON.parse(readerOk.body)
    assert.equal(body.ok, true)
    assert.equal(body.config.budget_s, 30)
    assert.equal(body.config.max_input_chars, 12000)
  })

  const sandboxDefault = await app.inject({ method: 'POST', url: '/jsapi/sandbox_get_config', payload: { args: [] } })
  check('CF4 sandbox_get_config 裸全量配置（无 ok）', () => {
    const body = JSON.parse(sandboxDefault.body)
    assert.equal(body.ok, undefined)
    assert.equal(body.enabled, true)
    assert.equal(body.command_profiles.run_admin_command, 'off')
    assert.equal(body.limits.strict.max_processes, 8)
  })
  const sandboxSave = await app.inject({
    method: 'POST', url: '/jsapi/sandbox_save_config', payload: { args: ['{"enabled": true}'] },
  })
  check('CF4 sandbox_save_config → 裸 {ok:true}（宽松合并）', () => {
    assert.equal(sandboxSave.body, '{"ok":true}')
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'config', 'sandbox.json'), 'utf8'))
    assert.equal(onDisk.command_profiles.run_command, 'standard')
  })
  const sandboxStatus = await app.inject({ method: 'POST', url: '/jsapi/sandbox_status', payload: { args: [] } })
  check('CF4 sandbox_status {available, platform, enabled, command_profiles, stats}', () => {
    const body = JSON.parse(sandboxStatus.body)
    assert.equal(body.available, true)
    assert.equal(body.platform, 'nt')
    assert.deepEqual(body.stats, { jobs_created: 0, runs_sandboxed: 0, runs_failed_closed: 0 })
  })

  const cacheStats = await app.inject({ method: 'POST', url: '/jsapi/search_cache_stats', payload: { args: [] } })
  check('CF5 search_cache_stats 七键（空起步）', () => {
    const body = JSON.parse(cacheStats.body)
    assert.equal(body.ok, true)
    assert.equal(body.ttl_minutes, 60)
    assert.deepEqual(body.ttl_classes, { news: 0, general: 0, encyclopedia: 0 })
    assert.equal(body.bytes, undefined)
  })
  const readerStats = await app.inject({ method: 'POST', url: '/jsapi/search_reader_stats', payload: { args: [] } })
  check('CF6 search_reader_stats 七键（空起步 + since 掩蔽源）', () => {
    const body = JSON.parse(readerStats.body)
    assert.equal(body.ok, true)
    assert.equal(body.reader_calls, 0)
    assert.equal(body.local_available, true)
    assert.equal(body.configured, false)
    assert.equal(typeof body.since, 'number')
  })
  const searchIdle = await app.inject({ method: 'POST', url: '/jsapi/search_status', payload: { args: [''] } })
  check('CF7 search_status 无活跃 → {ok, active}（无 state/task_id 回显）', () => {
    const body = JSON.parse(searchIdle.body)
    assert.deepEqual(body, { ok: true, active: false })
  })

  /* ---------- rpc kwargs-only（P0-1c T04 RP1/RP2） ---------- */
  const rpcUnknownKwarg = await app.inject({
    method: 'POST', url: '/jsapi/rpc',
    payload: { args: ['save_config', '{"model": "rpc-model"}'] },
  })
  check('RP1 rpc 未知 kwarg → CPython TypeError 合成', () => {
    assert.deepEqual(JSON.parse(rpcUnknownKwarg.body),
      { error: "Api.save_config() got an unexpected keyword argument 'model'" })
  })
  const rpcArrayPayload = await app.inject({
    method: 'POST', url: '/jsapi/rpc',
    payload: { args: ['save_sessions', '[{"id": "r1", "title": "rpc 会话"}]'] },
  })
  check('RP2 rpc 数组 payload 归一 {} → missing positional 合成', () => {
    assert.deepEqual(JSON.parse(rpcArrayPayload.body),
      { error: "Api.save_sessions() missing 1 required positional argument: 'data'" })
  })
  const rpcKnown = await app.inject({
    method: 'POST', url: '/jsapi/rpc',
    payload: { args: ['get_cwd', '{}'] },
  })
  check('RP1 rpc 合法 kwargs 透传（裸文本协议方法）', () => {
    assert.ok(rpcKnown.body.length > 0)
  })
  const rpcJson = await app.inject({
    method: 'POST', url: '/jsapi/rpc',
    payload: { args: ['get_ws_enabled', '{"sid": "s_smoke_1"}'] },
  })
  check('RP1 rpc 合法 kwargs 透传（JSON 方法）', () => {
    assert.deepEqual(JSON.parse(rpcJson.body), { enabled: true })
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
