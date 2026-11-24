import { useEffect } from 'react'
import { useSlice, closeModal, toggleDock } from '../state/store.js'
import ContextDock from '../features/dock/ContextDock.jsx'
import SettingsModal from '../features/settings/SettingsModal.jsx'
import MarketModal from '../features/market/MarketModal.jsx'
import CommandPalette from '../features/command/CommandPalette.jsx'
import './OverlayRoot.css'

export default function OverlayRoot() {
  const ui = useSlice('ui')

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (ui.activeModal) closeModal()
        else if (ui.dockOpen) toggleDock()
      }
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [ui.activeModal, ui.dockOpen])

  const modalTitle = ui.activeModal === 'settings'
    ? '设置中心（模型 / MCP / 记忆 / 真透色与动效）'
    : (ui.activeModal === 'market' ? '功能市场与专家中心' : '命令面板 (Ctrl+K)')

  return (
    <>
      <ContextDock />

      {ui.activeModal && (
        <div className="ov-backdrop" onClick={(e) => { if (e.target === e.currentTarget) closeModal() }}>
          <div className="ov-modal" data-size={ui.activeModal === 'command' ? 'compact' : 'wide'} role="dialog" aria-modal="true">
            <div className="ov-head">
              <h2 className="ov-title">{modalTitle}</h2>
              <button type="button" className="ov-close" onClick={closeModal} aria-label="关闭">×</button>
            </div>
            {ui.activeModal === 'settings' && <SettingsModal />}
            {ui.activeModal === 'market' && <MarketModal />}
            {ui.activeModal === 'command' && <CommandPalette />}
          </div>
        </div>
      )}

      <div className="ov-toasts" aria-live="polite">
        {ui.toasts.map((t) => (
          <div key={t.id} className="ov-toast" data-kind={t.kind}>{t.message}</div>
        ))}
      </div>
    </>
  )
}
