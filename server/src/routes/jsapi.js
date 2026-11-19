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
import { resolveContext, runWithContext } from '../session-context.js'

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
      // P0-3：请求级 sid 路由（X-Harbor-Sid 头 → ALS；无头=legacy 逐字节行为）
      return await runWithContext(resolveContext(request), async () => {
        // V4-H 前置护栏：仅当请求显式声明来自 Agent 工具循环时生效。
        // 理由：jsapi 同时承载 UI 直接调用，7 个方法名与高危工具名重合（browser_click 等），
        // 若默认启用会把 UI 交互全部拦成 CONFIRM_REQUIRED。
        const isAgentLoop = request.headers['x-harbor-agent-loop'] === '1'
        if (process.env.LIGHTWELL_HARNESS_V4H === '1' && isAgentLoop) {
          const {
            getSharedGuardrailEngine,
            extractBusinessArgsForSchema,
            toModelToolName,
          } = await import('../services/harness/executionGuardrails.mjs')
          const { getCachedToolRegistry } = await import('../services/harness/providerBridge.mjs')
          // 残留 #4：短周期缓存版（同 sid 同参数 1.5s 内复用），避免每请求重装 30+ 工具定义
          const { assembleToolListCached } = await import('../services/provider.js')

          const method = request.params.method
          const sessionId = String(request.headers['x-harbor-sid'] || 'default')
          // A-02 / A-03：位置参 → 纯业务参数。jsapi 的实参是位置数组
          // （如 delete_path = [path, recycle, token]），旧实现只认对象型 args[0]，
          // 导致 firstArg 恒 {} —— 参数 Schema 一维永远拿不到输入。
          const businessArgs = extractBusinessArgsForSchema(method, args)
          // A-14：方法名域与工具名域分离。set_clipboard 的方法名对应的模型工具名是
          // clipboard_write，直接用方法名查注册表会 miss → parameterSchema 为 null。
          let parameterSchema = null
          try {
            const tools = await assembleToolListCached('full', false, true, false)
            // 残留 #3：getSchemaOnly 是纯只读查询，不推进缓存注册表的 LRU/TTL
            // （inspectSchema 会 activateTools，等于「查一次就激活一格」）。
            const inspected = getCachedToolRegistry(tools).getSchemaOnly(toModelToolName(method))
            parameterSchema = inspected && inspected.ok ? inspected.schema.function.parameters : null
          } catch { /* Schema 回查失败降级为「无 Schema 校验」，其余四维仍然生效 */ }

          // A-04：模块级单例，否则 _recentWrites 随请求销毁，幂等门形同虚设。
          const engine = getSharedGuardrailEngine()
          const check = engine.evaluatePreFlight({
            toolName: method,
            args: businessArgs,
            confirmed: request.headers['x-harbor-confirmed'] === '1',
            parameterSchema,
            sessionId,
          })
          if (!check.allowed) {
            return JSON.stringify({
              ok: false,
              error: {
                code: check.code,
                message: check.message,
                requiresConfirmation: Boolean(check.requiresConfirmation),
              },
            })
          }

          const rawResult = await invoke(method, args)
          // 残留 #1：幂等键只在「真的写成功」之后登记。执行前登记会让首次失败
          // （路径不存在 / 权限拒绝）把 5s 内的合法重试误拦成 DUPLICATE_IDEMPOTENT_WRITE。
          let execOk = true
          try {
            const parsedRes = typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult
            if (parsedRes && parsedRes.ok === false) execOk = false
          } catch { /* 非 JSON 返回（纯文本/空串）视为执行完成 */ }
          if (execOk) {
            engine.recordSuccessfulWrite({ toolName: method, args: businessArgs, sessionId })
          }
          return rawResult
        }
        return invoke(request.params.method, args)
      })
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
