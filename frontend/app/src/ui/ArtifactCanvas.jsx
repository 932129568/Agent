import { memo, useEffect, useState } from 'react'
import { copyText, downloadTextFile } from '../platform/dom.js'
import './ArtifactCanvas.css'

/**
 * 实时交互式 Artifact 沙箱画布（R17 加固版）：
 * - memo 隔离外部无关状态刷新，杜绝 iframe 误重载；
 * - 接收沙箱内守护脚本回传的导航拦截提示与运行时错误（绝不出现点按钮把 Harbor 套娃打开的情况）；
 * - 支持一键「↻ 重载画布」、桌面/手机视口切换、源码查看、一键复制与下载。
 */
const ArtifactCanvas = memo(function ArtifactCanvas({ artifact, sandboxHtml = '', onCopied }) {
  const [view, setView] = useState('preview')
  const [viewport, setViewport] = useState('desktop')
  const [reloadKey, setReloadKey] = useState(0)
  const [guardNotice, setGuardNotice] = useState(null)

  useEffect(() => {
    setGuardNotice(null)
  }, [artifact && artifact.id, reloadKey])

  useEffect(() => {
    const onMsg = (ev) => {
      const data = ev && ev.data
      if (!data || data.__harborArtifact !== true) return
      if (data.kind === 'runtime_error') {
        setGuardNotice({ tone: 'err', text: `沙箱脚本异常：${String(data.detail || '').slice(0, 140)}` })
      } else if (data.kind === 'nav_blocked' || data.kind === 'form_blocked') {
        setGuardNotice({
          tone: 'info',
          text: `已拦截沙箱内页面跳转（${String(data.detail || 'form/link').slice(0, 48)}），防止画布重载宿主窗口`,
        })
      }
    }
    globalThis.addEventListener('message', onMsg)
    return () => globalThis.removeEventListener('message', onMsg)
  }, [])

  if (!artifact) {
    return (
      <div style={{ color: 'var(--text-3)', fontSize: 12.5, lineHeight: 1.6 }}>
        当对话、群聊或 DAG 工作流生成 HTML / SVG 交互代码时，点击「✦ 实时画布」即可在此免切窗口实时运行与交互预览。
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
              <button type="button" className="ac-btn" onClick={() => setReloadKey((k) => k + 1)} title="重新加载当前沙箱预览">↻</button>
            </>
          )}
          <button type="button" className="ac-btn" onClick={handleCopy}>复制</button>
          <button type="button" className="ac-btn" onClick={handleDownload}>下载</button>
        </div>
      </div>

      {guardNotice && (
        <div className="ac-notice" data-tone={guardNotice.tone} role="status">
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{guardNotice.text}</span>
          <button type="button" className="ac-btn" onClick={() => setGuardNotice(null)}>×</button>
        </div>
      )}

      <div className="ac-stage">
        {view === 'preview' ? (
          <iframe
            key={`${artifact.id}_${reloadKey}`}
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
})

export default ArtifactCanvas
