/**
 * 深比对 + 三分类裁决（设计 §6.2/§6.3）。
 *
 * 裁决：
 *   match       归一后双侧结构+值一致（含双侧同为异常/同一错误码）
 *   intentional 不一致但 intentional-deltas.json 存在 (fixture, call) 有效登记
 *               （expires 到期自动回到 suspect；approvedBy=pending 在报告中标待签核）
 *   suspect     不一致且无登记——疑似缺陷，只登记不修（修复属 P0-1b）
 *   error       驱动崩溃/超时/方法在某侧缺失
 *   skipped     显式 skip（须附原因）
 *
 * 比对语义：
 *   - Node 200：双侧 body 解析后深比较（键集/类型/嵌套值）；
 *   - Node 400/500：与 Python 侧「ok:false/error JSON」或未捕获异常对齐比对；
 *     Python 正常返回而 Node 500 → suspect（设计 §2.2）；
 *   - 例外格式差异：Python json.dumps 转义非 ASCII vs Node 原样 UTF-8 —— 解析后
 *     结构比较天然消除；键序不是契约。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRules, normalizeForCompare, normalizeValue, normalizeString, shapeTree, canonicalize } from './normalize.mjs'

const DIFF_TOOLS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tools', 'diff')

export function loadIntentionalDeltas(p = path.join(DIFF_TOOLS_DIR, 'intentional-deltas.json')) {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
  const byKey = new Map()
  for (const delta of raw.deltas || []) byKey.set(`${delta.fixture}|${delta.callId}`, delta)
  return { raw, byKey }
}

function deltaIsExpired(delta, now = new Date()) {
  if (!delta.expires) return false
  try { return new Date(delta.expires) < now } catch { return false }
}

function findDelta(registry, fixtureId, callId) {
  const delta = registry.byKey.get(`${fixtureId}|${callId}`)
  if (!delta) return null
  if (deltaIsExpired(delta)) return { ...delta, expired: true }
  return { ...delta, expired: false }
}

/** 深比较：返回首个差异路径（如 error.code / [0].messages[2].content）或 null。 */
export function firstDiff(a, b, where = '') {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${where}（数组长度 ${a.length} != ${b.length}）`
    for (let i = 0; i < a.length; i += 1) {
      const found = firstDiff(a[i], b[i], `${where}[${i}]`)
      if (found) return found
    }
    return null
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a).sort()
    const bKeys = Object.keys(b).sort()
    if (JSON.stringify(aKeys) !== JSON.stringify(bKeys)) {
      const onlyA = aKeys.filter(k => !bKeys.includes(k))
      const onlyB = bKeys.filter(k => !aKeys.includes(k))
      const parts = []
      if (onlyA.length) parts.push(`Python 独有键 ${onlyA.join(',')}`)
      if (onlyB.length) parts.push(`Node 独有键 ${onlyB.join(',')}`)
      return `${where}（${parts.join('；')}）`
    }
    for (const key of aKeys) {
      const found = firstDiff(a[key], b[key], where ? `${where}.${key}` : key)
      if (found) return found
    }
    return null
  }
  if (a !== b) return `${where || '(root)'}（Python=${JSON.stringify(a)} vs Node=${JSON.stringify(b)}）`
  return null
}

function brief(value, limit = 400) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function verdictFrom(delta, extra) {
  if (delta && !delta.expired) {
    return { verdict: 'intentional', deltaId: delta.id, approval: delta.approvedBy || 'pending', expires: delta.expires || '—', ...extra }
  }
  if (delta && delta.expired) {
    return { verdict: 'suspect', note: `登记 ${delta.id} 已过期（expires=${delta.expires}），回到 suspect 强制复审`, ...extra }
  }
  return { verdict: 'suspect', ...extra }
}

/** 单 call 三分类。py/node 为驱动 result 中该 call 的条目。 */
export function compareCall(fixture, call, py, node, rules, deltaRegistry) {
  const method = call.method
  const base = { callId: call.id, method, note: call.note || '' }
  if (call.skip) return { ...base, verdict: 'skipped', diffPath: '', pySummary: '', nodeSummary: '', skipReason: call.skipReason || call.skip }

  if (!py || !node) {
    return { ...base, verdict: 'error', diffPath: 'driver-entry',
      pySummary: py ? 'ok' : 'missing', nodeSummary: node ? 'ok' : 'missing' }
  }

  const pySide = py.meta || py.result?.meta
  const nodeSide = node.meta || node.result?.meta
  const pyNorm = normalizeForCompare(py.raw ?? py.exception ?? null, pySide, rules)
  const nodeNorm = normalizeForCompare(node.raw ?? node.exception ?? null, nodeSide, rules)
  const summary = { pySummary: brief(pyNorm.value), nodeSummary: brief(nodeNorm.value) }

  const pyException = py.exception || (py.raw === undefined ? 'missing-raw' : null)
  const nodeStatus = node.status ?? (node.raw === undefined ? 'missing-raw' : 200)
  const nodeIs500 = nodeStatus === 500 || nodeStatus === 'missing-raw'

  // 双侧传输层都失败（Python 未捕获异常 / Node 500）：归一文本一致 → match
  if (pyException && nodeIs500) {
    const a = pyNorm.value
    const b = nodeNorm.value
    const diffPath = firstDiff(a, b) || (a === b ? null : '(exception)')
    if (!diffPath && a === b) return { ...base, verdict: 'match', ...summary }
    return verdictFrom(findDelta(deltaRegistry, fixture.id, call.id),
      { ...base, diffPath, ...summary })
  }
  if (pyException || nodeIs500) {
    // 单侧异常（Python 正常返回而 Node 500 = 疑似缺陷；反之亦然）
    const diffPath = pyException ? 'python.exception' : `node.status=${nodeStatus}`
    return verdictFrom(findDelta(deltaRegistry, fixture.id, call.id),
      { ...base, diffPath, ...summary })
  }

  // Node 400（zod 拒绝等）：与 Python 侧返回对齐比对（走同一结构比较）
  let a = pyNorm.value
  let b = nodeNorm.value
  if (pyNorm.kind !== nodeNorm.kind) {
    // 一侧 JSON、一侧裸文本：双侧退化为归一字符串比较（设计 §6.2 第 2 条）
    const aText = pyNorm.kind === 'json' ? JSON.stringify(pyNorm.value) : pyNorm.value
    const bText = nodeNorm.kind === 'json' ? JSON.stringify(nodeNorm.value) : nodeNorm.value
    if (aText === bText) return { ...base, verdict: 'match', ...summary }
    return verdictFrom(findDelta(deltaRegistry, fixture.id, call.id),
      { ...base, diffPath: '(mixed-kind)', ...summary })
  }

  if (call.unordered || fixture.unordered) {
    a = canonicalize(a)
    b = canonicalize(b)
  }
  if (call.mode === 'shape' || fixture.mode === 'shape') {
    const sa = shapeTree(a)
    const sb = shapeTree(b)
    const diffPath = firstDiff(sa, sb)
    if (!diffPath) return { ...base, verdict: 'match', ...summary }
    return verdictFrom(findDelta(deltaRegistry, fixture.id, call.id),
      { ...base, diffPath, ...summary })
  }

  const diffPath = firstDiff(a, b)
  if (!diffPath) return { ...base, verdict: 'match', ...summary }
  return verdictFrom(findDelta(deltaRegistry, fixture.id, call.id),
    { ...base, diffPath, ...summary })
}

/** 副作用比对：工作区树快照 + probeConfigFiles 解析后 JSON（设计 §6.2 第 5 条）。 */
export function compareSideEffects(fixture, pyResult, nodeResult, rules) {
  const out = []
  const pyEffects = pyResult?.sideEffects || { workspace: [], probeFiles: {} }
  const nodeEffects = nodeResult?.sideEffects || { workspace: [], probeFiles: {} }

  const wantSnapshot = fixture.sideEffects?.snapshotWorkspace !== false
  if (wantSnapshot) {
    const norm = list => canonicalize((list || []).map(x => ({
      path: normalizeString(x.path, null, rules), sha256: x.sha256,
    })))
    const a = norm(pyEffects.workspace)
    const b = norm(nodeEffects.workspace)
    const diffPath = firstDiff(a, b)
    out.push({
      callId: 'side-effects:workspace', method: '(workspace snapshot)',
      verdict: diffPath ? 'suspect' : 'match', diffPath: diffPath || '',
      pySummary: brief(a), nodeSummary: brief(b), note: '相对路径集合 + 每文件 sha256',
    })
  }

  for (const name of fixture.sideEffects?.probeConfigFiles || []) {
    const a = normalizeValue(pyEffects.probeFiles?.[name] ?? null, pyResult?.meta, rules)
    const b = normalizeValue(nodeEffects.probeFiles?.[name] ?? null, nodeResult?.meta, rules)
    const diffPath = firstDiff(a, b)
    out.push({
      callId: `side-effects:probe:${name}`, method: `(probe ${name})`,
      verdict: diffPath ? 'suspect' : 'match', diffPath: diffPath || '',
      pySummary: brief(a), nodeSummary: brief(b), note: '独立配置文件解析后 JSON',
    })
  }
  return out
}
