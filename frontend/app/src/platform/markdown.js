/**
 * 平台层富文本净化适配（Markdown → DOMPurify 唯一出口，带 64 条有界 LRU 缓存）。
 * 归属 platform/ 使 ui/MarkdownView.jsx 遵守 LAW-07 单向依赖（ui → platform），零反向依赖。
 */
import { libs } from './libs.js'

const MAX_CACHE_ENTRIES = 64
const MAX_CACHE_TEXT_LEN = 120000
const _htmlCache = new Map()

function cacheGet(key) {
  if (!_htmlCache.has(key)) return null
  const val = _htmlCache.get(key)
  _htmlCache.delete(key)
  _htmlCache.set(key, val)
  return val
}

function cacheSet(key, val) {
  if (_htmlCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = _htmlCache.keys().next().value
    if (oldest !== undefined) _htmlCache.delete(oldest)
  }
  _htmlCache.set(key, val)
}

export function clearMarkdownCache() {
  _htmlCache.clear()
}

export function renderSafeMarkdown(source) {
  const text = String(source == null ? '' : source)
  if (!text) return { __html: '' }
  const canCache = text.length <= MAX_CACHE_TEXT_LEN
  if (canCache) {
    const hit = cacheGet(text)
    if (hit) return hit
  }

  const { marked, purify } = libs()
  let result
  if (marked && typeof marked.parse === 'function' && purify && typeof purify.sanitize === 'function') {
    result = { __html: purify.sanitize(marked.parse(text)) }
  } else {
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br/>')
    result = { __html: escaped }
  }

  if (canCache) cacheSet(text, result)
  return result
}
