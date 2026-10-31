/**
 * 审计日志（P0-1b G11：与 Python audit_chain.py + guard_service.audit 同构）与
 * 搜索缓存统计、历史目录配置。
 *
 * 审计条目形状（Python guard_service.audit 五维 + 哈希链）：
 *   {ts, op, action, detail, decision?, trace?, identity:{sid,principal},
 *    intent:{trace,summary}, evidence?:{args_sha256}, prev_hash, hash}
 * 链算法：canonical = 键排序紧凑 JSON；hash = sha256(prev ‖ canonical)；
 * genesis prev_hash = 64 个 '0'。链头持久化 audit_chain.json（独立文件）。
 * ts 口径：本地 '%Y-%m-%d %H:%M:%S'（Python B8.5 禁改口径）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_DIR, atomicWriteJson, readTextIfExists } from '../paths.js'
import { readConfigJson, mergeConfig, readConfigNormalized } from './jsonstore.js'
import { CONFIG_SPECS } from './config-specs.js'
import { runtime } from '../runtime.js'

const AUDIT_FILE = path.join(CONFIG_DIR, 'audit_log.jsonl')
const AUDIT_CHAIN_FILE = path.join(CONFIG_DIR, 'audit_chain.json')
const GENESIS_HASH = '0'.repeat(64)

const okJson = value => JSON.stringify(value)

function nowLocal() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 键排序紧凑序列化（与 Python canonical_json 同构：sort_keys+separators）。 */
function canonicalJson(value) {
  const sort = input => {
    if (Array.isArray(input)) return input.map(sort)
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.keys(input).sort()
        .map(key => [key, sort(input[key])]))
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

/* ---------------- 链头状态（进程内 + 原子落盘） ---------------- */
function loadChainHead() {
  try {
    const d = JSON.parse(readTextIfExists(AUDIT_CHAIN_FILE, 'null'))
    if (d && typeof d === 'object') {
      return { head: String(d.head || GENESIS_HASH), len: Math.max(0, Number(d.len) || 0) }
    }
  } catch { /* 损坏 → genesis 重启（Python 同口径） */ }
  return { head: GENESIS_HASH, len: 0 }
}

const chain = loadChainHead()

/** 进程级 trace id（Python SessionCoordinator 装配即有当前 trace；js_api 侧
 * 每条审计带 trace 键。差分归一按 id 键掩蔽，值形态无关紧要——键存在性对齐）。 */
const TRACE_ID = `t_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`

function persistChainHead() {
  atomicWriteJson(AUDIT_CHAIN_FILE, {
    version: 1, head: chain.head, len: chain.len, updated_at: nowLocal(),
  })
}

/* ---------------- 审计写入（Python audit() 同构） ---------------- */
export async function guardAudit(op, detailJson, action = 'check', decision = null) {
  try {
    let detail = detailJson
    if (typeof detail === 'string') {
      try { detail = JSON.parse(detail) } catch { detail = { raw: String(detailJson).slice(0, 200) } }
    }
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) detail = {}
    const normalizedDetail = Object.fromEntries(Object.entries(detail)
      .map(([k, v]) => [k, String(v).slice(0, 200)]))

    const entry = {
      ts: nowLocal(),
      op: String(op || ''),
      action: String(action || 'check'),
      detail: normalizedDetail,
    }
    if (decision) entry.decision = decision
    entry.trace = TRACE_ID
    entry.identity = { sid: String(runtime.currentSid || ''), principal: 'user' }
    entry.intent = { trace: TRACE_ID, summary: `${entry.op} ${decision || entry.action}` }
    if (Object.keys(normalizedDetail).length) {
      entry.evidence = {
        args_sha256: crypto.createHash('sha256')
          .update(canonicalJson(normalizedDetail)).digest('hex').slice(0, 32),
      }
    }
    // 挂链（Python 顺序：先对无链键条目计算 hash，再补 prev_hash/hash）
    const prev = chain.head
    const hash = entryHash(prev, entry)
    entry.prev_hash = prev
    entry.hash = hash
    chain.head = hash
    chain.len += 1
    try { persistChainHead() } catch { /* 落盘失败：链头不前进（下次重算同 hash） */ }

    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', 'utf8')
    return '{"ok":true}'
  } catch (error) {
    return JSON.stringify({ error: String(error && error.message ? error.message : error) })
  }
}

/* ---------------- 链校验（Python verify 同构：hash 重算 + 相邻衔接） ---------------- */
function verifyChain(entries) {
  const hashed = (entries || []).filter(e => e && typeof e === 'object' && 'hash' in e)
  if (!hashed.length) return { ok: true, checked: 0, head: chain.head, len: chain.len }
  let checked = 0
  for (let i = 1; i < hashed.length; i += 1) {
    const newer = hashed[i - 1]   // read_audit 倒序窗口：前者新、后者旧
    const older = hashed[i]
    const linked = newer.prev_hash === older.hash || older.prev_hash === newer.hash
    if (!linked) {
      return { ok: false, checked, broken_at: { index: i, ts: older.ts, op: older.op } }
    }
    checked += 1
  }
  for (const entry of hashed) {
    // 重算须剥离链键本身（Python：hash 在挂链前对无链键条目计算）
    const { hash, prev_hash, ...rest } = entry
    if (entryHash(entry.prev_hash, rest) !== entry.hash) {
      return { ok: false, checked, broken_at: { index: hashed.indexOf(entry), ts: entry.ts, op: entry.op } }
    }
  }
  return { ok: true, checked: hashed.length, head: chain.head, len: chain.len }
}

/** 审计读取（Python read_audit + api.get_audit_log 链块同构）：
 * 倒序窗口 {ok, total, entries} + chain{head, head_full, len, valid}。 */
export async function getAuditLog(limit = 200, offset = 0, verifyAll = false) {
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

/* ---------------- 搜索缓存统计 / 历史目录（不变） ---------------- */
/** 读取器统计的进程起点（search_reader._started_at = time.time() 同口径）。 */
const READER_STARTED_AT = Date.now() / 1000

export async function searchCacheStats() {
  // P0-1c CF5（service.py:1329-1387）：{ok, entries, hits, misses, ttl_minutes,
  // ttl_classes, size_kb}——entries/size_kb 按落盘文件实时统计（ttl_class 缺分类
  // 计入 general）；hits/misses 为进程内计数（Node 搜索缓存未迁移 → 0 起步，
  // 与 Python 空起步一致）；size_kb = int(bytes/1024) 截断
  const dir = path.join(CONFIG_DIR, 'search_cache')
  let entries = 0
  let size = 0
  const ttlClasses = { news: 0, general: 0, encyclopedia: 0 }
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const file = path.join(dir, name)
      try {
        const stat = fs.statSync(file)
        if (!stat.isFile()) continue
        entries += 1
        size += stat.size
        let cls = 'general'
        try { cls = (JSON.parse(fs.readFileSync(file, 'utf8') || '{}') || {}).ttl_class || 'general' } catch { /* 分类失败计入 general */ }
        if (Object.hasOwn(ttlClasses, cls)) ttlClasses[cls] += 1
      } catch { /* OSError continue（service.py 同款防御） */ }
    }
  }
  return okJson({ ok: true, entries, hits: 0, misses: 0, ttl_minutes: 60,
    ttl_classes: ttlClasses, size_kb: Math.trunc(size / 1024) })
}

export async function searchReaderStats() {
  // P0-1c CF6（search_reader.stats:154-162）：{ok, reader_calls, schema_fail,
  // degrade_count, local_available, configured, last_error, since}——Node 读取器
  // 未迁移，计数器 0/false/'' 起步与 Python 空态一致；configured 按 reader.json
  // base_url 判定（归一化读取）；since=进程起点 epoch（N 规则掩蔽键）
  const { config } = readConfigNormalized(CONFIG_SPECS.reader)
  return okJson({ ok: true, reader_calls: 0, schema_fail: 0, degrade_count: 0,
    local_available: true, configured: !!String(config.base_url || '').trim(),
    last_error: '', since: READER_STARTED_AT })
}

export async function searchStatus(taskId = '') {
  const { searchStatus: browserSearchStatus } = await import('./browser.js')
  return browserSearchStatus(taskId)
}

export async function historyDirGet() {
  const cfg = readConfigJson('history.json', {})
  const dir = cfg.dir || ''
  const effective = dir && fs.existsSync(dir) ? dir : CONFIG_DIR
  return okJson({ ok: true, dir, default_dir: CONFIG_DIR, sessions_file: path.join(effective, 'sessions.json') })
}

export async function historyDirSet(dirPath, migrate = false) {
  const input = String(dirPath || '').trim()
  if (!input) {
    await mergeConfig('history.json', JSON.stringify({ dir: '' }))
    return okJson({ ok: true, dir: '', migrated: false, migrated_from: '' })
  }
  let target
  try { target = fs.realpathSync(path.resolve(input)) } catch { return okJson({ error: `目录不存在：${input}（请先创建）` }) }
  if (!fs.statSync(target).isDirectory()) return okJson({ error: `目录不存在：${input}（请先创建）` })
  try { fs.accessSync(target, fs.constants.W_OK) } catch { return okJson({ error: `目录不可写：${target}` }) }
  const normalized = target.replace(/[\\/]+$/, '').toLowerCase()
  const sensitive = [process.env.WINDIR || 'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)']
    .filter(Boolean).map(x => path.resolve(x).replace(/[\\/]+$/, '').toLowerCase())
  const driveRoot = path.parse(target).root.replace(/[\\/]+$/, '').toLowerCase()
  if (normalized === driveRoot || sensitive.some(x => normalized === x || normalized.startsWith(x + path.sep))) {
    return okJson({ error: `不能使用系统目录：${target}` })
  }
  const previous = readConfigJson('history.json', {}).dir || ''
  const source = path.join(previous || CONFIG_DIR, 'sessions.json')
  let migrated = false; let migratedFrom = ''
  if (migrate && fs.existsSync(source) && path.dirname(fs.realpathSync(source)) !== target) {
    const destination = path.join(target, 'sessions.json')
    if (!fs.existsSync(destination)) {
      try { fs.copyFileSync(source, destination); migrated = true; migratedFrom = source }
      catch (error) { return okJson({ error: `迁移失败: ${error.message}` }) }
    }
  }
  await mergeConfig('history.json', JSON.stringify({ dir: target }))
  return okJson({ ok: true, dir: target, migrated, migrated_from: migratedFrom })
}
