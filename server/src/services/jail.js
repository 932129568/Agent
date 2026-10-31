/**
 * 路径监狱：所有文件工具共用的工作区越界防护。
 *
 * 与 legacy `_resolve_ws` 同口径：
 *   - 反复剥成对引号与空白；
 *   - 相对路径落到有效工作区下，绝对路径仅在监狱内放行；
 *   - realpath 后必须等于 root 或位于 root 之下（防 `..` 与符号链接逃逸）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { runtime, effectiveRoot } from '../runtime.js'

export class PathJailError extends Error {
  constructor(message) {
    super(message)
    this.code = 'PATH_JAIL'
  }
}

export function resolveWs(input, sid = runtime.currentSid) {
  const root = path.resolve(effectiveRoot(sid))
  let p = String(input == null ? '' : input).trim()
  while (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1).trim()
  if (!p) throw new PathJailError('缺少 path 参数')

  // 与 legacy 一致：以 / 或 \ 开头但不是盘符绝对路径的，按相对路径处理
  if (!p.startsWith('\\\\') && /^[\\/]/.test(p) && !(p.length > 1 && p[1] === ':')) {
    p = p.replace(/^[\\/]+/, '')
  }
  if (!path.isAbsolute(p)) p = path.join(root, p)

  const abs = fs.realpathSync.native ? realpathSafe(p) : path.resolve(p)
  const absRoot = realpathSafe(root)
  if (abs !== absRoot && !abs.startsWith(absRoot + path.sep)) {
    throw new PathJailError(`路径越界：仅限工作区 ${root} 内操作，请勿换路径重试；需要外部文件请让用户移入工作区。`)
  }
  return abs
}

function realpathSafe(p) {
  try {
    return fs.realpathSync(p)
  } catch (error) {
    // 目标尚不存在（新建文件/目录）时，退回到其最近的已存在祖先做判定
    const parent = path.dirname(p)
    if (parent === p) return path.resolve(p)
    return path.join(realpathSafe(parent), path.basename(p))
  }
}

export function shortPath(abs, sid = runtime.currentSid) {
  const root = path.resolve(effectiveRoot(sid))
  const rel = path.relative(root, abs)
  return rel && !rel.startsWith('..') ? rel : abs
}
