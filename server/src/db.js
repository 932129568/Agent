/**
 * Prisma 连接（Prisma 7 规范）：schema 不含 url，运行期由 driver adapter 连接。
 *
 * 驱动选择（实测）：
 *   - better-sqlite3 在本环境无 node-v153 预编译且 node-gyp 不可用 → 弃用；
 *   - **libsql 在 Node 27 上实测可执行 SQL**，故运行期采用
 *     `@prisma/adapter-libsql` + 生成的 Prisma Client（TypeScript，由 Node 原生
 *     类型擦除直接加载，不需要额外编译步骤）。
 *
 * 表结构由 `prisma/schema.prisma` 定义，`npx prisma db push` 建库。
 *
 * P0-2（存储统一）：
 *   - `export let prisma`（**ESM live binding**——switchDatabase 原子换绑后，
 *     所有 `import { prisma }` 的消费方零改动自动见新 client）；
 *   - `switchDatabase(newDbPath)`：history_dir_set 真实迁移用——目标就绪
 *     （建表验证）→ 同步换绑 → 旧 client 延迟 ~1s 断开（让在途查询完成）；
 *     目标未就绪绝不换绑（fail-safe 回退旧库）；
 *   - `ensureSchema(client)`：与 prisma db push 输出逐字一致的幂等 DDL
 *     （含 Meta 表——历史库补建，避免为补表起子进程）；
 *   - `withDbSwitchLock(fn)`：切换/迁移整段互斥（R3 竞态防线）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from './generated/prisma/client.ts'
import { config } from './config.js'
import { CONFIG_DIR } from './paths.js'

function resolveSqlitePath(databaseUrl) {
  const raw = String(databaseUrl || '').replace(/^file:/, '')
  // R39 修复（S2-12）：相对路径锚 CONFIG_DIR（与 electron/main.js 注入口径一致）
  // ——原锚 process.cwd()，cwd 随启动方式漂移（CLI/服务/不同目录）→ 同一份
  // 缺省 DATABASE_URL 打开不同库文件（「会话丢了」假象）。
  return path.isAbsolute(raw) ? raw : path.resolve(CONFIG_DIR, raw)
}

export let sqlitePath = resolveSqlitePath(config.DATABASE_URL)
fs.mkdirSync(path.dirname(sqlitePath), { recursive: true })

function createClient(dbPath) {
  const adapter = new PrismaLibSql({ url: `file:${dbPath}` })
  return new PrismaClient({ adapter })
}

export let prisma = createClient(sqlitePath)

/** 与 prisma db push 输出逐字一致的幂等 DDL（schema.prisma 为唯一事实源——
 * 改动表结构时同步本常量）。含 Meta 表（P0-2 新增）与两个 Session 索引。 */
const SCHEMA_DDL = [
  `CREATE TABLE IF NOT EXISTS "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL DEFAULT '',
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "runStatus" TEXT,
    "projectId" TEXT,
    "projectName" TEXT,
    "projectWorkspace" TEXT,
    "payload" TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS "Meta" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS "Session_updatedAt_idx" ON "Session"("updatedAt")`,
  `CREATE INDEX IF NOT EXISTS "Session_projectId_idx" ON "Session"("projectId")`,
]

/** 幂等建表（历史库补 Meta / 切换目标库初始化）。Prisma 主路径不可用则抛错——
 * 调用方按 fail-safe 处理（不启动迁移、不换绑）。 */
export async function ensureSchema(client) {
  for (const ddl of SCHEMA_DDL) await client.$executeRawUnsafe(ddl)
}

/** 切换/迁移整段互斥锁（R3：history_dir_set 全流程不得与另一切换交错）。 */
let switchQueue = Promise.resolve()
export function withDbSwitchLock(fn) {
  const run = switchQueue.then(fn, fn)
  switchQueue = run.catch(() => {})
  return run
}

/** 当前生效 DB 文件路径（history_dir_get.sessions_file 的介质披露源）。 */
export function currentDbPath() {
  return sqlitePath
}

/**
 * 原子换绑到目标 DB（§4.2）——**未持锁内核**：仅供已持 withDbSwitchLock 的
 * 调用方（misc.historyDirSet 整段互斥）使用；直接调用请走 switchDatabase 包装。
 * 目标建表验证通过才换绑；旧 client 延迟 ~1s 断开（在途查询收尾）；
 * 目标初始化失败不换绑并回传错误（绝不指向半初始化库）。
 */
export async function switchDatabaseCore(newDbPath) {
  const target = resolveSqlitePath(newDbPath)
  if (target === sqlitePath) return { ok: true, path: sqlitePath, switched: false }
  let next
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    next = createClient(target)
    await next.$connect()
    await ensureSchema(next)
  } catch (error) {
    if (next) await next.$disconnect().catch(() => {})
    return { error: `目标库初始化失败: ${error.message}` }
  }
  const previous = prisma
  const previousPath = sqlitePath
  prisma = next
  sqlitePath = target
  // 旧 client 延迟断开：Node 单线程下换绑后不再有新查询进入旧引用
  setTimeout(() => { previous.$disconnect().catch(() => {}) }, 1000).unref()
  return { ok: true, path: target, previousPath, switched: true }
}

/** 公共入口：互斥锁内换绑（供未持锁的独立调用方；持锁流程请用 Core 内核，
 * 避免外层锁 → 内层锁的自死锁）。 */
export async function switchDatabase(newDbPath) {
  return withDbSwitchLock(() => switchDatabaseCore(newDbPath))
}

export async function disconnectDb() {
  await prisma.$disconnect().catch(() => {})
}

export const driverName = 'prisma+libsql'
