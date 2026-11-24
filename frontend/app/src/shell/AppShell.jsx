import { useEffect, useRef, useState } from 'react'
import { applyKineticImpulse, applySecondaryRecoil, registerMotionAnchor, captureTriggerRect, motionScaleForTier } from '../platform/kinetic.js'
import { desktopBridge } from '../platform/libs.js'
import {
  useSlice,
  hydrateApp,
  flushPersistSessions,
  setActivePanel,
  toggleSidebar,
  toggleZenMode,
  openModal,
  openOnboardingModal,
  setSessionModelOverride,
  activateSavedModelGlobal,
  toggleDock,
  toggleSearchDock,
  createNewSession,
  createNewGroup,
  createNewWorkflow,
  updateVisualSettings,
} from '../state/store.js'
import HarborLogo from '../ui/HarborLogo.jsx'
import { NavIcon } from '../ui/Icons.jsx'
import DropdownMenu from '../ui/DropdownMenu.jsx'
import { findSavedModel } from '../services/modelVault.js'
import ChatPanel from '../features/chat/ChatPanel.jsx'
import SidebarSessions from '../features/sessions/SidebarSessions.jsx'
import SessionsPanel from '../features/sessions/SessionsPanel.jsx'
import WorkspacePanel from '../features/workspace/WorkspacePanel.jsx'
import PlanningPanel from '../features/planning/PlanningPanel.jsx'
import WorkflowPanel from '../features/workflow/WorkflowPanel.jsx'
import GroupPanel from '../features/group/GroupPanel.jsx'
import CollaborationPanel from '../features/collaboration/CollaborationPanel.jsx'
import AnalyticsPanel from '../features/analytics/AnalyticsPanel.jsx'
import SearchDock from '../features/search/SearchDock.jsx'
import OverlayRoot from './OverlayRoot.jsx'
import './AppShell.css'

/** 一级核心导航（克制 4 项，直达最高频工作台） */
const PRIMARY_NAV = [
  { id: 'chat', icon: 'chat', label: '智能对话' },
  { id: 'group', icon: 'group', label: '角色群聊' },
  { id: 'workflow', icon: 'workflow', label: '工作流插件' },
  { id: 'workspace', icon: 'workspace', label: '工作空间' },
]

/** 二级收纳导航（折叠于「更多功能」，保持一级界面清爽专注） */
const SECONDARY_NAV = [
  { id: 'sessions', icon: 'sessions', label: '会话总览' },
  { id: 'planning', icon: 'planning', label: '计划回滚' },
  { id: 'collaboration', icon: 'collaboration', label: '双模协同' },
  { id: 'analytics', icon: 'analytics', label: '用量洞察' },
]

export default function AppShell() {
  const ui = useSlice('ui')
  const sessionsState = useSlice('sessions')
  const group = useSlice('group')
  const pluginsState = useSlice('plugins')
  const runtime = useSlice('runtime')
  const settings = useSlice('settings')
  const [compactRail, setCompactRail] = useState(false)
  const [moreNavOpen, setMoreNavOpen] = useState(false)
  const [impactEdge, setImpactEdge] = useState('')
  const [impactY, setImpactY] = useState('50%')
  const shellRef = useRef(null)
  const railRef = useRef(null)
  const mainRef = useRef(null)

  useEffect(() => { hydrateApp().catch(() => {}) }, [])

  useEffect(() => {
    const playShellTransition = (phase) => {
      const el = shellRef.current
      const k = motionScaleForTier(settings.motion)
      if (!el || k === 0 || typeof el.animate !== 'function') return
      if (phase === 'open') {
        el.animate(
          [
            { transform: `translate3d(0,${(18 * k).toFixed(1)}px,0) scale(${(1 - 0.022 * k).toFixed(3)})`, opacity: 0.05 },
            { transform: 'translate3d(0,0,0) scale(1)', opacity: 1 },
          ],
          { duration: 270, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'backwards' }
        )
      } else if (phase === 'close') {
        el.animate(
          [
            { transform: 'translate3d(0,0,0) scale(1)', opacity: 1 },
            { transform: `translate3d(0,${(22 * k).toFixed(1)}px,0) scale(${(1 - 0.032 * k).toFixed(3)})`, opacity: 0 },
          ],
          { duration: 190, easing: 'cubic-bezier(.36, 0, .84, .32)', fill: 'forwards' }
        )
      }
    }
    playShellTransition('open')
    const desktop = desktopBridge()
    if (desktop && typeof desktop.onWindowLifecycle === 'function') {
      return desktop.onWindowLifecycle((ev) => {
        if (!ev) return
        if (ev.phase === 'close') flushPersistSessions()
        if (ev.phase === 'open' || ev.phase === 'close') playShellTransition(ev.phase)
      })
    }
    return undefined
  }, [settings.motion])

  useEffect(() => {
    const sig = ui.impactSignal
    const el = mainRef.current
    if (!sig || !el) return undefined
    const isStrong = sig.strength === 'strong'
    const speed = isStrong ? 275 : 210
    const edge = sig.edge || 'left'
    const yBias = sig.dy ? Math.max(-68, Math.min(68, sig.dy * 0.22)) : (isStrong ? 32 : 18)
    const vx = edge === 'left' ? speed : (edge === 'right' ? -speed : 0)
    const vy = edge === 'top' ? speed * 0.78 : (edge === 'bottom' ? -speed * 0.78 : yBias)
    const vrot = edge === 'left' ? (sig.dy > 40 ? -6.5 : 7.5) : (edge === 'right' ? -7.5 : 0)
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
    // 耦合反作用力：左侧主导航承重边缘吸收相反方向微回弹，增强真实质量撞击手感
    if (edge === 'left' && railRef.current) {
      applySecondaryRecoil(railRef.current, { edge, strength: sig.strength, motionTier: settings.motion })
    }
    const pct = sig.dy ? Math.max(16, Math.min(84, Math.round(50 + sig.dy * 0.12))) : 50
    setImpactY(`${pct}%`)
    setImpactEdge('')
    const t1 = requestAnimationFrame(() => setImpactEdge(edge))
    const t2 = setTimeout(() => setImpactEdge(''), 240)
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
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault(); toggleZenMode()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        if (ui.activePanel === 'group') createNewGroup()
        else if (ui.activePanel === 'workflow') createNewWorkflow()
        else createNewSession('新对话')
      }
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [ui.activePanel])

  const isGroupPanel = ui.activePanel === 'group'
  const isWorkflowPanel = ui.activePanel === 'workflow'
  const secondaryActive = SECONDARY_NAV.some((item) => item.id === ui.activePanel)
  const activeWorkflow = (pluginsState.workflows || []).find((w) => w.id === pluginsState.activeWorkflowId)
  const currentSession = sessionsState.items.find((s) => s.id === sessionsState.currentId)
  const curRun = currentSession && runtime.runsBySid[currentSession.id]
  const busy = isWorkflowPanel
    ? (pluginsState.run && pluginsState.run.status === 'running')
    : (isGroupPanel
      ? !!group.running
      : !!(curRun && ['waiting', 'thinking', 'streaming'].includes(curRun.phase)))
  const savedModels = Array.isArray(settings.savedModels) ? settings.savedModels : []
  const chatSavedModels = savedModels.filter((m) => !m.kind || m.kind === 'chat')
  const sessionSavedHit = currentSession && currentSession.modelProfileId ? findSavedModel(savedModels, currentSession.modelProfileId) : null
  const globalModel = settings.backendConfig.provider_model || settings.backendConfig.model || 'glm-4.5-flash'
  const activeModel = sessionSavedHit ? sessionSavedHit.label : ((currentSession && currentSession.modelProfileId) || globalModel)
  const topTitle = isWorkflowPanel
    ? (activeWorkflow ? activeWorkflow.name : '工作流插件')
    : (isGroupPanel
      ? (group.title || '多角色群聊')
      : (currentSession ? currentSession.title : 'Harbor'))
  const topSubStatus = isWorkflowPanel
    ? (busy ? 'DAG 并发执行中…' : `${(pluginsState.plugins || []).filter((p) => p.enabled).length} 个插件在线`)
    : (isGroupPanel
      ? (group.running ? (group.status === 'planning' ? '主持人调度中…' : '群聊接力中…') : activeModel)
      : (busy ? (curRun.stageLabel || curRun.phase) : activeModel))
  const split = runtime.hybridSplit || { localTokens: 0, cloudTokens: 0 }
  const savedYuan = ((split.localTokens / 1000) * 0.002).toFixed(2)

  const toolboxItems = [
    { section: '侧栏扩展工具' },
    {
      id: 'tb-dock',
      icon: '◫',
      label: '上下文副屏与实时画布',
      hint: 'Ctrl+Alt+D',
      active: ui.dockOpen,
      onClick: () => toggleDock(),
    },
    {
      id: 'tb-search',
      icon: '🌐',
      label: 'Agent 联网动态与来源',
      active: ui.searchDockOpen,
      onClick: () => toggleSearchDock(),
    },
  ]

  const appearanceItems = [
    { section: '主题模式' },
    {
      id: 'ap-light',
      icon: '☀',
      label: '明亮暖玻璃',
      active: settings.theme === 'light',
      onClick: () => updateVisualSettings({ theme: 'light' }),
    },
    {
      id: 'ap-dark',
      icon: '☾',
      label: '深色磨砂玻璃',
      active: settings.theme === 'dark',
      onClick: () => updateVisualSettings({ theme: 'dark' }),
    },
    { divider: true },
    { section: '窗外透色材质' },
    {
      id: 'ap-acrylic',
      label: 'Acrylic · 实时透窗外',
      active: settings.backdrop === 'acrylic',
      onClick: () => updateVisualSettings({ backdrop: 'acrylic' }),
    },
    {
      id: 'ap-mica',
      label: 'Mica · 柔和桌面色调',
      active: settings.backdrop === 'mica',
      onClick: () => updateVisualSettings({ backdrop: 'mica' }),
    },
    {
      id: 'ap-none',
      label: '纯实色背景',
      active: settings.backdrop === 'none',
      onClick: () => updateVisualSettings({ backdrop: 'none' }),
    },
    { divider: true },
    { section: '动效强度' },
    {
      id: 'ap-m-dyn',
      label: '灵动动效 (1.0×)',
      active: settings.motion === 'dynamic',
      onClick: () => updateVisualSettings({ motion: 'dynamic' }),
    },
    {
      id: 'ap-m-bal',
      label: '轻盈平衡 (0.58×)',
      active: settings.motion === 'balanced',
      onClick: () => updateVisualSettings({ motion: 'balanced' }),
    },
    {
      id: 'ap-m-red',
      label: '静息无障碍 (0×)',
      active: settings.motion === 'reduced',
      onClick: () => updateVisualSettings({ motion: 'reduced' }),
    },
    { divider: true },
    {
      id: 'ap-guide',
      icon: '📖',
      label: '功能说明与软件特色',
      hint: '指南',
      onClick: () => openOnboardingModal(),
    },
    {
      id: 'ap-settings',
      icon: '⚙',
      label: '透色与完整设置…',
      hint: '设置中心',
      onClick: (e) => openModal('settings', captureTriggerRect(e)),
    },
  ]

  return (
    <div ref={shellRef} className="hb-shell" data-zen={String(!!ui.zenMode)}>
      <nav ref={railRef} className="hb-rail" data-compact={String(compactRail)} aria-label="主导航">
        <div className="hb-rail-brand" onClick={() => setCompactRail((v) => !v)} style={{ cursor: 'pointer' }} title="点击切换导航栏宽/窄形态">
          <HarborLogo size={26} />
          <span className="hb-rail-title">Harbor</span>
        </div>

        <div className="hb-rail-group">
          {PRIMARY_NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className="hb-rail-btn"
              title={item.label}
              data-primary-nav="true"
              data-active={String(ui.activePanel === item.id)}
              onClick={() => setActivePanel(item.id)}
            >
              <NavIcon name={item.icon} />
              <span className="hb-rail-label">{item.label}</span>
            </button>
          ))}
        </div>

        <div className="hb-rail-divider" />

        {compactRail ? (
          <DropdownMenu
            block
            side="right"
            ariaLabel="更多工作台"
            items={SECONDARY_NAV.map((item) => ({
              id: `sec_${item.id}`,
              label: item.label,
              active: ui.activePanel === item.id,
              onClick: () => setActivePanel(item.id),
            }))}
            renderTrigger={({ open, toggle }) => (
              <button
                type="button"
                className="hb-rail-btn"
                title="更多功能"
                aria-expanded={String(open)}
                data-active={String(open || secondaryActive)}
                onClick={toggle}
              >
                <NavIcon name="more" />
              </button>
            )}
          />
        ) : (
          <div className="hb-rail-more">
            <button
              type="button"
              className="hb-rail-btn hb-rail-more-toggle"
              title="展开或收起更多功能"
              aria-expanded={String(moreNavOpen || secondaryActive)}
              data-active={String(secondaryActive && !moreNavOpen)}
              onClick={() => setMoreNavOpen((v) => !v)}
            >
              <NavIcon name="more" />
              <span className="hb-rail-label">更多功能</span>
              <span className="hb-rail-chev" data-open={String(moreNavOpen || secondaryActive)}>
                <NavIcon name="chevron" />
              </span>
            </button>
            {(moreNavOpen || secondaryActive) && (
              <div className="hb-rail-sublist" role="group" aria-label="二级功能菜单">
                {SECONDARY_NAV.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="hb-rail-btn hb-rail-sub-btn"
                    title={item.label}
                    data-active={String(ui.activePanel === item.id)}
                    onClick={() => setActivePanel(item.id)}
                  >
                    <NavIcon name={item.icon} />
                    <span className="hb-rail-label">{item.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="hb-rail-spacer" />

        <div className="hb-rail-divider" />

        <div className="hb-rail-group">
          <button
            ref={(el) => registerMotionAnchor('nav-market', el)}
            type="button"
            className="hb-rail-btn"
            title="行业专家包与 Skill 市场"
            data-active={String(ui.activeModal === 'market')}
            onClick={(e) => openModal('market', captureTriggerRect(e))}
          >
            <NavIcon name="market" />
            <span className="hb-rail-label">专家市场</span>
          </button>

          <DropdownMenu
            block
            direction="up"
            align="left"
            side={compactRail ? 'right' : ''}
            ariaLabel="侧栏工具箱"
            items={toolboxItems}
            renderTrigger={({ open, toggle }) => (
              <button
                ref={(el) => { registerMotionAnchor('nav-toolbox', el); registerMotionAnchor('nav-dock', el) }}
                type="button"
                className="hb-rail-btn"
                title="工具箱（副屏画布 / Agent 联网动态）"
                aria-expanded={String(open)}
                data-active={String(open || ui.dockOpen || ui.searchDockOpen)}
                onClick={toggle}
              >
                <NavIcon name="toolbox" />
                <span className="hb-rail-label">工具箱</span>
                {(ui.dockOpen || ui.searchDockOpen) && <span className="hb-rail-dot" />}
              </button>
            )}
          />

          <button
            ref={(el) => registerMotionAnchor('nav-settings', el)}
            type="button"
            className="hb-rail-btn"
            title="系统设置"
            data-active={String(ui.activeModal === 'settings')}
            onClick={(e) => openModal('settings', captureTriggerRect(e))}
          >
            <NavIcon name="settings" />
            <span className="hb-rail-label">系统设置</span>
          </button>
        </div>
      </nav>

      {ui.sidebarOpen && !ui.zenMode && (
        <aside className="hb-sidebar">
          <div className="hb-side-head">
            <span>{isWorkflowPanel ? '工作流目录' : (isGroupPanel ? '群聊列表' : '历史会话')}</span>
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
              {isWorkflowPanel
                ? `${(pluginsState.workflows || []).length} 条`
                : (isGroupPanel ? `${(group.items || []).length} 个` : `${sessionsState.items.length} 条`)}
            </span>
          </div>
          <SidebarSessions />
        </aside>
      )}

      <main ref={mainRef} className="hb-main" data-impact-edge={impactEdge} style={{ '--impact-y': impactY }}>
        <header className="hb-topbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <button type="button" className="hb-top-btn hb-icon-btn" onClick={toggleSidebar} title={ui.sidebarOpen ? '收起侧边栏' : '展开侧边栏'} aria-label={ui.sidebarOpen ? '收起侧边栏' : '展开侧边栏'}>
              <NavIcon name="sidebar" />
            </button>
            <DropdownMenu
              align="left"
              direction="down"
              ariaLabel="快速切换保存的模型"
              items={[
                { section: '当前会话模型切换' },
                {
                  id: 'mdl-default',
                  icon: '●',
                  label: `跟随全局默认 (${globalModel})`,
                  active: !(currentSession && currentSession.modelProfileId),
                  onClick: () => currentSession && setSessionModelOverride(currentSession.id, ''),
                },
                ...chatSavedModels.map((m) => ({
                  id: `mdl_${m.id}`,
                  icon: m.isLocal ? '💻' : '☁',
                  label: m.label,
                  hint: m.model,
                  active: Boolean(currentSession && currentSession.modelProfileId === m.id),
                  onClick: () => {
                    if (currentSession) setSessionModelOverride(currentSession.id, m.id)
                    else activateSavedModelGlobal(m.id)
                  },
                })),
                { divider: true },
                {
                  id: 'mdl-manage',
                  icon: '🧠',
                  label: `管理模型保存中心 (${savedModels.length})…`,
                  hint: '添加/编辑',
                  onClick: (e) => openModal('settings', captureTriggerRect(e)),
                },
              ]}
              renderTrigger={({ open, toggle }) => (
                <button
                  type="button"
                  className="hb-island"
                  data-busy={String(busy)}
                  aria-expanded={String(open)}
                  onClick={toggle}
                  title="点击快速切换已保存的模型，或进入模型保存中心"
                >
                  <span className="hb-island-dot" data-busy={String(busy)} />
                  <strong>{topTitle}</strong>
                  <span>· {topSubStatus}</span>
                </button>
              )}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {runtime.updateInfo && (
              <button type="button" className="hb-top-btn" onClick={(e) => openModal('settings', captureTriggerRect(e))}>
                ⬆ v{runtime.updateInfo.latest}
              </button>
            )}
            <button
              ref={(el) => registerMotionAnchor('btn-command', el)}
              type="button"
              className="hb-top-btn"
              onClick={(e) => openModal('command', captureTriggerRect(e))}
              title="打开全局命令面板 (Ctrl+K)"
            >
              ⌘ Ctrl+K
            </button>
            <button
              type="button"
              className="hb-top-btn"
              data-active={String(!!ui.zenMode)}
              onClick={() => toggleZenMode()}
              title="专注模式（Ctrl+Shift+F）：隐藏导航栏与侧边栏"
            >
              <span>{ui.zenMode ? '⊞ 退出专注' : '⊡ 专注'}</span>
            </button>
            <DropdownMenu
              align="right"
              direction="down"
              ariaLabel="外观与透色菜单"
              items={appearanceItems}
              renderTrigger={({ open, toggle }) => (
                <button
                  type="button"
                  className="hb-top-btn"
                  aria-expanded={String(open)}
                  data-active={String(open)}
                  onClick={toggle}
                  title="外观主题、窗外透色与动效强度"
                >
                  <NavIcon name="palette" />
                  <span>外观</span>
                </button>
              )}
            />
          </div>
        </header>

        <div className="hb-stage-row">
          <div className="hb-stage-main">
            <div key={ui.activePanel} className="hb-stage-view">
              {ui.activePanel === 'chat' && <ChatPanel />}
              {ui.activePanel === 'sessions' && <SessionsPanel />}
              {ui.activePanel === 'workspace' && <WorkspacePanel />}
              {ui.activePanel === 'workflow' && <WorkflowPanel />}
              {ui.activePanel === 'planning' && <PlanningPanel />}
              {ui.activePanel === 'group' && <GroupPanel />}
              {ui.activePanel === 'collaboration' && <CollaborationPanel />}
              {ui.activePanel === 'analytics' && <AnalyticsPanel />}
            </div>
          </div>
          <SearchDock />
        </div>

        <footer className="hb-ribbon">
          <button
            type="button"
            className="hb-ribbon-btn"
            onClick={() => toggleDock('overview')}
            title="点击打开上下文工作台查看详细遥测"
          >
            {runtime.serverHealth && runtime.serverHealth.ok ? '● 服务就绪' : '○ 离线模式'}
            {' · '}透色：{settings.backdrop} ({Math.round(settings.opacity * 100)}%)
            {runtime.cacheTotals && runtime.cacheTotals.promptTokens > 0 && ` · 本轮缓存 ${runtime.cacheTotals.latestHitRate}% / 累计 ${runtime.cacheTotals.hitRate}% (${runtime.cacheTotals.cachedTokens.toLocaleString()} tok)`}
            {(split.localTokens > 0 || split.cloudTokens > 0) && ` · 本地 ${split.localTokens.toLocaleString()} / 云端 ${split.cloudTokens.toLocaleString()} tok · 省 ≈¥${savedYuan}`}
          </button>
          <span>Harbor Desktop</span>
        </footer>
      </main>

      <OverlayRoot />
    </div>
  )
}
