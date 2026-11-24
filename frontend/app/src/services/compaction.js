/**
 * 历史压缩与锚点摘要（纯函数，继承 TOK-1 / TOK-2 / I10 全部行为钉）：
 * - stride 采样估算 Token（每 3000 字符采 1000，ASCII/3.5 + 非ASCII/1.8，抗中英混排偏差）；
 * - 缓存优先双条件触发（命中率 >=50% 时阈值放宽 1.5×，保护 5× 前缀缓存）；
 * - 幂等锚点摘要（__anchorDigest）：提取决策、文件路径与约束，二次压缩不重复叠摘要。
 */
const SAVER_THRESHOLDS = Object.freeze({ aggressive: 45000, std: 90000, relaxed: 140000 })
const LOCAL_RATIOS = Object.freeze({ aggressive: 0.4, std: 0.6, relaxed: 0.8 })

export function estTokens(text) {
  const s = String(text == null ? '' : text)
  const n = s.length
  if (n === 0) return 0
  if (n <= 3000) {
    let ascii = 0
    for (let i = 0; i < n; i++) if (s.charCodeAt(i) < 128) ascii++
    return Math.ceil(ascii / 3.5 + (n - ascii) / 1.8)
  }
  let sampled = 0
  let ascii = 0
  for (let start = 0; start < n; start += 3000) {
    const end = Math.min(n, start + 1000)
    for (let i = start; i < end; i++) {
      if (s.charCodeAt(i) < 128) ascii++
    }
    sampled += (end - start)
  }
  const sampledTok = ascii / 3.5 + (sampled - ascii) / 1.8
  return Math.ceil(sampledTok * (n / Math.max(1, sampled)))
}

export function historyTokens(messages) {
  return (Array.isArray(messages) ? messages : []).reduce((sum, m) => {
    if (!m) return sum
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')
    const r = typeof m.reasoning === 'string' ? m.reasoning : ''
    return sum + estTokens(c) + Math.ceil(estTokens(r) * 0.2) + 8
  }, 0)
}

export function computeCompactThreshold({ level = 'std', localMode = false, localCtxWindow = 8192, cacheHitRate = 0 } = {}) {
  const base = localMode
    ? Math.round((Number(localCtxWindow) > 0 ? Number(localCtxWindow) : 8192) * (LOCAL_RATIOS[level] || 0.6))
    : (SAVER_THRESHOLDS[level] || 90000)
  return cacheHitRate >= 50 ? Math.round(base * 1.5) : base
}

export function buildAnchorDigest(oldMessages) {
  const decisions = []
  const paths = new Set()
  const notes = []
  const fileRe = /\b[\w.-]+\/[\w./-]+\.(?:js|jsx|ts|tsx|mjs|cjs|css|json|md|py|html|yml|yaml)\b|\b[\w-]+\.(?:js|jsx|ts|tsx|mjs|css|json|md|py)\b/g
  const decRe = /(?:决定|采用|改为|方案|结论|红线|约束|必须|禁止)[^。\n]{2,100}/g

  for (const m of (Array.isArray(oldMessages) ? oldMessages : [])) {
    if (!m) continue
    const txt = String(m.content || '')
    if (m.__anchorDigest) {
      notes.push(txt.replace(/^【锚点摘要】\s*/, '').trim())
      continue
    }
    const fHits = txt.match(fileRe)
    if (fHits) fHits.forEach((p) => { if (paths.size < 16) paths.add(p) })
    const dHits = txt.match(decRe)
    if (dHits) dHits.forEach((d) => { if (decisions.length < 8 && !decisions.includes(d)) decisions.push(d.trim()) })
  }

  const parts = ['【锚点摘要】以下为已压缩历史的关键决策与文件锚点（自动保留，幂等更新）：']
  if (decisions.length) parts.push('• 决策与约束：\n  - ' + decisions.join('\n  - '))
  if (paths.size) parts.push('• 涉及文件：' + [...paths].join(', '))
  if (notes.length) parts.push('• 前序摘要延续：\n' + notes.slice(-1)[0].slice(0, 600))
  if (parts.length === 1) {
    const brief = (oldMessages || []).slice(0, 4).map((m) => `${m.role}: ${String(m.content || '').slice(0, 80)}`).join(' | ')
    parts.push('• 历史概要：' + brief)
  }
  return {
    role: 'assistant',
    content: parts.join('\n'),
    __anchorDigest: true,
    _nodeId: 'anchor_digest',
  }
}

export function compactSessionHistory(session, { force = false, keepTail = 6, level = 'std', localMode = false, localCtxWindow = 8192, cacheHitRate = 0 } = {}) {
  if (!session || !Array.isArray(session.messages) || session.messages.length <= keepTail) {
    return { compacted: false, session, beforeTokens: historyTokens(session && session.messages), afterTokens: historyTokens(session && session.messages) }
  }
  const beforeTokens = historyTokens(session.messages)
  const threshold = computeCompactThreshold({ level, localMode, localCtxWindow, cacheHitRate })
  if (!force && beforeTokens < threshold) {
    return { compacted: false, session, beforeTokens, afterTokens: beforeTokens, threshold }
  }

  const nonDigest = session.messages.filter((m) => !(m && m.__anchorDigest))
  if (nonDigest.length <= keepTail) {
    return { compacted: false, session, beforeTokens, afterTokens: beforeTokens }
  }
  let cut = Math.max(1, nonDigest.length - keepTail)
  // 对齐到 user 消息边界，避免 [assistant(锚点摘要), assistant(...)] 连续两条同角色消息
  if (nonDigest[cut] && nonDigest[cut].role === 'assistant') {
    if (cut + 1 < nonDigest.length && nonDigest[cut + 1].role === 'user') cut += 1
    else if (cut - 1 >= 1 && nonDigest[cut - 1].role === 'user') cut -= 1
  }
  const existingDigest = session.messages.filter((m) => m && m.__anchorDigest)
  const head = [...existingDigest, ...nonDigest.slice(0, cut)]
  const tail = nonDigest.slice(cut)
  const digest = buildAnchorDigest(head)
  const nextMessages = [digest, ...tail]
  const nextSession = { ...session, messages: nextMessages, tree: null, updatedAt: Date.now() }
  return {
    compacted: true,
    session: nextSession,
    beforeTokens,
    afterTokens: historyTokens(nextMessages),
    removedCount: cut,
  }
}
