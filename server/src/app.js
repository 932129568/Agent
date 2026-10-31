/**
 * 服务装配：fastify + pino + 路由。listen 与测试共用同一工厂，
 * 保证 smoke 用 `app.inject()` 测到的就是真实运行配置。
 */
import Fastify from 'fastify'
import { config } from './config.js'
import { logger } from './logger.js'
import { listMethods } from './registry.js'
import { jsapiRoutes } from './routes/jsapi.js'
import { authRoutes } from './routes/auth.js'
import { sessionCount } from './services/sessions.js'
import { mcpShutdown } from './services/mcp.js'
import { browserShutdown } from './services/browser.js'

export async function buildServer() {
  const app = Fastify({
    loggerInstance: logger,
    // 与桌面应用交互的载荷可能包含整段会话历史；默认 1MB 上限会误伤正常保存
    bodyLimit: 64 * 1024 * 1024,
    // fastify 5 的顶层 disableRequestLogging 已废弃（fastify 6 移除），
    // 这里不再传任何请求日志开关：静默由 pino 的 level='silent' 承担。
  })

  // CORS 默认关闭：本服务未来会承载文件/命令能力，绝不输出 `Access-Control-Allow-Origin: *`。
  // 仅当显式配置 CORS_ORIGIN（精确匹配，逗号分隔）时放行对应源；
  // 浏览器直开 file:// 调试时源为字符串 "null"，需显式配置 CORS_ORIGIN=null。
  if (config.CORS_ORIGIN) {
    const allowed = new Set(config.CORS_ORIGIN.split(',').map(item => item.trim()).filter(Boolean))
    app.addHook('onRequest', async (request, reply) => {
      const origin = request.headers.origin
      if (!origin || !allowed.has(origin)) return
      reply.header('Access-Control-Allow-Origin', origin)
      reply.header('Vary', 'Origin')
      reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
      reply.header('Access-Control-Allow-Headers', 'content-type')
      if (request.method === 'OPTIONS') {
        reply.code(204)
        return reply.send()
      }
    })
  }

  app.get('/health', async () => ({    ok: true,
    service: 'harbor-server',
    node: process.version,
    methods: listMethods().length,
    sessions: await sessionCount(),
    auth: config.AUTH_ENABLED === 'true',
  }))

  app.get('/', async () => ({
    service: 'harbor-server',
    health: '/health',
    jsapi: 'POST /jsapi/:method',
    methods: listMethods(),
  }))

  await app.register(jsapiRoutes)
  // better-auth 已挂载（/api/auth/*）。注意：业务路由默认**不**加鉴权，
  // 保持单机单用户语义；启用强制鉴权属于独立变更，需先评估对桌面前端的影响。
  await app.register(authRoutes)

  // 服务退出必须关闭 MCP 子进程与浏览器，避免桌面壳重启后遗留孤儿进程。
  app.addHook('onClose', async () => {
    await mcpShutdown().catch(() => {})
    await browserShutdown().catch(() => {})
  })

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      ok: false,
      error: { code: 'NOT_FOUND', message: `${request.method} ${request.url}` },
    })
  })

  return app
}
