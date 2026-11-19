/** 加载指示：状态由 props 驱动，禁止调用方直接改 DOM。 */
export default function Spinner({ label = '处理中', size = 16 }) {
  return (
    <span className="harbor-spinner" role="status" aria-live="polite">
      <span className="harbor-spinner-dot" style={{ width: size, height: size }} />
      <span>{label}</span>
    </span>
  )
}
