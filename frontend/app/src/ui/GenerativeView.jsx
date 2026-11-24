import { copyText } from '../platform/dom.js'
import './GenerativeView.css'

function RenderBlock({ block }) {
  const p = (block && block.props) || {}
  const comp = block && block.component

  if (comp === 'SectionHeader') {
    return (
      <div style={{ paddingTop: 4 }}>
        <strong style={{ fontSize: 13.5 }}>{String(p.title || '')}</strong>
        {p.subtitle && <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{String(p.subtitle)}</div>}
      </div>
    )
  }
  if (comp === 'StatTile') {
    return (
      <div className="gv-card">
        <div className="gv-stat-lbl">{String(p.label || '')}</div>
        <div className="gv-stat-val">{String(p.value ?? '—')}</div>
        {p.delta && <div style={{ fontSize: 11.5, color: 'var(--ok)' }}>{String(p.delta)}</div>}
      </div>
    )
  }
  if (comp === 'KeyValue') {
    const rows = Array.isArray(p.items) ? p.items : []
    return (
      <div className="gv-card">
        {rows.map((r, i) => (
          <div key={i} className="gv-kv-row">
            <span style={{ color: 'var(--text-3)' }}>{String(r.label || '')}</span>
            <span style={{ fontWeight: 500 }}>{String(r.value ?? '')}</span>
          </div>
        ))}
      </div>
    )
  }
  if (comp === 'Table') {
    const cols = Array.isArray(p.columns) ? p.columns : []
    const rows = Array.isArray(p.rows) ? p.rows : []
    return (
      <div className="gv-table-wrap">
        <table className="gv-table">
          <thead>
            <tr>{cols.map((c, i) => <th key={i}>{typeof c === 'string' ? c : String(c.label || c.key || '')}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {Array.isArray(r)
                  ? r.map((cell, ci) => <td key={ci}>{String(cell ?? '')}</td>)
                  : cols.map((c, ci) => <td key={ci}>{String((r && r[typeof c === 'string' ? c : c.key]) ?? '')}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }
  if (comp === 'BarChart') {
    const items = Array.isArray(p.items) ? p.items : []
    const maxVal = Math.max(1, ...items.map((x) => Number(x.value) || 0))
    return (
      <div className="gv-card">
        {p.title && <strong style={{ fontSize: 12.5 }}>{String(p.title)}</strong>}
        {items.map((it, i) => {
          const v = Number(it.value) || 0
          return (
            <div key={i} className="gv-bar-row">
              <span style={{ width: 96, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(it.label || '')}</span>
              <div className="gv-bar-track"><div className="gv-bar-fill" style={{ width: `${Math.round((v / maxVal) * 100)}%` }} /></div>
              <span style={{ width: 48, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{v}</span>
            </div>
          )
        })}
      </div>
    )
  }
  if (comp === 'Progress') {
    const pct = Math.min(100, Math.max(0, Number(p.value) || 0))
    return (
      <div className="gv-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
          <span>{String(p.label || '进度')}</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{pct}%</span>
        </div>
        <div className="gv-bar-track"><div className="gv-bar-fill" style={{ width: `${pct}%` }} /></div>
      </div>
    )
  }
  if (comp === 'Checklist') {
    const items = Array.isArray(p.items) ? p.items : []
    return (
      <div className="gv-card">
        {items.map((it, i) => (
          <div key={i} style={{ fontSize: 12.5, color: it.status === 'done' ? 'var(--ok)' : 'var(--text-2)' }}>
            {it.status === 'done' ? '☑ ' : '☐ '}{String(it.label || it.text || '')}
          </div>
        ))}
      </div>
    )
  }
  if (comp === 'Timeline') {
    const items = Array.isArray(p.items) ? p.items : []
    return (
      <div className="gv-card">
        <div className="gv-tl">
          {items.map((it, i) => (
            <div key={i} className="gv-tl-item">
              <strong>{String(it.title || it.label || '')}</strong>
              {it.detail && <span style={{ color: 'var(--text-2)' }}>{String(it.detail)}</span>}
            </div>
          ))}
        </div>
      </div>
    )
  }
  if (comp === 'Chips') {
    const items = Array.isArray(p.items) ? p.items : []
    return <div className="gv-chips">{items.map((c, i) => <span key={i} className="gv-chip">{String(typeof c === 'string' ? c : (c.label || ''))}</span>)}</div>
  }
  if (comp === 'Callout') {
    return (
      <div className="gv-callout" data-tone={String(p.tone || 'info')}>
        {p.title && <div style={{ fontWeight: 600, marginBottom: 4 }}>{String(p.title)}</div>}
        <div>{String(p.body || p.text || '')}</div>
      </div>
    )
  }
  if (comp === 'Skeleton') {
    return <div className="gv-card" style={{ minHeight: 56, opacity: 0.55 }}>载入中…</div>
  }
  if (comp === 'Card') {
    return (
      <div className="gv-card">
        {p.title && <strong>{String(p.title)}</strong>}
        {p.body && <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{String(p.body)}</div>}
        {Array.isArray(block.children) && block.children.map((ch) => <RenderBlock key={ch.blockId} block={ch} />)}
      </div>
    )
  }
  if (comp === 'TextBlock') {
    return <div style={{ fontSize: 13, color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}>{String(p.text || p.body || '')}</div>
  }
  return (
    <div className="gv-card">
      <strong>{String(p.title || '空区块')}</strong>
      <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{String(p.body || '')}</div>
    </div>
  )
}

export default function GenerativeView({ spec, onAction }) {
  if (!spec || !Array.isArray(spec.blocks)) return null
  return (
    <section className="gv-root" aria-label={spec.title || '生成式界面'}>
      <div className="gv-head">
        <h4 className="gv-title">✦ {spec.title || '结构化生成式视图'}</h4>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            className="gv-act-btn"
            onClick={async () => {
              await copyText(JSON.stringify(spec, null, 2))
              if (typeof onAction === 'function') onAction('copy', spec)
            }}
          >
            复制 Spec JSON
          </button>
        </div>
      </div>
      <div className="gv-layout" data-layout={spec.layout || 'single-column'}>
        {spec.blocks.map((b) => <RenderBlock key={b.blockId} block={b} />)}
      </div>
    </section>
  )
}
