/**
 * /jsapi 路由：复刻 pywebview `callApi(name, argsArray)` 的调用约定。
 *
 *   请求  POST /jsapi/<method>   body: { "args": [...] }（也接受裸数组）
 *   响应  字符串原文（legacy 各方法本就返回 JSON 字符串，前端 JSON.parse 后消费）
 *
 * 这样前端桥只需把 `window.pywebview.api[name](...args)` 换成一次 fetch，
 * 返回类型与既有代码完全一致，不需要逐点改业务逻辑。
 */
import { z } from 'zod'
import { invoke, JsApiError } from '../registry.js'

const BodySchema = z.union([
  z.object({ args: z.array(z.any()).default([]) }).passthrough(),
  z.array(z.any()),
])

export async function jsapiRoutes(app) {
  app.post('/jsapi/:method', async (request, reply) => {
    const parsed = BodySchema.safeParse(request.body ?? { args: [] })
    if (!parsed.success) {
      reply.code(400)
      return JSON.stringify({
        ok: false,
        error: { code: 'BAD_PARAMS', message: 'body 必须是 {args:[...]} 或数组', detail: parsed.error.issues },
      })
    }
    const args = Array.isArray(parsed.data) ? parsed.data : parsed.data.args
    try {
      return await invoke(request.params.method, args)
    } catch (error) {
      if (error instanceof JsApiError) {
        // 未迁移：200 + 结构化错误串，交给前端既有降级逻辑，而不是 500
        return JSON.stringify({
          ok: false,
          error: { code: error.code, message: error.message, hint: error.hint },
        })
      }
      // 路径越界属于「业务拒绝」：legacy 返回 {error:...} 文本供 Agent 阅读并自我纠正，
      // 不能映射成 500（那会让前端抛异常、丢掉可读的拒绝原因）
      if (error && error.code === 'PATH_JAIL') {
        return JSON.stringify({ error: error.message })
      }
      request.log.error({ err: error, method: request.params.method }, 'jsapi invoke failed')
      reply.code(500)
      return JSON.stringify({
        ok: false,
        error: { code: 'INTERNAL', message: String(error && error.message ? error.message : error) },
      })
    }
  })
}
