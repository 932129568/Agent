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

export async function getMemory() {
  return JSON.stringify(loadAll())
}

export async function appendMemory(entry) {
  let input = entry
  if (typeof input === 'string') {
    try { input = JSON.parse(input) } catch (error) { input = { text: input } }
  }
  if (!input || typeof input !== 'object') input = { text: String(input ?? '') }

  const text = String(input.text || '').trim()
  if (!text) return JSON.stringify({ error: '记忆内容为空' })

  const kind = input.kind || classify(text)
  const key = normalize(text)
  const list = loadAll()

  if (kind === 'rule' || kind === 'preference') {
    const existing = list.findIndex(item => normalize(item.text) === key)
    if (existing >= 0) {
      list[existing] = { ...list[existing], text, kind, ts: Date.now() }
      saveAll(list)
      return JSON.stringify({ ok: true, kind, total: list.length, deduped: true })
    }
  }

  list.push({ text, kind, ts: Date.now() })
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

export async function memoryDelete(index) {
  const list = loadAll()
  const i = Number(index)
  if (!Number.isInteger(i) || i < 0 || i >= list.length) {
    return JSON.stringify({ error: `索引越界: ${index}` })
  }
  list.splice(i, 1)
  saveAll(list)
  return JSON.stringify({ ok: true, total: list.length })
}

function bigrams(text) {
  const value = normalize(text).replace(/[^\p{L}\p{N}]+/gu, '')
  const grams = new Set()
  for (let index = 0; index < value.length - 1; index += 1) grams.add(value.slice(index, index + 2))
  return grams
}

export async function memoryRetrieve(query, limit = 5) {
  const q = bigrams(query)
  if (!q.size) return JSON.stringify({ ok: true, items: [] })
  const now = Date.now()
  const items = loadAll().map(item => {
    const grams = bigrams(item.text)
    let overlap = 0
    grams.forEach(gram => { if (q.has(gram)) overlap += 1 })
    const base = overlap / Math.max(1, q.size)
    const kindBoost = item.kind === 'rule' ? 0.25 : (item.kind === 'preference' ? 0.1 : 0)
    const ageDays = Math.max(0, (now - (item.ts || now)) / 86400000)
    const decay = 1 / (1 + ageDays / 30)
    return { ...item, score: Number(((base + kindBoost) * decay).toFixed(4)) }
  }).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Number(limit) || 5))
  return JSON.stringify({ ok: true, items })
}
