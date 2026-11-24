import { Component } from 'react'

/** 顶层 React 渲染故障护盾：阻断单组件异常导致桌面白屏，提供一键原地恢复。 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      console.error('[Harbor ErrorBoundary]', error)
    }
  }

  render() {
    if (!this.state.error) return this.props.children
    const msg = String((this.state.error && this.state.error.message) || this.state.error || '未知渲染错误')
    return (
      <div
        role="alert"
        style={{
          height: '100%',
          display: 'grid',
          placeItems: 'center',
          padding: 24,
          background: 'var(--stage-bg)',
          color: 'var(--text)',
        }}
      >
        <div
          style={{
            maxWidth: 520,
            padding: 22,
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--err)',
            background: 'var(--card-elevated)',
            boxShadow: 'var(--elev-2)',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <strong style={{ fontSize: 16, color: 'var(--err)' }}>界面遇到意外渲染异常</strong>
          <pre
            style={{
              margin: 0,
              padding: 10,
              borderRadius: 'var(--radius-sm)',
              background: 'var(--surface-subtle)',
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {msg}
          </pre>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              style={{
                padding: '7px 14px',
                borderRadius: 'var(--radius-full)',
                border: '1px solid var(--primary)',
                background: 'var(--primary)',
                color: 'var(--on-primary)',
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              重新挂载视图
            </button>
          </div>
        </div>
      </div>
    )
  }
}
