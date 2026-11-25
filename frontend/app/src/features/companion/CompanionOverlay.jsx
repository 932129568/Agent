import { useEffect, useRef, useState } from 'react'
import {
  useSlice,
  setActivePanel,
  setComposerDraft,
  addComposerToken,
  fireShellImpact,
  pushToast,
} from '../../state/store.js'
import {
  COMPANION_PERSONALITIES,
  loadCompanionAvatar,
  saveCompanionAvatar,
  loadCompanionConfig,
  saveCompanionConfig,
} from '../../services/companionCatalog.js'
import { askCompanionBrain } from '../../services/companionBrain.js'
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
} from '../../platform/dom.js'
import { computeViewportCoords } from '../../platform/kinetic.js'
import Companion3DCanvas from '../../ui/Companion3DCanvas.jsx'
import CompanionCustomizer from './CompanionCustomizer.jsx'
import './CompanionOverlay.css'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
  const [pos, setPos] = useState(() => ({
    x: Math.max(120, ((typeof window !== 'undefined' && window.innerWidth) || 1280) - 160),
    y: Math.max(120, ((typeof window !== 'undefined' && window.innerHeight) || 800) - 168),
  }))
  const [facing, setFacing] = useState(-1)
  const [look, setLook] = useState({ x: 0, y: 0 })
  const [actionState, setActionState] = useState('idle')
  const [speech, setSpeech] = useState('')
  const [chatOpen, setChatOpen] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [messages, setMessages] = useState(() => {
    const p = COMPANION_PERSONALITIES.find((x) => x.id === loadCompanionAvatar().personality) || COMPANION_PERSONALITIES[0]
    return [{ id: 'm0', role: 'assistant', text: p.greeting, engine: 'local' }]
  })
  const [ctxMenu, setCtxMenu] = useState(null) // { x, y }
  const [customizer, setCustomizer] = useState({ open: false, tab: 'avatar' })
  const [flyingOrb, setFlyingOrb] = useState(null) // { label, x, y }

  const posRef = useRef(pos)
  posRef.current = pos
  const busyTaskRef = useRef(false)
  const speechTimerRef = useRef(0)

  const say = (text, ms = 3600) => {
    setSpeech(text)
    if (speechTimerRef.current) clearTimeout(speechTimerRef.current)
    speechTimerRef.current = setTimeout(() => setSpeech(''), ms)
  }

  // 外部工具箱按钮触发重新唤出助手
  useEffect(() => {
    if (forceOpenSignal > 0) {
      const next = saveCompanionConfig({ ...config, visible: true })
      setConfig(next)
      say('我回来啦～随时待命！', 2600)
    }
  }, [forceOpenSignal])

  // 柔和视线追踪鼠标
  useEffect(() => {
    if (!config.visible) return undefined
    const onMove = (e) => {
      const cur = posRef.current
      const dx = e.clientX - (cur.x + 68)
      const dy = e.clientY - (cur.y + 52)
      setLook({
        x: Math.max(-1, Math.min(1, dx / 360)),
        y: Math.max(-1, Math.min(1, dy / 280)),
      })
    }
    const onDown = () => setCtxMenu(null)
    globalThis.addEventListener('pointermove', onMove, { passive: true })
    globalThis.addEventListener('pointerdown', onDown)
    return () => {
      globalThis.removeEventListener('pointermove', onMove)
      globalThis.removeEventListener('pointerdown', onDown)
    }
  }, [config.visible])

  // 平滑小跑移动到目标屏幕坐标 (tx, ty)
  const walkTo = async (tx, ty, runState = 'run', durationMs = 760) => {
    const start = { ...posRef.current }
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
    const destX = Math.max(12, Math.min(vw - 144, tx - 68))
    const destY = Math.max(24, Math.min(vh - 146, ty - 96))
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
    await walkTo(vw - 92, vh - 72, 'run', 680)
    setFacing(-1)
    setActionState('idle')
  }

  // 动作 1：小跑过去在目标方块那里蹲下去点击！
  const performCrouchClick = async (targetHint, label = '') => {
    const hit = findUiControlByHint(targetHint)
    if (!hit) {
      if (['chat', 'group', 'workflow', 'workspace'].includes(targetHint)) setActivePanel(targetHint)
      setActionState('happy')
      say(`已为你切换到「${label || targetHint}」～`)
      await sleep(900)
      setActionState('idle')
      return
    }
    say(`哒哒哒～跑去帮你点「${label || targetHint}」！`)
    await walkTo(hit.cx + 28, hit.cy + 16, 'run', 720)
    setFacing(hit.cx >= posRef.current.x + 68 ? 1 : -1)
    setActionState('crouch_click')
    await sleep(340)
    triggerUiControlClick(targetHint)
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
    const vp = computeViewportCoords(hit.cx, hit.cy, vw, vh)
    fireShellImpact('pointer', 'medium', { nx: vp.nx, ny: vp.ny, pointer: true })
    await sleep(420)
    setActionState('happy')
    say(`点好啦！我已经帮你打开「${label || targetHint}」咯 ✨`)
    await sleep(650)
    await returnToCorner()
  }

  // 动作 2：跑到输入框前面面向输入框拿起笔手写！
  const performWriteInput = async (textToWrite) => {
    setActivePanel('chat')
    await sleep(140)
    const hit = focusComposerInput()
    say('拿好发光小笔，跑去输入框帮你手写～')
    if (hit) await walkTo(hit.x + 110, hit.y + 12, 'run', 720)
    setActionState('write_input')
    const full = String(textToWrite || '')
    const step = Math.max(1, Math.ceil(full.length / 24))
    let cur = ''
    for (let i = 0; i < full.length; i += step) {
      cur = full.slice(0, i + step)
      setComposerDraft(cur)
      await sleep(48)
    }
    setComposerDraft(full)
    setActionState('happy')
    say('手写完毕！按回车就能直接发送咯 ✍️')
    await sleep(700)
    await returnToCorner()
  }

  // 动作 3：原地站着施展魔法召唤黑洞 → 伸手进去掏出文件 → 放到聊天框！
  const performBlackHoleMagic = async (fileName = '项目核心说明.md') => {
    setActivePanel('chat')
    setActionState('magic_blackhole')
    say(`空间魔法·微型黑洞展开！正在伸手把「${fileName}」掏出来…`, 4200)
    await sleep(980)
    const startX = posRef.current.x + (facing > 0 ? 105 : 25)
    const startY = posRef.current.y + 52
    const composerHit = findUiControlByHint('composer')
    const endX = composerHit ? composerHit.cx : Math.max(240, ((typeof window !== 'undefined' && window.innerWidth) || 1280) * 0.5)
    const endY = composerHit ? composerHit.cy : Math.max(300, ((typeof window !== 'undefined' && window.innerHeight) || 800) - 96)

    // 光球从黑洞飞入聊天框！
    for (let i = 0; i <= 18; i++) {
      const u = i / 18
      const ease = 1 - Math.pow(1 - u, 2.5)
      const arc = Math.sin(u * Math.PI) * -58
      setFlyingOrb({ label: `📄 ${fileName}`, x: startX + (endX - startX) * ease, y: startY + (endY - startY) * ease + arc })
      await sleep(24)
    }
    setFlyingOrb(null)
    addComposerToken({
      id: `bh_${Date.now()}`,
      name: `黑洞文件 · ${fileName}`,
      kind: 'file',
      prompt: `【来自 3D 助手黑洞传送的参考文件：${fileName}】请结合该文件上下文分析并响应用户需求。`,
    })
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
    const vp = computeViewportCoords(endX, endY, vw, vh)
    fireShellImpact('pointer', 'medium', { nx: vp.nx, ny: vp.ny, pointer: true })
    setActionState('happy')
    say(`搞定！「${fileName}」已经从黑洞拿出来放进聊天框啦 🌀`)
    pushToast(`3D 助手已通过黑洞魔法将「${fileName}」放入输入框`, 'ok')
    await sleep(800)
    setActionState('idle')
  }

  // 动作 4：修补被偷啃或碎裂的液态玻璃（先拾碎片再回原位，修补进度与玻璃本体 100% 同步！）
  const performRepairAll = async (isAutoPassive = false) => {
    const store = sandboxStoreRef && sandboxStoreRef.current
    if (!store) return
    const damaged = Array.from(store.bodies.values()).filter(
      (b) => b.status === 'shattered' || b.biteNotches.length > 0 || b.cracks.length > 0
    )
    if (damaged.length === 0) return

    for (const b of damaged) {
      if (b.status === 'shattered') {
        say(isAutoPassive ? `哎呀「${b.label}」碎了一地！我去把碎片收拾起来修补好～` : `正在小跑去捡「${b.label}」的玻璃碎片…`)
        const firstShard = b.shards[0]
        if (firstShard) {
          await walkTo(firstShard.x, firstShard.y, 'run', 760)
          setActionState('collect_shards')
          for (const sh of b.shards) {
            sh.collected = true
            if (typeof onForceRefreshSandbox === 'function') onForceRefreshSandbox()
            await sleep(55)
          }
          say('碎片收好啦！抱着碎片跑回原位修补～')
        }
        await walkTo(b.origin.x + b.origin.w / 2 + 24, b.origin.y + b.origin.h / 2 + 12, 'collect_shards', 720)
      } else {
        say(`乖乖跑去把啃掉的「${b.label}」修补回亮晶晶的样子…`)
        await walkTo(b.x + b.w / 2 + 24, b.y + b.h / 2 + 12, 'run', 720)
      }

      startRepairBody(store, b.id)
      setActionState('repair_glass')
      for (let step = 1; step <= 20; step++) {
        setRepairProgress(store, b.id, step / 20)
        if (typeof onForceRefreshSandbox === 'function') onForceRefreshSandbox()
        await sleep(85)
      }
      setGlassSourceVisibility(b.id, true)
      if (typeof onForceRefreshSandbox === 'function') onForceRefreshSandbox()
      setActionState('happy')
      say(`「${b.label}」已经慢慢凝聚修补完好啦 ✨`)
      await sleep(520)
    }
    await returnToCorner()
  }

  // 被动效果：当用户甩碎任意液态玻璃方块后，随机 5–9 秒后助手自动小跑去拾碎片并带回原位慢慢修补！
  useEffect(() => {
    if (!shatterSignal || !config.visible || config.autoRepairShattered === false) return undefined
    const delayMs = 5200 + Math.round(Math.random() * 4200)
    const timer = setTimeout(() => {
      if (busyTaskRef.current) return
      busyTaskRef.current = true
      performRepairAll(true).finally(() => { busyTaskRef.current = false })
    }, delayMs)
    return () => clearTimeout(timer)
  }, [shatterSignal, config.visible, config.autoRepairShattered])

  // 趣味习性：空闲时偶尔偷偷溜过去啃一口液态玻璃（留下真实咬痕，不会自动恢复，需互动让助手来修！）
  useEffect(() => {
    if (!config.visible || config.sneakEatEnabled === false || settings.motion === 'reduced') return undefined
    const timer = setInterval(async () => {
      if (busyTaskRef.current || chatOpen || customizer.open) return
      const store = sandboxStoreRef && sandboxStoreRef.current
      if (!store) return
      const candidates = collectVisibleGlassBlocks().filter((c) => !store.bodies.has(c.id))
      if (candidates.length === 0) return
      const pick = candidates[Math.floor(Math.random() * candidates.length)]
      busyTaskRef.current = true
      try {
        say(`悄悄溜过去…「${pick.label}」看起来好脆好好吃！`, 2600)
        await walkTo(pick.x + pick.w / 2 + 24, pick.y + pick.h / 2 + 12, 'run', 820)
        setActionState('sneak_eat')
        await sleep(900)
        biteGlassBody(store, pick)
        if (typeof onForceRefreshSandbox === 'function') onForceRefreshSandbox()
        setActionState('guilty')
        say(`啊呜！偷偷啃了一口「${pick.label}」（不会自己恢复哦，点我喊我修补～）`, 4200)
        await sleep(900)
        await returnToCorner()
      } finally {
        busyTaskRef.current = false
      }
    }, 34000)
    return () => clearInterval(timer)
  }, [config.visible, config.sneakEatEnabled, settings.motion, chatOpen, customizer.open])

  const executeAction = async (act) => {
    if (!act || busyTaskRef.current) return
    if (act.type === 'open_customizer') {
      setCustomizer({ open: true, tab: 'avatar' })
      return
    }
    busyTaskRef.current = true
    try {
      if (act.type === 'crouch_click') await performCrouchClick(act.target, act.label)
      else if (act.type === 'write_input') await performWriteInput(act.text)
      else if (act.type === 'magic_blackhole') await performBlackHoleMagic(act.fileName)
      else if (act.type === 'repair_all') await performRepairAll(false)
      else if (act.type === 'happy') {
        setActionState('happy')
        await sleep(900)
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

  const handleSendChat = async (overrideText = '') => {
    const text = String(overrideText || chatInput).trim()
    if (!text || chatBusy) return
    setChatInput('')
    const userMsg = { id: `u_${Date.now()}`, role: 'user', text }
    setMessages((prev) => [...prev.slice(-16), userMsg])
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
    : (config.llmEnabled ? '🧠 本地操作 + 大模型聊天' : '🛡 纯本地离线大脑')

  return (
    <div className="cp-root" data-companion-root="true">
      {/* 3D 可爱二次元助手主体 */}
      <div
        className="cp-actor"
        data-companion-actor="true"
        data-action={actionState}
        style={{ transform: `translate3d(${pos.x.toFixed(1)}px, ${pos.y.toFixed(1)}px, 0)` }}
        title={`左键与「${avatar.name || '米露'}」聊天协作 · 右键切换大模型驱动与 3D 捏脸`}
        onClick={(e) => {
          e.stopPropagation()
          setCtxMenu(null)
          setChatOpen((v) => !v)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
          const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
          setCtxMenu({ x: Math.min(vw - 248, e.clientX), y: Math.min(vh - 310, Math.max(12, e.clientY - 120)) })
        }}
      >
        {speech && <div className="cp-speech">{speech}</div>}
        <Companion3DCanvas avatar={avatar} actionState={actionState} facing={facing} lookX={look.x} lookY={look.y} size={136} />
        <span className="cp-name-tag">✦ {avatar.name || '米露'}</span>
      </div>

      {/* 黑洞飞出的发光文件球 */}
      {flyingOrb && (
        <div className="cp-file-orb" style={{ transform: `translate3d(${flyingOrb.x.toFixed(1)}px, ${flyingOrb.y.toFixed(1)}px, 0)` }}>
          {flyingOrb.label}
        </div>
      )}

      {/* 左键展开的液态玻璃协助聊天窗 */}
      {chatOpen && (
        <section className="cp-chat" aria-label="3D 助手协作对话框" onClick={(e) => e.stopPropagation()}>
          <div className="cp-chat-head">
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <strong style={{ fontSize: 13 }}>🐾 {avatar.name || '米露'}</strong>
              <span className="cp-mode-pill">{driveLabel}</span>
            </div>
            <div style={{ display: 'flex', gap: 5 }}>
              <button type="button" className="cp-mini-btn" onClick={() => setCustomizer({ open: true, tab: 'avatar' })}>🎨 捏脸</button>
              <button type="button" className="cp-mini-btn" onClick={() => setChatOpen(false)} aria-label="关闭助手聊天">×</button>
            </div>
          </div>

          <div className="cp-chat-list">
            {messages.map((m) => (
              <div key={m.id} className="cp-msg" data-role={m.role}>{m.text}</div>
            ))}
          </div>

          <div className="cp-quick-row">
            <button type="button" className="cp-mini-btn" onClick={() => handleSendChat('帮我把被啃掉和碎裂的玻璃修补好')}>🛠 修补玻璃</button>
            <button type="button" className="cp-mini-btn" onClick={() => handleSendChat('帮我打开系统设置')}>⚙ 代开设置</button>
            <button type="button" className="cp-mini-btn" onClick={() => handleSendChat('帮我写：请帮我设计一套高并发微服务架构')}>✍️ 拿笔手写</button>
            <button type="button" className="cp-mini-btn" onClick={() => handleSendChat('用黑洞帮我把 需求规格.md 放进聊天框')}>🌀 黑洞取文件</button>
            <button type="button" className="cp-mini-btn" onClick={() => handleSendChat('我是小白，Harbor 怎么用？')}>📘 新手教学</button>
          </div>

          <div className="cp-chat-foot">
            <input
              className="cp-chat-input"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSendChat() }}
              placeholder={`吩咐 ${avatar.name || '米露'} 操作软件、答疑或修补玻璃…`}
            />
            <button type="button" className="cp-mini-btn" style={{ background: 'var(--primary)', color: 'var(--on-primary)', borderColor: 'var(--primary)' }} disabled={chatBusy} onClick={() => handleSendChat()}>
              发送
            </button>
          </div>
        </section>
      )}

      {/* 右键液态玻璃快捷菜单（独立开关大模型 & 完全大模型驱动！） */}
      {ctxMenu && (
        <div className="cp-ctx" role="menu" aria-label="3D 助手右键菜单" style={{ left: `${ctxMenu.x}px`, top: `${ctxMenu.y}px` }} onClick={(e) => e.stopPropagation()}>
          <button type="button" className="cp-ctx-item" onClick={() => { setCtxMenu(null); setCustomizer({ open: true, tab: 'avatar' }) }}>
            <span>🎨 3D 捏脸与换装工坊</span><span>→</span>
          </button>
          <button type="button" className="cp-ctx-item" onClick={() => { setCtxMenu(null); executeAction({ type: 'repair_all' }) }}>
            <span>🛠 修补被啃/碎裂的玻璃</span><span>✨</span>
          </button>
          <button type="button" className="cp-ctx-item" onClick={() => { setCtxMenu(null); executeAction({ type: 'magic_blackhole', fileName: '架构白皮书.md' }) }}>
            <span>🌀 黑洞魔法取文件演示</span><span>⚡</span>
          </button>
          <div className="cp-ctx-div" />
          <button type="button" className="cp-ctx-item" data-active={String(Boolean(config.llmEnabled))} onClick={() => {
            const next = !config.llmEnabled
            updateConfigPatch({ llmEnabled: next, ...(next ? {} : { fullLlmDrive: false }) })
            pushToast(next ? '已为 3D 助手开启大模型闲聊（软件操作仍本地优先）' : '已切换为 3D 助手纯本地驱动（零 Token）', 'info')
            setCtxMenu(null)
          }}>
            <span>🧠 启用大模型使用</span><span>{config.llmEnabled ? '开' : '关'}</span>
          </button>
          <button type="button" className="cp-ctx-item" data-active={String(Boolean(config.fullLlmDrive))} onClick={() => {
            const next = !config.fullLlmDrive
            updateConfigPatch({ fullLlmDrive: next, ...(next ? { llmEnabled: true } : {}) })
            pushToast(next ? '已开启「完全使用大模型驱动」：由专属大模型全面接管动作决策' : '已恢复「本地优先驱动」：操作与指引本地秒响应', 'info')
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
            pushToast('已暂时隐藏 3D 助手，可在顶栏「工具箱」随时唤回', 'info')
          }}>
            <span>🙈 暂时隐藏助手</span><span>×</span>
          </button>
        </div>
      )}

      {/* 3D 捏脸换装 + 专属大模型弹窗 */}
      <CompanionCustomizer
        open={customizer.open}
        initialTab={customizer.tab}
        avatar={avatar}
        config={config}
        savedModels={settings.savedModels || []}
        defaultModel={settings.backendConfig.provider_model || settings.backendConfig.model || 'glm-4.5-flash'}
        onUpdateAvatar={updateAvatarPatch}
        onUpdateConfig={updateConfigPatch}
        onClose={() => setCustomizer({ ...customizer, open: false })}
      />
    </div>
  )
}
