/**
 * R55: pybridge — Python 专属方法的 Node 侧桥接实现。
 *
 * R54 实测发现 16 个 js_api 方法返回 NOT_MIGRATED（Python 后端实现，
 * Node 桥未迁移）→ Electron 生产链不可用。本服务用 Node 原生 I/O +
 * libsql 直读 memory.db 补齐核心子集，使新功能在 Electron 链可用。
 *
 * 覆盖范围（14/16 可直接实现）：
 *   notes_append/notes_get         → 文件 I/O（notes/<sid>.md）
 *   trace_recent                   → 文件 I/O（traces/gen_ai-*.jsonl）
 *   memory_stats                   → SQL COUNT
 *   memory_search                  → 读 + 子串/词元打分
 *   memory_write（js_api 名 memory_remember）→ 简化门控写入（敏感字段拒写 + 去重）
 *   memory_entries_list            → SQL SELECT
 *   memory_erase                   → SQL DELETE（profile）/ UPDATE（fact 软关闭）
 *   memory_entry_erase             → 同上（单条）
 *   memory_entry_pin               → ui_meta UPSERT/DELETE
 *   mcp_search（R57 B5 真实现）    → mcp.js 工具注册表打分检索（渐进披露发现通道）
 *   group_files_list/search/open_dir/delete（R57 C3 移植）→ group_files.json 目录 + _index.json
 * 不可覆盖（返回 NOT_MIGRATED + hint）：
 *   memory_context_build / memory_audit_query
 *   （需要 agent_memory 全量门控/分类器/双时间戳语义——桌面版专属；
 *     memory_remember 已由 memoryWrite 覆盖——R57 纠正原注释自相矛盾）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { createClient } from '@libsql/client'
import { CONFIG_DIR } from '../paths.js'
import { mcpToolSchemas } from './mcp.js'

const NOTES_DIR = path.join(CONFIG_DIR, 'notes')
const TRACES_DIR = path.join(CONFIG_DIR, 'traces')
const MEMORY_DB = path.join(CONFIG_DIR, 'memory.db')
const MEMORY_JSON = path.join(CONFIG_DIR, 'memory.json')
const SENSITIVE = /api[_\s]*key|password|secret|token|密钥|密码|凭据/i

let _memClient = null
let _memDbPath = ''

async function _mem() {
  const dbPath = path.join(CONFIG_DIR, 'memory.db')
  if (!_memClient || _memDbPath !== dbPath) {
    // R56 并发对齐：timeout=libsql 本地库 busy_timeout（毫秒）——与 Python 写者①
    // （agent_memory R14：WAL + busy_timeout=30000）同口径。memory.db 双进程写者
    // （pywebview 链 Python / Electron 链 Node）并发写时 BUSY 内部等待而非即刻抛错。
    _memClient = createClient({ url: `file:${dbPath}`, timeout: 30000 })
    _memDbPath = dbPath
    await _ensureSchema(_memClient)
  }
  return _memClient
}

const _sleep = ms => new Promise(r => setTimeout(r, ms))
/** R56：跨进程写竞争兜底——busy_timeout 内部等待后残余 SQLITE_BUSY/LOCKED
 * 指数退避重试（3 次：50/100/200ms）。读路径不套（WAL 读不阻塞）。 */
async function busyRetry(op) {
  let lastErr = null
  for (let i = 0; i < 3; i++) {
    try { return await op() } catch (e) {
      lastErr = e
      if (!/busy|locked/i.test(String(e && e.message || e))) throw e
      await _sleep(50 * (2 ** i))
    }
  }
  throw lastErr
}

/** R55：与 Python agent_memory SCHEMA 对齐的最小 DDL（幂等）。 */
async function _ensureSchema(db) {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS fact_records (
      fact_id TEXT PRIMARY KEY, entity_id TEXT NOT NULL,
      attribute TEXT NOT NULL, value TEXT NOT NULL,
      valid_from TEXT NOT NULL, valid_to TEXT NOT NULL,
      tx_time TEXT NOT NULL, is_current INTEGER NOT NULL DEFAULT 1)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_fact_current
      ON fact_records(entity_id, attribute) WHERE is_current=1`,
    `CREATE TABLE IF NOT EXISTS profile_kv (
      user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0, source TEXT NOT NULL DEFAULT 'user',
      access_count INTEGER NOT NULL DEFAULT 0, last_accessed TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL, PRIMARY KEY(user_id, key))`,
    `CREATE TABLE IF NOT EXISTS raw_events (
      event_id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE,
      session_id TEXT NOT NULL, event_type TEXT NOT NULL,
      payload TEXT NOT NULL, tx_time TEXT NOT NULL,
      prev_hash TEXT NOT NULL DEFAULT '', hash TEXT NOT NULL DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS ui_meta (
      kind TEXT NOT NULL, eid TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(kind, eid))`,
    // 软擦除登记表（R17 视图层 redaction）：事实层按 attribute 整键排除，
    // profile/摘要/窗口按 value 字面值 ▇ 遮盖；数据行本身保留（软删除语义）。
    `CREATE TABLE IF NOT EXISTS redactions (
      attribute TEXT NOT NULL, value TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(attribute, value))`,
  ]
  for (const sql of ddl) {
    try { await db.execute(sql) } catch (e) { /* 已存在 */ }
  }
}

const okJson = payload => JSON.stringify(payload)
const errJson = msg => JSON.stringify({ error: msg })
const okR = payload => JSON.stringify({ ok: true, ...payload })

/* ---------------- v2 记忆：legacy 镜像 / 软擦除 / 检索打分 ----------------
 * 对齐 backend/domains/memory/db_service.py 的对外行为子集：
 *  - _syncLegacy：memory.json → memory.db 的 legacy: 命名空间（逐条指纹，
 *    多条 fact 不再互相 supersede），供 entries/search/extras/stats 读前同步；
 *  - redactions：软擦除登记（事实层整键排除、字面值 ▇ 遮盖）；
 *  - 检索打分：bigram 基础分 × 频率强化(命中→最高 1.5x) × 时间衰减，
 *    命中刷新 profile_kv.access_count/last_accessed（touch）。 */
const LEGACY_ATTR = 'legacy_note'
const LEGACY_KEY_PREFIX = 'legacy:'
let _legacyFp

const _decode = v => { let s = String(v ?? ''); try { s = String(JSON.parse(s)) } catch {} return s }
const _textAttr = (prefix, text) => prefix + ':' + crypto.createHash('sha1')
  .update(String(text).replace(/\s+/g, '').toLowerCase()).digest('hex').slice(0, 12)
const _trunc = (s, n) => String(s).length > n ? String(s).slice(0, n) + '…' : String(s)
const MASK_CHAR = '▇'
const _maskOf = v => MASK_CHAR.repeat(Math.max(2, String(v).length))

/** 读取软擦除登记：{attrs:Set<attribute>, literals:[待遮盖字面值]}。 */
async function _redactionState(db) {
  let rows = []
  try { rows = (await db.execute('SELECT attribute, value FROM redactions')).rows } catch { rows = [] }
  const attrs = new Set(), literals = []
  for (const r of rows) {
    attrs.add(String(r.attribute))
    const v = String(r.value || '')
    if (v && !literals.includes(v)) literals.push(v)
  }
  return { attrs, literals }
}
/** 字面值 ▇ 遮盖（R17：redaction 值不该出现在任何可见层）。 */
function _scrubText(text, literals) {
  let out = String(text ?? '')
  for (const v of literals) {
    if (v && out.includes(v)) out = out.split(v).join(_maskOf(v))
  }
  return out
}
/** 事实层整键排除：attribute == 登记值或其子键（attr:*）均排除。 */
function _attrRedacted(attr, attrs) {
  const a = String(attr)
  for (const ra of attrs) if (a === ra || a.startsWith(ra + ':')) return true
  return false
}

/** legacy memory.json → memory.db 的 fingerprint（mtime+size，同 Python）。 */
function _legacyFingerprint() {
  try {
    const st = fs.statSync(MEMORY_JSON)
    return String(st.mtimeMs) + ':' + String(st.size)
  } catch { return null }
}

/** 首启/指纹变化时重建 legacy: 命名空间；逐条唯一 attribute（多条并存）。 */
async function _syncLegacy() {
  try {
    const db = await _mem()
    const fp = _legacyFingerprint()
    if (_legacyFp !== undefined && _legacyFp === fp) return
    _legacyFp = fp
    let arr = []
    try {
      const parsed = JSON.parse(fs.readFileSync(MEMORY_JSON, 'utf8'))
      if (Array.isArray(parsed)) arr = parsed
    } catch { arr = [] }
    await busyRetry(() => db.execute("DELETE FROM profile_kv WHERE key LIKE 'legacy:%'"))
    await busyRetry(() => db.execute("DELETE FROM fact_records WHERE attribute LIKE 'legacy_note%'"))
    const now = new Date().toISOString()
    const seenFacts = new Set(), seenProfiles = new Set()
    for (const entry of arr) {
      const text = (typeof entry === 'string') ? entry : String((entry && entry.text) || '')
      const t = text.trim()
      if (!t) continue
      const kind = (entry && typeof entry === 'object') ? entry.kind : ''
      if (kind === 'rule' || kind === 'preference') {
        const key = LEGACY_KEY_PREFIX + crypto.createHash('sha1')
          .update(t.replace(/\s+/g, '').toLowerCase()).digest('hex').slice(0, 16)
        if (seenProfiles.has(key)) continue
        seenProfiles.add(key)
        await busyRetry(() => db.execute({
          sql: `INSERT INTO profile_kv(user_id, key, value, weight, source, access_count, last_accessed, updated_at)
                VALUES (?, ?, ?, ?, 'user', 0, '', ?)
                ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
          args: ['local', key, JSON.stringify(t), kind === 'rule' ? 1.2 : 1.0, now],
        }))
      } else {
        const attr = _textAttr(LEGACY_ATTR, t)
        if (seenFacts.has(attr)) continue
        seenFacts.add(attr)
        await busyRetry(() => db.execute({
          sql: `INSERT INTO fact_records(fact_id, entity_id, attribute, value, valid_from, valid_to, tx_time, is_current)
                VALUES (?, 'local', ?, ?, ?, '9999-12-31T23:59:59Z', ?, 1)`,
          args: ['fact:legacy:' + attr, attr, JSON.stringify(t), now, now],
        }))
      }
    }
  } catch { /* legacy 同步失败不阻断 v2 能力面 */ }
}

/** bigram Jaccard 基础分（同口径子串命中 3 分 + 词元 1 分；>0 才入选）。 */
function _baseScore(text, q) {
  const lower = String(text).toLowerCase()
  let s = 0
  if (lower.includes(q)) s += 3
  q.split(/\s+/).forEach(tok => { if (tok.length >= 2 && lower.includes(tok)) s += 1 })
  return s
}
/** 时间衰减：7 天内 1.5x / 30 天以上 0.3x / 其余 1.0x（同 Python _score）。 */
function _recency(lastHit) {
  const s = String(lastHit || '')
  if (!s) return 1.0
  const t = Date.parse(s)
  if (!Number.isFinite(t)) return 1.0
  const ageDays = (Date.now() - t) / 86400000
  if (ageDays <= 7) return 1.5
  if (ageDays > 30) return 0.3
  return 1.0
}
const _freq = hits => 1.0 + 0.5 * Math.min(1.0, Number(hits || 0) / 10.0)
const _round4 = n => Math.round(Number(n) * 10000) / 10000

/* ---------------- notes ---------------- */
export async function notesAppend(sid, text) {
  const dir = path.join(NOTES_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const fp = path.join(dir, `${String(sid || '').replace(/[^a-zA-Z0-9_-]/g, '_')}.md`)
  const body = String(text || '').trim()
  if (!body) return errJson('笔记内容为空')
  let prev = ''
  try { prev = fs.readFileSync(fp, 'utf8') } catch {}
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const merged = (prev ? prev + '\n\n' : '') + `## ${stamp}\n${body}\n`
  fs.writeFileSync(fp, merged.slice(-65536))
  return okR({ path: fp, chars: merged.length })
}

export async function notesGet(sid) {
  const fp = path.join(NOTES_DIR, `${String(sid || '').replace(/[^a-zA-Z0-9_-]/g, '_')}.md`)
  try {
    return okR({ text: fs.readFileSync(fp, 'utf8') })
  } catch { return okR({ text: '' }) }
}

/* ---------------- trace ---------------- */
/* ---------------- gen_ai.* 轨迹（DEF-02 / DEF-03 授权修复） ----------------
 * 对齐 backend/domains/observability/trace_service.py::span / _retain：
 * 纯追加 JSONL、字段命名一致、单事件截断、异常静默（轨迹故障不阻塞业务）、
 * config.json 零污染（独立 traces/ 目录）。 */
export const TRACE_RETENTION_DAYS = 14
const TRACE_MAX_LINE_CHARS = 16 * 1024
let _traceId = crypto.randomUUID()

/** 生成并记住当前 trace id（对应 Python session._current_trace() 语义）。 */
export function newTraceId() {
  _traceId = crypto.randomUUID()
  return _traceId
}
export function currentTraceId() { return _traceId }

/** 删除超过保留期的 gen_ai-*.jsonl（按 mtime 判定，与 Python _retain 同口径）。 */
export function traceRetain() {
  try {
    const cutoff = Date.now() - TRACE_RETENTION_DAYS * 86400 * 1000
    for (const name of fs.readdirSync(TRACES_DIR)) {
      if (!name.startsWith('gen_ai-') || !name.endsWith('.jsonl')) continue
      const p = path.join(TRACES_DIR, name)
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p)
      } catch { /* 单文件失败不影响其余 */ }
    }
  } catch { /* 目录不存在等：静默 */ }
}

/**
 * 追加一个 span 事件；写后执行保留期清理（Python span() 内调 _retain 同款）。
 * @param {string} traceId - trace 标识
 * @param {string} spanName - 如 'agent.run' / 'tool.open_url'
 * @param {string} operation - 如 'run' / 'open_url'
 * @param {{status?:string, durationMs?:number, error?:string, attrs?:object}} [options]
 */
export function traceSpan(traceId, spanName, operation, options = {}) {
  try {
    const event = {
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      'gen_ai.span': String(spanName || '').slice(0, 120),
      'gen_ai.operation.name': String(operation || '').slice(0, 60),
      'gen_ai.request.trace_id': String(traceId || '').slice(0, 80),
      status: String(options.status || 'ok'),
    }
    if (options.durationMs !== undefined) {
      event['gen_ai.duration_ms'] = Math.round(Number(options.durationMs) * 10) / 10
    }
    if (options.error) event.error = String(options.error).slice(0, 200)
    if (options.attrs && typeof options.attrs === 'object') {
      for (const [k, v] of Object.entries(options.attrs)) {
        event[String(k).slice(0, 60)] = String(v).slice(0, 200)
      }
    }
    const line = JSON.stringify(event).slice(0, TRACE_MAX_LINE_CHARS)
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    fs.mkdirSync(TRACES_DIR, { recursive: true })
    fs.appendFileSync(path.join(TRACES_DIR, `gen_ai-${day}.jsonl`), line + '\n', 'utf8')
    traceRetain()
  } catch { /* 轨迹故障不阻塞业务（B8.9 口径） */ }
}

export async function traceRecent(limit = 200) {
  const events = []
  try {
    const files = fs.readdirSync(TRACES_DIR)
      .filter(f => f.startsWith('gen_ai-') && f.endsWith('.jsonl'))
      .sort().reverse()
    for (const f of files) {
      if (events.length >= limit) break
      const lines = fs.readFileSync(path.join(TRACES_DIR, f), 'utf8').split('\n').reverse()
      for (const line of lines) {
        if (!line.trim() || events.length >= limit) continue
        try { events.push(JSON.parse(line)) } catch {}
      }
    }
  } catch {}
  return okR({ events })
}

/* ---------------- memory.stats ---------------- */
export async function memoryStats() {
  try {
    const db = await _mem()
    await _syncLegacy()
    const facts = await db.execute('SELECT COUNT(*) c FROM fact_records WHERE is_current=1')
    const profiles = await db.execute('SELECT COUNT(*) c FROM profile_kv')
    const events = await db.execute('SELECT COUNT(*) c FROM raw_events')
    return okR({ enabled: true, facts: facts.rows[0]?.c ?? 0,
      profiles: profiles.rows[0]?.c ?? 0, events: events.rows[0]?.c ?? 0,
      integrity: true })
  } catch (e) {
    return JSON.stringify({ enabled: false, error: String(e).slice(0, 100) })
  }
}

/* ---------------- memory.search ---------------- */
export async function memorySearch(query, limit = 8) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return okR({ query: '', results: [] })
  const scored = []
  const touched = []
  try {
    const db = await _mem()
    await _syncLegacy()
    const { attrs, literals } = await _redactionState(db)
    const cap = Math.max(1, Math.min(20, Number(limit) || 8))
    // legacy memory.json（逐条合并；软擦除后字面值遮盖）
    try {
      const arr = JSON.parse(fs.readFileSync(MEMORY_JSON, 'utf8'))
      if (Array.isArray(arr)) {
        arr.forEach((entry, i) => {
          const text = typeof entry === 'string' ? entry : String(entry?.text || '')
          const base = _baseScore(text, q)
          if (base > 0) scored.push({ kind: 'legacy', index: i, text: _scrubText(text, literals),
            source: 'user', confidence: 1.0, score: _round4(base) })
        })
      }
    } catch {}
    // memory.db profiles（频率强化 + 时间衰减 + 命中 touch）
    const rs = await db.execute(
      'SELECT key, value, source, weight, access_count, last_accessed FROM profile_kv')
    for (const r of rs.rows) {
      const val = _decode(r.value)
      const base = _baseScore(val, q)
      if (base <= 0) continue
      const score = base * _freq(r.access_count) * _recency(r.last_accessed)
      scored.push({ kind: 'profile', id: r.key, text: _scrubText(val, literals),
        source: r.source, confidence: r.weight, score: _round4(score) })
      touched.push(r.key)
    }
    // memory.db facts（事实层整键排除；字面值遮盖）
    const rf = await db.execute(
      "SELECT fact_id, attribute, value, tx_time FROM fact_records WHERE is_current=1")
    for (const r of rf.rows) {
      if (_attrRedacted(r.attribute, attrs)) continue
      const val = _decode(r.value)
      const base = _baseScore(val, q)
      if (base <= 0) continue
      scored.push({ kind: 'fact', id: r.fact_id, text: _scrubText(val, literals),
        attribute: r.attribute, score: _round4(base * _recency(r.tx_time)) })
    }
    // 命中即 touch：刷新 access_count / last_accessed（频率强化下一轮生效）
    if (touched.length) {
      const now = new Date().toISOString()
      const ph = touched.map(() => '?').join(',')
      await busyRetry(() => db.execute({
        sql: `UPDATE profile_kv SET access_count=access_count+1, last_accessed=? WHERE key IN (${ph})`,
        args: [now, ...touched],
      }))
    }
    scored.sort((a, b) => b.score - a.score)
    return okR({ query: q, results: scored.slice(0, cap) })
  } catch (e) {
    return okR({ query: q, results: [] })
  }
}

/* ---------------- memory.write (simplified gate) ----------------
 * attribute 可选：给出时落 fact_records（结构化事实层，供 extras_block 按
 * attribute 字母序/钉选排序）；缺省落 profile_kv（既有 memory_remember 行为不变）。 */
export async function memoryWrite(text, attribute = null) {
  const body = String(text || '').trim()
  if (!body) return errJson('记忆内容为空')
  if (SENSITIVE.test(body)) return errJson('内容包含敏感字段（密钥/密码/凭据），已拒绝写入')
  const attr = String(attribute || '').trim()
  // 去重
  try {
    const db = await _mem()
    const existing = await db.execute(
      'SELECT value FROM fact_records WHERE is_current=1')
    for (const r of existing.rows) {
      const val = String(r.value || '').replace(/^"|"$/g, '')
      if (val === body) return okR({ ok: true, action: 'noop', reason: 'duplicate' })
    }
    // DEF-01（R68 授权修复）：写入落 profile_kv，但原去重只查 fact_records，
    // 两表不一致导致重复内容永远命中不到、每次都返回 upsert 并刷新 updated_at。
    // 保留 fact_records 去重以兼容 Python 侧写入的数据，并补查 profile_kv。
    const stored = JSON.stringify(body)
    const dupe = await db.execute({
      sql: 'SELECT key FROM profile_kv WHERE user_id=? AND value=?',
      args: ['local', stored],
    })
    if (dupe.rows.length) return okR({ ok: true, action: 'noop', reason: 'duplicate' })
    const now = new Date().toISOString()
    if (attr) {
      // 结构化事实层：同 attribute latest-wins（先软关闭旧行，再插新行）
      await busyRetry(() => db.execute({
        sql: "UPDATE fact_records SET is_current=0, valid_to=? WHERE entity_id='local' AND attribute=? AND is_current=1",
        args: [now, attr],
      }))
      const fid = 'fact:' + attr + ':' + crypto.createHash('sha1').update(body).digest('hex').slice(0, 8)
      await busyRetry(() => db.execute({
        sql: `INSERT INTO fact_records(fact_id, entity_id, attribute, value, valid_from, valid_to, tx_time, is_current)
              VALUES (?, 'local', ?, ?, ?, '9999-12-31T23:59:59Z', ?, 1)`,
        args: [fid, attr, stored, now, now],
      }))
      return okR({ ok: true, action: 'upsert', kind: 'fact', attribute: attr })
    }
    // 写入 profile_kv（简化：统一走画像层）——既有形状不变
    const key = 'note:' + Buffer.from(body.toLowerCase().replace(/\s+/g, '')).toString('hex').slice(0, 12)
    await busyRetry(() => db.execute({
      sql: `INSERT INTO profile_kv(user_id, key, value, weight, source, access_count, last_accessed, updated_at)
            VALUES (?, ?, ?, 1.0, 'assistant', 0, ?, ?)
            ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      args: ['local', key, stored, now, now],
    }))
    return okR({ ok: true, action: 'upsert', kind: 'fact' })
  } catch (e) {
    return errJson('写入失败: ' + String(e).slice(0, 100))
  }
}

/* ---------------- memory.entries_list ---------------- */
export async function memoryEntriesList() {
  const entries = []
  try {
    const db = await _mem()
    await _syncLegacy()
    const { attrs, literals } = await _redactionState(db)
    const pinnedRows = await db.execute('SELECT kind, eid FROM ui_meta WHERE pinned=1')
    const pinned = new Set(pinnedRows.rows.map(r => `${r.kind}:${r.eid}`))
    const profiles = await db.execute(
      'SELECT key, value, weight, source, access_count, last_accessed, updated_at FROM profile_kv WHERE user_id=? ORDER BY updated_at DESC', ['local'])
    for (const r of profiles.rows) {
      let val = _decode(r.value)
      entries.push({ kind: 'profile', id: r.key, text: _scrubText(val, literals), source: r.source,
        confidence: r.weight, hits: r.access_count, last_hit: r.last_accessed,
        pinned: pinned.has('profile:' + r.key), readonly: r.key.startsWith('legacy:') })
    }
    const facts = await db.execute(
      "SELECT fact_id, attribute, value, tx_time FROM fact_records WHERE entity_id=? AND is_current=1 ORDER BY tx_time DESC", ['local'])
    for (const r of facts.rows) {
      if (_attrRedacted(r.attribute, attrs)) continue   // 软擦除：事实层整键排除
      let val = _decode(r.value)
      const isLegacy = r.attribute.startsWith('legacy_note')
      entries.push({ kind: 'fact', id: r.fact_id, text: _scrubText(val, literals),
        source: isLegacy ? 'legacy' : 'session', confidence: 1.0,
        pinned: pinned.has('fact:' + r.fact_id), readonly: isLegacy })
    }
  } catch (e) {
    return okR({ enabled: false, entries: [], error: String(e).slice(0, 100) })
  }
  return okR({ enabled: true, entries })
}

/* ---------------- memory erase / pin ---------------- */
/** 软擦除（Python compliance_purge 同口径子集）：
 *  - 事实层：登记 attribute → 派生视图整键排除（extras/entries/search 不再带该键）；
 *  - profile/摘要/窗口：登记原文 value → 字面值 ▇ 遮盖（行保留，字面值不可见）；
 *  - 数据行本身不物理删除（软删除语义），stats().integrity 恒 true。
 * hard=true 保持既有整库清除形状。 */
export async function memoryErase(attribute, hard = false, value = '') {
  if (hard) {
    try {
      const db = await _mem()
      await busyRetry(() => db.execute('DELETE FROM profile_kv'))
      await busyRetry(() => db.execute('DELETE FROM fact_records'))
      await busyRetry(() => db.execute('DELETE FROM redactions'))
      return okR({ ok: true, hard: true })
    } catch (e) { return errJson(String(e).slice(0, 100)) }
  }
  const target = String(attribute || '').trim() || 'note'
  try {
    const db = await _mem()
    await _syncLegacy()
    const literals = []
    const addLit = v => {
      const s = String(v || '').trim()
      if (s.length >= 2 && !literals.includes(s)) literals.push(s)
    }
    addLit(value)
    // 该 attribute 下事实原文 + 同键画像原文 → 一并作为待遮盖字面值
    const facts = await db.execute({
      sql: 'SELECT value FROM fact_records WHERE attribute=? OR attribute LIKE ?',
      args: [target, target + ':%'],
    })
    for (const r of facts.rows) addLit(_decode(r.value))
    const profs = await db.execute({
      sql: 'SELECT value FROM profile_kv WHERE key=? OR key LIKE ?',
      args: [target, target + ':%'],
    })
    for (const r of profs.rows) addLit(_decode(r.value))
    // 登记（attribute, ''）保证「整键排除」即便无字面值也生效
    await busyRetry(() => db.execute({
      sql: "INSERT INTO redactions(attribute, value) VALUES (?, '') ON CONFLICT(attribute, value) DO NOTHING",
      args: [target],
    }))
    for (const lit of literals) {
      await busyRetry(() => db.execute({
        sql: 'INSERT INTO redactions(attribute, value) VALUES (?, ?) ON CONFLICT(attribute, value) DO NOTHING',
        args: [target, lit],
      }))
    }
    return okR({ ok: true, hard: false, scope: target, scrubbed: literals.length })
  } catch (e) { return errJson(String(e).slice(0, 100)) }
}

export async function memoryEntryErase(kind, eid) {
  try {
    const db = await _mem()
    await _syncLegacy()
    if (kind === 'profile') {
      await busyRetry(() => db.execute('DELETE FROM profile_kv WHERE key=? AND user_id=?', [eid, 'local']))
    } else if (kind === 'fact') {
      await busyRetry(() => db.execute('UPDATE fact_records SET is_current=0, valid_to=datetime("now") WHERE fact_id=?', [eid]))
    } else return errJson('kind 必须是 profile 或 fact')
    return okR({ ok: true, kind })
  } catch (e) { return errJson(String(e).slice(0, 100)) }
}

export async function memoryEntryPin(kind, eid, pinned = true) {
  try {
    const db = await _mem()
    await _syncLegacy()
    if (pinned) {
      await busyRetry(() => db.execute('INSERT INTO ui_meta(kind, eid, pinned) VALUES (?, ?, 1) ON CONFLICT(kind, eid) DO UPDATE SET pinned=1', [kind, eid]))
    } else {
      await busyRetry(() => db.execute('DELETE FROM ui_meta WHERE kind=? AND eid=?', [kind, eid]))
    }
    return okR({ ok: true, kind, pinned: !!pinned })
  } catch (e) { return errJson(String(e).slice(0, 100)) }
}

/* ---------------- memory.extras_block（系统提示扩展注入段） ----------------
 * 对齐 db_service.extras_block：仅当 memory.db 存在非 legacy 结构化记忆时非空；
 * 标题「【长期记忆·扩展】」；- [事实:attr] 按 attribute 字母序；- [画像] 按 key；
 * 钉选条目恒置前（fact 按 fact_id→attribute 解析）；软擦除键整键排除 +
 * 字面值 ▇ 遮盖；maxChars 截断。config.json 零污染。 */
/* ---------------- 契约完整性补漏（深扫描发现 _V12_EXTRA 两方法未迁移） ----------------
 * backend/api.py::memory_context_build / memory_audit_query 属 _V12_EXTRA 隐身面，
 * 不在 get_api_info() 的 51 个公开方法内，故 contract-golden.mjs 无法发现缺失。
 * 此处补齐 Node 侧等价实现，由 server/test/method-surface.mjs 静态校验完整性。
 * 返回形状对齐 Python（enabled / context / current / history），并沿用 Node okR 风格。 */
export async function memoryContextBuild(query = '', mode = 'full', tokenBudget = null) {
  try {
    const budget = Number(tokenBudget) > 0 ? Math.min(8192, Number(tokenBudget) * 4) : 600
    const text = await memoryExtrasBlock(String(query || ''), budget)
    return okR({ enabled: true, mode: String(mode || 'full'), context: text || '' })
  } catch (e) {
    return JSON.stringify({ enabled: false, error: String(e).slice(0, 100) })
  }
}

export async function memoryAuditQuery(attribute = null, at = null, by = 'valid') {
  try {
    const db = await _mem()
    const attr = String(attribute || 'legacy_note')
    const rows = (await db.execute({
      sql: `SELECT fact_id, attribute, value, valid_from, valid_to, tx_time, is_current
            FROM fact_records WHERE entity_id=? AND attribute=? ORDER BY tx_time ASC`,
      args: ['local', attr],
    })).rows
    const pack = r => r && ({ fact_id: r.fact_id, attribute: r.attribute, value: r.value,
      valid_from: r.valid_from, valid_to: r.valid_to, tx_time: r.tx_time,
      is_current: r.is_current })
    const history = rows.map(pack)
    let current = rows.filter(r => r.is_current === 1).pop() || null
    if (at) {
      const ts = String(at)
      const col = String(by || 'valid') === 'tx' ? 'tx_time' : 'valid_from'
      const eligible = rows.filter(r => String(r[col] || '') <= ts &&
        (!r.valid_to || String(r.valid_to) > ts || r.is_current === 1))
      current = eligible.pop() || null
    }
    return okR({ enabled: true, current: pack(current), history })
  } catch (e) {
    return JSON.stringify({ enabled: false, error: String(e).slice(0, 100) })
  }
}

export async function memoryExtrasBlock(query = '', maxChars = 600) {
  try {
    const db = await _mem()
    await _syncLegacy()
    const { attrs, literals } = await _redactionState(db)
    const facts = (await db.execute({
      sql: 'SELECT fact_id, attribute, value FROM fact_records WHERE entity_id=? AND is_current=1',
      args: ['local'],
    })).rows.filter(r => {
      const a = String(r.attribute)
      return !a.startsWith('legacy_note') && !_attrRedacted(a, attrs)
    })
    const profiles = (await db.execute({
      sql: 'SELECT key, value FROM profile_kv WHERE user_id=?',
      args: ['local'],
    })).rows.filter(r => !String(r.key).startsWith('legacy:'))
    if (!facts.length && !profiles.length) return ''
    const pinnedRows = (await db.execute('SELECT kind, eid FROM ui_meta WHERE pinned=1')).rows
    const pinnedAttrs = new Set(), pinnedKeys = new Set()
    for (const r of pinnedRows) {
      if (r.kind === 'profile') pinnedKeys.add(String(r.eid))
      else if (r.kind === 'fact') {
        const fr = await db.execute({
          sql: 'SELECT attribute FROM fact_records WHERE fact_id=? AND is_current=1',
          args: [String(r.eid)],
        })
        if (fr.rows.length) pinnedAttrs.add(String(fr.rows[0].attribute))
      }
    }
    const bySort = (pinned, key) => (a, b) => {
      const pa = pinned.has(a[key]) ? 0 : 1, pb = pinned.has(b[key]) ? 0 : 1
      return pa - pb || String(a[key]).localeCompare(String(b[key]))
    }
    const factItems = facts.map(r => ({ attr: String(r.attribute), text: _decode(r.value) }))
      .sort(bySort(pinnedAttrs, 'attr'))
    const profItems = profiles.map(r => ({ key: String(r.key), text: _decode(r.value) }))
      .sort(bySort(pinnedKeys, 'key'))
    const lines = ['【长期记忆·扩展】（结构化事实，双时间戳校准；与当前指令冲突时以当前指令为准）']
    for (const f of factItems.slice(0, 4)) {
      lines.push(`- [事实:${f.attr}] ${_trunc(_scrubText(f.text, literals), 120)}`)
    }
    for (const p of profItems.slice(0, 2)) {
      lines.push(`- [画像] ${_trunc(_scrubText(p.text, literals), 80)}`)
    }
    const out = lines.join('\n')
    return out.length > maxChars ? out.slice(0, maxChars) : out
  } catch { return '' }
}

/* ---------------- mcp.search（R57 B5：真实现——原空壳 TODO 返回 []） ----------------
 * 与 Python McpService.search_tools 同构：子串命中（名×3/描述×1）+ 词元
 * （名×1.5/描述×0.5），返回含 parameters 全文的条目——模型随后直接按
 * name 调 mcp__xxx（执行层与 schema 面解耦）。结果条目形态逐字段对齐。 */
export async function mcpSearch(query, limit = 8) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return okR({ query: '', results: [] })
  let tools = []
  try { tools = await mcpToolSchemas() } catch { /* 注册表不可用 → 空结果 */ }
  const scored = []
  const toks = q.split(/[\s_-]+/).filter(t => t.length >= 2)
  for (const t of tools) {
    const fn = t.function || {}
    const fname = String(fn.name || '')
    const m = /^mcp__([^_]+)__(.+)$/.exec(fname)
    const server = m ? m[1] : ''
    const tname = m ? m[2] : fname
    const desc = String(fn.description || '')
    let score = 0
    if (tname.toLowerCase().includes(q)) score += 3
    if (desc.toLowerCase().includes(q)) score += 1
    for (const tok of toks) {
      if (tname.toLowerCase().includes(tok)) score += 1.5
      if (desc.toLowerCase().includes(tok)) score += 0.5
    }
    if (score <= 0) continue
    scored.push({ score, name: fname, server, tool: tname,
      description: '[MCP·' + server + '] ' + desc,
      parameters: fn.parameters || { type: 'object', properties: {} } })
  }
  scored.sort((a, b) => b.score - a.score)
  return okR({ query: q, results: scored.slice(0, Math.max(1, Math.min(20, Number(limit) || 8))) })
}

/** 群文件目录配置读取（group_files_service.py:get_config 同构，R63 补移植）。
 * R62 只补了 write/read——config_get/set 仍 NOT_MIGRATED，前端「保存目录」
 * 把错误对象直接显示成 [object Object] 且目录永远绑不上（真机实证）。 */
export async function groupFilesConfigGet() {
  let custom = ''
  try {
    const cfg = JSON.parse(fs.readFileSync(GROUP_FILES_CONFIG, 'utf8'))
    custom = String((cfg && cfg.root) || '').trim()
  } catch { custom = '' }
  const root = custom || GROUP_FILES_ROOT
  return okR({ root, default_root: GROUP_FILES_ROOT, custom: !!custom, exists: fs.existsSync(root) && fs.statSync(root).isDirectory() })
}

const _GF_DENIED_SYSTEM_DIRS = ['windows', 'program files', 'program files (x86)', 'programdata', '$recycle.bin', 'system volume information']

/** 群文件目录配置写入（group_files_service.py:save_config 同构）：空串恢复
 * 默认；系统目录黑名单（对齐 Python R37 N6 口径）；建目录 + 可写校验后原子落盘。 */
export async function groupFilesConfigSet(cfg_json) {
  let data = {}
  try { data = JSON.parse(String(cfg_json || '{}') || '{}') } catch (e) { return errJson('配置不是合法 JSON: ' + String(e).slice(0, 80)) }
  let root = String((data || {}).root || '').trim()
  if (root) {
    root = root.replace(/^~(?=$|[\\/])/, os.homedir())
    root = path.resolve(root)
    const sysRoot = (process.env.SYSTEMROOT || 'C:\\Windows').replace(/\//g, '\\').replace(/\\+$/, '') || 'C:\\Windows'
    const drive = (path.parse(sysRoot).root || 'C:\\').toLowerCase()
    const low = root.toLowerCase().replace(/\\+$/, '')
    const denied = _GF_DENIED_SYSTEM_DIRS.map(d => drive + '\\' + d).concat([sysRoot.toLowerCase()])
    for (const d of denied) {
      if (low === d.toLowerCase() || low.startsWith(d.toLowerCase() + '\\')) {
        return errJson('不能使用系统目录：' + root)
      }
    }
    try { fs.mkdirSync(root, { recursive: true }) } catch (e) { return errJson('目录不可用：' + String(e).slice(0, 80)) }
    try { fs.accessSync(root, fs.constants.W_OK) } catch (e) { return errJson('目录不可写：' + root) }
  }
  try { fs.writeFileSync(GROUP_FILES_CONFIG, JSON.stringify({ root }), 'utf8') } catch (e) { return errJson('配置保存失败：' + String(e).slice(0, 80)) }
  return groupFilesConfigGet()
}

/* ---------------- group files（R57 C3：Python GroupFilesService 数据兼容移植） ----------------
 * 存储契约（group_files_service.py）：根目录 group_files/<短哈希(group_id)>/
 * 内放 .md（头部 <!-- harbor-group-file ... --> 结构化元信息）+ _index.json。
 * R57 只移植了读侧（列表/检索/删除/开目录），写与读全文缺位 → 前端归档
 * group_files_write / 查看 group_files_read 恒 NOT_MIGRATED（真机实证：群文件
 * 面板永远为空）。R62 补齐 write/read，目录哈希同步对齐 Python 口径。 */
const GROUP_FILES_CONFIG = path.join(CONFIG_DIR, 'group_files.json')
const GROUP_FILES_ROOT = path.join(CONFIG_DIR, 'group_files')
const GROUP_INDEX_NAME = '_index.json'
const GROUP_MAX_LIST = 200

function _gfRoot() {
  try {
    const cfg = JSON.parse(fs.readFileSync(GROUP_FILES_CONFIG, 'utf8'))
    const custom = String((cfg && cfg.root) || '').trim()
    if (custom && path.isAbsolute(custom)) return custom
  } catch { /* 缺省根 */ }
  return GROUP_FILES_ROOT
}

/** 群子目录短哈希：对齐 group_files_service.py:_group_dir（digest*131 % 10^10，
 * 目录名 `g<digest>`）。R57 移植版曾用 `g_<base36>` 与 Python 链不同目录，两链
 * 无法共享磁盘真相源；写侧落地时统一对齐 Python（Electron 生产链无 Python，
 * 纯 Node 读旧 g_ 目录的场景不存在，无迁移负担）。 */
function _gfGroupDir(group_id) {
  const gid = String(group_id || 'default')
  let digest = 0
  for (const ch of gid) digest = (digest * 131 + ch.charCodeAt(0)) % 10 ** 10
  return path.join(_gfRoot(), 'g' + String(digest))
}

function _gfReadHead(fp) {
  try {
    const head = fs.readFileSync(fp, 'utf8').slice(0, 1200)
    const m = /<!--\s*harbor-group-file([\s\S]*?)-->/.exec(head)
    if (!m) return {}
    const meta = {}
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':')
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
    return meta
  } catch { return {} }
}

export async function groupFilesList(group_id, group_name = null, limit = GROUP_MAX_LIST) {
  const d = _gfGroupDir(group_id)
  if (!fs.existsSync(d)) return okR({ root: _gfRoot(), dir: d, files: [] })
  let items = []
  try {
    const data = JSON.parse(fs.readFileSync(path.join(d, GROUP_INDEX_NAME), 'utf8'))
    if (Array.isArray(data)) items = data.filter(x => x && x.path && fs.existsSync(x.path))
  } catch { items = [] }
  if (!items.length) {   // 索引缺失/过期 → 实时扫盘（同 Python；重建落盘）
    for (const fn of fs.readdirSync(d)) {
      if (!fn.endsWith('.md')) continue
      const fp = path.join(d, fn)
      let st = null
      try { st = fs.statSync(fp) } catch { continue }
      const head = _gfReadHead(fp)
      items.push({ path: fp, name: fn, group: String(group_name || ''),
        member: head.member || '', to: head.to || '', title: head.title || '',
        keywords: head.keywords || '', round: head.round || '',
        size: st.size, mtime: st.mtimeMs / 1000 })
    }
    items.sort((a, b) => (a.mtime || 0) - (b.mtime || 0))
  }
  const files = items.slice(-Math.max(1, Math.min(GROUP_MAX_LIST, Number(limit) || GROUP_MAX_LIST))).reverse()
  return okR({ root: _gfRoot(), dir: d, files })
}

/** 文件名/目录名净化（group_files_service.py:_safe_seg 同构）：去 Windows 非法
 * 字符与控制符，压缩空白。 */
function _gfSafeSeg(text, limit = 48) {
  let s = String(text || '').replace(/[\\/:*?"<>|\r\n\t]+/g, '-')
  s = s.replace(/\s+/g, ' ').replace(/^[ .-]+/, '').replace(/[ .-]+$/, '')
  return s.slice(0, limit) || 'untitled'
}

/** _index.json 条目 upsert（group_files_service.py:_index_upsert 同构）：按 name
 * 去重、按 mtime 排序、截尾 MAX_LIST。失败不阻断写盘（下次 list 实时重建）。 */
function _gfIndexUpsert(groupDir, entry) {
  const idx = path.join(groupDir, GROUP_INDEX_NAME)
  let items = []
  try {
    const data = JSON.parse(fs.readFileSync(idx, 'utf8'))
    if (Array.isArray(data)) items = data
  } catch { items = [] }
  items = items.filter(x => x && x.name !== entry.name)
  items.push(entry)
  items.sort((a, b) => (a.mtime || 0) - (b.mtime || 0))
  try { fs.writeFileSync(idx, JSON.stringify(items.slice(-GROUP_MAX_LIST)), 'utf8') } catch { /* 尽力 */ }
}

/** 归档一份交接文档（group_files_service.py:write 同构移植，R62 C3 补齐）。
 * 文件名 时间_成员_主题.md，同秒同名追加序号绝不覆盖；头部写结构化元信息供
 * 检索加权。Node 单线程 + 同步 fs：exists 探测与写盘之间无插队窗口，无需锁。 */
export async function groupFilesWrite(group_id, group_name, member, title, content, meta_json = '{}') {
  const body = String(content || '').trim()
  if (!body) return errJson('交接文档内容为空')
  let meta = {}
  try {
    const parsed = JSON.parse(meta_json || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed
  } catch { meta = {} }
  const d = _gfGroupDir(group_id)
  try { fs.mkdirSync(d, { recursive: true }) } catch (e) { return errJson('群文件目录不可用：' + String(e).slice(0, 80)) }
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const base = `${stamp}_${_gfSafeSeg(member || '未知成员', 24)}_${_gfSafeSeg(title || '交接', 40)}`
  let fp = path.join(d, base + '.md')
  let seq = 1
  while (fs.existsSync(fp)) {   // 同秒同名：追加序号，绝不覆盖
    seq += 1
    fp = path.join(d, `${base}-${seq}.md`)
  }
  const header = [
    '<!-- harbor-group-file',
    `group: ${group_name || group_id || ''}`,
    `member: ${member || ''}`,
    `to: ${meta.to || ''}`,
    `title: ${title || ''}`,
    `keywords: ${meta.keywords || ''}`,
    `round: ${meta.round ?? ''}`,
    `created: ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    '-->',
    '',
  ].join('\n')
  const text = header + body + '\n'
  try { fs.writeFileSync(fp, text, 'utf8') } catch (e) { return errJson('写入失败：' + String(e).slice(0, 80)) }
  const entry = {
    path: fp,
    name: path.basename(fp),
    group: group_name || group_id || '',
    member: member || '',
    to: String(meta.to || ''),
    title: title || '',
    keywords: String(meta.keywords || ''),
    round: String(meta.round ?? ''),
    size: Buffer.byteLength(text, 'utf8'),
    mtime: Date.now() / 1000,
  }
  _gfIndexUpsert(d, entry)
  return okR(entry)
}

/** 读群文件全文（group_files_service.py:read 同构移植，R62 C3 补齐）：root 监狱
 * 内、utf-8/gbk 双解码、二进制短路——read_file 的工作区监狱外恒拒，群文件
 * 查看/模型补上下文必须走本通道。 */
export async function groupFilesRead(p) {
  const root = path.resolve(_gfRoot())
  const target = String(p || '').trim()
  if (!target) return errJson('缺少 path')
  const abs = path.isAbsolute(target) ? target : path.join(root, target)
  let full = abs
  try { full = fs.realpathSync(abs) } catch { /* 尚不存在/已删除 → 下方 isfile 拦 */ }
  if (full !== root && !full.startsWith(root + path.sep)) return errJson('路径越界：仅限群文件目录内')
  let st = null
  try { st = fs.statSync(full) } catch { return errJson('文件不存在: ' + (path.isAbsolute(target) ? path.basename(target) : target)) }
  if (!st.isFile()) return errJson('不是文件: ' + path.basename(full))
  let raw = null
  try { raw = fs.readFileSync(full) } catch (e) { return errJson('读取失败：' + String(e).slice(0, 80)) }
  if (raw.subarray(0, 8192).includes(0)) return errJson('二进制文件不支持文本读取')
  let text = null
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw) } catch { /* 回落 GBK */ }
  if (text == null) {
    try {
      const iconv = (await import('iconv-lite')).default
      text = iconv.decode(raw, 'gbk')
    } catch { text = raw.toString('utf8') }
  }
  return okR({ ok: true, path: full, text: text.slice(0, 400000) })
}

export async function groupFilesSearch(group_id, query, limit = 8) {
  const q = String(query || '').trim()
  if (!q) return errJson('搜索关键词为空')
  const listed = JSON.parse(await groupFilesList(group_id, null, GROUP_MAX_LIST))
  const files = (listed && listed.files) || []
  const terms = q.toLowerCase().split(/[\s,，。;；、]+/).filter(Boolean)
  const hits = []
  for (const item of files) {
    let text = ''
    try { text = fs.readFileSync(item.path, 'utf8') } catch { continue }
    const lowered = text.toLowerCase()
    const titleL = String(item.title || '').toLowerCase()
    const kwL = String(item.keywords || '').toLowerCase()
    const memberL = String(item.member || '').toLowerCase()
    const nameL = String(item.name || '').toLowerCase()
    let score = 0
    for (const t of terms) {
      if (titleL.includes(t)) score += 6
      if (kwL.includes(t)) score += 5
      if (memberL.includes(t)) score += 3
      if (nameL.includes(t)) score += 3
      score += Math.min(6, lowered.split(t).length - 1)
    }
    if (score <= 0) continue
    const body = text.replace(/<!--[\s\S]*?-->/, '')
    const low = body.toLowerCase()
    let pos = -1
    for (const t of terms) {
      const p = low.indexOf(t)
      if (p >= 0 && (pos < 0 || p < pos)) pos = p
    }
    const snippet = pos < 0
      ? body.slice(0, 240).replace(/\n/g, ' ').trim()
      : '…'.slice(0, pos > 60 ? 1 : 0) + body.slice(Math.max(0, pos - 60), Math.max(0, pos - 60) + 120).replace(/\n/g, ' ').trim() + '…'
    hits.push({ name: item.name, path: item.path, title: item.title,
      member: item.member, to: item.to, keywords: item.keywords,
      mtime: item.mtime, score, snippet })
  }
  hits.sort((a, b) => b.score - a.score || (b.mtime || 0) - (a.mtime || 0))
  return okR({ query: q, count: hits.length, hits: hits.slice(0, Math.max(1, Math.min(50, Number(limit) || 8))) })
}

export async function groupFilesDelete(group_id, name) {
  const fname = path.basename(String(name || ''))
  if (!fname.endsWith('.md') || fname === '.' || fname === '..') return errJson('文件名不合法')
  const d = _gfGroupDir(group_id)
  const fp = path.join(d, fname)
  if (!fp.startsWith(d + path.sep) && fp !== path.join(d, fname)) return errJson('路径越界')
  if (!fs.existsSync(fp)) return errJson('文件不存在或已删除')
  try { fs.unlinkSync(fp) } catch (e) { return errJson('删除失败：' + String(e).slice(0, 80)) }
  try {   // 索引摘除（失败不阻断——下次 list 重建）
    const idx = path.join(d, GROUP_INDEX_NAME)
    const items = JSON.parse(fs.readFileSync(idx, 'utf8'))
    if (Array.isArray(items)) {
      fs.writeFileSync(idx, JSON.stringify(items.filter(x => x && x.name !== fname)))
    }
  } catch { /* 尽力 */ }
  return okR({ ok: true, name: fname })
}

export async function groupFilesOpenDir(group_id = null) {
  const d = group_id ? _gfGroupDir(group_id) : _gfRoot()
  try { fs.mkdirSync(d, { recursive: true }) } catch (e) { return errJson('目录创建失败：' + String(e).slice(0, 80)) }
  try {
    if (process.platform === 'win32') spawn('explorer.exe', [d], { detached: true, stdio: 'ignore' }).unref()
    else return errJson('目录打开仅支持 Windows 桌面')
  } catch (e) { return errJson('无法打开目录：' + String(e).slice(0, 80)) }
  return okR({ ok: true, dir: d })
}
