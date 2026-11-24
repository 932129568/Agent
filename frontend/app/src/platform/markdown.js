/**
 * 平台层富文本净化适配（Markdown → DOMPurify 唯一出口）。
 * 归属 platform/ 使 ui/MarkdownView.jsx 遵守 LAW-07 单向依赖（ui → platform），零反向依赖。
 */
import { libs } from './libs.js'

export function renderSafeMarkdown(source) {
  const text = String(source == null ? '' : source)
  const { marked, purify } = libs()
  if (marked && typeof marked.parse === 'function' && purify && typeof purify.sanitize === 'function') {
    return { __html: purify.sanitize(marked.parse(text)) }
  }
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br/>')
  return { __html: escaped }
}
