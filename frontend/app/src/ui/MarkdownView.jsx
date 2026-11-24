import { memo, useCallback, useMemo } from 'react'
import { renderSafeMarkdown } from '../platform/markdown.js'
import { copyText } from '../platform/dom.js'
import './MarkdownView.css'

/**
 * 唯一允许使用 dangerouslySetInnerHTML 的组件（LAW-04 强制经 platform/markdown.js DOMPurify 净化）。
 * R17：React 事件委托同时处理代码块「复制代码」与 <a> 链接拦截，杜绝点击相对链接意外重载 Harbor 宿主！
 */
const MarkdownView = memo(function MarkdownView({ content, className = '' }) {
  const markup = useMemo(() => renderSafeMarkdown(content), [content])

  const handleClick = useCallback((e) => {
    const link = e.target && typeof e.target.closest === 'function' ? e.target.closest('a[href]') : null
    if (link) {
      e.preventDefault()
      const href = String(link.getAttribute('href') || '').trim()
      if (/^https?:\/\//i.test(href)) {
        copyText(href).catch(() => {})
      }
      return
    }
    const btn = e.target && typeof e.target.closest === 'function' ? e.target.closest('.md-code-copy') : null
    if (!btn) return
    const block = btn.closest('.md-code-block')
    const pre = block ? block.lastElementChild : null
    const codeText = (pre && pre.textContent) || ''
    if (!codeText) return
    copyText(codeText).then(() => {
      btn.setAttribute('data-copied', 'true')
      btn.textContent = '✓ 已复制'
      setTimeout(() => {
        btn.removeAttribute('data-copied')
        btn.textContent = '复制代码'
      }, 1600)
    }).catch(() => {})
  }, [])

  return (
    <div
      className={className ? `md-view ${className}` : 'md-view'}
      onClick={handleClick}
      dangerouslySetInnerHTML={markup}
    />
  )
})

export default MarkdownView
