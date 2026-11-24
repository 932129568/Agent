import { useMemo } from 'react'
import { renderSafeMarkdown } from '../platform/markdown.js'

/** 唯一允许使用 dangerouslySetInnerHTML 的组件（LAW-04 强制经 platform/markdown.js DOMPurify 净化）。 */
export default function MarkdownView({ content, className = '' }) {
  const markup = useMemo(() => renderSafeMarkdown(content), [content])
  return <div className={className} dangerouslySetInnerHTML={markup} />
}
