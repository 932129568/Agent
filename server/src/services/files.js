/**
 * 文件工具（P0-1c T02 F1-F6：与 legacy file_service.py/toolcache_service.py 全语义同构）。
 *
 * read_file（F1，file_service.py:151-241 逐条）：keepends 行集（无尾行幻影）、
 * 缺文件 difflib 猜错提示（绝对路径入错误文本）、目录/64MB/二进制短路、
 * auto_limit 自适应（≤2000 行一次读全 / >2000 分页 1200）、240000 字符预算、
 * 「整文件 served」才 mark_read、offset 越界 note、hint 续读指引。
 *
 * 写族（F3-F4）：write_file 既有 >20KB 拒绝；append 限流（10 分钟 6 次）+
 * bytes 回显；search_replace 按原编码写回 + 文本模式换行翻译
 * （atomic_write_text_mode：\n→os.linesep——legacy 钉死契约，快照经 H1 归一）。
 * 路径口径（F4/F5）：make_dir/get_file_info/binary/缺文件错误回**绝对路径**；
 * read/write/append/replace 成功响应的 path 回**短路径**。
 */
import fs from 'node:fs'
import path from 'node:path'
import iconv from 'iconv-lite'
import { resolveWs, shortPath } from './jail.js'
import { withRootLock, ctxRoot } from '../session-context.js'

const MAX_LIST = 200
const READ_BUDGET = 240000
const READ_AUTO_DEFAULT = 800
const FILE_SIZE_CAP = 64 * 1024 * 1024
const IS_WIN = process.platform === 'win32'

const okJson = value => JSON.stringify(value)
const errJson = message => JSON.stringify({ error: String(message) })

/* ---------------- 指纹缓存（mark_read=整文件 served；写操作失效化） ---------------- */
const fingerprint = new Map()   // abs path -> 'mtimeMs:size'
function markRead(target) {
  const stat = fs.statSync(target)
  fingerprint.set(target, `${stat.mtimeMs}:${stat.size}`)
}
function invalidate(target) { fingerprint.delete(target) }
function unchangedSinceRead(target) {
  const fp = fingerprint.get(target)
  if (!fp) return false
  try {
    const stat = fs.statSync(target)
    return `${stat.mtimeMs}:${stat.size}` === fp
  } catch { return false }
}

/* ---------------- 编码探测（file_service._decode_bytes_ex 同构） ---------------- */
function decodeBufferEx(raw) {
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    return { text: iconv.decode(raw.subarray(3), 'utf8'), encoding: 'utf-8-sig', lossy: false }
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    return { text, encoding: 'utf-8', lossy: false }
  } catch { /* 回落 GBK */ }
  const gbkText = iconv.decode(raw, 'gbk')
  if (!gbkText.includes('\uFFFD')) return { text: gbkText, encoding: 'gbk', lossy: false }
  return { text: new TextDecoder('utf-8').decode(raw), encoding: 'utf-8', lossy: true }
}

/** keepends 行集（Python str.splitlines(keepends=True) 的 \r\n|\r|\n 子集语义）。 */
function splitKeepends(text) {
  if (!text) return []
  return text.match(/.*(?:\r\n|\r|\n)|.+$/g) || []
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192))
  return sample.includes(0)
}

function statOrNull(target) {
  try { return fs.statSync(target) } catch { return null }
}

/** Python difflib.SequenceMatcher.ratio 的 LCS 近似（get_close_matches cutoff 0.6）。 */
function similarity(a, b) {
  if (!a.length && !b.length) return 1
  if (!a.length || !b.length) return 0
  const rows = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      rows[i][j] = a[i - 1] === b[j - 1]
        ? rows[i - 1][j - 1] + 1
        : Math.max(rows[i - 1][j], rows[i][j - 1])
    }
  }
  return (2 * rows[a.length][b.length]) / (a.length + b.length)
}

/** 缺文件猜错提示（file_service.py:175-190：≤2 层深度、隐藏目录跳过、cutoff 0.6）。 */
function guessClosestFile(root, missingBase) {
  const candidates = []
  const walk = (dir, depth) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (depth + 1 < 2) walk(path.join(dir, entry.name), depth + 1)
      } else candidates.push(entry.name)
      if (candidates.length > 2000) return
    }
  }
  walk(root, 0)
  if (candidates.length > 2000) return ''
  let best = ''
  let bestRatio = 0.6
  for (const name of candidates) {
    const ratio = similarity(missingBase, name.toLowerCase())
    if (ratio > bestRatio) { bestRatio = ratio; best = name }
  }
  return best
}

/* ---------------- 读族 ---------------- */

export async function listDir(input) {
  const target = resolveWs(input)
  const entries = []
  for (const item of fs.readdirSync(target, { withFileTypes: true })) {
    let isDir = false
    try { isDir = item.isDirectory() } catch { /* OSError → False 口径 */ }
    let size = -1
    if (!isDir) {
      try { size = fs.statSync(path.join(target, item.name)).size } catch { size = -1 }
    }
    entries.push({ name: item.name + (isDir ? '/' : ''), size: isDir ? null : size })
  }
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
  try {
    let off = Number.parseInt(String(offset ?? 0), 10)
    if (!Number.isFinite(off) || off < 0) off = 0
    let li = limit === null || limit === undefined ? READ_AUTO_DEFAULT : Number.parseInt(String(limit), 10)
    if (!Number.isFinite(li)) li = READ_AUTO_DEFAULT
    const autoLimit = li <= 0
    let pageSize = autoLimit ? READ_AUTO_DEFAULT : Math.max(50, Math.min(li, 20000))

    // 指纹短路（offset==0 且未变化且非 force）
    if (!force && off === 0 && unchangedSinceRead(target)) {
      return okJson({
        ok: true, path: shortPath(target), unchanged: true,
        note: '文件自上次读取后未变化，此前已完整读过，原文应仍在上文中；仅当上文中确实看不到原文时才带 force=true。',
      })
    }
    if (!fs.existsSync(target)) {
      const base = path.basename(target).toLowerCase()
      const root = path.dirname(target)
      const closest = guessClosestFile(root, base)
      const hint = closest ? `（最接近的文件: ${closest}，可用相对路径直接读取）` : ''
      return errJson(`文件不存在: ${target}${hint}`)
    }
    if (fs.statSync(target).isDirectory()) {
      return errJson(`路径是目录不是文件: ${target}，列目录请用 list_dir`)
    }
    if (fs.statSync(target).size > FILE_SIZE_CAP) {
      return errJson('文件超过 64MB，不支持整读；请用 run_powershell 分段处理，或先拆分文件。')
    }
    const raw = fs.readFileSync(target)
    if (looksBinary(raw)) {
      // 信息性载荷（非错误）：ok(payload) 纯序列化不含 ok 键——file_service.py:211-213 原样
      return okJson({ path: target, binary: true, info: '二进制文件，read_file 不适用；如需分析请用 run_powershell' })
    }
    const { text } = decodeBufferEx(raw)
    const lines = splitKeepends(text)
    const total = lines.length
    if (autoLimit) pageSize = total > 2000 ? 1200 : 2000
    if (off >= total) {
      return okJson({ ok: true, path: shortPath(target), total_lines: total,
        note: `offset=${off} 已超出文件末尾（共 ${total} 行）` })
    }
    const seg = lines.slice(off, off + pageSize)
    const parts = []
    let used = 0
    let shown = 0
    for (let i = 0; i < seg.length; i += 1) {
      const part = `${off + i + 1}\t${seg[i]}`
      if (used + part.length > READ_BUDGET) break
      parts.push(part)
      used += part.length
      shown += 1
    }
    let numbered = parts.join('')
    if (shown < seg.length) numbered += '\n…(超大文件截断，可传 offset 继续读)'
    const info = { ok: true, path: shortPath(target), total_lines: total, content: numbered }
    const nextOff = off + shown
    if (nextOff < total) info.hint = `还有 ${total - nextOff} 行未读，可传 offset=${nextOff} 继续读`
    // 仅「整文件 served」才 mark_read（六轮 r5 建议12：BUDGET 截断时不得误记）
    if (nextOff >= total && shown >= seg.length) markRead(target)
    return okJson(info)
  } catch (error) {
    return errJson(error.message || String(error))
  }
}

/* ---------------- 工具输出缓存（toolcache_service 同构：tc<seq>_<epoch秒>） ---------------- */
let toolcacheSeq = 0
const nextToolcacheId = () => `tc${(toolcacheSeq += 1)}_${Math.floor(Date.now() / 1000)}`
const toolcache = new Map()   // id -> { content, lines }

export async function cacheToolOutput(content) {
  const id = nextToolcacheId()
  const text = String(content ?? '')
  toolcache.set(id, { content: text, lines: text.split('\n') })
  if (toolcache.size > 200) toolcache.delete(toolcache.keys().next().value)
  return id
}

export async function clearFileCaches() {
  fingerprint.clear()
  toolcache.clear()
  return 'ok'
}

/** read_more（toolcache_service.py:78-106 同构）。 */
export async function readMore(cacheId, offset = 0, limit = 400) {
  const entry = toolcache.get(String(cacheId || ''))
  if (!entry) return okJson({ error: '缓存不存在或已清理，请重新执行原命令获取' })
  const lines = entry.lines
  const off = Math.max(0, Number.parseInt(String(offset ?? 0), 10) || 0)
  const lim = Math.max(20, Math.min(Number.parseInt(String(limit ?? 400), 10) || 400, 2000))
  const part = lines.slice(off, off + lim)
  if (!part.length) return okJson({ error: `offset 超出范围，共 ${lines.length} 行` })
  let body = part.join('\n')
  if (off + lim < lines.length) {
    body += `\n…[第 ${off + 1}-${off + part.length} 行 / 共 ${lines.length} 行；续读 read_more(cache_id="${cacheId}", offset=${off + part.length})]`
  }
  return okJson({ ok: true, total_lines: lines.length, content: body })
}

/* ---------------- 写族 ---------------- */

export async function writeFile(input, content) {
  // P0-3 T02：per-root 写互斥（同 root 写操作串行不撕裂）
  return withRootLock(ctxRoot(), async () => {
    const target = resolveWs(input)
  try {
    if (fs.existsSync(target) && fs.statSync(target).size > 20000) {
      return errJson('目标文件已存在且 >20KB。请改用 search_replace 局部修改；确需整体重写，先 delete_path 删掉它再 write_file。')
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    // atomic_write_text：newline=''（无换行翻译）逐字节
    const tmp = `${target}.${process.pid}.tmp`
    fs.writeFileSync(tmp, String(content ?? ''), 'utf8')
    fs.renameSync(tmp, target)
    invalidate(target)
    return okJson({ ok: true, path: shortPath(target), bytes: Buffer.byteLength(String(content ?? ''), 'utf8') })
  } catch (error) { return errJson(error.message || String(error)) }
  })
}

const appendHistory = new Map()   // abs path -> timestamps[]（10 分钟窗口 6 次限流）
export async function appendFile(input, content) {
  return withRootLock(ctxRoot(), async () => {
    const target = resolveWs(input)
  try {
    const now = Date.now()
    const hist = (appendHistory.get(target) || []).filter(t => now - t < 600000)
    hist.push(now)
    appendHistory.set(target, hist)
    if (appendHistory.size > 512) {
      const excess = [...appendHistory.keys()].slice(0, appendHistory.size - 512)
      for (const key of excess) appendHistory.delete(key)
    }
    if (hist.length > 6) {
      return errJson('append_file 已达频次上限（10 分钟 6 次），本次未写入，计数已重置。请改用 write_file 一次性重写，或稍后再追加。')
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.appendFileSync(target, String(content ?? ''), 'utf8')
    invalidate(target)
    return okJson({ ok: true, path: shortPath(target), bytes: Buffer.byteLength(String(content ?? ''), 'utf8') })
  } catch (error) { return errJson(error.message || String(error)) }
  })
}

/** 原编码写回载荷（file_service.py:340-345 同构：GBK/utf-8-sig/utf-8）。 */
function encodeForWrite(text, encoding) {
  if (encoding === 'gbk') return iconv.encode(text, 'gbk')
  if (encoding === 'utf-8-sig') {
    return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
  }
  return Buffer.from(text, 'utf8')
}

export async function searchReplace(input, oldText, newText, replaceAll = false) {
  return withRootLock(ctxRoot(), async () => {
    const target = resolveWs(input)
  try {
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      return errJson(`路径是目录: ${target}`)
    }
    if (!fs.existsSync(target)) {
      return errJson(`文件不存在: ${target}，新建内容请用 write_file`)
    }
    if (fs.statSync(target).size > FILE_SIZE_CAP) {
      return errJson('文件超过 64MB，不支持 search_replace 整读改写；请用 run_powershell 分段处理。')
    }
    const raw = fs.readFileSync(target)
    if (looksBinary(raw)) return errJson('二进制文件不支持 search_replace，请勿尝试修改')
    const { text, encoding, lossy } = decodeBufferEx(raw)
    if (lossy) {
      return errJson('文件编码无法无损识别（既非 UTF-8 也非 GBK），为避免损坏已拒绝写入；请先人工转换为 UTF-8。')
    }
    const from = String(oldText ?? '')
    if (!text.includes(from)) {
      const probe = (from.trim().split(/\r?\n/)[0] || '').slice(0, 80)
      let bestNo = -1
      let bestRatio = 0
      let bestLine = ''
      text.split(/\r?\n/).forEach((line, i) => {
        const ratio = similarity(probe, line.trim().slice(0, 80))
        if (ratio > bestRatio) { bestRatio = ratio; bestNo = i; bestLine = line }
      })
      const hint = bestRatio > 0.6 ? `；最相似内容在第 ${bestNo + 1} 行: ${bestLine.trim().slice(0, 80)}` : ''
      return errJson(`未找到匹配内容: old 必须与文件原文逐字符一致${hint}`)
    }
    const count = text.split(from).length - 1
    if (count > 1 && !replaceAll) {
      return errJson(`匹配到 ${count} 处，请提供更长上下文或传 replace_all=true`)
    }
    const updated = replaceAll ? text.split(from).join(String(newText ?? '')) : text.replace(from, String(newText ?? ''))
    let payload
    try { payload = encodeForWrite(updated, encoding) }
    catch (error) {
      return errJson(`新内容含原编码（${encoding}）无法表示的字符（${error.message || error}），已拒绝写入；请改用 UTF-8 字符集或先转换文件编码。`)
    }
    // atomic_write_text_mode：文本模式换行翻译（\n → os.linesep；legacy 钉死契约，
    // 快照经 H1 归一消平台分叉）。Python newline=None 只翻译 \n 字符——\r 原样保留。
    let written = payload
    if (IS_WIN) {
      const textPayload = payload.toString('utf8')
      written = Buffer.from(textPayload.replace(/\n/g, '\r\n'), 'utf8')
    }
    const tmp = `${target}.${process.pid}.tmp`
    fs.writeFileSync(tmp, written)
    fs.renameSync(tmp, target)
    invalidate(target)
    return okJson({ ok: true, path: shortPath(target), replaced: replaceAll ? count : 1 })
  } catch (error) { return errJson(error.message || String(error)) }
  })
}

export async function makeDir(input) {
  return withRootLock(ctxRoot(), async () => {
    const target = resolveWs(input)
  try {
    fs.mkdirSync(target, { recursive: true })
    return okJson({ ok: true, path: target })
  } catch (error) { return errJson(error.message || String(error)) }
  })
}

/** '%Y-%m-%d %H:%M:%S' 本地时间（get_file_info 契约格式）。 */
function localTimestamp(ms) {
  const d = new Date(ms)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export async function getFileInfo(input) {
  const target = resolveWs(input)
  const stat = statOrNull(target)
  if (!stat) return errJson(`[Errno 2] No such file or directory: '${target}'`)
  return okJson({
    path: target, is_dir: stat.isDirectory(), size: stat.size,
    mtime: localTimestamp(stat.mtimeMs),
  })
}

export async function movePath(src, dst) {
  return withRootLock(ctxRoot(), async () => {
    const from = resolveWs(src)
  const to = resolveWs(dst)
  try {
    if (!fs.existsSync(from)) return errJson(`源不存在: ${from}`)
    if (fs.existsSync(to)) return errJson(`目标已存在: ${to}`)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(from, to)
    invalidate(from)
    invalidate(to)
    return okJson({ ok: true, src: from, dst: to })
  } catch (error) { return errJson(error.message || String(error)) }
  })
}

export async function copyPath(src, dst) {
  return withRootLock(ctxRoot(), async () => {
    const from = resolveWs(src)
  const to = resolveWs(dst)
  try {
    if (!fs.existsSync(from)) return errJson(`源不存在: ${from}`)
    if (fs.existsSync(to)) return errJson(`目标已存在: ${to}`)
    if (fs.statSync(from).isDirectory()) fs.cpSync(from, to, { recursive: true })
    else {
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(from, to)
    }
    return okJson({ ok: true, src: from, dst: to })
  } catch (error) { return errJson(error.message || String(error)) }
  })
}
