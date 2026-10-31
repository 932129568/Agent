/**
 * P0-2 T01 存储迁移基建测试组：三原语 + DB 切换 + bootstrap 导入。
 * 全部在临时目录隔离执行（HARBOR_CONFIG_DIR + DATABASE_URL 先于 import 注入）。
 * 数据保护断言：原文件不改写不删除、备份不覆盖、失败整批回滚。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-migration-'))
process.env.HARBOR_CONFIG_DIR = path.join(tmp, 'config')
process.env.DATABASE_URL = `file:${path.join(tmp, 'main.db')}`
process.env.LOG_LEVEL = 'silent'
fs.mkdirSync(process.env.HARBOR_CONFIG_DIR, { recursive: true })

const { prisma, switchDatabase, disconnectDb } = await import('../src/db.js')
const {
  importLegacySessions, materializeSessions, bootstrapLegacyImport,
  MIGRATION_META_KEY, MIGRATION_BACKUP_SUFFIX,
} = await import('../src/services/session-migrate.js')
const { saveSessions, getSessions } = await import('../src/services/sessions.js')

await execFileAsync(process.execPath,
  ['node_modules/prisma/build/index.js', 'db', 'push', '--schema=./prisma/schema.prisma'],
  { cwd: serverRoot, env: process.env })

const results = []
const check = async (name, fn) => { await fn(); results.push(name) }
const legacyFile = path.join(tmp, 'legacy-sessions.json')
const LEGACY = [
  { id: 's1', title: '会话一', createdAt: 1000, updatedAt: 3000, runStatus: 'working', messages: [{ role: 'user', content: '你好，迁移' }] },
  { id: 42, title: '数字 id 保真', createdAt: 1000, updatedAt: 2000, messages: [{ role: 'assistant', content: '含 emoji 🚀 与中文' }] },
  { id: 's3', title: '老三', createdAt: 1000, updatedAt: 1000, messages: [] },
]

fs.writeFileSync(legacyFile, JSON.stringify([...LEGACY, 'not-an-object-entry']))
const imported1 = await importLegacySessions(legacyFile, { mode: 'merge' })
await check('merge 导入：3 有效条目入库 + 非对象条目 warning', () => {
  assert.equal(imported1.ok, true)
  assert.equal(imported1.imported, 3)
  assert.equal(imported1.skipped, 0)
  assert.equal(imported1.warnings.length, 1)
})
const listed = JSON.parse(await getSessions())
await check('payload 全文保真 + id 类型保真 + updatedAt desc 排序', () => {
  assert.equal(listed.length, 3)
  assert.equal(listed[0].id, 's1')               // updatedAt 3000 居首
  assert.equal(listed[1].id, 42)                 // 数字 id 仍为数字（非字符串化）
  assert.equal(listed[2].id, 's3')
  assert.deepEqual(listed[0].messages, LEGACY[0].messages)
  assert.equal(listed[0].title, '会话一')
})
const imported2 = await importLegacySessions(legacyFile, { mode: 'merge' })
await check('merge 幂等重跑：imported=0 / skipped=3 / 无重复行', async () => {
  assert.equal(imported2.imported, 0)
  assert.equal(imported2.skipped, 3)
  assert.equal(await prisma.session.count(), 3)
})

const replaceFile = path.join(tmp, 'replace-sessions.json')
fs.writeFileSync(replaceFile, JSON.stringify([{ id: 'new1', title: '替换后', updatedAt: 9000, messages: [] }]))
const replaced = await importLegacySessions(replaceFile, { mode: 'replace' })
await check('replace 模式：事务内全量替换（旧行清空）', async () => {
  assert.equal(replaced.ok, true)
  assert.equal(replaced.imported, 1)
  assert.equal(await prisma.session.count(), 1)
  assert.deepEqual(JSON.parse(await getSessions()).map(x => x.id), ['new1'])
})

const materialized = path.join(tmp, 'materialized-sessions.json')
const mat = await materializeSessions(materialized)
await check('物化导出：文件数组与 DB 逐条一致 + Python compact 序列化', async () => {
  assert.equal(mat.ok, true)
  assert.equal(mat.count, 1)
  const text = fs.readFileSync(materialized, 'utf8')
  assert.ok(text.startsWith('[{"id": "new1"'))   // Python json.dumps 分隔符 ': '
  assert.deepEqual(JSON.parse(text), JSON.parse(await getSessions()))
})

// ---- 事务回滚（批中条目触发 Prisma 类型错误 → 整批回滚）----
const dupFile = path.join(tmp, 'dup-sessions.json')
fs.writeFileSync(dupFile, JSON.stringify([
  { id: 'good', title: '好条目', updatedAt: 1, messages: [] },
  { id: 'bad', title: 'runStatus 数字类型违例', runStatus: 123, updatedAt: 2, messages: [] },
]))
const dup = await importLegacySessions(dupFile, { mode: 'merge' })
await check('故障注入：批中类型违例 → 整批回滚（零部分导入）', async () => {
  assert.ok(dup.error)
  assert.equal(await prisma.session.count(), 1)   // 仍是 replace 后的 new1
})

// ---- switchDatabase：live binding + 新旧库读写隔离 ----
const secondDb = path.join(tmp, 'second.db')
const switched = await switchDatabase(secondDb)
await check('switchDatabase：换绑成功且报告旧路径', () => {
  assert.equal(switched.ok, true)
  assert.equal(switched.switched, true)
  assert.equal(switched.previousPath, path.join(tmp, 'main.db'))
})
await saveSessions(JSON.stringify([{ id: 'switched-in', title: '新库会话', updatedAt: 5000, messages: [] }]))
await check('换绑后写入落到新库；物化反映新库内容', async () => {
  assert.deepEqual(JSON.parse(await getSessions()).map(x => x.id), ['switched-in'])
  assert.equal(await prisma.session.count(), 1)
  const m = await materializeSessions(path.join(tmp, 'second-sessions.json'))
  assert.equal(m.count, 1)
})
const back = await switchDatabase(path.join(tmp, 'main.db'))
await check('切回旧库：旧数据原地保留（无覆盖无丢失）', async () => {
  assert.equal(back.ok, true)
  assert.deepEqual(JSON.parse(await getSessions()).map(x => x.id), ['new1'])
})
const failedSwitch = await switchDatabase(path.join(tmp, 'main.db', 'not-a-dir', 'x.db'))
await check('目标不可达：不换绑 + 旧库继续服务', async () => {
  assert.ok(failedSwitch.error)
  assert.deepEqual(JSON.parse(await getSessions()).map(x => x.id), ['new1'])
})

// ---- bootstrapLegacyImport：备份/标记/幂等/原文件不动 ----
const cfgSessions = path.join(process.env.HARBOR_CONFIG_DIR, 'sessions.json')
fs.writeFileSync(cfgSessions, JSON.stringify([{ id: 'boot1', title: '启动导入', updatedAt: 7000, messages: [] }]))
const boot1 = await bootstrapLegacyImport()
await check('bootstrap：导入 + Meta 标记 + 备份生成（原文件字节不变）', async () => {
  assert.equal(boot1.ok, true)
  assert.equal(boot1.imported, 1)
  assert.equal(fs.readFileSync(cfgSessions, 'utf8'), JSON.stringify([{ id: 'boot1', title: '启动导入', updatedAt: 7000, messages: [] }]))
  assert.equal(fs.readFileSync(`${cfgSessions}${MIGRATION_BACKUP_SUFFIX}`, 'utf8'),
    fs.readFileSync(cfgSessions, 'utf8'))
  const meta = await prisma.meta.findUnique({ where: { key: MIGRATION_META_KEY } })
  assert.ok(meta && JSON.parse(meta.value).imported === 1)
})
const boot2 = await bootstrapLegacyImport()
await check('bootstrap 幂等：重跑 imported=0/skipped=1、备份不覆盖', async () => {
  assert.equal(boot2.imported, 0)
  assert.equal(boot2.skipped, 1)
  assert.equal(fs.readFileSync(`${cfgSessions}${MIGRATION_BACKUP_SUFFIX}`, 'utf8'),
    fs.readFileSync(cfgSessions, 'utf8'))
})
fs.writeFileSync(cfgSessions, '{corrupt-json')
const bootBad = await bootstrapLegacyImport()
await check('bootstrap 源损坏：错误返回 + 无新标记 + 备份保持', async () => {
  assert.ok(bootBad.error)
  const meta = await prisma.meta.findUnique({ where: { key: MIGRATION_META_KEY } })
  assert.equal(JSON.parse(meta.value).imported, 1)   // 标记未被错误覆盖
})

// ---- import 期零迁移副作用（staging 9c6fa8c 回归项）----
const cfgDir = process.env.HARBOR_CONFIG_DIR
const before = new Set(fs.readdirSync(cfgDir))
await import('../src/services/session-migrate.js')
await check('import 期零副作用：无新增迁移产物文件', () => {
  const after = fs.readdirSync(cfgDir)
  assert.deepEqual(after.sort(), [...before].sort())
})

await disconnectDb()
console.log(JSON.stringify({ ok: true, node: process.version, checks: results.length, results }, null, 2))
