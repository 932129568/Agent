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

export function normalizeError(payload, fallbackCode = 'UNKNOWN') {
  if (payload instanceof HarborError) return payload
  if (payload && payload.error) {
    const e = payload.error
    const msg = typeof e === 'string' ? e : (e.message || e.code || '操作失败')
    return new HarborError(String((e && e.code) || fallbackCode), String(msg), {
      hint: (e && e.hint) || '',
      cause: payload,
    })
  }
  if (payload instanceof Error) return new HarborError(fallbackCode, payload.message, { cause: payload })
  return new HarborError(fallbackCode, String(payload || '未知错误'))
}

export const isAbort = (err) =>
  !!err && (err.name === 'AbortError' || err.code === 'ABORTED' || err.code === 'USER_PAUSED')
