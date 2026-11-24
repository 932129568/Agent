import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSlice, toggleDock, setDockTab, fireShellImpact, pushToast } from '../../state/store.js'
import { playDrawerSlideIn, playDrawerSlideOut } from '../../platform/kinetic.js'
import { buildArtifactSandboxDoc } from '../../services/artifacts.js'
import DiffView from '../../ui/DiffView.jsx'
import MarkdownView from '../../ui/MarkdownView.jsx'
import ArtifactCanvas from '../../ui/ArtifactCanvas.jsx'
import './ContextDock.css'

export default function ContextDock() {
  const ui = useSlice('ui')
  const sessionsState = useSlice('sessions')
  const runtime = useSlice('runtime')
  const settings = useSlice('settings')
  const shouldShow = ui.dockOpen && !ui.activeModal
  const [mounted, setMounted] = useState(shouldShow)
  const asideRef = useRef(null)
  const closingRef = useRef(false)

  useEffect(() => {
    if (shouldShow) {
      closingRef.current = false
      setMounted(true)
    } else if (mounted && !closingRef.current) {
      closingRef.current = true
      playDrawerSlideOut(
        asideRef.current,
        settings.motion,
        () => fireShellImpact('right', 'strong'),
        () => {
          closingRef.current = false
          setMounted(false)
        },
        'nav-dock'
      )
    }
  }, [shouldShow])

  useLayoutEffect(() => {
    if (mounted && shouldShow && asideRef.current) {
      playDrawerSlideIn(asideRef.current, settings.motion)
    }
  }, [mounted, shouldShow])

  const sandboxHtml = useMemo(
    () => (ui.activeArtifact ? buildArtifactSandboxDoc(ui.activeArtifact, settings.theme) : ''),
    [ui.activeArtifact, settings.theme]
  )

  if (!mounted) return null

  const session = sessionsState.items.find((s) => s.id === sessionsState.currentId)
  const sid = session ? session.id : ''
  const run = (sid && runtime.runsBySid[sid]) || { phase: 'idle', tools: [], diffs: [] }
  const msgs = (session && session.messages) || []
  const approxTokens = Math.ceil(msgs.reduce((n, m) => n + String(m.content || '').length, 0) / 1.8)
  const isWide = ui.dockTab === 'artifact' && Boolean(ui.activeArtifact)

  return (
    <aside ref={asideRef} className="dk-root" data-wide={String(isWide)} aria-label="右侧上下文工作台">
      <div className="dk-head">
        <strong>上下文工作台</strong>
        <button type="button" className="dk-close" onClick={() => toggleDock()} aria-label="关闭">×</button>
      </div>
      <div className="dk-tabs" role="tablist">
        {[
          ['overview', '概览'],
          ['artifact', ui.activeArtifact ? '✦ 画布' : '画布'],
          ['diff', `Diff(${(run.diffs || []).length})`],
          ['trace', `轨迹(${(run.tools || []).length})`],
          ['preview', '预览'],
        ].map(([id, label]) => (
          <button key={id} type="button" className="dk-tab" data-active={String(ui.dockTab === id)} onClick={() => setDockTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="dk-body">
        {ui.dockTab === 'overview' && (
          <>
            <div className="dk-kv"><span className="dk-k">当前会话</span><span className="dk-v">{session ? session.title : '无'}</span></div>
            <div className="dk-kv"><span className="dk-k">消息数 / 估算 Token</span><span className="dk-v">{msgs.length} 条 · ~{approxTokens}</span></div>
            <div className="dk-kv"><span className="dk-k">当前运行阶段</span><span className="dk-v">{run.phase}</span></div>
            <div className="dk-kv"><span className="dk-k">模型</span><span className="dk-v">{settings.backendConfig.model || 'glm-4.5-flash'}</span></div>
            <div className="dk-kv">
              <span className="dk-k">前缀缓存命中</span>
              <span className="dk-v">
                {runtime.cacheTotals && runtime.cacheTotals.promptTokens > 0
                  ? `本轮 ${runtime.cacheTotals.latestHitRate}% · 累计 ${runtime.cacheTotals.hitRate}% (${runtime.cacheTotals.cachedTokens.toLocaleString()} tok)`
                  : (runtime.cacheTotals && runtime.cacheTotals.prefixLocked ? `已锁定 #${runtime.cacheTotals.prefixHash}` : '首轮预热中')}
              </span>
            </div>
            {runtime.activeToolProfile && (
              <div className="dk-kv">
                <span className="dk-k">智能工具域</span>
                <span className="dk-v">{runtime.activeToolProfile.label} ({runtime.activeToolProfile.activeCount}/{runtime.activeToolProfile.totalCount} 工具)</span>
              </div>
            )}
            <div className="dk-kv"><span className="dk-k">窗外透色材质</span><span className="dk-v">{settings.backdrop} ({Math.round(settings.opacity * 100)}%)</span></div>
            <div className="dk-kv"><span className="dk-k">本地 Fastify</span><span className="dk-v">{runtime.serverHealth && runtime.serverHealth.ok ? '在线' : '离线'}</span></div>
          </>
        )}
        {ui.dockTab === 'artifact' && (
          <ArtifactCanvas
            artifact={ui.activeArtifact}
            sandboxHtml={sandboxHtml}
            onCopied={(msg) => pushToast(msg, 'ok')}
          />
        )}
        {ui.dockTab === 'diff' && (
          (run.diffs || []).length > 0
            ? run.diffs.map((d, i) => <DiffView key={i} filePath={d.path} before={d.before} after={d.after} />)
            : <div style={{ color: 'var(--text-3)' }}>本会话尚未产生文件写入 Diff。</div>
        )}
        {ui.dockTab === 'trace' && (
          (run.tools || []).length > 0
            ? run.tools.map((t, i) => (
              <div key={i} className="dk-kv">
                <span className="dk-k">{t.status === 'done' ? '✓' : t.status === 'fail' ? '✗' : '◉'} {t.name}</span>
                <span className="dk-v">{t.detail || '—'}</span>
              </div>
            ))
            : <div style={{ color: 'var(--text-3)' }}>本轮暂无工具调用轨迹。</div>
        )}
        {ui.dockTab === 'preview' && (
          ui.dockPreview
            ? <MarkdownView content={ui.dockPreview} />
            : <div style={{ color: 'var(--text-3)' }}>在群聊交接卡或文件列表中点击「副屏预览」即可在此查看。</div>
        )}
      </div>
    </aside>
  )
}
