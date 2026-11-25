import { useEffect, useRef, useState } from 'react'
import './GlassSelect.css'

export default function GlassSelect({
  value, options = [], onChange, ariaLabel = '下拉选择', title = '', prefix = '',
  block = false, direction = 'down', align = 'left', style = null,
}) {
  const [open, setOpen] = useState(false)
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

  const normOpts = (options || []).map((opt) => (
    typeof opt === 'object' && opt !== null
      ? { value: opt.value, label: String(opt.label ?? opt.value), hint: opt.hint ? String(opt.hint) : '' }
      : { value: opt, label: String(opt), hint: '' }
  ))
  const current = normOpts.find((o) => String(o.value) === String(value)) || normOpts[0] || { value: '', label: '' }

  return (
    <div ref={wrapRef} className="gs-wrap" data-block={String(Boolean(block))} style={style || undefined}>
      <button type="button" className="gs-trigger" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={String(open)} title={title || ariaLabel} onClick={() => setOpen((v) => !v)}>
        <span className="gs-val">{prefix ? `${prefix}${current.label}` : current.label}</span>
        <span className="gs-chev">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="gs-panel" data-direction={direction} data-align={align} role="listbox" aria-label={ariaLabel}>
          {normOpts.map((opt) => {
            const active = String(opt.value) === String(value)
            return (
              <button key={String(opt.value)} type="button" role="option" aria-selected={String(active)} className="gs-opt" data-active={String(active)}
                onClick={() => { setOpen(false); if (typeof onChange === 'function') onChange(opt.value) }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{opt.label}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  {opt.hint && <span className="gs-opt-hint">{opt.hint}</span>}
                  {active && <span className="gs-check">✓</span>}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
