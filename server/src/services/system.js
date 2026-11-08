/**
 * OS 原生能力：进程、应用/链接打开、剪贴板、目录对话框、截图。
 * Windows 走 tasklist / PowerShell，全部 execFile + 参数数组，不做 shell 拼接。
 */
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import iconv from 'iconv-lite'
import { enforceExec, ARMED } from './guard.js'
import { guardAudit } from './misc.js'

const run = promisify(execFile)
const okJson = value => JSON.stringify(value)
const errJson = message => JSON.stringify({ error: String(message) })
const IS_WIN = process.platform === 'win32'
const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']
const exportPaths = new Set()
const pathKey = value => path.normalize(path.resolve(String(value || ''))).toLowerCase()

/** P0-1c PL1：get_platform_info（api.py:308-346 结构全对齐）。
 *
 * - os：detect_platform 口径（win32→'win' / darwin→'mac' / 其余→'headless'）；
 * - machine：platform.machine() 映射（x64→'AMD64' / arm64→'ARM64' / ia32→'x86'）；
 * - python：键冻结（前端 window.__platformInfo 消费）、值披露 Node 运行时
 *   版本串（ID-202——与 ID-001 exe 字段同构：键是契约，值是宿主身份）；
 * - services：七接口就绪度 = 平台能力声明（sandbox 与 CF4 sandbox_status 的
 *   available:true 同口径；Node 沙箱/DPAPI 设施缺口由 ID-201 / P0-2 跟踪）；
 * - browser_backend：platform/win/headless 为 Python 字面量同值，mac 探测
 *   （Node 无 cocoa 后端恒 false），note 为冻结契约文案。
 * Node 增强折叠（os_release/cpus/total_memory/homedir）不外露——P0-1b 先例。 */
export async function getPlatformInfo() {
  const detect = IS_WIN ? 'win' : (process.platform === 'darwin' ? 'mac' : 'headless')
  const machineMap = { x64: 'AMD64', arm64: 'ARM64', ia32: 'x86' }
  const services = {}
  for (const name of ['secrets', 'sandbox', 'screen', 'trash', 'paths', 'process', 'notify']) {
    services[name] = { ok: IS_WIN, name }
  }
  return okJson({
    ok: true,
    os: detect,
    machine: machineMap[process.arch] || process.arch,
    python: process.versions.node,
    services,
    browser_backend: {
      platform: detect,
      win: true,
      headless: true,
      mac: false,
      note: 'mac 后端为理论实现（PyObjC 就绪即启用；真机链路验证排期 M9.5）',
    },
  })
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

/** R37 修复（S2-1 P1 命令注入）：参数以 PS 单引号字面量**内联**进脚本体——
 * 原 args 作为独立 argv 跟在 -Command 后，无空白参数被 PS 解析器按裸词展开，
 * `$( )` 子表达式被执行（活体 PoC：http://$(x).com → http://INJECTED.com），
 * open_url/open_app/set_clipboard/pick_save_path 的载荷可越过 always 档
 * 「用户确认的是 X」语义执行任意命令。PS 单引号内零插值（'' 转义单引号），
 * 值面再无可执行语法。 */
const psLiteral = v => `'` + String(v ?? '').replace(/'/g, `''`) + `'`
async function ps(script, args = []) {
  let body = script
  args.forEach((v, i) => { body = body.split(`$args[${i}]`).join(psLiteral(v)) })
  return run('powershell.exe', [...PS, `& { ${body} }`], {
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
  // P0-1c CL2：{ok, text, len}（clipboard_service.get_clipboard 口径）
  const refusal = await enforceExec('clipboard_read', {}, token)
  if (refusal) return errJson(refusal)
  if (!IS_WIN) return errJson('当前平台暂未实现剪贴板读取')
  const { stdout } = await ps('Get-Clipboard -Raw')
  const text = stdout.replace(/\r?\n$/, '')
  return okJson({ ok: true, text, len: text.length })
}

export async function setClipboard(text, token = null) {
  // P0-1c CL1：{ok, len, verified}——写后回读校验（与 legacy 同语义；
  // 差分 mock 环境回读即共享槽位值）
  const value = String(text ?? '')
  const refusal = await enforceExec('clipboard_write', { len: value.length }, token)
  if (refusal) return errJson(refusal)
  if (!IS_WIN) return errJson('当前平台暂未实现剪贴板写入')
  await ps('Set-Clipboard -Value $args[0]', [value])
  let verified = false
  try {
    const { stdout } = await ps('Get-Clipboard -Raw')
    verified = stdout.replace(/\r?\n$/, '') === value
  } catch { verified = false }
  return okJson({ ok: true, len: value.length, verified })
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

/* ---------------- 进程（P0-1c K1：四层防线，对齐 process_service.py:126-164） ---------------- */

// 关键进程保护名单（小写比较）：强杀可致系统不稳定/会话丢失（逐字迁移）
const PROTECTED_NAMES = new Set(['system', 'system idle process', 'idle',
  'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe',
  'services.exe', 'lsass.exe', 'svchost.exe', 'explorer.exe',
  'dwm.exe', 'sihost.exe', 'taskhostw.exe', 'ctfmon.exe'])
// pid 保护：Idle(0)/System(4)/自身
const PROTECTED_PIDS = new Set([0, 4])

/** Python %r 语义（str repr 单引号口径）。 */
const pyRepr = value => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/** 控制台解码（W13：OEM/GBK 优先 + 替换符最少启发；process_service._decode_console）。 */
function decodeConsole(buf) {
  if (!buf || !buf.length) return ''
  let best = null
  let bestBad = null
  for (const encoding of ['gbk', 'utf8']) {
    const text = iconv.decode(buf, encoding)
    const bad = (text.match(/\uFFFD/g) || []).length
    if (best === null || bad < bestBad) { best = text; bestBad = bad }
    if (bad === 0) break
  }
  return best
}

/** S2：pid → 进程名反查（tasklist /fi CSV；OEM 优先解码口径同 legacy W13）。 */
async function resolveNameByPid(pid) {
  try {
    const { stdout } = await run('tasklist', ['/fi', `PID eq ${Number(pid)}`, '/fo', 'csv', '/nh'],
      { timeout: 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' })
    const raw = decodeConsole(stdout)
    for (const line of raw.split(/\r?\n/)) {
      const parts = line.split('","').map(col => col.replace(/^"|"$/g, '').trim())
      if (parts.length >= 2 && parts[1] === String(Number(pid))) return parts[0]
    }
  } catch { /* 反查失败 → None（调用方降级处理，与 Python 同款不额外收紧） */ }
  return null
}

/** P4：保护名单判定（process_service._protection_reason 逐字）。 */
function protectionReason(pid, name) {
  if (pid !== null && pid !== undefined) {
    const pidNum = Number(pid)
    if (Number.isInteger(pidNum) && (PROTECTED_PIDS.has(pidNum) || pidNum === process.pid)) {
      return `pid=${pidNum} 是系统关键进程或 Harbor 自身，已拒绝强杀`
    }
  }
  if (name && PROTECTED_NAMES.has(String(name).trim().toLowerCase())) {
    return `进程 ${name} 属于系统关键进程，已拒绝强杀`
  }
  return null
}

export async function killProcess(pid = null, name = null, token = null) {
  const detail = { pid: pid !== null && pid !== undefined ? pid : '', name: name || '' }
  const refusal = await enforceExec('kill_process', detail, token)
  if (refusal) return errJson(refusal)

  try {
    // ---- api 层（api.py:620-639）：反查前置 + 伪造名拒绝 ----
    if (pid !== null && pid !== undefined) {
      const resolved = await resolveNameByPid(pid)
      if (resolved === null) {
        // 未武装差分环境放行到服务层；生产武装态此处 block（api.py resolve-failed）
        if (ARMED) {
          await guardAudit('kill_process', detail, 'block', 'resolve-failed')
          return okJson({ error: `无法确认 pid=${pid} 对应的进程名（tasklist 反查失败），为防误杀系统进程已拒绝执行。` })
        }
      } else if (name && String(resolved).trim().toLowerCase() !== String(name).trim().toLowerCase()) {
        await guardAudit('kill_process', detail, 'block', 'name-spoofed')
        return okJson({ error: `pid=${pid} 实际进程名为 ${resolved}，与传入 name=${name} 不一致，已拒绝（防伪造 name 绕过名单）` })
      }
      if (resolved) detail.name = resolved
    }

    // ---- 服务层四层防线（顺序即安全语义，不得调换） ----
    // C1：pid 非数字直接报错
    if (pid !== null && pid !== undefined) {
      const pidText = String(pid).trim()
      if (!/^-?\d+$/.test(pidText)) {
        return okJson({ error: `pid 必须是数字: ${pyRepr(pid)}` })
      }
      // S2（二轮）：反查结果权威——伪造 name 不再架空名单
      const resolved = await resolveNameByPid(pid)
      if (resolved) {
        if (name && String(name).trim().toLowerCase() !== resolved.trim().toLowerCase()) {
          return okJson({ error: `pid=${pid} 实际进程名为 ${resolved}，与传入 name=${name} 不一致，已拒绝` })
        }
        name = resolved
      }
    }
    // S3（二轮）：taskkill /IM 通配符可批量强杀（'*' 杀当前用户一切进程）——直接拒绝
    if (name && (String(name).includes('*') || String(name).includes('?'))) {
      return okJson({ error: '进程名不支持通配符（* / ?），请先用 list_processes 确认确切进程名后按名/按 pid 结束' })
    }
    // P4：保护名单（token 之后仍生效的硬防线）
    const reason = protectionReason(pid, name)
    if (reason) return okJson({ error: `${reason}（保护名单）` })

    // X5：执行（/T 树杀 + /F 强杀；输出 GBK 解码——legacy OEM 口径，截 2000）
    let result
    if (pid !== null && pid !== undefined) {
      result = await run('taskkill', ['/PID', String(pid), '/T', '/F'],
        { timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' })
    } else if (name) {
      result = await run('taskkill', ['/IM', String(name), '/T', '/F'],
        { timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' })
    } else {
      return okJson({ error: '需要 pid 或 name 参数' })
    }
    const stdoutText = iconv.decode(result.stdout || Buffer.alloc(0), 'gbk').trim()
    const stderrText = iconv.decode(result.stderr || Buffer.alloc(0), 'gbk').trim()
    const output = (stdoutText || stderrText).slice(0, 2000)
    await guardAudit('kill_process', { ...detail, killed: true }, 'decision', 'ok')
    return okJson({ ok: true, exit_code: 0, output })
  } catch (error) {
    // taskkill 非零退出（进程不存在等）：保持成功形状 + exit_code（Agent 判断力）
    if (error && typeof error.code === 'number' && (error.stdout !== undefined || error.stderr !== undefined)) {
      const stdoutText = iconv.decode(error.stdout || Buffer.alloc(0), 'gbk').trim()
      const stderrText = iconv.decode(error.stderr || Buffer.alloc(0), 'gbk').trim()
      return okJson({ ok: false, exit_code: error.code, output: (stdoutText || stderrText).slice(0, 2000) })
    }
    return okJson({ error: String(error && error.message ? error.message : error) })
  }
}
