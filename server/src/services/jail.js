/**
 * 路径监狱：所有文件工具共用的工作区越界防护（R9 支持关闭沙箱后全盘用户路径自由访问）。
 *
 * 口径：
 *   - 沙箱开启（默认 sandbox.enabled !== false）：严格锁定在当前工作区 ctxRoot() 之内；
 *   - 沙箱关闭（用户在设置里关闭沙箱）：相对路径仍落到工作区 ctxRoot() 下，显式传入的
 *     桌面/文档/项目绝对路径全量放行，仅拦截操作系统核心目录（Windows / System32 / /etc / /System）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { effectiveRoot } from '../runtime.js'
import { ctxRoot } from '../session-context.js'
import { readConfigNormalized } from './jsonstore.js'
import { CONFIG_SPECS } from './config-specs.js'

export class PathJailError extends Error {
  constructor(message) {
    super(message)
    this.code = 'PATH_JAIL'
  }
}

export function isSandboxDisabled() {
  try {
    const { config } = readConfigNormalized(CONFIG_SPECS.sandbox)
    return config && config.enabled === false
  } catch {
    return false
  }
}

function isProtectedOsSystemPath(absPath) {
  const norm = path.normalize(String(absPath || '')).toLowerCase()
  if (process.platform === 'win32') {
    const winDir = path.normalize(process.env.WINDIR || 'C:\\Windows').toLowerCase()
    if (norm === winDir || norm.startsWith(winDir + path.sep)) return true
    if (/^[a-z]:\\(?:system volume information|\$recycle\.bin)(?:\\|$)/i.test(norm)) return true
    return false
  }
  return ['/etc', '/usr', '/bin', '/sbin', '/boot', '/dev', '/proc', '/sys', '/system'].some(
    (sys) => norm === sys || norm.startsWith(sys + '/')
  )
}

export function resolveWs(input, sid) {
  const root = path.resolve(sid === undefined ? ctxRoot() : effectiveRoot(sid))
  let p = String(input == null ? '' : input).trim()
  while (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1).trim()
  if (!p) throw new PathJailError('缺少 path 参数')

  if (!p.startsWith('\\\\') && /^[\\/]/.test(p) && !(p.length > 1 && p[1] === ':')) {
    p = p.replace(/^[\\/]+/, '')
  }
  const explicitAbs = path.isAbsolute(p)
  if (!explicitAbs) p = path.join(root, p)

  const abs = fs.realpathSync.native ? realpathSafe(p) : path.resolve(p)
  const absRoot = realpathSafe(root)
  const insideWs = abs === absRoot || abs.startsWith(absRoot + path.sep)

  if (!insideWs) {
    if (isSandboxDisabled() && explicitAbs && !isProtectedOsSystemPath(abs)) {
      return abs
    }
    throw new PathJailError(`路径越界：仅限工作区 ${root} 内操作（如需直接读写桌面或外部路径，可在「设置 → 工具、护栏与沙箱」关闭沙箱限制）。`)
  }
  return abs
}

function realpathSafe(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    const parent = path.dirname(p)
    if (parent === p) return path.resolve(p)
    return path.join(realpathSafe(parent), path.basename(p))
  }
}

export function shortPath(abs, sid) {
  const root = path.resolve(sid === undefined ? ctxRoot() : effectiveRoot(sid))
  const rel = path.relative(root, abs)
  return rel && !rel.startsWith('..') ? rel.split(path.sep).join('/') : abs
}
