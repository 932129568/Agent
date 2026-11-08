/**
 * 进程运行态：当前 sid、会话工作区绑定、cwd。
 * 持久化到独立 runtime.json（config.json 零污染）。
 *
 * P0-3：currentSid 保留为 legacy 全局默认上下文（Q6 永久保留）；header 请求
 * 的 per-sid 覆盖由 session-context.js 承载。sessionCwds（per-sid cwd 覆盖）
 * 并入本文件持久化（向后兼容缺省 {}）。
 */
import { RUNTIME_PATH, readJsonIfExists, atomicWriteJson } from './paths.js'

const persisted = readJsonIfExists(RUNTIME_PATH, {}) || {}

export const runtime = {
  currentSid: persisted.currentSid || null,
  cwd: persisted.cwd || process.cwd(),
  sessionWs: persisted.sessionWs || {},
  // P0-3：per-sid cwd 覆盖（header 请求的 set_workspace 写入；无头不写）
  sessionCwds: persisted.sessionCwds || {},
}

export function setCurrentSid(sid) {
  runtime.currentSid = sid || null
  return runtime.currentSid
}

export function setCwd(dir) {
  runtime.cwd = dir
  atomicWriteJson(RUNTIME_PATH, {
    // R37 修复（S2-5）：以**盘上现值**为底合并写——workspace.js 同文件持有
    // recentWs/wsEnabled 键，原 setCwd/setSessionCwd/setSessionWs 高频短形状
    // 整写把它们静默抹掉（set_ws_enabled(false) 重启回真、recentWs 清零）。
    ...readJsonIfExists(RUNTIME_PATH, {}),
    currentSid: runtime.currentSid,
    cwd: runtime.cwd,
    sessionWs: runtime.sessionWs,
    sessionCwds: runtime.sessionCwds,
  })
  return runtime.cwd
}

/** header 请求的 per-sid cwd 覆盖写入（不影响其他会话的全局 cwd）。 */
export function setSessionCwd(sid, dir) {
  if (sid) runtime.sessionCwds[sid] = dir
  setCwd(runtime.cwd)
  return dir
}

export function setSessionWs(sid, dir) {
  if (sid) runtime.sessionWs[sid] = dir
  setCwd(runtime.cwd)
}

export function effectiveRoot(sid) {
  return (sid && runtime.sessionWs[sid]) || runtime.cwd
}
