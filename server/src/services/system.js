/**
 * OS 原生能力：进程、应用/链接打开、剪贴板、目录对话框、截图。
 * Windows 走 tasklist / PowerShell，全部 execFile + 参数数组，不做 shell 拼接。
 */
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { enforceExec } from './guard.js'

const run = promisify(execFile)
const okJson = value => JSON.stringify(value)
const errJson = message => JSON.stringify({ error: String(message) })
const IS_WIN = process.platform === 'win32'
const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']
const exportPaths = new Set()
const pathKey = value => path.normalize(path.resolve(String(value || ''))).toLowerCase()

export async function getPlatformInfo() {
  return okJson({ ok: true, platform: process.platform, arch: process.arch,
    node: process.version, os_release: os.release(), os_type: os.type(),
    cpus: os.cpus().length, total_memory: os.totalmem(), homedir: os.homedir() })
}

export async function listProcesses(keyword = null) {
  const filter = String(keyword || '').toLowerCase()
  if (IS_WIN) {
    const { stdout } = await run('tasklist', ['/FO', 'CSV', '/NH'], { maxBuffer: 32 * 1024 * 1024 })
    const rows = []
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue
      const cols = line.split('","').map(col => col.replace(/^"|"$/g, ''))
      if (cols.length < 2) continue
      const [name, pid] = cols
      if (filter && !`${name} ${pid}`.toLowerCase().includes(filter)) continue
      rows.push({ name, pid: Number(pid), mem: cols[4] || '' })
    }
    return okJson(rows.slice(0, 300))
  }
  const { stdout } = await run('ps', ['-eo', 'pid,comm,%mem'], { maxBuffer: 8 * 1024 * 1024 })
  const rows = stdout.split('\n').slice(1).map(line => line.trim().split(/\s+/))
    .filter(cols => cols.length >= 2)
    .map(cols => ({ pid: Number(cols[0]), name: cols[1], mem: cols[2] || '' }))
    .filter(row => !filter || row.name.toLowerCase().includes(filter))
  return okJson(rows.slice(0, 300))
}

async function ps(script, args = []) {
  return run('powershell.exe', [...PS, `& { ${script} }`, ...args], {
    maxBuffer: 64 * 1024 * 1024, timeout: 60000, windowsHide: true,
  })
}

export async function openApp(target, token = null) {
  const value = String(target || '').trim()
  if (!value) return errJson('缺少 path')
  const refusal = await enforceExec('open_app', { path: value }, token)
  if (refusal) return errJson(refusal)
  try {
    if (IS_WIN) await ps('Start-Process -FilePath $args[0]', [value])
    else {
      const { spawn } = await import('node:child_process')
      const child = spawn('xdg-open', [value], { detached: true, stdio: 'ignore' })
      child.unref()
    }
    return okJson({ ok: true, path: value })
  } catch (error) { return errJson(`打开失败: ${error.message}`) }
}

export async function openUrl(url) {
  const value = String(url || '').trim()
  if (!/^https?:\/\//i.test(value)) return errJson('仅支持 http(s) 链接')
  try {
    if (IS_WIN) await ps('Start-Process -FilePath $args[0]', [value])
    else {
      const { spawn } = await import('node:child_process')
      const child = spawn('xdg-open', [value], { detached: true, stdio: 'ignore' })
      child.unref()
    }
    return okJson({ ok: true, url: value })
  } catch (error) { return errJson(`打开链接失败: ${error.message}`) }
}

export async function openBilling() {
  return openUrl('https://bigmodel.cn/usercenter/billing')
}

export async function getClipboard(token = null) {
  const refusal = await enforceExec('clipboard_read', {}, token)
  if (refusal) return errJson(refusal)
  if (!IS_WIN) return errJson('当前平台暂未实现剪贴板读取')
  const { stdout } = await ps('Get-Clipboard -Raw')
  return stdout.replace(/\r?\n$/, '')
}

export async function setClipboard(text, token = null) {
  const value = String(text ?? '')
  const refusal = await enforceExec('clipboard_write', { len: value.length }, token)
  if (refusal) return errJson(refusal)
  if (!IS_WIN) return errJson('当前平台暂未实现剪贴板写入')
  await ps('Set-Clipboard -Value $args[0]', [value])
  return '{"ok":true}'
}

export async function pickFolder(sid = null) { // sid 保留 legacy 参数面；原生对话框不依赖会话状态
  // 测试例外（差分设计 §2.3 对话框 seam，与 Python 侧 GLM_TEST_PICK 对等）：
  // 默认空 = 真实对话框；非空 = 直接按给定路径返回（不弹窗）。契约输出形状不变。
  const testPicked = process.env.HARBOR_TEST_PICKED_PATH
  if (testPicked) return okJson({ ok: true, path: testPicked })
  if (!IS_WIN) return okJson({ ok: false, err: 'no window' })
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = '选择工作目录'
if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dlg.SelectedPath }`
  try {
    const { stdout } = await ps(script)
    const dir = stdout.trim()
    return dir ? okJson({ ok: true, path: dir }) : okJson({ ok: false, err: 'cancelled' })
  } catch (error) { return okJson({ ok: false, err: `${error.name}: ${error.message}` }) }
}

export async function pickSavePath(defaultName = 'export.md') {
  // 测试例外同 pick_folder：HARBOR_TEST_PICKED_PATH 非空时登记后直接返回（不弹窗），
  // 与 Python 侧 GLM_TEST_PICK 驱动桩对等；默认行为（真实另存为对话框）不变。
  const testPicked = process.env.HARBOR_TEST_PICKED_PATH
  if (testPicked) {
    exportPaths.add(pathKey(testPicked))
    return okJson({ ok: true, path: testPicked })
  }
  if (!IS_WIN) return errJson('当前环境不支持保存对话框')
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$dlg = New-Object System.Windows.Forms.SaveFileDialog
$dlg.FileName = $args[0]
if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dlg.FileName }`
  try {
    const { stdout } = await ps(script, [String(defaultName || 'export.md')])
    const file = stdout.trim()
    if (!file) return okJson({ ok: false, path: '' })
    exportPaths.add(pathKey(file))
    return okJson({ ok: true, path: file })
  } catch (error) { return errJson(`保存对话框失败: ${error.message}`) }
}

/** save_export_file 先校验再消费；校验失败时登记仍保留，用户可重试。 */
export function consumeExportPath(target) {
  const key = pathKey(target)
  if (!exportPaths.has(key)) return false
  exportPaths.delete(key)
  return true
}

export async function takeScreenshot(left = null, top = null, width = null, height = null, token = null) {
  const refusal = await enforceExec('take_screenshot', {}, token)
  if (refusal) return errJson(refusal)
  if (!IS_WIN) return errJson('当前平台暂未实现截图')
  const l = Number(left) || 0; const t = Number(top) || 0
  const w = Number(width) || 0; const h = Number(height) || 0
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$w = ${w > 0 ? w : '[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width'}
$h = ${h > 0 ? h : '[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height'}
$bmp = New-Object System.Drawing.Bitmap([int]$w, [int]$h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${l}, ${t}, 0, 0, $bmp.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
[Convert]::ToBase64String($ms.ToArray())
$g.Dispose(); $bmp.Dispose(); $ms.Dispose()`
  try {
    const { stdout } = await ps(script)
    const b64 = stdout.replace(/\s+/g, '')
    if (!b64) return errJson('截图失败')
    return okJson({ ok: true, image_base64: b64, dataUrl: `data:image/png;base64,${b64}`,
      mime: 'image/png', width: w, height: h })
  } catch (error) { return errJson(`截图失败: ${error.message}`) }
}

export async function killProcess(pid = null, name = null, token = null) {
  const refusal = await enforceExec('kill_process', { pid: pid || '', name: name || '' }, token)
  if (refusal) return errJson(refusal)
  if (IS_WIN) {
    if (pid) await run('taskkill', ['/PID', String(pid), '/F'])
    else if (name) await run('taskkill', ['/IM', String(name), '/F'])
    else return errJson('需要 pid 或 name')
    return okJson({ ok: true, pid: pid || null, name: name || null })
  }
  if (pid) await run('kill', ['-9', String(pid)])
  else if (name) await run('pkill', ['-9', '-f', String(name)])
  else return errJson('需要 pid 或 name')
  return okJson({ ok: true, pid: pid || null, name: name || null })
}
