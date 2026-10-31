/**
 * better-auth 接入（libsql / Kysely 方言）。
 *
 * 使用边界（重要）：本模块只**挂载认证能力**，不默认给业务路由加鉴权。
 * Harbor 现为单机单用户语义，`AUTH_ENABLED=false` 时 /jsapi 不设防；
 * 只有显式打开开关才应在路由层启用会话校验（另见 app.js 注释）。
 *
 * 数据库：**独立 auth 库文件**，不与 Prisma 的 Session 表共库——
 * SQLite 表名不区分大小写，better-auth 的 `session` 表会与 Prisma 的
 * `Session` 表直接冲突（实测报 table "session" already exists）。
 */
import { betterAuth } from 'better-auth'
import { Kysely } from 'kysely'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import path from 'node:path'
import { config } from './config.js'
import { sqlitePath } from './db.js'
import { childLogger } from './logger.js'

const log = childLogger('auth')

export const authSqlitePath = path.join(path.dirname(sqlitePath), 'harbor-auth.db')

const kysely = new Kysely({
  dialect: new LibsqlDialect({ url: `file:${authSqlitePath}` }),
})

const secret = process.env.AUTH_SECRET || ''
if (config.AUTH_ENABLED === 'true' && secret.length < 32) {
  log.warn('AUTH_ENABLED=true 但 AUTH_SECRET 缺失或过短（<32 字符），生产环境必须设置')
}

export const auth = betterAuth({
  database: { db: kysely, type: 'sqlite' },
  secret: secret || 'harbor-local-dev-secret-not-for-production',
  baseURL: `http://${config.HOST}:${config.PORT}`,
  emailAndPassword: { enabled: true },
  // 纯本机部署：不启用社交登录、不启用 RateLimit 云侧能力
  advanced: { disableCSRFCheck: false },
})

export const authEnabled = config.AUTH_ENABLED === 'true'
