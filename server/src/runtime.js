/**
 * 进程运行态：当前 sid、会话工作区绑定、cwd。
 * 持久化到独立 runtime.json（config.json 零污染）。
 *
 * 已知边界：currentSid 是进程级单值，与 legacy RuntimeState 同形。
 * 多会话真正并行时必须改为 per-run 上下文（见升级文档未完成项）。
 */
import { RUNTIME_PATH, readJsonIfExists, atomicWriteJson } from './paths.js'

const persisted = readJsonIfExists(RUNTIME_PATH, {}) || {}

export const runtime = {
  currentSid: persisted.currentSid || null,
  cwd: persisted.cwd || process.cwd(),
  sessionWs: persisted.sessionWs || {},
}

export function setCurrentSid(sid) {
  runtime.currentSid = sid || null
  return runtime.currentSid
}

export function setCwd(dir) {
  runtime.cwd = dir
  atomicWriteJson(RUNTIME_PATH, {
    currentSid: runtime.currentSid,
    cwd: runtime.cwd,
    sessionWs: runtime.sessionWs,
  })
  return runtime.cwd
}

export function setSessionWs(sid, dir) {
  if (sid) runtime.sessionWs[sid] = dir
  setCwd(runtime.cwd)
}

export function effectiveRoot(sid) {
  return (sid && runtime.sessionWs[sid]) || runtime.cwd
}
