import { useEffect, useRef, useState } from 'react'
import { applyKineticImpulse, applySecondaryRecoil, applyLocalGlassPress, computeDirectionalImpulse, computeViewportCoords, registerMotionAnchor, captureTriggerRect, motionScaleForTier, IMPACT_STYLES, resolveImpactStyle } from '../platform/kinetic.js'
import { createGlassSandboxState } from '../platform/glassSandboxEngine.js'
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
import LiquidImpactCanvas from '../ui/LiquidImpactCanvas.jsx'
import ModelPicker from '../ui/ModelPicker.jsx'
import GlassSandboxOverlay from '../ui/GlassSandboxOverlay.jsx'
import CompanionOverlay from '../features/companion/CompanionOverlay.jsx'
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
  const [impactPos, setImpactPos] = useState({ nx: 0.04, ny: 0.5 })
  const [impactSeq, setImpactSeq] = useState(0)
  const [activeImpactMeta, setActiveImpactMeta] = useState({ styleId: 'mercury', edge: 'left', strength: 'strong' })
  const lastPointerRef = useRef({ nx: null, ny: null, at: 0 })
  const glintRafRef = useRef(0)
  const sandboxStoreRef = useRef(null)
  if (!sandboxStoreRef.current) sandboxStoreRef.current = createGlassSandboxState()
  const [shatterSignal, setShatterSignal] = useState(0)
  const [companionSummonSeq, setCompanionSummonSeq] = useState(0)
  const [, setSandboxRefresh] = useState(0)
  const shellRef = useRef(null)
  const railRef = useRef(null)
  const topbarRef = useRef(null)
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
    const stylePreset = resolveImpactStyle(settings.impactStyle || 'mercury', sig.seq)
    // 若触发源未显式传边缘测试（panel/medium），优先使用 220ms 内用户真实点击的屏幕归一化坐标
    const freshPtr = (Date.now() - lastPointerRef.current.at) < 260 ? lastPointerRef.current : null
    const useNx = sig.nx != null ? sig.nx : (sig.strength === 'panel' && freshPtr ? freshPtr.nx : null)
    const useNy = sig.ny != null ? sig.ny : (sig.strength === 'panel' && freshPtr ? freshPtr.ny : null)
    const phys = computeDirectionalImpulse({
      nx: useNx,
      ny: useNy,
      edge: sig.edge || 'left',
      dy: sig.dy || 0,
      strength: sig.strength || 'strong',
      stylePreset,
    })
    const applied = applyKineticImpulse(el, {
      vx: phys.vx,
      vy: phys.vy,
      vrot: phys.vrot,
      vsc: phys.vsc,
      vrx: phys.vrx,
      vry: phys.vry,
      omega: stylePreset.omega || 24,
      zeta: stylePreset.zeta || 0.44,
      maxPx: phys.maxPx,
      maxRot: phys.maxRot,
      maxSc: phys.maxSc,
      maxTilt: phys.maxTilt,
      motionTier: settings.motion,
    })
    if (!applied) return undefined
    if (phys.edge === 'left' && railRef.current) {
      applySecondaryRecoil(railRef.current, { edge: 'left', strength: sig.strength, motionTier: settings.motion })
    } else if (phys.edge === 'top' && topbarRef.current) {
      applySecondaryRecoil(topbarRef.current, { edge: 'top', strength: sig.strength, motionTier: settings.motion })
    }
    const pct = Math.max(12, Math.min(88, Math.round(phys.ny * 100)))
    setImpactPos({ nx: phys.nx, ny: phys.ny })
    setImpactY(`${pct}%`)
    setActiveImpactMeta({ styleId: stylePreset.id, edge: phys.edge, strength: sig.strength || 'strong' })
    setImpactSeq((n) => n + 1)
    setImpactEdge('')
    const t1 = requestAnimationFrame(() => setImpactEdge(phys.edge))
    const t2 = setTimeout(() => setImpactEdge(''), 640)
    return () => {
      cancelAnimationFrame(t1)
      clearTimeout(t2)
    }
  }, [ui.impactSignal, settings.motion, settings.impactStyle])

  // R28 全视口精确点击坐标引擎（零左栏截断、穿透弹窗）+ 动态镜面高光追踪
  const handleShellPointerDown = (e) => {
    if (settings.motion === 'reduced' || e.button !== 0) return
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
    const { nx, ny } = computeViewportCoords(e.clientX, e.clientY, vw, vh)
    lastPointerRef.current = { nx, ny, at: Date.now() }
    const hitInteractive = e.target && typeof e.target.closest === 'function'
      && e.target.closest('button, a, .chat-quick-card, .mk-card, .et-team-card, .ss-item, .sd-source, .st-btn, .gs-trigger, .mp-trigger')
    if (hitInteractive && !e.target.closest('.cp-root, .gsb-layer')) {
      applyLocalGlassPress(hitInteractive, e.clientX, e.clientY, settings.motion)
      if (!e.target.closest('.st-hit-pad')) {
        fireShellImpact('pointer', 'light', { nx, ny, pointer: true })
      }
    }
  }
  const handleShellPointerMove = (e) => {
    if (settings.motion === 'reduced' || !shellRef.current || glintRafRef.current) return
    const cx = e.clientX, cy = e.clientY
    glintRafRef.current = requestAnimationFrame(() => {
      glintRafRef.current = 0
      if (!shellRef.current) return
      shellRef.current.style.setProperty('--glint-x', `${cx}px`)
      shellRef.current.style.setProperty('--glint-y', `${cy}px`)
    })
  }

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
    {
      id: 'tb-companion',
      icon: '🐾',
      label: '唤出 3D 娱乐协助助手',
      onClick: () => setCompanionSummonSeq((n) => n + 1),
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
    { section: '液态玻璃撞击特效' },
    ...IMPACT_STYLES.map((st) => ({
      id: `ap-imp-${st.id}`,
      label: st.label,
      hint: st.id === 'random' ? '自动变奏' : '',
      active: (settings.impactStyle || 'mercury') === st.id,
      onClick: () => {
        updateVisualSettings({ impactStyle: st.id })
        fireShellImpact('left', 'strong')
      },
    })),
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
    <div ref={shellRef} className="hb-shell" data-zen={String(!!ui.zenMode)} onPointerDownCapture={handleShellPointerDown} onPointerMove={handleShellPointerMove}>
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
              aria-expanded={String(moreNavOpen)}
              data-active={String(secondaryActive)}
              onClick={() => setMoreNavOpen((v) => !v)}
            >
              <NavIcon name="more" />
              <span className="hb-rail-label">更多功能</span>
              <span className="hb-rail-chev" data-open={String(moreNavOpen)}>
                <NavIcon name="chevron" />
              </span>
            </button>
            {moreNavOpen && (
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
        {impactEdge && settings.motion !== 'reduced' && (
          <div key={impactSeq} className="hb-liquid-impact" data-edge={impactEdge} data-style={activeImpactMeta.styleId} aria-hidden="true">
            <span className="hb-lg-meniscus" />
            <span className="hb-lg-ripple-1" />
            <span className="hb-lg-ripple-2" />
            <span className="hb-lg-sheen" />
          </div>
        )}

        <header ref={topbarRef} className="hb-topbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <button type="button" className="hb-top-btn hb-icon-btn" onClick={toggleSidebar} title={ui.sidebarOpen ? '收起侧边栏' : '展开侧边栏'} aria-label={ui.sidebarOpen ? '收起侧边栏' : '展开侧边栏'}>
              <NavIcon name="sidebar" />
            </button>
            <ModelPicker
              align="left"
              direction="down"
              ariaLabel="快速切换保存的模型"
              value={(currentSession && currentSession.modelProfileId) || ''}
              defaultModel={globalModel}
              models={savedModels}
              onChange={(id) => {
                if (currentSession) setSessionModelOverride(currentSession.id, id)
                else if (id) activateSavedModelGlobal(id)
              }}
              onOpenVault={(e) => openModal('settings', captureTriggerRect(e))}
              renderTrigger={({ open, toggle }) => (
                <button
                  type="button"
                  className="hb-island"
                  onClick={toggle}
                  aria-expanded={String(open)}
                  title="点击快捷切换当前会话或全局保存的模型"
                >
                  {/* r28 这里引用了两个**从未定义**的变量（islandDotState / islandText），
                      且用了 CSS 里不存在的 data-state —— 整个应用一渲染就
                      ReferenceError: islandDotState is not defined，外壳挂不上。
                      恢复为与 AppShell.css（[data-busy="true"]）和 e2e（断言灵岛文本含模型名）一致的写法。 */}
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
      <GlassSandboxOverlay
        storeRef={sandboxStoreRef}
        motionTier={settings.motion}
        onGlassImpact={(ev) => fireShellImpact(ev.edge || 'pointer', ev.strength || 'medium', { nx: ev.nx, ny: ev.ny, pointer: true })}
        onBlockShattered={() => setShatterSignal((n) => n + 1)}
        onStateSync={() => setSandboxRefresh((n) => n + 1)}
      />
      <LiquidImpactCanvas
        seq={impactSeq}
        nx={impactPos.nx}
        ny={impactPos.ny}
        styleId={activeImpactMeta.styleId}
        strength={activeImpactMeta.strength}
        motionTier={settings.motion}
        theme={settings.theme}
      />
      <CompanionOverlay
        sandboxStoreRef={sandboxStoreRef}
        shatterSignal={shatterSignal}
        forceOpenSignal={companionSummonSeq}
        onForceRefreshSandbox={() => setSandboxRefresh((n) => n + 1)}
      />
    </div>
  )
}
