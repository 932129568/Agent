import { useEffect, useRef, useState } from 'react'
import { applyKineticImpulse } from '../platform/kinetic.js'
import {
  useSlice,
  hydrateApp,
  setActivePanel,
  toggleSidebar,
  openModal,
  toggleDock,
  toggleSearchDock,
  createNewSession,
  updateVisualSettings,
} from '../state/store.js'
import HarborLogo from '../ui/HarborLogo.jsx'
import { NavIcon } from '../ui/Icons.jsx'
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

const PRIMARY_NAV = [
  { id: 'chat', icon: 'chat', label: '智能对话' },
  { id: 'sessions', icon: 'sessions', label: '会话总览' },
  { id: 'workspace', icon: 'workspace', label: '工作空间' },
  { id: 'planning', icon: 'planning', label: '计划回滚' },
  { id: 'group', icon: 'group', label: '角色群聊' },
  { id: 'collaboration', icon: 'collaboration', label: '双模协同' },
  { id: 'analytics', icon: 'analytics', label: '用量洞察' },
]

export default function AppShell() {
  const ui = useSlice('ui')
  const sessionsState = useSlice('sessions')
  const runtime = useSlice('runtime')
  const settings = useSlice('settings')
  const [compactRail, setCompactRail] = useState(false)
  const [impactEdge, setImpactEdge] = useState('')
  const mainRef = useRef(null)

  useEffect(() => { hydrateApp().catch(() => {}) }, [])

  // 校准后的物理撞击响应（峰值 4.6–5.8px + scale(0.988) + 140ms 弧形高光，收敛 275ms，残余 0px）
  useEffect(() => {
    const sig = ui.impactSignal
    const el = mainRef.current
    if (!sig || !el) return undefined
    const isStrong = sig.strength === 'strong'
    const speed = isStrong ? 275 : 210
    const edge = sig.edge || 'left'
    const vx = edge === 'left' ? speed : (edge === 'right' ? -speed : 0)
    const vy = edge === 'top' ? speed * 0.75 : (edge === 'bottom' ? -speed * 0.75 : (isStrong ? 36 : 22))
    const vrot = edge === 'left' ? 7.5 : (edge === 'right' ? -7.5 : 0)
    const applied = applyKineticImpulse(el, {
      vx,
      vy,
      vrot,
      vsc: isStrong ? -0.62 : -0.34,
      omega: 24,
      zeta: 0.44,
      maxPx: isStrong ? 6.0 : 4.8,
      maxRot: isStrong ? 0.38 : 0.24,
      maxSc: isStrong ? 0.016 : 0.010,
      motionTier: settings.motion,
    })
    if (!applied) return undefined
    setImpactEdge('')
    const t1 = requestAnimationFrame(() => setImpactEdge(edge))
    const t2 = setTimeout(() => setImpactEdge(''), 180)
    return () => {
      cancelAnimationFrame(t1)
      clearTimeout(t2)
    }
  }, [ui.impactSignal, settings.motion])

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
  const activeModel = settings.backendConfig.provider_model || settings.backendConfig.model || 'glm-4.5-flash'

  return (
    <div className="hb-shell">
      <nav className="hb-rail" data-compact={String(compactRail)} aria-label="主导航">
        <div className="hb-rail-brand" onClick={() => setCompactRail((v) => !v)} style={{ cursor: 'pointer' }} title="点击切换导航栏宽/窄形态">
          <HarborLogo size={26} />
          <span className="hb-rail-title">Harbor</span>
        </div>

        <div className="hb-rail-section">工作台</div>
        {PRIMARY_NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            className="hb-rail-btn"
            title={item.label}
            data-active={String(ui.activePanel === item.id)}
            onClick={() => setActivePanel(item.id)}
          >
            <NavIcon name={item.icon} />
            <span className="hb-rail-label">{item.label}</span>
          </button>
        ))}

        <div className="hb-rail-section">扩展与工具</div>
        <button type="button" className="hb-rail-btn" title="专家市场与团队" data-active={String(ui.activeModal === 'market')} onClick={() => openModal('market')}>
          <NavIcon name="market" />
          <span className="hb-rail-label">专家市场</span>
        </button>
        <button type="button" className="hb-rail-btn" title="网页搜索分栏" data-active={String(ui.searchDockOpen)} onClick={() => toggleSearchDock()}>
          <NavIcon name="search" />
          <span className="hb-rail-label">网页搜索</span>
        </button>
        <button type="button" className="hb-rail-btn" title="右侧上下文工作台" data-active={String(ui.dockOpen)} onClick={() => toggleDock()}>
          <NavIcon name="dock" />
          <span className="hb-rail-label">上下文副屏</span>
        </button>

        <div className="hb-rail-spacer" />

        <button type="button" className="hb-rail-btn" title="设置中心" data-active={String(ui.activeModal === 'settings')} onClick={() => openModal('settings')}>
          <NavIcon name="settings" />
          <span className="hb-rail-label">系统设置</span>
        </button>
      </nav>

      {ui.sidebarOpen && (
        <aside className="hb-sidebar">
          <div className="hb-side-head">
            <span>历史会话</span>
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{sessionsState.items.length} 条</span>
          </div>
          <SidebarSessions />
        </aside>
      )}

      <main ref={mainRef} className="hb-main" data-impact-edge={impactEdge}>
        <header className="hb-topbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <button type="button" className="hb-top-btn" onClick={toggleSidebar} title="展开/收起会话栏">
              <NavIcon name="sidebar" />
              <span>{ui.sidebarOpen ? '收起会话' : '展开会话'}</span>
            </button>
            <div className="hb-island" data-busy={String(busy)}>
              <span>{busy ? '◉' : '●'}</span>
              <strong>{currentSession ? currentSession.title : 'Harbor'}</strong>
              <span>· {busy ? (curRun.stageLabel || curRun.phase) : activeModel}</span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {runtime.updateInfo && (
              <button type="button" className="hb-top-btn" onClick={() => openModal('settings')}>
                ⬆ v{runtime.updateInfo.latest}
              </button>
            )}
            <button
              type="button"
              className="hb-top-btn"
              onClick={() => updateVisualSettings({ theme: settings.theme === 'light' ? 'dark' : 'light' })}
              title="一键切换明亮/深色磨砂透色"
            >
              <NavIcon name={settings.theme === 'light' ? 'moon' : 'sun'} />
              <span>{settings.theme === 'light' ? '深色玻璃' : '明亮玻璃'}</span>
            </button>
            <button type="button" className="hb-top-btn" onClick={() => openModal('command')}>⌘ Ctrl+K</button>
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
            后端：{runtime.serverHealth && runtime.serverHealth.ok ? 'Fastify 5 在线' : '离线模式'}
            {' · '}窗外透色：{settings.backdrop} ({Math.round(settings.opacity * 100)}%)
            {runtime.cacheTotals && runtime.cacheTotals.promptTokens > 0 && ` · 缓存命中 ${runtime.cacheTotals.hitRate}% (${runtime.cacheTotals.cachedTokens.toLocaleString()} tok)`}
            {(split.localTokens > 0 || split.cloudTokens > 0) && ` · 本地 ${split.localTokens.toLocaleString()} / 云端 ${split.cloudTokens.toLocaleString()} tok · 省 ≈¥${savedYuan}`}
          </span>
          <span>Harbor · React 19 + Fastify 5</span>
        </footer>
      </main>

      <OverlayRoot />
    </div>
  )
}
