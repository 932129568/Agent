import { useEffect } from 'react'
import {
  useSlice,
  hydrateApp,
  setActivePanel,
  toggleSidebar,
  openModal,
  toggleDock,
  toggleSearchDock,
  createNewSession,
} from '../state/store.js'
import ChatPanel from '../features/chat/ChatPanel.jsx'
import SidebarSessions from '../features/sessions/SidebarSessions.jsx'
import SessionsPanel from '../features/sessions/SessionsPanel.jsx'
import WorkspacePanel from '../features/workspace/WorkspacePanel.jsx'
import PlanningPanel from '../features/planning/PlanningPanel.jsx'
import GroupPanel from '../features/group/GroupPanel.jsx'
import CollaborationPanel from '../features/collaboration/CollaborationPanel.jsx'
import AnalyticsPanel from '../features/analytics/AnalyticsPanel.jsx'
import SearchDock from '../features/search/SearchDock.jsx'
import OverlayRoot from './OverlayRoot.jsx'
import './AppShell.css'

export default function AppShell() {
  const ui = useSlice('ui')
  const sessionsState = useSlice('sessions')
  const runtime = useSlice('runtime')
  const settings = useSlice('settings')

  useEffect(() => { hydrateApp().catch(() => {}) }, [])

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault(); openModal('command')
      } else if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'd') {
        e.preventDefault(); toggleDock()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault(); createNewSession('新对话')
      }
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [])

  const currentSession = sessionsState.items.find((s) => s.id === sessionsState.currentId)
  const curRun = currentSession && runtime.runsBySid[currentSession.id]
  const busy = !!(curRun && ['waiting', 'thinking', 'streaming'].includes(curRun.phase))
  const split = runtime.hybridSplit || { localTokens: 0, cloudTokens: 0 }
  const savedYuan = ((split.localTokens / 1000) * 0.002).toFixed(2)

  return (
    <div className="hb-shell">
      <nav className="hb-rail" aria-label="主导航">
        <button type="button" className="hb-rail-btn" title="对话" data-active={String(ui.activePanel === 'chat')} onClick={() => setActivePanel('chat')}>聊</button>
        <button type="button" className="hb-rail-btn" title="会话总览" data-active={String(ui.activePanel === 'sessions')} onClick={() => setActivePanel('sessions')}>历</button>
        <button type="button" className="hb-rail-btn" title="工作区与护栏" data-active={String(ui.activePanel === 'workspace')} onClick={() => setActivePanel('workspace')}>空</button>
        <button type="button" className="hb-rail-btn" title="计划与回滚" data-active={String(ui.activePanel === 'planning')} onClick={() => setActivePanel('planning')}>计</button>
        <button type="button" className="hb-rail-btn" title="多角色群聊" data-active={String(ui.activePanel === 'group')} onClick={() => setActivePanel('group')}>群</button>
        <button type="button" className="hb-rail-btn" title="双模型协同" data-active={String(ui.activePanel === 'collaboration')} onClick={() => setActivePanel('collaboration')}>协</button>
        <button type="button" className="hb-rail-btn" title="用量与审计" data-active={String(ui.activePanel === 'analytics')} onClick={() => setActivePanel('analytics')}>析</button>
        <button type="button" className="hb-rail-btn" title="专家市场与团队编排" data-active={String(ui.activeModal === 'market')} onClick={() => openModal('market')}>市</button>
        <div className="hb-rail-spacer" />
        <button type="button" className="hb-rail-btn" title="网页搜索分栏" data-active={String(ui.searchDockOpen)} onClick={() => toggleSearchDock()}>搜</button>
        <button type="button" className="hb-rail-btn" title="上下文工作台" data-active={String(ui.dockOpen)} onClick={() => toggleDock()}>副</button>
        <button type="button" className="hb-rail-btn" title="设置中心" data-active={String(ui.activeModal === 'settings')} onClick={() => openModal('settings')}>设</button>
      </nav>

      {ui.sidebarOpen && (
        <aside className="hb-sidebar">
          <div className="hb-brand">
            <span>Harbor</span>
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>React 19 Full</span>
          </div>
          <SidebarSessions />
        </aside>
      )}

      <main className="hb-main">
        <header className="hb-topbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <button type="button" className="hb-top-btn" onClick={toggleSidebar}>
              {ui.sidebarOpen ? '◀ 侧栏' : '▶ 侧栏'}
            </button>
            <div className="hb-island" data-busy={String(busy)}>
              <span>{busy ? '◉' : '●'}</span>
              <strong>{currentSession ? currentSession.title : 'Harbor'}</strong>
              <span>· {busy ? curRun.stageLabel || curRun.phase : (settings.backendConfig.model || 'glm-4.5-flash')}</span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {runtime.updateInfo && (
              <button type="button" className="hb-top-btn" onClick={() => openModal('settings')}>
                ⬆ v{runtime.updateInfo.latest} 可用
              </button>
            )}
            <button type="button" className="hb-top-btn" onClick={() => openModal('command')}>⌘ 命令 Ctrl+K</button>
            <button type="button" className="hb-top-btn" onClick={() => toggleDock()}>工作台</button>
            <button type="button" className="hb-top-btn" onClick={() => openModal('settings')}>透色与设置</button>
          </div>
        </header>

        <div className="hb-stage-row">
          <div className="hb-stage-main">
            {ui.activePanel === 'chat' && <ChatPanel />}
            {ui.activePanel === 'sessions' && <SessionsPanel />}
            {ui.activePanel === 'workspace' && <WorkspacePanel />}
            {ui.activePanel === 'planning' && <PlanningPanel />}
            {ui.activePanel === 'group' && <GroupPanel />}
            {ui.activePanel === 'collaboration' && <CollaborationPanel />}
            {ui.activePanel === 'analytics' && <AnalyticsPanel />}
          </div>
          <SearchDock />
        </div>

        <footer className="hb-ribbon">
          <span>
            后端：{runtime.serverHealth && runtime.serverHealth.ok ? '127.0.0.1 Fastify 在线' : '离线模式'}
            {' · '}透色：{settings.backdrop} ({Math.round(settings.opacity * 100)}%)
            {(split.localTokens > 0 || split.cloudTokens > 0) && ` · 本地 ${split.localTokens.toLocaleString()} tok / 云端 ${split.cloudTokens.toLocaleString()} tok · 省 ≈¥${savedYuan}`}
          </span>
          <span>Harbor React 19 · 17 域全量迁入 · 十二条铁律</span>
        </footer>
      </main>

      <OverlayRoot />
    </div>
  )
}
