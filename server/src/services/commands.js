/**
 * 命令执行沙箱（P0-1b T02 对齐重写）：run_command / run_powershell /
 * run_admin_command / software_*。
 *
 * 响应契约收敛为 legacy 方言（设计 §7 方言表，stdout/stderr 分离折叠为内部实现）：
 *   成功     {exit_code, output[, note]}（output=stdout+可选 '\n[stderr] '+stderr；
 *            空输出补 note '命令执行完毕，无任何输出'）
 *   去重拒绝 {info: tip, skipped: true}（RunDeduper 文案逐字）
 *   超时     {error: '命令执行超时(<t>s)'}——并回滚去重登记放行合法重试（W1）
 *   admin    人审门（HARBOR_TEST_MSGBOX seam：6=放行/7=拒绝；无 seam 无 UI 钩子
 *            时 fail-closed 拒绝——E4）→ 拒绝 {info, skipped:true}；放行后 UAC
 *            （Start-Process -Verb RunAs）为第二道门；成功
 *            {exit_code, output, note:'已通过管理员权限执行'}
 *
 * 截断（C5）：6000 字阈值 + toolcache 续读（'id=tc<n>_<ts>, 用 read_more 分段获取'）。
 * 去重键（C4①）：用户原命令域（不掺 shell 前缀；admin 不用包装后脚本算键）。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { effectiveRoot, runtime } from '../runtime.js'
import { enforceExec } from './guard.js'
import { cacheToolOutput } from './files.js'

const run = promisify(execFile)
const okJson = value => JSON.stringify(value)
const errJson = message => JSON.stringify({ error: String(message) })

const IS_WIN = process.platform === 'win32'
const MAX_OUTPUT = 6000           // Python cmd_service 截断阈值（admin 通道 60000 保留）
const ADMIN_MAX_OUTPUT = 60000
const DEFAULT_TIMEOUT = 120000
const DEDUP_WINDOW_MS = 15 * 60 * 1000  // Python RunDeduper 全窗（OrderedDict maxlen 64 条）

const BLACKLIST = [
  /rm\s+-rf\s+\//i,
  /del\s+\/s\s+\/q/i,
  /rmdir\s+\/s\s+\/q/i,
  /\bformat\s+[a-z]:/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /Remove-Item\s+.*-Recurse.*-Force.*[A-Z]:\\/i,
  /Stop-Computer/i,
  /Restart-Computer/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
]

const recent = new Map()   // dedupKey -> last-run ts（全窗；begin_task 复位）
let lastKey = null         // Python RunDeduper._last（紧邻去重与窗口去重文案分叉）

const WRITE_VERBS = new Set(['del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri', 'mkdir', 'md',
  'new-item', 'ni', 'move', 'move-item', 'copy', 'copy-item', 'cp',
  'reg', 'regedit', 'regsvr32', 'setx', 'format', 'taskkill',
  'stop-process', 'start-process', 'iex', 'invoke-expression', 'rm', 'rm-item'])

/** begin_task 的唯一职责：新任务重置命令去重；clear_caches 不得调用它。 */
export async function beginTask() {
  recent.clear()
  lastKey = null
  return 'ok'
}

/** 去重键（Python dedup_key 语义：小写化 + 剥引号与 ./ .\ 前缀的命令归一）。 */
function dedupKey(command) {
  const key = String(command || '').split(/\s+/).filter(Boolean).join(' ').toLowerCase()
    .replace(/^["']|["']$/g, '')
    .replace(/^\.\//, '')
    .replace(/^\.\\/, '')
  return key
}

/** Python RunDeduper.check 三变体文案（cmd_service.py:67-90 逐字）。 */
function checkDedup(command) {
  const key = dedupKey(command)
  if (key.includes('[console]::outputencoding')) {
    return '后端已强制 UTF-8，命令里不要再设置编码；读文件请用 read_file（自动识别 UTF-8/GBK）。'
  }
  if (key === lastKey) {
    return '与上一条命令完全相同，已拒绝；如需刷新结果请加参数或说明目的。'
  }
  if (recent.has(key)) {
    const isWrite = key.split(/\s+/).some(token => WRITE_VERBS.has(token.replace(/[^a-z-]/g, '')))
    if (isWrite) return '该写命令本会话已执行过，已拦截；确需重跑请修改参数。'
    return '该命令最近已执行过，已拒绝重复执行；如需刷新结果请加参数或说明目的。'
  }
  return null
}

function markDedup(command) {
  const key = dedupKey(command)
  lastKey = key
  recent.set(key, Date.now())
  if (recent.size > 64) recent.delete(recent.keys().next().value)
}

/** W1：执行失败/被护栏拒绝的命令回滚登记——合法重试不被误拦。 */
function unmarkDedup(command) {
  const key = dedupKey(command)
  recent.delete(key)
  if (lastKey === key) lastKey = null
}

function blacklistHit(command) {
  return BLACKLIST.find(pattern => pattern.test(command)) || null
}

/** Python _truncate_output 同构：6000 字阈值 + toolcache 续读引用。 */
async function truncateOutput(output, maxBytes = MAX_OUTPUT) {
  const text = String(output || '')
  if (text.length <= maxBytes) return text
  const cid = await cacheToolOutput(text)
  const tip = cid ? `id=${cid}, 用 read_more 分段获取` : '全文未保留'
  return `${text.slice(0, 1500)}\n…[输出共 ${text.length} 字已截断;${tip}]…\n${text.slice(-800)}`
}

export async function execute(command, timeout, token, shell = 'cmd', guardOp = null, guardCommand = null, skipGuard = false, skipDedup = false) {
  const cmd = String(command || '').trim()
  if (!cmd) return errJson('缺少 command')

  const op = guardOp || (shell === 'powershell' ? 'run_powershell' : 'run_command')
  if (!skipGuard) {
    // 与前端 _guardDetailOf 及 legacy 执行点同源：命令摘要人是 {cmd}（提权时保留用户原命令）
    const refusal = await enforceExec(op, { cmd: String(guardCommand ?? command ?? '').trim() }, token)
    if (refusal) return errJson(refusal)
  }
  // 去重域 = 用户原命令（admin 路径由 runAdminCommand 自行管理去重——W5 单域原则）
  const dedupKey = String(guardCommand ?? command ?? cmd)
  if (!skipDedup) {
    const dedupTip = checkDedup(dedupKey)
    if (dedupTip) {
      return okJson({ info: dedupTip, skipped: true })
    }
    markDedup(dedupKey)
  }

  const hit = blacklistHit(cmd)
  if (hit) {
    if (!skipDedup) unmarkDedup(dedupKey)  // 拒绝不占去重域（W1 同口径）
    return errJson(`命令命中沙箱黑名单（${hit}），已拒绝执行。请改用更窄、可逆的操作。`)
  }

  const cwd = effectiveRoot(runtime.currentSid)
  const timeoutSeconds = Math.max(5, Math.min(Number(timeout) || 60, 600))
  const timeoutMs = timeoutSeconds * 1000

  const [file, args] = IS_WIN
    ? (shell === 'powershell'
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd]]
      : ['cmd.exe', ['/d', '/s', '/c', cmd]])
    : ['/bin/sh', ['-c', cmd]]

  try {
    const { stdout, stderr } = await run(file, args, {
      cwd,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    })
    const errText = String(stderr || '').trim()
    let output = String(stdout || '') + (errText ? `\n[stderr] ${errText}` : '')
    output = await truncateOutput(output)
    const info = { exit_code: 0, output }
    if (!output.trim()) info.note = '命令执行完毕，无任何输出'
    return okJson(info)
  } catch (error) {
    // 超时/执行级失败：回滚去重登记（W1）——合法重试不被误拦
    if (!skipDedup) unmarkDedup(guardCommand ?? command ?? cmd)
    const timedOut = !!(error.killed || error.signal) || /timed out/i.test(error.message || '')
    if (timedOut) return errJson(`命令执行超时(${timeoutSeconds}s)`)
    const errText = String(error.stderr || '').trim()
    let output = String(error.stdout || '') + (errText ? `\n[stderr] ${errText}` : '')
    output = await truncateOutput(output)
    const info = { exit_code: typeof error.code === 'number' ? error.code : 1, output }
    if (!output.trim()) info.note = '命令执行完毕，无任何输出'
    return okJson(info)
  }
}

export async function runCommand(command, timeout, token) {
  return execute(command, timeout, token, 'cmd')
}

export async function runPowershell(command, timeout, token) {
  return execute(command, timeout, token, 'powershell')
}

/** admin 人审门（E4）：HARBOR_TEST_MSGBOX seam（6=放行/7=拒绝）；无 seam 且无
 * UI 钩子 → fail-closed 拒绝（与 Python IDNO 同款回执）。UAC 为第二道门。 */
function adminMessageBoxDecision(cmd) {
  const seam = process.env.HARBOR_TEST_MSGBOX
  if (seam === '6') return { allow: true }
  if (seam === '7') return { allow: false }
  // 生产：P0-4 接 Electron 对话框；接线前 fail-closed（收紧，不静默提权）
  return { allow: false }
}

export async function runAdminCommand(command, token, timeout) {
  const cmd = String(command || '').trim()
  if (!cmd) return errJson('缺少 command')
  if (!IS_WIN) return errJson('提权执行目前仅支持 Windows')

  // Python 顺序：api 层 _execute_guarded 先于人审/去重（guard → service）
  const refusal = await enforceExec('run_admin_command', { cmd }, token)
  if (refusal) return errJson(refusal)

  // 去重键 = 用户原命令域（W5：不掺 shell 前缀/包装脚本）
  const dedupTip = checkDedup(cmd)
  if (dedupTip) {
    return okJson({ info: dedupTip, skipped: true })
  }

  const verdict = adminMessageBoxDecision(cmd)
  if (!verdict.allow) {
    return okJson({ info: '用户拒绝了本次管理员命令，请改用无需提权的方案。', skipped: true })
  }

  markDedup(cmd)
  // admin 路径：token 已在人审前消费、去重已在用户命令域登记——execute 全跳过
  const script = `Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/s','/c',${JSON.stringify(cmd)} -Verb RunAs -Wait`
  const raw = await execute(script, timeout, null, 'powershell', 'run_admin_command', cmd, true, true)
  let payload
  try { payload = JSON.parse(raw) } catch { return raw }
  // 响应折叠为 legacy admin 方言：{exit_code, output, note:'已通过管理员权限执行'}
  if (payload && payload.exit_code !== undefined && !payload.error && !payload.info) {
    const output = await truncateOutput(payload.output ?? '', ADMIN_MAX_OUTPUT)
    return okJson({
      exit_code: payload.exit_code,
      output,
      note: '已通过管理员权限执行',
    })
  }
  unmarkDedup(cmd)
  return raw
}

export async function softwareCall(params, token) {
  const { softwareCall: call } = await import('./software.js')
  return call(params, token)
}

export async function softwareList(status = 'all') {
  const { softwareList: list } = await import('./software.js')
  return list(status)
}

export async function softwareProbe(name = null) {
  const { softwareProbe: probe } = await import('./software.js')
  return probe(name)
}
