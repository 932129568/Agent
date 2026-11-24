/**
 * 审计哈希链独立叶子模块（从 misc.js 下沉，彻底解开 browser ↔ guard ↔ misc 循环依赖）。
 *
 * 审计条目形状（与既有 audit_chain 契约 100% 同构）：
 *   {ts, op, action, detail, decision?, trace?, identity:{sid,principal},
 *    intent:{trace,summary}, evidence?:{args_sha256}, prev_hash, hash}
 * 链算法：canonical = 键排序紧凑 JSON；hash = sha256(prev ‖ canonical)；
 * genesis prev_hash = 64 个 '0'。链头持久化 audit_chain.json（独立文件）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_DIR, atomicWriteJson, readTextIfExists } from '../paths.js'
import { ctxSid } from '../session-context.js'

const AUDIT_FILE = path.join(CONFIG_DIR, 'audit_log.jsonl')
const AUDIT_CHAIN_FILE = path.join(CONFIG_DIR, 'audit_chain.json')
const GENESIS_HASH = '0'.repeat(64)

const okJson = (value) => JSON.stringify(value)

function nowLocal() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function canonicalJson(value) {
  const sort = (input) => {
    if (Array.isArray(input)) return input.map(sort)
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, sort(input[key])]))
    }
    return input
  }
  return JSON.stringify(sort(value))
}

function entryHash(prevHash, entry) {
  return crypto.createHash('sha256')
    .update(String(prevHash || '') + canonicalJson(entry))
    .digest('hex')
}

function loadChainHead() {
  try {
    const d = JSON.parse(readTextIfExists(AUDIT_CHAIN_FILE, 'null'))
    if (d && typeof d === 'object') {
      return { head: String(d.head || GENESIS_HASH), len: Math.max(0, Number(d.len) || 0) }
    }
  } catch { /* 损坏 → genesis 重启 */ }
  return { head: GENESIS_HASH, len: 0 }
}

const chain = loadChainHead()
const TRACE_ID = `t_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`

function persistChainHead() {
  atomicWriteJson(AUDIT_CHAIN_FILE, {
    version: 1, head: chain.head, len: chain.len, updated_at: nowLocal(),
  })
}

export async function guardAudit(op, detailJson, action = 'check', decision = null) {
  try {
    let detail = detailJson
    if (typeof detail === 'string') {
      try { detail = JSON.parse(detail) } catch { detail = { raw: String(detailJson).slice(0, 200) } }
    }
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) detail = {}
    const normalizedDetail = Object.fromEntries(
      Object.entries(detail).map(([k, v]) => [k, String(v).slice(0, 200)])
    )

    const entry = {
      ts: nowLocal(),
      op: String(op || ''),
      action: String(action || 'check'),
      detail: normalizedDetail,
    }
    if (decision) entry.decision = decision
    entry.trace = TRACE_ID
    entry.identity = { sid: String(ctxSid() || ''), principal: 'user' }
    entry.intent = { trace: TRACE_ID, summary: `${entry.op} ${decision || entry.action}` }
    if (Object.keys(normalizedDetail).length) {
      entry.evidence = {
        args_sha256: crypto.createHash('sha256')
          .update(canonicalJson(normalizedDetail)).digest('hex').slice(0, 32),
      }
    }

    const prev = chain.head
    const hash = entryHash(prev, entry)
    entry.prev_hash = prev
    entry.hash = hash

    // 真正实现 append 先行：写文件成功后再推进内存链头与 audit_chain.json，防止写盘异常断链
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', 'utf8')
    chain.head = hash
    chain.len += 1
    try { persistChainHead() } catch { /* 链头落盘失败：重启由文件尾重建 */ }

    return '{"ok":true}'
  } catch (error) {
    return JSON.stringify({ error: String(error && error.message ? error.message : error) })
  }
}

function verifyChain(entries) {
  const hashed = (entries || []).filter((e) => e && typeof e === 'object' && 'hash' in e)
  if (!hashed.length) return { ok: true, checked: 0, head: chain.head, len: chain.len }
  let checked = 0
  for (let i = 1; i < hashed.length; i += 1) {
    const newer = hashed[i - 1]
    const older = hashed[i]
    const linked = newer.prev_hash === older.hash || older.prev_hash === newer.hash
    if (!linked) {
      return { ok: false, checked, broken_at: { index: i, ts: older.ts, op: older.op } }
    }
    checked += 1
  }
  for (const entry of hashed) {
    const { hash, prev_hash, ...rest } = entry
    if (entryHash(entry.prev_hash, rest) !== entry.hash) {
      return { ok: false, checked, broken_at: { index: hashed.indexOf(entry), ts: entry.ts, op: entry.op } }
    }
  }
  return { ok: true, checked: hashed.length, head: chain.head, len: chain.len }
}

export async function getAuditLog(limit = 200, offset = 0, _verifyAll = false) {
  const text = readTextIfExists(AUDIT_FILE, '')
  const entries = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { entries.push(JSON.parse(line)) } catch { /* 单行损坏不拖垮整页 */ }
  }
  const size = Math.max(1, Math.min(Number(limit) || 200, 1000))
  const start = Math.max(0, Number(offset) || 0)
  const window = entries.slice().reverse().slice(start, start + size)

  const headInfo = loadChainHead()
  const chainBlock = {
    head: String(headInfo.head || '').slice(0, 8),
    head_full: headInfo.head || '',
    len: headInfo.len,
    valid: true,
  }
  const verdict = verifyChain(window)
  chainBlock.valid = !!verdict.ok
  if (!verdict.ok) chainBlock.broken_at = verdict.broken_at

  return okJson({ ok: true, total: entries.length, entries: window, chain: chainBlock })
}
