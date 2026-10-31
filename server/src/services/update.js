/**
 * 自动更新：manifest 检查、后台下载、SHA256 校验、打包版自替换。
 * 网络安全口径与 legacy 一致：仅 HTTPS、拒绝重定向、500MB/30 分钟上限。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const DEFAULT_MANIFEST_URL = 'https://github.com/harbor/harbor/releases/latest/download/update-manifest.json'
const UPDATE_DIR = process.env.HARBOR_UPDATE_DIR || path.join(os.tmpdir(), 'harbor-update')
const MAX_BYTES = 500 * 1024 * 1024
const DOWNLOAD_DEADLINE_MS = 30 * 60 * 1000
const json = value => JSON.stringify(value)

function appVersion() {
  try { return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim().replace(/^[vV]/, '') || '1.9.0' }
  catch { return '1.9.0' }
}
const APP_VERSION = appVersion()
const versionTuple = value => String(value || '').trim().replace(/^[vV]/, '').split('.').map(x => Number.parseInt(x, 10) || 0)
function newer(a, b) {
  const left = versionTuple(a); const right = versionTuple(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const d = (left[i] || 0) - (right[i] || 0)
    if (d) return d > 0
  }
  return false
}
async function fetchNoRedirect(url, options = {}) {
  return fetch(url, { ...options, redirect: 'error', headers: { 'User-Agent': `Harbor/${APP_VERSION}`, ...(options.headers || {}) } })
}

const state = { state: 'idle', pct: 0, error: null, path: null, version: null, url: null, sha256: null }

/**
 * 宿主检测（T05，P0-4 §5.3/Q4）：
 *   - Electron 宿主（A1 拓扑：server 宿主于 Electron 主进程，process.versions.electron
 *     置位）→ Electron 分支：拉起已校验 Setup /S 静默安装 → 退出（NSIS 覆盖安装
 *     原子性承接替换；sentinel/bat 单 exe 自替换思路保留为回退记录）；
 *   - pkg 单 exe（process.pkg / HARBOR_FROZEN_EXE）→ 旧分支原样（自替换 bat）；
 *   - 两者皆无 → 开发模式拒绝（语义逐字不变）。
 *   HARBOR_FROZEN_EXE 优先于 Electron 检测（显式注入的冻结 exe 语义保守沿用旧路）。
 *   HARBOR_UPDATE_ELECTRON=1 为测试 seam（mock 宿主；生产入口不设置）。
 *   HARBOR_UPDATE_EXIT_DELAY_MS 为测试 seam（退出延迟毫秒数，默认 1500）。
 */
export function isElectronUpdateHost() {
  if (process.env.HARBOR_FROZEN_EXE || process.pkg) return false
  return Boolean(process.versions.electron) || process.env.HARBOR_UPDATE_ELECTRON === '1'
}

/** Setup 拉起 seam：测试注入 mock 以捕获 (setupPath, args)，生产恒为真实 spawn。 */
let launchSetupImpl = null
export function _setLaunchSetupForTest(fn) { launchSetupImpl = fn }

function launchSilentSetup(setupPath) {
  if (launchSetupImpl) return launchSetupImpl(setupPath, ['/S'])
  const child = spawn(setupPath, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  return child
}

export async function checkUpdate(manifestUrl) {
  const url = String(manifestUrl || DEFAULT_MANIFEST_URL).trim()
  if (!url.toLowerCase().startsWith('https://')) {
    return json({ error: `更新清单地址必须使用 https（已拒绝 ${url.split('://')[0]}）` })
  }
  try {
    const response = await fetchNoRedirect(url, { signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    if (!data || typeof data !== 'object' || !data.version) return json({ error: '更新清单格式无效' })
    const latest = String(data.version)
    if (!newer(latest, APP_VERSION)) return json({ update_available: false, current: APP_VERSION })
    return json({ update_available: true, current: APP_VERSION, latest, url: data.url || '',
      sha256: String(data.sha256 || ''), notes: String(data.notes || ''), size: data.size })
  } catch (error) {
    return json({ error: `更新检查失败: ${error.message}` })
  }
}

export async function startUpdateDownload(urlInput, sha256Input, version) {
  const url = String(urlInput || '').trim()
  const sha256 = String(sha256Input || '').trim()
  const v = String(version || 'new')
  if (!url) return json({ error: '缺少下载地址' })
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(v)) return json({ error: '版本号含非法字符，已拒绝下载（仅允许字母数字 . _ -）' })
  if (!/^[a-fA-F0-9]{64}$/.test(sha256)) return json({ error: '更新清单缺少有效的 sha256 校验值，已拒绝下载' })
  if (!url.toLowerCase().startsWith('https://')) return json({ error: `下载地址必须使用 https（已拒绝 ${url.split('://')[0]}）` })
  if (state.state === 'downloading') return json({ error: '已有下载进行中' })
  Object.assign(state, { state: 'downloading', pct: 0, error: null, path: null, version, url, sha256 })
  void downloadWorker(url, sha256, v)
  return json({ ok: true })
}

async function downloadWorker(url, sha256, version) {
  const tmpPath = path.join(UPDATE_DIR, `harbor-${version}.exe.tmp`)
  const finalPath = path.join(UPDATE_DIR, `harbor-${version}.exe`)
  let handle
  try {
    await fsp.mkdir(UPDATE_DIR, { recursive: true })
    const response = await fetchNoRedirect(url, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (!response.body) throw new Error('更新响应没有内容')
    const total = Number(response.headers.get('content-length') || 0)
    if (total > MAX_BYTES) throw new Error('更新包声明大小超上限 500MB，已拒绝')
    const hash = crypto.createHash('sha256')
    const reader = response.body.getReader()
    handle = await fsp.open(tmpPath, 'w')
    let done = 0
    const deadline = Date.now() + DOWNLOAD_DEADLINE_MS
    while (true) {
      if (Date.now() > deadline) throw new Error('下载超过 30 分钟未完成，已中止')
      const { done: finished, value } = await reader.read()
      if (finished) break
      done += value.byteLength
      if (done > MAX_BYTES) throw new Error('更新包实际大小超 500MB 上限，已中止')
      hash.update(value)
      await handle.write(value)
      state.pct = total ? Math.floor(done * 100 / total) : 0
    }
    await handle.close(); handle = null
    const digest = hash.digest('hex')
    if (digest.toLowerCase() !== sha256.toLowerCase()) {
      throw new Error(`SHA256 校验失败（期望 ${sha256.slice(0, 12)}，实际 ${digest.slice(0, 12)}）`)
    }
    await fsp.rename(tmpPath, finalPath)
    Object.assign(state, { state: 'done', pct: 100, path: finalPath, error: null })
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await fsp.rm(tmpPath, { force: true }).catch(() => {})
    Object.assign(state, { state: 'error', error: error.message, path: null })
  }
}

export async function getUpdateProgress() { return json({ ...state }) }

export async function applyUpdate() {
  const oldExe = process.env.HARBOR_FROZEN_EXE || (process.pkg ? process.execPath : '')
  if (!oldExe && !isElectronUpdateHost()) return json({ error: '开发模式不支持自更新，请使用打包版' })
  if (state.state !== 'done' || !state.path) return json({ error: '尚无已完成校验的更新包' })
  if (!fs.existsSync(state.path)) return json({ error: '更新包不存在，请重新下载' })
  // sha256 复核链共用（下载时校验 + 应用前复核，篡改面同口径）
  const digest = crypto.createHash('sha256').update(await fsp.readFile(state.path)).digest('hex')
  if (digest.toLowerCase() !== String(state.sha256).toLowerCase()) {
    return json({ error: '更新包复核哈希不匹配（可能被篡改），已拒绝安装' })
  }
  if (!oldExe) {
    // —— Electron 分支（§5.3/Q4）：拉起已校验 Setup /S 静默安装 → 退出 ——
    // manifest 契约不变（url 即指向 Setup）；NSIS per-user 覆盖安装承接目录替换。
    // spawn 失败（杀软拦截/文件占用）→ 旧版继续可用（R7：失败时旧版仍可启动），
    // 取消退出定时器；成功则短延迟退出（等 HTTP 回包落定），NSIS 检测到进程
    // 已退出后接管覆盖安装。旧 sentinel/bat 自替换路径原样保留在下方 pkg 分支。
    if (/["\r\n%]/.test(state.path)) return json({ error: '更新包路径含非法字符，已拒绝应用' })
    const exitDelayMs = Number(process.env.HARBOR_UPDATE_EXIT_DELAY_MS) || 1500
    const exitTimer = setTimeout(() => process.exit(0), exitDelayMs)
    exitTimer.unref()
    try {
      const child = launchSilentSetup(state.path)
      child.on && child.on('error', error => {
        console.error('[update] Setup 拉起失败（保留旧版继续运行）:', error && error.message)
        clearTimeout(exitTimer)
      })
    } catch (error) {
      clearTimeout(exitTimer)
      console.error('[update] Setup 拉起异常（保留旧版继续运行）:', error && error.message)
    }
    return json({ ok: true, note: '已拉起已校验的安装包静默更新，应用即将退出' })
  }
  const sentinel = path.join(UPDATE_DIR, `apply_ok.${process.pid}.sentinel`)
  for (const value of [state.path, oldExe, sentinel]) {
    if (/["\r\n%]/.test(value)) return json({ error: '更新路径含批处理敏感字符，已拒绝应用' })
  }
  // 复核哈希已在本函数头部统一执行（共用校验链）；pkg 分支其余语义原样保留
  const bat = path.join(UPDATE_DIR, 'apply_update.bat')
  const script = `@echo off\r\ntimeout /t 2 /nobreak >nul\r\ncopy /y "${oldExe}" "${oldExe}.bak" >nul 2>&1\r\ncopy /y "${state.path}" "${oldExe}" >nul 2>&1\r\nif errorlevel 1 (copy /y "${oldExe}.bak" "${oldExe}" >nul 2>&1 & exit /b 1)\r\necho ok>"${sentinel}"\r\nstart "" "${oldExe}"\r\ndel "%~f0" >nul 2>&1\r\n`
  await fsp.writeFile(bat, script, 'utf8')
  const child = spawn('cmd.exe', ['/c', 'start', '', '/min', bat], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  setTimeout(() => process.exit(0), 1500).unref()
  return json({ ok: true, note: '应用即将退出并完成更新' })
}
