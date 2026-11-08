/**
 * 记忆服务：结构化三类（fact / preference / rule）+ 去重 + 上限淘汰 + 关键词检索。
 *
 * 与 legacy MemoryService 同口径：
 *   - 指令类（rule/preference）按规范化文本去重，fact 超上限淘汰最旧；
 *   - 检索 = bigram 重叠 + rule 加成 + 时间衰减；
 *   - 存储独立 memory.json（config.json 零污染）。
 */
import { CONFIG_DIR, atomicWriteJson, readJsonIfExists } from '../paths.js'
import path from 'node:path'

const MEMORY_FILE = path.join(CONFIG_DIR, 'memory.json')
const MAX_FACTS = 200

const RULE_WORDS = ['必须', '禁止', '不要', '一律', '始终', '务必', '不得', '只能', '永远', 'never', 'must', 'always']
const PREF_WORDS = ['偏好', '喜欢', '习惯', '希望', '倾向', '首选', '常用', 'prefer', 'like']

function loadAll() {
  const list = readJsonIfExists(MEMORY_FILE, [])
  return Array.isArray(list) ? list.filter(item => item && typeof item === 'object') : []
}

function saveAll(list) {
  atomicWriteJson(MEMORY_FILE, list)
}

export function classify(text) {
  const value = String(text || '')
  if (RULE_WORDS.some(word => value.toLowerCase().includes(word))) return 'rule'
  if (PREF_WORDS.some(word => value.toLowerCase().includes(word))) return 'preference'
  return 'fact'
}

const normalize = text => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase()

/** P0-1c M1：时间双字段（memory_service 口径）——ts 'MM-DD HH:MM' 显示形态 +
 * ts_iso datetime.now().isoformat() 全量（淘汰/衰减比较无跨年歧义）。 */
function timeStamp() {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const ts = `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  const tsIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T`
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}`
  return { ts, ts_iso: tsIso }
}

/** 条目时间 → epoch 毫秒（ts_iso 优先；回落 'MM-DD HH:MM' 按当前年推断）。 */
function itemTime(item) {
  const iso = String(item.ts_iso || '').trim()
  if (iso) {
    const parsed = Date.parse(iso)
    if (Number.isFinite(parsed)) return parsed
  }
  const match = String(item.ts || '').match(/(\d{2})-(\d{2}) (\d{2}):(\d{2})/)
  if (!match) return null
  const now = new Date()
  let dt = new Date(now.getFullYear(), Number(match[1]) - 1, Number(match[2]),
    Number(match[3]), Number(match[4]))
  if (dt.getTime() > now.getTime() + 86400000) dt = new Date(now.getFullYear() - 1,
    Number(match[1]) - 1, Number(match[2]), Number(match[3]), Number(match[4]))
  return dt.getTime()
}

export async function getMemory() {
  return JSON.stringify(loadAll())
}

export async function appendMemory(entry) {
  let input = entry
  if (typeof input === 'string') {
    try { input = JSON.parse(input) } catch (error) { input = { text: input } }
  }
  if (!input || typeof input !== 'object') input = { text: String(input ?? '') }

  // R38 修复（K2 双端对齐）：空 text 条目与 Python legacy 契约同口径**允许入库**
  // （{'k':'v'} 无 text 形态也入；检索/注入层自然跳过空条目）——原 Node 单端拒绝。
  const text = String(input.text ?? '').trim()

  const kind = input.kind || classify(text)
  const key = normalize(text)
  const list = loadAll()

  if (kind === 'rule' || kind === 'preference') {
    const existing = list.findIndex(item => normalize(item.text) === key)
    if (existing >= 0) {
      list[existing] = { ...list[existing], text, kind, ...timeStamp() }
      saveAll(list)
      return JSON.stringify({ ok: true, kind, total: list.length, deduped: true })
    }
  }

  list.push({ text, kind, ...timeStamp() })
  const facts = list.filter(item => (item.kind || 'fact') === 'fact')
  if (facts.length > MAX_FACTS) {
    const overflow = facts.length - MAX_FACTS
    let removed = 0
    for (let index = 0; index < list.length && removed < overflow;) {
      if ((list[index].kind || 'fact') === 'fact') {
        list.splice(index, 1)
        removed += 1
      } else index += 1
    }
  }

  saveAll(list)
  return JSON.stringify({ ok: true, kind, total: list.length })
}

/** Python %r 语义（str repr 单引号口径，与 system.js pyRepr 同规则）。 */
const pyRepr = value => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

export async function memoryDelete(index) {
  // P0-1c M3/M4：{ok, remaining}；非整数/越界 → 结构化 BAD_PARAMS
  // （config_service.delete_memory:345-393 口径——_coerce_index：None/bool →
  // 「序号需要是整数」；字符串按 int 解析，失败带 %r 收到值（截 32）；
  // hint 固定「传入要删除的记忆序号（从 0 开始）」；越界 message+hint 人话）
  const reject = message => JSON.stringify({ ok: false,
    error: { code: 'BAD_PARAMS', message, hint: '传入要删除的记忆序号（从 0 开始）' } })
  let i
  if (index === null || index === undefined || typeof index === 'boolean') {
    return reject('序号需要是整数')
  }
  if (typeof index === 'string') {
    const text = index.trim()
    if (/^[+-]?\d+$/.test(text)) i = Number(text)
    else return reject(`序号需要是整数（收到 ${pyRepr(text.slice(0, 32))}）`)
  } else if (typeof index === 'number' && Number.isInteger(index)) {
    i = index
  } else {
    return reject('序号需要是整数')
  }
  const list = loadAll()
  if (i < 0 || i >= list.length) {
    return JSON.stringify({ ok: false, error: { code: 'BAD_PARAMS',
      message: `序号越界：当前共 ${list.length} 条记忆`, hint: '刷新列表后重试；序号从 0 开始' } })
  }
  list.splice(i, 1)
  saveAll(list)
  return JSON.stringify({ ok: true, remaining: list.length })
}

function bigrams(text) {
  const value = normalize(text).replace(/[^\p{L}\p{N}]+/gu, '')
  const grams = new Set()
  for (let index = 0; index < value.length - 1; index += 1) grams.add(value.slice(index, index + 2))
  return grams
}

export async function memoryRetrieve(query, limit = 5) {
  // P0-1c M2：memory_service.retrieve 同构——bigram 重叠（零重叠排除）+
  // kind 加成 + 0.5**(ageDays/30) 时间衰减；输出原条目（无 score 键）
  const q = bigrams(query)
  if (!q.size || !q) return JSON.stringify({ ok: true, items: [] })
  const now = Date.now()
  const all = loadAll()
  const scored = []
  all.forEach((item, idx) => {
    const grams = bigrams(item.text)
    let overlap = 0
    grams.forEach(gram => { if (q.has(gram)) overlap += 1 })
    if (overlap <= 0) return
    const base = overlap / Math.max(1, q.size)
    // R38 修复（K4 双端对齐）：kind 加成改**乘法**（×1.3/×1.1，memory_service.py
    // :98-101 同口径）——原 Node 加法变体使同一记忆两端排序可不同。
    let score = base
    if (item.kind === 'rule') score *= 1.3
    else if (item.kind === 'preference') score *= 1.1
    const t = itemTime(item)
    if (t !== null) {
      const ageDays = Math.max(0, (now - t) / 86400000)
      score *= 0.5 ** (ageDays / 30)
    }
    scored.push({ score, idx, item })
  })
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx)
  const items = scored.slice(0, Math.max(1, Number(limit) || 5)).map(x => x.item)
  return JSON.stringify({ ok: true, items })
}
