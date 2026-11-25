import { useEffect, useRef, useState } from 'react'
import './ModelPicker.css'

function hostLabel(url = '') {
  try { return new URL(url).hostname.replace(/^www\./i, '') } catch { return '默认端点' }
}

/**
 * R25 液态玻璃模型选择器（彻底取代原生丑陋 <select> 下拉框）：
 * 展示端点域名、模型 ID、当前激活高亮与直达模型保存中心入口。
 */
export default function ModelPicker({
  value = '',
  defaultModel = 'glm-4.5-flash',
  models = [],
  onChange,
  onOpenVault,
  ariaLabel = '切换本会话模型',
  direction = 'up',
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    globalThis.addEventListener('pointerdown', onDown, true)
    globalThis.addEventListener('keydown', onKey, true)
    return () => {
      globalThis.removeEventListener('pointerdown', onDown, true)
      globalThis.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const chatModels = (models || []).filter((m) => !m.kind || m.kind === 'chat')
  const activeCustom = chatModels.find((m) => m.id === value) || null
  const labelText = activeCustom ? activeCustom.label : `默认 · ${defaultModel}`

  const pick = (id) => {
    setOpen(false)
    if (typeof onChange === 'function') onChange(id)
  }

  return (
    <div ref={wrapRef} className="mp-wrap" data-model-picker="true">
      <button
        type="button"
        className="mp-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={String(open)}
        title="点击切换当前会话使用的模型"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="mp-dot" data-custom={String(Boolean(activeCustom))} />
        <span className="mp-label">{labelText}</span>
        <span className="mp-chev">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="mp-panel" data-direction={direction} role="listbox" aria-label={ariaLabel}>
          <div className="mp-head">
            <span>选择本会话模型</span>
            <span style={{ fontWeight: 500, color: 'var(--text-3)' }}>{chatModels.length + 1} 个可用</span>
          </div>
          <div className="mp-list">
            <button
              type="button"
              role="option"
              aria-selected={String(!value)}
              className="mp-item"
              data-active={String(!value)}
              onClick={() => pick('')}
            >
              <div className="mp-item-main">
                <span className="mp-item-title">跟随全局默认模型</span>
                <span className="mp-item-meta">{defaultModel}</span>
              </div>
              {!value && <span className="mp-check">✓</span>}
            </button>

            {chatModels.map((m) => (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={String(value === m.id)}
                className="mp-item"
                data-active={String(value === m.id)}
                onClick={() => pick(m.id)}
              >
                <div className="mp-item-main">
                  <span className="mp-item-title">{m.label}</span>
                  <span className="mp-item-meta">{m.model} · {hostLabel(m.baseUrl)}</span>
                </div>
                {value === m.id && <span className="mp-check">✓</span>}
              </button>
            ))}
          </div>
          {typeof onOpenVault === 'function' && (
            <div className="mp-foot">
              <button
                type="button"
                className="mp-manage-btn"
                onClick={(e) => { setOpen(false); onOpenVault(e) }}
              >
                ＋ 管理 / 新增自定义模型 →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
