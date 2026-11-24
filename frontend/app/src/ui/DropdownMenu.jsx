import { useEffect, useMemo, useRef, useState } from 'react'
import './DropdownMenu.css'

/**
 * 统一发布级玻璃态二级弹出菜单（R20 深度打磨 · 100% 遵守 LAW-01 / LAW-05 / LAW-07）：
 * - 支持上弹/下弹/侧弹、平滑缩放退场（data-closing="true"）；
 * - 完整键盘无障碍导航：ArrowDown / ArrowUp / Home / End / Enter / Escape；
 * - 点击外部自动平滑关闭，支持分组、分割线、选中对勾、快捷键提示与危险项着色。
 */
export default function DropdownMenu({
  label = '更多',
  title = '',
  ariaLabel = '更多操作菜单',
  triggerClassName = '',
  triggerActive = false,
  renderTrigger = null,
  items = [],
  align = 'right',
  direction = 'down',
  side = '',
  block = false,
}) {
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [focusIdx, setFocusIdx] = useState(-1)
  const wrapRef = useRef(null)
  const timerRef = useRef(0)

  const actionableIndices = useMemo(() => {
    const arr = []
    ;(Array.isArray(items) ? items : []).forEach((it, idx) => {
      if (it && !it.hidden && !it.divider && !it.section && !it.disabled) arr.push(idx)
    })
    return arr
  }, [items])

  const closeSmoothly = () => {
    if (!open || closing) return
    setClosing(true)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      setClosing(false)
      setOpen(false)
      setFocusIdx(-1)
    }, 115)
  }

  const toggleMenu = () => {
    if (open && !closing) {
      closeSmoothly()
    } else {
      clearTimeout(timerRef.current)
      setClosing(false)
      setOpen(true)
      setFocusIdx(-1)
    }
  }

  useEffect(() => () => clearTimeout(timerRef.current), [])

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        closeSmoothly()
      }
    }
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeSmoothly()
      } else if (e.key === 'ArrowDown' && actionableIndices.length) {
        e.preventDefault()
        setFocusIdx((cur) => {
          const pos = actionableIndices.indexOf(cur)
          return actionableIndices[(pos + 1) % actionableIndices.length]
        })
      } else if (e.key === 'ArrowUp' && actionableIndices.length) {
        e.preventDefault()
        setFocusIdx((cur) => {
          const pos = actionableIndices.indexOf(cur)
          return actionableIndices[(pos <= 0 ? actionableIndices.length : pos) - 1]
        })
      } else if (e.key === 'Home' && actionableIndices.length) {
        e.preventDefault()
        setFocusIdx(actionableIndices[0])
      } else if (e.key === 'End' && actionableIndices.length) {
        e.preventDefault()
        setFocusIdx(actionableIndices[actionableIndices.length - 1])
      } else if (e.key === 'Enter' && focusIdx >= 0 && items[focusIdx]) {
        e.preventDefault()
        handlePick(items[focusIdx], e)
      }
    }
    globalThis.addEventListener('pointerdown', onPointerDown)
    globalThis.addEventListener('keydown', onKeyDown)
    return () => {
      globalThis.removeEventListener('pointerdown', onPointerDown)
      globalThis.removeEventListener('keydown', onKeyDown)
    }
  }, [open, closing, actionableIndices, focusIdx, items])

  const handlePick = (item, ev) => {
    if (!item || item.disabled) return
    if (!item.keepOpen) closeSmoothly()
    if (typeof item.onClick === 'function') item.onClick(ev)
  }

  return (
    <div ref={wrapRef} className="dm-wrap" data-block={String(!!block)} data-open={String(open)}>
      {typeof renderTrigger === 'function' ? (
        renderTrigger({ open, toggle: toggleMenu })
      ) : (
        <button
          type="button"
          className={triggerClassName}
          title={title || ariaLabel}
          aria-label={ariaLabel}
          aria-expanded={String(open)}
          aria-haspopup="menu"
          data-active={String(open || !!triggerActive)}
          onClick={toggleMenu}
        >
          {label}
        </button>
      )}

      {open && (
        <div
          className="dm-panel"
          role="menu"
          aria-label={ariaLabel}
          data-align={align}
          data-dir={direction}
          data-side={side || undefined}
          data-closing={String(closing)}
        >
          {(Array.isArray(items) ? items : []).map((it, i) => {
            if (!it || it.hidden) return null
            if (it.divider) return <div key={`div_${i}`} className="dm-divider" role="separator" />
            if (it.section) return <div key={`sec_${i}`} className="dm-section">{it.section}</div>
            return (
              <button
                key={it.id || `mi_${i}`}
                type="button"
                role="menuitem"
                className="dm-item"
                disabled={!!it.disabled}
                data-active={String(!!it.active)}
                data-focused={String(focusIdx === i)}
                data-danger={String(!!it.danger)}
                onMouseEnter={() => setFocusIdx(i)}
                onClick={(ev) => handlePick(it, ev)}
              >
                <span className="dm-item-left">
                  {it.icon && <span>{it.icon}</span>}
                  <span className="dm-item-label">{it.label}</span>
                </span>
                {it.active ? (
                  <span className="dm-item-hint">✓</span>
                ) : (
                  it.hint && <span className="dm-item-hint">{it.hint}</span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
