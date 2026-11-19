/**
 * 工作日志与工作目录：与 legacy workspace_service 同形。
 *
 *   get_cwd()               → 当前工作目录（字符串原文，非 JSON）
 *   set_workspace(path)     → 目录存在才切换，返回 {"ok":true,"path":...}
 *   get_worklog()           → <root>/_glm_worklog.md 原文
 *   append_worklog(text)    → 追加 `- [MM-DD HH:MM] <text 截 500>`，UTF-8
 */
import fs from 'node:fs'
import path from 'node:path'
import { runtime, setCwd, setSessionCwd, effectiveRoot } from '../runtime.js'
import { ctxSid, ctxExplicit, ctxRoot, sessionCwds } from '../session-context.js'
import { readTextIfExists } from '../paths.js'
import { touchRecent } from './workspace.js'

export function getCwd() {
  // P0-3：header 请求若本会话有 cwd 覆盖则返回覆盖值（无头=全局 cwd 现状）
  if (ctxExplicit() && ctxSid() && sessionCwds.has(ctxSid())) return sessionCwds.get(ctxSid())
  return runtime.cwd
}

export function setWorkspace(dir) {
  const target = String(dir || '')
  if (!target || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    return JSON.stringify({ error: `目录不存在: ${target}` })
  }
  // P0-3（Q3 裁定）：header 请求的工作区切换只影响本会话（写 per-sid
  // sessionCwds，不污染其他会话的全局 cwd）；无头路径写全局 cwd 现状不变
  if (ctxExplicit() && ctxSid()) {
    setSessionCwd(ctxSid(), target)
    touchRecent(target)
    return JSON.stringify({ ok: true, path: target })
  }
  setCwd(target)
  // P0-1c W 补齐（api.py:477-481 修复⑦）：经 api 直改目录后 recent 列表须含该目录
  // （快捷条/面板下拉数据源），否则 set_workspace 切换的目录不进 recent
  touchRecent(target)
  return JSON.stringify({ ok: true, path: runtime.cwd })
}

function worklogPath() {
  return path.join(ctxRoot(), '_glm_worklog.md')
}

export function getWorklog() {
  return readTextIfExists(worklogPath(), '')
}

export function appendWorklog(text) {
  const file = worklogPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const ts = `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  const line = `- [${ts}] ${String(text).slice(0, 500)}\n`
  fs.appendFileSync(file, line, 'utf8')
  return '{"ok":true}'
}
