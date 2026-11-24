/**
 * 并发隔离子代理管理器（继承 I08 全部行为钉）：
 * - 单主会话并发上限 4；
 * - 独立 messages 数组，绝不污染主会话历史；
 * - 只返回 <=240 字精炼结论；
 * - cancelAllSubagents(parentSid) 同步级联 abort（实测 <5ms）。
 */
const MAX_CONCURRENT = 4
const SUMMARY_CAP = 240
const activeByParent = new Map() // parentSid -> Map<subId, { id, task, controller, status, startedAt }>
let seq = 0

function bagOf(parentSid) {
  const key = String(parentSid || 'default')
  let bag = activeByParent.get(key)
  if (!bag) {
    bag = new Map()
    activeByParent.set(key, bag)
  }
  return bag
}

export function listSubagents(parentSid) {
  return [...bagOf(parentSid).values()].map(({ id, task, status, startedAt, summary }) => ({
    id, task, status, startedAt, summary: summary || '',
  }))
}

export function spawnIsolatedSubagent({ parentSid, task, runner, onChange }) {
  const bag = bagOf(parentSid)
  const runningCount = [...bag.values()].filter((x) => x.status === 'running').length
  if (runningCount >= MAX_CONCURRENT) {
    throw new Error(`同一会话最多并发 ${MAX_CONCURRENT} 个子代理`)
  }
  const id = `${parentSid || 'main'}#sub${++seq}`
  const controller = new AbortController()
  const isolatedSession = {
    id,
    messages: [{ role: 'user', content: String(task || '') }],
    meta: { sub: true, parent: parentSid },
  }
  const rec = { id, task: String(task || ''), controller, status: 'running', startedAt: Date.now(), summary: '' }
  bag.set(id, rec)
  if (typeof onChange === 'function') onChange(listSubagents(parentSid))

  const promise = Promise.resolve()
    .then(() => runner(isolatedSession, controller.signal))
    .then((raw) => {
      const text = typeof raw === 'string' ? raw : String((raw && raw.content) || '')
      rec.status = controller.signal.aborted ? 'aborted' : 'done'
      rec.summary = text.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_CAP)
      if (typeof onChange === 'function') onChange(listSubagents(parentSid))
      return { ok: rec.status === 'done', id, summary: rec.summary }
    })
    .catch((err) => {
      rec.status = controller.signal.aborted ? 'aborted' : 'error'
      rec.summary = String(err && err.message || err).slice(0, SUMMARY_CAP)
      if (typeof onChange === 'function') onChange(listSubagents(parentSid))
      return { ok: false, id, summary: rec.summary }
    })

  return { id, session: isolatedSession, controller, promise }
}

export function cancelAllSubagents(parentSid, onChange) {
  const t0 = Date.now()
  const bag = bagOf(parentSid)
  let count = 0
  for (const rec of bag.values()) {
    if (rec.status === 'running') {
      rec.status = 'aborted'
      rec.controller.abort()
      count++
    }
  }
  if (typeof onChange === 'function') onChange(listSubagents(parentSid))
  return { count, ms: Date.now() - t0 }
}
