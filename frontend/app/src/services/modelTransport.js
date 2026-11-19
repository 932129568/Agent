/**
 * 模型传输契约（规范 §6）。
 *
 * 这是**接口骨架**，B1/B3 迁移时把 legacy 的 ModelTransport 实现搬进来。
 * 迁移必须保住的行为钉（来自 R63/R64 真机修复）：
 *  - local=true 时包装流必须 new Response(wrapped) 重建，禁止 resp.body = wrapped（只读 getter 会静默丢弃）；
 *  - 本地端点同端点 FIFO 槽位，流消费完才释放；
 *  - AbortController 一路传播到 fetch 与 SSE 解析器，暂停要带原因、保留部分正文；
 *  - 免费档节流 / 429 退避 / 5xx 重试集中在此层。
 */
import { HarborError, isAbort } from './errors.js'

export function createModelTransport({ request, parseSse, acquireLocalSlot, onDelta }) {
  if (typeof request !== 'function' || typeof parseSse !== 'function') {
    throw new HarborError('TRANSPORT_CONTRACT', 'modelTransport 缺少 request / parseSse 实现')
  }
  return {
    async *stream({ payload, local = false, signal, endpoint }) {
      const release = local && typeof acquireLocalSlot === 'function'
        ? await acquireLocalSlot(endpoint, signal) : () => {}
      try {
        const response = await request({ payload, local, signal, endpoint })
        for await (const chunk of parseSse(response, signal)) {
          if (signal && signal.aborted) throw new HarborError('USER_PAUSED', '用户暂停')
          if (typeof onDelta === 'function') onDelta(chunk)
          yield chunk
        }
      } catch (error) {
        if (isAbort(error)) throw error
        throw new HarborError('STREAM_FAILED', String(error && error.message || error),
          { cause: error, retryable: true })
      } finally {
        release()
      }
    },
  }
}
