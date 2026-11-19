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
 *
 * R64 冷启动懒化（module-optimization-r64.md F8）：better-auth+kysely+
 * libsql-kysely 三件套静态 import 实测 755ms（占 server 冷 import 60%），
 * 而单机默认 AUTH_ENABLED=false、前端零直调 /api/auth/*——改为**首次
 * /api/auth/* 请求时动态 import**（ensureAuth 单飞）。冷启动 1245→约 490ms。
 */
import path from 'node:path'
import { config } from './config.js'
import { sqlitePath } from './db.js'

export const authSqlitePath = path.join(path.dirname(sqlitePath), 'harbor-auth.db')

export const authEnabled = config.AUTH_ENABLED === 'true'

const secret = process.env.AUTH_SECRET || ''
if (config.AUTH_ENABLED === 'true' && secret.length < 32) {
  // R40 修复（S2-21）：fail-fast 拒绝启动——原仅 warn 后回落固定 dev 密钥，
  // 显式开启认证却得到「人人皆知的密钥」比不认证更危险（假性安全）。
  throw new Error('AUTH_ENABLED=true 但 AUTH_SECRET 缺失或过短（<32 字符）——'
    + '拒绝以固定 dev 密钥启动。请设置强随机的 AUTH_SECRET（openssl rand -base64 48），'
    + '或显式关闭 AUTH_ENABLED。')
}

let _authPromise = null

/** 单飞懒建 better-auth 实例（首个 /api/auth/* 请求触发；此后命中缓存）。 */
export function ensureAuth() {
  if (!_authPromise) {
    _authPromise = (async () => {
      const [{ betterAuth }, { Kysely }, { LibsqlDialect }] = await Promise.all([
        import('better-auth'),
        import('kysely'),
        import('@libsql/kysely-libsql'),
      ])
      const kysely = new Kysely({
        dialect: new LibsqlDialect({ url: `file:${authSqlitePath}` }),
      })
      return betterAuth({
        database: { db: kysely, type: 'sqlite' },
        secret: secret || 'harbor-local-dev-secret-not-for-production',
        baseURL: `http://${config.HOST}:${config.PORT}`,
        emailAndPassword: { enabled: true },
        // 纯本机部署：不启用社交登录、不启用 RateLimit 云侧能力
        advanced: { disableCSRFCheck: false },
      })
    })().catch(e => { _authPromise = null; throw e })   // 失败复位：下次请求重试
  }
  return _authPromise
}
