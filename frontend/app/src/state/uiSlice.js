/**
 * UI 图层、浮层互斥、动效撞击与 Toast 领域切片（R17 激进解耦）：
 * 仅依赖 state/kernel.js，零循环依赖，严守 LAW-05 / LAW-07。
 */
import { writeStorage } from '../platform/storage.js'
import { getState, patchSlice, syncRuntimeTelemetryForSid } from './kernel.js'

const ONBOARDING_SEEN_KEY = 'harbor.v5.onboarding.seen'
const WEB_SEARCH_MODE_KEY = 'harbor.v5.web_search_mode'

let impactSeq = 0

export function fireShellImpact(edge = 'left', strength = 'medium', vec = null) {
  const hasNx = vec && Number.isFinite(vec.nx)
  const hasNy = vec && Number.isFinite(vec.ny)
  patchSlice('ui', (u) => ({
    ...u,
    impactSignal: {
      seq: ++impactSeq,
      edge,
      strength,
      dx: vec && Number.isFinite(vec.dx) ? vec.dx : 0,
      dy: vec && Number.isFinite(vec.dy) ? vec.dy : 0,
      nx: hasNx ? Math.max(0.02, Math.min(0.98, vec.nx)) : null,
      ny: hasNy ? Math.max(0.02, Math.min(0.98, vec.ny)) : null,
      pointer: Boolean(vec && vec.pointer),
    },
  }))
}

export function setActivePanel(panel) {
  const st = getState()
  const prev = st.ui.activePanel
  patchSlice('ui', (u) => ({ ...u, activePanel: panel }))
  if (prev !== panel) {
    syncRuntimeTelemetryForSid(panel === 'group' ? st.group.activeGroupId : st.sessions.currentId)
    fireShellImpact('left', 'panel')
  }
}

export function toggleSidebar() {
  patchSlice('ui', (u) => ({ ...u, sidebarOpen: !u.sidebarOpen }))
}

export function toggleZenMode(force) {
  patchSlice('ui', (u) => {
    const next = typeof force === 'boolean' ? force : !u.zenMode
    return { ...u, zenMode: next }
  })
}

export function openModal(modalId, originRect = null) {
  patchSlice('ui', (u) => ({ ...u, activeModal: modalId, modalOriginRect: originRect || null, dockOpen: false }))
}

export function closeModal(impactEdge = 'left', skipImpact = false) {
  const hadModal = !!(getState().ui && getState().ui.activeModal)
  patchSlice('ui', (u) => ({ ...u, activeModal: null, modalOriginRect: null }))
  if (hadModal && !skipImpact) fireShellImpact(impactEdge, 'strong')
}

export function toggleDock(tab) {
  const wasOpen = !!(getState().ui && getState().ui.dockOpen)
  patchSlice('ui', (u) => {
    const willOpen = tab ? true : !u.dockOpen
    return { ...u, dockOpen: willOpen, dockTab: tab || u.dockTab, activeModal: willOpen ? null : u.activeModal }
  })
  if (wasOpen && !tab) fireShellImpact('right', 'strong')
}

export function setDockTab(tab) {
  patchSlice('ui', (u) => ({ ...u, dockTab: tab }))
}

export function setDockPreview(text) {
  patchSlice('ui', (u) => ({ ...u, dockPreview: String(text || ''), dockOpen: true, dockTab: 'preview', activeModal: null }))
}

export function openArtifactCanvas(artifact) {
  if (!artifact || !artifact.code) return
  patchSlice('ui', (u) => ({
    ...u,
    activeArtifact: artifact,
    dockOpen: true,
    dockTab: 'artifact',
    activeModal: null,
  }))
}

export function toggleSearchDock(force) {
  patchSlice('ui', (u) => ({ ...u, searchDockOpen: typeof force === 'boolean' ? force : !u.searchDockOpen }))
}

export function setComposerDraft(text) {
  patchSlice('ui', (u) => ({ ...u, composerDraft: String(text == null ? '' : text) }))
}

export function appendComposerDraft(snippet) {
  patchSlice('ui', (u) => ({ ...u, composerDraft: u.composerDraft ? `${u.composerDraft}\n${snippet}` : String(snippet || '') }))
}

export function addComposerToken(token) {
  patchSlice('ui', (u) => {
    if (!token || !token.id || u.composerTokens.some((t) => t.id === token.id)) return u
    return { ...u, composerTokens: [...u.composerTokens, token] }
  })
}

export function removeComposerToken(id) {
  patchSlice('ui', (u) => ({ ...u, composerTokens: u.composerTokens.filter((t) => t.id !== id) }))
}

export function dismissToast(id) {
  patchSlice('ui', (u) => ({ ...u, toasts: u.toasts.filter((t) => t.id !== id) }))
}

export function pushToast(message, kind = 'info') {
  const id = 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5)
  patchSlice('ui', (u) => ({ ...u, toasts: [...u.toasts.slice(-3), { id, message: String(message || ''), kind }] }))
  setTimeout(() => dismissToast(id), 3800)
}


export function openOnboardingModal() {
  patchSlice('ui', (u) => ({ ...u, onboardingOpen: true, activeModal: null }))
}

export function closeOnboardingModal(markSeen = true) {
  if (markSeen) {
    try { writeStorage(ONBOARDING_SEEN_KEY, '1') } catch {}
  }
  patchSlice('ui', (u) => ({ ...u, onboardingOpen: false }))
}


export function setWebSearchMode(mode = 'auto') {
  const safe = ['auto', 'visible', 'off'].includes(mode) ? mode : 'auto'
  try { writeStorage(WEB_SEARCH_MODE_KEY, safe) } catch {}
  patchSlice('ui', (u) => ({ ...u, webSearchMode: safe }))
  const labels = {
    auto: '已切换为「自动后台联网」：模型按需在后台静默搜索并标注来源',
    visible: '已切换为「前台可视浏览」：模型搜索或打开网页时将弹出浏览器窗口供你观看',
    off: '已关闭联网搜索：模型仅基于已有知识与本地工作区作答',
  }
  pushToast(labels[safe], 'info')
}
