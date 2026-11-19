/** 通用面板容器（规范 §4）：纯展示，无状态、无后端调用。 */
export default function Panel({ title, actions, children, className = '' }) {
  return (
    <section className={'harbor-panel ' + className}>
      {title ? <header className="harbor-panel-head">
        <h2>{title}</h2>
        {actions ? <div className="harbor-panel-actions">{actions}</div> : null}
      </header> : null}
      <div className="harbor-panel-body">{children}</div>
    </section>
  )
}
