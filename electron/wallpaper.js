/**
 * R80 / W2：桌面壁纸镜像（Windows 主进程侧取数）。
 *
 * 为什么需要镜像：实测（见 deliverables/design/liquid-glass/r80 探针记录）系统
 * Mica 在 Web 侧采不到像素、透明窗口下 backdrop-filter 采不到任何内容——只有
 * 「页面内自绘壁纸 + CSS backdrop-filter 采样」能被真实折射。所以镜像必须由本
 * 进程把桌面壁纸读成 data URI 交给渲染进程。
 *
 * 取数顺序（契约 §6）：
 *   ① 注册表 HKCU\Control Panel\Desktop → WallPaper / WallpaperStyle / TileWallpaper
 *   ② 优先用 %APPDATA%\Microsoft\Windows\Themes\TranscodedWallpaper——它是系统
 *      转码后的真实壁纸副本（实测 2,284,788 字节 / 3840×2160 / JPEG，无扩展名，
 *      因此 MIME 必须按magic 嗅探而不是按后缀）
 *   ③ 注册表 WallPaper 指向的原图作次选（TranscodedWallpaper 缺失时）
 *
 * 红线：只用 node 内置模块，不引第三方包；任何失败一律返回 null 且**不抛异常**
 * （读不到壁纸必须静默降级，绝不阻塞启动）。
 *
 * 另导出纯函数 wallpaperOffset()：把窗口屏幕坐标换算成镜像层的反向偏移，
 * 抽出来是为了能在 electron/test-wallpaper.cjs 里直接断言（main.js 依赖 electron
 * 运行时，无法被单测 require）。
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')

/** 注册表项（三值同在 HKCU\Control Panel\Desktop 下，一次 query 全取） */
const REG_PATH = 'HKCU\\Control Panel\\Desktop'
const REG_NAMES = ['WallPaper', 'WallpaperStyle', 'TileWallpaper']
const REG_TIMEOUT_MS = 1500
const PS_TIMEOUT_MS = 4000

/** 壁纸文件大小上下界：小于 1KB 视为占位/损坏，大于 32MB 放弃（内存保护） */
const MIN_BYTES = 1024
const MAX_BYTES = 32 * 1024 * 1024

/** WallpaperStyle 缺省 10（填充），TileWallpaper 缺省 0（不平铺） */
const DEFAULT_STYLE = '10'
const DEFAULT_TILE = '0'

/**
 * 跑一个外部命令，永不 reject：失败/超时/被策略拦截一律给 null。
 * @param {string} file
 * @param {string[]} args
 * @param {number} timeout
 * @returns {Promise<string|null>}
 */
function run(file, args, timeout) {
  return new Promise(resolve => {
    try {
      execFile(file, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 },
        (error, stdout) => resolve(error ? null : String(stdout || '')))
    } catch (error) {
      resolve(null)
    }
  })
}

/**
 * 从 `reg query <key>` 的整键输出里取某个值。
 * 行格式：`    WallPaper    REG_SZ    C:\path\to\wall.jpg`
 * @param {string} text
 * @param {string} name
 * @returns {string}
 */
function parseRegValue(text, name) {
  if (!text) return ''
  const want = name.toLowerCase()
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s+(\S+)\s+REG_\w+\s+(.*)$/)
    if (m && m[1].toLowerCase() === want) return m[2].trim()
  }
  return ''
}

/**
 * 兜底：reg.exe 被组策略/安全软件禁用时用 PowerShell 一次取三值。
 * 只在主路径拿不到 WallPaper 时才跑（PowerShell 冷启动约数百毫秒，不常用）。
 * @returns {Promise<Record<string,string>>}
 */
async function queryViaPowerShell() {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$p=Get-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop'",
    "Write-Output ('WallPaper=' + $p.WallPaper)",
    "Write-Output ('WallpaperStyle=' + $p.WallpaperStyle)",
    "Write-Output ('TileWallpaper=' + $p.TileWallpaper)",
  ].join('; ')
  const out = await run('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    PS_TIMEOUT_MS)
  const values = {}
  if (!out) return values
  for (const line of out.split(/\r?\n/)) {
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const val = line.slice(idx + 1).trim()
    if (REG_NAMES.includes(key) && val) values[key] = val
  }
  return values
}

/**
 * 读壁纸三值。任何环境异常都退化为空对象（调用方用缺省值兜底）。
 * @returns {Promise<Record<string,string>>}
 */
async function queryRegistry() {
  const values = {}
  const text = await run('reg.exe', ['query', REG_PATH], REG_TIMEOUT_MS)
  if (text) {
    for (const name of REG_NAMES) {
      const val = parseRegValue(text, name)
      if (val) values[name] = val
    }
  }
  if (!values.WallPaper) {
    const fallback = await queryViaPowerShell()
    for (const name of REG_NAMES) {
      if (!values[name] && fallback[name]) values[name] = fallback[name]
    }
  }
  return values
}

/** 展开 %USERPROFILE% 这类环境变量（注册表里可能存变量形态的路径） */
function expandEnv(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  return raw.replace(/%([^%]+)%/g, (whole, name) => {
    const hit = process.env[name]
    return hit === undefined ? whole : hit
  })
}

/** 系统转码壁纸副本路径（无扩展名，实为 JPEG） */
function transcodedPath() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(base, 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper')
}

/**
 * 按 magic 嗅探图片类型——TranscodedWallpaper 没有扩展名，靠后缀会全错。
 * @param {Buffer} buf
 * @param {string} filePath
 * @returns {string}
 */
function sniffMime(buf, filePath) {
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg'
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4D) return 'image/bmp'
  if (buf.length >= 12 && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  const ext = path.extname(String(filePath || '')).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.bmp') return 'image/bmp'
  if (ext === '.webp') return 'image/webp'
  return 'image/jpeg'
}

/**
 * JPEG 尺寸：扫到 SOF0/1/2/… 段读高宽（不解码像素）。
 * @param {Buffer} buf
 * @returns {{width:number,height:number}|null}
 */
function jpegSize(buf) {
  let off = 2
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xFF) { off += 1; continue }
    const marker = buf[off + 1]
    if (marker === 0xFF) { off += 1; continue }
    // 无长度域的独立标记
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) { off += 2; continue }
    const len = buf.readUInt16BE(off + 2)
    if (len < 2) return null
    const isSOF = marker >= 0xC0 && marker <= 0xCF &&
                  marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC
    if (isSOF) {
      const height = buf.readUInt16BE(off + 5)
      const width = buf.readUInt16BE(off + 7)
      if (width > 0 && height > 0) return { width, height }
      return null
    }
    if (marker === 0xDA) return null // 扫描数据开始，SOF 已经过去了
    off += 2 + len
  }
  return null
}

/**
 * 从文件头取像素宽高（PNG / JPEG / GIF / BMP / WebP）。取不到给 null，不算失败。
 * @param {Buffer} buf
 * @returns {{width:number|null,height:number|null}}
 */
function readSize(buf) {
  try {
    // PNG：IHDR 紧跟 8 字节签名 + 4 字节长度 + 4 字节类型 → 宽在 16，高在 20
    if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    if (buf.length >= 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
      const size = jpegSize(buf)
      return size ? { width: size.width, height: size.height } : { width: null, height: null }
    }
    if (buf.length >= 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
    }
    if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4D) {
      return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) }
    }
    if (buf.length >= 30 && buf.slice(8, 12).toString('latin1') === 'WEBP') {
      const fmt = buf.slice(12, 16).toString('latin1')
      if (fmt === 'VP8X') {
        return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
      }
      if (fmt === 'VP8 ') {
        return { width: buf.readUInt16LE(26) & 0x3FFF, height: buf.readUInt16LE(28) & 0x3FFF }
      }
      if (fmt === 'VP8L') {
        const bits = buf.readUInt32LE(21)
        return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 }
      }
    }
  } catch (error) { /* 头部异常：宽高留空即可 */ }
  return { width: null, height: null }
}

/**
 * 读一个候选文件；不存在 / 过小 / 过大 / 读失败都给 null。
 * @param {string} filePath
 * @returns {Promise<{buf:Buffer,bytes:number}|null>}
 */
async function tryReadFile(filePath) {
  const target = String(filePath || '').trim()
  if (!target) return null
  try {
    const stat = await fs.promises.stat(target)
    if (!stat.isFile() || stat.size < MIN_BYTES || stat.size > MAX_BYTES) return null
    const buf = await fs.promises.readFile(target)
    if (buf.length < MIN_BYTES) return null
    return { buf, bytes: buf.length }
  } catch (error) {
    return null
  }
}

/**
 * 读桌面壁纸 → base64 data URI。
 *
 * @param {{candidates?: string[], skipRegistry?: boolean}} [options]
 *   candidates 显式指定候选文件（自测模拟「路径不存在」用）；不给则走
 *   TranscodedWallpaper → 注册表 WallPaper 的自动顺序。
 * @returns {Promise<null|{dataUri:string,width:number|null,height:number|null,
 *   style:string,tile:string,source:string,bytes:number}>}
 *   任何失败返回 null，**不抛异常**。
 */
async function readWallpaper(options) {
  const opts = options || {}
  try {
    const reg = opts.skipRegistry ? {} : await queryRegistry()
    const style = String(reg.WallpaperStyle || DEFAULT_STYLE).trim() || DEFAULT_STYLE
    const tile = String(reg.TileWallpaper || DEFAULT_TILE).trim() || DEFAULT_TILE

    /** @type {Array<{file:string, source:string}>} */
    let candidates
    if (Array.isArray(opts.candidates)) {
      candidates = opts.candidates.map(file => ({ file: expandEnv(file), source: 'explicit' }))
    } else {
      candidates = [{ file: transcodedPath(), source: 'transcoded' }]
      const declared = expandEnv(reg.WallPaper)
      if (declared) candidates.push({ file: declared, source: 'registry' })
    }

    for (const { file, source } of candidates) {
      const hit = await tryReadFile(file)
      if (!hit) continue
      const mime = sniffMime(hit.buf, file)
      const { width, height } = readSize(hit.buf)
      const dataUri = `data:${mime};base64,${hit.buf.toString('base64')}`
      return { dataUri, width, height, style, tile, source, bytes: hit.bytes }
    }
    return null
  } catch (error) {
    // 兜底：契约要求读不到就静默降级
    return null
  }
}

/* ================= 传输编码：压到能放进 CSS 自定义属性的体积 =================
 * 实测（Electron 45.2.1 / Chromium 142，二分法）：CSS 自定义属性的值上限是
 * **2,097,152 字符（2^21）**——2,097,152 可写可读，2,097,153 起 setProperty
 * 静默失败、getPropertyValue 回空串，且不报任何错。而 3840×2160 壁纸的
 * data URI 是 3,046,407 字符，直接塞 --wp-url 会被无声吞掉（镜像永远不出现，
 * 这是最难查的一类坏法）。
 *
 * 所以先在主进程用 nativeImage 降采样重编码成 JPEG，再交给渲染进程。镜像层
 * 永远在 backdrop-filter 之后，1920 宽绰绰有余。留 30% 余量取 1,500,000。
 * 压不下去返回 null → 上层整体退回纯玻璃（宁可没有镜像，也不要写坏值）。 */
const WP_MAX_URI_CHARS = 1500000
const WP_TARGET_WIDTHS = [1920, 1440, 1080, 800]
const WP_JPEG_QUALITY = 82

/**
 * 把过大的 data URI 压到安全体积。
 * 纯 Node 环境下 require('electron') 会失败 → 原样返回（不至于抛错）。
 * @param {null|{dataUri:string,width:number,height:number}} wp
 * @returns {null|object}
 */
function encodeMirrorImage(wp) {
  if (!wp || !wp.dataUri) return wp
  if (wp.dataUri.length <= WP_MAX_URI_CHARS) return wp
  try {
    const { nativeImage } = require('electron')
    const img = nativeImage.createFromDataURL(wp.dataUri)
    if (!img || img.isEmpty()) return wp
    const { width, height } = img.getSize()
    if (!width || !height) return wp
    for (const target of WP_TARGET_WIDTHS) {
      if (target >= width) continue
      const targetHeight = Math.max(1, Math.round((height * target) / width))
      const resized = img.resize({ width: target, height: targetHeight, quality: 'good' })
      if (!resized || resized.isEmpty()) continue
      const jpeg = resized.toJPEG(WP_JPEG_QUALITY)
      if (!jpeg || !jpeg.length) continue
      const dataUri = 'data:image/jpeg;base64,' + jpeg.toString('base64')
      if (dataUri.length > WP_MAX_URI_CHARS) continue
      // width/height 保留源像素尺寸（报告与 --wp-size 口径），另附编码后尺寸
      return Object.assign({}, wp, {
        dataUri,
        encodedWidth: target,
        encodedHeight: targetHeight,
        encodedBytes: jpeg.length,
      })
    }
  } catch (error) {
    return wp   // 非 Electron 环境 / 解码失败：原样返回，由调用方决定怎么降级
  }
  return null
}

/**
 * 镜像层反向偏移（契约 §6.5）。
 *
 * 镜像固定在视口上，窗口往右下走多少，镜像就得往左上平移同样多，屏外内容才会
 * 看起来「钉在桌面上不动」。bounds 是 DIP，乘 scaleFactor 换物理像素；取负号
 * 即反向。渲染侧再除以 devicePixelRatio 还原成 CSS px（见 preload.js）。
 *
 * @param {{x:number,y:number}} bounds 窗口屏幕坐标（DIP）
 * @param {number} scaleFactor 当前显示器缩放比
 * @returns {{x:number,y:number}} 物理像素偏移（负值）
 */
function wallpaperOffset(bounds, scaleFactor) {
  const b = bounds || {}
  const s = Number(scaleFactor)
  const safeScale = Number.isFinite(s) && s > 0 ? s : 1
  const bx = Number(b.x)
  const by = Number(b.y)
  return {
    x: Math.round(-(Number.isFinite(bx) ? bx : 0) * safeScale),
    y: Math.round(-(Number.isFinite(by) ? by : 0) * safeScale),
  }
}

module.exports = { readWallpaper, encodeMirrorImage, wallpaperOffset }
