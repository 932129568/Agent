/**
 * 统一错误模型（规范 §6）。
 * 服务层只抛 HarborError；UI 只渲染 message / hint，不解析原始后端对象。
 */
export class HarborError extends Error {
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'HarborError'
    this.code = code
    this.hint = options.hint || ''
    this.cause = options.cause || null
    this.retryable = !!options.retryable
  }
}

/** 把 server 的 {ok:false,error:{code,message,hint}} 与异常统一归一化。 */
export function normalizeError(payload, fallbackCode = 'UNKNOWN') {
  if (payload instanceof HarborError) return payload
  if (payload && payload.error) {
    const e = payload.error
    return new HarborError(String(e.code || fallbackCode), String(e.message || '操作失败'), {
      hint: e.hint || '', cause: payload,
    })
  }
  if (payload instanceof Error) {
    return new HarborError(fallbackCode, payload.message, { cause: payload })
  }
  if (typeof payload === 'string') return new HarborError(fallbackCode, payload)
  return new HarborError(fallbackCode, '未知错误', { cause: payload })
}

export const isAbort = (err) =>
  !!err && (err.name === 'AbortError' || err.code === 'ABORTED' || err.code === 'USER_PAUSED')
