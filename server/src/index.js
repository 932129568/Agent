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

try {
  await app.listen({ host: config.HOST, port: config.PORT })
  logger.info({ host: config.HOST, port: config.PORT }, 'harbor-server listening')
} catch (error) {
  logger.error({ err: error }, 'listen failed')
  process.exit(1)
}

// P0-2：生产启动一次性后台迁移任务（listen 成功后、不阻塞服务）——
// legacy sessions.json → DB 增量导入（幂等可重入；原文件永不删除不改写）。
// 纪律（staging 9c6fa8c 教训）：仅本生产入口触发；buildServer 测试入口与
// run-diff / contract-* / node-driver 永不触发迁移（隔离 CONFIG_DIR 为唯一范式）。
try {
  const { bootstrapLegacyImport } = await import('./services/session-migrate.js')
  bootstrapLegacyImport().then(result => {
    if (result.error) logger.error({ err: result.error }, 'legacy sessions 迁移失败（下回启动重试）')
    else logger.info({ imported: result.imported, skipped: result.skipped }, 'legacy sessions 迁移完成')
  }).catch(error => logger.error({ err: error }, 'legacy sessions 迁移异常（下回启动重试）'))
} catch (error) {
  logger.error({ err: error }, 'legacy sessions 迁移挂接失败（不影响服务）')
}
