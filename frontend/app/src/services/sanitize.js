/**
 * 富文本净化（规范 §7.5）：Markdown → DOMPurify，唯一允许产出 HTML 字符串的地方。
 * 组件不得直接读 window.marked / window.DOMPurify，也不得裸用 dangerouslySetInnerHTML。
 */
import { libs } from '../platform/libs.js'
import { HarborError } from './errors.js'

export function renderMarkdown(source, options = {}) {
  const { marked, purify } = libs()
  if (!marked || typeof marked.parse !== 'function') {
    throw new HarborError('LIB_UNAVAILABLE', 'Markdown 引擎未就绪', { retryable: true })
  }
  const raw = marked.parse(String(source == null ? '' : source), options)
  if (!purify || typeof purify.sanitize !== 'function') {
    // 降级宁可返回纯文本，也不把未净化 HTML 交给渲染层
    return { __html: '' }
  }
  return { __html: purify.sanitize(raw) }
}

export function escapeText(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
