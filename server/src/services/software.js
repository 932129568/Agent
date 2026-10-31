/** 外部软件注册表与调用（P0-1b T05 对齐重写：与 legacy software_service.py 同构）。
 *
 * 调用顺序（legacy 源码顺序，单一事实源）：
 *   ① api 层护栏：action_risk(software, action)=='dangerous' → force_always
 *      _detail → enforceExec（未武装也强制 token——legacy enforce_exec 语义）
 *   ② args 必须是 JSON 对象 → ③ 软件解析（UNKNOWN_SOFTWARE，%r 引号）
 *   → ④ 动作解析（BAD_PARAMS，%r 引号）→ ⑤ 安装/身份校验（unknown 先探测；
 *   NOT_INSTALLED / IDENTITY_MISMATCH）→ ⑥ arg Schema 硬校验（SCHEMA_INVALID
 *   + violations[{path,expect,got}] + example）→ ⑦ 工作区路径门禁
 *   → ⑧ 执行（cli: {ok,software,action,kind,exit_code,stdout,stderr,
 *   duration_ms,sandboxed,truncated,untrusted,source}；gui/uri 形态）。
 *
 * 持久化（SW6）：software.json = {version:1, user:{...}, probe_cache:{...}}。
 * CLI 全部 execFile+argv，不经过 shell。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CONFIG_DIR, atomicWriteJson } from '../paths.js'
import { resolveWs } from './jail.js'
import { ctxRoot } from '../session-context.js'
import { enforceExec } from './guard.js'
import { guardAudit } from './misc.js'
import { cacheToolOutput } from './files.js'

const run = promisify(execFile)
const json = value => JSON.stringify(value)
const fail = (code, message, hint = '', extra = {}) => json({ ok: false,
  error: { code, message, ...(hint ? { hint } : {}), ...extra } })
const schema = (properties = {}, required = []) => (required.length
  ? { type: 'object', properties, required }
  : { type: 'object', properties })
const str = { type: 'string' }
const wsPath = { type: 'string', 'x-workspace-path': true }
const action = (name, risk, argv, properties = {}, required = []) => ({ name, risk, argv, arg_schema: schema(properties, required) })

const PRESETS = {
  git: { name: 'git', kind: 'cli', source: 'preset', exec: 'git', version_args: ['--version'], version_pattern: 'git version', website: 'https://git-scm.com/downloads', risk_default: 'read', actions: [
    action('status', 'read', ['status']), action('diff', 'read', ['diff']),
    action('log', 'read', ['log', '--oneline', '-n', '{max_count}'], { max_count: { type: 'integer', minimum: 1, maximum: 100, default: 10 } }),
    action('add', 'mutate', ['add', '{paths}'], { paths: { ...str, minLength: 1, maxLength: 500, description: '要暂存的文件/目录（空格分隔多个）' } }, ['paths']),
    action('commit', 'mutate', ['commit', '-m', '{message}'], { message: { ...str, minLength: 1, maxLength: 200, example: 'fix: 描述本次修改' } }, ['message']),
    action('clone', 'mutate', ['clone', '{url}'], { url: { ...str, minLength: 8, maxLength: 500, pattern: '^https?://', example: 'https://github.com/org/repo.git' } }, ['url']),
  ] },
  ffmpeg: { name: 'ffmpeg', kind: 'cli', source: 'preset', exec: 'ffmpeg', version_args: ['-version'], version_pattern: 'ffmpeg version', website: 'https://ffmpeg.org/download.html', risk_default: 'read', actions: [
    action('version', 'read', ['-version']),
    action('convert', 'mutate', ['-y', '-i', '{input}', '{output}'], { input: { ...wsPath, description: '输入媒体文件（工作区内）' }, output: { ...wsPath, description: '输出文件（工作区内）' } }, ['input', 'output']),
  ] },
  '7z': { name: '7z', kind: 'cli', source: 'preset', exec: '7z', version_args: [], version_pattern: '7-Zip', website: 'https://www.7-zip.org/download.html', risk_default: 'read', actions: [
    action('list', 'read', ['l', '{archive}'], { archive: { ...wsPath, description: '压缩包路径（工作区内）' } }, ['archive']),
    action('extract', 'mutate', ['x', '-y', '-o{output}', '{archive}'], { archive: { ...wsPath, description: '压缩包路径（工作区内）' }, output: { ...wsPath, description: '解压目标目录（工作区内）' } }, ['archive', 'output']),
  ] },
  python: { name: 'python', kind: 'cli', source: 'preset', exec: 'python', version_args: ['--version'], version_pattern: 'Python \\d', website: 'https://www.python.org/downloads/', risk_default: 'read', actions: [
    action('version', 'read', ['--version']), action('pip_list', 'read', ['-m', 'pip', 'list']),
    action('run_script', 'dangerous', ['{script}'], { script: { ...wsPath, description: '要执行的 .py 脚本（工作区内，可执行任意代码——高危）' } }, ['script']),
  ] },
  node: { name: 'node', kind: 'cli', source: 'preset', exec: 'node', version_args: ['--version'], version_pattern: 'v\\d+\\.\\d+', website: 'https://nodejs.org/', risk_default: 'read', actions: [
    action('version', 'read', ['--version']),
    action('run_script', 'dangerous', ['{script}'], { script: { ...wsPath, description: '要执行的 .js 脚本（工作区内，可执行任意代码——高危）' } }, ['script']),
  ] },
  notepad: { name: 'notepad', kind: 'gui', source: 'preset', exec: 'notepad', version_args: [], version_pattern: '', expected_title: 'Notepad|记事本|无标题', website: 'https://apps.microsoft.com/', risk_default: 'read', actions: [
    action('open', 'read', ['{path}'], { path: { ...wsPath, description: '要打开的文本文件（工作区内）' } }, ['path']),
  ] },
}

const REGISTRY_FILE = path.join(CONFIG_DIR, 'software.json')
const CLI_TIMEOUT_MIN = 5
const CLI_TIMEOUT_MAX = 600

/* ---------------- 注册表（presets ⊕ user ⊕ probe_cache；load 归一） ---------------- */
const registryState = new Map()

function loadRegistryFile() {
  try {
    const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'))
    if (data && typeof data === 'object' && !Array.isArray(data)) return data
  } catch { /* 缺失/损坏 → 纯预设 */ }
  return {}
}

function rebuildRegistry() {
  const data = loadRegistryFile()
  const user = (data.user && typeof data.user === 'object') ? data.user : {}
  const cache = (data.probe_cache && typeof data.probe_cache === 'object') ? data.probe_cache : {}
  registryState.clear()
  for (const [name, preset] of Object.entries(PRESETS)) {
    registryState.set(name, JSON.parse(JSON.stringify(preset)))
  }
  for (const [name, entry] of Object.entries(user)) {
    if (!entry || typeof entry !== 'object' || !entry.name || !entry.kind) continue
    const base = registryState.get(name)
    registryState.set(name, base ? { ...base, ...entry } : { ...entry })
  }
  for (const [name, entry] of registryState) {
    entry.name = name
    entry.source = (name in PRESETS && !(name in user)) ? 'preset' : 'user'
    entry.status = 'unknown'
    entry.version = null
    entry.probed_at = null
    const cached = cache[name]
    if (cached && typeof cached === 'object' && ['probed', 'missing', 'version_mismatch'].includes(cached.status)) {
      entry.status = cached.status
      entry.version = cached.version ?? null
      entry.probed_at = cached.probed_at ?? null
    }
  }
}
rebuildRegistry()

/** SW6：落盘 {version:1, user:{...}, probe_cache:{已探测条目}}（legacy _persist 同构）。 */
function persistRegistry() {
  const data = loadRegistryFile()
  const user = {}
  for (const [name, entry] of registryState) {
    if (entry.source === 'user') user[name] = entry
  }
  const probeCache = {}
  for (const [name, entry] of registryState) {
    if (entry.status !== 'unknown') {
      probeCache[name] = { status: entry.status, version: entry.version, probed_at: entry.probed_at }
    }
  }
  atomicWriteJson(REGISTRY_FILE, { version: 1, user: { ...user, ...(data.user && typeof data.user === 'object' ? data.user : {}) }, probe_cache: probeCache })
}

function publicEntry(entry) {
  return { name: entry.name, kind: entry.kind, status: entry.status, source: entry.source,
    risk_default: entry.risk_default, ...(entry.version ? { version: entry.version } : {}),
    actions: (entry.actions || []).map(x => ({ name: x.name, risk: x.risk, arg_schema: x.arg_schema || {} })) }
}

/** legacy %r 引号（Python repr of str）。 */
const pyRepr = value => `'${String(value)}'`

export async function softwareList(status = 'all') {
  const filter = ['all', 'probed', 'missing'].includes(String(status || 'all')) ? String(status || 'all') : 'all'
  const items = [...registryState.values()].filter(entry => filter === 'all' ||
    (filter === 'probed' && entry.status === 'probed') ||
    (filter === 'missing' && ['missing', 'version_mismatch'].includes(entry.status)))
    .map(publicEntry).sort((a, b) => a.name.localeCompare(b.name))
  return json({ ok: true, software: items })
}

async function resolveExecutable(entry) {
  if (entry.name === 'node') return process.execPath
  const execName = String(entry.exec || '')
  if (path.isAbsolute(execName)) return fs.existsSync(execName) ? execName : null
  try {
    const { stdout } = await run(process.platform === 'win32' ? 'where.exe' : 'which', [execName], { timeout: 5000, windowsHide: true })
    return stdout.split(/\r?\n/).map(x => x.trim()).find(Boolean) || null
  } catch { return null }
}

async function probeOne(name) {
  const entry = registryState.get(name)
  if (!entry) return { name, status: 'unknown' }
  const exe = await resolveExecutable(entry)
  let status = 'missing'; let version = null
  if (exe) {
    status = 'probed'
    if (entry.version_args?.length && entry.version_pattern) {
      try {
        const { stdout, stderr } = await run(exe, entry.version_args, { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 })
        const output = `${stdout}${stderr}`
        if (new RegExp(entry.version_pattern, 'i').test(output)) version = output.match(/\d+\.\d+(?:\.\d+)*/)?.[0] || null
        else status = 'version_mismatch'
      } catch { status = 'version_mismatch' }
    }
  }
  Object.assign(entry, { status, version, probed_at: Date.now(), resolved_exec: exe })
  return { name, status, ...(version ? { version } : {}) }
}

export async function softwareProbe(name = null) {
  const started = Date.now()
  let targets
  if (name) {
    const key = String(name).trim().toLowerCase()
    if (!registryState.has(key)) return fail('BAD_PARAMS', `未注册的软件: ${pyRepr(name)}`, `可用软件: ${[...registryState.keys()].sort().join('/')}`)
    targets = [key]
  } else targets = [...registryState.keys()].sort()
  const probed = []
  for (const target of targets) probed.push(await probeOne(target))
  persistRegistry()
  await guardAudit('software_probe', { names: targets.join(',').slice(0, 200),
    probed: probed.filter(x => x.status === 'probed').length,
    missing: probed.filter(x => x.status === 'missing').length }, 'probe', 'ok')
  return json({ ok: true, probed, elapsed_ms: Date.now() - started })
}

/* ---------------- arg Schema 校验（legacy _summarize/_expect_text 同构） ---------------- */
function summarize(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return `boolean(${value})`
  if (typeof value === 'number') return Number.isInteger(value) ? `int(${value})` : `float(${value})`
  if (typeof value === 'string') {
    const trimmed = value.length > 24 ? `${value.slice(0, 24)}…` : value
    return `string(${JSON.stringify(trimmed)})`
  }
  if (Array.isArray(value)) return `array[${value.length}]`
  return 'object'
}

function expectText(spec, required) {
  const bits = [spec.type || 'value']
  if (spec.minLength != null || spec.maxLength != null) {
    bits.push(`长度 ${spec.minLength ?? 0}-${spec.maxLength ?? '∞'}`)
  }
  if (spec.minimum != null || spec.maximum != null) {
    bits.push(`范围 ${spec.minimum ?? '-∞'}-${spec.maximum ?? '∞'}`)
  }
  if (spec.enum) bits.push(`合法值 ${spec.enum.join('/')}`)
  const text = bits.join(' ')
  return required ? `${text}(必填)` : text
}

function validateArgs(schemaObject, args) {
  const violations = []
  const properties = schemaObject?.properties || {}
  const required = new Set(schemaObject?.required || [])
  for (const name of required) {
    if (args[name] == null || (typeof args[name] === 'string' && !args[name].trim())) {
      violations.push({ path: name, expect: expectText(properties[name] || {}, true), got: summarize(args[name]) })
    }
  }
  for (const [name, spec] of Object.entries(properties)) {
    if (args[name] == null) continue
    const value = args[name]
    const wrongType = (spec.type === 'string' && typeof value !== 'string') ||
      (spec.type === 'integer' && (!Number.isInteger(value) || typeof value === 'boolean')) ||
      (spec.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) ||
      (spec.type === 'boolean' && typeof value !== 'boolean') ||
      (spec.type === 'array' && !Array.isArray(value)) ||
      (spec.type === 'object' && (typeof value !== 'object' || Array.isArray(value)))
    if (wrongType) { violations.push({ path: name, expect: expectText(spec, required.has(name)), got: summarize(value) }); continue }
    if (spec.type === 'string') {
      if ((spec.minLength != null && value.length < spec.minLength) || (spec.maxLength != null && value.length > spec.maxLength) ||
        (spec.pattern && !(new RegExp(spec.pattern).test(value))) || (spec.enum && !spec.enum.includes(value))) {
        violations.push({ path: name, expect: expectText(spec, required.has(name)), got: summarize(value) })
      }
    }
    if (['integer', 'number'].includes(spec.type) && ((spec.minimum != null && value < spec.minimum) ||
      (spec.maximum != null && value > spec.maximum) || (spec.enum && !spec.enum.includes(value)))) {
      violations.push({ path: name, expect: expectText(spec, required.has(name)), got: summarize(value) })
    }
  }
  return violations
}

function genExample(schemaObject) {
  const out = {}
  for (const name of schemaObject?.required || []) {
    const spec = schemaObject.properties?.[name] || {}
    out[name] = spec.default ?? spec.example ?? (spec['x-workspace-path'] ? 'src/main.py' : spec.type === 'integer' ? (spec.minimum || 0) : '文本')
  }
  return out
}

function sanitize(text) {
  return String(text || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

async function truncateOutput(text) {
  const clean = sanitize(text)
  if (clean.length <= 6000) return { text: clean, truncated: false }
  const id = await cacheToolOutput(clean)
  return { text: `${clean.slice(0, 1500)}\n…(输出截断，完整内容见 full_ref)…\n${clean.slice(-800)}`, truncated: true, full_ref: id }
}

function buildArgv(entry, act, args) {
  return (act.argv || []).map(token => String(token).replace(/\{([A-Za-z_]\w*)\}/g, (_, key) => String(args[key] ?? `{${key}}`)))
}

/** legacy api 层 action_risk：注册表+动作解析（无安装探测）。 */
function actionRisk(software, actionName) {
  const entry = registryState.get(String(software || '').trim().toLowerCase())
  if (!entry) return null
  const act = (entry.actions || []).find(x => x.name === actionName)
  if (!act) return null
  return String(act.risk || entry.risk_default || 'read')
}

export async function softwareCall(params, token = null) {
  let input = params
  if (typeof input === 'string') { try { input = JSON.parse(input) } catch { input = {} } }
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {}
  const software = String(input.software || '').trim().toLowerCase()
  const actionName = String(input.action || '').trim()
  const source = String(input.source || '')
  const args = input.args == null ? {} : input.args
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return fail('BAD_PARAMS', 'args 必须是 JSON 对象', '例如 {"message": "fix: 描述"}')
  }

  // ① api 层护栏（legacy 位置）：dangerous → force_always（未武装也强制 token）
  const risk = actionRisk(software, actionName)
  if (risk === 'dangerous' && source !== 'manual_test') {
    const refusal = await enforceExec('software_call',
      { software, action: actionName, force_always: true }, token)
    if (refusal) {
      await guardAudit('software_call', { software, action: actionName, risk, source }, 'call', 'block')
      return json({ ok: false, error: { code: 'CONFIRM_REQUIRED', message: refusal, op: 'software_call' } })
    }
  }

  // ③ 软件解析（%r 引号 + hint 可用清单）
  const entry = registryState.get(software)
  if (!entry) {
    await guardAudit('software_call', { software, action: actionName, source }, 'call', 'block')
    return fail('UNKNOWN_SOFTWARE', `注册表中没有软件: ${pyRepr(software)}`, `可用软件: ${[...registryState.keys()].sort().join('/')}`)
  }
  // ④ 动作解析
  const act = (entry.actions || []).find(x => x.name === actionName)
  if (!act) {
    await guardAudit('software_call', { software, action: actionName, source }, 'call', 'block')
    return fail('BAD_PARAMS', `软件 ${software} 没有动作: ${pyRepr(actionName)}`, `可用动作: ${(entry.actions || []).map(x => x.name).join('/')}`)
  }
  // ⑤ 安装/身份校验（unknown 先按需探测）
  let status = entry.status
  if (status === 'unknown') status = (await probeOne(software)).status
  if (status === 'missing') {
    await guardAudit('software_call', { software, action: actionName, risk, source }, 'call', 'block')
    const hint = entry.website
      ? `请前往官网下载安装 ${software}：${entry.website}（Harbor 不会自动下载软件，防供应链风险）`
      : `请先安装 ${software} 后重试（Harbor 不会自动下载软件）`
    return fail('NOT_INSTALLED', `未检测到 ${software}（PATH/注册表均未找到）`, hint)
  }
  if (status === 'version_mismatch') {
    await guardAudit('software_call', { software, action: actionName, risk, source }, 'call', 'block')
    return fail('IDENTITY_MISMATCH', `检测到的 ${software} 与预期身份不符（可能是同名假冒程序）`,
      '请检查 PATH 环境变量中是否存在同名程序；确认无误后可在设置→外部软件中重新探测')
  }
  // ⑥ arg Schema 硬校验（SCHEMA_INVALID 自校正回显）
  const argSchema = act.arg_schema || schema()
  const violations = validateArgs(argSchema, args)
  if (violations.length) {
    await guardAudit('software_call', { software, action: actionName, risk, source, violations: violations.length }, 'call', 'block')
    return fail('SCHEMA_INVALID', '参数校验失败', '请按 example 修正后重试（Agent 自校正 ≤2 次）',
      { violations, example: genExample(argSchema) })
  }
  // ⑦ 工作区路径门禁（防 ../junction 越界）
  const gated = { ...args }
  for (const [pname, spec] of Object.entries(argSchema.properties || {})) {
    if (spec['x-workspace-path'] && args[pname] != null) {
      try { gated[pname] = resolveWs(args[pname]) }
      catch (error) {
        return fail('SCHEMA_INVALID', '参数校验失败', String(error.message || error),
          { violations: [{ path: pname, expect: '工作区内的路径', got: summarize(args[pname]) }], example: genExample(argSchema) })
      }
    }
  }

  const timeout = Math.max(CLI_TIMEOUT_MIN, Math.min(Number(input.timeout) || 60, CLI_TIMEOUT_MAX))
  const started = Date.now()

  // ⑧a GUI 形态
  if (entry.kind === 'gui') {
    try {
      const exe = entry.resolved_exec || await resolveExecutable(entry)
      const { spawn } = await import('node:child_process')
      const child = spawn(exe, buildArgv(entry, act, gated), { detached: true, stdio: 'ignore', windowsHide: false })
      child.unref()
      await guardAudit('software_call', { software, action: actionName, risk }, 'call', 'launched')
      return json({ ok: true, software, action: actionName, kind: 'gui', launched: true,
        title_confirmed: false, note: 'GUI 已启动；Node 通道不伪称完成窗口标题核验', untrusted: true, source: { software, action: actionName } })
    } catch (error) { return fail('GUI_UNCONFIRMED', error.message, '', { launched: false }) }
  }

  // ⑧b CLI 形态（成功形状逐键对齐 legacy _call_cli）
  const exe = entry.resolved_exec || await resolveExecutable(entry)
  try {
    const { stdout, stderr } = await run(exe, buildArgv(entry, act, gated), {
      cwd: ctxRoot(), timeout: timeout * 1000, killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    })
    const out = await truncateOutput(stdout); const err = await truncateOutput(stderr)
    await guardAudit('software_call', { software, action: actionName, risk }, 'call', 'ok')
    return json({ ok: true, software, action: actionName, kind: 'cli', exit_code: 0,
      stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated,
      full_ref: out.full_ref || err.full_ref, duration_ms: Date.now() - started,
      sandboxed: false, untrusted: true, source: { software, action: actionName } })
  } catch (error) {
    await guardAudit('software_call', { software, action: actionName, risk }, 'call', 'killed')
    const out = await truncateOutput(error.stdout); const err = await truncateOutput(error.stderr || error.message)
    const timedOut = !!(error.killed || error.signal) || /timed out/i.test(error.message || '')
    if (timedOut) return fail('TIMEOUT', `执行超过 ${timeout}s，进程已终止`, '', { stdout: out.text, stderr: err.text })
    // 非零退出码保留为成功形状（Agent 依据 exit_code 自校正）
    if (typeof error.code === 'number') return json({ ok: true, software, action: actionName, kind: 'cli',
      exit_code: error.code, stdout: out.text, stderr: err.text, duration_ms: Date.now() - started,
      sandboxed: false, untrusted: true, source: { software, action: actionName } })
    return fail('INTERNAL', error.message)
  }
}
