/**
 * P0-2 显式迁移 CLI（§4.1 入口纪律：除生产启动外的唯一合法触发口）：
 *   npm run migrate:legacy -- --source=<path/to/sessions.json> --db=<path/to/harbor.db>
 *
 * 用途：临时副本验证（verify-migration.mjs 驱动）与运维手动迁移。
 * 数据保护：只读源文件；备份 <source>.pre-node-migration.bak（已存在不覆盖）；
 * 原 sessions.json 永不删除不改写；单事务失败整批回滚。
 */
import path from 'node:path'

function parseArgs(argv) {
  const out = { source: null, db: null }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--source' && argv[i + 1]) { out.source = argv[++i]; continue }
    if (argv[i].startsWith('--source=')) { out.source = argv[i].slice('--source='.length); continue }
    if (argv[i] === '--db' && argv[i + 1]) { out.db = argv[++i]; continue }
    if (argv[i].startsWith('--db=')) { out.db = argv[i].slice('--db='.length); continue }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.source || !args.db) {
  console.error('usage: npm run migrate:legacy -- --source=<sessions.json> --db=<harbor.db>')
  process.exit(4)
}

// DATABASE_URL 必须在 db.js 首次 import 前注入（config.js 在 import 期解析）
process.env.DATABASE_URL = `file:${path.resolve(args.db)}`
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent'

const { bootstrapLegacyImport } = await import('../services/session-migrate.js')
const { disconnectDb } = await import('../db.js')

const result = await bootstrapLegacyImport({ source: path.resolve(args.source) })
console.log(JSON.stringify(result))
await disconnectDb()
process.exit(result.error ? 1 : 0)
