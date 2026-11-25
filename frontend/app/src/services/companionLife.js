/**
 * Harbor 芽露自主生命行为状态机（R31）：
 * 走出桌面、窗边坐着荡脚、伸懒腰、摇腰间酒红铃铛、打盹、四处溜达、饿了偷啃玻璃，
 * 全都是角色「自带的活体本能动作」，绝不把这些做成生硬菜单项让用户点来点去。
 */

/**
 * 根据当前位置、精力、闲置时长、窗口尺寸与桌面跨窗能力，规划下一个自然自主行为。
 * 纯函数可 100% 单元测试。
 */
export function pickNextAutonomousBehavior({
  pos = { x: 900, y: 600 },
  vw = 1280,
  vh = 800,
  energy = 90,
  idleSeconds = 10,
  canVentureDesktop = false,
  recentlyReturnedFromDesktop = false,
  sneakEatEnabled = true,
  hasGlassCandidates = false,
  roll = Math.random(),
} = {}) {
  const r = Math.max(0, Math.min(0.9999, Number(roll) || 0))

  // 1) 长时间未交互或精力较低 -> 自然蜷坐打盹充电
  if (energy < 38 || (idleSeconds > 110 && r < 0.25)) {
    return { type: 'sleep', durationMs: 6500, quip: '呼噜噜…芽露稍微打个小盹，有事点我就醒 💤' }
  }

  // 2) 桌面端且未刚回来：约 20% 概率自然走向窗边探头，然后走出 Harbor 窗口到真实桌面散步！
  if (canVentureDesktop && !recentlyReturnedFromDesktop && r < 0.22) {
    const exitSide = pos.x < vw * 0.45 ? 'left' : 'right'
    return {
      type: 'venture_desktop',
      exitSide,
      edgeX: exitSide === 'left' ? 18 : Math.max(120, vw - 110),
      edgeY: Math.max(120, Math.min(vh - 180, pos.y)),
      quip: '叮铃～外面的桌面看起来好宽敞，芽露出去溜达一圈就回来 🌿',
    }
  }

  // 3) 饿了且开启趣味偷啃 -> 偶尔偷偷溜过去啃一口液态玻璃
  if (sneakEatEnabled && hasGlassCandidates && energy < 78 && r >= 0.22 && r < 0.34) {
    return { type: 'sneak_eat', quip: '肚子咕噜噜…那块液态玻璃看起来好脆呀！' }
  }

  // 4) 跳到窗口底栏或顶栏边坐下荡小脚
  if (r >= 0.34 && r < 0.52) {
    const tx = Math.max(140, Math.min(vw - 180, 180 + ((r * 1337) % 1) * Math.max(180, vw - 360)))
    return {
      type: 'sit_edge',
      targetX: tx,
      targetY: Math.max(120, vh - 178),
      durationMs: 4600,
      quip: '',
    }
  }

  // 5) 原地伸懒腰或轻敲腰间酒红铃铛
  if (r >= 0.52 && r < 0.70) {
    return r < 0.61
      ? { type: 'stretch', durationMs: 2600, quip: '嗯唔～伸个大懒腰，露芽杖充满电啦 ✨' }
      : { type: 'bell_play', durationMs: 2400, quip: '叮铃铃～🔔' }
  }

  // 6) 默认：在窗口内悠闲散步到新的自然落点（避开中央阅读区，偏四周边缘）
  const marginX = 96
  const chooseLeft = r > 0.85
  const tx = chooseLeft
    ? marginX + ((r * 97) % 1) * 140
    : Math.max(200, vw - 260 + ((r * 53) % 1) * 120)
  const ty = Math.max(120, Math.min(vh - 184, 150 + ((r * 211) % 1) * Math.max(120, vh - 340)))
  return {
    type: 'stroll',
    targetX: tx,
    targetY: ty,
    quip: '',
  }
}
