/**
 * 平台层 DOM 适配（规范 §7 唯一例外）。
 *
 * 白名单登记（每个例外必须写理由与退出条件）：
 *  1. mountPoint() —— React root 需要一个初始挂载节点；退出条件：生产链改为直接
 *     以 document.body 为容器后删除（需用户确认布局影响）。
 *  2. focusById() —— 第三方输入组件与接管流程需要命令式聚焦；退出条件：全部输入
 *     组件 React 化后改用 ref。
 *
 * 除本文件外，任何层出现原生 DOM API 都会被 arch-contract.mjs 判违规。
 */
export function mountPoint(id = 'harbor-app-root') {
  /* eslint-disable-next-line no-restricted-globals -- 白名单 1：React 挂载点 */
  return typeof document !== 'undefined' ? document.getElementById(id) : null
}

export function focusById(id) {
  /* eslint-disable-next-line no-restricted-globals -- 白名单 2：命令式聚焦 */
  const el = typeof document !== 'undefined' ? document.getElementById(id) : null
  if (el && typeof el.focus === 'function') el.focus()
  return !!el
}
