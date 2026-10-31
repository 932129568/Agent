/** 专家包：目录导入、内容寻址快照、启停、偏好与只读资源。绝不执行包内代码。 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { CONFIG_DIR, atomicWriteJson, readJsonIfExists } from '../paths.js'

const REGISTRY = () => path.join(CONFIG_DIR, 'experts.json')
const ROOT = () => path.join(CONFIG_DIR, 'experts')
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const DIGEST_RE = /^[0-9a-f]{64}$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9][A-Za-z0-9.-]{0,31})?$/
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.csv', '.yaml', '.yml'])
const SECRETS = new Set(['.env', 'credentials.json', 'secrets.json', 'id_rsa', 'id_dsa'])
const DEFAULT_LIMITS = { maxPackageBytes: 33554432, maxFileBytes: 1048576, maxFiles: 512, maxDepth: 8,
  maxAgents: 64, maxSkills: 64, maxResources: 256, maxResourceBytes: 262144, maxPromptBytes: 262144,
  maxMembers: 12, memberCalls: 8, maxTurns: 40, maxActorTurns: 12, maxToolCalls: 120, runTokens: 200000 }
const RANGES = { maxPackageBytes: [1048576, 33554432], maxFileBytes: [65536, 1048576], maxFiles: [16, 512],
  maxDepth: [2, 8], maxAgents: [1, 64], maxSkills: [0, 64], maxResources: [0, 256], maxResourceBytes: [4096, 262144],
  maxPromptBytes: [1024, 262144], maxMembers: [2, 12], memberCalls: [0, 8], maxTurns: [1, 40],
  maxActorTurns: [1, 12], maxToolCalls: [1, 120], runTokens: [1000, 200000] }
const json = value => JSON.stringify(value)
const fail = (code, message, extra = {}) => ({ ok: false, error: { code, message, ...extra } })
const sha = data => crypto.createHash('sha256').update(data).digest('hex')
const empty = () => ({ schema_version: 1, packages: {}, preferences: { limits: { ...DEFAULT_LIMITS } } })
function registry() {
  const data = readJsonIfExists(REGISTRY(), null)
  if (!data || data.schema_version !== 1 || !data.packages || typeof data.packages !== 'object') return empty()
  data.preferences ||= { limits: { ...DEFAULT_LIMITS } }
  data.preferences.limits = { ...DEFAULT_LIMITS, ...(data.preferences.limits || {}) }
  return data
}
function commit(data) { atomicWriteJson(REGISTRY(), data) }
function parse(value) { if (value && typeof value === 'object') return value; try { return JSON.parse(value || '{}') } catch { return null } }
function safeRel(value) {
  const rel = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
  if (!rel || rel.includes('\0') || rel.split('/').some(x => !x || x === '.' || x === '..')) throw new Error('资源路径非法')
  return rel
}
function scan(root) {
  const records = {}; let total = 0; let count = 0
  const realRoot = fs.realpathSync(root)
  function walk(dir, depth) {
    if (depth > 8) throw new Error('专家包目录深度超过 8')
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const full = path.join(dir, entry.name); const stat = fs.lstatSync(full)
      if (stat.isSymbolicLink()) throw new Error(`专家包不允许符号链接: ${entry.name}`)
      if (entry.isDirectory()) { walk(full, depth + 1); continue }
      if (!stat.isFile() || stat.nlink > 1) throw new Error(`专家包文件必须是普通非硬链接文件: ${entry.name}`)
      if (SECRETS.has(entry.name.toLowerCase())) throw new Error(`专家包不允许包含凭证文件: ${entry.name}`)
      if (stat.size > 1048576) throw new Error(`单文件超过 1 MiB: ${entry.name}`)
      const rel = path.relative(realRoot, full).split(path.sep).join('/')
      const data = fs.readFileSync(full); total += data.length; count++
      if (count > 512) throw new Error('专家包文件数超过 512')
      if (total > 33554432) throw new Error('专家包超过 32 MiB')
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
function manifestFor(records) {
  const metaRel = ['.codebuddy-plugin/plugin.json', '.workbuddy-plugin/plugin.json', 'plugin.json'].find(x => records[x])
  if (!metaRel) throw new Error('缺少 .codebuddy-plugin/plugin.json（或兼容路径）')
  let metadata
  try { metadata = JSON.parse(records[metaRel].data.toString('utf8')) } catch { throw new Error('plugin.json 不是有效 JSON') }
  const packageId = String(metadata.name || '').toLowerCase()
  if (!ID_RE.test(packageId)) throw new Error('专家包 name 非法')
  if (!VERSION_RE.test(String(metadata.version || ''))) throw new Error('专家包 version 必须是 semver')
  const agents = (metadata.agents || []).map(x => String(x).replace(/^\.\//, ''))
  const skills = (metadata.skills || []).map(x => String(x).replace(/^\.\//, '').replace(/\/$/, ''))
  for (const rel of agents) if (!records[rel]) throw new Error(`声明的 agent 不存在: ${rel}`)
  if (agents.length > 64 || skills.length > 64) throw new Error('agents/skills 数量超限')
  const resources = Object.keys(records).filter(rel => TEXT_EXT.has(path.extname(rel).toLowerCase()) && rel !== metaRel)
  return { schema_version: 1, package_id: packageId, kind: metadata.expertType === 'team' ? 'team' : 'agent',
    version: String(metadata.version), metadata, agents, team: metadata.teamInfo || null, skills, resources,
    scripts: [], limits: { ...DEFAULT_LIMITS }, validation: { valid: true, warnings: [] },
    readable_paths: resources, metadata_path: metaRel }
}

export async function expertImportDirectory(directory) {
  try {
    const source = String(directory || '').trim()
    if (!source || !fs.statSync(source).isDirectory()) return json(fail('INVALID_IMPORT_SOURCE', '导入路径必须是已存在目录'))
    const records = scan(source); const manifest = manifestFor(records); const snapshotId = digest(records)
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
        source: { kind: 'directory', name: path.basename(source) }, warnings: [], valid: true })
      commit(data)
      return json({ ok: true, package_id: manifest.package_id, snapshot_id: snapshotId, version: manifest.version, activated: false, warnings: [] })
    } catch (error) { await fsp.rm(staging, { recursive: true, force: true }).catch(() => {}); throw error }
  } catch (error) { return json(fail('EXPERT_IMPORT_INVALID', error.message)) }
}
export async function expertList(query = '') {
  const q = String(query || '').toLowerCase(); const packages = []
  for (const [id, record] of Object.entries(registry().packages).sort(([a], [b]) => a.localeCompare(b))) {
    const snapshots = record.snapshots || []; if (!snapshots.length) continue
    const active = snapshots.find(x => x.digest === record.active_snapshot) || snapshots.at(-1)
    if (q && !id.toLowerCase().includes(q) && !String(active.name || '').toLowerCase().includes(q)) continue
    packages.push({ id, kind: active.kind || 'agent', name: active.name || id, version: active.version,
      enabled: !!record.enabled, valid: active.valid !== false, active_snapshot: record.active_snapshot || '',
      source: active.source || {}, warnings: active.warnings || [] })
  }
  return json({ ok: true, packages })
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
    commit(data); return json({ ok: true, package_id: packageId, enabled, active_snapshot: record.active_snapshot || '' })
  } catch (error) { return json(fail('PACKAGE_NOT_FOUND', error.message)) }
}
export async function expertReadResource(snapshotId, relative) {
  try {
    if (!DIGEST_RE.test(String(snapshotId))) throw new Error('snapshot ID 非法')
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
  commit(data); return json({ ok: true, limits: current })
}
export async function expertDeletePackage(packageId) {
  try {
    selected(packageId); const data = registry(); delete data.packages[packageId]; commit(data)
    return json({ ok: true, package_id: packageId, deleted: true })
  } catch (error) { return json(fail('PACKAGE_NOT_FOUND', error.message)) }
}
