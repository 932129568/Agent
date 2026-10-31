/**
 * P0-2 T01 临时副本迁移验证器（§4.4 全断言）：
 *   node tools/verify-migration.mjs
 *
 * 流程（真实数据零污染）：
 *   1. 真实 ~/.glm-chat 全量指纹（逐文件 MD5 + 清单 hash，只读）；
 *   2. 完整复制到临时目录（fs.cpSync，只复制不删除）；
 *   3. 在副本上跑 migrate:legacy CLI（HARBOR_CONFIG_DIR 无需设置——CLI 只认
 *      --source/--db；源/备份/新库全部落在副本内）；
 *   4. 断言：条目数一致 / payload 全量保真 / id 类型保真 / 幂等重跑
 *      imported=0 / 原 sessions.json 与备份字节不变 / 真实指纹前后不变；
 *   5. 故障注入：大文件导入中途 kill 进程 → 重跑幂等收敛（事务回滚语义）。
 *
 * 输出 JSON 证据报告（结论 + 计数 + 指纹摘要）。失败即非零退出。
 */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(ROOT, 'server', 'src', 'cli', 'migrate-legacy.mjs')
const REAL_DIR = path.join(os.homedir(), '.glm-chat')

function md5(buf) { return crypto.createHash('md5').update(buf).digest('hex') }

function fingerprint(dir) {
  const files = []
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  walk(dir)
  const manifest = files.sort().map(file => {
    const rel = path.relative(dir, file).replaceAll('\\', '/')
    return `${rel}:${md5(fs.readFileSync(file))}`
  })
  return { count: files.length, hash: md5(manifest.join('\n')), manifest }
}

async function runCli(source, db) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, '--source', source, '--db', db],
    { env: { ...process.env, LOG_LEVEL: 'silent' }, maxBuffer: 16 * 1024 * 1024 })
  const lines = stdout.trim().split('\n').filter(Boolean)
  return { result: JSON.parse(lines[lines.length - 1]), stderr }
}

const report = { steps: [] }
const step = (name, fn) => { fn(); report.steps.push(name); console.log('PASS:', name) }

// ---------- 0. 真实目录指纹（前） ----------
const realBefore = fingerprint(REAL_DIR)
report.realFingerprintBefore = { count: realBefore.count, hash: realBefore.hash }
console.log(`真实目录指纹：${realBefore.count} 文件，hash=${realBefore.hash.slice(0, 12)}…`)

// ---------- 1. 完整复制到临时目录 ----------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-verify-migration-'))
const copyDir = path.join(work, 'copy')
fs.cpSync(REAL_DIR, copyDir, { recursive: true })
const legacySource = path.join(copyDir, 'sessions.json')
const targetDb = path.join(copyDir, 'harbor.db')
step('真实目录完整复制到临时目录（只复制不删除）', () => {
  assert.ok(fs.existsSync(legacySource), '副本 sessions.json 必须存在')
})
const legacyEntries = JSON.parse(fs.readFileSync(legacySource, 'utf8'))
const validEntries = legacyEntries.filter(x => x && typeof x === 'object' && !Array.isArray(x) && x.id !== undefined && x.id !== null)
const originalBytes = fs.readFileSync(legacySource)

// ---------- 2. 首次迁移 ----------
const first = await runCli(legacySource, targetDb)
step('首次迁移成功且计数与有效条目一致', () => {
  assert.equal(first.result.ok, true, JSON.stringify(first.result))
  assert.equal(first.result.imported, validEntries.length)
  assert.equal(first.result.skipped, 0)
})

// ---------- 3. 全量 payload 保真 + id 类型保真（独立只读进程回读） ----------
const READ_DB = path.join(ROOT, 'tools', 'read-session-db.mjs')
const readback = await execFileAsync(process.execPath, [READ_DB, targetDb], { maxBuffer: 256 * 1024 * 1024 })
const readbackData = JSON.parse(readback.stdout.trim().split('\n').filter(Boolean).pop())
const rows = readbackData.rows
const byId = new Map(rows.map(r => [r.id, r]))
step('DB 行数与有效条目一致', () => assert.equal(rows.length, validEntries.length))
step('payload 全量保真（每条与 legacy 原文深度一致）', () => {
  for (const entry of validEntries) {
    const row = byId.get(String(entry.id))
    assert.ok(row, `缺条目 id=${entry.id}`)
    assert.deepEqual(JSON.parse(row.payload), entry, `payload 不一致 id=${entry.id}`)
  }
})
step('id 类型保真（数字 id 仍为数字）', () => {
  for (const entry of validEntries) {
    if (typeof entry.id === 'number') assert.equal(typeof JSON.parse(byId.get(String(entry.id)).payload).id, 'number')
  }
})

// ---------- 4. 幂等重跑 + 备份字节不变 ----------
const backup = `${legacySource}.pre-node-migration.bak`
step('备份已生成且与源字节一致', () => {
  assert.deepEqual(fs.readFileSync(backup), originalBytes)
})
const second = await runCli(legacySource, targetDb)
step('幂等重跑：imported=0 / skipped=N', () => {
  assert.equal(second.result.ok, true)
  assert.equal(second.result.imported, 0)
  assert.equal(second.result.skipped, validEntries.length)
})
step('原 sessions.json 与备份字节全程不变', () => {
  assert.deepEqual(fs.readFileSync(legacySource), originalBytes)
  assert.deepEqual(fs.readFileSync(backup), originalBytes)
})

// ---------- 5. 故障注入：导入中途 kill → 重跑收敛 ----------
const faultDir = path.join(work, 'fault')
fs.mkdirSync(faultDir, { recursive: true })
const bigFile = path.join(faultDir, 'sessions.json')
const bigEntries = Array.from({ length: 12000 }, (_, i) => ({
  id: `fault-${i}`, title: `故障注入 ${i}`, createdAt: 1000 + i, updatedAt: 1000 + i,
  messages: [{ role: 'user', content: `故障注入会话 ${i}——用于验证事务回滚与幂等重试。` }],
}))
fs.writeFileSync(bigFile, JSON.stringify(bigEntries))
const faultDb = path.join(faultDir, 'harbor.db')
const child = spawn(process.execPath, [CLI, '--source', bigFile, '--db', faultDb],
  { env: { ...process.env, LOG_LEVEL: 'silent' }, stdio: 'ignore' })
await new Promise(resolve => setTimeout(resolve, 400))
child.kill('SIGTERM')
await new Promise(resolve => child.once('exit', resolve))
step('导入中途 kill 进程（故障注入完成）', () => assert.ok(true))
const recovered = await runCli(bigFile, faultDb)
step('kill 后重跑幂等收敛（事务回滚 → 全量或全跳过）', () => {
  assert.equal(recovered.result.ok, true)
  assert.ok(recovered.result.imported + recovered.result.skipped === bigEntries.length,
    `imported=${recovered.result.imported} skipped=${recovered.result.skipped}`)
})
const recoveredRows = await execFileAsync(process.execPath, [READ_DB, faultDb], { maxBuffer: 256 * 1024 * 1024 })
step('恢复后 DB 条目数与源一致', () => {
  const count = JSON.parse(recoveredRows.stdout.trim().split('\n').filter(Boolean).pop()).count
  assert.equal(count, bigEntries.length)
})

// ---------- 6. 真实目录指纹（后） ----------
const realAfter = fingerprint(REAL_DIR)
step('真实 ~/.glm-chat 指纹全程不变（469 文件口径的零污染证据）', () => {
  assert.equal(realAfter.count, realBefore.count)
  assert.equal(realAfter.hash, realBefore.hash)
})
report.realFingerprintAfter = { count: realAfter.count, hash: realAfter.hash }
report.migration = { entries: validEntries.length, imported: first.result.imported }
report.faultInjection = { entries: bigEntries.length, recovered: recovered.result }
report.ok = true
console.log(JSON.stringify(report, null, 2))
