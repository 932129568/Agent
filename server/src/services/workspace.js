/**
 * 会话工作区族：绑定/解绑、启用开关、最近目录、受控文件写。
 *
 * 与 legacy 同口径：
 *   - 每个会话可绑定独立工作区，未绑定回落全局 cwd；
 *   - `set_ws_enabled(false)` 后文件工具应对该会话不可用（在 jail 层判定）；
 *   - 删除/移动/复制同样受路径监狱约束，回收站不可用时按配置直接删除并留审计字段。
 */
import fs from 'node:fs'
import path from 'node:path'
import { runtime, setCwd, effectiveRoot } from '../runtime.js'
import { resolveWs, shortPath } from './jail.js'
import { atomicWriteJson, RUNTIME_PATH } from '../paths.js'
import { enforceExec } from './guard.js'

const okJson = value => JSON.stringify(value)
const errJson = message => JSON.stringify({ error: String(message) })

const wsEnabledMap = new Map()
let recentWs = []

function persist() {
  atomicWriteJson(RUNTIME_PATH, {
    currentSid: runtime.currentSid,
    cwd: runtime.cwd,
    sessionWs: runtime.sessionWs,
    recentWs,
  })
}

export function wsEnabledFor(sid) {
  if (sid && wsEnabledMap.has(sid)) return wsEnabledMap.get(sid)
  return true
}

export function touchRecent(dir) {
  if (!dir) return
  recentWs = [dir, ...recentWs.filter(item => item !== dir)].slice(0, 12)
  persist()
}

export async function getEffectiveWs(sid) {
  const id = sid || runtime.currentSid
  const root = effectiveRoot(id)
  return okJson({ ok: true, ws: root, enabled: wsEnabledFor(id), bound: !!(id && runtime.sessionWs[id]) })
}

export async function getSessionWs(sid) {
  const id = sid || runtime.currentSid
  return okJson({ ok: true, sid: id, ws: (id && runtime.sessionWs[id]) || null })
}

export async function setSessionWs(sid, dir, enabled = true) {
  if (!sid) return errJson('缺少 sid')
  const target = String(dir || '')
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    return errJson(`目录不存在: ${target}`)
  }
  runtime.sessionWs[sid] = target
  wsEnabledMap.set(sid, enabled !== false)
  touchRecent(target)
  persist()
  return okJson({ ok: true, sid, ws: target, enabled: wsEnabledFor(sid) })
}

export async function deleteSessionWs(sid) {
  if (!sid) return errJson('缺少 sid')
  delete runtime.sessionWs[sid]
  wsEnabledMap.delete(sid)
  persist()
  return okJson({ ok: true, sid })
}

export async function getWsEnabled(sid) {
  const id = sid || runtime.currentSid
  return okJson({ ok: true, enabled: wsEnabledFor(id) })
}

export async function setWsEnabled(sid, enabled) {
  const id = sid || runtime.currentSid
  if (!id) return errJson('缺少 sid')
  wsEnabledMap.set(id, !!enabled)
  persist()
  return okJson({ ok: true, sid: id, enabled: wsEnabledFor(id) })
}

export async function getWsState(sid) {
  const id = sid || runtime.currentSid
  const root = effectiveRoot(id)
  return okJson({
    ok: true, ws: root, enabled: wsEnabledFor(id),
    exists: fs.existsSync(root), bound: !!(id && runtime.sessionWs[id]),
  })
}

export async function setWsDir(dir) {
  const target = String(dir || '')
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    return errJson(`目录不存在: ${target}`)
  }
  setCwd(target)
  touchRecent(target)
  return okJson({ ok: true, path: runtime.cwd })
}

export async function listRecentWs() {
  return okJson(recentWs.filter(dir => fs.existsSync(dir)))
}

export async function saveWorkspaceFile(name, text) {
  const clean = String(name || '').replace(/[\\/]/g, '_').replace(/\.\./g, '_')
  if (!clean) return errJson('缺少文件名')
  const root = effectiveRoot(runtime.currentSid)
  const dir = path.join(root, 'attachments')
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, clean)
  fs.writeFileSync(target, String(text ?? ''), 'utf8')
  return okJson({ ok: true, path: shortPath(target) })
}

export async function copyIntoWs(src, dstName) {
  const source = String(src || '')
  if (!fs.existsSync(source)) return errJson(`源文件不存在: ${source}`)
  const root = effectiveRoot(runtime.currentSid)
  const dir = path.join(root, 'attachments')
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, dstName ? String(dstName) : path.basename(source))
  fs.copyFileSync(source, target)
  return okJson({ ok: true, path: shortPath(target) })
}

export async function copyPath(src, dst) {
  const from = resolveWs(src)
  const to = resolveWs(dst)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.cpSync(from, to, { recursive: true })
  return okJson({ ok: true, src: shortPath(from), dst: shortPath(to) })
}

export async function movePath(src, dst) {
  const from = resolveWs(src)
  const to = resolveWs(dst)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.renameSync(from, to)
  return okJson({ ok: true, src: shortPath(from), dst: shortPath(to) })
}

export async function deletePath(input, recycle = true, token = null) {
  // 危险操作接入护栏：always/session 档需要一次性 token 或会话信任
  const refusal = await enforceExec('delete_path', { path: input }, token)
  if (refusal) return errJson(refusal)

  const target = resolveWs(input)
  if (!fs.existsSync(target)) return errJson('目标不存在')
  // 桌面端的回收站能力依赖 OS API；Node 侧当前直接删除并显式回报 recycle=false，
  // 不伪称「已入回收站」。
  fs.rmSync(target, { recursive: true, force: true })
  return okJson({ ok: true, path: shortPath(target), recycled: false, requested_recycle: !!recycle })
}
