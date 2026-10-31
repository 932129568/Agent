/**
 * better-auth 的 Web Standard handler 适配到 fastify。
 * 路由：`ALL /api/auth/*`（注册/登录/会话等全部交给 better-auth）。
 */
import { auth } from '../auth.js'

export async function authRoutes(app) {
  app.all('/api/auth/*', async (request, reply) => {
    const url = new URL(request.raw.url, `http://${request.headers.host || 'localhost'}`)
    const headers = new Headers()
    Object.entries(request.headers).forEach(([key, value]) => {
      if (typeof value === 'string') headers.set(key, value)
    })

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD' && request.body != null
    const webRequest = new Request(url, {
      method: request.method,
      headers,
      body: hasBody ? JSON.stringify(request.body) : undefined,
    })

    const webResponse = await auth.handler(webRequest)
    reply.code(webResponse.status)
    webResponse.headers.forEach((value, key) => {
      // set-cookie 可能多值，fastify 需要数组形式
      if (key.toLowerCase() === 'set-cookie') return
      reply.header(key, value)
    })
    const cookies = typeof webResponse.headers.getSetCookie === 'function'
      ? webResponse.headers.getSetCookie() : []
    if (cookies.length) reply.header('set-cookie', cookies)

    const text = await webResponse.text()
    return text
  })
}
