import { memo, useMemo } from 'react'
import { renderSafeMarkdown } from '../platform/markdown.js'

/** 唯一允许使用 dangerouslySetInnerHTML 的组件（LAW-04 强制经 platform/markdown.js DOMPurify 净化，memo 避免无效重渲染）。 */
const MarkdownView = memo(function MarkdownView({ content, className = '' }) {
  const markup = useMemo(() => renderSafeMarkdown(content), [content])
  return <div className={className} dangerouslySetInnerHTML={markup} />
})

export default MarkdownView
