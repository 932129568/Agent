/**
 * 护栏判定链（P0-1b T01 对齐重写）：与 legacy backend/domains/security/guard_service.py
 * 逐结构同构——scope 分类学、默认档位矩阵、confirm 回执（label）、token/grant/trust
 * 契约、armed 语义、配置归一化。
 *
 * 判定链（与 Python check()/enforce_exec 同构，顺序即安全语义）：
 *
 *   guardCheck(op, detail):                    enforceExec(op, detail, token):
 *     op ∉ GUARD_OPS → {action:'allow'}          r = guardCheck(op, detail)
 *     ① 保护名单 → block{reason}                 r.action=block → 拒绝(reason)
 *     ② deny/allow 规则 → block/allow{via}       force_always → token 消费/拒绝
 *     ③ 任务授权(仅 5 映射 op) → allow{via}       via=rule → 放行(审计+命中计数)
 *     ④ 持久信任 trustedOps → allow{via}          via=grant → 放行(审计)
 *     ⑤ tier off → allow                         持久信任 → 放行(审计)
 *     ⑥ tier list → listless? confirm : allow    未武装(armed=false) → 放行
 *     ⑦ 其余 → confirm{action,op,label}          会话信任 → 放行
 *                                                tier off/list → 放行
 *                                                token 有效 → 放行(审计)
 *                                                否则 → 拒绝(档位文案)
 *
 * armed（E7）：生产缺省武装（HARBOR_GUARD_ARMED 仅模块 init 读取、生产入口永不
 * 设置）；未武装跳过的只是会话信任/token/档位确认——block/规则/授权/持久信任
 * 仍然生效（与 Python 未武装路径逐行同构）。
 *
 * 配置面：guard.json 读取时归一化（默认全量 + 文件覆盖 + tiers 白名单过滤）；
 * guard 自身写档（save_config/rule 操作）整写归一结果。used/escalated 是会话级
 * 内存态（外部重写文件不归零——与 Python 会话语义一致）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_DIR, atomicWriteJson } from '../paths.js'
import { guardAudit } from './misc.js'
import { runtime } from '../runtime.js'

const GUARD_FILE = path.join(CONFIG_DIR, 'guard.json')
const TOKEN_TTL_SECONDS = 60
const GRANT_IDLE_SECONDS = 1800
const GRANT_TTL_DEFAULT = 7200
const GRANT_TTL_MIN = 60
const GRANT_TTL_MAX = 86400

/** Python GUARD_OPS（17 op 白名单）：之外的操作不设防（契约设计：新增危险 op 必须先注册）。 */
export const GUARD_OPS = [
  'delete_path', 'kill_process', 'clipboard_write', 'clipboard_read',
  'take_screenshot', 'run_command', 'run_powershell', 'run_admin_command',
  'open_app', 'web_search', 'software_call',
  'browser_navigate', 'browser_extract', 'browser_click', 'browser_fill',
  'browser_screenshot', 'browser_close',
]

/** Python DEFAULT_TIERS 全矩阵（逐字对齐）。 */
export const DEFAULT_TIERS = {
  delete_path: 'always',
  kill_process: 'always',
  clipboard_write: 'always',
  clipboard_read: 'session',
  take_screenshot: 'session',
  run_command: 'off',
  run_powershell: 'off',
  run_admin_command: 'off',
  open_app: 'off',
  web_search: 'off',
  software_call: 'session',
  browser_navigate: 'session',
  browser_extract: 'session',
  browser_click: 'always',
  browser_fill: 'always',
  browser_screenshot: 'session',
  browser_close: 'session',
}

/** Python OP_LABELS（confirm 回执的人话标签，逐字）。 */
const OP_LABELS = {
  delete_path: '删除文件/目录',
  kill_process: '结束进程',
  clipboard_write: '写入剪贴板',
  clipboard_read: '读取剪贴板',
  take_screenshot: '屏幕截图',
  run_command: '执行命令',
  run_powershell: '执行 PowerShell',
  run_admin_command: '管理员命令',
  open_app: '打开应用/链接',
}

/** Python GRANT_SCOPES + _OP_GRANT_SCOPES：授权面严格收敛（E1）——文件写操作
 * 永不因任务授权放行；未映射 op 不经授权放行（fail-closed）。 */
const GRANT_SCOPES = new Set(['workspace_write', 'exec', 'app_launch'])
const OP_GRANT_SCOPES = {
  delete_path: 'workspace_write',
  run_command: 'exec',
  run_powershell: 'exec',
  run_admin_command: 'exec',
  open_app: 'app_launch',
}

/** Python _LISTLESS_OPS：无名单语义的操作，list 档降级为每次确认。 */
const LISTLESS_OPS = new Set(['clipboard_write', 'clipboard_read', 'take_screenshot',
  'run_command', 'run_powershell', 'run_admin_command', 'open_app'])

/** armed（E7）：生产缺省武装；测试 seam 仅模块 init 读取。 */
export const ARMED = process.env.HARBOR_GUARD_ARMED !== 'false'

/* ---------------- 会话级内存态（Python 进程内语义） ---------------- */
const tokens = new Map()          // token -> {op, digest, exp, used}
const sessionTrust = new Set()    // 本会话已信任的 op
let trustedSid = null
let grant = null                  // 当前任务授权（进程内，不入 guard.json）
let approvalUsed = 0              // 会话级审批计数（Python _cfg.approval_budget.used 同源）
let approvalEscalated = false     // 会话级升级标志
const ruleHits = new Map()        // rule_id -> hits（内存叠加，写档时落盘）

const now = () => Date.now()
const digestOf = detail => crypto.createHash('sha256')
  .update(JSON.stringify(detail ?? {})).digest('hex').slice(0, 32)

/* ---------------- 配置归一化（G9/G12） ---------------- */
const VALID_TIERS = new Set(['always', 'list', 'session', 'off'])

function normalizeRule(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const ruleId = String(raw.rule_id || '').trim()
  const opPattern = String(raw.op_pattern || '').trim()
  if (!ruleId || !opPattern) return null
  try { new RegExp(opPattern) } catch { return null }
  let detailPattern = String(raw.detail_pattern || '').trim()
  if (detailPattern) {
    try { new RegExp(detailPattern) } catch { detailPattern = '' }
  }
  const rule = { rule_id: ruleId, op_pattern: opPattern }
  if (detailPattern) rule.detail_pattern = detailPattern
  rule.hits = Math.max(0, Number.isInteger(raw.hits) ? raw.hits : Number(raw.hits) || 0)
  rule.created_at = String(raw.created_at || '')
  const note = String(raw.note || '').trim().slice(0, 200)
  if (note) rule.note = note
  return rule
}

/** 读取 + 归一化（Python _load 同构：默认全量 + 文件覆盖 + 白名单过滤；
 * used/escalated 会话级不加载；allow_rules 仅在存在时入键）。 */
function loadCfg() {
  let data = {}
  try {
    data = JSON.parse(fs.readFileSync(GUARD_FILE, 'utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {}
  } catch { data = {} }
  const cfg = {
    tiers: { ...DEFAULT_TIERS },
    protect_paths: [],
    protect_processes: [],
    trustedOps: [],
    approval_budget: { limit: 20, used: 0, escalated: false },
  }
  if (data.tiers && typeof data.tiers === 'object') {
    for (const op of GUARD_OPS) {
      if (VALID_TIERS.has(data.tiers[op])) cfg.tiers[op] = data.tiers[op]
    }
  }
  if (Array.isArray(data.protect_paths)) {
    cfg.protect_paths = data.protect_paths.map(p => path.normalize(String(p).trim()).toLowerCase())
      .filter(Boolean)
  }
  if (Array.isArray(data.protect_processes)) {
    cfg.protect_processes = data.protect_processes.map(p => String(p).toLowerCase().trim())
      .filter(Boolean)
  }
  if (Array.isArray(data.trustedOps)) {
    cfg.trustedOps = data.trustedOps.map(String).filter(op => GUARD_OPS.includes(op))
  }
  if (Array.isArray(data.allow_rules)) {
    cfg.allow_rules = data.allow_rules.map(normalizeRule).filter(Boolean)
  }
  if (data.approval_budget && typeof data.approval_budget === 'object'
      && Number.isInteger(data.approval_budget.limit)) {
    cfg.approval_budget.limit = data.approval_budget.limit
  }
  return cfg
}

/** guard 写档：归一 cfg + 会话态落盘（used/escalated/hits）。 */
function persistCfg(cfg) {
  const out = {
    tiers: cfg.tiers,
    protect_paths: cfg.protect_paths,
    protect_processes: cfg.protect_processes,
    trustedOps: cfg.trustedOps,
    approval_budget: { limit: cfg.approval_budget.limit, used: approvalUsed, escalated: approvalEscalated },
  }
  if (cfg.allow_rules && cfg.allow_rules.length) {
    out.allow_rules = cfg.allow_rules.map(r => ({ ...r, hits: ruleHits.get(r.rule_id) ?? r.hits }))
  }
  atomicWriteJson(GUARD_FILE, out)
}

function tierOf(op) {
  return loadCfg().tiers[op] || 'always'
}

/* ---------------- 保护名单与规则匹配 ---------------- */
function detailPaths(detail) {
  const out = []
  const walk = value => {
    if (!value) return
    if (typeof value === 'string') {
      if (/^[a-zA-Z]:[\\/]|^\//.test(value)) out.push(value)
      return
    }
    if (Array.isArray(value)) { value.forEach(walk); return }
    if (typeof value === 'object') Object.values(value).forEach(walk)
  }
  walk(detail)
  return out
}

function fnmatch(text, pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i').test(text)
}

function matchProtect(detail) {
  const cfg = loadCfg()
  for (const p of detailPaths(detail)) {
    const lower = p.toLowerCase()
    const hit = cfg.protect_paths.find(x =>
      fnmatch(lower, x) || fnmatch(lower, `${x}\\*`) || fnmatch(lower, `${x}/*`))
    if (hit) return { pattern: hit, path: p }
  }
  return null
}

function matchRule(op, detail) {
  // Python check() ②：仅 allow_rules（deny 语义由保护名单①承担，无 deny_rules 概念）
  const cfg = loadCfg()
  const text = JSON.stringify(detail ?? {})
  return (cfg.allow_rules || []).find(rule => {
    try {
      if (rule.detail_pattern) {
        return new RegExp(rule.op_pattern).test(op) && new RegExp(rule.detail_pattern).test(text)
      }
      return new RegExp(rule.op_pattern).test(op)
    } catch { return false }
  }) || null
}

/* ---------------- 判定链（Python check() 同构，无审计副作用） ---------------- */
export async function guardCheck(op, detail = {}) {
  if (!GUARD_OPS.includes(op)) return JSON.stringify({ action: 'allow' })
  const tier = tierOf(op)

  // ① 保护名单优先于一切（Python：仅 delete_path/kill_process 有名单判定）
  if (op === 'delete_path') {
    const hit = matchProtect(detail)
    if (hit) {
      return JSON.stringify({
        action: 'block',
        reason: `路径 ${detail.path} 命中保护名单（${hit.pattern}），已拒绝删除。如确需删除请用户手动操作或在设置中调整保护名单。`,
      })
    }
  }

  // ② allow 规则（窄规则优先于松模式；deny 语义在 ① 保护名单）
  const allowRule = matchRule(op, detail)
  if (allowRule) {
    return JSON.stringify({ action: 'allow', via: 'rule', rule_id: allowRule.rule_id || null })
  }

  // ③ 任务授权（仅映射 op；fail-closed）
  if (grant && grant.idle_deadline > now()) {
    const scope = OP_GRANT_SCOPES[op]
    if (scope && grant.scope.includes(scope)) {
      grant.idle_deadline = now() + GRANT_IDLE_SECONDS * 1000
      return JSON.stringify({ action: 'allow', via: 'grant', grant_id: grant.grant_id })
    }
  }

  // ④ 持久信任（guard.json trustedOps）
  if (loadCfg().trustedOps.includes(op)) {
    return JSON.stringify({ action: 'allow', via: 'trusted-persistent' })
  }

  // ⑤⑥ 档位
  if (tier === 'off') return JSON.stringify({ action: 'allow' })
  if (tier === 'list' && !LISTLESS_OPS.has(op)) return JSON.stringify({ action: 'allow' })
  // ⑦ always/session → confirm（回执带 label——Python 契约）
  return JSON.stringify({ action: 'confirm', op, label: OP_LABELS[op] || op })
}

/** js_api guard_check 面（Python api.guard_check：check + 按结果 action 落审计）。 */
export async function guardCheckApi(op, detailJson = '{}') {
  let detail = detailJson
  if (typeof detail === 'string') {
    try { detail = JSON.parse(detail || '{}') } catch { detail = {} }
  }
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) detail = {}
  const raw = await guardCheck(op, detail)
  const verdict = JSON.parse(raw)
  await guardAudit(op, detail, verdict.action || 'check')
  return raw
}

/* ---------------- token（G3：{token, ttl:60}；op 白名单校验） ---------------- */
async function countApproval(op) {
  approvalUsed += 1
  const cfg = loadCfg()
  const limit = Number(cfg.approval_budget.limit) || 20
  if (approvalUsed >= limit && !approvalEscalated) {
    approvalEscalated = true
    await guardAudit('guard_budget', { used: approvalUsed, limit }, 'decision', 'escalated')
  }
}

export async function guardConfirmToken(op, detail = {}) {
  if (!GUARD_OPS.includes(op) && op !== 'mcp_call') {
    return JSON.stringify({ error: `未知护栏操作: ${op}` })
  }
  const token = crypto.randomBytes(16).toString('hex')
  tokens.set(token, { op, digest: digestOf(detail), exp: now() + TOKEN_TTL_SECONDS * 1000, used: false })
  await countApproval(op)
  return JSON.stringify({ token, ttl: TOKEN_TTL_SECONDS })
}

export async function consumeToken(op, detail, token) {
  const entry = tokens.get(String(token || ''))
  if (!entry || entry.used || entry.exp < now()) return false
  if (entry.op !== op || entry.digest !== digestOf(detail)) return false
  entry.used = true
  return true
}

/** Python refund_token：执行前失败退还审批（不白扣预算）。 */
export async function refundToken(op, detail, token) {
  const key = String(token || '')
  if (!key || tokens.has(key)) return false
  tokens.set(key, { op, digest: digestOf(detail), exp: now() + TOKEN_TTL_SECONDS * 1000, used: false })
  approvalUsed = Math.max(0, approvalUsed - 1)
  return true
}

/* ---------------- 会话信任（G4：op 白名单 + 计一次审批） ---------------- */
export async function guardSessionTrust(op) {
  if (!GUARD_OPS.includes(op)) {
    return JSON.stringify({ error: `未知护栏操作: ${op}` })
  }
  if (trustedSid !== runtime.currentSid) {
    sessionTrust.clear()
    trustedSid = runtime.currentSid
  }
  sessionTrust.add(op)
  await countApproval(op)
  return '{"ok":true}'
}

/* ---------------- 白名单规则（G5） ---------------- */
export async function guardRuleList() {
  const cfg = loadCfg()
  const rules = (cfg.allow_rules || []).map(r => {
    const item = { rule_id: r.rule_id, op_pattern: r.op_pattern, hits: ruleHits.get(r.rule_id) ?? r.hits, created_at: r.created_at }
    if (r.detail_pattern) item.detail_pattern = r.detail_pattern
    if (r.note) item.note = r.note
    return item
  })
  return JSON.stringify({ ok: true, rules })
}

const DENY_SENSITIVE_OPS = ['delete_path', 'kill_process']

export async function guardRuleAdd(opPattern, detailPattern = null, note = null) {
  const op = String(opPattern || '').trim()
  if (!op) return JSON.stringify({ error: 'op_pattern 不能为空' })
  let opRx
  try { opRx = new RegExp(op) } catch (error) { return JSON.stringify({ error: `op_pattern 不是合法正则: ${error.message}` }) }
  const detail = String(detailPattern || '').trim()
  let detailRx = null
  if (detail) {
    try { detailRx = new RegExp(detail) } catch (error) { return JSON.stringify({ error: `detail_pattern 不是合法正则: ${error.message}` }) }
  }
  if (!detail && DENY_SENSITIVE_OPS.some(name => opRx.test(name))) {
    return JSON.stringify({ error: `该规则覆盖 ${DENY_SENSITIVE_OPS.find(name => opRx.test(name))} 且无 detail 窄约束，会架空保护名单（deny 清单先于白名单生效），已拒绝创建`, code: 'GUARD_DENIED' })
  }
  const ruleId = `r_${crypto.randomBytes(6).toString('hex')}`
  const rule = { rule_id: ruleId, op_pattern: op, hits: 0, created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') }
  if (detail) rule.detail_pattern = detail
  const noteText = String(note || '').trim().slice(0, 200)
  if (noteText) rule.note = noteText
  const cfg = loadCfg()
  cfg.allow_rules = [...(cfg.allow_rules || []), rule]
  persistCfg(cfg)
  await guardAudit('guard_rule_add', { rule_id: ruleId, op_pattern: op, detail_pattern: detail }, 'rule', 'allow')
  const result = { ok: true, rule_id: ruleId }
  if (detail && /\b(write|delete|remove|modify|set|write_file|delete_path)\b/i.test(detail)) {
    result.warn = 'detail 含写动词，确认这是宽模式规则？（窄规则优先）'
  }
  return JSON.stringify(result)
}

export async function guardRuleRemove(ruleId) {
  const cfg = loadCfg()
  const target = String(ruleId || '').trim()
  const rules = (cfg.allow_rules || []).filter(rule => rule.rule_id !== target)
  const removed = rules.length !== (cfg.allow_rules || []).length
  if (removed) {
    cfg.allow_rules = rules
    ruleHits.delete(target)
    persistCfg(cfg)
    await guardAudit('guard_rule_remove', { rule_id: target }, 'rule', 'remove')
  }
  return JSON.stringify({ ok: true, removed })
}

/* ---------------- 任务授权（G6/G7：scope 枚举 + TTL 范围 + 全键响应） ---------------- */
function isoSeconds(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function normalizeScope(scope) {
  let parts
  if (typeof scope === 'string' && scope) {
    parts = scope.split(/[+,/\s]+/).filter(Boolean)
  } else if (Array.isArray(scope)) {
    parts = scope.map(String)
  } else {
    return null
  }
  const scopes = [...new Set(parts.map(p => p.trim()).filter(Boolean))]
  if (!scopes.length || !scopes.every(s => GRANT_SCOPES.has(s))) return null
  return scopes
}

export async function guardTaskGrant(scope, ttlSeconds = GRANT_TTL_DEFAULT) {
  const scopes = normalizeScope(scope)
  if (!scopes) {
    return JSON.stringify({ error: 'scope 需为非空枚举数组（合法值: workspace_write/exec/app_launch）' })
  }
  const ttl = ttlSeconds
  if (typeof ttl === 'boolean' || !Number.isInteger(ttl) || ttl !== Number(ttl)) {
    return JSON.stringify({ error: `ttl_seconds 需为整数（${GRANT_TTL_MIN}-${GRANT_TTL_MAX} 秒）` })
  }
  if (ttl < GRANT_TTL_MIN || ttl > GRANT_TTL_MAX) {
    return JSON.stringify({ error: `ttl_seconds 超出范围（${GRANT_TTL_MIN}-${GRANT_TTL_MAX} 秒），安全参数不静默夹逼` })
  }
  const started = now()
  const grantId = `g_${crypto.randomBytes(8).toString('hex')}`
  grant = {
    grant_id: grantId, scope: scopes, granted_at: started,
    expires_at: started + ttl * 1000, idle_deadline: started + GRANT_IDLE_SECONDS * 1000,
    granted_by: 'user',
  }
  await guardAudit('guard_grant', { grant_id: grantId, scope: scopes.slice().sort().join(','), ttl }, 'grant', 'grant')
  return JSON.stringify({
    ok: true, grant_id: grantId,
    expires_at: isoSeconds(grant.expires_at),
    idle_deadline: isoSeconds(grant.idle_deadline),
    remaining_s: Math.floor((Math.min(grant.expires_at, grant.idle_deadline) - started) / 1000),
    scope: scopes.slice().sort(), granted_by: 'user',
  })
}

export async function guardTaskRevoke(grantId = null) {
  const target = grantId ? String(grantId).trim() : grant?.grant_id
  const revoked = !!(target && grant && grant.grant_id === target)
  if (revoked) {
    const id = grant.grant_id
    grant = null
    await guardAudit('guard_revoke', { grant_id: id }, 'revoke', 'revoke')
  }
  return JSON.stringify({ ok: true, revoked })
}

export async function guardTaskStatus() {
  if (!grant || grant.idle_deadline <= now() || grant.expires_at <= now()) {
    return JSON.stringify({ ok: true, active: false })
  }
  const remaining = Math.max(0, Math.floor((Math.min(grant.expires_at, grant.idle_deadline) - now()) / 1000))
  return JSON.stringify({
    ok: true, active: true, grant_id: grant.grant_id,
    expires_at: isoSeconds(grant.expires_at), idle_deadline: isoSeconds(grant.idle_deadline),
    remaining_s: remaining, scope: [...grant.scope].sort(), granted_by: grant.granted_by,
    expiring_soon: remaining < 600,
  })
}

/* ---------------- 审批预算 ---------------- */
export async function guardApprovalBudget(limit = null) {
  if (limit !== null && limit !== undefined) {
    if (!Number.isInteger(limit) || typeof limit === 'boolean' || limit < 1 || limit > 100) {
      return JSON.stringify({ error: `审批预算上限需为 1-100 的整数（当前 ${JSON.stringify(limit)}）` })
    }
    const cfg = loadCfg()
    cfg.approval_budget.limit = limit
    approvalEscalated = approvalUsed >= limit
    persistCfg(cfg)
    await guardAudit('guard_budget', { limit }, 'decision', 'set-limit')
  }
  const cfg = loadCfg()
  const configured = Number(cfg.approval_budget.limit) || 20
  return JSON.stringify({
    ok: true, used: approvalUsed, limit: configured,
    escalated: approvalEscalated, remaining: Math.max(0, configured - approvalUsed),
    grant_active: !!(grant && grant.idle_deadline > now() && grant.expires_at > now()),
  })
}

/* ---------------- 执行点强制（Python enforce_exec 同构 + armed） ---------------- */
async function noteRuleHit(ruleId) {
  if (!ruleId) return
  ruleHits.set(ruleId, (ruleHits.get(ruleId) ?? 0) + 1)
  const cfg = loadCfg()
  if (cfg.allow_rules?.some(r => r.rule_id === ruleId)) persistCfg(cfg)
}

export async function enforceExec(op, detail = {}, token = null) {
  const verdict = JSON.parse(await guardCheck(op, detail))
  if (verdict.action === 'block') return verdict.reason
  // force_always：高危动作无视档位与信任态，每次都要有效 token（先于 via 短路）
  if ((detail || {}).force_always) {
    if (token && await consumeToken(op, detail, token)) {
      await guardAudit(op, detail, 'decision', 'token-confirm')
      return null
    }
    return '该操作属高危动作（dangerous），需每次确认，但调用方未携带有效的一次性确认 token。请通过界面确认后执行，不要绕过确认流程。'
  }
  const via = verdict.via
  if (via === 'rule') {
    await noteRuleHit(verdict.rule_id)
    await guardAudit(op, detail, 'decision', 'rule')
    return null
  }
  if (via === 'grant') {
    await guardAudit(op, detail, 'decision', 'grant')
    return null
  }
  if (loadCfg().trustedOps.includes(op)) {
    await guardAudit(op, detail, 'decision', 'trusted-persistent')
    return null
  }
  // armed（E7）：未武装环境（无窗口的测试/嵌入态）放行——与 Python 逐行同构
  if (!ARMED) return null
  if (trustedSid === runtime.currentSid && sessionTrust.has(op)) return null
  let tier = tierOf(op)
  if (tier === 'list' && LISTLESS_OPS.has(op)) tier = 'always'
  if (tier === 'off' || tier === 'list') return null
  if (token && await consumeToken(op, detail, token)) {
    await guardAudit(op, detail, 'decision', 'token-confirm')
    return null
  }
  return `该操作需要用户在界面确认（护栏档位 ${tier}），但调用方未携带有效的一次性确认 token。请通过界面确认后执行，不要绕过确认流程。`
}

/* ---------------- 配置读写（G9/G12：归一化全量） ---------------- */
export function guardGetConfig() {
  const cfg = loadCfg()
  cfg.approval_budget = { ...cfg.approval_budget, used: approvalUsed, escalated: approvalEscalated }
  if (cfg.allow_rules) {
    cfg.allow_rules = cfg.allow_rules.map(r => ({ ...r, hits: ruleHits.get(r.rule_id) ?? r.hits }))
  }
  return JSON.stringify(cfg)
}

export async function guardSaveConfig(configJson) {
  try {
    const incoming = JSON.parse(String(configJson))
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return JSON.stringify({ error: '配置必须是 JSON 对象' })
    }
    const cfg = loadCfg()
    if (incoming.trustedOps !== undefined) {
      if (!Array.isArray(incoming.trustedOps)) {
        return JSON.stringify({ error: 'trustedOps 必须是数组' })
      }
      for (const op of incoming.trustedOps) {
        if (!GUARD_OPS.includes(String(op))) {
          return JSON.stringify({ error: `未知的信任操作: ${op}` })
        }
      }
      cfg.trustedOps = incoming.trustedOps.map(String)
    }
    if (incoming.tiers && typeof incoming.tiers === 'object') {
      for (const op of GUARD_OPS) {
        if (VALID_TIERS.has(incoming.tiers[op])) cfg.tiers[op] = incoming.tiers[op]
      }
    }
    if (Array.isArray(incoming.protect_paths)) {
      cfg.protect_paths = incoming.protect_paths.map(p => path.normalize(String(p).trim()).toLowerCase()).filter(Boolean)
    }
    if (Array.isArray(incoming.protect_processes)) {
      cfg.protect_processes = incoming.protect_processes.map(p => String(p).toLowerCase().trim()).filter(Boolean)
    }
    persistCfg(cfg)
    return '{"ok":true}'
  } catch (error) {
    return JSON.stringify({ error: String(error && error.message ? error.message : error) })
  }
}
