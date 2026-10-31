/**
 * P0-2 存储迁移三原语（session-migrate.js）：
 *   - importLegacySessions(sourceJsonPath, {mode})：legacy sessions.json → DB
 *     （merge=DB 已有同 id 跳过不覆盖；replace=事务内全量替换——WebDAV restore 语义）；
 *   - materializeSessions(destJsonPath)：DB → legacy 数组原文（物化导出视图）；
 *   - switchDatabase：db.js 换绑原语（ESM live binding）——经本模块统一出口
 *     （共享知识纪律 §8.1：任何 sessions.json 场景只经这两个转换函数，
 *     禁止手写第二份 DB↔JSON 转换逻辑）。
 *
 * 触发纪律（staging 泄漏 9c6fa8c 教训固化）：本模块所有函数只在生产启动
 * 流程（index.js）或显式 CLI 被调用——模块 import 期零副作用；测试入口
 * （run-diff / contract-* / node-driver）在隔离 CONFIG_DIR 下运行，永不触发迁移。
 *
 * 数据保护（R1/R4）：legacy 原文件永不删除不改写；备份已存在不覆盖；
 * 整批单事务（失败整批回滚）；Meta 标记最后写（崩溃重入幂等）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { prisma, ensureSchema } from '../db.js'
import { CONFIG_DIR } from '../paths.js'

export { switchDatabase, currentDbPath } from '../db.js'

export const LEGACY_SESSIONS_FILE = 'sessions.json'
export const MIGRATION_META_KEY = 'migration_legacy_sessions'
export const MIGRATION_BACKUP_SUFFIX = '.pre-node-migration.bak'

/** 与 sessions.js 相同的索引列抽取规则（payload 原文优先；id 类型保真）。 */
function toRecord(entry) {
  const toText = (value, fallback = '') => (value == null ? fallback : String(value))
  const toBigInt = (value, fallback = 0) => {
    const num = Number(value)
    return Number.isFinite(num) && num > 0 ? BigInt(Math.trunc(num)) : BigInt(fallback)
  }
  return {
    title: toText(entry.title),
    createdAt: toBigInt(entry.createdAt, Date.now()),
    updatedAt: toBigInt(entry.updatedAt, Date.now()),
    runStatus: entry.runStatus ?? null,
    projectId: entry.projectId == null ? null : toText(entry.projectId),
    projectName: entry.projectName == null ? null : toText(entry.projectName),
    projectWorkspace: entry.projectWorkspace == null ? null : toText(entry.projectWorkspace),
    payload: JSON.stringify(entry),
  }
}

/**
 * legacy → DB 导入（§4.1）。
 * - 非对象条目跳过并计 warning（不阻塞迁移）；
 * - merge：已有同 id 跳过（update:{} 空写——保守不覆盖），imported=实际新建数；
 * - replace：事务内 deleteMany+逐条写入（Python 文件级替换语义）。
 * 整批在单事务内（R4：失败整批回滚，标记由调用方最后写）。
 */
export async function importLegacySessions(sourceJsonPath, { mode = 'merge' } = {}) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(sourceJsonPath, 'utf8'))
  } catch (error) {
    return { error: `legacy sessions 读取失败: ${error.message}` }
  }
  if (!Array.isArray(parsed)) return { error: 'legacy sessions 不是 JSON 数组' }
  const warnings = []
  const entries = []
  parsed.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || item.id === undefined || item.id === null) {
      warnings.push(`跳过非会话条目 index=${index}`)
      return
    }
    entries.push(item)
  })
  try {
    let imported = 0
    let skipped = 0
    await prisma.$transaction(async tx => {
      if (mode === 'replace') await tx.session.deleteMany({})
      for (const entry of entries) {
        const id = String(entry.id)
        const record = toRecord(entry)
        if (mode === 'replace') {
          await tx.session.upsert({ where: { id }, create: { id, ...record }, update: record })
          imported += 1
        } else {
          // merge：DB 已有同 id 跳过（空 update 不覆盖）；新建才计数
          const existing = await tx.session.findUnique({ where: { id } })
          if (existing) { skipped += 1; continue }
          await tx.session.create({ data: { id, ...record } })
          imported += 1
        }
      }
    })
    return { ok: true, imported, skipped, warnings }
  } catch (error) {
    return { error: `导入失败（整批已回滚）: ${error.message}` }
  }
}

/** Python json.dumps(ensure_ascii=False) 兼容序列化：compact + ', '/': ' 分隔符
 * （Python sessions.json 落盘格式；物化导出须与 legacy 文件同形）。
 * 输入仅 JSON 可表示类型（payload 经 JSON.parse 的纯数据），逐层递归输出。 */
function pyJsonDumps(value) {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(pyJsonDumps).join(', ')}]`
  if (typeof value === 'object') {
    return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${pyJsonDumps(v)}`).join(', ')}}`
  }
  return JSON.stringify(value)
}

/** 原子文本写（tmp + rename，与 paths.atomicWriteJson 同模式）。 */
function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

/** DB → legacy 数组原文物化导出（§4.1/§8.1 唯一转换口）。
 * 按 updatedAt desc（与 getSessions 同序）；序列化 ensure_ascii=false 口径
 * 对齐 Python json.dumps（非 ASCII 不转义）；原子写防半截文件（R9）。 */
export async function materializeSessions(destJsonPath, client = prisma) {
  const rows = await client.session.findMany({ orderBy: { updatedAt: 'desc' } })
  const entries = rows.map(row => JSON.parse(row.payload))
  atomicWriteText(destJsonPath, pyJsonDumps(entries))
  return { ok: true, path: destJsonPath, count: entries.length }
}

/** 备份先行（R1）：<source>.pre-node-migration.bak——已存在不覆盖（保留最早证据）。 */
export function backupOnce(sourcePath, suffix = MIGRATION_BACKUP_SUFFIX) {
  const backup = `${sourcePath}${suffix}`
  if (fs.existsSync(backup)) return backup
  fs.copyFileSync(sourcePath, backup)
  return backup
}

async function readMeta(key) {
  const row = await prisma.meta.findUnique({ where: { key } })
  return row ? row.value : null
}

async function writeMeta(key, value) {
  await prisma.meta.upsert({
    where: { key },
    create: { key, value: JSON.stringify(value) },
    update: { value: JSON.stringify(value) },
  })
}

/**
 * bootstrap 一次性/增量导入（§4.1，幂等可重入）：
 *   1. 默认/配置 history 目录 sessions.json 存在性检测 + Meta 标记；
 *   2. 备份先行（不覆盖）；3. merge 增量导入（只补 DB 没有的 id）；
 *   4. Meta 标记最后写（崩溃回滚 → 下次启动重试）。
 * 无存量且未迁移 → 写标记 {imported:0} 退出（§5.2 同款空跑口径）。
 * 并存期语义：Python 回退产生的新会话，下次启动增量 merge 补齐。
 */
export async function bootstrapLegacyImport({ source = null } = {}) {
  const legacyPath = source || path.join(CONFIG_DIR, LEGACY_SESSIONS_FILE)
  await ensureSchema(prisma)   // 历史库补 Meta（幂等）
  const marker = await readMeta(MIGRATION_META_KEY)
  if (!fs.existsSync(legacyPath)) {
    if (marker) return { ok: true, imported: 0, skipped: 0, already: true }
    await writeMeta(MIGRATION_META_KEY, { at: new Date().toISOString(), source: null, imported: 0, skipped: 0 })
    return { ok: true, imported: 0, skipped: 0 }
  }
  backupOnce(legacyPath)
  const result = await importLegacySessions(legacyPath, { mode: 'merge' })
  if (result.error) return result
  if (!marker) {
    await writeMeta(MIGRATION_META_KEY, {
      at: new Date().toISOString(), source: legacyPath,
      imported: result.imported, skipped: result.skipped,
    })
  }
  return result
}
