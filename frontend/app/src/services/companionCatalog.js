/**
 * Harbor 旗舰级 3D 互动桌宠与全自动监工助手 · 形象工坊目录、双形态变身与养成持久化（R29）：
 * - 参考全网高人气「大肥鱼（胖鲸鱼本尊 + 鲸鱼娘萌娘）」「粘土人 Nendoroid 二次元」与「Apple 液态玻璃星核喵」4 大高精建模形态；
 * - 支持一键「大肥鱼 ↔ 鲸鱼娘」双形态即时变身，支持发型/发色/瞳色/异色瞳/头饰/服装/手持物/体型/性格深度定制；
 * - 内置好感度 Lv.1–Lv.10、饱食度、心情、投喂零食目录与持久配置。
 */
import { readStorage, writeStorage } from '../platform/storage.js'

const AVATAR_KEY = 'harbor.r28.companion.avatar'
const CONFIG_KEY = 'harbor.r28.companion.config'
const STATS_KEY = 'harbor.r29.companion.stats'

export const COMPANION_BODY_FORMS = Object.freeze([
  { id: 'dafeiyu', label: '🐳 大肥鱼·胖鲸鱼', desc: '经典圆滚滚高光瓷感胖鲸鱼，头顶喷水柱、尾巴会拍打扑腾' },
  { id: 'whale_girl', label: '🎀 大肥鱼·鲸鱼娘', desc: '精致 2.2 头身粘土人鲸鱼娘，赛璐璐发丝高光+鲸尾发饰' },
  { id: 'chibi_anime', label: '✨ 星见二次元萌娘', desc: '精细日系 Q 版看板娘，立体刘海光环+宝石星光大眼' },
  { id: 'liquid_cat', label: '🫧 液态玻璃星核喵', desc: '半透明液态玻璃软萌团子猫，耳尖微光+悬浮星环' },
])

export const COMPANION_HAIRSTYLES = Object.freeze([
  { id: 'twintails', label: '元气双马尾' },
  { id: 'bob', label: '日系波波头' },
  { id: 'long', label: '星瀑长直发' },
  { id: 'buns', label: '软萌双丸子' },
  { id: 'wolf', label: '飒爽狼尾短发' },
  { id: 'sidetail', label: '俏皮侧马尾' },
  { id: 'drill', label: '大小姐双螺旋' },
  { id: 'hime', label: '公主切长发' },
])

export const COMPANION_HAIR_COLORS = Object.freeze([
  { id: 'ocean', label: '深海鲸蓝', hex: '#4B8BF5', shade: '#2452B0', light: '#99CCFF' },
  { id: 'sky', label: '晴空冰蓝', hex: '#6AC4FA', shade: '#2D7CC2', light: '#C8EDFF' },
  { id: 'sakura', label: '樱花奶粉', hex: '#F79EC2', shade: '#C55B8A', light: '#FFD6E8' },
  { id: 'silver', label: '月光冰银', hex: '#D8E3F4', shade: '#8E9FBC', light: '#FFFFFF' },
  { id: 'honey', label: '蜜糖奶油金', hex: '#F8CE70', shade: '#C48A2B', light: '#FFF0C2' },
  { id: 'obsidian', label: '星夜墨黑', hex: '#2F384C', shade: '#141925', light: '#687899' },
  { id: 'mint', label: '薄荷海盐', hex: '#6BE2C4', shade: '#2A9D82', light: '#C7FFF0' },
  { id: 'lilac', label: '星穹丁香紫', hex: '#B99CF9', shade: '#7456C6', light: '#E6DAFF' },
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
  { id: 'sapphire', label: '深海蓝', hex: '#257BE8', glow: '#8BD3FF' },
  { id: 'cyan', label: '冰晶青', hex: '#14B8C4', glow: '#99F6FF' },
  { id: 'amber', label: '琥珀金', hex: '#E69A28', glow: '#FFE299' },
  { id: 'rose', label: '蔷薇粉', hex: '#E85C8B', glow: '#FFC2D9' },
  { id: 'emerald', label: '翡翠绿', hex: '#22A874', glow: '#9BF6D3' },
  { id: 'violet', label: '星穹紫', hex: '#8A5CF6', glow: '#D5C2FF' },
  { id: 'crimson', label: '绯红宝石', hex: '#DF4545', glow: '#FFB8B8' },
  { id: 'hetero', label: '异色双瞳', hex: '#257BE8', rightHex: '#F2992E', glow: '#B8E8FF' },
])

export const COMPANION_HEADGEARS = Object.freeze([
  { id: 'whale_spout', label: '喷水小浪花' },
  { id: 'crown', label: '迷你小皇冠' },
  { id: 'sailor_hat', label: '水手贝雷帽' },
  { id: 'cat_ears', label: '软萌猫耳' },
  { id: 'bunny_ears', label: '垂耳兔耳' },
  { id: 'ribbon', label: '大蝴蝶结' },
  { id: 'halo', label: '星辰光环' },
  { id: 'headphones', label: '赛博猫耳耳机' },
  { id: 'none', label: '无头饰' },
])

export const COMPANION_OUTFITS = Object.freeze([
  { id: 'maid', label: '清甜服务女仆装', primary: '#253252', accent: '#FFFFFF', trim: '#60BDF8' },
  { id: 'sailor', label: '深海学院水手服', primary: '#2E62C8', accent: '#FFFFFF', trim: '#F48260' },
  { id: 'cyber', label: '赛博机能外套', primary: '#1E273B', accent: '#38BDF8', trim: '#A78BFA' },
  { id: 'mage', label: '星穹魔导师斗篷', primary: '#563DB8', accent: '#F8D064', trim: '#C4B5FD' },
  { id: 'pajama', label: '软糯鲨鱼睡衣', primary: '#7BC8F6', accent: '#FFFDF7', trim: '#F79EC2' },
  { id: 'hanfu', label: '流光轻汉服', primary: '#E86E58', accent: '#FFF4E8', trim: '#F6C860' },
])

export const COMPANION_ACCESSORIES = Object.freeze([
  { id: 'stylus', label: '星光手写笔' },
  { id: 'fish_cookie', label: '小鱼干零食' },
  { id: 'wand', label: '星辰指挥棒' },
  { id: 'glasses', label: '监工圆眼镜' },
  { id: 'ribbon_tail', label: '发光小鲸尾' },
  { id: 'wings', label: '半透明精灵翼' },
  { id: 'none', label: '无配饰' },
])

export const COMPANION_SKINS = Object.freeze([
  { id: 'porcelain', label: '瓷白奶油肌', hex: '#FFF2E9', shade: '#F2CDBE' },
  { id: 'peach', label: '蜜桃元气肌', hex: '#FFE4D2', shade: '#E8B69E' },
  { id: 'warm', label: '暖光杏肌', hex: '#F8D4BA', shade: '#D9A889' },
  { id: 'cool', label: '清冷月白肌', hex: '#FBF5F8', shade: '#DECED8' },
])

export const COMPANION_PERSONALITIES = Object.freeze([
  {
    id: 'dafeiyu_cute',
    label: '呆萌贪吃·大肥鱼',
    greeting: '咕噜噜～我是你的「大肥鱼」全能桌面总管！把任何复杂任务直接丢给我，我会自己挑最合适的专家团、技能或工作流全程监工交稿～闲着没事也可以拎起我晃晃、摸摸头或投喂小鱼干哦！',
    idleQuips: ['咕噜～今天有什么大工程交给我统筹呀？', '肚皮有点饿了…要不要喂我一颗小鱼干？', '我随时可以帮你跑去调度 12 支原生专家团和工作流哦！'],
  },
  {
    id: 'energetic',
    label: '元气靠谱·小管家',
    greeting: '嗨呀！我是你的专属全能助手～发一句需求我就自动判断调哪个模块、哪个专家、哪个工作流并盯到交稿，也能陪你玩液态玻璃沙盒和接星星！',
    idleQuips: ['能量满满！点我直接派发全自动任务吧 ✨', '把需求丢给我，我替你全流程监工交稿！'],
  },
  {
    id: 'tsundere',
    label: '傲娇毒舌·监工长',
    greeting: '哼，才不是专门等你发需求的！把麻烦事丢过来吧，选专家、跑工作流、审终稿我全包了——顺便别老拎我尾巴！',
    idleQuips: ['哼，你再不摸我头我可去啃玻璃了哦。', '这任务交给我监工，保证比你自己点快十倍！'],
  },
  {
    id: 'gentle',
    label: '温柔治愈·大姐姐',
    greeting: '辛苦啦～我是你的专属桌面伙伴。想省心完成复杂任务时，把目标发给我，我会悄悄为你调配最合适的专家与工作流并认真把关交付。',
    idleQuips: ['工作累了可以点「番茄钟」让我安静陪你哦 🍅', '一切都准备好了，随时把需求交给我吧～'],
  },
])

export const COMPANION_SNACKS = Object.freeze([
  { id: 'dried_fish', name: '脆脆小鱼干', icon: '🐟', energy: 25, affection: 6, quote: '咔嚓咔嚓！超香的小鱼干～饱饱的就不去啃玻璃啦！' },
  { id: 'glass_candy', name: '液态玻璃糖', icon: '🍬', energy: 18, affection: 8, quote: '哇！亮晶晶的液态玻璃糖，比界面的按钮还甜一百倍！' },
  { id: 'token_donut', name: '算力甜甜圈', icon: '🍩', energy: 35, affection: 5, quote: '满血复活！我现在能一口气监工十个专家团交付！' },
  { id: 'star_milk', name: '星穹奶茶', icon: '🧋', energy: 22, affection: 10, quote: '咕嘟咕嘟～好幸福，好感度暴涨啦 ♡' },
])

export const COMPANION_PRESETS = Object.freeze([
  {
    id: 'dafeiyu_classic',
    name: '🐳 经典大肥鱼 (默认)',
    avatar: {
      name: '大肥鱼',
      bodyForm: 'dafeiyu',
      hairStyle: 'twintails',
      hairColor: 'ocean',
      eyeStyle: 'star',
      eyeColor: 'sapphire',
      headgear: 'whale_spout',
      outfit: 'sailor',
      accessory: 'fish_cookie',
      skin: 'porcelain',
      personality: 'dafeiyu_cute',
      scale: 1.0,
    },
  },
  {
    id: 'dafeiyu_whale_girl',
    name: '🎀 大肥鱼·鲸鱼娘',
    avatar: {
      name: '大肥鱼娘',
      bodyForm: 'whale_girl',
      hairStyle: 'long',
      hairColor: 'sky',
      eyeStyle: 'star',
      eyeColor: 'sapphire',
      headgear: 'sailor_hat',
      outfit: 'maid',
      accessory: 'ribbon_tail',
      skin: 'porcelain',
      personality: 'dafeiyu_cute',
      scale: 1.0,
    },
  },
  {
    id: 'sakura_milu',
    name: '🌸 樱花星见米露',
    avatar: {
      name: '米露',
      bodyForm: 'chibi_anime',
      hairStyle: 'twintails',
      hairColor: 'sakura',
      eyeStyle: 'heart',
      eyeColor: 'rose',
      headgear: 'cat_ears',
      outfit: 'sailor',
      accessory: 'stylus',
      skin: 'porcelain',
      personality: 'energetic',
      scale: 1.0,
    },
  },
  {
    id: 'cyber_kuro',
    name: '⚡ 赛博黑猫监工',
    avatar: {
      name: '小黑',
      bodyForm: 'chibi_anime',
      hairStyle: 'wolf',
      hairColor: 'obsidian',
      eyeStyle: 'cool',
      eyeColor: 'hetero',
      headgear: 'headphones',
      outfit: 'cyber',
      accessory: 'glasses',
      skin: 'cool',
      personality: 'tsundere',
      scale: 1.0,
    },
  },
  {
    id: 'liquid_mochi_cat',
    name: '🫧 液态玻璃星核喵',
    avatar: {
      name: '琉璃喵',
      bodyForm: 'liquid_cat',
      hairStyle: 'bob',
      hairColor: 'silver',
      eyeStyle: 'cat',
      eyeColor: 'cyan',
      headgear: 'halo',
      outfit: 'mage',
      accessory: 'wings',
      skin: 'porcelain',
      personality: 'gentle',
      scale: 1.0,
    },
  },
  {
    id: 'pink_whale',
    name: '🍑 蜜桃粉肥鱼',
    avatar: {
      name: '粉肥鱼',
      bodyForm: 'dafeiyu',
      hairStyle: 'buns',
      hairColor: 'sakura',
      eyeStyle: 'bright',
      eyeColor: 'rose',
      headgear: 'crown',
      outfit: 'pajama',
      accessory: 'wand',
      skin: 'peach',
      personality: 'energetic',
      scale: 1.04,
    },
  },
])

export const DEFAULT_COMPANION_AVATAR = Object.freeze({ ...COMPANION_PRESETS[0].avatar })

export const DEFAULT_COMPANION_CONFIG = Object.freeze({
  visible: true,
  llmEnabled: false,
  fullLlmDrive: false,
  autopilotEnabled: true, // 默认开启「全自动路由监工交稿」能力！
  modelProfileId: '',
  customBaseUrl: '',
  customApiKey: '',
  customModel: '',
  sneakEatEnabled: true,
  autoRepairShattered: true,
})

export const DEFAULT_COMPANION_STATS = Object.freeze({
  affection: 35,
  energy: 86,
  mood: '元气满满',
  tasksDelivered: 0,
  snacksEaten: 0,
  headPats: 0,
})

export function loadCompanionAvatar() {
  try {
    const raw = readStorage(AVATAR_KEY, '')
    if (!raw) return { ...DEFAULT_COMPANION_AVATAR }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_COMPANION_AVATAR }
    // 兼容旧 R28 无 bodyForm 存档：自动平滑升级为精致鲸鱼娘/大肥鱼
    const bodyForm = COMPANION_BODY_FORMS.some((f) => f.id === parsed.bodyForm)
      ? parsed.bodyForm
      : (parsed.name === '米露' ? 'whale_girl' : 'dafeiyu')
    return { ...DEFAULT_COMPANION_AVATAR, ...parsed, bodyForm }
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
  const next = {
    ...DEFAULT_COMPANION_STATS,
    ...(stats || {}),
  }
  next.affection = Math.max(0, Math.min(1000, Number(next.affection) || 0))
  next.energy = Math.max(0, Math.min(100, Number(next.energy) || 0))
  try { writeStorage(STATS_KEY, JSON.stringify(next)) } catch {}
  return next
}

export function affectionLevel(affection = 0) {
  const a = Math.max(0, Number(affection) || 0)
  return Math.min(10, 1 + Math.floor(a / 60))
}
