/**
 * Harbor 3D 可爱二次元娱乐协助助手 · 捏脸换装资产目录与持久化配置（R28）
 * 支持 7 发型 × 8 发色 × 6 眼型 × 8 瞳色 × 7 头饰兽耳 × 6 服装 × 7 配饰 × 4 肤色 × 4 性格声线自由组合。
 */
import { readStorage, writeStorage } from '../platform/storage.js'

const AVATAR_KEY = 'harbor.r28.companion.avatar'
const CONFIG_KEY = 'harbor.r28.companion.config'

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
  { id: 'sakura', label: '樱花粉', hex: '#F6A6C1', shade: '#C96B8D' },
  { id: 'sky', label: '晴空蓝', hex: '#7BC8F6', shade: '#3B8CC4' },
  { id: 'silver', label: '月光银', hex: '#DCE3F0', shade: '#99A7C2' },
  { id: 'honey', label: '蜜糖金', hex: '#F7D07A', shade: '#C9963A' },
  { id: 'obsidian', label: '深海黑', hex: '#2F3647', shade: '#171B26' },
  { id: 'mint', label: '薄荷绿', hex: '#7AE3C3', shade: '#39A889' },
  { id: 'lilac', label: '丁香紫', hex: '#BCA3F7', shade: '#7E64C7' },
  { id: 'coral', label: '珊瑚橙', hex: '#F49772', shade: '#C45B38' },
])

export const COMPANION_EYE_STYLES = Object.freeze([
  { id: 'star', label: '星光大眼' },
  { id: 'bright', label: '元气圆眼' },
  { id: 'gentle', label: '温柔半眯' },
  { id: 'cat', label: '灵动猫瞳' },
  { id: 'heart', label: '甜心高光' },
  { id: 'cool', label: '酷飒凤眼' },
])

export const COMPANION_EYE_COLORS = Object.freeze([
  { id: 'sapphire', label: '海蓝', hex: '#2B8BE6' },
  { id: 'amber', label: '琥珀金', hex: '#E69A28' },
  { id: 'rose', label: '蔷薇粉', hex: '#E85C8B' },
  { id: 'emerald', label: '翡翠绿', hex: '#22A874' },
  { id: 'violet', label: '星穹紫', hex: '#8A5CF6' },
  { id: 'crimson', label: '绯红', hex: '#DF4545' },
  { id: 'cyan', label: '冰晶青', hex: '#14B8C4' },
  { id: 'hetero', label: '异色双瞳', hex: '#2B8BE6', rightHex: '#E69A28' },
])

export const COMPANION_HEADGEARS = Object.freeze([
  { id: 'cat_ears', label: '软萌猫耳' },
  { id: 'bunny_ears', label: '垂耳兔耳' },
  { id: 'halo', label: '天使光环' },
  { id: 'ribbon', label: '大蝴蝶结' },
  { id: 'devil_horns', label: '小恶魔角' },
  { id: 'headphones', label: '赛博猫耳耳机' },
  { id: 'none', label: '无头饰' },
])

export const COMPANION_OUTFITS = Object.freeze([
  { id: 'sailor', label: '水手学院装', primary: '#3B6FD8', accent: '#FFFFFF' },
  { id: 'cyber', label: '赛博机能卫衣', primary: '#252E42', accent: '#38BDF8' },
  { id: 'maid', label: '蕾丝甜点裙', primary: '#2C2A35', accent: '#F9D8E6' },
  { id: 'mage', label: '星穹魔导师袍', primary: '#5B42B8', accent: '#F7C95C' },
  { id: 'pajama', label: '云朵软绵睡衣', primary: '#F5B5C8', accent: '#FFF8EB' },
  { id: 'labcoat', label: '极客研究员大褂', primary: '#F4F7FB', accent: '#D4653E' },
])

export const COMPANION_ACCESSORIES = Object.freeze([
  { id: 'none', label: '无配饰' },
  { id: 'glasses', label: '圆框金丝眼镜' },
  { id: 'wings', label: '迷你光翼' },
  { id: 'grimoire', label: '浮游魔导书' },
  { id: 'scarf', label: '元气小围巾' },
  { id: 'star_clip', label: '星光双发夹' },
  { id: 'bandaid', label: '元气创可贴' },
])

export const COMPANION_SKINS = Object.freeze([
  { id: 'porcelain', label: '瓷白', hex: '#FFF0E6', shade: '#E8C5B3' },
  { id: 'peach', label: '蜜桃粉白', hex: '#FFE6D8', shade: '#E3B6A0' },
  { id: 'warm', label: '暖玉自然', hex: '#F6D5BC', shade: '#D4A586' },
  { id: 'honey', label: '元气小麦', hex: '#E3B48D', shade: '#BA855E' },
])

export const COMPANION_PERSONALITIES = Object.freeze([
  { id: 'energetic', label: '元气甜妹', greeting: '嗨呀！我是你的 3D 液态玻璃小助手米露，有不懂的随时戳我，顺便…你的玻璃方块看起来好好吃诶～' },
  { id: 'tsundere', label: '傲娇小恶魔', greeting: '哼、才不是特意来帮你的！只不过看你不太熟 Harbor，勉为其难替你跑腿点击一下啦（才没有偷啃玻璃）！' },
  { id: 'gentle', label: '温柔学姐', greeting: '欢迎回到 Harbor 工作台。不管是功能引导、代操作还是修补碎掉的液态玻璃，交给我慢慢帮你打理就好。' },
  { id: 'geek', label: '极客管家', greeting: 'Harbor 3D 协同助手就绪！本地知识图谱与动作脚本已装载，零 Token 即可代你执行界面操作与文件黑洞投递。' },
])

export const COMPANION_PRESETS = Object.freeze([
  {
    id: 'miru',
    name: '星见米露（默认）',
    avatar: { name: '米露', hairstyle: 'twintails', hairColor: 'sakura', eyeStyle: 'star', eyeColor: 'sapphire', headgear: 'cat_ears', outfit: 'sailor', accessory: 'star_clip', skin: 'porcelain', personality: 'energetic', scale: 1.0 },
  },
  {
    id: 'cyber_kuro',
    name: '赛博小黑',
    avatar: { name: '小黑', hairstyle: 'wolf', hairColor: 'obsidian', eyeStyle: 'cat', eyeColor: 'cyan', headgear: 'headphones', outfit: 'cyber', accessory: 'glasses', skin: 'porcelain', personality: 'geek', scale: 1.0 },
  },
  {
    id: 'mage_lulu',
    name: '星穹魔导露露',
    avatar: { name: '露露', hairstyle: 'long', hairColor: 'lilac', eyeStyle: 'heart', eyeColor: 'hetero', headgear: 'halo', outfit: 'mage', accessory: 'grimoire', skin: 'peach', personality: 'tsundere', scale: 1.02 },
  },
  {
    id: 'bunny_momo',
    name: '软萌兔耳桃桃',
    avatar: { name: '桃桃', hairstyle: 'buns', hairColor: 'honey', eyeStyle: 'bright', eyeColor: 'rose', headgear: 'bunny_ears', outfit: 'pajama', accessory: 'wings', skin: 'peach', personality: 'gentle', scale: 0.96 },
  },
])

export const DEFAULT_AVATAR = Object.freeze({ ...COMPANION_PRESETS[0].avatar })

export const DEFAULT_COMPANION_CONFIG = Object.freeze({
  visible: true,
  llmEnabled: false,       // 右键可开关：是否允许闲聊调用助手专属大模型
  fullLlmDrive: false,     // 右键可开关：是否完全由大模型接替本地驱动
  sneakEatEnabled: true,   // 是否允许助手空闲偷偷啃液态玻璃
  autoRepairShattered: true, // 被动效果：用户把方块甩碎消失后自动随机时间去收拾碎片并修补
  modelProfileId: '',      // 独立绑定模型保存中心的模型 ID
  customBaseUrl: '',
  customModel: '',
  customApiKey: '',
})

export function loadCompanionAvatar() {
  try {
    const raw = readStorage(AVATAR_KEY, '')
    if (!raw) return { ...DEFAULT_AVATAR }
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_AVATAR, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
  } catch {
    return { ...DEFAULT_AVATAR }
  }
}

export function saveCompanionAvatar(avatar) {
  const next = { ...DEFAULT_AVATAR, ...(avatar || {}) }
  try { writeStorage(AVATAR_KEY, JSON.stringify(next)) } catch {}
  return next
}

export function loadCompanionConfig() {
  try {
    const raw = readStorage(CONFIG_KEY, '')
    if (!raw) return { ...DEFAULT_COMPANION_CONFIG }
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_COMPANION_CONFIG, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
  } catch {
    return { ...DEFAULT_COMPANION_CONFIG }
  }
}

export function saveCompanionConfig(cfg) {
  const next = { ...DEFAULT_COMPANION_CONFIG, ...(cfg || {}) }
  try { writeStorage(CONFIG_KEY, JSON.stringify(next)) } catch {}
  return next
}
