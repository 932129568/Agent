/**
 * 护栏判定链：确认档、保护名单、规则、任务授权、会话信任、一次性 token。
 *
 * 判定顺序与 legacy guard_service 一致（顺序即安全语义，不可随意调整）：
 *   ① 升级/阻断名单（deny 永远优先）
 *   ② 保护名单（路径/目录名）
 *   ③ allow 规则
 *   ④ 任务授权（仅覆盖声明过的 scope，未映射操作 fail-closed）
 *   ⑤ 持久信任 trustedOps
 *   ⑥ 档位 off / list / always / session
 *
 * token 一次性 + TTL + 绑定 op 与参数摘要（防止「确认 A 参数、执行 B 参数」）。
 */
import crypto from 'node:crypto'
import { readConfigJson, mergeConfig } from './jsonstore.js'
import { guardAudit } from './misc.js'
import { runtime } from '../runtime.js'

const GUARD_FILE = 'guard.json'
const TOKEN_TTL_MS = 120000
const GRANT_IDLE_MS = 1800000

/** 无路径参数的操作：list 档不能等同 off（legacy W10），降级为每次确认 */
const LISTLESS_OPS = new Set(['run_command', 'run_powershell', 'run_admin_command',
  'open_app', 'open_url', 'kill_process', 'clipboard_read', 'clipboard_write'])

const OP_SCOPES = {
  read_file: 'fs:read', list_dir: 'fs:read', read_more: 'fs:read', get_file_info: 'fs:read',
  write_file: 'fs:write', append_file: 'fs:write', search_replace: 'fs:write',
  make_dir: 'fs:write', copy_path: 'fs:write', move_path: 'fs:write', delete_path: 'fs:write',
  run_command: 'cmd:exec', run_powershell: 'cmd:exec', run_admin_command: 'cmd:exec',
  open_app: 'os:launch', open_url: 'os:launch', kill_process: 'os:kill',
  clipboard_read: 'os:clipboard', clipboard_write: 'os:clipboard',
  take_screenshot: 'os:capture',
}

const tokens = new Map()
const sessionTrust = new Set()
let grant = null
let trustedSid = null
let approvalUsed = 0
let approvalEscalated = false

const now = () => Date.now()
const digestOf = detail => crypto.createHash('sha256')
  .update(JSON.stringify(detail ?? {})).digest('hex').slice(0, 32)

function cfg() {
  return readConfigJson(GUARD_FILE, {})
}

function tierOf(op) {
  const tiers = cfg().tiers || {}
  return tiers[op] || 'session'
}

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

function matchProtect(detail) {
  const protect = cfg().protect || {}
  if (protect.enabled === false) return null
  const names = protect.names || []
  const paths = (protect.paths || []).map(p => String(p).toLowerCase())
  for (const p of detailPaths(detail)) {
    const lower = p.toLowerCase()
    if (names.some(name => name && lower.split(/[\\/]/).includes(String(name).toLowerCase()))) {
      return `命中保护名单目录名：${p}`
    }
    if (paths.some(prefix => prefix && lower.startsWith(prefix))) {
      return `命中保护名单路径：${p}`
    }
  }
  return null
}

function matchRule(op, detail, action) {
  const config = cfg()
  const direct = (config.rules || []).filter(rule => rule && rule.action === action)
  const versioned = action === 'allow' ? (config.allow_rules || []) : (config.deny_rules || [])
  const text = JSON.stringify(detail ?? {})
  return [...direct, ...versioned].find(rule => {
    try {
      if (rule.op_pattern) { if (!new RegExp(rule.op_pattern).test(op)) return false }
      else if (rule.op && rule.op !== op) return false
      if (rule.detail_pattern) return new RegExp(rule.detail_pattern).test(text)
      if (rule.pattern) return text.includes(String(rule.pattern))
      return true
    } catch { return false }
  }) || null
}

export async function guardCheck(op, detail = {}) {
  if (!op) return JSON.stringify({ action: 'block', reason: '缺少 op' })

  const protectHit = matchProtect(detail)
  if (protectHit) {
    await guardAudit(op, detail, 'decision', 'block-list')
    return JSON.stringify({ action: 'block', reason: protectHit })
  }

  const denyRule = matchRule(op, detail, 'deny')
  if (denyRule) {
    await guardAudit(op, detail, 'decision', 'deny-rule')
    return JSON.stringify({ action: 'block', reason: `命中拒绝规则 ${denyRule.rule_id || ''}` })
  }

  const allowRule = matchRule(op, detail, 'allow')
  if (allowRule) {
    return JSON.stringify({ action: 'allow', via: 'rule', rule_id: allowRule.rule_id || null })
  }

  if (grant && grant.idle_deadline > now()) {
    const scope = OP_SCOPES[op]
    // fail-closed：未映射 scope 的操作不因授权而放行
    if (scope && grant.scope.includes(scope)) {
      grant.idle_deadline = now() + GRANT_IDLE_MS
      return JSON.stringify({ action: 'allow', via: 'grant', grant_id: grant.grant_id })
    }
  }

  if ((cfg().trustedOps || []).includes(op)) {
    return JSON.stringify({ action: 'allow', via: 'trusted-persistent' })
  }

  if (trustedSid === runtime.currentSid && sessionTrust.has(op)) {
    return JSON.stringify({ action: 'allow', via: 'trusted-session' })
  }

  const tier = tierOf(op)
  if (tier === 'off') return JSON.stringify({ action: 'allow' })
  if (tier === 'list' && !LISTLESS_OPS.has(op)) return JSON.stringify({ action: 'allow' })
  return JSON.stringify({ action: 'confirm', op, tier })
}

export async function guardConfirmToken(op, detail = {}) {
  const token = crypto.randomUUID()
  approvalUsed += 1
  const limit = Number(cfg().approval_budget?.limit || 20)
  if (approvalUsed >= limit) approvalEscalated = true
  tokens.set(token, { op, digest: digestOf(detail), exp: now() + TOKEN_TTL_MS, used: false })
  return JSON.stringify({ ok: true, token, op, expires_in: TOKEN_TTL_MS / 1000 })
}

export async function consumeToken(op, detail, token) {
  const entry = tokens.get(String(token || ''))
  if (!entry || entry.used || entry.exp < now()) return false
  if (entry.op !== op || entry.digest !== digestOf(detail)) return false
  entry.used = true
  return true
}

export async function guardSessionTrust(op) {
  if (trustedSid !== runtime.currentSid) {
    sessionTrust.clear()
    trustedSid = runtime.currentSid
  }
  sessionTrust.add(op)
  return '{"ok":true}'
}

export async function guardRuleList() {
  const config = cfg()
  return JSON.stringify({ ok: true, rules: [...(config.rules || []).filter(x => x.action === 'allow'), ...(config.allow_rules || [])] })
}

export async function guardRuleAdd(opPattern, detailPattern = null, note = null) {
  const op = String(opPattern || '').trim()
  if (!op) return JSON.stringify({ error: 'op_pattern 不能为空' })
  let opRx
  try { opRx = new RegExp(op) } catch (error) { return JSON.stringify({ error: `op_pattern 不是合法正则: ${error.message}` }) }
  const detail = String(detailPattern || '').trim()
  if (detail) {
    try { new RegExp(detail) } catch (error) { return JSON.stringify({ error: `detail_pattern 不是合法正则: ${error.message}` }) }
  }
  if (!detail && ['delete_path', 'kill_process'].some(opName => opRx.test(opName))) {
    return JSON.stringify({ error: '危险操作不允许创建无 detail 的宽白名单', code: 'GUARD_DENIED' })
  }
  const ruleId = `r_${crypto.randomBytes(6).toString('hex')}`
  const rule = { rule_id: ruleId, op_pattern: op, hits: 0, created_at: new Date().toISOString() }
  if (detail) rule.detail_pattern = detail
  const noteText = String(note || '').trim().slice(0, 200)
  if (noteText) rule.note = noteText
  const allowRules = [...(cfg().allow_rules || []), rule]
  await mergeConfig(GUARD_FILE, JSON.stringify({ allow_rules: allowRules }))
  const result = { ok: true, rule_id: ruleId }
  if (detail && /\b(write|delete|remove|modify|set|write_file|delete_path)\b/i.test(detail)) {
    result.warn = 'detail 含写动词，确认这是宽模式规则？（窄规则优先）'
  }
  return JSON.stringify(result)
}

export async function guardRuleRemove(ruleId) {
  const config = cfg()
  await mergeConfig(GUARD_FILE, JSON.stringify({
    rules: (config.rules || []).filter(rule => rule.rule_id !== ruleId),
    allow_rules: (config.allow_rules || []).filter(rule => rule.rule_id !== ruleId),
  }))
  return '{"ok":true}'
}

export async function guardTaskGrant(scope, ttlSeconds = 1800) {
  const scopes = Array.isArray(scope) ? scope : String(scope || '').split(',').map(s => s.trim()).filter(Boolean)
  const deadline = now() + Math.max(1, Number(ttlSeconds) || 1800) * 1000
  grant = {
    grant_id: `g_${crypto.randomBytes(4).toString('hex')}`,
    scope: scopes, granted_by: 'user',
    expires_at: deadline, idle_deadline: deadline,
  }
  return JSON.stringify({ ok: true, grant_id: grant.grant_id, scope: scopes })
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
  if (!grant || grant.idle_deadline <= now()) return JSON.stringify({ ok: true, active: false })
  const remaining = Math.max(0, Math.floor((Math.min(grant.expires_at, grant.idle_deadline) - now()) / 1000))
  return JSON.stringify({ ok: true, active: true, grant_id: grant.grant_id,
    expires_at: new Date(grant.expires_at).toISOString(), idle_deadline: new Date(grant.idle_deadline).toISOString(),
    remaining_s: remaining, scope: [...grant.scope].sort(), granted_by: grant.granted_by,
    expiring_soon: remaining < 600 })
}

export async function guardApprovalBudget(limit = null) {
  if (limit !== null && limit !== undefined) {
    if (!Number.isInteger(limit) || typeof limit === 'boolean' || limit < 1 || limit > 100) {
      return JSON.stringify({ error: `审批预算上限需为 1-100 的整数（当前 ${JSON.stringify(limit)}）` })
    }
    await mergeConfig(GUARD_FILE, JSON.stringify({ approval_budget: { limit } }))
    approvalEscalated = approvalUsed >= limit
    await guardAudit('guard_budget', { limit }, 'decision', 'set-limit')
  }
  const configured = Number(cfg().approval_budget?.limit || 20)
  return JSON.stringify({ ok: true, used: approvalUsed, limit: configured,
    escalated: approvalEscalated, remaining: Math.max(0, configured - approvalUsed),
    grant_active: !!(grant && grant.idle_deadline > now()) })
}

/** 供执行点调用：返回 null 放行，返回字符串为拒绝原因。 */
export async function enforceExec(op, detail = {}, token = null) {
  const verdict = JSON.parse(await guardCheck(op, detail))
  if (verdict.action === 'block') return verdict.reason
  if (verdict.action === 'allow') return null
  // confirm：需要有效一次性 token（会话信任已在 check 内判定）
  if (token && await consumeToken(op, detail, token)) {
    await guardAudit(op, detail, 'decision', 'token-confirm')
    return null
  }
  return `该操作需要用户在界面确认（护栏档位 ${verdict.tier || tierOf(op)}），请确认后携带一次性 token 再执行。`
}
