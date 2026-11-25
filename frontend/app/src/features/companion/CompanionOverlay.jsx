import { useEffect, useRef, useState } from 'react'
import {
  useSlice,
  getState,
  subscribe,
  setActivePanel,
  openModal,
  setComposerDraft,
  addComposerToken,
  enqueueOrSendChat,
  startExpertTeamRun,
  selectWorkflow,
  runActiveWorkflow,
  runGroupRelay,
  startCollaborationRun,
  setDockPreview,
  fireShellImpact,
  pushToast,
} from '../../state/store.js'
import {
  COMPANION_PERSONALITIES,
  COMPANION_SNACKS,
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
import { computeViewportCoords } from '../../platform/kinetic.js'
import Companion3DCanvas from '../../ui/Companion3DCanvas.jsx'
import CompanionCustomizer from './CompanionCustomizer.jsx'
import './CompanionOverlay.css'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 实时监听 Harbor store 状态直至某一真实模块运行完成（支持超时与手动取消） */
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
    x: Math.max(120, ((typeof window !== 'undefined' && window.innerWidth) || 1280) - 168),
    y: Math.max(120, ((typeof window !== 'undefined' && window.innerHeight) || 800) - 174),
  }))
  const [facing, setFacing] = useState(-1)
  const [look, setLook] = useState({ x: 0, y: 0 })
  const [dragTilt, setDragTilt] = useState(0)
  const [isDraggingPet, setIsDraggingPet] = useState(false)
  const [actionState, setActionState] = useState('idle')
  const [speech, setSpeech] = useState('')
  const [chatOpen, setChatOpen] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [snackBarOpen, setSnackBarOpen] = useState(false)
  const [pomodoroSec, setPomodoroSec] = useState(0)
  const [starToy, setStarToy] = useState(null) // { x, y }
  const [autopilotHud, setAutopilotHud] = useState(null) // { title, moduleLabel, stepText, pct, running }
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

  const say = (text, ms = 3800) => {
    setSpeech(text)
    if (speechTimerRef.current) clearTimeout(speechTimerRef.current)
    speechTimerRef.current = setTimeout(() => setSpeech(''), ms)
  }

  const bumpStats = (delta = {}) => {
    setStats((prev) => saveCompanionStats({
      ...prev,
      affection: (prev.affection || 0) + (delta.affection || 0),
      energy: Math.max(0, Math.min(100, (prev.energy ?? 80) + (delta.energy || 0))),
      tasksDelivered: (prev.tasksDelivered || 0) + (delta.tasksDelivered || 0),
      snacksEaten: (prev.snacksEaten || 0) + (delta.snacksEaten || 0),
      headPats: (prev.headPats || 0) + (delta.headPats || 0),
      ...(delta.mood ? { mood: delta.mood } : {}),
    }))
  }

  // 外部工具箱按钮触发重新唤出助手
  useEffect(() => {
    if (forceOpenSignal > 0) {
      const next = saveCompanionConfig({ ...config, visible: true })
      setConfig(next)
      say('咕噜噜～我回来报到啦！', 2800)
    }
  }, [forceOpenSignal])

  // 番茄钟专注倒计时
  useEffect(() => {
    if (pomodoroSec <= 0) return undefined
    const t = setInterval(() => {
      setPomodoroSec((prev) => {
        if (prev <= 1) {
          setActionState('deliver')
          say('🍅 25 分钟专注达成！快伸个懒腰喝口水吧，你超棒的 ✨', 5200)
          bumpStats({ affection: 12, mood: '为你骄傲' })
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(t)
  }, [pomodoroSec > 0])

  // 柔和视线追踪鼠标 + 点击菜单外部才关闭右键菜单（修复 R28 pointerdown 误关菜单 Bug！）
  useEffect(() => {
    if (!config.visible) return undefined
    const onMove = (e) => {
      const cur = posRef.current
      const dx = e.clientX - (cur.x + 74)
      const dy = e.clientY - (cur.y + 62)
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

  // ============================================================================
  // 可玩性核心 1：拎起来拖动晃动 + 甩出抛物线弹墙重力物理！
  // ============================================================================
  const startFlingPhysics = (vx0, vy0) => {
    if (flingRafRef.current) cancelAnimationFrame(flingRafRef.current)
    let x = posRef.current.x
    let y = posRef.current.y
    let vx = Math.max(-1400, Math.min(1400, vx0))
    let vy = Math.max(-1400, Math.min(1400, vy0))
    const speed0 = Math.hypot(vx, vy)
    if (speed0 < 160) {
      setDragTilt(0)
      setActionState('bounce')
      say('安全着陆～我就先在这儿乖乖等你啦！', 2400)
      setTimeout(() => { if (!busyTaskRef.current) setActionState('idle') }, 480)
      return
    }
    setActionState('thrown')
    say('哇啊啊起飞啦——要撞到液态玻璃墙啦！！', 2200)
    let lastT = performance.now()
    let bounces = 0

    const tick = (now) => {
      const dt = Math.min(0.032, Math.max(0.008, (now - lastT) / 1000))
      lastT = now
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
      const maxX = Math.max(20, vw - 148)
      const maxY = Math.max(24, vh - 154)

      vy += 1550 * dt // 柔和重力加速度
      x += vx * dt
      y += vy * dt
      vx *= 0.992

      let hitWall = false
      let hitSide = 'bottom'
      if (x < 8) { x = 8; vx = Math.abs(vx) * 0.62; hitWall = true; hitSide = 'left' }
      else if (x > maxX) { x = maxX; vx = -Math.abs(vx) * 0.62; hitWall = true; hitSide = 'right' }
      if (y < 14) { y = 14; vy = Math.abs(vy) * 0.56; hitWall = true; hitSide = 'top' }
      else if (y > maxY) { y = maxY; vy = -Math.abs(vy) * 0.48; vx *= 0.78; hitWall = true; hitSide = 'bottom' }

      if (hitWall && Math.hypot(vx, vy) > 130) {
        bounces += 1
        const vp = computeViewportCoords(x + 74, y + 74, vw, vh)
        fireShellImpact(hitSide, bounces === 1 ? 'strong' : 'medium', { nx: vp.nx, ny: vp.ny, pointer: true })
        setActionState('bounce')
      }

      setPos({ x, y })
      setFacing(vx >= 0 ? 1 : -1)
      setDragTilt(Math.max(-0.42, Math.min(0.42, vx / 900)))

      const settled = y >= maxY - 2 && Math.abs(vy) < 75 && Math.abs(vx) < 42
      if (settled || bounces > 5) {
        flingRafRef.current = 0
        setDragTilt(0)
        setActionState('happy')
        say('咚！Q弹着陆～好刺激再来一次！(揉头)', 2600)
        setTimeout(() => { if (!busyTaskRef.current) setActionState('idle') }, 700)
        return
      }
      flingRafRef.current = requestAnimationFrame(tick)
    }
    flingRafRef.current = requestAnimationFrame(tick)
  }

  const handleActorPointerDown = (e) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (flingRafRef.current) {
      cancelAnimationFrame(flingRafRef.current)
      flingRafRef.current = 0
    }
    const startX = e.clientX
    const startY = e.clientY
    const originX = posRef.current.x
    const originY = posRef.current.y
    const actorRect = e.currentTarget.getBoundingClientRect()
    const relY = actorRect && actorRect.height ? (e.clientY - actorRect.top) / actorRect.height : 0.5

    petDragRef.current = {
      startX,
      startY,
      originX,
      originY,
      relY,
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
        say(avatar.bodyForm === 'dafeiyu' ? '哇哇别拎大肥鱼！尾巴要扑腾打结啦～' : '咿呀！别拎着我后脖颈晃呀，要头晕啦～', 2400)
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
      const nx = Math.max(6, Math.min(vw - 146, d.originX + (ev.clientX - d.startX)))
      const ny = Math.max(10, Math.min(vh - 150, d.originY + (ev.clientY - d.startY)))
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

  // 平滑小跑/游动到屏幕任意坐标
  const walkTo = async (tx, ty, runState = 'run', durationMs = 760) => {
    const start = { ...posRef.current }
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
    const destX = Math.max(12, Math.min(vw - 148, tx - 72))
    const destY = Math.max(24, Math.min(vh - 154, ty - 96))
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
    await walkTo(vw - 96, vh - 78, 'run', 660)
    setFacing(-1)
    setActionState('idle')
  }

  // 互动玩法：双形态即时变身 / 投喂零食 / 抛星星小游戏 / 摸摸头 / 跳舞
  const performMorphForm = async () => {
    const nextForm = avatar.bodyForm === 'dafeiyu' ? 'whale_girl' : 'dafeiyu'
    const nextName = nextForm === 'dafeiyu' ? '大肥鱼' : '大肥鱼娘'
    const nextHead = nextForm === 'dafeiyu' ? 'whale_spout' : 'sailor_hat'
    setAvatar((prev) => saveCompanionAvatar({ ...prev, bodyForm: nextForm, name: nextName, headgear: nextHead }))
    setActionState('dance')
    say(nextForm === 'dafeiyu' ? '嘭✨ 变回胖乎乎的大肥鱼本尊啦！咕噜噜～' : '嘭✨ 变身二次元鲸鱼娘形态，准备为你效劳！', 3200)
    await sleep(950)
    setActionState('idle')
  }

  const performFeedSnack = async (snack) => {
    if (!snack) return
    setSnackBarOpen(false)
    setActionState('eat_snack')
    say(`${snack.icon} ${snack.quote}`, 3600)
    bumpStats({ energy: snack.energy, affection: snack.affection, snacksEaten: 1, mood: '超满足' })
    await sleep(1100)
    setActionState('happy')
    await sleep(600)
    setActionState('idle')
  }

  const performStarCatchGame = async () => {
    if (busyTaskRef.current) return
    busyTaskRef.current = true
    try {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
      const tx = 140 + Math.random() * Math.max(200, vw - 300)
      const ty = 120 + Math.random() * Math.max(160, vh - 280)
      setStarToy({ x: tx, y: ty })
      say('发现发光液态星晶！看我冲刺凌空接住它 ⭐', 2600)
      await walkTo(tx + 12, ty + 20, 'run', 680)
      setStarToy(null)
      const vp = computeViewportCoords(tx, ty, vw, vh)
      fireShellImpact('pointer', 'medium', { nx: vp.nx, ny: vp.ny, pointer: true })
      setActionState('deliver')
      bumpStats({ affection: 8, energy: -4, mood: '超开心' })
      say('接住啦！！好感度 +8 ✨ 要不要再丢一颗？', 3200)
      await sleep(900)
      setActionState('idle')
    } finally {
      busyTaskRef.current = false
    }
  }

  // ============================================================================
  // 核心能力：全自动无人驾驶总管 (Autopilot Supervisor) — 完全替代真人操作直到交稿！
  // ============================================================================
  const performAutopilot = async (requirement) => {
    const req = String(requirement || '').trim()
    if (!req) return
    autopilotCancelRef.current = false
    const st0 = getState()
    const workflows = (st0.plugins && st0.plugins.workflows) || []
    const teams = buildAvailableTeams((st0.market && st0.market.experts) || [])

    setActionState('supervising')
    setAutopilotHud({
      title: '正在全盘评估最佳执行方案…',
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
      `🧭 **无人驾驶路由决策完成**（${plan.plannedBy === 'llm-supervisor' ? '专属大模型总管' : '本地极速总管'}）`,
      `• **选用模块**：${plan.moduleLabel}`,
      plan.team ? `• **派出原生专家团**：${plan.team.name}（${1 + plan.team.members.length} 人）` : null,
      plan.workflow ? `• **选用工作流**：${plan.workflow.name}` : null,
      plan.mode === 'chat' && plan.expert ? `• **自动挂载专家**：${plan.expert.name}` : null,
      plan.mode === 'chat' && plan.skill ? `• **自动挂载 Skill**：${plan.skill.name}` : null,
      `• **决策依据**：${plan.reason}`,
    ].filter(Boolean).join('\n')

    setMessages((prev) => [...prev.slice(-16), { id: `ap_plan_${Date.now()}`, role: 'assistant', text: planMsg, engine: 'autopilot' }])
    say(`已选定「${plan.moduleLabel}」，我亲自跑去操作并全程监工！`, 3600)

    let deliverable = ''

    try {
      // 1) 物理跑去目标导航并点击切入模块
      setAutopilotHud({
        title: plan.moduleLabel,
        moduleLabel: plan.team ? plan.team.name : (plan.workflow ? plan.workflow.name : (plan.expert ? plan.expert.name : 'Harbor')),
        stepText: plan.steps[0] || '正在切入目标模块…',
        pct: 32,
        running: true,
      })

      const navHit = findUiControlByHint(plan.navTarget)
      if (navHit) {
        await walkTo(navHit.cx + 30, navHit.cy + 14, 'run', 640)
        setActionState('crouch_click')
        await sleep(220)
      }

      if (plan.mode === 'workflow' && plan.workflow) {
        setActivePanel('workflow')
        selectWorkflow(plan.workflow.id)
        await sleep(160)
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
        openModal('market')
        await sleep(140)
        setActionState('supervising')
        setAutopilotHud({
          title: `监工原生专家团：${plan.team.name}`,
          moduleLabel: `${1 + plan.team.members.length} 人成建制团队`,
          stepText: `正在监督 ${plan.team.members.map((m) => m.name).join(' → ')} 接力交付…`,
          pct: 58,
          running: true,
        })
        await startExpertTeamRun({ goal: req, lead: plan.team.lead, members: plan.team.members, useRecovery: false })
        deliverable = String((getState().expertTeam && getState().expertTeam.finalReport) || '')
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
        // 默认最优：智能对话 + 自动精准装载最佳专家 + 最佳 Skill + 拿笔手写 + 自动发送 + 监工等待！
        setActivePanel('chat')
        await sleep(140)
        if (plan.expert) {
          addComposerToken({ id: plan.expert.id, name: plan.expert.name, kind: 'agent', prompt: plan.expert.prompt })
        }
        if (plan.skill) {
          addComposerToken({ id: plan.skill.id, name: `Skill · ${plan.skill.name}`, kind: 'skill', prompt: plan.skill.prompt })
        }
        const compHit = focusComposerInput()
        if (compHit) await walkTo(compHit.x + 120, compHit.y + 10, 'run', 520)
        setActionState('write_input')
        setAutopilotHud({
          title: `正在手写需求并派单`,
          moduleLabel: `${plan.expert ? plan.expert.name : '智能对话'}`,
          stepText: '已自动装载最佳专家与 Skill，正在写入任务并启动运行…',
          pct: 48,
          running: true,
        })
        setComposerDraft(req)
        await sleep(220)
        const sid = getState().sessions.currentId
        const beforeLen = ((getState().sessions.items.find((s) => s.id === sid) || {}).messages || []).length
        enqueueOrSendChat(req)
        setActionState('supervising')
        setAutopilotHud({
          title: `监工智能对话执行中…`,
          moduleLabel: `${plan.expert ? plan.expert.name : '智能对话'}`,
          stepText: '正在实时跟踪思考流、联网/工具调用与正文生成…',
          pct: 72,
          running: true,
        })
        await waitForStoreCondition((st) => {
          const run = st.runtime && st.runtime.runsBySid && st.runtime.runsBySid[sid]
          const sess = st.sessions.items.find((s) => s.id === sid)
          const msgs = (sess && sess.messages) || []
          if (msgs.length > beforeLen && msgs[msgs.length - 1].role === 'assistant' && (!run || run.phase === 'done' || run.phase === 'idle')) {
            return { ok: true, text: msgs[msgs.length - 1].content }
          }
          if (run && run.error) return { ok: false, error: run.error }
          return null
        }, 45000, autopilotCancelRef)
        const sessNow = getState().sessions.items.find((s) => s.id === sid)
        const lastAsst = [...((sessNow && sessNow.messages) || [])].reverse().find((m) => m.role === 'assistant')
        deliverable = lastAsst ? String(lastAsst.content || '') : ''
      }

      // 3) 质检验收并交稿！
      const qa = evaluateDeliverableQuality(deliverable, req)
      setAutopilotHud({
        title: qa.ok ? `🎉 自主交稿完成 · ${qa.grade}` : '执行已结束（请检查模型配置或重试）',
        moduleLabel: plan.moduleLabel,
        stepText: qa.ok ? `质检 ${qa.score} 分 · ${qa.charCount} 字，已自动推送至右侧副屏` : qa.summary,
        pct: 100,
        running: false,
      })

      if (qa.ok && deliverable) {
        setDockPreview(`# 📦 大肥鱼全自动监工交付终稿\n\n> **原始需求**：${req}\n> **选用路线**：${plan.moduleLabel}\n> **验收评级**：${qa.grade}（${qa.score} 分 · ${qa.charCount} 字）\n\n---\n\n${deliverable}`)
        setActionState('deliver')
        bumpStats({ affection: 15, energy: -6, tasksDelivered: 1, mood: '圆满交稿' })
        say(`交稿啦！${qa.grade}，我已经把终稿整理放进右侧副屏咯 📦✨`, 5000)
        pushToast(`大肥鱼已完成「${plan.moduleLabel}」全自动监工并交稿！`, 'ok')
      } else {
        setActionState('guilty')
        say('呜…这次没有拿到完整正文，点下面可以让我重新试一次哦', 4200)
      }

      setMessages((prev) => [
        ...prev.slice(-16),
        {
          id: `ap_done_${Date.now()}`,
          role: 'assistant',
          text: `📦 **全自动监工交付验收单**\n${qa.summary}`,
          deliverable: deliverable || '',
          requirement: req,
          engine: 'autopilot',
        },
      ])
      await sleep(1100)
      await returnToCorner()
    } catch (err) {
      setAutopilotHud(null)
      setActionState('guilty')
      const errTxt = String((err && err.message) || err)
      setMessages((prev) => [...prev.slice(-16), { id: `ap_err_${Date.now()}`, role: 'assistant', text: `呜哇执行过程遇到小插曲：${errTxt}`, engine: 'autopilot' }])
      say('执行遇到一点小故障，我退回角落等你指示～', 3600)
    }
  }

  // 经典动作：蹲点点击 / 拿笔手写 / 黑洞取文件 / 修补受损玻璃
  const performCrouchClick = async (targetHint, label = '') => {
    const hit = findUiControlByHint(targetHint)
    if (!hit) {
      if (['chat', 'group', 'workflow', 'workspace'].includes(targetHint)) setActivePanel(targetHint)
      setActionState('happy')
      say(`已为你切换到「${label || targetHint}」～`)
      await sleep(800)
      setActionState('idle')
      return
    }
    say(`哒哒哒～跑去帮你点「${label || targetHint}」！`)
    await walkTo(hit.cx + 28, hit.cy + 16, 'run', 680)
    setFacing(hit.cx >= posRef.current.x + 70 ? 1 : -1)
    setActionState('crouch_click')
    await sleep(300)
    triggerUiControlClick(targetHint)
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
    const vp = computeViewportCoords(hit.cx, hit.cy, vw, vh)
    fireShellImpact('pointer', 'medium', { nx: vp.nx, ny: vp.ny, pointer: true })
    await sleep(360)
    setActionState('happy')
    say(`点好啦！已为你打开「${label || targetHint}」✨`)
    await sleep(600)
    await returnToCorner()
  }

  const performWriteInput = async (textToWrite) => {
    setActivePanel('chat')
    await sleep(140)
    const hit = focusComposerInput()
    say('拿好星光小笔，跑去输入框帮你手写～')
    if (hit) await walkTo(hit.x + 110, hit.y + 12, 'run', 680)
    setActionState('write_input')
    const full = String(textToWrite || '')
    const step = Math.max(1, Math.ceil(full.length / 22))
    let cur = ''
    for (let i = 0; i < full.length; i += step) {
      cur = full.slice(0, i + step)
      setComposerDraft(cur)
      await sleep(42)
    }
    setComposerDraft(full)
    setActionState('happy')
    say('手写完毕！按回车就能发出去咯 ✍️')
    await sleep(650)
    await returnToCorner()
  }

  const performBlackHoleMagic = async (fileName = '项目核心说明.md') => {
    setActivePanel('chat')
    setActionState('magic_blackhole')
    say(`空间魔法·微型黑洞展开！正在伸手把「${fileName}」掏出来…`, 4200)
    await sleep(880)
    const startX = posRef.current.x + (facing > 0 ? 105 : 25)
    const startY = posRef.current.y + 52
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
      prompt: `【来自助手黑洞传送的参考文件：${fileName}】请结合该文件上下文分析并响应用户需求。`,
    })
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
    const vp = computeViewportCoords(endX, endY, vw, vh)
    fireShellImpact('pointer', 'medium', { nx: vp.nx, ny: vp.ny, pointer: true })
    setActionState('happy')
    say(`搞定！「${fileName}」已从黑洞放进聊天框啦 🌀`)
    pushToast(`助手已通过黑洞魔法将「${fileName}」放入输入框`, 'ok')
    await sleep(750)
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
        say(isAutoPassive ? `哎呀「${b.label}」碎了一地！我去把碎片收拾起来修补好～` : `正在跑去捡「${b.label}」的玻璃碎片…`)
        const firstShard = b.shards[0]
        if (firstShard) {
          await walkTo(firstShard.x, firstShard.y, 'run', 720)
          setActionState('collect_shards')
          for (const sh of b.shards) {
            sh.collected = true
            if (typeof onForceRefreshSandbox === 'function') onForceRefreshSandbox()
            await sleep(50)
          }
          say('碎片收好啦！抱着碎片跑回原位修补～')
        }
        await walkTo(b.origin.x + b.origin.w / 2 + 24, b.origin.y + b.origin.h / 2 + 12, 'collect_shards', 680)
      } else {
        say(`乖乖跑去把啃掉的「${b.label}」修补回亮晶晶的样子…`)
        await walkTo(b.x + b.w / 2 + 24, b.y + b.h / 2 + 12, 'run', 680)
      }

      startRepairBody(store, b.id)
      setActionState('repair_glass')
      for (let step = 1; step <= 20; step++) {
        setRepairProgress(store, b.id, step / 20)
        if (typeof onForceRefreshSandbox === 'function') onForceRefreshSandbox()
        await sleep(80)
      }
      setGlassSourceVisibility(b.id, true)
      if (typeof onForceRefreshSandbox === 'function') onForceRefreshSandbox()
      setActionState('happy')
      say(`「${b.label}」已经凝聚修补完好啦 ✨`)
      await sleep(480)
    }
    await returnToCorner()
  }

  // 被动效果：甩碎玻璃 5–9 秒后自动拾碎片修补
  useEffect(() => {
    if (!shatterSignal || !config.visible || config.autoRepairShattered === false) return undefined
    const delayMs = 5200 + Math.round(Math.random() * 4000)
    const timer = setTimeout(() => {
      if (busyTaskRef.current || isDraggingPet) return
      busyTaskRef.current = true
      performRepairAll(true).finally(() => { busyTaskRef.current = false })
    }, delayMs)
    return () => clearTimeout(timer)
  }, [shatterSignal, config.visible, config.autoRepairShattered])

  // 趣味习性：饱食度 < 75 且闲置时偶尔溜去啃一口液态玻璃（投喂小鱼干就不会偷啃！）
  useEffect(() => {
    if (!config.visible || config.sneakEatEnabled === false || settings.motion === 'reduced') return undefined
    const timer = setInterval(async () => {
      if (busyTaskRef.current || chatOpen || customizer.open || isDraggingPet || stats.energy >= 88) return
      const store = sandboxStoreRef && sandboxStoreRef.current
      if (!store) return
      const candidates = collectVisibleGlassBlocks().filter((c) => !store.bodies.has(c.id))
      if (candidates.length === 0) return
      const pick = candidates[Math.floor(Math.random() * candidates.length)]
      busyTaskRef.current = true
      try {
        say(`肚子咕噜噜…「${pick.label}」看起来好脆好好吃！`, 2600)
        await walkTo(pick.x + pick.w / 2 + 24, pick.y + pick.h / 2 + 12, 'run', 800)
        setActionState('sneak_eat')
        await sleep(850)
        biteGlassBody(store, pick)
        bumpStats({ energy: 10, mood: '偷吃得逞' })
        if (typeof onForceRefreshSandbox === 'function') onForceRefreshSandbox()
        setActionState('guilty')
        say(`啊呜！偷偷啃了一口「${pick.label}」（点我喊我修补，或者喂我小鱼干吧～）`, 4200)
        await sleep(850)
        await returnToCorner()
      } finally {
        busyTaskRef.current = false
      }
    }, 38000)
    return () => clearInterval(timer)
  }, [config.visible, config.sneakEatEnabled, settings.motion, chatOpen, customizer.open, isDraggingPet, stats.energy])

  const executeAction = async (act) => {
    if (!act || busyTaskRef.current) return
    if (act.type === 'open_customizer') {
      setCustomizer({ open: true, tab: 'avatar' })
      return
    }
    if (act.type === 'throw_star') {
      performStarCatchGame()
      return
    }
    busyTaskRef.current = true
    try {
      if (act.type === 'autopilot') await performAutopilot(act.requirement)
      else if (act.type === 'crouch_click') await performCrouchClick(act.target, act.label)
      else if (act.type === 'write_input') await performWriteInput(act.text)
      else if (act.type === 'magic_blackhole') await performBlackHoleMagic(act.fileName)
      else if (act.type === 'repair_all') await performRepairAll(false)
      else if (act.type === 'morph_form') await performMorphForm()
      else if (act.type === 'dance') {
        setActionState('dance')
        bumpStats({ affection: 4, mood: '转圈开心' })
        await sleep(1400)
        setActionState('idle')
      } else if (act.type === 'sleep') {
        setActionState('sleep')
        bumpStats({ energy: 12, mood: '小憩充电' })
      } else if (act.type === 'happy') {
        setActionState('happy')
        await sleep(850)
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

  const updateAvatarPatch = (patch) => setAvatar((prev) => saveCompanionAvatar({ ...prev, ...patch }))
  const updateConfigPatch = (patch) => setConfig((prev) => saveCompanionConfig({ ...prev, ...patch }))

  if (!config.visible) return null

  const driveLabel = config.fullLlmDrive
    ? '⚡ 完全大模型驱动'
    : (config.autopilotEnabled !== false ? '🤖 全自动总管' : '🛡 纯本地离线')
  const lv = affectionLevel(stats.affection)
  const pomoLabel = pomodoroSec > 0
    ? `${String(Math.floor(pomodoroSec / 60)).padStart(2, '0')}:${String(pomodoroSec % 60).padStart(2, '0')}`
    : ''

  return (
    <div className="cp-root" data-companion-root="true">
      {/* 抛出的星晶小游戏道具 */}
      {starToy && (
        <div className="cp-star-toy" style={{ transform: `translate3d(${starToy.x.toFixed(1)}px, ${starToy.y.toFixed(1)}px, 0)` }} aria-hidden="true">
          ⭐
        </div>
      )}

      {/* 大肥鱼 / 鲸鱼娘 / 二次元 3D 可拎起互动桌宠主体 */}
      <div
        className="cp-actor"
        data-companion-actor="true"
        data-body-form={avatar.bodyForm || 'dafeiyu'}
        data-action={actionState}
        data-dragging={String(isDraggingPet)}
        style={{ transform: `translate3d(${pos.x.toFixed(1)}px, ${pos.y.toFixed(1)}px, 0)` }}
        title={`左键打开全自动总管聊天 · 按住可拎起拖动甩飞 · 双击转圈跳舞 · 右键变身与换装`}
        onPointerDown={handleActorPointerDown}
        onClick={(e) => {
          e.stopPropagation()
          if (suppressClickRef.current) return
          setCtxMenu(null)
          // 醒来 + 按触碰区域给出摸头/戳肚皮趣味反馈，并打开/切换协助面板
          const rect = e.currentTarget.getBoundingClientRect()
          const relY = rect && rect.height ? (e.clientY - rect.top) / rect.height : 0.5
          if (!chatOpen && !busyTaskRef.current) {
            if (relY < 0.42) {
              setActionState('pat')
              bumpStats({ affection: 5, headPats: 1, mood: '被摸头好开心' })
              say('嘿嘿～摸摸头最舒服啦 ♡ 有什么任务直接吩咐我！', 2800)
              setTimeout(() => { if (!busyTaskRef.current) setActionState('idle') }, 900)
            } else {
              setActionState('poke')
              say('哎呀别戳我软软的大肚皮啦～要给我派任务吗？', 2600)
              setTimeout(() => { if (!busyTaskRef.current) setActionState('idle') }, 700)
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
          setCtxMenu({ x: Math.min(vw - 262, Math.max(12, e.clientX)), y: Math.min(vh - 390, Math.max(12, e.clientY - 140)) })
        }}
      >
        {speech && <div className="cp-speech">{speech}</div>}
        <Companion3DCanvas
          avatar={avatar}
          actionState={actionState}
          facing={facing}
          lookX={look.x}
          lookY={look.y}
          dragTilt={dragTilt}
          size={146}
        />
        <span className="cp-name-tag">
          <span>{avatar.bodyForm === 'dafeiyu' ? '🐳' : '✦'} {avatar.name || '大肥鱼'}</span>
          <span className="cp-lv-badge">Lv.{lv}</span>
          {pomoLabel && <span className="cp-lv-badge">🍅{pomoLabel}</span>}
        </span>
      </div>

      {/* 黑洞飞出的发光文件球 */}
      {flyingOrb && (
        <div className="cp-file-orb" style={{ transform: `translate3d(${flyingOrb.x.toFixed(1)}px, ${flyingOrb.y.toFixed(1)}px, 0)` }}>
          {flyingOrb.label}
        </div>
      )}

      {/* 左键展开的液态玻璃「全自动总管 & 互动陪伴」小窗 */}
      {chatOpen && (
        <section className="cp-chat" aria-label="大肥鱼全自动总管协作面板" onClick={(e) => e.stopPropagation()}>
          <div className="cp-chat-head">
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
              <strong style={{ fontSize: 13 }}>{avatar.bodyForm === 'dafeiyu' ? '🐳' : '🎀'} {avatar.name || '大肥鱼'}</strong>
              <span className="cp-mode-pill">{driveLabel}</span>
            </div>
            <div style={{ display: 'flex', gap: 5 }}>
              <button type="button" className="cp-mini-btn" title="大肥鱼本尊 ↔ 鲸鱼娘一键变身" onClick={() => executeAction({ type: 'morph_form' })}>🔄 变身</button>
              <button type="button" className="cp-mini-btn" onClick={() => setCustomizer({ open: true, tab: 'avatar' })}>🎨 工坊</button>
              <button type="button" className="cp-mini-btn" onClick={() => setChatOpen(false)} aria-label="关闭助手聊天">×</button>
            </div>
          </div>

          <div className="cp-stats-bar">
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              <span className="cp-stat-pill">♡ Lv.{lv} ({stats.affection})</span>
              <span className="cp-stat-pill">🐟 饱食 {stats.energy}%</span>
              <span className="cp-stat-pill">📦 交稿 {stats.tasksDelivered}</span>
            </div>
            <button type="button" className="cp-mini-btn" data-active={String(snackBarOpen)} onClick={() => setSnackBarOpen((v) => !v)}>
              🐟 投喂
            </button>
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
                  <button
                    type="button"
                    className="cp-mini-btn"
                    onClick={() => { autopilotCancelRef.current = true; setAutopilotHud(null) }}
                  >
                    停止监工
                  </button>
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

          <div className="cp-quick-row">
            <button
              type="button"
              className="cp-mini-btn"
              data-active="true"
              onClick={() => handleSendChat('帮我制定一份新产品的全栈架构设计与上线验收方案', { forceAutopilot: true })}
            >
              🤖 全自动代办交稿
            </button>
            <button type="button" className="cp-mini-btn" onClick={() => performStarCatchGame()}>⭐ 丢星星逗它接</button>
            <button type="button" className="cp-mini-btn" onClick={() => handleSendChat('帮我把被啃掉和碎裂的玻璃修补好')}>🛠 修补玻璃</button>
            <button type="button" className="cp-mini-btn" onClick={() => handleSendChat('用黑洞帮我把 需求规格.md 放进聊天框')}>🌀 黑洞取文件</button>
            <button
              type="button"
              className="cp-mini-btn"
              onClick={() => {
                if (pomodoroSec > 0) { setPomodoroSec(0); say('番茄钟已结束，随时叫我～') }
                else { setPomodoroSec(25 * 60); setActionState('supervising'); say('🍅 25 分钟专注模式开启！我戴上眼镜安静陪你～') }
              }}
            >
              {pomodoroSec > 0 ? `🍅 停止(${pomoLabel})` : '🍅 番茄钟'}
            </button>
          </div>

          <div className="cp-chat-foot">
            <input
              className="cp-chat-input"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSendChat() }}
              placeholder="直接发需求让我全自动选模块/专家/工作流交稿…"
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

      {/* 右键液态玻璃快捷菜单 */}
      {ctxMenu && (
        <div className="cp-ctx" role="menu" aria-label="3D 助手右键菜单" style={{ left: `${ctxMenu.x}px`, top: `${ctxMenu.y}px` }} onClick={(e) => e.stopPropagation()}>
          <button type="button" className="cp-ctx-item" onClick={() => { setCtxMenu(null); setCustomizer({ open: true, tab: 'avatar' }) }}>
            <span>🎨 形象工坊与捏脸换装</span><span>→</span>
          </button>
          <button type="button" className="cp-ctx-item" onClick={() => { setCtxMenu(null); executeAction({ type: 'morph_form' }) }}>
            <span>🔄 一键变身（大肥鱼 ↔ 鲸鱼娘）</span><span>✨</span>
          </button>
          <button type="button" className="cp-ctx-item" onClick={() => { setCtxMenu(null); performStarCatchGame() }}>
            <span>⭐ 丢液态星晶逗它接</span><span>🎮</span>
          </button>
          <button type="button" className="cp-ctx-item" onClick={() => { setCtxMenu(null); executeAction({ type: 'repair_all' }) }}>
            <span>🛠 修补被啃/碎裂的玻璃</span><span>✨</span>
          </button>
          <div className="cp-ctx-div" />
          <button type="button" className="cp-ctx-item" data-active={String(config.autopilotEnabled !== false)} onClick={() => {
            const next = config.autopilotEnabled === false
            updateConfigPatch({ autopilotEnabled: next })
            pushToast(next ? '已开启「全自动无人驾驶总管」：发需求自动选模块/专家/工作流监工交稿' : '已关闭自动派单，仅手动指令触发', 'info')
            setCtxMenu(null)
          }}>
            <span>🤖 全自动无人驾驶接管</span><span>{config.autopilotEnabled !== false ? '开' : '关'}</span>
          </button>
          <button type="button" className="cp-ctx-item" data-active={String(Boolean(config.llmEnabled))} onClick={() => {
            const next = !config.llmEnabled
            updateConfigPatch({ llmEnabled: next, ...(next ? {} : { fullLlmDrive: false }) })
            pushToast(next ? '已为助手开启大模型闲聊与路由增强' : '已切换为纯本地零 Token 驱动', 'info')
            setCtxMenu(null)
          }}>
            <span>🧠 启用大模型使用</span><span>{config.llmEnabled ? '开' : '关'}</span>
          </button>
          <button type="button" className="cp-ctx-item" data-active={String(Boolean(config.fullLlmDrive))} onClick={() => {
            const next = !config.fullLlmDrive
            updateConfigPatch({ fullLlmDrive: next, ...(next ? { llmEnabled: true } : {}) })
            pushToast(next ? '已开启「完全使用大模型驱动」' : '已恢复「本地优先驱动」', 'info')
            setCtxMenu(null)
          }}>
            <span>⚡ 完全使用大模型驱动</span><span>{config.fullLlmDrive ? '开' : '关'}</span>
          </button>
          <button type="button" className="cp-ctx-item" onClick={() => { setCtxMenu(null); setCustomizer({ open: true, tab: 'llm' }) }}>
            <span>⚙ 助手专属大模型设置</span><span>→</span>
          </button>
          <div className="cp-ctx-div" />
          <button type="button" className="cp-ctx-item" onClick={() => {
            setCtxMenu(null)
            setChatOpen(false)
            updateConfigPatch({ visible: false })
            pushToast('已暂时隐藏助手，可在顶栏「工具箱 → 唤出 3D 娱乐协助助手」随时唤回', 'info')
          }}>
            <span>🙈 暂时隐藏助手</span><span>×</span>
          </button>
        </div>
      )}

      {/* 3D 大肥鱼/二次元形象工坊 + 专属大模型弹窗 */}
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
