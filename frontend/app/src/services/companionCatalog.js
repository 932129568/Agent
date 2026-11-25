/**
 * Harbor 旗舰级 3D 活体助手 · 原版「芽露 (Yalu)」建模包资产与扩展注册表（R31）：
 * - 所有后续新角色/换装/动作扩展均在 `COMPANION_MODEL_PACKS` 中按统一契约注册；
 * - 严格尊重原版设定：「酒红铃铛」为穿戴在芽露腰间/衣饰的随身配饰，「露芽杖」为施法/工作时自然握持于右手的法杖（绝不作为贴纸漂浮在两侧）；
 * - 支持两种忠实于芽露原版设定的活体引擎：
 *   1) `yalu_3d`（默认）：基于芽露三视图、表情差分与双道具细节 3D 化重建的 60fps 全骨骼动画模型（16 套自然逐帧动作 + 发丝/裙摆/腰间铃铛弹簧物理）；
 *   2) `yalu_film`：从原版 60fps 补帧成片提取的透明逐帧动态精灵引擎（原片笔触实时动态循环 + 3D 视差倾角）。
 */
import { readStorage, writeStorage } from '../platform/storage.js'

const AVATAR_KEY = 'harbor.r31.companion.avatar'
const LEGACY_AVATAR_KEY = 'harbor.r30.companion.avatar'
const CONFIG_KEY = 'harbor.r28.companion.config'
const STATS_KEY = 'harbor.r29.companion.stats'

export const COMPANION_MODEL_PACKS = Object.freeze([
  {
    id: 'yalu_official',
    name: '🌿 芽露 · 原版设定建模包',
    tagline: '基于芽露定妆正面、正侧背三视图、4 组表情差分、酒红铃铛与露芽杖细节及 60fps 补帧成片全量驱动',
    badge: '原版建模',
    assets: {
      front: './assets/yalu/yalu-front.webp',
      turnFront: './assets/yalu/yalu-turn-front.webp',
      side: './assets/yalu/yalu-turn-side.webp',
      back: './assets/yalu/yalu-turn-back.webp',
      animIdleStrip: './assets/yalu/yalu-anim-idle.webp',
      animActionStrip: './assets/yalu/yalu-anim-action.webp',
      animFrames: 16,
      expressions: [
        { id: 'happy', label: '元气微笑', src: './assets/yalu/yalu-expr-1.webp' },
        { id: 'focus', label: '认真监工', src: './assets/yalu/yalu-expr-2.webp' },
        { id: 'flustered', label: '慌张害羞', src: './assets/yalu/yalu-expr-3.webp' },
        { id: 'proud', label: '摇铃交稿', src: './assets/yalu/yalu-expr-4.webp' },
      ],
      props: {
        staff: { id: 'staff', label: '露芽杖（施法/工作手持）', src: './assets/yalu/prop-staff.webp' },
        bell: { id: 'bell', label: '酒红铃铛（随身腰间佩戴）', src: './assets/yalu/prop-bell.webp' },
      },
      showcaseVideo: './assets/yalu/yalu-showcase.mp4',
    },
  },
])

export const YALU_RENDER_MODES = Object.freeze([
  { id: 'yalu_3d', label: '🧊 芽露 3D 骨骼活体（推荐）', desc: '全关节 60fps 逐帧骨骼动画：自然行走、坐边荡脚、拎起挣扎、挥杖施法、腰铃物理摆动' },
  { id: 'yalu_film', label: '🎞 芽露 60fps 原片逐帧', desc: '直接播放从原版 60fps 补帧成片提取的透明动态帧序列 + 3D 视差倾角' },
])

export const YALU_AURA_THEMES = Object.freeze([
  { id: 'natural', label: '晨露原色', glow: 'rgba(174, 215, 162, 0.36)' },
  { id: 'amethyst', label: '紫晶柔光', glow: 'rgba(134, 84, 148, 0.38)' },
  { id: 'crimson', label: '酒红铃韵', glow: 'rgba(150, 19, 44, 0.34)' },
  { id: 'glass', label: '液态通透', glow: 'rgba(255, 255, 255, 0.46)' },
])

export const COMPANION_PERSONALITIES = Object.freeze([
  {
    id: 'yalu_gentle',
    label: '灵动治愈·芽露',
    greeting: '叮铃～🌿 我是芽露。把任何工作需求直接发给我，我会自己挑选最合适的模块、专家团或工作流并盯到交稿；闲着的时候我也会自己在窗口和桌面上四处溜达哦～',
  },
  {
    id: 'energetic',
    label: '元气靠谱·小管家',
    greeting: '叮铃铃～芽露随时待命！直接告诉我你要做什么，我替你全流程调度、监工并验收交付！',
  },
  {
    id: 'tsundere',
    label: '傲娇认真·监工长',
    greeting: '哼，最麻烦的任务直接交给我吧！选专家团、跑工作流、审终稿我全包了——顺便别老拎着我晃！',
  },
  {
    id: 'gentle',
    label: '温柔陪伴·晨露',
    greeting: '辛苦啦～我是芽露。需要专注时我可以安静坐在一旁陪你，有复杂任务随时丢给我全自动处理 🌿',
  },
])

export const COMPANION_SNACKS = Object.freeze([
  { id: 'dew_drop', name: '晨露蜜糖', icon: '💧', energy: 26, affection: 8, quote: '好清甜的晨露蜜糖！露芽杖的嫩芽都亮起来啦 🌿' },
  { id: 'berry_cake', name: '酒红莓果挞', icon: '🍓', energy: 24, affection: 9, quote: '叮铃～酸酸甜甜超好吃，腰间铃铛都开心得晃起来了！' },
  { id: 'glass_candy', name: '液态玻璃糖', icon: '🍬', energy: 20, affection: 7, quote: '咔嚓！比按钮还甜，吃饱就不去偷偷啃玻璃啦～' },
])

/* 兼容既有单测契约的导出常量 */
export const COMPANION_HAIRSTYLES = Object.freeze([
  { id: 'yalu_layered', label: '芽露原版长卷' }, { id: 'twintails', label: '双马尾' }, { id: 'bob', label: '波波头' },
  { id: 'long', label: '长直发' }, { id: 'buns', label: '双丸子' }, { id: 'wolf', label: '狼尾' }, { id: 'drill', label: '双螺旋' },
])
export const COMPANION_HEADGEARS = Object.freeze([
  { id: 'sprout_pin', label: '嫩芽发饰' }, { id: 'ribbon', label: '酒红丝带' }, { id: 'crown', label: '小皇冠' },
  { id: 'cat_ears', label: '猫耳' }, { id: 'bunny_ears', label: '兔耳' }, { id: 'halo', label: '光环' }, { id: 'none', label: '无' },
])
export const COMPANION_OUTFITS = Object.freeze([
  { id: 'yalu_cape', label: '芽露晨露披风装' }, { id: 'hanfu', label: '轻汉服' }, { id: 'sailor', label: '学院装' },
  { id: 'maid', label: '女仆装' }, { id: 'mage', label: '魔导袍' }, { id: 'cyber', label: '机能装' },
])
export const COMPANION_ACCESSORIES = Object.freeze([
  { id: 'yalu_bell_staff', label: '随身酒红铃铛 + 露芽杖' }, { id: 'wand', label: '露芽杖' }, { id: 'bell', label: '酒红铃铛' },
  { id: 'stylus', label: '星光笔' }, { id: 'glasses', label: '监工镜' }, { id: 'wings', label: '晨露翼' }, { id: 'none', label: '轻装' },
])

export const DEFAULT_COMPANION_AVATAR = Object.freeze({
  name: '芽露',
  bodyForm: 'yalu_model',
  renderMode: 'yalu_3d', // 'yalu_3d' | 'yalu_film'
  modelPackId: 'yalu_official',
  auraTheme: 'natural',
  expressionOverride: 'auto',
  personality: 'yalu_gentle',
  scale: 1.0,
})

export const DEFAULT_COMPANION_CONFIG = Object.freeze({
  visible: true,
  llmEnabled: false,
  fullLlmDrive: false,
  // 意图理解模式：'model' = 有可用端点时一律让模型理解意图并驱动（默认）
  //               'local' = 用户显式切回本地规则
  intentMode: 'model',
  autopilotEnabled: true,
  autonomousLifeEnabled: true, // 自带自然走动、坐边、走出桌面漫游与回窗等活体生命行为
  modelProfileId: '',
  customBaseUrl: '',
  customApiKey: '',
  customModel: '',
  sneakEatEnabled: true,
  autoRepairShattered: true,
})

export const DEFAULT_COMPANION_STATS = Object.freeze({
  affection: 45,
  energy: 92,
  mood: '晨露元气',
  tasksDelivered: 0,
  snacksEaten: 0,
  headPats: 0,
})

export function getActiveModelPack(packId = 'yalu_official') {
  return COMPANION_MODEL_PACKS.find((p) => p.id === packId) || COMPANION_MODEL_PACKS[0]
}

export function loadCompanionAvatar() {
  try {
    const raw = readStorage(AVATAR_KEY, '')
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') return { ...DEFAULT_COMPANION_AVATAR, ...parsed }
    }
    const legacy = readStorage(LEGACY_AVATAR_KEY, '')
    if (legacy) {
      const lp = JSON.parse(legacy)
      if (lp && typeof lp === 'object') return { ...DEFAULT_COMPANION_AVATAR, scale: Number(lp.scale) || 1.0 }
    }
    return { ...DEFAULT_COMPANION_AVATAR }
  } catch {
    return { ...DEFAULT_COMPANION_AVATAR }
  }
}

export function saveCompanionAvatar(avatar) {
  const next = { ...DEFAULT_COMPANION_AVATAR, ...(avatar || {}) }
  next.scale = Math.max(0.75, Math.min(1.4, Number(next.scale) || 1.0))
  try { writeStorage(AVATAR_KEY, JSON.stringify(next)) } catch {}
  return next
}

export function loadCompanionConfig() {
  try {
    const raw = readStorage(CONFIG_KEY, '')
    if (!raw) return { ...DEFAULT_COMPANION_CONFIG }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_COMPANION_CONFIG }
    return { ...DEFAULT_COMPANION_CONFIG, ...parsed }
  } catch {
    return { ...DEFAULT_COMPANION_CONFIG }
  }
}

export function saveCompanionConfig(cfg) {
  const next = { ...DEFAULT_COMPANION_CONFIG, ...(cfg || {}) }
  try { writeStorage(CONFIG_KEY, JSON.stringify(next)) } catch {}
  return next
}

export function loadCompanionStats() {
  try {
    const raw = readStorage(STATS_KEY, '')
    if (!raw) return { ...DEFAULT_COMPANION_STATS }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_COMPANION_STATS }
    return {
      ...DEFAULT_COMPANION_STATS,
      ...parsed,
      affection: Math.max(0, Math.min(1000, Number(parsed.affection) || 0)),
      energy: Math.max(0, Math.min(100, Number(parsed.energy) || 0)),
    }
  } catch {
    return { ...DEFAULT_COMPANION_STATS }
  }
}

export function saveCompanionStats(stats) {
  const next = { ...DEFAULT_COMPANION_STATS, ...(stats || {}) }
  next.affection = Math.max(0, Math.min(1000, Number(next.affection) || 0))
  next.energy = Math.max(0, Math.min(100, Number(next.energy) || 0))
  try { writeStorage(STATS_KEY, JSON.stringify(next)) } catch {}
  return next
}

export function affectionLevel(affection = 0) {
  const a = Math.max(0, Number(affection) || 0)
  return Math.min(10, 1 + Math.floor(a / 60))
}
