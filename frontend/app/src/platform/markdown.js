/**
 * 平台层富文本净化适配（Markdown → DOMPurify 唯一出口，带 64 条有界 LRU 缓存 + 交互式代码块顶栏增强）。
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

/** 将已净化的 `<pre><code class="language-xxx">...</code></pre>` 包装为带语言标签与一键复制按钮的玻璃代码卡。 */
function enhanceCodeBlocks(sanitizedHtml) {
  return String(sanitizedHtml || '').replace(
    /<pre><code(?:\s+class="language-([a-zA-Z0-9_+#.-]+)")?>([\s\S]*?)<\/code><\/pre>/gi,
    (_full, rawLang, inner) => {
      const lang = String(rawLang || 'code').replace(/[^a-zA-Z0-9_+#.-]/g, '').slice(0, 20) || 'code'
      return (
        `<div class="md-code-block" data-lang="${lang}">` +
          `<div class="md-code-bar">` +
            `<span class="md-code-lang">${lang}</span>` +
            `<button type="button" class="md-code-copy">复制代码</button>` +
          `</div>` +
          `<pre><code class="language-${lang}">${inner}</code></pre>` +
        `</div>`
      )
    }
  )
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
    const clean = purify.sanitize(marked.parse(text))
    result = { __html: enhanceCodeBlocks(clean) }
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
