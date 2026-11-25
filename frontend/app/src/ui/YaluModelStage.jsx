import './YaluModelStage.css'

const AURA_MAP = {
  natural:   { filter: 'none', glow: 'rgba(130, 212, 168, 0.38)' },
  starlight: { filter: 'saturate(1.08) brightness(1.04)', glow: 'rgba(96, 190, 250, 0.44)' },
  crimson:   { filter: 'saturate(1.1) contrast(1.03)', glow: 'rgba(218, 92, 118, 0.42)' },
  glass:     { filter: 'brightness(1.06) contrast(1.04)', glow: 'rgba(255, 255, 255, 0.52)' },
}

const DEFAULT_ASSETS = {
  front: './assets/yalu/yalu-front.webp',
  turnFront: './assets/yalu/yalu-turn-front.webp',
  side: './assets/yalu/yalu-turn-side.webp',
  back: './assets/yalu/yalu-turn-back.webp',
  staff: './assets/yalu/prop-staff.webp',
  bell: './assets/yalu/prop-bell.webp',
  showcaseVideo: './assets/yalu/yalu-showcase.mp4',
}

export default function YaluModelStage({
  assets = null,
  actionState = 'idle',
  facing = -1,
  lookX = 0,
  lookY = 0,
  dragTilt = 0,
  propLoadout = 'both',
  auraTheme = 'natural',
  viewAngle = 'auto',
  scale = 1,
  width = 128,
  height = 176,
}) {
  const res = { ...DEFAULT_ASSETS, ...(assets || {}) }
  const aura = AURA_MAP[auraTheme] || AURA_MAP.natural

  if (viewAngle === 'video') {
    return (
      <div className="yms-stage" style={{ width, height, pointerEvents: 'auto' }} data-yalu-stage="video">
        <video
          className="yms-video"
          src={res.showcaseVideo}
          autoPlay
          loop
          muted
          playsInline
          controls
        />
      </div>
    )
  }

  let spriteSrc = res.front
  let autoFlip = facing > 0 ? -1 : 1
  if (viewAngle === 'front') {
    spriteSrc = res.front
    autoFlip = 1
  } else if (viewAngle === 'side') {
    spriteSrc = res.side
    autoFlip = 1
  } else if (viewAngle === 'back') {
    spriteSrc = res.back
    autoFlip = 1
  } else {
    if (actionState === 'run' || actionState === 'collect_shards') {
      spriteSrc = res.side
    } else if (actionState === 'repair_glass' || actionState === 'crouch_click' || actionState === 'write_input' || actionState === 'sneak_eat') {
      spriteSrc = res.back
      autoFlip = 1
    } else {
      spriteSrc = res.front
      autoFlip = facing > 0 ? -1 : 1
    }
  }

  const showStaff = propLoadout === 'both' || propLoadout === 'staff' || actionState === 'magic_blackhole' || actionState === 'repair_glass' || actionState === 'write_input' || actionState === 'supervising'
  const showBell = propLoadout === 'both' || propLoadout === 'bell' || actionState === 'deliver' || actionState === 'happy' || actionState === 'dance'

  const tiltDeg = Math.max(-26, Math.min(26, (Number(dragTilt) || 0) * 55))
  const parallaxX = Math.max(-4, Math.min(4, (Number(lookX) || 0) * 3.5))
  const parallaxY = Math.max(-3, Math.min(3, (Number(lookY) || 0) * 2.5))
  const safeScale = Math.max(0.75, Math.min(1.35, Number(scale) || 1))

  const moodIcon = actionState === 'pat' || actionState === 'happy'
    ? '💕'
    : (actionState === 'deliver' ? '🔔✨' : (actionState === 'sleep' ? '💤' : (actionState === 'grabbed' || actionState === 'thrown' ? '💦' : '')))

  return (
    <div
      className="yms-stage"
      data-yalu-stage="sprite"
      style={{ width, height, '--yms-glow': aura.glow }}
    >
      <span className="yms-aura" aria-hidden="true" />
      <div
        className="yms-rig"
        data-action={actionState}
        style={{
          transform: `translate3d(${parallaxX.toFixed(1)}px, ${parallaxY.toFixed(1)}px, 0) scale(${safeScale.toFixed(3)}) rotate(${tiltDeg.toFixed(1)}deg)`,
        }}
      >
        {actionState === 'supervising' && <span className="yms-supervise-ring" aria-hidden="true" />}
        {actionState === 'magic_blackhole' && <span className="yms-blackhole" aria-hidden="true" />}

        <img
          className="yms-sprite"
          src={spriteSrc}
          alt="芽露"
          draggable={false}
          style={{
            transform: `scaleX(${autoFlip})`,
            filter: aura.filter !== 'none'
              ? `${aura.filter} drop-shadow(0 10px 18px rgba(15, 28, 56, 0.24))`
              : 'drop-shadow(0 10px 18px rgba(15, 28, 56, 0.24))',
          }}
        />

        {showStaff && res.staff && (
          <img className="yms-prop-staff" src={res.staff} alt="" draggable={false} aria-hidden="true" />
        )}
        {showBell && res.bell && (
          <img className="yms-prop-bell" src={res.bell} alt="" draggable={false} aria-hidden="true" />
        )}
        {moodIcon && <span className="yms-mood-float" aria-hidden="true">{moodIcon}</span>}
      </div>
    </div>
  )
}
