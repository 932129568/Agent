/** 外部软件注册表：list/probe/call。CLI 全部 execFile+argv，不经过 shell。 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CONFIG_DIR, atomicWriteJson } from '../paths.js'
import { readConfigJson } from './jsonstore.js'
import { resolveWs } from './jail.js'
import { effectiveRoot, runtime } from '../runtime.js'
import { enforceExec } from './guard.js'
import { guardAudit } from './misc.js'
import { cacheToolOutput } from './files.js'

const run = promisify(execFile)
const json = value => JSON.stringify(value)
const fail = (code, message, hint = '', extra = {}) => json({ ok: false,
  error: { code, message, ...(hint ? { hint } : {}), ...extra } })
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required })
const str = { type: 'string' }
const wsPath = { type: 'string', 'x-workspace-path': true }
const action = (name, risk, argv, properties = {}, required = []) => ({ name, risk, argv, arg_schema: schema(properties, required) })
const PRESETS = {
  git: { name: 'git', kind: 'cli', source: 'preset', exec: 'git', version_args: ['--version'], version_pattern: 'git version', website: 'https://git-scm.com/downloads', risk_default: 'read', actions: [
    action('status', 'read', ['status']), action('diff', 'read', ['diff']),
    action('log', 'read', ['log', '--oneline', '-n', '{max_count}'], { max_count: { type: 'integer', minimum: 1, maximum: 100, default: 10 } }),
    action('add', 'mutate', ['add', '{paths}'], { paths: { ...str, minLength: 1, maxLength: 500 } }, ['paths']),
    action('commit', 'mutate', ['commit', '-m', '{message}'], { message: { ...str, minLength: 1, maxLength: 200, example: 'fix: 描述本次修改' } }, ['message']),
    action('clone', 'mutate', ['clone', '{url}'], { url: { ...str, minLength: 8, maxLength: 500, pattern: '^https?://', example: 'https://github.com/org/repo.git' } }, ['url']),
  ] },
  ffmpeg: { name: 'ffmpeg', kind: 'cli', source: 'preset', exec: 'ffmpeg', version_args: ['-version'], version_pattern: 'ffmpeg version', website: 'https://ffmpeg.org/download.html', risk_default: 'read', actions: [
    action('version', 'read', ['-version']),
    action('convert', 'mutate', ['-y', '-i', '{input}', '{output}'], { input: wsPath, output: wsPath }, ['input', 'output']),
  ] },
  '7z': { name: '7z', kind: 'cli', source: 'preset', exec: '7z', version_args: [], version_pattern: '7-Zip', website: 'https://www.7-zip.org/download.html', risk_default: 'read', actions: [
    action('list', 'read', ['l', '{archive}'], { archive: wsPath }, ['archive']),
    action('extract', 'mutate', ['x', '-y', '-o{output}', '{archive}'], { archive: wsPath, output: wsPath }, ['archive', 'output']),
  ] },
  python: { name: 'python', kind: 'cli', source: 'preset', exec: 'python', version_args: ['--version'], version_pattern: 'Python \\d', website: 'https://www.python.org/downloads/', risk_default: 'read', actions: [
    action('version', 'read', ['--version']), action('pip_list', 'read', ['-m', 'pip', 'list']),
    action('run_script', 'dangerous', ['{script}'], { script: wsPath }, ['script']),
  ] },
  node: { name: 'node', kind: 'cli', source: 'preset', exec: 'node', version_args: ['--version'], version_pattern: 'v\\d+\\.\\d+', website: 'https://nodejs.org/', risk_default: 'read', actions: [
    action('version', 'read', ['--version']),
    action('run_script', 'dangerous', ['{script}'], { script: wsPath }, ['script']),
  ] },
  notepad: { name: 'notepad', kind: 'gui', source: 'preset', exec: 'notepad', version_args: [], version_pattern: '', expected_title: 'Notepad|记事本|无标题', website: 'https://apps.microsoft.com/', risk_default: 'read', actions: [
    action('open', 'read', ['{path}'], { path: wsPath }, ['path']),
  ] },
}
const registryState = new Map()
for (const [name, entry] of Object.entries(PRESETS)) registryState.set(name, { ...entry, status: 'unknown', version: null })
for (const [name, entry] of Object.entries(readConfigJson('software.json', {}).custom || {})) {
  if (entry && entry.name && entry.kind) registryState.set(name, { ...entry, status: entry.status || 'unknown' })
}
function persist() {
  const probeCache = Object.fromEntries([...registryState].map(([name, entry]) => [name,
    { status: entry.status, version: entry.version, probed_at: entry.probed_at || null }]))
  atomicWriteJson(path.join(CONFIG_DIR, 'software.json'), { ...readConfigJson('software.json', {}), probe_cache: probeCache })
}
function publicEntry(entry) {
  return { name: entry.name, kind: entry.kind, status: entry.status, source: entry.source,
    risk_default: entry.risk_default, ...(entry.version ? { version: entry.version } : {}),
    actions: (entry.actions || []).map(x => ({ name: x.name, risk: x.risk, arg_schema: x.arg_schema || {} })) }
}
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
  const exec = String(entry.exec || '')
  if (path.isAbsolute(exec)) return fs.existsSync(exec) ? exec : null
  try {
    const { stdout } = await run(process.platform === 'win32' ? 'where.exe' : 'which', [exec], { timeout: 5000, windowsHide: true })
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
  return { name, status, version }
}
export async function softwareProbe(name = null) {
  const started = Date.now()
  let targets
  if (name) {
    const key = String(name).trim().toLowerCase()
    if (!registryState.has(key)) return fail('BAD_PARAMS', `未注册的软件: ${name}`, `可用软件: ${[...registryState.keys()].sort().join('/')}`)
    targets = [key]
  } else targets = [...registryState.keys()].sort()
  const probed = []
  for (const target of targets) probed.push(await probeOne(target))
  persist()
  await guardAudit('software_probe', { names: targets.join(',').slice(0, 200),
    probed: probed.filter(x => x.status === 'probed').length,
    missing: probed.filter(x => x.status === 'missing').length }, 'probe', 'ok')
  return json({ ok: true, probed, elapsed_ms: Date.now() - started })
}
function summarize(value) {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `array[${value.length}]`
  if (typeof value === 'object') return 'object{}'
  return `${typeof value}(${JSON.stringify(value).slice(0, 40)})`
}
function validate(schemaObject, args) {
  const violations = []
  const properties = schemaObject?.properties || {}
  for (const name of schemaObject?.required || []) {
    if (args[name] == null || (typeof args[name] === 'string' && !args[name].trim())) {
      violations.push({ path: name, expect: `${properties[name]?.type || 'value'}(必填)`, got: summarize(args[name]) })
    }
  }
  for (const [name, spec] of Object.entries(properties)) {
    if (args[name] == null) continue
    const value = args[name]; const type = spec.type
    const wrong = (type === 'string' && typeof value !== 'string') ||
      (type === 'integer' && (!Number.isInteger(value) || typeof value === 'boolean')) ||
      (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) ||
      (type === 'boolean' && typeof value !== 'boolean') ||
      (type === 'array' && !Array.isArray(value)) || (type === 'object' && (typeof value !== 'object' || Array.isArray(value)))
    if (wrong) { violations.push({ path: name, expect: type, got: summarize(value) }); continue }
    if (type === 'string') {
      if ((spec.minLength != null && value.length < spec.minLength) || (spec.maxLength != null && value.length > spec.maxLength) ||
        (spec.pattern && !(new RegExp(spec.pattern).test(value))) || (spec.enum && !spec.enum.includes(value))) {
        violations.push({ path: name, expect: '符合 schema 的字符串', got: summarize(value) })
      }
    }
    if (['integer', 'number'].includes(type) && ((spec.minimum != null && value < spec.minimum) ||
      (spec.maximum != null && value > spec.maximum) || (spec.enum && !spec.enum.includes(value)))) {
      violations.push({ path: name, expect: `范围 ${spec.minimum ?? '-∞'}-${spec.maximum ?? '∞'}`, got: summarize(value) })
    }
  }
  return violations
}
function example(schemaObject) {
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
export async function softwareCall(params, token = null) {
  let input = params
  if (typeof input === 'string') { try { input = JSON.parse(input) } catch { input = {} } }
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {}
  const software = String(input.software || '').trim().toLowerCase()
  const actionName = String(input.action || '').trim()
  const args = input.args == null ? {} : input.args
  if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('BAD_PARAMS', 'args 必须是 JSON 对象', '例如 {"message":"fix: 描述"}')
  const entry = registryState.get(software)
  if (!entry) return fail('UNKNOWN_SOFTWARE', `注册表中没有软件: ${software}`, `可用软件: ${[...registryState.keys()].sort().join('/')}`)
  const act = (entry.actions || []).find(x => x.name === actionName)
  if (!act) return fail('BAD_PARAMS', `软件 ${software} 没有动作: ${actionName}`, `可用动作: ${(entry.actions || []).map(x => x.name).join('/')}`)
  if (entry.status === 'unknown') await probeOne(software)
  if (entry.status === 'missing') return fail('NOT_INSTALLED', `未检测到 ${software}（PATH/注册表均未找到）`, `请先安装 ${software}；Harbor 不会自动下载软件`)
  if (entry.status === 'version_mismatch') return fail('IDENTITY_MISMATCH', `检测到的 ${software} 与预期身份不符（可能是同名假冒程序）`)
  const argSchema = act.arg_schema || schema()
  const violations = validate(argSchema, args)
  if (violations.length) return fail('SCHEMA_INVALID', '参数校验失败', '请按 example 修正后重试（Agent 自校正 ≤2 次）', { violations, example: example(argSchema) })
  const gated = { ...args }
  for (const [name, spec] of Object.entries(argSchema.properties || {})) {
    if (spec['x-workspace-path'] && args[name] != null) {
      try { gated[name] = resolveWs(args[name]) }
      catch (error) { return fail('SCHEMA_INVALID', '参数校验失败', String(error.message || error), { violations: [{ path: name, expect: '工作区内的路径', got: summarize(args[name]) }], example: example(argSchema) }) }
    }
  }
  const risk = act.risk || entry.risk_default || 'read'
  if (risk === 'dangerous' && input.source !== 'manual_test') {
    const refusal = await enforceExec('software_call', { software, action: actionName }, token)
    if (refusal) return fail('CONFIRM_REQUIRED', refusal, '', { software, action: actionName })
  }
  const started = Date.now()
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
  const exe = entry.resolved_exec || await resolveExecutable(entry)
  const timeout = Math.max(5, Math.min(Number(input.timeout) || 60, 600))
  try {
    const { stdout, stderr } = await run(exe, buildArgv(entry, act, gated), {
      cwd: effectiveRoot(runtime.currentSid), timeout: timeout * 1000, killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    })
    const out = await truncateOutput(stdout); const err = await truncateOutput(stderr)
    await guardAudit('software_call', { software, action: actionName, risk }, 'call', 'ok')
    return json({ ok: true, software, action: actionName, kind: 'cli', exit_code: 0,
      stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated,
      full_ref: out.full_ref || err.full_ref, duration_ms: Date.now() - started,
      untrusted: true, source: { software, action: actionName } })
  } catch (error) {
    const out = await truncateOutput(error.stdout); const err = await truncateOutput(error.stderr || error.message)
    const timedOut = !!(error.killed || error.signal) || /timed out/i.test(error.message || '')
    if (timedOut) return fail('TIMEOUT', `执行超过 ${timeout}s，进程已终止`, '', { stdout: out.text, stderr: err.text })
    // 非零退出码保留为成功形状，让 Agent 能依据 stdout/stderr/exit_code 自校正。
    if (typeof error.code === 'number') return json({ ok: true, software, action: actionName, kind: 'cli',
      exit_code: error.code, stdout: out.text, stderr: err.text, duration_ms: Date.now() - started,
      untrusted: true, source: { software, action: actionName } })
    return fail('INTERNAL', error.message)
  }
}
