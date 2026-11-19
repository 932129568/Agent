/**
 * 规范化引擎（唯一实现——设计 D7：双侧驱动只产 raw，比对器统一归一）。
 *
 * 数据驱动：规则来自 tools/diff/normalize-rules.json（N01–N14）。
 *   1. 侧路径占位替换：PICKED → WS → CFG → ROOT（先长后短，原生分隔符，
 *      大小写不敏感，反斜杠/正斜杠双形态）——先于 N01 分隔符归一；
 *   2. 正则序贯替换（顺序敏感）；
 *   3. 键控掩码：epoch/耗时/pid/随机 id 键命中即掩值（递归遍历）。
 *
 * 平台/宿主标识（exe 字段等）不归一——一律走 intentional 登记。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIFF_TOOLS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tools', 'diff')

export function loadRules(rulesPath = path.join(DIFF_TOOLS_DIR, 'normalize-rules.json')) {
  const raw = JSON.parse(fs.readFileSync(rulesPath, 'utf8'))
  const maskIndex = new Map()
  for (const [kind, keys] of Object.entries(raw.maskKeys || {})) {
    const placeholder = (raw.maskValues || {})[kind] || `<${kind.toUpperCase()}>`
    for (const key of keys) maskIndex.set(key, placeholder)
  }
  return { raw, maskIndex }
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 侧路径 → 占位符（值内出现本侧 ROOT/WS/CFG/PICKED 前缀即替换）。 */
export function replaceSidePaths(text, side) {
  if (!side) return text
  let out = text
  const pairs = [
    ['<PICKED>', side.picked],
    ['<WS>', side.ws],
    ['<CFG>', side.cfg],
    ['<ROOT>', side.root],
  ]
  for (const [placeholder, value] of pairs) {
    if (!value) continue
    const variants = [String(value), String(value).replaceAll('\\', '/')]
    for (const variant of variants) {
      if (!variant) continue
      out = out.replace(new RegExp(escapeRegex(variant), 'gi'), placeholder)
    }
  }
  return out
}

/** 正则序贯替换（顺序敏感；UPPER_DRIVE 为盘符大写特殊约定；(?i) 前缀转 flags）。 */
function applyRegexRules(text, rules) {
  let out = text
  for (const rule of rules) {
    let pattern = String(rule.pattern)
    let flags = 'g'
    if (pattern.startsWith('(?i)')) {
      pattern = pattern.slice(4)
      flags = 'gi'
    }
    const regex = new RegExp(pattern, flags)
    if (rule.replace === 'UPPER_DRIVE') {
      out = out.replace(regex, match => match.toUpperCase())
    } else {
      out = out.replace(regex, rule.replace)
    }
  }
  return out
}

/** 字符串归一：侧路径 → 正则规则 → 分隔符归一（N01，数据驱动）。 */
export function normalizeString(text, side, rules) {
  let out = replaceSidePaths(String(text ?? ''), side)
  out = applyRegexRules(out, rules.raw.regexRules || [])
  const sep = rules.raw.separatorRule
  if (sep && sep.from) out = out.split(sep.from).join(sep.to || '/')
  return out
}

/** 结构归一：键控掩码 + 数值量化 + 字符串归一，递归。 */
export function normalizeValue(value, side, rules) {
  if (typeof value === 'string') return normalizeString(value, side, rules)
  if (Array.isArray(value)) return value.map(item => normalizeValue(item, side, rules))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, val] of Object.entries(value)) {
      const mask = rules.maskIndex.get(key)
      if (mask) {
        out[key] = mask
        continue
      }
      const bucket = (rules.raw.quantizeKeys || {})[key]
      if (bucket && typeof val === 'number' && Number.isFinite(val)) {
        out[key] = Math.floor(val / bucket) * bucket  // 时间抖动容差（如 remaining_s ±10s 量化）
        continue
      }
      out[key] = normalizeValue(val, side, rules)
    }
    return out
  }
  return value
}

/** shape 模式：键集 + 值类型树（环境绑定输出只比形状）。 */
export function shapeTree(value) {
  if (Array.isArray(value)) return { type: 'array', items: value.map(shapeTree) }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return { type: 'object', keys, values: Object.fromEntries(keys.map(k => [k, shapeTree(value[k])])) }
  }
  if (value === null) return { type: 'null' }
  return { type: typeof value }
}

/**
 * raw 文本 → 归一后可比较值：
 *   双侧都能 JSON.parse → 解析后结构归一；否则按归一字符串比较（设计 §6.2）。
 */
export function normalizeForCompare(raw, side, rules) {
  if (raw === null || raw === undefined) return { kind: 'null', value: null }
  const text = String(raw)
  try {
    const parsed = JSON.parse(text)
    return { kind: 'json', value: normalizeValue(parsed, side, rules) }
  } catch {
    return { kind: 'text', value: normalizeString(text, side, rules) }
  }
}

/** unordered 集合比较（N13）：顶层数组按归一后 JSON 文本排序。 */
export function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
      .map(item => JSON.stringify(item))
      .sort()
      .map(item => JSON.parse(item))
  }
  return value
}
