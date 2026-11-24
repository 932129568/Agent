import { useState } from 'react'
import {
  useSlice,
  toggleSearchDock,
  runWebSearch,
  extractSearchUrl,
  appendComposerDraft,
  pushToast,
} from '../../state/store.js'
import './SearchDock.css'

/** 弹性分栏停靠搜索面板（与 MainStage 并排回流，绝不盖住正文） */
export default function SearchDock() {
  const ui = useSlice('ui')
  const search = useSlice('search')
  const [q, setQ] = useState(search.query || '')

  if (!ui.searchDockOpen) return null

  return (
    <aside className="sd-panel" aria-label="浏览器搜索停靠面板">
      <div className="sd-head">
        <strong>浏览器搜索（分栏回流）</strong>
        <button type="button" className="sd-btn" onClick={() => toggleSearchDock(false)}>×</button>
      </div>
      <div className="sd-bar">
        <input className="sd-input" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') runWebSearch(q) }}
          placeholder="搜索网页内容…" />
        <button type="button" className="sd-btn" onClick={() => runWebSearch(q)} disabled={search.loading}>
          {search.loading ? '搜索中…' : '搜索'}
        </button>
      </div>
      <div className="sd-body">
        {search.extracted && (
          <div className="sd-item">
            <strong>正文提取：{search.extracted.url}</strong>
            <div style={{ maxHeight: 160, overflow: 'auto', color: 'var(--text-2)' }}>{search.extracted.text.slice(0, 1200)}</div>
            <button type="button" className="sd-btn" onClick={() => {
              appendComposerDraft(`> 参考来源：${search.extracted.url}\n${search.extracted.text.slice(0, 1000)}`)
              pushToast('已引用到对话输入框', 'ok')
            }}>引用到对话</button>
          </div>
        )}
        {(search.results || []).map((item, idx) => (
          <div key={idx} className="sd-item">
            <strong>{item.title || item.url}</strong>
            <div style={{ color: 'var(--text-2)' }}>{item.snippet || ''}</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {item.url && <button type="button" className="sd-btn" onClick={() => extractSearchUrl(item.url)}>提取正文</button>}
              <button type="button" className="sd-btn" onClick={() => {
                appendComposerDraft(`参考：${item.title || ''} (${item.url || ''})\n${item.snippet || ''}`)
                pushToast('已插入输入框', 'ok')
              }}>引用</button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}
