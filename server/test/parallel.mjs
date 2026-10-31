/**
 * P0-3 并行会话隔离实证组（不占差分面——并行=Node 增强，Python 无并行对应物）。
 *
 * 五组实证（§5.3）+ T01 静态防回归断言：
 *   1. 交错隔离：A/B header 各自 cwd/trust/grant/dedup 互不影响；
 *   2. 写互斥：同 root 两会话并发 write_file 同一文件 50 次无撕裂；
 *   3. legacy 混用：无头走全局 activeSid，与 header 互不污染；
 *   4. purge 清理：session_purge 后该 sid 容器全清、其他 sid 不受影响；
 *   5. A/B 交替 save 全量数组不丢条目（R4 共享知识纪律）；
 *   6. 静态断言：services/** 无 runtime.currentSid 直读（persist 全局写除外）。
 *
 * 全部经 buildServer + app.inject 走真实路由（ALS 请求级上下文唯一真实路径）。
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-parallel-'))
process.env.HARBOR_CONFIG_DIR = path.join(tmp, 'config')
process.env.DATABASE_URL = `file:${path.join(tmp, 'parallel.db')}`
process.env.LOG_LEVEL = 'silent'
process.env.HARBOR_GUARD_ARMED = 'true'   // trust/grant/dedup 隔离需武装语义

const wsA = path.join(tmp, 'wsA')
const wsB = path.join(tmp, 'wsB')
fs.mkdirSync(wsA, { recursive: true })
fs.mkdirSync(wsB, { recursive: true })
fs.mkdirSync(process.env.HARBOR_CONFIG_DIR, { recursive: true })
await execFileAsync(process.execPath,
  ['node_modules/prisma/build/index.js', 'db', 'push', '--schema=./prisma/schema.prisma'],
  { cwd: serverRoot, env: process.env })

const { buildServer } = await import('../src/app.js')
const { disconnectDb } = await import('../src/db.js')
const app = await buildServer()
const results = []
const check = async (name, fn) => { await fn(); results.push(name) }
const call = (method, args = [], sid = null) => app.inject({
  method: 'POST', url: `/jsapi/${method}`,
  payload: { args }, headers: sid ? { 'x-harbor-sid': sid } : {},
})
const json = response => JSON.parse(response.body)

/* ---------------- 1. 交错隔离 ---------------- */
await check('A/B header 各自 set_workspace 只影响本会话（Q3 语义）', async () => {
  assert.equal(json(await call('set_workspace', [wsA], 'sid-A')).ok, true)
  assert.equal(json(await call('set_workspace', [wsB], 'sid-B')).ok, true)
  assert.equal((await call('get_cwd', [], 'sid-A')).body, wsA)
  assert.equal((await call('get_cwd', [], 'sid-B')).body, wsB)
  // 全局 cwd 不受 header 写入污染（无头=legacy 全局语义）
  assert.notEqual((await call('get_cwd')).body, wsA)
  assert.notEqual((await call('get_cwd')).body, wsB)
})
await check('get_effective_ws 按 header 自省（sid 与 ws 各自独立）', async () => {
  const a = json(await call('get_effective_ws', [], 'sid-A'))
  const b = json(await call('get_effective_ws', [], 'sid-B'))
  assert.equal(a.sid, 'sid-A'); assert.equal(a.ws, wsA)
  assert.equal(b.sid, 'sid-B'); assert.equal(b.ws, wsB)
})
await check('会话信任隔离：A trust 后 B guard_check 仍为 confirm', async () => {
  assert.equal((await call('guard_session_trust', ['run_command'], 'sid-A')).body, '{"ok":true}')
  const verdict = json(await call('guard_check', ['run_command', '{}'], 'sid-B'))
  assert.equal(verdict.action, 'confirm')
  // B 也需自行信任后才放行（A 的信任不命中 B）
  assert.equal((await call('guard_session_trust', ['run_command'], 'sid-B')).body, '{"ok":true}')
  const bAfter = json(await call('guard_check', ['run_command', '{}'], 'sid-B'))
  assert.equal(bAfter.action, 'allow')
})
await check('命令去重隔离：A 重复命令被拒、B 同命令放行', async () => {
  const first = json(await call('run_command', ['echo parallel-dedup', 30], 'sid-A'))
  assert.equal(first.exit_code, 0)
  const dup = json(await call('run_command', ['echo parallel-dedup', 30], 'sid-A'))
  assert.ok(String(dup.error || dup.output || '').includes('最近已执行过'))
  const bFirst = json(await call('run_command', ['echo parallel-dedup', 30], 'sid-B'))
  assert.equal(bFirst.exit_code, 0)
})
await check('任务授权隔离：A grant 不影响 B 的 status', async () => {
  const granted = json(await call('guard_task_grant', ['workspace_write', 3600], 'sid-A'))
  assert.equal(granted.ok, true)
  assert.equal(json(await call('guard_task_status', [], 'sid-A')).active, true)
  assert.equal(json(await call('guard_task_status', [], 'sid-B')).active, false)
  const budgetA = json(await call('guard_approval_budget', [], 'sid-A'))
  const budgetB = json(await call('guard_approval_budget', [], 'sid-B'))
  assert.ok(budgetA.used >= 1)
  assert.notEqual(budgetA.used, budgetB.used)
})

/* ---------------- 2. 写互斥（同 root 并发 50 次无撕裂） ---------------- */
await check('同 root 并发 write_file 50 次：最终为某次完整写入', async () => {
  const target = path.join(wsA, 'shared.txt')
  const payloads = []
  const calls = []
  for (let i = 0; i < 50; i += 1) {
    const sid = i % 2 === 0 ? 'sid-A' : 'sid-B'
    const text = `WRITE-${String(i).padStart(3, '0')}-${sid}-${'x'.repeat(40)}`
    payloads.push(text)
    calls.push(call('write_file', [target, text], sid))
  }
  const responses = await Promise.all(calls)
  for (const response of responses) assert.equal(json(response).ok, true)
  const finalContent = fs.readFileSync(target, 'utf8')
  assert.ok(payloads.includes(finalContent), `最终内容非任何一次完整写入: ${finalContent.slice(0, 60)}`)
  // 无残留临时文件（tmp+rename 序列完整）
  assert.ok(!fs.readdirSync(wsA).some(name => name.includes('.tmp')))
})

/* ---------------- 3. legacy 混用 ---------------- */
await check('无头走全局 activeSid 且与 header 互不污染', async () => {
  assert.equal((await call('set_current_sid', ['s-legacy'])).body, '{"ok":true}')
  assert.equal(json(await call('get_effective_ws')).sid, 's-legacy')
  assert.equal(json(await call('get_effective_ws', [], 'sid-A')).sid, 'sid-A')
  assert.equal(json(await call('get_effective_ws')).sid, 's-legacy')
  assert.equal((await call('set_current_sid', ['s-legacy2'])).body, '{"ok":true}')
  assert.equal(json(await call('get_effective_ws')).sid, 's-legacy2')
  assert.equal(json(await call('get_effective_ws', [], 'sid-A')).sid, 'sid-A')
  // legacy clear-on-switch：s-legacy 的信任在切换后不再生效（旧全局 sid）
  assert.equal((await call('guard_session_trust', ['run_command'], 's-legacy2')).body, '{"ok":true}')
  assert.equal((await call('set_current_sid', ['s-legacy3'])).body, '{"ok":true}')
  const afterSwitch = json(await call('guard_check', ['run_command', '{}'], 's-legacy2'))
  assert.equal(afterSwitch.action, 'confirm')
})

/* ---------------- 4. purge 清理 ---------------- */
await check('session_purge 清该 sid 全部容器、其他 sid 不受影响', async () => {
  assert.equal(json(await call('set_workspace', [wsA], 'sid-P')).ok, true)
  assert.equal((await call('guard_session_trust', ['run_command'], 'sid-P')).body, '{"ok":true}')
  assert.equal(json(await call('guard_task_grant', ['workspace_write', 3600], 'sid-P')).ok, true)
  assert.equal(json(await call('session_purge', ['sid-P', '[]'])).ok, true)
  // cwd 覆盖清（回全局）、grant 清、trust 清
  assert.notEqual((await call('get_cwd', [], 'sid-P')).body, wsA)
  assert.equal(json(await call('guard_task_status', [], 'sid-P')).active, false)
  assert.equal(json(await call('guard_check', ['run_command', '{}'], 'sid-P')).action, 'confirm')
  // 其他 sid 的容器仍在
  assert.equal(json(await call('guard_task_status', [], 'sid-A')).active, true)
  assert.equal((await call('get_cwd', [], 'sid-A')).body, wsA)
})

/* ---------------- 5. A/B 交替 save 全量数组不丢条目（R4） ---------------- */
await check('交替 save_sessions 全量数组不丢条目', async () => {
  const mk = (id, title) => ({ id, title, updatedAt: 1000, messages: [] })
  await call('save_sessions', [JSON.stringify([mk('a1', 'A1'), mk('shared', '共享')])], 'sid-A')
  await call('save_sessions', [JSON.stringify([mk('b1', 'B1'), mk('shared', '共享')])], 'sid-B')
  await call('save_sessions', [JSON.stringify([mk('a1', 'A1'), mk('a2', 'A2'), mk('shared', '共享')])], 'sid-A')
  await call('save_sessions', [JSON.stringify([mk('b1', 'B1'), mk('b2', 'B2'), mk('shared', '共享')])], 'sid-B')
  const listed = json(await call('get_sessions'))
  const ids = listed.map(x => x.id).sort()
  assert.deepEqual(ids, ['a1', 'a2', 'b1', 'b2', 'shared'])
})

/* ---------------- 6. 静态防回归断言（T01） ---------------- */
await check('services/** 无 runtime.currentSid 直读（单点收口）', () => {
  const servicesDir = path.join(serverRoot, 'src', 'services')
  const offenders = []
  for (const file of fs.readdirSync(servicesDir)) {
    if (!file.endsWith('.js')) continue
    const text = fs.readFileSync(path.join(servicesDir, file), 'utf8')
    for (const [index, line] of text.split('\n').entries()) {
      // persist 全局默认写（workspace.js 的 runtime.json 序列化）属合法全局态持久化
      if (/runtime\.currentSid/.test(line) && !/currentSid: runtime\.currentSid/.test(line)) {
        offenders.push(`${file}:${index + 1}`)
      }
    }
  }
  assert.deepEqual(offenders, [])
})

await app.close()
await disconnectDb()
console.log(JSON.stringify({ ok: true, node: process.version, checks: results.length, results }, null, 2))
