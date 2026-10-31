/**
 * 宿主接缝（P0-4 §2.2/T01）：Node 服务脱离纯 CLI 运行（A1 Electron 主进程 /
 * A3 独立子进程）时，宿主经本模块注册能力提供者。无宿主注册时，所有调用点
 * 行为与纯 Node 运行完全一致（零副作用、零行为翻转）。
 *
 * 当前唯一预期消费者：admin 人审对话框 provider（T03 接线
 * services/commands.js 的 adminMessageBoxDecision——接线前该函数维持既有
 * fail-closed 语义；差分环境无宿主 → fail-closed 兜底不变，契约零翻转）。
 */

/**
 * 宿主提供者形态（T03 定型）：
 *   - adminMessageBox(cmd): Promise<{allow: boolean}> —— admin 提权人审。
 * @type {{adminMessageBox?: (cmd: string) => Promise<{allow: boolean}>}|null}
 */
let host = null

/** 宿主注册口（幂等：后注册覆盖前者；传 null 注销=回退无宿主行为）。 */
export function setHostDialogProvider(provider) {
  host = provider ? Object.freeze({ ...provider }) : null
}

/** 读取当前宿主提供者（无宿主返回 null——调用方按既有 fail-closed 走）。 */
export function getHostDialogProvider() {
  return host
}

/** 宿主在场判定（测试与日志用）。 */
export function hasHost() {
  return host !== null
}
