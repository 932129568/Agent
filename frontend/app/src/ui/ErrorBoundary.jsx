import React from 'react'

/** 统一错误边界（规范 §7）：任何域抛错都收口到可读提示，不白屏。 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error, info) {
    if (typeof console !== 'undefined') console.error('[Harbor] 组件错误：', error, info)
  }
  render() {
    if (!this.state.error) return this.props.children
    const message = String(this.state.error && this.state.error.message || this.state.error)
    return React.createElement('div', { role: 'alert', className: 'harbor-error' },
      React.createElement('strong', null, '界面出错了'),
      React.createElement('p', null, message),
      React.createElement('button', {
        type: 'button',
        onClick: () => this.setState({ error: null }),
      }, '重试'))
  }
}
