/**
 * Harbor R28 全元素液态玻璃物理沙盒引擎（纯物理 + 状态机，零外部依赖，100% 可单元测试）：
 * - 长按抓起任意液态玻璃方块（按钮/导航胶囊/快捷卡/状态岛），原位留空不留残影；
 * - 停稳松手：沿液态玻璃低摩擦表面缓慢滑动并停在落点（不主动归位）；
 * - 甩开松手：速度越快力道越大，撞击屏幕四边按真实物理轨迹弹性回弹，且与其他浮动方块发生动量碰撞；
 * - 凹陷回弹 + 裂痕碎裂：慢撞仅凹陷回弹；快撞产生裂痕与碎光，重击 3 次整块碎裂成碎片消失（绝不自动恢复）；
 * - 归位与恢复：拖回原位自动吸附 / 长按原位空槽快速磁力吸回 / 碎裂后长按原位空槽 2 秒液态凝聚恢复；
 * - 3D 二次元助手联动：支持助手偷啃液态玻璃（真实半圆咬痕，不自愈）与同步进度修补/拾取碎片恢复。
 */

export const CRACK_SPEED_THRESHOLD = 420
export const MAX_GLASS_HP = 3
export const HEAL_HOLD_MS = 2000

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

function makeCrackLines(w, h, impactSide, seed) {
  const cx = impactSide === 'left' ? 4 : (impactSide === 'right' ? w - 4 : w * (0.25 + ((seed * 37) % 50) / 100))
  const cy = impactSide === 'top' ? 4 : (impactSide === 'bottom' ? h - 4 : h * (0.25 + ((seed * 53) % 50) / 100))
  const baseAng = impactSide === 'left' ? 0 : (impactSide === 'right' ? Math.PI : (impactSide === 'top' ? Math.PI / 2 : -Math.PI / 2))
  const lines = []
  for (let i = 0; i < 4; i++) {
    const a1 = baseAng + (i - 1.5) * 0.42 + (((seed + i * 17) % 10) - 5) * 0.04
    const len1 = Math.min(w, h) * (0.35 + ((seed + i * 13) % 35) / 100)
    const mx = clamp(cx + Math.cos(a1) * len1 * 0.55, 2, w - 2)
    const my = clamp(cy + Math.sin(a1) * len1 * 0.55, 2, h - 2)
    const a2 = a1 + (i % 2 ? 0.34 : -0.34)
    const ex = clamp(mx + Math.cos(a2) * len1 * 0.52, 2, w - 2)
    const ey = clamp(my + Math.sin(a2) * len1 * 0.52, 2, h - 2)
    lines.push(`M ${cx.toFixed(1)} ${cy.toFixed(1)} L ${mx.toFixed(1)} ${my.toFixed(1)} L ${ex.toFixed(1)} ${ey.toFixed(1)}`)
  }
  return lines
}

function makeShards(x, y, w, h, vx, vy, count = 12) {
  const shards = []
  const cx = x + w / 2
  const cy = y + h / 2
  for (let i = 0; i < count; i++) {
    const ang = (Math.PI * 2 * i) / count + ((i % 3) - 1) * 0.22
    const spd = 90 + (i % 5) * 58
    shards.push({
      id: `sh_${i}_${Math.round(cx)}`,
      x: cx + Math.cos(ang) * (w * 0.16),
      y: cy + Math.sin(ang) * (h * 0.16),
      vx: vx * 0.35 + Math.cos(ang) * spd,
      vy: vy * 0.35 + Math.sin(ang) * spd - 45,
      rot: (i * 47) % 360,
      vrot: (i % 2 ? 1 : -1) * (160 + (i % 4) * 75),
      size: 7 + (i % 4) * 3.5,
      collected: false,
    })
  }
  return shards
}

export function createGlassSandboxState() {
  return {
    bodies: new Map(), // glassId -> body record
    seq: 0,
  }
}

export function grabGlassBody(store, { id, label, x, y, w, h, radius = 14 }) {
  const existing = store.bodies.get(id)
  if (existing && existing.status === 'shattered') return existing
  const body = existing ? {
    ...existing,
    status: 'dragging',
    vx: 0,
    vy: 0,
    vrot: 0,
    pickupAnim: 1,
    // 记录抓取瞬间的位置：用于区分「真的拖动过」与「抓起后原地松手」。
    grabPos: { x: existing.x, y: existing.y },
  } : {
    id,
    label: String(label || '液态玻璃'),
    origin: { x, y, w, h, radius },
    x,
    y,
    w,
    h,
    radius,
    grabPos: { x, y },
    vx: 0,
    vy: 0,
    rot: 0,
    vrot: 0,
    dentX: 0,
    dentY: 0,
    dentAmt: 0,
    dentVel: 0,
    hp: MAX_GLASS_HP,
    maxHp: MAX_GLASS_HP,
    cracks: [],
    biteNotches: [], // [{ edge, posFrac, size }]
    shards: [],
    status: 'dragging', // 'dragging' | 'floating' | 'recalling' | 'shattered' | 'bitten_in_place' | 'repairing'
    repairProgress: 0,
    repairMode: '', // 'bite' | 'shatter'
    pickupAnim: 1,
    shatteredAt: 0,
  }
  store.bodies.set(id, body)
  store.seq += 1
  return body
}

export function moveDraggedBody(store, id, x, y, vx = 0, vy = 0) {
  const b = store.bodies.get(id)
  if (!b || b.status !== 'dragging') return null
  b.x = x
  b.y = y
  b.vx = vx
  b.vy = vy
  b.rot = clamp(vx * 0.014, -14, 14)
  return b
}

export function releaseGlassBody(store, id, vx = 0, vy = 0) {
  const b = store.bodies.get(id)
  if (!b) return { snapped: false, body: null }
  const distHome = Math.hypot(b.x - b.origin.x, b.y - b.origin.y)
  const speed = Math.hypot(vx, vy)
  // 「抓起来又原地松手」不等于「拖动后放回原位」：
  // 前者应保持悬浮（r28 规格：慢滑不归位，只有长按/召回才回原位），
  // 后者才是磁吸归位。用抓取点到释放点的位移区分，阈值 8px。
  const movedFromGrab = b.grabPos ? Math.hypot(b.x - b.grabPos.x, b.y - b.grabPos.y) : Infinity
  if (distHome < 56 && speed < 320 && movedFromGrab >= 8 && b.biteNotches.length === 0) {
    store.bodies.delete(id)
    store.seq += 1
    return { snapped: true, body: b }
  }
  b.status = 'floating'
  // 速度越快力道越大；停稳松手则保留微妙液态滑动飘移（绝不主动归位）
  if (speed < 48) {
    const driftAng = ((store.seq * 1.9 + b.x * 0.03) % (Math.PI * 2))
    b.vx = Math.cos(driftAng) * 52
    b.vy = Math.sin(driftAng) * 42
  } else {
    b.vx = clamp(vx, -2400, 2400)
    b.vy = clamp(vy, -2400, 2400)
  }
  b.vrot = clamp((b.vx * 0.08 - b.vy * 0.04), -180, 180)
  store.seq += 1
  return { snapped: false, body: b }
}

export function recallGlassBody(store, id) {
  const b = store.bodies.get(id)
  if (!b || b.status === 'shattered') return null
  b.status = 'recalling'
  b.vx = 0
  b.vy = 0
  store.seq += 1
  return b
}

export function restoreShatteredBody(store, id) {
  const b = store.bodies.get(id)
  if (!b) return false
  store.bodies.delete(id)
  store.seq += 1
  return true
}

/** 3D 二次元助手偷偷啃一口液态玻璃（真实留下缺口，绝不自动恢复！） */
export function biteGlassBody(store, { id, label, x, y, w, h, radius = 14 }) {
  let b = store.bodies.get(id)
  if (b && b.status === 'shattered') return null
  if (!b) {
    b = {
      id,
      label: String(label || '液态玻璃'),
      origin: { x, y, w, h, radius },
      x,
      y,
      w,
      h,
      radius,
      vx: 0,
      vy: 0,
      rot: 0,
      vrot: 0,
      dentX: 0,
      dentY: 0,
      dentAmt: 0.45,
      dentVel: 0,
      hp: MAX_GLASS_HP,
      maxHp: MAX_GLASS_HP,
      cracks: [],
      biteNotches: [],
      shards: [],
      status: 'bitten_in_place',
      repairProgress: 0,
      repairMode: '',
      pickupAnim: 0,
      shatteredAt: 0,
    }
    store.bodies.set(id, b)
  }
  if (b.biteNotches.length < 4) {
    const edges = ['top', 'right', 'bottom', 'left']
    const edge = edges[b.biteNotches.length % edges.length]
    const posFrac = 0.28 + ((b.biteNotches.length * 23 + Math.round(x)) % 44) / 100
    b.biteNotches.push({ edge, posFrac, size: Math.max(9, Math.min(16, Math.min(b.w, b.h) * 0.34)) })
    b.dentAmt = 0.55
  }
  store.seq += 1
  return b
}

export function startRepairBody(store, id) {
  const b = store.bodies.get(id)
  if (!b) return null
  b.repairMode = b.status === 'shattered' ? 'shatter' : 'bite'
  b.status = 'repairing'
  b.repairProgress = 0
  store.seq += 1
  return b
}

export function setRepairProgress(store, id, progress) {
  const b = store.bodies.get(id)
  if (!b || b.status !== 'repairing') return null
  b.repairProgress = clamp(progress, 0, 1)
  if (b.repairProgress >= 1) {
    if (b.repairMode === 'shatter') {
      store.bodies.delete(id)
    } else {
      b.biteNotches = []
      b.cracks = []
      b.hp = MAX_GLASS_HP
      if (Math.hypot(b.x - b.origin.x, b.y - b.origin.y) < 12) {
        store.bodies.delete(id)
      } else {
        b.status = 'floating'
      }
    }
    store.seq += 1
    return { done: true, id }
  }
  return { done: false, id, progress: b.repairProgress }
}

/** 步进物理世界（dt 秒），返回本帧产生的撞击事件列表（供触发液态玻璃波纹、裂痕与碎裂回调） */
export function stepGlassSandbox(store, dtSec, vw, vh) {
  const dt = clamp(Number(dtSec) || 0.016, 0.002, 0.04)
  const W = Math.max(320, Number(vw) || 1280)
  const H = Math.max(240, Number(vh) || 800)
  const events = []
  const floatingList = []

  for (const b of store.bodies.values()) {
    // 凹陷弹簧回弹
    if (Math.abs(b.dentAmt) > 0.002 || Math.abs(b.dentVel) > 0.002) {
      const acc = -220 * b.dentAmt - 14 * b.dentVel
      b.dentVel += acc * dt
      b.dentAmt += b.dentVel * dt
      if (Math.abs(b.dentAmt) < 0.003 && Math.abs(b.dentVel) < 0.01) {
        b.dentAmt = 0
        b.dentVel = 0
      }
    }
    if (b.pickupAnim > 0) b.pickupAnim = Math.max(0, b.pickupAnim - dt * 3.5)

    // 碎片缓慢摩擦落定在地面
    if (b.status === 'shattered' && b.shards.length > 0) {
      for (const sh of b.shards) {
        if (sh.collected) continue
        sh.x = clamp(sh.x + sh.vx * dt, 8, W - 8)
        sh.y = clamp(sh.y + sh.vy * dt, 8, H - 8)
        sh.vx *= Math.pow(0.08, dt)
        sh.vy = (sh.vy + 220 * dt) * Math.pow(0.14, dt)
        sh.rot += sh.vrot * dt
        sh.vrot *= Math.pow(0.08, dt)
      }
      continue
    }

    // 长按原位磁力吸回动画
    if (b.status === 'recalling') {
      const dx = b.origin.x - b.x
      const dy = b.origin.y - b.y
      const dist = Math.hypot(dx, dy)
      if (dist < 10) {
        const cx = b.origin.x + b.w / 2
        const cy = b.origin.y + b.h / 2
        events.push({ type: 'landed', id: b.id, x: cx, y: cy, speed: 340 })
        if (b.biteNotches.length > 0) {
          b.x = b.origin.x
          b.y = b.origin.y
          b.rot = 0
          b.status = 'bitten_in_place'
        } else {
          store.bodies.delete(b.id)
        }
        store.seq += 1
        continue
      }
      const pull = Math.max(14, 20 * dt * 60)
      b.x += dx * Math.min(0.32, pull * 0.018)
      b.y += dy * Math.min(0.32, pull * 0.018)
      b.rot *= 0.82
      continue
    }

    if (b.status !== 'floating') continue

    // 积分位移 + 液态玻璃低摩擦滑动（绝不主动归位！）
    b.x += b.vx * dt
    b.y += b.vy * dt
    b.rot += b.vrot * dt
    const speedNow = Math.hypot(b.vx, b.vy)
    const drag = speedNow < 160 ? Math.pow(0.36, dt) : Math.pow(0.48, dt)
    b.vx *= drag
    b.vy *= drag
    b.vrot *= Math.pow(0.24, dt)
    if (Math.abs(b.vx) < 3) b.vx = 0
    if (Math.abs(b.vy) < 3) b.vy = 0
    if (Math.abs(b.vrot) < 2) b.vrot = 0

    // 4 面屏幕边框真实物理反弹 + 凹陷 + 高速裂痕/碎裂！
    let hitSide = ''
    let impactSpeed = 0
    if (b.x < 4) {
      b.x = 4; impactSpeed = Math.abs(b.vx); b.vx = Math.abs(b.vx) * 0.74; hitSide = 'left'
    } else if (b.x + b.w > W - 4) {
      b.x = W - 4 - b.w; impactSpeed = Math.abs(b.vx); b.vx = -Math.abs(b.vx) * 0.74; hitSide = 'right'
    }
    if (b.y < 4) {
      b.y = 4; impactSpeed = Math.max(impactSpeed, Math.abs(b.vy)); b.vy = Math.abs(b.vy) * 0.74; hitSide = hitSide || 'top'
    } else if (b.y + b.h > H - 4) {
      b.y = H - 4 - b.h; impactSpeed = Math.max(impactSpeed, Math.abs(b.vy)); b.vy = -Math.abs(b.vy) * 0.74; hitSide = hitSide || 'bottom'
    }

    if (hitSide && impactSpeed > 75) {
      b.dentX = hitSide === 'left' ? -1 : (hitSide === 'right' ? 1 : 0)
      b.dentY = hitSide === 'top' ? -1 : (hitSide === 'bottom' ? 1 : 0)
      b.dentAmt = clamp(impactSpeed / 720, 0.16, 0.92)
      b.dentVel = 2.4
      const ix = hitSide === 'left' ? 4 : (hitSide === 'right' ? W - 4 : b.x + b.w / 2)
      const iy = hitSide === 'top' ? 4 : (hitSide === 'bottom' ? H - 4 : b.y + b.h / 2)
      let shattered = false
      if (impactSpeed >= CRACK_SPEED_THRESHOLD) {
        b.hp -= 1
        b.cracks.push(...makeCrackLines(b.w, b.h, hitSide, store.seq + b.cracks.length))
        if (b.hp <= 0) {
          b.status = 'shattered'
          b.shatteredAt = Date.now()
          b.shards = makeShards(b.x, b.y, b.w, b.h, b.vx, b.vy, 12)
          b.vx = 0; b.vy = 0
          shattered = true
          store.seq += 1
        }
      }
      events.push({ type: shattered ? 'shatter' : (impactSpeed >= CRACK_SPEED_THRESHOLD ? 'crack' : 'bounce'), id: b.id, x: ix, y: iy, speed: impactSpeed, side: hitSide })
    }

    if (b.status === 'floating') floatingList.push(b)
  }

  // 方块与方块之间的真实 2D 弹性碰撞（A 与 B 动量交换 + 双向凹陷 + 高速裂痕！）
  for (let i = 0; i < floatingList.length; i++) {
    for (let j = i + 1; j < floatingList.length; j++) {
      const a = floatingList[i]
      const b = floatingList[j]
      if (a.status !== 'floating' || b.status !== 'floating') continue
      const acx = a.x + a.w / 2, acy = a.y + a.h / 2
      const bcx = b.x + b.w / 2, bcy = b.y + b.h / 2
      const ox = (a.w + b.w) / 2 - Math.abs(acx - bcx)
      const oy = (a.h + b.h) / 2 - Math.abs(acy - bcy)
      if (ox > 0 && oy > 0) {
        const nx = ox < oy ? (acx < bcx ? -1 : 1) : 0
        const ny = ox < oy ? 0 : (acy < bcy ? -1 : 1)
        const pen = Math.min(ox, oy) / 2 + 0.5
        a.x += nx * pen; a.y += ny * pen
        b.x -= nx * pen; b.y -= ny * pen

        const rvx = a.vx - b.vx
        const rvy = a.vy - b.vy
        const relAlongNormal = rvx * nx + rvy * ny
        if (relAlongNormal < 0) {
          const imp = -1.78 * relAlongNormal * 0.5
          a.vx += imp * nx; a.vy += imp * ny
          b.vx -= imp * nx; b.vy -= imp * ny
          const hitSpd = Math.abs(relAlongNormal)
          a.dentX = -nx; a.dentY = -ny; a.dentAmt = clamp(hitSpd / 650, 0.22, 0.88); a.dentVel = 2.2
          b.dentX = nx; b.dentY = ny; b.dentAmt = clamp(hitSpd / 650, 0.22, 0.88); b.dentVel = 2.2
          const mx = (acx + bcx) / 2
          const my = (acy + bcy) / 2
          for (const target of [a, b]) {
            if (hitSpd >= CRACK_SPEED_THRESHOLD) {
              target.hp -= 1
              target.cracks.push(...makeCrackLines(target.w, target.h, nx !== 0 ? (nx > 0 ? 'left' : 'right') : (ny > 0 ? 'top' : 'bottom'), store.seq + target.cracks.length))
              if (target.hp <= 0) {
                target.status = 'shattered'
                target.shatteredAt = Date.now()
                target.shards = makeShards(target.x, target.y, target.w, target.h, target.vx, target.vy, 12)
                target.vx = 0; target.vy = 0
                events.push({ type: 'shatter', id: target.id, x: mx, y: my, speed: hitSpd })
              }
            }
          }
          events.push({ type: 'collide', id: a.id, otherId: b.id, x: mx, y: my, speed: hitSpd })
        }
      }
    }
  }

  return events
}
