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
