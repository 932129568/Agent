/**
 * 文件工具族（无命令执行面）：read_file / read_more / list_dir / write_file /
 * append_file / search_replace / make_dir / get_file_info。
 *
 * 安全口径：所有路径必须过 `resolveWs` 监狱；写入一律原子写或追加，不做
 * 任何 shell 拼接。编码兼容 UTF-8(BOM) / UTF-8 / GBK（中文 Windows 常见）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import iconv from 'iconv-lite'
import { resolveWs, shortPath } from './jail.js'

const MAX_LIST = 200
const textCache = new Map()
const fingerprint = new Map()

const okJson = value => JSON.stringify(value)
const errJson = message => JSON.stringify({ error: String(message) })

function decodeBuffer(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: iconv.decode(buffer.subarray(3), 'utf8'), encoding: 'utf-8-sig', lossy: false }
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return { text, encoding: 'utf-8', lossy: false }
  } catch (error) {
    // GBK 回退（与 legacy 顺序一致）；再失败则按 utf-8 替换字符解码并标记失真
    try {
      return { text: iconv.decode(buffer, 'gbk'), encoding: 'gbk', lossy: false }
    } catch (error2) {
      return { text: new TextDecoder('utf-8').decode(buffer), encoding: 'utf-8', lossy: true }
    }
  }
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 2048))
  for (const byte of sample) {
    if (byte === 0) return true
  }
  return false
}

function statOrNull(target) {
  try {
    return fs.statSync(target)
  } catch (error) {
    return null
  }
}

export async function listDir(input) {
  const target = resolveWs(input)
  const items = fs.readdirSync(target, { withFileTypes: true })
  const entries = items.map(item => {
    let size = null
    if (!item.isDirectory()) {
      const st = statOrNull(path.join(target, item.name))
      size = st ? st.size : -1
    }
    return { name: item.name + (item.isDirectory() ? '/' : ''), size }
  })
  entries.sort((a, b) => {
    const dirA = a.name.endsWith('/') ? 0 : 1
    const dirB = b.name.endsWith('/') ? 0 : 1
    return dirA - dirB || a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  })
  if (entries.length > MAX_LIST) {
    return okJson({
      path: target, entries: entries.slice(0, MAX_LIST), truncated: true,
      total: entries.length,
      hint: `目录过大仅返回前 ${MAX_LIST} 项（共 ${entries.length} 项，目录优先），请改用更精确的子路径`,
    })
  }
  return okJson({ path: target, entries })
}

export async function readFile(input, offset = 0, limit = 0, force = false) {
  const target = resolveWs(input)
  const stat = statOrNull(target)
  if (!stat) return errJson(`文件不存在: ${shortPath(target)}`)
  if (stat.isDirectory()) return errJson('目标是目录，请用 list_dir')

  const fp = `${stat.mtimeMs}:${stat.size}`
  if (!force && Number(offset) === 0 && fingerprint.get(target) === fp) {
    return okJson({
      ok: true, path: shortPath(target), unchanged: true,
      note: '文件自上次读取后未变化，此前已完整读过；仅当确实看不到原文时才带 force=true。',
    })
  }

  const raw = fs.readFileSync(target)
  if (looksBinary(raw)) return errJson('检测到二进制内容，已中止读取（图片/可执行文件请用专用工具）')

  const { text, encoding, lossy } = decodeBuffer(raw)
  const lines = text.split(/\r?\n/)
  const start = Math.max(0, Number(offset) || 0)
  const autoLimit = !(Number(limit) > 0)
  const size = autoLimit ? 800 : Math.max(50, Math.min(Number(limit), 20000))
  const slice = lines.slice(start, start + size)
  const numbered = slice.map((line, index) => `${start + index + 1}\t${line}`).join('\n')

  const payload = {
    ok: true, path: shortPath(target), content: numbered,
    encoding, lossy: lossy || undefined,
    total_lines: lines.length, offset: start, returned: slice.length,
  }
  if (start + size < lines.length) {
    const cacheId = crypto.randomUUID()
    textCache.set(cacheId, { path: target, lines, encoding })
    payload.truncated = true
    payload.cache_id = cacheId
    payload.hint = `仅返回第 ${start + 1}-${start + slice.length} 行（共 ${lines.length} 行），用 read_more 继续`
  }
  fingerprint.set(target, fp)
  return okJson(payload)
}

/** cache_tool_output 与 read_more 共用同一缓存，不再维护互不认识的内存副本。 */
export async function cacheToolOutput(content) {
  const id = crypto.randomUUID()
  textCache.set(id, { path: null, lines: String(content ?? '').split(/\r?\n/), encoding: 'utf-8', generic: true })
  if (textCache.size > 200) textCache.delete(textCache.keys().next().value)
  return id
}

export async function clearFileCaches() {
  fingerprint.clear()
  textCache.clear()
  return 'ok'
}

export async function readMore(cacheId, offset = 0, limit = 200) {
  const entry = textCache.get(String(cacheId || ''))
  if (!entry) return errJson('cache_id 不存在或已过期，请重新 read_file')
  const start = Math.max(0, Number(offset) || 0)
  const size = Math.max(1, Math.min(Number(limit) || 200, 20000))
  const slice = entry.lines.slice(start, start + size)
  return okJson({
    ok: true, path: entry.path ? shortPath(entry.path) : null,
    content: entry.generic ? slice.join('\n') : slice.map((line, index) => `${start + index + 1}\t${line}`).join('\n'),
    total_lines: entry.lines.length, offset: start, returned: slice.length,
    truncated: start + size < entry.lines.length || undefined,
  })
}

export async function writeFile(input, content) {
  const target = resolveWs(input)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, String(content ?? ''), 'utf8')
  fs.renameSync(tmp, target)
  fingerprint.delete(target)
  return okJson({ ok: true, path: shortPath(target), bytes: Buffer.byteLength(String(content ?? ''), 'utf8') })
}

export async function appendFile(input, content) {
  const target = resolveWs(input)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.appendFileSync(target, String(content ?? ''), 'utf8')
  fingerprint.delete(target)
  return okJson({ ok: true, path: shortPath(target) })
}

export async function searchReplace(input, oldText, newText, replaceAll = false) {
  const target = resolveWs(input)
  const from = String(oldText ?? '')
  if (!from) return errJson('old 不能为空')
  const raw = fs.readFileSync(target)
  const { text, encoding, lossy } = decodeBuffer(raw)
  if (lossy) return errJson('文件编码已失真（非 UTF-8/GBK），禁止按原编码回写，请先人工确认编码')

  const occurrences = text.split(from).length - 1
  if (occurrences === 0) return errJson('未找到匹配文本，未修改文件')
  if (occurrences > 1 && !replaceAll) {
    return errJson(`匹配到 ${occurrences} 处，未指定 replace_all，为避免误改已中止`)
  }

  const updated = replaceAll ? text.split(from).join(String(newText ?? ''))
    : text.replace(from, String(newText ?? ''))
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, updated, encoding === 'gbk' ? 'utf8' : 'utf8')
  fs.renameSync(tmp, target)
  fingerprint.delete(target)
  return okJson({ ok: true, path: shortPath(target), replaced: replaceAll ? occurrences : 1 })
}

export async function makeDir(input) {
  const target = resolveWs(input)
  fs.mkdirSync(target, { recursive: true })
  return okJson({ ok: true, path: shortPath(target) })
}

export async function getFileInfo(input) {
  const target = resolveWs(input)
  const stat = statOrNull(target)
  if (!stat) return okJson({ ok: true, path: shortPath(target), exists: false })
  return okJson({
    ok: true, path: shortPath(target), exists: true,
    is_dir: stat.isDirectory(), size: stat.size,
    mtime: new Date(stat.mtimeMs).toISOString(),
  })
}
