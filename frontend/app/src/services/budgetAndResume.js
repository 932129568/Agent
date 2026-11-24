/**
 * 成本失控三维熔断 + 中断续跑分类 + 浏览器验证码人工接管检测（纯函数，可直接 L1 单测）。
 */
export function createCostDefense({ sessionBudgetRmb = 0, pricePer1kTokens = 0.002 } = {}) {
  const sigCounts = new Map()
  let noProgressRounds = 0
  let lastFactsCount = 0

  return {
    checkBudget(spentTokens = 0) {
      const limit = Number(sessionBudgetRmb) || 0
      if (limit <= 0) return null
      const spent = (Number(spentTokens) / 1000) * pricePer1kTokens
      if (spent >= limit) {
        return { stop: true, reason: 'BUDGET_EXCEEDED', spent: Number(spent.toFixed(4)), budget: limit }
      }
      return null
    },
    registerToolSignature(sig) {
      const n = (sigCounts.get(sig) || 0) + 1
      sigCounts.set(sig, n)
      if (n >= 3) return { loop: true, count: n, sig }
      return { loop: false, count: n, sig }
    },
    registerProgress(factsCount) {
      if (factsCount > lastFactsCount) {
        lastFactsCount = factsCount
        noProgressRounds = 0
      } else {
        noProgressRounds++
      }
      return { stalled: noProgressRounds >= 10, noProgressRounds }
    },
  }
}

export function isResumableError(msg) {
  const m = String(msg || '')
  return /(Failed to fetch|NetworkError|network|timeout|timed? ?out|socket|ECONN|EPIPE|fetch failed|HTTP 5\d\d|HTTP 429|aborted|USER_PAUSED|连接|超时|限流|中止)/i.test(m)
    && !/HTTP 40[13]\b/i.test(m)
}

export function shouldOfferResume(session) {
  if (!session || !Array.isArray(session.messages) || !session.messages.length) return false
  return session.runStatus === 'paused'
}

export function detectTakeoverRequired(rawResult) {
  let obj = rawResult
  if (typeof rawResult === 'string') {
    try { obj = JSON.parse(rawResult) } catch { return null }
  }
  if (!obj || typeof obj !== 'object') return null
  const code = String((obj.error && obj.error.code) || obj.code || '')
  if (code === 'CAPTCHA_REQUIRED' || obj.takeover_id) {
    return {
      takeoverId: String(obj.takeover_id || (obj.error && obj.error.takeover_id) || ''),
      url: String(obj.url || ''),
      message: String((obj.error && obj.error.message) || obj.message || '检测到验证码或登录拦截，需要人工接管浏览器完成验证后继续'),
    }
  }
  return null
}
