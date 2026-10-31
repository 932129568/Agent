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
  // P0-1c W5：recent 条目 {path, name, ts}（workspace_service.touch_recent_ws 同构）
  if (!dir) return
  const target = path.resolve(String(dir))
  recentWs = [
    { path: target, name: path.basename(target) || target, ts: Date.now() / 1000 },
    ...recentWs.filter(item => item.path !== target),
  ].slice(0, 12)
  persist()
}

export async function getEffectiveWs(sid) {
  // P0-1c W1：{sid, ws, source, exists}（workspace_service.py:99-107，无 ok 键；
  // sid 原样回传——空即 null 语义）
  const id = sid || ''
  let ws = runtime.cwd
  let source = 'global'
  if (id && runtime.sessionWs[id]) { ws = runtime.sessionWs[id]; source = 'session' }
  return okJson({ sid: id, ws, source, exists: !!(ws && fs.existsSync(ws) && fs.statSync(ws).isDirectory()) })
}

export async function getSessionWs(sid) {
  // P0-1c W2：{ws, bound}（workspace_service.py:94-97——get 无 ok 键，ws 回落 cwd）
  const bound = !!(sid && runtime.sessionWs[sid])
  return okJson({ ws: (sid && runtime.sessionWs[sid]) || runtime.cwd, bound })
}

export async function setSessionWs(sid, dir, enabled = true) {
  // P0-1c W2：workspace_service.py:75-93——空 path 或禁用即解绑；目录校验；
  // touch recent（path 或 cwd）；响应 {ok, sid, ws(回落 cwd), bound}
  if (!sid) return okJson({ ok: false, error: '缺少 sid' })
  const target = String(dir || '')
  if (target && enabled) {
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      return okJson({ ok: false, error: `目录不存在: ${target}` })
    }
    runtime.sessionWs[sid] = path.resolve(target)
  } else {
    delete runtime.sessionWs[sid]
  }
  touchRecent(target || runtime.cwd)
  persist()
  const ws = runtime.sessionWs[sid] || runtime.cwd
  return okJson({ ok: true, sid, ws, bound: !!runtime.sessionWs[sid] })
}

export async function deleteSessionWs(sid) {
  // P0-1c W7：裸 '{"ok":true}'（workspace_service.py:111-119——sid 空串亦合法）
  delete runtime.sessionWs[sid || '']
  wsEnabledMap.delete(sid || '')
  persist()
  return okJson({ ok: true })
}

export async function getWsEnabled(sid) {
  // P0-1c W3：{enabled}（workspace_service.py:126-128——get 无 ok 键）
  return okJson({ enabled: wsEnabledFor(sid || runtime.currentSid) })
}

export async function setWsEnabled(sid, enabled) {
  // P0-1c W3：{ok, enabled}（workspace_service.py:121-124——无 sid 回显）
  const id = sid || runtime.currentSid
  if (id) wsEnabledMap.set(id, !!enabled)
  persist()
  return okJson({ ok: true, enabled: wsEnabledFor(id) })
}

export async function getWsState(sid) {
  // P0-1c W4：{ws, bound, enabled, recent[:8]}（workspace_service.py:130-142——无 ok/exists）
  const bound = !!(sid && runtime.sessionWs[sid])
  return okJson({
    ws: (sid && runtime.sessionWs[sid]) || runtime.cwd, bound,
    enabled: wsEnabledFor(sid || runtime.currentSid),
    recent: recentWs.slice(0, 8),
  })
}

export async function setWsDir(dir) {
  // P0-1c W7：{ok, ws}（workspace_service.py:165-176——path 键改 ws）
  const target = String(dir || '')
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    return okJson({ ok: false, error: '目录不存在' })
  }
  setCwd(target)
  touchRecent(target)
  return okJson({ ok: true, ws: runtime.cwd })
}

export async function listRecentWs() {
  // P0-1c W5：裸 JSON 数组（workspace_service.py:156-162——原样回放不包装不过滤）
  return JSON.stringify(recentWs)
}

/** 消毒文件名（workspace_service.sanitize_name:203-206：非法字符替换 + .. 穿越）。 */
export function sanitizeName(name) {
  const safe = String(name || 'attachment').replace(/[\\/:*?<>|]/g, '_').replace(/\.\./g, '__')
  return safe || 'attachment'
}

const pad2 = n => String(n).padStart(2, '0')

export async function saveWorkspaceFile(name, text) {
  // P0-1c W6：返回裸绝对路径字符串（legacy ok(p) 直通语义）+
  // YYYYMMDD_HHMMSS_ 时间戳前缀（N05 <TSFN> 归一）
  try {
    const root = effectiveRoot(runtime.currentSid)
    const dir = path.join(root, 'attachments')
    fs.mkdirSync(dir, { recursive: true })
    const now = new Date()
    const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}_`
      + `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
    const target = path.join(dir, `${stamp}_${sanitizeName(name)}`)
    fs.writeFileSync(target, String(text ?? ''), 'utf8')
    return target
  } catch (error) { return okJson({ ok: false, error: String(error.message || error) }) }
}

export async function copyIntoWs(src, dstName) {
  // P0-1c W8：HHMMSS_ 前缀 + {ok, path(绝对)}（workspace_service.py:200-222）
  try {
    const source = String(src || '')
    if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
      return errJson(`文件不存在: ${source}`)
    }
    const root = effectiveRoot(runtime.currentSid)
    const dir = path.join(root, 'attachments')
    fs.mkdirSync(dir, { recursive: true })
    const now = new Date()
    const stamp = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
    const base = `${stamp}_${sanitizeName(dstName || path.basename(source))}`
    const target = path.join(dir, base)
    // 双保险：目标必须仍在 attachments 内
    const norm = value => path.normalize(path.resolve(value)).toLowerCase()
    if (norm(target) !== norm(dir) && !norm(target).startsWith(`${norm(dir)}${path.sep}`)) {
      return errJson(`非法文件名: ${dstName}`)
    }
    fs.copyFileSync(source, target)
    return okJson({ ok: true, path: target })
  } catch (error) { return errJson(String(error.message || error)) }
}

/* copy_path/move_path 已迁移至 files.js（P0-1c F4：绝对路径口径 + 存在性校验） */

async function powerShellRecycle(target, isDir) {
  // Microsoft.VisualBasic.FileIO SendToRecycleBin（与 legacy send2trash 同因同果：
  // 真实 OS 回收站副作用；差分环境该命令不在 mock 表 → 放行真实执行）
  const method = isDir ? 'DeleteDirectory' : 'DeleteFile'
  const script = `Add-Type -AssemblyName Microsoft.VisualBasic; `
    + `[Microsoft.VisualBasic.FileIO.FileSystem]::${method}(${JSON.stringify(target)}, `
    + `'OnlyErrorDialogs', 'SendToRecycleBin')`
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
}

/** P0-1c F6：delete_path 与 file_service.py:372-420 同构。
 * cwd/生效根/驱动器根拒绝 → 回收站（PowerShell VB；失败以文件是否仍在磁盘为准）→
 * 永久删除两条降级文案。响应 {ok, path(绝对), mode}。 */
export async function deletePath(input, recycle = true, token = null) {
  // 危险操作接入护栏：always/session 档需要一次性 token 或会话信任
  const refusal = await enforceExec('delete_path', { path: input }, token)
  if (refusal) return errJson(refusal)

  const target = resolveWs(input)
  try {
    const normCase = value => path.normalize(path.resolve(value)).toLowerCase()
    const cwdN = normCase(runtime.cwd || process.cwd())
    const rootN = normCase(effectiveRoot(runtime.currentSid))
    if (normCase(target) === cwdN || normCase(target) === rootN
        || path.dirname(target) === target) {
      return errJson('拒绝删除：工作目录本身或驱动器根目录')
    }
    if (!fs.existsSync(target)) return errJson(`路径不存在: ${target}`)
    let recycleUnavailable = false
    let recycleBroken = false
    if (recycle) {
      try {
        await powerShellRecycle(target, fs.statSync(target).isDirectory())
        return okJson({ ok: true, path: target, mode: '回收站' })
      } catch (error) {
        if (error && (error.code === 'ENOENT' || /powershell/i.test(String(error.message || '')))) {
          recycleUnavailable = true
        }
        // 以文件是否仍在磁盘为准（send2trash 同款「先移动成功后抛错」防御）
        if (!fs.existsSync(target)) return okJson({ ok: true, path: target, mode: '回收站' })
        recycleBroken = true
      }
    }
    fs.rmSync(target, { recursive: true, force: true })
    const mode = recycleUnavailable
      ? '永久删除(未装 send2trash，未进回收站)⚠️不可恢复，请谨慎'
      : recycleBroken
        ? '永久删除(回收站暂不可用，未进回收站)⚠️不可恢复，请谨慎'
        : '永久删除'
    return okJson({ ok: true, path: target, mode })
  } catch (error) {
    return errJson(error.message || String(error))
  }
}
