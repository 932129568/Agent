/** 专家包：目录导入、内容寻址快照、启停、偏好与只读资源。绝不执行包内代码。 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { CONFIG_DIR, atomicWriteJson, readJsonIfExists } from '../paths.js'
import { importBuiltinExperts, METADATA_FIELDS } from './expert-builtin.js'

const REGISTRY = () => path.join(CONFIG_DIR, 'experts.json')
const ROOT = () => path.join(CONFIG_DIR, 'experts')
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const DIGEST_RE = /^[0-9a-f]{64}$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9][A-Za-z0-9.-]{0,31})?$/
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.csv', '.yaml', '.yml'])
const SECRETS = new Set(['.env', 'credentials.json', 'secrets.json', 'id_rsa', 'id_dsa'])
const DEFAULT_LIMITS = { maxPackageBytes: 33554432, maxFileBytes: 1048576, maxFiles: 512, maxDepth: 8,
  maxAgents: 64, maxSkills: 64, maxResources: 256, maxMetadataBytes: 65536, maxResourceBytes: 262144,
  maxPromptBytes: 262144, maxMembers: 12, memberCalls: 8, maxTurns: 40, maxActorTurns: 12,
  maxToolCalls: 120, mailboxMessages: 64, mailboxMessageBytes: 16384, mailboxBytes: 262144,
  runEvents: 1000, sessionEvents: 4000, eventRate: 20, runDeadlineSec: 1800,
  memberDeadlineSec: 480, mailboxWaitSec: 600, runTokens: 200000 }
const RANGES = { maxPackageBytes: [1048576, 33554432], maxFileBytes: [65536, 1048576], maxFiles: [16, 512],
  maxDepth: [2, 8], maxAgents: [1, 64], maxSkills: [0, 64], maxResources: [0, 256],
  maxMetadataBytes: [4096, 65536], maxResourceBytes: [4096, 262144],
  maxPromptBytes: [1024, 262144], maxMembers: [2, 12], memberCalls: [0, 8], maxTurns: [1, 40],
  maxActorTurns: [1, 12], maxToolCalls: [1, 120], mailboxMessages: [1, 64],
  mailboxMessageBytes: [1024, 16384], mailboxBytes: [16384, 262144],
  runEvents: [100, 1000], sessionEvents: [400, 4000], eventRate: [1, 20],
  runDeadlineSec: [60, 1800], memberDeadlineSec: [60, 480], mailboxWaitSec: [60, 600],
  runTokens: [1000, 200000] }
const json = value => JSON.stringify(value)
const fail = (code, message, extra = {}) => ({ ok: false, error: { code, message, ...extra } })
/** R69 授权修复：带细粒度 code 的导入拒绝异常，与 backend/domains/expert/validator.py 对齐。 */
class ExpertError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'ExpertError'
    this.code = code
    this.extra = extra
  }
}
const denied = (code, message, extra) => { throw new ExpertError(code, message, extra) }
const METADATA_PATHS = ['.codebuddy-plugin/plugin.json', '.workbuddy-plugin/plugin.json', 'plugin.json']
const MAX_METADATA_BYTES = 65536
const sha = data => crypto.createHash('sha256').update(data).digest('hex')
const empty = () => ({ schema_version: 1, packages: {}, preferences: { limits: { ...DEFAULT_LIMITS } } })
/** 最近一次 registry 载入的诊断（仅用于自省；绝不并入 config.json）。
 *  REGISTRY_CORRUPT_RECOVERED / REGISTRY_SCHEMA_UNSUPPORTED 与 validator/service.py 同款。 */
let registryWarning = null
let registryReadOnly = false
function recoverCorrupt(file) {
  registryWarning = 'REGISTRY_CORRUPT_RECOVERED'
  registryReadOnly = false
  // Python service.py::_backup_bad 同款：损坏文件改名保留，原文件绝不覆盖用户 config.json，
  // 异常一律静默（不阻塞业务）。
  try { fs.renameSync(file, `${file}.bad-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`) }
  catch { /* 备份失败不影响内存恢复 */ }
}
function registry() {
  const file = REGISTRY()
  let raw
  try { raw = fs.readFileSync(file, 'utf8') }
  catch (error) {
    if (error.code === 'ENOENT') { registryWarning = null; registryReadOnly = false; return empty() }
    recoverCorrupt(file); return empty()
  }
  let data
  try { data = JSON.parse(raw) }
  catch { recoverCorrupt(file); return empty() }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.schema_version !== 1) {
    // 未知 schema：只读恢复，不备份不覆盖原文件（Python REGISTRY_SCHEMA_UNSUPPORTED 同款）。
    registryWarning = 'REGISTRY_SCHEMA_UNSUPPORTED'; registryReadOnly = true; return empty()
  }
  if (!data.packages || typeof data.packages !== 'object' || Array.isArray(data.packages)) {
    recoverCorrupt(file); return empty()
  }
  registryWarning = null; registryReadOnly = false
  data.preferences ||= { limits: { ...DEFAULT_LIMITS } }
  data.preferences.limits = { ...DEFAULT_LIMITS, ...(data.preferences.limits || {}) }
  return data
}
function commit(data) { atomicWriteJson(REGISTRY(), data) }
/** 写注册表统一入口：只读拒绝 + 写失败回滚为结构化错误（异常静默不阻塞业务）。 */
function commitRegistry(data) {
  if (registryReadOnly) return fail('REGISTRY_SCHEMA_UNSUPPORTED', 'registry schema 不受支持，未覆盖原文件')
  try { commit(data); return null }
  catch { return fail('REGISTRY_WRITE_FAILED', 'registry 保存失败，原值未改变') }
}
function parse(value) { if (value && typeof value === 'object') return value; try { return JSON.parse(value || '{}') } catch { return null } }
function safeRel(value) {
  const rel = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
  if (!rel || rel.includes('\0') || rel.split('/').some(x => !x || x === '.' || x === '..')) denied('PATH_ESCAPE', '资源路径非法')
  return rel
}
/** R69 授权修复：区分 junction / reparse 属性（对齐 validator.py::_secure_lstat）。
 *  Windows 上 lstat 把 junction 也报成 symlink，故须先于 LINK_NOT_ALLOWED 判定：
 *  ① stat 携带 st_file_attributes / fileAttributes 的 FILE_ATTRIBUTE_REPARSE_POINT(0x400) 位
 *     （可由打桩注入，或未来 Node 暴露该字段）；
 *  ② 真实 junction：readlink 目标为绝对路径且 statSync 跟随为目录。
 *  平台非 win32 直接返回 false，不影响其它平台既有行为。 */
function isReparsePoint(full, stat) {
  if (process.platform !== 'win32') return false
  const REPARSE = 0x400
  const attrs = Number(stat.st_file_attributes ?? stat.fileAttributes ?? 0)
  if ((attrs & REPARSE) === REPARSE) return true
  if (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()) {
    try { if (path.isAbsolute(fs.readlinkSync(full)) && fs.statSync(full).isDirectory()) return true }
    catch { /* 目标不可读时按普通 symlink 处理 */ }
  }
  return false
}
function scan(root) {
  const records = {}; const folded = {}; let total = 0; let count = 0
  const realRoot = fs.realpathSync(root)
  function walk(dir, depth) {
    if (depth > 8) denied('DEPTH_TOO_LARGE', '专家包目录深度超过 8', { path: dir })
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const full = path.join(dir, entry.name); const stat = fs.lstatSync(full)
      const rel = path.relative(realRoot, full).split(path.sep).join('/')
      // NFC + case-fold 后冲突（对齐 validator.py::scan_package）
      const key = rel.normalize('NFC').toLowerCase()
      if (key in folded) denied('CASEFOLD_COLLISION', `路径在 NFC/case-fold 后冲突: ${rel}`,
        { path: rel, details: { other: folded[key] } })
      folded[key] = rel
      // R69 授权修复：junction/reparse 单独判定 → REPARSE_NOT_ALLOWED，不再统一按 LINK_NOT_ALLOWED。
      if (isReparsePoint(full, stat)) denied('REPARSE_NOT_ALLOWED', `专家包禁止 junction/reparse 路径: ${entry.name}`, { path: rel })
      if (stat.isSymbolicLink()) denied('LINK_NOT_ALLOWED', `专家包不允许符号链接: ${entry.name}`, { path: rel })
      if (entry.isDirectory()) { walk(full, depth + 1); continue }
      if (!stat.isFile()) denied('NOT_REGULAR_FILE', `包内只允许普通文件: ${entry.name}`, { path: rel })
      if (stat.nlink > 1) denied('HARDLINK_NOT_ALLOWED', `专家包禁止硬链接文件: ${entry.name}`, { path: rel })
      if (SECRETS.has(entry.name.toLowerCase())) denied('SECRET_FILE_NOT_ALLOWED', `专家包不允许包含凭证文件: ${entry.name}`, { path: rel })
      if (stat.size > 1048576) denied('FILE_TOO_LARGE', `单文件超过 1 MiB: ${entry.name}`, { path: rel })
      const data = fs.readFileSync(full); total += data.length; count++
      if (count > 512) denied('TOO_MANY_FILES', '专家包文件数超过 512', { path: rel })
      if (total > 33554432) denied('PACKAGE_TOO_LARGE', '专家包超过 32 MiB', { path: rel })
      records[rel] = { data, size: data.length, sha256: sha(data) }
    }
  }
  walk(realRoot, 0)
  return records
}
function digest(records) {
  const hash = crypto.createHash('sha256')
  for (const rel of Object.keys(records).sort()) { hash.update(rel, 'utf8'); hash.update(Buffer.from([0])); hash.update(records[rel].data) }
  return hash.digest('hex')
}
/** R69 授权修复：frontmatter 受限标量 / 一层嵌套 map 校验（对齐 Python frontmatter.py）。
 *  无 frontmatter 的 agent 保持既有宽松行为（experts.mjs 依赖）；有 frontmatter 时逐行校验：
 *  支持 bool/int/单双引号字符串/flow map/2 空格一层 map/| 块文本；拒绝 tab、4 空格深层缩进、
 *  嵌套 map、控制字符、未闭合引号。返回 { maxTurns } 供 AGENT_LIMIT_INTERSECTED 警告使用。 */
const FM_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
function fmScalar(raw, rel, line) {
  const v = raw.trim()
  if (!v) denied('EMPTY_VALUE', '字段值不能为空', { path: rel, line })
  for (const ch of v) if (ch.charCodeAt(0) < 32) denied('CONTROL_CHARACTER', '字段含控制字符', { path: rel, line })
  if (v === 'true' || v === 'false') return v === 'true'
  if (/^-?(?:0|[1-9][0-9]*)$/.test(v)) return parseInt(v, 10)
  if (v.startsWith('"')) {
    let parsed
    try { parsed = JSON.parse(v) } catch { denied('UNCLOSED_QUOTE', '双引号字符串非法', { path: rel, line }) }
    if (typeof parsed !== 'string') denied('INVALID_SCALAR', '字段必须是字符串', { path: rel, line })
    return parsed
  }
  if (v.startsWith("'")) {
    if (v.length < 2 || !v.endsWith("'")) denied('UNCLOSED_QUOTE', '单引号字符串非法', { path: rel, line })
    return v.slice(1, -1).replace(/''/g, "'")
  }
  if (v.startsWith('{')) {
    if (!v.endsWith('}')) denied('UNCLOSED_MAP', 'flow-map 未闭合', { path: rel, line })
    const inner = v.slice(1, -1).trim()
    if (!inner) return {}
    for (const item of inner.split(',')) {
      if (!item.includes(':')) denied('INVALID_MAP', 'flow-map 项缺少冒号', { path: rel, line })
      const child = item.slice(0, item.indexOf(':')).trim()
      if (!FM_KEY_RE.test(child)) denied('INVALID_MAP_KEY', 'flow-map 子键非法', { path: rel, line })
      if (item.slice(item.indexOf(':') + 1).trim().startsWith('{')) denied('NESTED_MAP', '只允许一层 map', { path: rel, line })
    }
    return {}
  }
  if (v.startsWith('[')) {
    try { JSON.parse(v) } catch { denied('INVALID_ARRAY', 'inline array 必须是合法 JSON', { path: rel, line }) }
    return []
  }
  if (v.includes('[]') || v.includes('{}') || v.includes(': ')) denied('INVALID_BARE_STRING', 'bare-string 含非法字符', { path: rel, line })
  return v
}
function validateFrontmatter(data, rel) {
  const text = data.toString('utf8')
  if (!text.startsWith('---')) return { maxTurns: null }
  const end = text.indexOf('\n---', 3)
  if (end === -1) denied('UNCLOSED_BLOCK', 'frontmatter 未闭合', { path: rel })
  const front = text.slice(4, end)
  const lines = front.split('\n')
  const seen = new Set()
  let maxTurns = null
  let i = 0
  while (i < lines.length) {
    const line = lines[i]; const number = i + 2
    if (!line.trim() || line.trimStart().startsWith('#')) { i += 1; continue }
    if (line.includes('\t')) denied('INVALID_INDENT', 'frontmatter 禁止 tab', { path: rel, line: number })
    if (line.length - line.trimStart().length > 0) denied('INVALID_INDENT', '顶层字段不能缩进', { path: rel, line: number })
    const colon = line.indexOf(':')
    if (colon === -1) denied('INVALID_ENTRY', '字段必须是 key: value', { path: rel, line: number })
    const key = line.slice(0, colon).trim()
    if (!FM_KEY_RE.test(key)) denied('INVALID_KEY', '字段名非法', { path: rel, line: number })
    if (seen.has(key)) denied('DUPLICATE_KEY', 'frontmatter 字段重复', { path: rel, line: number })
    seen.add(key)
    const raw = line.slice(colon + 1).trim()
    if (raw === '|' || raw === '|-') {
      i += 1
      while (i < lines.length) {
        const child = lines[i]
        if (child && !child.startsWith('  ')) break
        if (child.startsWith('    ')) denied('INVALID_INDENT', 'block 缩进非法', { path: rel, line: i + 2 })
        i += 1
      }
      continue
    }
    if (raw === '') {
      i += 1
      const children = new Set()
      while (i < lines.length) {
        const child = lines[i]
        if (child.trim() === '') { i += 1; continue }
        const ci = child.length - child.trimStart().length
        if (ci === 0) break
        if (ci !== 2) denied('INVALID_INDENT', '一层 map 必须使用两个空格缩进', { path: rel, line: i + 2 })
        const entry = child.slice(2)
        const cColon = entry.indexOf(':')
        if (cColon === -1) denied('INVALID_MAP', '一层 map 项缺少冒号', { path: rel, line: i + 2 })
        const ck = entry.slice(0, cColon).trim()
        if (!FM_KEY_RE.test(ck)) denied('INVALID_MAP_KEY', 'map 子键非法', { path: rel, line: i + 2 })
        if (children.has(ck)) denied('DUPLICATE_KEY', 'map 子键重复', { path: rel, line: i + 2 })
        children.add(ck)
        const cv = entry.slice(cColon + 1).trim()
        if (!cv) denied('NESTED_MAP', '只允许一层 map', { path: rel, line: i + 2 })
        fmScalar(cv, rel, i + 2)
        i += 1
      }
      continue
    }
    const value = fmScalar(raw, rel, number)
    if (key === 'maxTurns' && typeof value === 'number') maxTurns = value
    i += 1
  }
  return { maxTurns }
}

function manifestFor(records) {
  // R69 授权修复：三处 metadata 全部检查（大小上限 / 内容冲突 / 相同警告），
  // 不再只取第一份。对齐 backend/domains/expert/validator.py::_load_metadata。
  const present = METADATA_PATHS.filter(x => records[x])
  if (!present.length) denied('METADATA_NOT_FOUND', '未找到三种受支持位置的 plugin.json')
  const parsed = present.map(rel => {
    if (records[rel].size > MAX_METADATA_BYTES) {
      denied('METADATA_TOO_LARGE', `plugin.json 超过 64 KiB: ${rel}`, { path: rel })
    }
    try { return { rel, obj: JSON.parse(records[rel].data.toString('utf8')) } }
    catch { denied('INVALID_METADATA_JSON', `plugin.json 不是有效 JSON: ${rel}`, { path: rel }) }
  })
  const metaRel = parsed[0].rel
  const metadata = parsed[0].obj
  const warnings = []
  if (parsed.length > 1) {
    const fields = [...new Set(parsed.flatMap(p => Object.keys(p.obj || {})))].sort()
    const conflicts = []
    for (const field of fields) {
      const first = JSON.stringify(metadata?.[field])
      if (parsed.some(p => JSON.stringify(p.obj?.[field]) !== first)) {
        conflicts.push({ field, path: parsed.find(p => JSON.stringify(p.obj?.[field]) !== first)?.rel })
      }
    }
    if (conflicts.length) denied('METADATA_CONFLICT', '多份 plugin.json 元数据冲突',
      { path: metaRel, details: conflicts })
    warnings.push('MULTIPLE_METADATA_IDENTICAL')
  }
  // R69 授权修复：用户导入严格字段白名单（对齐 validator.py::_load_metadata）。
  // 内置包经 expert-builtin.js::sanitizeMetadata 已剥成白名单子集，故不受影响。
  const metaObj = (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) ? metadata : {}
  const unknown = Object.keys(metaObj).filter(k => !METADATA_FIELDS.has(k) && !k.startsWith('x-harbor-'))
  if (unknown.length) denied('METADATA_FIELD_UNKNOWN', 'plugin.json 含未知核心字段',
    { path: metaRel, field: unknown[0] })
  const packageId = String(metadata.name || '').toLowerCase()
  if (!ID_RE.test(packageId)) throw new Error('专家包 name 非法')
  if (!VERSION_RE.test(String(metadata.version || ''))) throw new Error('专家包 version 必须是 semver')
  // agents 解析（validator._agent_paths：声明为文件或目录前缀 → 直接 .md 扫描，排序去重）
  const declared = metadata.agents === undefined ? './agents/' : metadata.agents
  const declaredItems = typeof declared === 'string' ? [declared] : declared
  if (!Array.isArray(declaredItems)) throw new Error('agents 必须是目录字符串或文件数组')
  const selected = []
  for (const item of declaredItems) {
    let rel = String(item).replace(/\\/g, '/').replace(/^\.\//, '')
    if (rel.includes('..') || rel.startsWith('/')) denied('PATH_ESCAPE', '声明的 agents 路径越界', { path: rel })
    if (records[rel] && rel.endsWith('.md')) { selected.push(rel); continue }
    const prefix = rel.replace(/\/$/, '') + '/'
    for (const key of Object.keys(records)) {
      if (key.startsWith(prefix) && key.endsWith('.md') && !key.slice(prefix.length).includes('/')) selected.push(key)
    }
  }
  const agents = [...new Set(selected)].sort()
  if (!agents.length) throw new Error('未找到任何 Agent Markdown')
  const skills = (typeof metadata.skills === 'string' ? [metadata.skills] : (metadata.skills || []))
    .map(x => String(x).replace(/^\.\//, '').replace(/\/$/, ''))
  for (const rel of agents) if (!records[rel]) throw new Error(`声明的 agent 不存在: ${rel}`)
  if (agents.length > 64 || skills.length > 64) throw new Error('agents/skills 数量超限')
  // AGENT_LIMIT_INTERSECTED 警告（validator.py:238-239：maxTurns > maxActorTurns）
  for (const rel of agents) {
    const { maxTurns } = validateFrontmatter(records[rel].data, rel)
    if (maxTurns !== null && maxTurns > DEFAULT_LIMITS.maxActorTurns) warnings.push(`AGENT_LIMIT_INTERSECTED:${rel}`)
  }
  const resources = Object.keys(records).filter(rel => TEXT_EXT.has(path.extname(rel).toLowerCase()) && !METADATA_PATHS.includes(rel))
  return { schema_version: 1, package_id: packageId, kind: metadata.expertType === 'team' ? 'team' : 'agent',
    version: String(metadata.version), metadata, agents, team: metadata.teamInfo || null, skills, resources,
    scripts: [], limits: { ...DEFAULT_LIMITS }, validation: { valid: true, warnings },
    readable_paths: [...new Set([...resources, ...agents])].sort(), metadata_path: metaRel }
}

export async function expertImportDirectory(directory, sourceKind = 'directory') {
  try {
    if (sourceKind !== 'directory' && sourceKind !== 'builtin') {
      return json(fail('INVALID_IMPORT_SOURCE', '导入来源只允许 directory/builtin'))
    }
    const source = String(directory || '').trim()
    // P0-1c E2：目录不可读类 → PATH_UNAVAILABLE + 绝对路径 + 稳定类名映射（Python 口径）
    if (!source) return json(fail('PATH_UNAVAILABLE', '路径无法读取', { path: '', details: 'FileNotFoundError' }))
    let stat
    try { stat = fs.statSync(source) } catch (error) {
      const kindName = error.code === 'ENOENT' ? 'FileNotFoundError'
        : error.code === 'EACCES' || error.code === 'EPERM' ? 'PermissionError' : 'OSError'
      return json(fail('PATH_UNAVAILABLE', '路径无法读取', { path: path.resolve(source), details: kindName }))
    }
    if (!stat.isDirectory()) return json(fail('PATH_UNAVAILABLE', '路径无法读取', { path: path.resolve(source), details: 'NotADirectoryError' }))
    const records = scan(source); const manifest = manifestFor(records); const snapshotId = digest(records)
    const warnings = manifest.validation.warnings
    const finalDir = path.join(ROOT(), 'snapshots', manifest.package_id, snapshotId)
    const staging = path.join(ROOT(), 'staging', `${process.pid}-${crypto.randomUUID()}`)
    await fsp.mkdir(staging, { recursive: true })
    try {
      for (const rel of Object.keys(records).sort()) {
        const target = path.join(staging, ...rel.split('/')); await fsp.mkdir(path.dirname(target), { recursive: true })
        await fsp.writeFile(target, records[rel].data, { flag: 'wx', mode: 0o600 })
      }
      const stored = { ...manifest, snapshot_id: snapshotId,
        files: Object.keys(records).sort().map(rel => ({ path: rel, size: records[rel].size, sha256: records[rel].sha256 })) }
      atomicWriteJson(path.join(staging, '.harbor-snapshot.json'), stored)
      if (!fs.existsSync(finalDir)) { await fsp.mkdir(path.dirname(finalDir), { recursive: true }); await fsp.rename(staging, finalDir) }
      else await fsp.rm(staging, { recursive: true, force: true })
      const data = registry(); const record = data.packages[manifest.package_id] ||= { enabled: false, active_snapshot: '', snapshots: [] }
      if (!record.snapshots.some(x => x.digest === snapshotId)) record.snapshots.push({ digest: snapshotId,
        version: manifest.version, kind: manifest.kind, name: manifest.package_id, registered_at: new Date().toISOString(),
        source: { kind: sourceKind, name: sourceKind === 'builtin' ? manifest.package_id : path.basename(source) },
        warnings, valid: true })
      const writeError = commitRegistry(data)
      if (writeError) return json(writeError)
      return json({ ok: true, package_id: manifest.package_id, snapshot_id: snapshotId, version: manifest.version, activated: false, warnings })
    } catch (error) { await fsp.rm(staging, { recursive: true, force: true }).catch(() => {}); throw error }
  } catch (error) {
    // R69 授权修复：带 code 的校验异常 → Python 同款细粒度错误码；
    // 未知异常仍保留 EXPERT_IMPORT_INVALID 兜底，返回形状不变。
    if (error instanceof ExpertError) return json(fail(error.code, error.message, error.extra))
    return json(fail('EXPERT_IMPORT_INVALID', error.message))
  }
}

/** 内置专家包导入（P0-1c E1）：容器构造期一次（Python container.py:120-127 同构）。
 * once 标志防重复；失败 warning 不中断 registry 初始化。 */
let builtinReady = false
let builtinOnce = null
export async function ensureBuiltinExperts() {
  if (builtinReady) return
  builtinReady = true
  try { await importBuiltinExperts(expertImportDirectory) }
  catch { /* registry 初始化不因 builtin 失败而崩溃（Python 同口径） */ }
}
/** R59 性能：顶层 `await ensureBuiltinExperts()`（实测 397ms 启动开销）改为
 * 首个 registry 读取入口按需单飞——并发调用共享同一 promise，builtin 失败
 * 不中断调用方（同上口径）。 */
function builtinOnceRun() {
  if (!builtinOnce) builtinOnce = ensureBuiltinExperts()
  return builtinOnce
}
export async function expertList(query = '') {
  await builtinOnceRun()
  const q = String(query || '').toLowerCase(); const packages = []
  for (const [id, record] of Object.entries(registry().packages).sort(([a], [b]) => a.localeCompare(b))) {
    const snapshots = record.snapshots || []; if (!snapshots.length) continue
    const active = snapshots.find(x => x.digest === record.active_snapshot) || snapshots.at(-1)
    if (q && !id.toLowerCase().includes(q) && !String(active.name || '').toLowerCase().includes(q)) continue
    packages.push({ id, kind: active.kind || 'agent', name: active.name || id, version: active.version,
      enabled: !!record.enabled, valid: active.valid !== false, active_snapshot: record.active_snapshot || '',
      source: active.source || {}, warnings: active.warnings || [] })
  }
  const result = { ok: true, packages }
  // 仅在损坏/未知 schema 恢复时附加诊断字段；正常返回形状逐字节不变。
  if (registryWarning) result.registry_warning = registryWarning
  return json(result)
}
function selected(packageId, snapshotId = '') {
  if (!ID_RE.test(String(packageId))) throw new Error('package ID 非法')
  const record = registry().packages[packageId]
  if (!record || !(record.snapshots || []).length) throw new Error('专家包不存在')
  const snapshot = snapshotId ? record.snapshots.find(x => x.digest === snapshotId) :
    (record.snapshots.find(x => x.digest === record.active_snapshot) || record.snapshots.at(-1))
  if (!snapshot) throw new Error('指定 snapshot 未注册')
  return { record, snapshot }
}
function loadSnapshot(packageId, snapshotId) {
  if (!DIGEST_RE.test(String(snapshotId))) throw new Error('snapshot ID 非法')
  const dir = path.join(ROOT(), 'snapshots', packageId, snapshotId)
  const manifest = readJsonIfExists(path.join(dir, '.harbor-snapshot.json'), null)
  if (!manifest || manifest.snapshot_id !== snapshotId) throw new Error('snapshot manifest 非法')
  return { dir, manifest }
}
export async function expertGet(packageId, snapshotId = '') {
  await builtinOnceRun()
  try {
    const { snapshot } = selected(packageId, snapshotId); const { manifest } = loadSnapshot(packageId, snapshot.digest)
    return json({ ok: true, package: { id: packageId, snapshot_id: snapshot.digest, kind: manifest.kind,
      version: manifest.version, metadata: manifest.metadata, agents: manifest.agents, team: manifest.team,
      skills: manifest.skills, resources: manifest.resources, scripts: manifest.scripts || [], limits: manifest.limits, validation: manifest.validation } })
  } catch (error) { return json(fail('PACKAGE_NOT_FOUND', error.message)) }
}
export async function expertSetEnabled(packageId, enabled, snapshotId = '') {
  try {
    if (typeof enabled !== 'boolean') return json(fail('INVALID_ENABLED', 'enabled 必须是 boolean'))
    selected(packageId, snapshotId); const data = registry(); const record = data.packages[packageId]
    record.enabled = enabled
    if (enabled) record.active_snapshot = snapshotId || record.active_snapshot || record.snapshots.at(-1).digest
    const writeError = commitRegistry(data)
    if (writeError) return json(writeError)
    return json({ ok: true, package_id: packageId, enabled, active_snapshot: record.active_snapshot || '' })
  } catch (error) { return json(fail('PACKAGE_NOT_FOUND', error.message)) }
}
export async function expertReadResource(snapshotId, relative) {
  try {
    // P0-1c E3：非法 snapshot id → INVALID_SNAPSHOT_ID（分类对齐 Python；无 path 键）
    if (!DIGEST_RE.test(String(snapshotId))) return json(fail('INVALID_SNAPSHOT_ID', 'snapshot ID 非法'))
    const base = path.join(ROOT(), 'snapshots'); let found
    for (const id of fs.existsSync(base) ? fs.readdirSync(base) : []) {
      const candidate = path.join(base, id, snapshotId); if (fs.existsSync(candidate)) { found = loadSnapshot(id, snapshotId); break }
    }
    if (!found) throw new Error('snapshot 不存在')
    const rel = safeRel(relative)
    if (!found.manifest.readable_paths.includes(rel)) throw new Error('资源不在只读白名单')
    const file = path.join(found.dir, ...rel.split('/')); const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 262144) throw new Error('资源必须是普通非硬链接文件且不超过 256 KiB')
    const data = fs.readFileSync(file); const expected = found.manifest.files.find(x => x.path === rel)
    if (!expected || sha(data) !== expected.sha256) throw new Error('资源 hash 与 snapshot manifest 不一致')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data)
    return json({ ok: true, path: rel, sha256: sha(data), text, truncated: false,
      provenance: { packageId: found.manifest.package_id, snapshotId, path: rel, sha256: sha(data), source: { kind: 'managed_snapshot' } } })
  } catch (error) { return json(fail('RESOURCE_NOT_READABLE', error.message, { path: String(relative || '') })) }
}
export async function expertSavePreferences(prefsJson) {
  const prefs = parse(prefsJson)
  if (!prefs || Array.isArray(prefs)) return json(fail('INVALID_PREFERENCES', '偏好必须是 JSON 对象'))
  const incoming = prefs.limits || prefs; const data = registry(); const current = data.preferences.limits
  for (const [key, value] of Object.entries(incoming)) {
    const range = RANGES[key]
    if (!range) return json(fail('INVALID_PREFERENCES', '未知 limits 字段', { field: key }))
    if (!Number.isInteger(value) || value < range[0] || value > range[1]) return json(fail('INVALID_PREFERENCES', 'limits 超出允许范围', { field: key, details: { min: range[0], max: range[1] } }))
    if (value > (current[key] ?? range[1])) return json(fail('PREFERENCES_NOT_STRICTER', '偏好只能更严格，不能放大限额', { field: key }))
    current[key] = value
  }
  const writeError = commitRegistry(data)
  if (writeError) return json(writeError)
  return json({ ok: true, limits: current })
}
export async function expertDeletePackage(packageId) {
  try {
    selected(packageId); const data = registry(); delete data.packages[packageId]
    const writeError = commitRegistry(data)
    if (writeError) return json(writeError)
    return json({ ok: true, package_id: packageId, deleted: true })
  } catch (error) { return json(fail('PACKAGE_NOT_FOUND', error.message)) }
}
