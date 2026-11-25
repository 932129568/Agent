import { useEffect, useRef, useState } from 'react'
import './ModelPicker.css'

function hostLabel(url = '') {
  try { return new URL(url).hostname.replace(/^www\./i, '') } catch { return '继承主端点' }
}

export default function ModelPicker({
  value = '', defaultModel = 'glm-4.5-flash', models = [], onChange, onOpenVault,
  ariaLabel = '切换本会话模型', direction = 'up', align = 'right', renderTrigger = null,
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const wrapRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    globalThis.addEventListener('pointerdown', onDown, true)
    globalThis.addEventListener('keydown', onKey, true)
    return () => {
      globalThis.removeEventListener('pointerdown', onDown, true)
      globalThis.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const chatModels = (models || []).filter((m) => !m.kind || m.kind === 'chat')
  const kw = q.trim().toLowerCase()
  const filteredModels = kw
    ? chatModels.filter((m) => [m.label, m.model, m.baseUrl].join(' ').toLowerCase().includes(kw))
    : chatModels
  const activeCustom = chatModels.find((m) => m.id === value) || null
  const labelText = activeCustom ? activeCustom.label : `默认 · ${defaultModel}`

  const pick = (id) => { setOpen(false); setQ(''); if (typeof onChange === 'function') onChange(id) }

  return (
    <div ref={wrapRef} className="mp-wrap" data-model-picker="true">
      {typeof renderTrigger === 'function' ? (
        renderTrigger({ open, toggle: () => setOpen((v) => !v), activeCustom, labelText })
      ) : (
        <button type="button" className="mp-trigger" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={String(open)} title="点击切换模型" onClick={() => setOpen((v) => !v)}>
          <span className="mp-dot" data-custom={String(Boolean(activeCustom))} />
          <span className="mp-label">{labelText}</span>
          <span className="mp-chev">{open ? '▴' : '▾'}</span>
        </button>
      )}
      {open && (
        <div className="mp-panel" data-direction={direction} data-align={align} role="listbox" aria-label={ariaLabel}>
          <div className="mp-head">
            <div className="mp-head-row">
              <span>切换模型配置</span>
              <span style={{ fontWeight: 500, color: 'var(--text-3)' }}>{chatModels.length + 1} 个可用</span>
            </div>
            {chatModels.length >= 3 && (
              <input className="mp-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="筛选已保存模型名或端点…" />
            )}
          </div>
          <div className="mp-list">
            {!kw && (
              <button type="button" role="option" aria-selected={String(!value)} className="mp-item" data-active={String(!value)} onClick={() => pick('')}>
                <div className="mp-item-main">
                  <div className="mp-item-top"><span className="mp-item-title">跟随全局默认模型</span><span className="mp-tag">默认</span></div>
                  <span className="mp-item-meta">{defaultModel}</span>
                </div>
                {!value && <span className="mp-check">✓</span>}
              </button>
            )}
            {filteredModels.map((m) => (
              <button key={m.id} type="button" role="option" aria-selected={String(value === m.id)} className="mp-item" data-active={String(value === m.id)} onClick={() => pick(m.id)}>
                <div className="mp-item-main">
                  <div className="mp-item-top">
                    <span className="mp-item-title">{m.label}</span>
                    <span className="mp-tag">{m.isLocal ? '💻 本地' : '☁ 云端'}</span>
                  </div>
                  <span className="mp-item-meta">{m.model} · {hostLabel(m.baseUrl)}</span>
                </div>
                {value === m.id && <span className="mp-check">✓</span>}
              </button>
            ))}
          </div>
          {typeof onOpenVault === 'function' && (
            <div className="mp-foot">
              <button type="button" className="mp-manage-btn" onClick={(e) => { setOpen(false); onOpenVault(e) }}>＋ 管理 / 新增自定义模型 →</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
