/**
 * Harbor 旗舰级 3D 互动桌宠与全自动监工助手 · 原版「芽露」建模包资产体系与扩展注册表（R30）：
 * - 以后所有新角色/换装/道具建模均在 `COMPANION_MODEL_PACKS` 中按统一契约扩展，无需重写渲染引擎；
 * - 默认旗舰角色为「芽露 (Yalu)」原版建模包：完整接入正面定妆立绘、正/侧/背三视图、4 组表情差分、
 *   专属双道具（露芽杖 + 酒红铃铛）与 60fps 补帧成片；
 * - 同时保留旧版 Canvas 扩展形态作为可选皮肤，100% 兼容既有单测与历史存档平滑迁移。
 */
import { readStorage, writeStorage } from '../platform/storage.js'

const AVATAR_KEY = 'harbor.r30.companion.avatar'
const LEGACY_AVATAR_KEY = 'harbor.r28.companion.avatar'
const CONFIG_KEY = 'harbor.r28.companion.config'
const STATS_KEY = 'harbor.r29.companion.stats'

export const COMPANION_MODEL_PACKS = Object.freeze([
  {
    id: 'yalu_official',
    name: '🌿 芽露 · 原版精绘建模',
    tagline: '自带正/侧/背三视图、4 组表情差分、露芽杖 & 酒红铃铛双道具与 60fps 补帧成片',
    badge: '原版建模',
    assets: {
      front: './assets/yalu/yalu-front.webp',
      turnFront: './assets/yalu/yalu-turn-front.webp',
      side: './assets/yalu/yalu-turn-side.webp',
      back: './assets/yalu/yalu-turn-back.webp',
      expressions: [
        { id: 'happy', label: '元气微笑', src: './assets/yalu/yalu-expr-1.webp' },
        { id: 'focus', label: '认真监工', src: './assets/yalu/yalu-expr-2.webp' },
        { id: 'flustered', label: '慌张害羞', src: './assets/yalu/yalu-expr-3.webp' },
        { id: 'proud', label: '摇铃交稿', src: './assets/yalu/yalu-expr-4.webp' },
      ],
      props: {
        staff: { id: 'staff', label: '🌿 露芽杖', src: './assets/yalu/prop-staff.webp' },
        bell: { id: 'bell', label: '🔔 酒红铃铛', src: './assets/yalu/prop-bell.webp' },
      },
      showcaseVideo: './assets/yalu/yalu-showcase.mp4',
    },
  },
])

export const YALU_PROP_LOADOUTS = Object.freeze([
  { id: 'both', label: '🌿 露芽杖 + 🔔 酒红铃铛（双持）' },
  { id: 'staff', label: '🌿 仅持露芽杖' },
  { id: 'bell', label: '🔔 仅挂酒红铃铛' },
  { id: 'none', label: '✨ 轻装无道具' },
])

export const YALU_AURA_THEMES = Object.freeze([
  { id: 'natural', label: '原版晨露光', filter: 'none', glow: 'rgba(130, 212, 168, 0.36)' },
  { id: 'starlight', label: '星穹微光', filter: 'saturate(1.08) brightness(1.04)', glow: 'rgba(96, 190, 250, 0.42)' },
  { id: 'crimson', label: '酒红暖光', filter: 'saturate(1.1) contrast(1.03)', glow: 'rgba(218, 92, 118, 0.40)' },
  { id: 'glass', label: '液态通透', filter: 'brightness(1.06) contrast(1.04)', glow: 'rgba(255, 255, 255, 0.50)' },
])

export const COMPANION_BODY_FORMS = Object.freeze([
  { id: 'yalu_model', label: '🌿 芽露·原版建模 (默认)', desc: '你亲手设计的芽露原版立绘+三视图+表情差分+露芽杖&酒红铃铛+60fps成片' },
  { id: 'dafeiyu', label: '🐳 备用·大肥鱼', desc: '备用皮肤：圆滚滚瓷感胖鲸鱼' },
  { id: 'whale_girl', label: '🎀 备用·鲸鱼娘', desc: '备用皮肤：2.2头身鲸鱼娘' },
  { id: 'liquid_cat', label: '🫧 备用·液态星核喵', desc: '备用皮肤：半透明液态玻璃团子猫' },
])

export const COMPANION_HAIRSTYLES = Object.freeze([
  { id: 'twintails', label: '元气双马尾' },
  { id: 'bob', label: '日系波波头' },
  { id: 'long', label: '星瀑长直发' },
  { id: 'buns', label: '软萌双丸子' },
  { id: 'wolf', label: '飒爽狼尾短发' },
  { id: 'sidetail', label: '俏皮侧马尾' },
  { id: 'drill', label: '大小姐双螺旋' },
])

export const COMPANION_HAIR_COLORS = Object.freeze([
  { id: 'ocean', label: '深海鲸蓝', hex: '#4B8BF5', shade: '#2452B0' },
  { id: 'sky', label: '晴空冰蓝', hex: '#6AC4FA', shade: '#2D7CC2' },
  { id: 'sakura', label: '樱花奶粉', hex: '#F79EC2', shade: '#C55B8A' },
  { id: 'silver', label: '月光冰银', hex: '#D8E3F4', shade: '#8E9FBC' },
  { id: 'honey', label: '蜜糖奶油金', hex: '#F8CE70', shade: '#C48A2B' },
  { id: 'obsidian', label: '星夜墨黑', hex: '#2F384C', shade: '#141925' },
  { id: 'mint', label: '薄荷海盐', hex: '#6BE2C4', shade: '#2A9D82' },
  { id: 'lilac', label: '星穹丁香紫', hex: '#B99CF9', shade: '#7456C6' },
])

export const COMPANION_EYE_STYLES = Object.freeze([
  { id: 'star', label: '星光宝石眼' },
  { id: 'bright', label: '水汪汪圆眼' },
  { id: 'gentle', label: '温柔月牙眼' },
  { id: 'cat', label: '灵动猫系眼' },
  { id: 'heart', label: '甜心星芒眼' },
  { id: 'cool', label: '酷飒冰瞳' },
])

export const COMPANION_EYE_COLORS = Object.freeze([
  { id: 'sapphire', label: '深海蓝', hex: '#257BE8' },
  { id: 'cyan', label: '冰晶青', hex: '#14B8C4' },
  { id: 'amber', label: '琥珀金', hex: '#E69A28' },
  { id: 'rose', label: '蔷薇粉', hex: '#E85C8B' },
  { id: 'emerald', label: '翡翠绿', hex: '#22A874' },
  { id: 'violet', label: '星穹紫', hex: '#8A5CF6' },
  { id: 'crimson', label: '绯红宝石', hex: '#DF4545' },
  { id: 'hetero', label: '异色双瞳', hex: '#257BE8', rightHex: '#F2992E' },
])

export const COMPANION_HEADGEARS = Object.freeze([
  { id: 'whale_spout', label: '喷水小浪花' },
  { id: 'crown', label: '迷你小皇冠' },
  { id: 'sailor_hat', label: '水手贝雷帽' },
  { id: 'cat_ears', label: '软萌猫耳' },
  { id: 'bunny_ears', label: '垂耳兔耳' },
  { id: 'ribbon', label: '大蝴蝶结' },
  { id: 'halo', label: '星辰光环' },
])

export const COMPANION_OUTFITS = Object.freeze([
  { id: 'maid', label: '清甜女仆装', primary: '#253252', accent: '#FFFFFF' },
  { id: 'sailor', label: '深海水手服', primary: '#2E62C8', accent: '#FFFFFF' },
  { id: 'cyber', label: '赛博机能衣', primary: '#1E273B', accent: '#38BDF8' },
  { id: 'mage', label: '星穹魔导袍', primary: '#563DB8', accent: '#F8D064' },
  { id: 'pajama', label: '软糯睡衣', primary: '#7BC8F6', accent: '#FFFDF7' },
  { id: 'hanfu', label: '流光轻汉服', primary: '#E86E58', accent: '#FFF4E8' },
])

export const COMPANION_ACCESSORIES = Object.freeze([
  { id: 'stylus', label: '星光手写笔' },
  { id: 'fish_cookie', label: '小鱼干零食' },
  { id: 'wand', label: '露芽杖' },
  { id: 'bell', label: '酒红铃铛' },
  { id: 'glasses', label: '监工圆眼镜' },
  { id: 'ribbon_tail', label: '发光尾饰' },
  { id: 'wings', label: '精灵翼' },
])

export const COMPANION_SKINS = Object.freeze([
  { id: 'porcelain', label: '瓷白奶油肌', hex: '#FFF2E9' },
  { id: 'peach', label: '蜜桃元气肌', hex: '#FFE4D2' },
  { id: 'warm', label: '暖光杏肌', hex: '#F8D4BA' },
  { id: 'cool', label: '清冷月白肌', hex: '#FBF5F8' },
])

export const COMPANION_PERSONALITIES = Object.freeze([
  {
    id: 'yalu_gentle',
    label: '灵动治愈·芽露',
    greeting: '叮铃铃～🌿 我是你的「芽露」！挥动露芽杖就能帮你全自动挑选专家团、技能或工作流并监工交稿～你也可以直接拎着我走出窗口去桌面散步、摇响酒红铃铛，或者把液态玻璃方块甩出窗外玩哦！',
  },
  {
    id: 'energetic',
    label: '元气靠谱·小管家',
    greeting: '叮铃～元气满满的芽露随时待命！直接发需求给我，我自动调度全站能力盯到交稿！',
  },
  {
    id: 'tsundere',
    label: '傲娇认真·监工长',
    greeting: '叮铃！把最麻烦的需求丢给我吧，选专家团、跑工作流、验收终稿我全包了——不准老拎着我乱甩！',
  },
  {
    id: 'gentle',
    label: '温柔陪伴·晨露',
    greeting: '辛苦啦～我是芽露，累了就点个番茄钟让我安静陪你，有重活全部交给我自动监工吧 🌿',
  },
])

export const COMPANION_SNACKS = Object.freeze([
  { id: 'dew_drop', name: '晨露蜜糖', icon: '💧', energy: 26, affection: 8, quote: '好清甜的晨露蜜糖！露芽杖都亮晶晶的啦 🌿✨' },
  { id: 'berry_cake', name: '酒红莓果挞', icon: '🍓', energy: 24, affection: 9, quote: '叮铃铃～和酒红铃铛一样可爱的莓果挞，超级好吃！' },
  { id: 'glass_candy', name: '液态玻璃糖', icon: '🍬', energy: 20, affection: 7, quote: '咔嚓！比按钮还甜一百倍，饱饱的就不偷啃玻璃啦～' },
  { id: 'star_milk', name: '星穹青提茶', icon: '🧋', energy: 30, affection: 10, quote: '满血复活！我现在能一口气监工十支原生专家团交稿！' },
])

export const COMPANION_PRESETS = Object.freeze([
  {
    id: 'yalu_default',
    name: '🌿 芽露·原版定妆 (默认)',
    avatar: {
      name: '芽露',
      bodyForm: 'yalu_model',
      modelPackId: 'yalu_official',
      propLoadout: 'both',
      auraTheme: 'natural',
      expressionOverride: 'auto',
      hairStyle: 'long',
      hairColor: 'mint',
      eyeStyle: 'star',
      eyeColor: 'emerald',
      headgear: 'ribbon',
      outfit: 'hanfu',
      accessory: 'wand',
      skin: 'porcelain',
      personality: 'yalu_gentle',
      scale: 1.0,
    },
  },
  {
    id: 'yalu_staff_mage',
    name: '🪄 芽露·露芽杖监工',
    avatar: {
      name: '芽露',
      bodyForm: 'yalu_model',
      modelPackId: 'yalu_official',
      propLoadout: 'staff',
      auraTheme: 'starlight',
      expressionOverride: 'focus',
      hairStyle: 'long',
      hairColor: 'mint',
      eyeStyle: 'star',
      eyeColor: 'emerald',
      headgear: 'ribbon',
      outfit: 'hanfu',
      accessory: 'wand',
      skin: 'porcelain',
      personality: 'tsundere',
      scale: 1.02,
    },
  },
  {
    id: 'yalu_bell_chime',
    name: '🔔 芽露·酒红铃铛',
    avatar: {
      name: '芽露',
      bodyForm: 'yalu_model',
      modelPackId: 'yalu_official',
      propLoadout: 'bell',
      auraTheme: 'crimson',
      expressionOverride: 'proud',
      hairStyle: 'long',
      hairColor: 'mint',
      eyeStyle: 'star',
      eyeColor: 'emerald',
      headgear: 'ribbon',
      outfit: 'hanfu',
      accessory: 'bell',
      skin: 'porcelain',
      personality: 'energetic',
      scale: 1.0,
    },
  },
  {
    id: 'dafeiyu_classic',
    name: '🐳 备用皮肤·大肥鱼',
    avatar: {
      name: '大肥鱼',
      bodyForm: 'dafeiyu',
      modelPackId: 'yalu_official',
      propLoadout: 'none',
      auraTheme: 'natural',
      expressionOverride: 'auto',
      hairStyle: 'twintails',
      hairColor: 'ocean',
      eyeStyle: 'star',
      eyeColor: 'sapphire',
      headgear: 'whale_spout',
      outfit: 'sailor',
      accessory: 'fish_cookie',
      skin: 'porcelain',
      personality: 'energetic',
      scale: 1.0,
    },
  },
])

export const DEFAULT_COMPANION_AVATAR = Object.freeze({ ...COMPANION_PRESETS[0].avatar })

export const DEFAULT_COMPANION_CONFIG = Object.freeze({
  visible: true,
  llmEnabled: false,
  fullLlmDrive: false,
  autopilotEnabled: true,
  modelProfileId: '',
  customBaseUrl: '',
  customApiKey: '',
  customModel: '',
  sneakEatEnabled: true,
  autoRepairShattered: true,
})

export const DEFAULT_COMPANION_STATS = Object.freeze({
  affection: 40,
  energy: 90,
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
    const legacyRaw = readStorage(LEGACY_AVATAR_KEY, '')
    if (legacyRaw) {
      const lp = JSON.parse(legacyRaw)
      if (lp && typeof lp === 'object') {
        return { ...DEFAULT_COMPANION_AVATAR, scale: Number(lp.scale) || 1.0 }
      }
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
