import { useEffect, useState } from 'react'
import { useSlice, selectSession } from '../../state/store.js'
import * as api from '../../services/bridge.js'
import './AnalyticsPanel.css'

export default function AnalyticsPanel() {
  const sessionsState = useSlice('sessions')
  const [audit, setAudit] = useState([])

  useEffect(() => {
    api.getAuditLog(20, 0).then((r) => {
      const items = (r && (r.entries || r.logs || r.items)) || (Array.isArray(r) ? r : [])
      setAudit(items)
    }).catch(() => {})
  }, [])

  const ranked = sessionsState.items.map((s) => {
    const chars = (s.messages || []).reduce((acc, m) => acc + String(m.content || '').length, 0)
    const tok = (s.usage && s.usage.total_tokens) || Math.ceil(chars / 1.8)
    return { id: s.id, title: s.title || '未命名', msgs: (s.messages || []).length, tokens: tok }
  }).sort((a, b) => b.tokens - a.tokens)

  const totalTokens = ranked.reduce((acc, x) => acc + x.tokens, 0)
  const totalMsgs = ranked.reduce((acc, x) => acc + x.msgs, 0)

  return (
    <section className="an-root">
      <h2 style={{ margin: 0 }}>用量洞察与审计日志</h2>
      <div className="an-stats">
        <div className="an-kpi"><div style={{ fontSize: 12, color: 'var(--text-3)' }}>累计会话</div><div className="an-kpi-val">{sessionsState.items.length}</div></div>
        <div className="an-kpi"><div style={{ fontSize: 12, color: 'var(--text-3)' }}>累计消息</div><div className="an-kpi-val">{totalMsgs}</div></div>
        <div className="an-kpi"><div style={{ fontSize: 12, color: 'var(--text-3)' }}>估算 Token 总量</div><div className="an-kpi-val">{totalTokens.toLocaleString()}</div></div>
      </div>

      <div className="an-card">
        <div style={{ fontWeight: 600 }}>高耗 Top 5 会话</div>
        {ranked.slice(0, 5).map((r) => (
          <div key={r.id} className="an-row">
            <span>{r.title}（{r.msgs} 条消息）</span>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-2)' }}>{r.tokens.toLocaleString()} tok</span>
              <button type="button" style={{ padding: '4px 10px', borderRadius: 'var(--radius-full)', border: '1px solid var(--border)', background: 'var(--surface-subtle)', cursor: 'pointer', fontSize: 12 }}
                onClick={() => selectSession(r.id)}>进入</button>
            </div>
          </div>
        ))}
      </div>

      <div className="an-card">
        <div style={{ fontWeight: 600 }}>近期安全审计记录（{audit.length}）</div>
        {audit.length === 0
          ? <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>暂无审计日志。</div>
          : audit.slice(0, 12).map((a, idx) => (
            <div key={idx} className="an-row">
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{a.op || a.action || a.event || JSON.stringify(a).slice(0, 80)}</span>
              <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{a.ts || a.time || ''}</span>
            </div>
          ))}
      </div>
    </section>
  )
}
