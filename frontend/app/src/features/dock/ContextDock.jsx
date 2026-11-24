import { useSlice, toggleDock, setDockTab } from '../../state/store.js'
import DiffView from '../../ui/DiffView.jsx'
import MarkdownView from '../../ui/MarkdownView.jsx'
import './ContextDock.css'

export default function ContextDock() {
  const ui = useSlice('ui')
  const sessionsState = useSlice('sessions')
  const runtime = useSlice('runtime')
  const settings = useSlice('settings')

  if (!ui.dockOpen || ui.activeModal) return null

  const session = sessionsState.items.find((s) => s.id === sessionsState.currentId)
  const sid = session ? session.id : ''
  const run = (sid && runtime.runsBySid[sid]) || { phase: 'idle', tools: [], diffs: [] }
  const msgs = (session && session.messages) || []
  const approxTokens = Math.ceil(msgs.reduce((n, m) => n + String(m.content || '').length, 0) / 1.8)

  return (
    <aside className="dk-root" aria-label="右侧上下文工作台">
      <div className="dk-head">
        <strong>上下文工作台（事件驱动 · 0 轮询）</strong>
        <button type="button" className="dk-close" onClick={() => toggleDock()} aria-label="关闭">×</button>
      </div>
      <div className="dk-tabs" role="tablist">
        {[
          ['overview', '概览'],
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
            <div className="dk-kv"><span className="dk-k">窗外透色材质</span><span className="dk-v">{settings.backdrop} ({Math.round(settings.opacity * 100)}%)</span></div>
            <div className="dk-kv"><span className="dk-k">本地 Fastify</span><span className="dk-v">{runtime.serverHealth && runtime.serverHealth.ok ? '在线' : '离线'}</span></div>
          </>
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
