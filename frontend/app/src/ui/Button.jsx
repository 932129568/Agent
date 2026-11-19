/** 无业务语义的展示组件（规范 §4）：props 驱动，禁止状态与后端调用。 */
export default function Button({ children, onClick, variant = 'default', disabled = false, title }) {
  return (
    <button type="button" className={'harbor-btn harbor-btn-' + variant}
      onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  )
}
