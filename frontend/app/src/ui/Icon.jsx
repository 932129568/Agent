/** 图标组件：统一走 SVG symbol 引用，避免各域自造图标。 */
export default function Icon({ name, size = 20, className = '' }) {
  if (!name) return null
  return (
    <svg className={'ui-icon ' + className} width={size} height={size}
      aria-hidden="true" focusable="false">
      <use href={'#i-' + name} />
    </svg>
  )
}
