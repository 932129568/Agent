/**
 * P0-2 T03 DPAPI 原语层（与 Python mcp_dpapi.py 同格式同兜底）。
 *
 * 格式契约：加密值 = 'dpapi:' + base64(ciphertext)（CurrentUser 域、UI_FORBIDDEN）；
 * 不可用/异常 → 原样明文 + 日志（不锁死用户配置）；解密失败（换机/换用户）
 * → 返回内层串（面板告警语义）。
 *
 * 实现路径优先级（Q4 裁定）：
 *   1. Electron safeStorage（process.versions.electron 存在时，P0-4 注入）；
 *   2. PowerShell .NET ProtectedData.Protect/Unprotect（独立 Node 主路径——
 *      与 Python ctypes 同一底层 CryptProtectData，跨语言密文兼容）；
 *   3. 不可用 → 明文兜底 + W17 warning（与 Python 逐字一致）。
 *
 * 纪律（R5）：敏感值经 **stdin 管道**传入 PowerShell（绝不走命令行参数/
 * 环境变量——命令行进进程列表=新增泄漏面）；加解密支持批量（一次 PS 调用
 * 处理 JSON 数组，MCP env/header 多值场景避免 N 次进程启动）；isAvailable()
 * 启动探测一次并缓存。
 *
 * 模块 import 期零副作用（仅惰性函数定义；探测在首次调用时发生）。
 */
import { spawn } from 'node:child_process'
import { childLogger } from '../logger.js'

const log = childLogger('dpapi')

export const ENC_PREFIX = 'dpapi:'
export const W17_WARNING = '当前系统 DPAPI 不可用，密码以本地文件权限保护（未加密）；建议在正常 Windows 会话使用'

/** 一次 PowerShell 调用（stdin 传入 JSON 文本，stdout 回读）。 */
function runPs(script, stdinText, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`PowerShell 调用超时（${timeoutMs}ms）`))
    }, timeoutMs)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(stderr.trim() || `PowerShell exit ${code}`))
      else resolve(stdout)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(stdinText, 'utf8')
  })
}

// Protect/Unprotect 脚本：stdin = JSON 数组，逐元素处理，stdout = JSON 数组。
// [Console]::In.ReadToEnd() 读取 stdin；敏感值绝不出现在命令行。
// 序列化纪律：逐元素 ConvertTo-Json 后拼接——PS 的 ConvertTo-Json 会把单元素
// 数组展开成标量（导致 Node 侧 JSON.parse 得到字符串而非数组）。
const PS_PROTECT = `
Add-Type -AssemblyName System.Security
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$items = [Console]::In.ReadToEnd() | ConvertFrom-Json
$out = @()
foreach ($item in $items) {
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes([string]$item)
    $cipher = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
    $out += [Convert]::ToBase64String($cipher)
  } catch { $out += [string]$item }
}
[Console]::Out.Write('[' + (($out | ForEach-Object { $_ | ConvertTo-Json -Compress }) -join ',') + ']')
`
const PS_UNPROTECT = `
Add-Type -AssemblyName System.Security
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$items = [Console]::In.ReadToEnd() | ConvertFrom-Json
$out = @()
foreach ($item in $items) {
  try {
    $raw = [Convert]::FromBase64String([string]$item)
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect($raw, $null, 'CurrentUser')
    $out += [Text.Encoding]::UTF8.GetString($bytes)
  } catch { $out += [string]$item }
}
[Console]::Out.Write('[' + (($out | ForEach-Object { $_ | ConvertTo-Json -Compress }) -join ',') + ']')
`

let availabilityProbe = null

/** 当前环境 DPAPI 是否可用（Electron safeStorage 优先；否则 PS 往返探测缓存）。 */
export async function isAvailable() {
  if (availabilityProbe !== null) return availabilityProbe
  availabilityProbe = (async () => {
    if (process.versions.electron) {
      try {
        const { safeStorage } = await import('electron')
        return safeStorage.isEncryptionAvailable()
      } catch { return false }
    }
    if (process.platform !== 'win32') return false
    try {
      const out = await runPs(PS_PROTECT, JSON.stringify(['probe']))
      const encrypted = JSON.parse(out)[0]
      const back = JSON.parse(await runPs(PS_UNPROTECT, JSON.stringify([encrypted])))[0]
      return back === 'probe'
    } catch (error) {
      log.warn({ err: error }, 'DPAPI 可用性探测失败')
      return false
    }
  })()
  return availabilityProbe
}

/** Electron safeStorage 包装（P0-4 主进程注入路径）。 */
async function electronApi() {
  const { safeStorage } = await import('electron')
  return safeStorage
}

/**
 * 批量加密：string[] → 'dpapi:'+base64[]；不可用/异常 → 对应明文原样返回
 * （与 Python encrypt_value 逐条兜底语义一致）。
 */
export async function encryptValues(values) {
  const input = values.map(v => (v === null || v === undefined ? '' : String(v)))
  if (!input.length) return []
  if (input.every(v => v === '')) return input
  if (await isAvailable()) {
    try {
      if (process.versions.electron) {
        const safeStorage = await electronApi()
        return input.map(v => (v === '' ? v : ENC_PREFIX + safeStorage.encryptString(v).toString('base64')))
      }
      const out = JSON.parse(await runPs(PS_PROTECT, JSON.stringify(input)))
      return input.map((v, i) => {
        const enc = String(out[i] ?? '')
        // PS 侧逐元素 try/catch 失败回原文——只有真正拿到密文才加前缀
        return enc && enc !== v ? ENC_PREFIX + enc : v
      })
    } catch (error) {
      log.warn({ err: error }, 'DPAPI 加密失败，按明文存储')
      return input
    }
  }
  return input
}

/**
 * 批量解密：'dpapi:...'[] → 明文[]；非标记原样返回；不可用/失败 → 返回内层串
 * （Python decrypt_value 兜底语义——面板据此前缀判定 decrypt_failed）。
 */
export async function decryptValues(markers) {
  const input = markers.map(v => String(v ?? ''))
  if (!input.length) return []
  const pending = input.map(v => (v.startsWith(ENC_PREFIX) ? v.slice(ENC_PREFIX.length) : null))
  if (pending.every(v => v === null)) return input
  if (await isAvailable()) {
    try {
      let plain
      if (process.versions.electron) {
        const safeStorage = await electronApi()
        plain = pending.map(b64 => (b64 === null ? null : safeStorage.decryptString(Buffer.from(b64, 'base64')).toString('utf8')))
      } else {
        const payload = pending.map(v => (v === null ? '' : v))
        const out = JSON.parse(await runPs(PS_UNPROTECT, JSON.stringify(payload)))
        plain = out.map(v => String(v ?? ''))
      }
      return input.map((original, i) => {
        if (pending[i] === null) return original
        const value = plain[i]
        // 解密失败（换机/换用户）→ 返回内层标记串（Python 同款兜底）
        return value === pending[i] ? original : value
      })
    } catch (error) {
      log.warn({ err: error }, 'DPAPI 解密失败，按明文兜底')
      return input
    }
  }
  return input
}

/** 单值便捷封装（webdav password 等）。 */
export async function encryptValue(plain) {
  if (plain === null || plain === undefined || plain === '') return plain
  return (await encryptValues([String(plain)]))[0]
}

export async function decryptValue(marker) {
  if (typeof marker !== 'string' || !marker.startsWith(ENC_PREFIX)) return marker
  return (await decryptValues([marker]))[0]
}

/**
 * env/headers 字段级加密（Python _encrypt_field:45-79 同构）：
 * - 已是 {__enc__} 标记对象或 'dpapi:' 前缀串：先试解密验证——可解则原样透传
 *   （不重复加密），不可解按内层串重新加密；
 * - 否则加密；加密产出带前缀 → 落盘为 {__enc__: enc}，否则明文串原样落盘；
 * - plain_keys = 因不可用/失败而以明文落盘的非空值键（W21 面板提示）。
 */
export async function encryptField(mapping) {
  const out = {}
  const plainKeys = []
  for (const [key, raw] of Object.entries(mapping || {})) {
    let value = raw
    if (value && typeof value === 'object' && typeof value.__enc__ === 'string') {
      const dec = await decryptValue(value.__enc__)
      if (dec && !dec.startsWith(ENC_PREFIX)) { out[key] = { __enc__: value.__enc__ }; continue }
      value = value.__enc__   // 解密验证失败：按内层串重新加密（不丢原值语义）
    }
    value = String(value ?? '')
    if (value.startsWith(ENC_PREFIX)) {
      // 合法明文值可能恰好以 'dpapi:' 开头——试解密验证，真能解出才是密文标记
      const dec = await decryptValue(value)
      if (dec && !dec.startsWith(ENC_PREFIX)) { out[key] = { __enc__: value }; continue }
    }
    const enc = await encryptValue(value)
    out[key] = enc.startsWith(ENC_PREFIX) ? { __enc__: enc } : enc
    if (!enc.startsWith(ENC_PREFIX) && value) plainKeys.push(String(key))
  }
  return { values: out, plainKeys }
}

/**
 * 解密整个映射（Python decrypt_mapping 同构）：
 * 返回 {values, failed}——失败键在视图中保持内层标记串（W21 编辑器回显契约），
 * failed 列表供面板提示「密钥解密失败，请重新填写」。
 */
export async function decryptMapping(mapping) {
  const values = {}
  const failed = []
  for (const [key, raw] of Object.entries(mapping || {})) {
    let marker = null
    if (raw && typeof raw === 'object' && typeof raw.__enc__ === 'string') marker = raw.__enc__
    else if (typeof raw === 'string' && raw.startsWith(ENC_PREFIX)) marker = raw
    if (marker === null) { values[key] = raw === null || raw === undefined ? '' : String(raw); continue }
    const plain = await decryptValue(marker)
    if (plain.startsWith(ENC_PREFIX)) failed.push(String(key))
    values[key] = plain
  }
  return { values, failed }
}
