/** 高辨识度 Harbor 灯塔 H 几何徽标（16px–64px 皆清晰锐利，告别杂乱细密多环） */
export default function HarborLogo({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <defs>
        <linearGradient id="harborLogoGrad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#E87A52" />
          <stop offset="100%" stopColor="#B8462A" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="url(#harborLogoGrad)" />
      <rect x="8" y="7.5" width="4.6" height="17" rx="1.8" fill="#FFFCF7" />
      <rect x="19.4" y="7.5" width="4.6" height="17" rx="1.8" fill="#FFFCF7" />
      <rect x="11.2" y="14.2" width="9.6" height="4" rx="1.6" fill="#FFFCF7" />
      <circle cx="16" cy="9.8" r="2.2" fill="#FFE096" />
    </svg>
  )
}
