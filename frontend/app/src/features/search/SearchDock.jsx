import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  useSlice,
  toggleSearchDock,
  runWebSearch,
  extractSearchUrl,
  appendComposerDraft,
  fireShellImpact,
  pushToast,
} from '../../state/store.js'
import { playDrawerSlideIn, playDrawerSlideOut } from '../../platform/kinetic.js'
import './SearchDock.css'

export default function SearchDock() {
  const ui = useSlice('ui')
  const search = useSlice('search')
  const settings = useSlice('settings')
  const [q, setQ] = useState(search.query || '')
  const [mounted, setMounted] = useState(!!ui.searchDockOpen)
  const panelRef = useRef(null)
  const closingRef = useRef(false)

  useEffect(() => {
    if (ui.searchDockOpen) {
      closingRef.current = false
      setMounted(true)
    } else if (mounted && !closingRef.current) {
      closingRef.current = true
      playDrawerSlideOut(
        panelRef.current,
        settings.motion,
        () => fireShellImpact('right', 'medium'),
        () => {
          closingRef.current = false
          setMounted(false)
        },
        'nav-toolbox'
      )
    }
  }, [ui.searchDockOpen])

  useLayoutEffect(() => {
    if (mounted && ui.searchDockOpen && panelRef.current) {
      playDrawerSlideIn(panelRef.current, settings.motion)
    }
  }, [mounted, ui.searchDockOpen])

  if (!mounted) return null

  return (
    <aside ref={panelRef} className="sd-panel" aria-label="浏览器搜索停靠面板">
      <div className="sd-head">
        <strong>网页搜索</strong>
        <button type="button" className="sd-btn" onClick={() => toggleSearchDock(false)} aria-label="关闭搜索">×</button>
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
