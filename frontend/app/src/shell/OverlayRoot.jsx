import { useEffect, useLayoutEffect, useRef } from 'react'
import { useSlice, closeModal, toggleDock, fireShellImpact, resolvePendingClarify, cancelDeleteGroup, confirmDeleteGroup, closeProjectSessionModal, confirmProjectSessionModal, browseProjectFolder } from '../state/store.js'
import { playModalMorphIn, playModalFlyOut, getMotionAnchorRect } from '../platform/kinetic.js'
import ContextDock from '../features/dock/ContextDock.jsx'
import SettingsModal from '../features/settings/SettingsModal.jsx'
import MarketModal from '../features/market/MarketModal.jsx'
import CommandPalette from '../features/command/CommandPalette.jsx'
import ClarifyModal from '../ui/ClarifyModal.jsx'
import GroupDeleteModal from '../ui/GroupDeleteModal.jsx'
import ProjectSessionModal from '../ui/ProjectSessionModal.jsx'
import './OverlayRoot.css'

const MODAL_HOME = {
  settings: { anchorId: 'nav-settings', edge: 'left' },
  market: { anchorId: 'nav-market', edge: 'left' },
  command: { anchorId: 'btn-command', edge: 'top' },
}

export default function OverlayRoot() {
  const ui = useSlice('ui')
  const runtime = useSlice('runtime')
  const workspace = useSlice('workspace')
  const settings = useSlice('settings')
  const backdropRef = useRef(null)
  const modalRef = useRef(null)
  const closingRef = useRef(false)

  // 打开时 useLayoutEffect 首帧同步执行 FLIP 空间展开（从触发/归属按钮位置丝滑展开，绝不闪开）
  useLayoutEffect(() => {
    closingRef.current = false
    if (!ui.activeModal || !modalRef.current) return
    const home = MODAL_HOME[ui.activeModal] || { anchorId: 'nav-settings', edge: 'left' }
    const startRect = ui.modalOriginRect || getMotionAnchorRect(home.anchorId)
    playModalMorphIn(modalRef.current, backdropRef.current, startRect, home.edge, settings.motion)
  }, [ui.activeModal])

  // 关闭时：窗口平滑飞向其归属摆放按钮位置 → 撞击瞬间传递真实矢量动量给主壳 + 目标按钮微回弹
  const handleCloseModal = () => {
    if (closingRef.current || !ui.activeModal) return
    closingRef.current = true
    const home = MODAL_HOME[ui.activeModal] || { anchorId: 'nav-settings', edge: 'left' }
    const targetRect = getMotionAnchorRect(home.anchorId) || ui.modalOriginRect
    playModalFlyOut(
      modalRef.current,
      home.edge,
      settings.motion,
      (vec) => fireShellImpact(home.edge, 'strong', vec),
      () => {
        closingRef.current = false
        // 撞击已在飞抵瞬间触发，此处 skipImpact=true 防止重复二次冲击
        closeModal(home.edge, true)
      },
      { backdropEl: backdropRef.current, targetRect, anchorId: home.anchorId }
    )
  }

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (ui.activeModal) handleCloseModal()
        else if (ui.dockOpen) toggleDock()
      }
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [ui.activeModal, ui.dockOpen, settings.motion])

  const modalTitle = ui.activeModal === 'settings'
    ? '设置中心（模型推理 / 安全护栏 / 记忆同步 / 真透色与动效）'
    : (ui.activeModal === 'market' ? '行业专家包、热门 Skill 库与团队编排' : '命令面板 (Ctrl+K)')

  return (
    <>
      <ContextDock />
      <ClarifyModal request={runtime.pendingClarify} onResolve={resolvePendingClarify} />
      <GroupDeleteModal request={runtime.pendingGroupDelete} onCancel={cancelDeleteGroup} onConfirm={confirmDeleteGroup} />
      <ProjectSessionModal
        request={runtime.pendingProjectModal}
        recentFolders={workspace.recent}
        onPickFolder={browseProjectFolder}
        onCancel={closeProjectSessionModal}
        onConfirm={confirmProjectSessionModal}
      />

      {ui.activeModal && (
        <div ref={backdropRef} className="ov-backdrop" onClick={(e) => { if (e.target === e.currentTarget) handleCloseModal() }}>
          <div ref={modalRef} className="ov-modal" data-size={ui.activeModal === 'command' ? 'compact' : 'wide'} role="dialog" aria-modal="true">
            <div className="ov-head">
              <h2 className="ov-title">{modalTitle}</h2>
              <button type="button" className="ov-close" onClick={handleCloseModal} aria-label="关闭">×</button>
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
