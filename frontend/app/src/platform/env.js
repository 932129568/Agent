/** 平台环境适配（规范 §2）：唯一读取全局环境的位置。 */
export function sessionId() {
  const g = globalThis
  return (g.HarborBridge && g.HarborBridge.sid) || g.__HARBOR_SID__ || ''
}

export function appVersion() {
  return globalThis.APP_VERSION || '0.0.0'
}

export function isFileProtocol() {
  return typeof location !== 'undefined' && location.protocol === 'file:'
}

/** 预编译 libs 适配：feature 层禁止直接读 window.marked / window.DOMPurify。 */
export function libs() {
  const g = globalThis
  return {
    marked: g.marked || null,
    purify: g.DOMPurify || null,
    highlight: g.hljs || null,
    flate: g.flate || null,
    uiSchema: g.HarborUISchema || null,
  }
}
