/**
 * 命令执行沙箱：run_command / run_powershell / run_admin_command / software_*。
 *
 * 执行前必须过护栏（token 或会话信任）；执行时套用：
 *   - 命令黑名单（删除/格式化/关机等破坏性模式）；
 *   - 工作目录限定为有效工作区；
 *   - 超时强杀、stdout/stderr 截断、执行耗时与退出码回传；
 *   - 相同命令短窗口去重（防止 Agent 重复触发同一高代价命令）。
 *
 * 注意：沙箱是应用层校验，**不是操作系统级隔离**。黑名单是兜底而非全部防线，
 * 真正的授权边界在 guard 的档位与 token。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { effectiveRoot, runtime } from '../runtime.js'
import { enforceExec } from './guard.js'

const run = promisify(execFile)
const okJson = value => JSON.stringify(value)
const errJson = message => JSON.stringify({ error: String(message) })

const IS_WIN = process.platform === 'win32'
const MAX_OUTPUT = 60000
const DEFAULT_TIMEOUT = 120000
const DEDUP_WINDOW_MS = 15000

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

const recent = new Map()

/** begin_task 的唯一职责：新任务重置命令去重；clear_caches 不得调用它。 */
export async function beginTask() {
  recent.clear()
  return 'ok'
}

function blacklistHit(command) {
  return BLACKLIST.find(pattern => pattern.test(command)) || null
}

function truncate(text) {
  const value = String(text || '')
  if (value.length <= MAX_OUTPUT) return { text: value, truncated: false }
  return { text: value.slice(0, MAX_OUTPUT) + '\n…(输出已截断)', truncated: true }
}

export async function execute(command, timeout, token, shell = 'cmd', guardOp = null, guardCommand = null) {
  const cmd = String(command || '').trim()
  if (!cmd) return errJson('缺少 command')

  const op = guardOp || (shell === 'powershell' ? 'run_powershell' : 'run_command')
  // 与前端 _guardDetailOf 及 legacy 执行点同源：命令摘要是 {cmd}，不是 {command}。
  // 提权时 guardCommand 保留用户原命令，不能用包装后的 Start-Process 脚本计算摘要。
  const refusal = await enforceExec(op, { cmd: String(guardCommand ?? command ?? '').trim() }, token)
  if (refusal) return errJson(refusal)

  const hit = blacklistHit(cmd)
  if (hit) {
    return errJson(`命令命中沙箱黑名单（${hit}），已拒绝执行。请改用更窄、可逆的操作。`)
  }

  const key = `${shell}:${cmd}`
  const last = recent.get(key)
  if (last && Date.now() - last < DEDUP_WINDOW_MS) {
    return okJson({ ok: true, deduped: true, note: '相同命令刚执行过，已按去重策略跳过' })
  }
  recent.set(key, Date.now())

  const cwd = effectiveRoot(runtime.currentSid)
  const timeoutMs = Math.max(1000, Math.min(Number(timeout) * 1000 || DEFAULT_TIMEOUT, 600000))
  const started = Date.now()

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
    const out = truncate(stdout)
    const err = truncate(stderr)
    return okJson({
      ok: true, code: 0, cwd,
      stdout: out.text, stderr: err.text,
      truncated: out.truncated || err.truncated,
      duration_ms: Date.now() - started,
    })
  } catch (error) {
    const out = truncate(error.stdout)
    const err = truncate(error.stderr || error.message)
    // execFile 超时时 killSignal 即为我们传入的 SIGKILL，error.killed 不一定为 true，
    // 因此以「被杀信号」判定超时，而不是只看 killed 标志
    const timedOut = !!(error.killed || error.signal) || /timed out/i.test(error.message || '')
    return okJson({
      ok: false,
      code: typeof error.code === 'number' ? error.code : null,
      timeout: timedOut || undefined,
      cwd,
      stdout: out.text, stderr: err.text,
      truncated: out.truncated || err.truncated,
      duration_ms: Date.now() - started,
    })
  }
}

export async function runCommand(command, timeout, token) {
  return execute(command, timeout, token, 'cmd')
}

export async function runPowershell(command, timeout, token) {
  return execute(command, timeout, token, 'powershell')
}

export async function runAdminCommand(command, token, timeout) {
  const cmd = String(command || '').trim()
  if (!IS_WIN) return errJson('提权执行目前仅支持 Windows')
  // 通过 Start-Process -Verb RunAs 触发系统 UAC 确认（用户可见），不在后台静默提权。
  // 只在 execute 内消费一次 run_admin_command token；不能先校验再以 run_powershell 二次消费。
  const script = `Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/s','/c',${JSON.stringify(cmd)} -Verb RunAs -Wait`
  return execute(script, timeout, token, 'powershell', 'run_admin_command', cmd)
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
