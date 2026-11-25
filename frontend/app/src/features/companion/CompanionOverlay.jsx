import { useEffect, useRef, useState } from 'react'
import {
  useSlice,
  getState,
  subscribe,
  setActivePanel,
  openModal,
  closeModal,
  setComposerDraft,
  addComposerToken,
  enqueueOrSendChat,
  startExpertTeamRun,
  stopExpertTeamRun,
  selectWorkflow,
  runActiveWorkflow,
  stopWorkflowRun,
  runGroupRelay,
  abortGroupRelay,
  startCollaborationRun,
  stopCollaborationRun,
  setDockPreview,
  fireShellImpact,
  pushToast,
} from '../../state/store.js'
import {
  COMPANION_PERSONALITIES,
  COMPANION_SNACKS,
  getActiveModelPack,
  loadCompanionAvatar,
  saveCompanionAvatar,
  loadCompanionConfig,
  saveCompanionConfig,
  loadCompanionStats,
  saveCompanionStats,
  affectionLevel,
} from '../../services/companionCatalog.js'
import { askCompanionBrain } from '../../services/companionBrain.js'
import {
  planAutopilotExecution,
  evaluateDeliverableQuality,
} from '../../services/companionAutopilot.js'
import { pickNextAutonomousBehavior } from '../../services/companionLife.js'
import { buildAvailableTeams } from '../../services/expertTeam.js'
import {
  biteGlassBody,
  startRepairBody,
  setRepairProgress,
} from '../../platform/glassSandboxEngine.js'
import {
  collectVisibleGlassBlocks,
  findUiControlByHint,
  triggerUiControlClick,
  focusComposerInput,
  setGlassSourceVisibility,
  copyText,
} from '../../platform/dom.js'
import { desktopBridge } from '../../platform/libs.js'
import { computeViewportCoords } from '../../platform/kinetic.js'
import YaluModelStage from '../../ui/YaluModelStage.jsx'
import CompanionCustomizer from './CompanionCustomizer.jsx'
import './CompanionOverlay.css'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitForStoreCondition(predicate, timeoutMs = 45000, cancelRef = null) {
  return new Promise((resolve) => {
    try {
      const immediate = predicate(getState())
      if (immediate) { resolve(immediate); return }
    } catch {}
    let done = false
    let unsub = null
    const finish = (val) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearInterval(cancelPoll)
      if (typeof unsub === 'function') unsub()
      resolve(val)
    }
    const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs)
    const cancelPoll = setInterval(() => {
      if (cancelRef && cancelRef.current) finish({ cancelled: true })
    }, 180)
    unsub = subscribe(() => {
      try {
        const hit = predicate(getState())
        if (hit) finish(hit)
      } catch {}
    })
  })
}

function pickExpressionUrl(pack, actionState, override = 'auto') {
  const exprs = (pack && pack.assets && pack.assets.expressions) || []
  if (!exprs.length) return ''
  if (override && override !== 'auto') {
    const found = exprs.find((e) => e.id === override)
    if (found) return found.src
  }
  if (actionState === 'supervising' || actionState === 'write_input' || actionState === 'crouch_click') return (exprs[1] || exprs[0]).src
  if (actionState === 'grabbed' || actionState === 'thrown' || actionState === 'guilty' || actionState === 'poke') return (exprs[2] || exprs[0]).src
  if (actionState === 'deliver' || actionState === 'dance' || actionState === 'happy' || actionState === 'bell_play') return (exprs[3] || exprs[0]).src
  return exprs[0].src
}

export default function CompanionOverlay({
  sandboxStoreRef,
  shatterSignal = 0,
  forceOpenSignal = 0,
  onForceRefreshSandbox,
}) {
  const settings = useSlice('settings')
  const [avatar, setAvatar] = useState(() => loadCompanionAvatar())
  const [config, setConfig] = useState(() => loadCompanionConfig())
  const [stats, setStats] = useState(() => loadCompanionStats())
  const [pos, setPos] = useState(() => ({
    x: Math.max(120, ((typeof window !== 'undefined' && window.innerWidth) || 1280) - 166),
    y: Math.max(120, ((typeof window !== 'undefined' && window.innerHeight) || 800) - 210),
  }))
  const [facing, setFacing] = useState(-1)
  const [look, setLook] = useState({ x: 0, y: 0 })
  const [dragTilt, setDragTilt] = useState(0)
  const [isDraggingPet, setIsDraggingPet] = useState(false)
  const [roamingDesktop, setRoamingDesktop] = useState(false)
  const [actionState, setActionState] = useState('idle')
  const [speech, setSpeech] = useState('')
  const [chatOpen, setChatOpen] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [snackBarOpen, setSnackBarOpen] = useState(false)
  const [autopilotHud, setAutopilotHud] = useState(null)
  const [messages, setMessages] = useState(() => {
    const p = COMPANION_PERSONALITIES.find((x) => x.id === loadCompanionAvatar().personality) || COMPANION_PERSONALITIES[0]
    return [{ id: 'm0', role: 'assistant', text: p.greeting, engine: 'local' }]
  })
  const [ctxMenu, setCtxMenu] = useState(null)
  const [customizer, setCustomizer] = useState({ open: false, tab: 'avatar' })
  const [flyingOrb, setFlyingOrb] = useState(null)

  const posRef = useRef(pos)
  posRef.current = pos
  const busyTaskRef = useRef(false)
  const autopilotCancelRef = useRef(false)
  const speechTimerRef = useRef(0)
  const flingRafRef = useRef(0)
  const petDragRef = useRef(null)
  const suppressClickRef = useRef(false)
  const lastInteractAtRef = useRef(Date.now())
  const lastDesktopReturnAtRef = useRef(0)

  const pack = getActiveModelPack(avatar.modelPackId)
  const packAssets = {
    front: pack.assets.front,
    side: pack.assets.side,
    back: pack.assets.back,
    animIdleStrip: pack.assets.animIdleStrip,
    animActionStrip: pack.assets.animActionStrip,
    animFrames: pack.assets.animFrames,
    showcaseVideo: pack.assets.showcaseVideo,
  }

  const say = (text, ms = 3600) => {
    if (!text) return
    setSpeech(text)
    if (speechTimerRef.current) clearTimeout(speechTimerRef.current)
    speechTimerRef.current = setTimeout(() => setSpeech(''), ms)
  }

  const bumpStats = (delta = {}) => {
    setStats((prev) => saveCompanionStats({
      ...prev,
      affection: (prev.affection || 0) + (delta.affection || 0),
      energy: Math.max(0, Math.min(100, (prev.energy ?? 88) + (delta.energy || 0))),
      tasksDelivered: (prev.tasksDelivered || 0) + (delta.tasksDelivered || 0),
      snacksEaten: (prev.snacksEaten || 0) + (delta.snacksEaten || 0),
      headPats: (prev.headPats || 0) + (delta.headPats || 0),
      ...(delta.mood ? { mood: delta.mood } : {}),
    }))
  }

  // 自然跨窗走出到真实系统桌面（可由芽露自主漫步触发，也可由用户直接把她拖出/甩出窗外触发）
  const stepOutToDesktop = async (relX = null, relY = null, vx = 0, vy = 0, quip = '') => {
    const desk = desktopBridge()
    if (!desk || typeof desk.getDesktopMetrics !== 'function' || typeof desk.syncDesktopStage !== 'function') {
      return false
    }
    try {
      const m = await desk.getDesktopMetrics()
      const wb = (m && m.winBounds) || { x: 100, y: 100, width: 1320, height: 840 }
      const db = (m && m.displayBounds) || { x: 0, y: 0, width: 1920, height: 1080 }
      const rx = relX != null ? relX : (posRef.current.x > wb.width * 0.5 ? wb.width + 24 : -136)
      const ry = relY != null ? relY : posRef.current.y
      const deskX = Math.max(db.x + 16, Math.min(db.x + db.width - 144, wb.x + rx))
      const deskY = Math.max(db.y + 16, Math.min(db.y + db.height - 210, wb.y + ry))
      setRoamingDesktop(true)
      setChatOpen(false)
      setCtxMenu(null)
      desk.syncDesktopStage({
        pet: {
          active: true,
          roaming: true,
          autoReturnSec: 20,
          name: avatar.name || '芽露',
          x: deskX,
          y: deskY,
          vx,
          vy,
          facing: vx >= 0 ? 1 : -1,
          speech: quip || '叮铃～外面的桌面好宽敞，芽露逛一圈就回来 🌿',
        },
      })
      return true
    } catch {
      return false
    }
  }

  const returnFromDesktop = (relX = null, relY = null) => {
    const desk = desktopBridge()
    if (desk && typeof desk.syncDesktopStage === 'function') {
      desk.syncDesktopStage({ hidePet: true })
    }
    lastDesktopReturnAtRef.current = Date.now()
    setRoamingDesktop(false)
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
    setPos({
      x: relX != null ? Math.max(12, Math.min(vw - 148, relX)) : Math.max(120, vw - 166),
      y: relY != null ? Math.max(16, Math.min(vh - 196, relY)) : Math.max(120, vh - 210),
    })
    setActionState('happy')
    say('叮铃～外面逛完回来啦 🌿', 2800)
    setTimeout(() => { if (!busyTaskRef.current) setActionState('idle') }, 750)
  }

  useEffect(() => {
    const desk = desktopBridge()
    if (!desk || typeof desk.onDesktopStageEvent !== 'function') return undefined
    return desk.onDesktopStageEvent((ev) => {
      if (ev && ev.type === 'pet_return') {
        returnFromDesktop(ev.relX, ev.relY)
      }
    })
  }, [])

  useEffect(() => {
    if (forceOpenSignal > 0) {
      const next = saveCompanionConfig({ ...config, visible: true })
      setConfig(next)
      if (roamingDesktop) returnFromDesktop()
      else say('叮铃铃～芽露回来啦 🌿', 2600)
    }
  }, [forceOpenSignal])

  // 视线追踪与右键菜单外部关闭
  useEffect(() => {
    if (!config.visible) return undefined
    const onMove = (e) => {
      const cur = posRef.current
      const dx = e.clientX - (cur.x + 68)
      const dy = e.clientY - (cur.y + 84)
      setLook({
        x: Math.max(-1, Math.min(1, dx / 360)),
        y: Math.max(-1, Math.min(1, dy / 280)),
      })
    }
    const onDown = (e) => {
      if (e.target && typeof e.target.closest === 'function' && e.target.closest('.cp-ctx')) return
      setCtxMenu(null)
    }
    globalThis.addEventListener('pointermove', onMove, { passive: true })
    globalThis.addEventListener('pointerdown', onDown)
    return () => {
      globalThis.removeEventListener('pointermove', onMove)
      globalThis.removeEventListener('pointerdown', onDown)
      if (flingRafRef.current) cancelAnimationFrame(flingRafRef.current)
    }
  }, [config.visible])

  const walkTo = async (tx, ty, runState = 'run', durationMs = 740) => {
    const start = { ...posRef.current }
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
    const destX = Math.max(8, Math.min(vw - 140, tx - 64))
    const destY = Math.max(16, Math.min(vh - 190, ty - 110))
    setFacing(destX >= start.x ? 1 : -1)
    setActionState(runState)
    const steps = Math.max(12, Math.round(durationMs / 24))
    for (let i = 1; i <= steps; i++) {
      const u = i / steps
      const ease = 1 - Math.pow(1 - u, 2.2)
      setPos({ x: start.x + (destX - start.x) * ease, y: start.y + (destY - start.y) * ease })
      await sleep(Math.round(durationMs / steps))
    }
  }

  const returnToCorner = async () => {
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
    await walkTo(vw - 96, vh - 96, 'run', 640)
    setFacing(-1)
    setActionState('idle')
  }

  // ============================================================================
  // 核心：芽露自带的「自主活体生命循环」（无需任何菜单，自然散步/坐边/伸懒腰/敲铃铛/走出桌面！）
  // ============================================================================
  useEffect(() => {
    if (!config.visible || config.autonomousLifeEnabled === false || settings.motion === 'reduced') return undefined
    let cancelled = false
    let timer = 0

    const scheduleNext = () => {
      const waitMs = 11000 + Math.round(Math.random() * 8000)
      timer = setTimeout(async () => {
        if (cancelled) return
        if (busyTaskRef.current || chatOpen || customizer.open || isDraggingPet || roamingDesktop) {
          scheduleNext()
          return
        }
        const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
        const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
        const desk = desktopBridge()
        const canVentureDesktop = Boolean(desk && typeof desk.syncDesktopStage === 'function')
        const store = sandboxStoreRef && sandboxStoreRef.current
        const candidates = store ? collectVisibleGlassBlocks().filter((c) => !store.bodies.has(c.id)) : []
        const idleSec = (Date.now() - lastInteractAtRef.current) / 1000
        const recentlyBack = (Date.now() - lastDesktopReturnAtRef.current) < 48000

        const act = pickNextAutonomousBehavior({
          pos: posRef.current,
          vw,
          vh,
          energy: stats.energy,
          idleSeconds: idleSec,
          canVentureDesktop,
          recentlyReturnedFromDesktop: recentlyBack,
          sneakEatEnabled: config.sneakEatEnabled !== false,
          hasGlassCandidates: candidates.length > 0,
        })

        busyTaskRef.current = true
        try {
          if (act.type === 'stroll') {
            await walkTo(act.targetX, act.targetY, 'run', 860)
            setActionState('idle')
          } else if (act.type === 'sit_edge') {
            await walkTo(act.targetX, act.targetY, 'run', 820)
            setActionState('sit_edge')
            await sleep(act.durationMs || 4200)
            if (!cancelled) setActionState('idle')
          } else if (act.type === 'stretch' || act.type === 'bell_play') {
            setActionState(act.type)
            if (act.quip) say(act.quip, 2600)
            await sleep(act.durationMs || 2400)
            if (!cancelled) setActionState('idle')
          } else if (act.type === 'sleep') {
            setActionState('sleep')
            if (act.quip) say(act.quip, 3200)
            bumpStats({ energy: 14, mood: '小憩充电' })
            await sleep(act.durationMs || 6000)
            if (!cancelled) setActionState('idle')
          } else if (act.type === 'venture_desktop') {
            await walkTo(act.edgeX, act.edgeY, 'run', 880)
            setFacing(act.exitSide === 'left' ? -1 : 1)
            setActionState('peek_edge')
            if (act.quip) say(act.quip, 2600)
            await sleep(880)
            if (!cancelled && !chatOpen && !customizer.open) {
              const exitRelX = act.exitSide === 'left' ? -120 : vw + 18
              await stepOutToDesktop(exitRelX, posRef.current.y, act.exitSide === 'left' ? -90 : 90, 0, act.quip)
            }
          } else if (act.type === 'sneak_eat' && store && candidates.length > 0) {
            const pick = candidates[Math.floor(Math.random() * candidates.length)]
            say(`肚子咕噜噜…「${pick.label}」看起来好脆好好吃！`, 2600)
            await walkTo(pick.x + pick.w / 2 + 24, pick.y + pick.h / 2 + 12, 'run', 800)
            setActionState('sneak_eat')
            await sleep(820)
            biteGlassBody(store, pick)
            bumpStats({ energy: 12, mood: '偷吃得逞' })
            if (typeof onForceRefreshSandbox === 'function') onForceRefreshSandbox()
            setActionState('guilty')
            say(`啊呜！偷偷啃了一口「${pick.label}」（点我让我修补哦～）`, 3800)
            await sleep(820)
            await returnToCorner()
          }
        } finally {
          busyTaskRef.current = false
        }
        if (!cancelled) scheduleNext()
      }, waitMs)
    }

    scheduleNext()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [config.visible, config.autonomousLifeEnabled, config.sneakEatEnabled, settings.motion, chatOpen, customizer.open, isDraggingPet, roamingDesktop, stats.energy])

  // 拎起拖动 + 抛物线物理（跨出窗口边自然走向真实桌面！）
  const startFlingPhysics = (vx0, vy0) => {
    if (flingRafRef.current) cancelAnimationFrame(flingRafRef.current)
    const vw0 = (typeof window !== 'undefined' && window.innerWidth) || 1280
    const vh0 = (typeof window !== 'undefined' && window.innerHeight) || 800
    const desk = desktopBridge()
    const canRoamDesktop = Boolean(desk && typeof desk.syncDesktopStage === 'function')

    let x = posRef.current.x
    let y = posRef.current.y
    if (canRoamDesktop && (x < -28 || x > vw0 - 98 || y < -24 || y > vh0 - 110)) {
      setDragTilt(0)
      stepOutToDesktop(x, y, vx0 * 0.45, vy0 * 0.45, '叮铃～到外面的桌面啦，我先四处逛逛 🌿')
      return
    }

    let vx = Math.max(-1450, Math.min(1450, vx0))
    let vy = Math.max(-1450, Math.min(1450, vy0))
    const speed0 = Math.hypot(vx, vy)
    if (speed0 < 160) {
      setDragTilt(0)
      setActionState('happy')
      say('安全着陆～我就先在这儿陪着你啦 🌿', 2200)
      setTimeout(() => { if (!busyTaskRef.current) setActionState('idle') }, 500)
      return
    }
    setActionState('thrown')
    say('哇啊啊起飞啦——腰间铃铛要响翻天啦 🔔', 2200)
    let lastT = performance.now()
    let bounces = 0

    const tick = (now) => {
      const dt = Math.min(0.032, Math.max(0.008, (now - lastT) / 1000))
      lastT = now
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
      const maxX = Math.max(20, vw - 134)
      const maxY = Math.max(24, vh - 186)

      vy += 1500 * dt
      x += vx * dt
      y += vy * dt
      vx *= 0.992

      if (canRoamDesktop && ((x < 2 && vx < -520) || (x > maxX && vx > 520) || (y < 6 && vy < -520))) {
        flingRafRef.current = 0
        setDragTilt(0)
        stepOutToDesktop(x, y, vx * 0.72, vy * 0.72, '飞到窗口外面的桌面啦～✨')
        return
      }

      let hitWall = false
      let hitSide = 'bottom'
      if (x < 6) { x = 6; vx = Math.abs(vx) * 0.62; hitWall = true; hitSide = 'left' }
      else if (x > maxX) { x = maxX; vx = -Math.abs(vx) * 0.62; hitWall = true; hitSide = 'right' }
      if (y < 12) { y = 12; vy = Math.abs(vy) * 0.56; hitWall = true; hitSide = 'top' }
      else if (y > maxY) { y = maxY; vy = -Math.abs(vy) * 0.46; vx *= 0.78; hitWall = true; hitSide = 'bottom' }

      if (hitWall && Math.hypot(vx, vy) > 130) {
        bounces += 1
        const vp = computeViewportCoords(x + 68, y + 92, vw, vh)
        fireShellImpact(hitSide, bounces === 1 ? 'strong' : 'medium', { nx: vp.nx, ny: vp.ny, pointer: true })
      }

      setPos({ x, y })
      setFacing(vx >= 0 ? 1 : -1)
      setDragTilt(Math.max(-0.42, Math.min(0.42, vx / 900)))

      const settled = y >= maxY - 2 && Math.abs(vy) < 75 && Math.abs(vx) < 42
      if (settled || bounces > 5) {
        flingRafRef.current = 0
        setDragTilt(0)
        setActionState('happy')
        say('咚！稳稳落地～', 2200)
        setTimeout(() => { if (!busyTaskRef.current) setActionState('idle') }, 650)
        return
      }
      flingRafRef.current = requestAnimationFrame(tick)
    }
    flingRafRef.current = requestAnimationFrame(tick)
  }

  const handleActorPointerDown = (e) => {
    if (e.button !== 0) return
    e.stopPropagation()
    lastInteractAtRef.current = Date.now()
    if (flingRafRef.current) {
      cancelAnimationFrame(flingRafRef.current)
      flingRafRef.current = 0
    }
    const startX = e.clientX
    const startY = e.clientY
    const originX = posRef.current.x
    const originY = posRef.current.y

    petDragRef.current = {
      startX, startY, originX, originY,
      dragging: false,
      samples: [{ x: startX, y: startY, t: performance.now() }],
    }

    const onMove = (ev) => {
      const d = petDragRef.current
      if (!d) return
      const dist = Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY)
      if (!d.dragging && dist > 6) {
        d.dragging = true
        suppressClickRef.current = true
        setIsDraggingPet(true)
        setCtxMenu(null)
        setActionState('grabbed')
        say('咿呀！别拎着我晃呀～', 2000)
      }
      if (!d.dragging) return
      const now = performance.now()
      d.samples.push({ x: ev.clientX, y: ev.clientY, t: now })
      while (d.samples.length > 6 && (now - d.samples[0].t) > 90) d.samples.shift()
      const first = d.samples[0]
      const dtS = Math.max(0.012, (now - first.t) / 1000)
      const vx = (ev.clientX - first.x) / dtS
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
      const nx = Math.max(-56, Math.min(vw - 72, d.originX + (ev.clientX - d.startX)))
      const ny = Math.max(-44, Math.min(vh - 96, d.originY + (ev.clientY - d.startY)))
      setPos({ x: nx, y: ny })
      if (Math.abs(vx) > 40) setFacing(vx > 0 ? 1 : -1)
      setDragTilt(Math.max(-0.44, Math.min(0.44, -vx / 1100)))
    }

    const onUp = () => {
      globalThis.removeEventListener('pointermove', onMove)
      globalThis.removeEventListener('pointerup', onUp)
      globalThis.removeEventListener('pointercancel', onUp)
      const d = petDragRef.current
      petDragRef.current = null
      setIsDraggingPet(false)
      if (!d || !d.dragging) return
      const now = performance.now()
      const recent = d.samples.filter((s) => (now - s.t) <= 105)
      const a = recent[0] || d.samples[0]
      const b = recent[recent.length - 1] || d.samples[d.samples.length - 1]
      const dtS = Math.max(0.016, (b.t - a.t) / 1000)
      const vx = recent.length >= 2 ? (b.x - a.x) / dtS : 0
      const vy = recent.length >= 2 ? (b.y - a.y) / dtS : 0
      startFlingPhysics(vx, vy)
      setTimeout(() => { suppressClickRef.current = false }, 80)
    }

    globalThis.addEventListener('pointermove', onMove)
    globalThis.addEventListener('pointerup', onUp)
    globalThis.addEventListener('pointercancel', onUp)
  }

  const performFeedSnack = async (snack) => {
    if (!snack) return
    lastInteractAtRef.current = Date.now()
    setSnackBarOpen(false)
    setActionState('happy')
    say(`${snack.icon} ${snack.quote}`, 3400)
    bumpStats({ energy: snack.energy, affection: snack.affection, snacksEaten: 1, mood: '超满足' })
    await sleep(950)
    setActionState('idle')
  }

  const abortCurrentAutopilot = () => {
    autopilotCancelRef.current = true
    try { stopExpertTeamRun() } catch {}
    try { stopWorkflowRun() } catch {}
    try { stopCollaborationRun() } catch {}
    try { abortGroupRelay() } catch {}
    setAutopilotHud(null)
    setActionState('idle')
    say('已按你的指示停止本次监工任务～', 2400)
  }

  // 全自动无人驾驶总管：直切多专家团 Tab + 实时成员进度 + 自动收起交稿
  const performAutopilot = async (requirement) => {
    const req = String(requirement || '').trim()
    if (!req) return
    lastInteractAtRef.current = Date.now()
    if (roamingDesktop) returnFromDesktop()
    autopilotCancelRef.current = false
    const st0 = getState()
    const workflows = (st0.plugins && st0.plugins.workflows) || []
    const teams = buildAvailableTeams((st0.market && st0.market.experts) || [])

    setActionState('supervising')
    setAutopilotHud({
      title: '芽露正在全盘评估最佳执行方案…',
      moduleLabel: '全域智能路由器',
      stepText: '扫描 56 专家 · 60 Skill · 12 原生团 · DAG 工作流',
      pct: 14,
      running: true,
    })

    const plan = await planAutopilotExecution({
      requirement: req,
      workflows,
      teams,
      config,
      endpointConfig: resolveCompanionEndpoint(),
    })

    if (autopilotCancelRef.current) {
      setAutopilotHud(null)
      setActionState('idle')
      return
    }

    const planMsg = [
      `🧭 **芽露无人驾驶路由决策完成**（${plan.plannedBy === 'llm-supervisor' ? '专属大模型总管' : '本地极速总管'}）`,
      `• **选用模块**：${plan.moduleLabel}`,
      plan.team ? `• **派出原生专家团**：${plan.team.name}（${1 + plan.team.members.length} 人）` : null,
      plan.workflow ? `• **选用工作流**：${plan.workflow.name}` : null,
      plan.mode === 'chat' && plan.expert ? `• **自动挂载专家**：${plan.expert.name}` : null,
      plan.mode === 'chat' && plan.skill ? `• **自动挂载 Skill**：${plan.skill.name}` : null,
      `• **决策依据**：${plan.reason}`,
    ].filter(Boolean).join('\n')

    setMessages((prev) => [...prev.slice(-16), { id: `ap_plan_${Date.now()}`, role: 'assistant', text: planMsg, engine: 'autopilot' }])
    say(`已选定「${plan.moduleLabel}」，看我执露芽杖亲自操作监工！`, 3400)

    let deliverable = ''
    let execError = ''

    try {
      setAutopilotHud({
        title: plan.moduleLabel,
        moduleLabel: plan.team ? plan.team.name : (plan.workflow ? plan.workflow.name : (plan.expert ? plan.expert.name : 'Harbor')),
        stepText: plan.steps[0] || '正在切入目标模块…',
        pct: 28,
        running: true,
      })

      const navHit = findUiControlByHint(plan.navTarget)
      if (navHit) {
        await walkTo(navHit.cx + 30, navHit.cy + 14, 'run', 560)
        setActionState('crouch_click')
        await sleep(180)
      }

      if (plan.mode === 'workflow' && plan.workflow) {
        setActivePanel('workflow')
        selectWorkflow(plan.workflow.id)
        await sleep(140)
        setActionState('supervising')
        setAutopilotHud({
          title: `监工工作流：${plan.workflow.name}`,
          moduleLabel: 'DAG 流水线',
          stepText: '已注入任务目标并启动并行 DAG，正在实时监工各节点…',
          pct: 62,
          running: true,
        })
        await runActiveWorkflow({ workflowId: plan.workflow.id, input: req })
        const afterWf = getState().plugins && getState().plugins.runByWfId && getState().plugins.runByWfId[plan.workflow.id]
        const outputs = afterWf && afterWf.nodeStates
          ? Object.values(afterWf.nodeStates).map((ns) => ns && ns.output).filter(Boolean)
          : []
        deliverable = outputs.length ? outputs[outputs.length - 1] : ''
      } else if (plan.mode === 'expert_team' && plan.team) {
        openModal('market', null, { marketTab: 'team', marketTeamId: plan.team.id })
        await sleep(160)
        setActionState('supervising')
        const totalSteps = Math.max(2, (plan.team.members || []).length + 1)
        const unsubTeam = subscribe(() => {
          const et = getState().expertTeam
          if (!et) return
          const tl = et.timeline || []
          const latest = tl[tl.length - 1]
          const doneCnt = (et.completedMembers || []).length
          const pct = Math.min(92, Math.round(35 + (doneCnt / totalSteps) * 55))
          if (latest && latest.label) {
            setAutopilotHud({
              title: `监工原生团：${plan.team.name}`,
              moduleLabel: `${doneCnt}/${(plan.team.members || []).length} 成员已交接`,
              stepText: latest.label,
              pct,
              running: true,
            })
            say(latest.label.slice(0, 42), 2400)
          }
        })
        try {
          setAutopilotHud({
            title: `监工原生团：${plan.team.name}`,
            moduleLabel: `${1 + plan.team.members.length} 人成建制团队`,
            stepText: `已切入「多专家团队」并启动 ${plan.team.members.map((m) => m.name).join(' → ')} 接力…`,
            pct: 36,
            running: true,
          })
          const teamRes = await startExpertTeamRun({
            goal: req,
            lead: plan.team.lead,
            members: plan.team.members,
            useRecovery: false,
          })
          deliverable = String((teamRes && teamRes.finalReport) || (getState().expertTeam && getState().expertTeam.finalReport) || '')
          if (teamRes && !teamRes.ok && teamRes.error) execError = teamRes.error
        } finally {
          if (typeof unsubTeam === 'function') unsubTeam()
        }
        if (!autopilotCancelRef.current && deliverable) {
          closeModal('left', true)
        }
      } else if (plan.mode === 'group') {
        setActivePanel('group')
        await sleep(140)
        setActionState('supervising')
        setAutopilotHud({
          title: '监工多角色群聊接力',
          moduleLabel: '主持人动态调度',
          stepText: '已发起群聊接力，正在实时监工各角色发言汇总…',
          pct: 62,
          running: true,
        })
        await runGroupRelay(req)
        const gMsgs = (getState().group && getState().group.messages) || []
        const latestAsst = [...gMsgs].reverse().find((m) => m && m.role !== 'user' && m.content)
        deliverable = latestAsst ? String(latestAsst.content) : ''
      } else if (plan.mode === 'collaboration') {
        setActivePanel('collaboration')
        await sleep(140)
        setActionState('supervising')
        setAutopilotHud({
          title: '监工双模协同闭环',
          moduleLabel: '云端规划 + 本地执行',
          stepText: '正在监管脱敏规划、执行与多轮评审…',
          pct: 64,
          running: true,
        })
        await startCollaborationRun(req)
        const cState = getState().collaboration || {}
        deliverable = String(cState.finalOutput || cState.reviewSummary || cState.workerOutput || '')
      } else {
        setActivePanel('chat')
        await sleep(140)
        if (plan.expert) addComposerToken({ id: plan.expert.id, name: plan.expert.name, kind: 'agent', prompt: plan.expert.prompt })
        if (plan.skill) addComposerToken({ id: plan.skill.id, name: `Skill · ${plan.skill.name}`, kind: 'skill', prompt: plan.skill.prompt })
        const compHit = focusComposerInput()
        if (compHit) await walkTo(compHit.x + 120, compHit.y + 10, 'run', 500)
        setActionState('write_input')
        setAutopilotHud({
          title: '芽露正在执杖手写并派单',
          moduleLabel: `${plan.expert ? plan.expert.name : '智能对话'}`,
          stepText: '已自动装载最佳专家与 Skill，正在写入任务并启动运行…',
          pct: 48,
          running: true,
        })
        setComposerDraft(req)
        await sleep(180)
        const sid = getState().sessions.currentId
        const beforeLen = ((getState().sessions.items.find((s) => s.id === sid) || {}).messages || []).length
        enqueueOrSendChat(req)
        setActionState('supervising')
        setAutopilotHud({
          title: '监工智能对话执行中…',
          moduleLabel: `${plan.expert ? plan.expert.name : '智能对话'}`,
          stepText: '正在实时跟踪思考流、联网/工具调用与正文生成…',
          pct: 72,
          running: true,
        })
        const waitRes = await waitForStoreCondition((st) => {
          const run = st.runtime && st.runtime.runsBySid && st.runtime.runsBySid[sid]
          const sess = st.sessions.items.find((s) => s.id === sid)
          const msgs = (sess && sess.messages) || []
          if (msgs.length > beforeLen && msgs[msgs.length - 1].role === 'assistant' && (!run || run.phase === 'done' || run.phase === 'idle')) {
            return { ok: true, text: msgs[msgs.length - 1].content }
          }
          if (run && run.error) return { ok: false, error: run.error }
          return null
        }, 45000, autopilotCancelRef)
        if (waitRes && waitRes.error) execError = waitRes.error
        const sessNow = getState().sessions.items.find((s) => s.id === sid)
        const lastAsst = [...((sessNow && sessNow.messages) || [])].reverse().find((m) => m.role === 'assistant')
        deliverable = lastAsst ? String(lastAsst.content || '') : ''
      }

      if (autopilotCancelRef.current) return

      const qa = evaluateDeliverableQuality(deliverable, req)
      setAutopilotHud({
        title: qa.ok ? `🔔 芽露交稿完成 · ${qa.grade}` : '执行未获得有效正文',
        moduleLabel: plan.moduleLabel,
        stepText: qa.ok ? `质检 ${qa.score} 分 · ${qa.charCount} 字，已自动推送至右侧副屏` : (execError || qa.summary),
        pct: 100,
        running: false,
      })

      if (qa.ok && deliverable) {
        setDockPreview(`# 🌿 芽露全自动监工交付终稿\n\n> **原始需求**：${req}\n> **选用路线**：${plan.moduleLabel}\n> **验收评级**：${qa.grade}（${qa.score} 分 · ${qa.charCount} 字）\n\n---\n\n${deliverable}`)
        setActionState('deliver')
        bumpStats({ affection: 15, energy: -6, tasksDelivered: 1, mood: '圆满交稿' })
        say(`叮铃铃～交稿啦！${qa.grade}，终稿已经放进右侧副屏咯 🔔✨`, 4800)
        pushToast(`芽露已完成「${plan.moduleLabel}」全自动监工并交稿！`, 'ok')
      } else {
        setActionState('guilty')
        say(execError ? `呜…模型返回异常：${execError.slice(0, 32)}` : '这次没有拿到完整正文，请检查模型配置后重试～', 4200)
      }

      setMessages((prev) => [
        ...prev.slice(-16),
        {
          id: `ap_done_${Date.now()}`,
          role: 'assistant',
          text: `📦 **全自动监工交付验收单**\n${execError && !deliverable ? `错误详情：${execError}\n` : ''}${qa.summary}`,
          deliverable: deliverable || '',
          requirement: req,
          engine: 'autopilot',
        },
      ])
      await sleep(950)
      await returnToCorner()
    } catch (err) {
      setAutopilotHud(null)
      setActionState('guilty')
      const errTxt = String((err && err.message) || err)
      setMessages((prev) => [...prev.slice(-16), { id: `ap_err_${Date.now()}`, role: 'assistant', text: `执行遇到异常：${errTxt}`, engine: 'autopilot' }])
      say('执行遇到小故障，我先退回角落等你指示～', 3400)
    }
  }

  const performCrouchClick = async (targetHint, label = '') => {
    const hit = findUiControlByHint(targetHint)
    if (!hit) {
      if (['chat', 'group', 'workflow', 'workspace'].includes(targetHint)) setActivePanel(targetHint)
      setActionState('happy')
      say(`已为你切换到「${label || targetHint}」～`)
      await sleep(700)
      setActionState('idle')
      return
    }
    say(`哒哒哒～跑去帮你点「${label || targetHint}」！`)
    await walkTo(hit.cx + 28, hit.cy + 16, 'run', 620)
    setFacing(hit.cx >= posRef.current.x + 64 ? 1 : -1)
    setActionState('crouch_click')
    await sleep(260)
    triggerUiControlClick(targetHint)
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
    const vp = computeViewportCoords(hit.cx, hit.cy, vw, vh)
    fireShellImpact('pointer', 'medium', { nx: vp.nx, ny: vp.ny, pointer: true })
    await sleep(320)
    setActionState('happy')
    say(`点好啦！已为你打开「${label || targetHint}」✨`)
    await sleep(540)
    await returnToCorner()
  }

  const performWriteInput = async (textToWrite) => {
    setActivePanel('chat')
    await sleep(140)
    const hit = focusComposerInput()
    say('握好露芽杖，跑去输入框帮你手写～')
    if (hit) await walkTo(hit.x + 110, hit.y + 12, 'run', 620)
    setActionState('write_input')
    const full = String(textToWrite || '')
    const step = Math.max(1, Math.ceil(full.length / 22))
    let cur = ''
    for (let i = 0; i < full.length; i += step) {
      cur = full.slice(0, i + step)
      setComposerDraft(cur)
      await sleep(38)
    }
    setComposerDraft(full)
    setActionState('happy')
    say('手写完毕！按回车就能发出去咯 ✍️')
    await sleep(580)
    await returnToCorner()
  }

  const performBlackHoleMagic = async (fileName = '项目核心说明.md') => {
    setActivePanel('chat')
    setActionState('magic_blackhole')
    say(`露芽杖·微型黑洞展开！正在把「${fileName}」取出来…`, 4000)
    await sleep(820)
    const startX = posRef.current.x + (facing > 0 ? 105 : 22)
    const startY = posRef.current.y + 68
    const composerHit = findUiControlByHint('composer')
    const endX = composerHit ? composerHit.cx : Math.max(240, ((typeof window !== 'undefined' && window.innerWidth) || 1280) * 0.5)
    const endY = composerHit ? composerHit.cy : Math.max(300, ((typeof window !== 'undefined' && window.innerHeight) || 800) - 96)

    for (let i = 0; i <= 18; i++) {
      const u = i / 18
      const ease = 1 - Math.pow(1 - u, 2.5)
      const arc = Math.sin(u * Math.PI) * -58
      setFlyingOrb({ label: `📄 ${fileName}`, x: startX + (endX - startX) * ease, y: startY + (endY - startY) * ease + arc })
      await sleep(22)
    }
    setFlyingOrb(null)
    addComposerToken({
      id: `bh_${Date.now()}`,
      name: `黑洞文件 · ${fileName}`,
      kind: 'file',
      prompt: `【来自芽露黑洞传送的参考文件：${fileName}】请结合该文件上下文分析并响应用户需求。`,
    })
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
    const vp = computeViewportCoords(endX, endY, vw, vh)
    fireShellImpact('pointer', 'medium', { nx: vp.nx, ny: vp.ny, pointer: true })
    setActionState('happy')
    say(`搞定！「${fileName}」已放进聊天框啦 🌀`)
    pushToast(`芽露已通过黑洞魔法将「${fileName}」放入输入框`, 'ok')
    await sleep(680)
    setActionState('idle')
  }

  const performRepairAll = async (isAutoPassive = false) => {
    const store = sandboxStoreRef && sandboxStoreRef.current
    if (!store) return
    const damaged = Array.from(store.bodies.values()).filter(
      (b) => b.status === 'shattered' || b.biteNotches.length > 0 || b.cracks.length > 0
    )
    if (damaged.length === 0) return

    for (const b of damaged) {
      if (b.status === 'shattered') {
        say(isAutoPassive ? `哎呀「${b.label}」碎了一地！我拿露芽杖把碎片收回来修补～` : `正在跑去捡「${b.label}」的玻璃碎片…`)
        const firstShard = b.shards[0]
        if (firstShard) {
          await walkTo(firstShard.x, firstShard.y, 'run', 660)
          setActionState('collect_shards')
          for (const sh of b.shards) {
            sh.collected = true
            if (typeof onForceRefreshSandbox === 'function') onForceRefreshSandbox()
            await sleep(46)
          }
          say('碎片收好啦！跑回原位用露芽杖凝聚修补～')
        }
        await walkTo(b.origin.x + b.origin.w / 2 + 24, b.origin.y + b.origin.h / 2 + 12, 'collect_shards', 640)
      } else {
        say(`乖乖跑去把啃掉的「${b.label}」修补回亮晶晶的样子…`)
        await walkTo(b.x + b.w / 2 + 24, b.y + b.h / 2 + 12, 'run', 640)
      }

      startRepairBody(store, b.id)
      setActionState('repair_glass')
      for (let step = 1; step <= 20; step++) {
        setRepairProgress(store, b.id, step / 20)
        if (typeof onForceRefreshSandbox === 'function') onForceRefreshSandbox()
        await sleep(74)
      }
      setGlassSourceVisibility(b.id, true)
      if (typeof onForceRefreshSandbox === 'function') onForceRefreshSandbox()
      setActionState('happy')
      say(`「${b.label}」已经凝聚修补完好啦 🌿✨`)
      await sleep(440)
    }
    await returnToCorner()
  }

  useEffect(() => {
    if (!shatterSignal || !config.visible || config.autoRepairShattered === false) return undefined
    const delayMs = 5000 + Math.round(Math.random() * 3800)
    const timer = setTimeout(() => {
      if (busyTaskRef.current || isDraggingPet || roamingDesktop) return
      busyTaskRef.current = true
      performRepairAll(true).finally(() => { busyTaskRef.current = false })
    }, delayMs)
    return () => clearTimeout(timer)
  }, [shatterSignal, config.visible, config.autoRepairShattered, roamingDesktop])

  const executeAction = async (act) => {
    if (!act || busyTaskRef.current) return
    if (act.type === 'open_customizer') {
      setCustomizer({ open: true, tab: 'avatar' })
      return
    }
    busyTaskRef.current = true
    try {
      if (act.type === 'autopilot') await performAutopilot(act.requirement)
      else if (act.type === 'crouch_click') await performCrouchClick(act.target, act.label)
      else if (act.type === 'write_input') await performWriteInput(act.text)
      else if (act.type === 'magic_blackhole') await performBlackHoleMagic(act.fileName)
      else if (act.type === 'repair_all') await performRepairAll(false)
      else if (act.type === 'dance') {
        setActionState('dance')
        bumpStats({ affection: 4, mood: '摇铃开心' })
        await sleep(1300)
        setActionState('idle')
      } else if (act.type === 'sleep') {
        setActionState('sleep')
        bumpStats({ energy: 12, mood: '小憩充电' })
      } else if (act.type === 'happy') {
        setActionState('happy')
        await sleep(800)
        setActionState('idle')
      }
    } finally {
      busyTaskRef.current = false
    }
  }

  const resolveCompanionEndpoint = () => {
    const baseCfg = settings.backendConfig || {}
    const saved = (settings.savedModels || []).find((m) => m.id === config.modelProfileId)
    return {
      baseUrl: config.customBaseUrl || (saved && saved.baseUrl) || baseCfg.provider_base_url || baseCfg.provider_base || 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: config.customApiKey || (saved && saved.apiKey) || baseCfg.api_key || baseCfg.provider_key || '',
      model: config.customModel || (saved && saved.model) || baseCfg.model || baseCfg.provider_model || 'glm-4.5-flash',
    }
  }

  const handleSendChat = async (overrideText = '', { forceAutopilot = false } = {}) => {
    const text = String(overrideText || chatInput).trim()
    if (!text || chatBusy) return
    lastInteractAtRef.current = Date.now()
    setChatInput('')
    setMessages((prev) => [...prev.slice(-16), { id: `u_${Date.now()}`, role: 'user', text }])
    setChatBusy(true)
    try {
      const store = sandboxStoreRef && sandboxStoreRef.current
      const damagedCount = store
        ? Array.from(store.bodies.values()).filter((b) => b.status === 'shattered' || b.biteNotches.length > 0 || b.cracks.length > 0).length
        : 0
      const res = await askCompanionBrain({
        userText: text,
        history: messages,
        avatar,
        config,
        endpointConfig: resolveCompanionEndpoint(),
        damagedCount,
        forceAutopilot,
      })
      setMessages((prev) => [...prev.slice(-16), { id: `a_${Date.now()}`, role: 'assistant', text: res.reply, engine: res.engine }])
      say(res.reply.slice(0, 56), 3400)
      if (res.action) executeAction(res.action)
    } finally {
      setChatBusy(false)
    }
  }

  const cycleDriveMode = () => {
    if (config.fullLlmDrive) {
      updateConfigPatch({ llmEnabled: false, fullLlmDrive: false })
      pushToast('芽露已切换为「🤖 本地全自动总管」（零 Token）', 'info')
    } else if (config.llmEnabled) {
      updateConfigPatch({ llmEnabled: true, fullLlmDrive: true })
      pushToast('芽露已切换为「⚡ 完全大模型驱动」', 'info')
    } else {
      updateConfigPatch({ llmEnabled: true, fullLlmDrive: false })
      pushToast('芽露已切换为「🧠 大模型闲聊 + 本地总管」', 'info')
    }
  }

  const updateAvatarPatch = (patch) => setAvatar((prev) => saveCompanionAvatar({ ...prev, ...patch }))
  const updateConfigPatch = (patch) => setConfig((prev) => saveCompanionConfig({ ...prev, ...patch }))

  if (!config.visible) return null

  const exprAvatarUrl = pickExpressionUrl(pack, actionState, avatar.expressionOverride)
  const driveLabel = config.fullLlmDrive
    ? '⚡ 完全大模型'
    : (config.llmEnabled ? '🧠 闲聊增强' : '🤖 全自动总管')
  const lv = affectionLevel(stats.affection)
  const storeNow = sandboxStoreRef && sandboxStoreRef.current
  const hasDamagedGlass = Boolean(
    storeNow && Array.from(storeNow.bodies.values()).some((b) => b.status === 'shattered' || b.biteNotches.length > 0 || b.cracks.length > 0)
  )

  return (
    <div className="cp-root" data-companion-root="true">
      {/* 仅在芽露自己溜达到桌面时显示极简召回胶囊 */}
      {roamingDesktop && (
        <button type="button" className="cp-recall-pill" onClick={() => returnFromDesktop()}>
          🌿 呼唤「{avatar.name || '芽露'}」回窗
        </button>
      )}

      {/* 芽露 3D 骨骼 / 60fps 原片逐帧活体主体（零体外漂浮道具！） */}
      {!roamingDesktop && (
        <div
          className="cp-actor"
          data-companion-actor="true"
          data-render-mode={avatar.renderMode || 'yalu_3d'}
          data-action={actionState}
          data-dragging={String(isDraggingPet)}
          style={{ transform: `translate3d(${pos.x.toFixed(1)}px, ${pos.y.toFixed(1)}px, 0)` }}
          title={`左键与「${avatar.name || '芽露'}」对话派单 · 按住可拎起拖出窗口 · 双击摇铃 · 右键工坊与驱动`}
          onPointerDown={handleActorPointerDown}
          onClick={(e) => {
            e.stopPropagation()
            if (suppressClickRef.current) return
            lastInteractAtRef.current = Date.now()
            setCtxMenu(null)
            const rect = e.currentTarget.getBoundingClientRect()
            const relY = rect && rect.height ? (e.clientY - rect.top) / rect.height : 0.5
            if (!chatOpen && !busyTaskRef.current) {
              if (relY < 0.42) {
                setActionState('pat')
                bumpStats({ affection: 5, headPats: 1, mood: '被摸头好开心' })
                say('叮铃～摸摸头最舒服啦 💕 有什么任务交给芽露？', 2600)
                setTimeout(() => { if (!busyTaskRef.current) setActionState('idle') }, 850)
              } else {
                setActionState('bell_play')
                say('叮铃铃～碰到我腰间的酒红铃铛啦 🔔', 2400)
                setTimeout(() => { if (!busyTaskRef.current) setActionState('idle') }, 800)
              }
            }
            setChatOpen((v) => !v)
          }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            if (!busyTaskRef.current) executeAction({ type: 'dance' })
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
            const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
            setCtxMenu({ x: Math.min(vw - 246, Math.max(12, e.clientX)), y: Math.min(vh - 170, Math.max(12, e.clientY - 70)) })
          }}
        >
          {speech && <div className="cp-speech">{speech}</div>}
          <YaluModelStage
            assets={packAssets}
            renderMode={avatar.renderMode || 'yalu_3d'}
            actionState={actionState}
            facing={facing}
            lookX={look.x}
            lookY={look.y}
            dragTilt={dragTilt}
            auraTheme={avatar.auraTheme || 'natural'}
            scale={avatar.scale || 1}
            width={136}
            height={186}
          />
          <span className="cp-name-tag">
            <span>🌿 {avatar.name || '芽露'}</span>
            <span className="cp-lv-badge">Lv.{lv}</span>
          </span>
        </div>
      )}

      {flyingOrb && (
        <div className="cp-file-orb" style={{ transform: `translate3d(${flyingOrb.x.toFixed(1)}px, ${flyingOrb.y.toFixed(1)}px, 0)` }}>
          {flyingOrb.label}
        </div>
      )}

      {/* 极简纯净的对话与全自动派单小窗（告别花哨按钮堆砌！） */}
      {chatOpen && (
        <section className="cp-chat" aria-label="芽露全自动总管协作面板" onClick={(e) => e.stopPropagation()}>
          <div className="cp-chat-head">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              {exprAvatarUrl && <img className="cp-expr-avatar" src={exprAvatarUrl} alt="芽露表情" />}
              <strong style={{ fontSize: 13 }}>{avatar.name || '芽露'}</strong>
              <span className="cp-mode-pill">{driveLabel}</span>
            </div>
            <div style={{ display: 'flex', gap: 5 }}>
              <button type="button" className="cp-mini-btn" data-active={String(snackBarOpen)} onClick={() => setSnackBarOpen((v) => !v)}>🍓 投喂</button>
              <button type="button" className="cp-mini-btn" onClick={() => setCustomizer({ open: true, tab: 'avatar' })}>🎨 工坊</button>
              <button type="button" className="cp-mini-btn" onClick={() => setChatOpen(false)} aria-label="关闭助手聊天">×</button>
            </div>
          </div>

          {snackBarOpen && (
            <div className="cp-quick-row" style={{ borderTop: 0, borderBottom: '1px solid var(--border)' }}>
              {COMPANION_SNACKS.map((sn) => (
                <button key={sn.id} type="button" className="cp-mini-btn" onClick={() => performFeedSnack(sn)}>
                  {sn.icon} {sn.name}
                </button>
              ))}
            </div>
          )}

          {autopilotHud && (
            <div className="cp-autopilot-hud" data-autopilot-hud="true">
              <div className="cp-autopilot-row">
                <strong>{autopilotHud.title}</strong>
                {autopilotHud.running ? (
                  <button type="button" className="cp-mini-btn" onClick={abortCurrentAutopilot}>停止监工</button>
                ) : (
                  <button type="button" className="cp-mini-btn" onClick={() => setAutopilotHud(null)}>收起</button>
                )}
              </div>
              <div style={{ color: 'var(--text-2)' }}>{autopilotHud.stepText}</div>
              <div className="cp-progress-track">
                <div className="cp-progress-fill" style={{ width: `${autopilotHud.pct}%` }} />
              </div>
            </div>
          )}

          <div className="cp-chat-list">
            {messages.map((m) => (
              <div key={m.id} className="cp-msg" data-role={m.role}>
                <div>{m.text}</div>
                {m.deliverable && (
                  <div className="cp-delivery-actions">
                    <button type="button" className="cp-mini-btn" data-active="true" onClick={() => setDockPreview(m.deliverable)}>
                      📄 右侧副屏查收终稿
                    </button>
                    <button type="button" className="cp-mini-btn" onClick={async () => { await copyText(m.deliverable); pushToast('已复制终稿内容', 'ok') }}>
                      📋 复制终稿
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* 仅在需要时呈现极简情景入口（最多 2 项，绝不堆砌按钮！） */}
          <div className="cp-quick-row">
            <button
              type="button"
              className="cp-mini-btn"
              data-active="true"
              onClick={() => handleSendChat('帮我制定一份新产品的全栈架构设计与上线验收方案', { forceAutopilot: true })}
            >
              🤖 全自动代办交稿
            </button>
            {hasDamagedGlass ? (
              <button type="button" className="cp-mini-btn" onClick={() => handleSendChat('帮我把受损的玻璃修补好')}>🛠 修补受损玻璃</button>
            ) : (
              <button type="button" className="cp-mini-btn" onClick={() => handleSendChat('用黑洞帮我把 需求规格.md 放进聊天框')}>🌀 黑洞取文件</button>
            )}
          </div>

          <div className="cp-chat-foot">
            <input
              className="cp-chat-input"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSendChat() }}
              placeholder="直接发需求给芽露，她会自动选专家团/工作流监工交稿…"
            />
            <button
              type="button"
              className="cp-mini-btn"
              style={{ background: 'var(--primary)', color: 'var(--on-primary)', borderColor: 'var(--primary)' }}
              disabled={chatBusy}
              onClick={() => handleSendChat()}
            >
              派发
            </button>
          </div>
        </section>
      )}

      {/* 极简克制右键菜单（仅保留 3 项核心系统控制，所有互动/出窗漫步均为自然本能动作！） */}
      {ctxMenu && (
        <div className="cp-ctx" role="menu" aria-label="芽露右键菜单" style={{ left: `${ctxMenu.x}px`, top: `${ctxMenu.y}px` }} onClick={(e) => e.stopPropagation()}>
          <button type="button" className="cp-ctx-item" onClick={() => { setCtxMenu(null); setCustomizer({ open: true, tab: 'avatar' }) }}>
            <span>🎨 芽露 3D 工坊与大模型设置</span><span>→</span>
          </button>
          <button type="button" className="cp-ctx-item" data-active={String(Boolean(config.fullLlmDrive))} onClick={() => { setCtxMenu(null); cycleDriveMode() }}>
            <span>🧠 驱动模式切换</span><span>{driveLabel}</span>
          </button>
          <div className="cp-ctx-div" />
          <button type="button" className="cp-ctx-item" onClick={() => {
            setCtxMenu(null)
            setChatOpen(false)
            updateConfigPatch({ visible: false })
            pushToast('已暂时隐藏芽露，可在顶栏「工具箱」随时唤回', 'info')
          }}>
            <span>🙈 暂时隐藏芽露</span><span>×</span>
          </button>
        </div>
      )}

      <CompanionCustomizer
        open={customizer.open}
        initialTab={customizer.tab}
        avatar={avatar}
        config={config}
        savedModels={settings.savedModels || []}
        defaultModel={settings.backendConfig.provider_model || settings.backendConfig.model || 'glm-4.5-flash'}
        onUpdateAvatar={updateAvatarPatch}
        onUpdateConfig={updateConfigPatch}
        onClose={() => setCustomizer((prev) => ({ ...prev, open: false }))}
      />
    </div>
  )
}
