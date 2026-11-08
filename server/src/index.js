/**
 * 进程入口：仅绑定 loopback，带优雅停机。
 */
import { buildServer } from './app.js'
import { config } from './config.js'
import { logger } from './logger.js'
import { disconnectDb } from './db.js'

const app = await buildServer()

async function shutdown(signal) {
  logger.info({ signal }, 'shutting down')
  try {
    await app.close()
    await disconnectDb()
  } finally {
    process.exit(0)
  }
}

process.on('SIGINT', () => { shutdown('SIGINT') })
process.on('SIGTERM', () => { shutdown('SIGTERM') })
// R37 修复（S2-15）：进程级兜底——单个游离 rejection 原会以未处理异常击穿
// 进程（Electron 宿主下=整窗崩溃）。记录不退出：桌面单用户场景可用性优先。
process.on('unhandledRejection', reason => { logger.error({ err: reason }, 'unhandledRejection') })
process.on('uncaughtException', err => { logger.error({ err }, 'uncaughtException') })

try {
  await app.listen({ host: config.HOST, port: config.PORT })
  logger.info({ host: config.HOST, port: config.PORT }, 'harbor-server listening')
} catch (error) {
  logger.error({ err: error }, 'listen failed')
  process.exit(1)
}

// P0-2：生产启动一次性后台迁移任务链（listen 成功后、不阻塞服务）——
// ① legacy sessions.json → DB 增量导入；② 存量明文密钥 DPAPI 迁移。
// 纪律（staging 9c6fa8c 教训）：仅本生产入口触发；buildServer 测试入口与
// run-diff / contract-* / node-driver 永不触发迁移（隔离 CONFIG_DIR 为唯一范式）。
try {
  const { bootstrapLegacyImport } = await import('./services/session-migrate.js')
  const { migratePlaintextSecrets } = await import('./services/dpapi-migrate.js')
  ;(async () => {
    const result = await bootstrapLegacyImport()
    if (result.error) logger.error({ err: result.error }, 'legacy sessions 迁移失败（下回启动重试）')
    else logger.info({ imported: result.imported, skipped: result.skipped }, 'legacy sessions 迁移完成')
    const secrets = await migratePlaintextSecrets()
    if (secrets.error) logger.warn({ err: secrets.error, pending: secrets.pending }, '存量明文密钥迁移延后（W17）')
    else logger.info({ migrated: secrets.migrated }, '存量明文密钥 DPAPI 迁移完成')
  })().catch(error => logger.error({ err: error }, '存储迁移后台任务异常（下回启动重试）'))
} catch (error) {
  logger.error({ err: error }, '存储迁移挂接失败（不影响服务）')
}
