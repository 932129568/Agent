import { useState } from 'react'
import { copyText, downloadTextFile } from '../platform/dom.js'
import './ArtifactCanvas.css'

/**
 * 实时交互式 Artifact 沙箱画布（R15）：
 * - 纯展示组件（ui → platform，严守 LAW-07），由 ContextDock 传入 artifact 与 sandboxHtml；
 * - `<iframe sandbox="allow-scripts">` 隔离渲染，零宿主污染，支持桌面/手机视口切换、源码查看、一键复制与下载。
 */
export default function ArtifactCanvas({ artifact, sandboxHtml = '', onCopied }) {
  const [view, setView] = useState('preview')       // 'preview' | 'code'
  const [viewport, setViewport] = useState('desktop') // 'desktop' | 'mobile'

  if (!artifact) {
    return (
      <div style={{ color: 'var(--text-3)', fontSize: 12.5, lineHeight: 1.6 }}>
        当对话或群聊中生成 HTML / SVG 交互代码时，点击消息下方的「✦ 实时画布」即可在此免切窗口实时运行与交互预览。
      </div>
    )
  }

  const handleCopy = async () => {
    await copyText(artifact.code || '')
    if (typeof onCopied === 'function') onCopied('已复制 Artifact 源码')
  }

  const handleDownload = () => {
    const mime = artifact.kind === 'svg' ? 'image/svg+xml;charset=utf-8' : 'text/html;charset=utf-8'
    downloadTextFile(artifact.filename || 'artifact.html', artifact.code || '', mime)
    if (typeof onCopied === 'function') onCopied(`已导出 ${artifact.filename || 'artifact.html'}`)
  }

  return (
    <div className="ac-root">
      <div className="ac-bar">
        <div className="ac-title-wrap">
          <span className="ac-badge">{artifact.kind || 'html'}</span>
          <span className="ac-title" title={artifact.title}>{artifact.title || '交互画布'}</span>
        </div>
        <div className="ac-actions">
          <button type="button" className="ac-btn" data-active={String(view === 'preview')} onClick={() => setView('preview')}>渲染</button>
          <button type="button" className="ac-btn" data-active={String(view === 'code')} onClick={() => setView('code')}>源码</button>
          {view === 'preview' && (
            <>
              <button type="button" className="ac-btn" data-active={String(viewport === 'desktop')} onClick={() => setViewport('desktop')}>桌面</button>
              <button type="button" className="ac-btn" data-active={String(viewport === 'mobile')} onClick={() => setViewport('mobile')}>手机</button>
            </>
          )}
          <button type="button" className="ac-btn" onClick={handleCopy}>复制</button>
          <button type="button" className="ac-btn" onClick={handleDownload}>下载</button>
        </div>
      </div>

      <div className="ac-stage">
        {view === 'preview' ? (
          <iframe
            className="ac-frame"
            data-viewport={viewport}
            title={artifact.title || 'Artifact Preview'}
            sandbox="allow-scripts"
            srcDoc={sandboxHtml}
          />
        ) : (
          <pre className="ac-code"><code>{artifact.code}</code></pre>
        )}
      </div>
    </div>
  )
}
