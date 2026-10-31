/** WebDAV 数据主权：连通性、备份导出、三方冲突恢复。零第三方 WebDAV 依赖。 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { CONFIG_DIR, ensureDir, atomicWriteJson, readJsonIfExists } from '../paths.js'
import { ENC_PREFIX, W17_WARNING, encryptValue, decryptValue } from './dpapi.js'

const SCOPE = ['config.json', 'sessions.json', 'audit_log.jsonl']
const POLICIES = new Set(['ask', 'local_wins', 'remote_wins', 'keep_both'])
const MAX_BYTES = 256 * 1024 * 1024
const WEBDAV_CONFIG_KEYS = ['url', 'username', 'password', 'remote_path', 'auto_sync', 'conflict_policy']
const json = value => JSON.stringify(value)
const sha = data => crypto.createHash('sha256').update(data).digest('hex')
const fileSha = file => { try { return sha(fs.readFileSync(file)) } catch { return '' } }

function parse(value) {
  if (value && typeof value === 'object') return value
  try { return JSON.parse(value || '{}') } catch { return null }
}

/** P0-1c WD1：webdav_get_config（webdav_service.get_config:612-629 同构）——
 * 无文件 → {ok, config:null}；有文件 → 键白名单视图。
 * P0-2 T03：password 经 dpapi 解密返回明文（get_config 解密口径）；解密失败
 * （换机/换用户，结果仍为标记串）→ 置 ''（Python 同款），不落密文到前端。 */
export async function webdavGetConfig() {
  const file = path.join(CONFIG_DIR, 'webdav.json')
  if (!fs.existsSync(file)) return json({ ok: true, config: null })
  let data
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    return json({ ok: false, error: `webdav.json 读取失败: ${error.message}` })
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return json({ ok: false, error: 'webdav.json 结构异常' })
  }
  const config = {}
  for (const key of WEBDAV_CONFIG_KEYS) {
    if (Object.hasOwn(data, key)) config[key] = data[key]
  }
  if (typeof config.password === 'string' && config.password) {
    const dec = await decryptValue(config.password)
    config.password = dec && !dec.startsWith(ENC_PREFIX) ? dec : ''
  }
  return json({ ok: true, config })
}

/** P0-1c WD1：webdav_save_config（webdav_service.save_config:631-657 同构）——
 * 校验（密码必填）→ 原子写 → {ok, config(无 password)}。校验失败不落盘
 * （未配置态文件不存在的语义由此保持）。
 * P0-2 T03：password 经 dpapi 加密落盘（CurrentUser 域）；DPAPI 不可用 →
 * 明文兜底 + W17 warning（与 Python 逐字一致，非静默）。 */
export async function webdavSaveConfig(cfgJson) {
  let cfg
  try {
    cfg = JSON.parse(String(cfgJson ?? '{}'))
  } catch (error) {
    return json({ ok: false, error: `配置解析失败: ${error.message}` })
  }
  const { record, error } = validateConfig(cfg)
  if (error) return json({ ok: false, error })
  // DPAPI 字段级加密（不可用则明文兜底——Python encrypt_value 同语义）
  const encrypted = await encryptValue(record.password)
  ensureDir(CONFIG_DIR)
  try {
    atomicWriteJson(path.join(CONFIG_DIR, 'webdav.json'), { ...record, password: encrypted })
  } catch (writeError) {
    return json({ ok: false, error: `webdav.json 写入失败: ${writeError.message}` })
  }
  const { password, ...safeRecord } = record
  const out = { ok: true, config: safeRecord }
  // W17：加密未产出标记（DPAPI 不可用/失败）→ 明文落盘须用户可见（Python 同款）
  if (typeof encrypted !== 'string' || !encrypted.startsWith(ENC_PREFIX)) out.warning = W17_WARNING
  return json(out)
}
export function validateConfig(input) {
  const cfg = parse(input)
  if (!cfg || Array.isArray(cfg)) return { error: 'WebDAV 配置必须是 JSON 对象' }
  let url
  try { url = new URL(String(cfg.url || '').trim()) } catch { return { error: 'WebDAV 地址需要 http:// 或 https:// 开头' } }
  if (!['http:', 'https:'].includes(url.protocol)) return { error: 'WebDAV 地址需要 http:// 或 https:// 开头' }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    return { error: 'WebDAV 必须使用 https://（凭证明文出网风险；localhost 除外）' }
  }
  if (url.username || url.password || String(cfg.url).includes('@')) return { error: '地址内不允许内嵌凭证（user:pass@host），请分开填写账号密码' }
  const username = String(cfg.username || '').trim(); const password = String(cfg.password || '')
  if (!username) return { error: '缺少 WebDAV 账号' }
  if (!password) return { error: '缺少 WebDAV 密码' }
  const segments = String(cfg.remote_path || '/glm-chat-backup').split('/').filter(x => x && x !== '.')
  if (segments.some(x => x === '..' || x.includes('\\') || x.includes('%') || x.replace(/%2e/gi, '.').includes('..'))) {
    return { error: '远端目录不允许包含 ".."、反斜杠或百分号编码（路径穿越风险）' }
  }
  const conflictPolicy = String(cfg.conflict_policy || 'ask').toLowerCase()
  if (!POLICIES.has(conflictPolicy)) return { error: 'conflict_policy 仅支持 ask/local_wins/remote_wins/keep_both' }
  url.pathname = url.pathname.replace(/\/$/, '')
  return { record: { url: url.toString().replace(/\/$/, ''), username, password,
    remote_path: `/${segments.join('/')}`, auto_sync: !!cfg.auto_sync, conflict_policy: conflictPolicy } }
}
async function storedRecord() {
  const cfg = readJsonIfExists(path.join(CONFIG_DIR, 'webdav.json'), null)
  if (!cfg) return { error: '未配置 WebDAV（设置 → 数据与备份）' }
  // P0-2 T03：IO 前解密（Python _record_for_io 经 get_config 解密同口径）——
  // 密文绝不当 Basic Auth 密码下发
  if (typeof cfg.password === 'string' && cfg.password) {
    const dec = await decryptValue(cfg.password)
    cfg.password = dec && !dec.startsWith(ENC_PREFIX) ? dec : ''
  }
  return validateConfig(cfg)
}
function endpoint(record, rel = '') {
  const base = new URL(record.url)
  base.pathname = `${base.pathname.replace(/\/$/, '')}${record.remote_path.replace(/\/$/, '')}/${String(rel).replace(/^\//, '')}`
  return base
}
async function bodyWithin(response, cap = 65536) {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader(); const chunks = []; let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > cap) { await reader.cancel(); throw new Error(`响应超过 ${Math.floor(cap / 1048576)} MB 上限`) }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}
async function dav(record, method, rel = '', body, headers = {}, timeout = 30000, cap = 65536) {
  const auth = Buffer.from(`${record.username}:${record.password}`, 'utf8').toString('base64')
  const response = await fetch(endpoint(record, rel), { method, body, redirect: 'error',
    headers: { Authorization: `Basic ${auth}`, Accept: '*/*', ...headers }, signal: AbortSignal.timeout(timeout) })
  if (response.status >= 300 && response.status < 400) throw new Error('服务端返回重定向（已按安全口径拒绝）')
  const data = await bodyWithin(response, cap)
  return { status: response.status, headers: response.headers, data }
}
function davError(status, data) {
  const detail = Buffer.from(data || '').toString('utf8').slice(0, 150).trim()
  const text = ({ 401: '认证失败（401）：请检查 WebDAV 账号密码', 403: '无权访问（403）',
    404: '路径不存在（404）', 405: '方法不被允许（405）', 409: '冲突（409）：父目录不存在', 507: '服务端存储不足（507）' })[status] || `HTTP ${status}`
  return text + (detail ? `：${detail}` : '')
}
async function plan() {
  const out = []
  for (const rel of SCOPE) {
    const file = path.join(CONFIG_DIR, rel)
    if (!fs.existsSync(file)) out.push({ path: rel, missing: true })
    else {
      const stat = await fsp.stat(file)
      if (stat.size > MAX_BYTES) throw new Error(`${rel} 超过 256 MB 上限，备份已中止`)
      out.push({ path: rel, sha256: fileSha(file), bytes: stat.size })
    }
  }
  return out
}
export async function webdavTest(cfgJson = '{}') {
  const parsed = parse(cfgJson); const result = parsed && parsed.url ? validateConfig(parsed) : await storedRecord()
  if (result.error) return json({ ok: false, error: result.error })
  try {
    const options = await dav(result.record, 'OPTIONS', '', undefined, {}, 15000)
    if (options.status >= 400) return json({ ok: false, error: davError(options.status, options.data) })
    const probe = await dav(result.record, 'PROPFIND', '', '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
      { Depth: '0', 'Content-Type': 'application/xml' }, 20000)
    if (![200, 207, 404].includes(probe.status)) return json({ ok: false, error: davError(probe.status, probe.data) })
    const capability = options.headers.get('dav') || 'unknown'
    return json({ ok: true, dav_capability: capability, detail: `连接成功（DAV 能力：${capability}）` })
  } catch (error) { return json({ ok: false, error: `连接测试失败: ${error.message}` }) }
}
export async function webdavExport() {
  const { record, error } = await storedRecord()
  const items = await plan().catch(e => [{ error: e.message }])
  if (error) return json({ ok: false, error, plan: items })
  if (items.some(x => x.error)) return json({ ok: false, error: items[0].error })
  const uploaded = []
  try {
    const mkcol = await dav(record, 'MKCOL')
    if (![200, 201, 204, 405, 409].includes(mkcol.status)) return json({ ok: false, error: `远端目录创建失败: ${davError(mkcol.status, mkcol.data)}` })
    for (const item of items.filter(x => !x.missing)) {
      const response = await dav(record, 'PUT', item.path, await fsp.readFile(path.join(CONFIG_DIR, item.path)),
        { 'Content-Type': 'application/octet-stream' }, 120000)
      if (![200, 201, 204].includes(response.status)) return json({ ok: false, error: `上传 ${item.path} 失败: ${davError(response.status, response.data)}`, uploaded })
      uploaded.push(item.path)
    }
    const manifest = { version: 1, created_at: new Date().toISOString(), items: items.filter(x => !x.missing) }
    const response = await dav(record, 'PUT', 'manifest.json', JSON.stringify(manifest, null, 1), { 'Content-Type': 'application/json' }, 60000)
    if (![200, 201, 204].includes(response.status)) return json({ ok: false, error: `manifest 上传失败: ${davError(response.status, response.data)}`, uploaded })
    return json({ ok: true, uploaded, manifest })
  } catch (error) { return json({ ok: false, error: `WebDAV 备份失败: ${error.message}`, uploaded }) }
}
function classify(local, remote, baseline) {
  const out = { unchanged: [], only_local: [], only_remote: [], conflicts: [] }
  for (const p of [...new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(baseline)])].sort()) {
    const l = local[p] || ''; const r = remote[p] || ''; const b = baseline[p] || ''
    if (l === r) out.unchanged.push(p)
    else if (l !== b && r === b) out.only_local.push(p)
    else if (r !== b && l === b) out.only_remote.push(p)
    else out.conflicts.push({ path: p, local_sha: l, remote_sha: r, baseline_sha: b })
  }
  return out
}
export async function webdavRestore(payloadJson) {
  const { record, error } = await storedRecord()
  if (error) {
    // P0-1c WD2（webdav_service.restore:700-709）：未配置时 manifest 校验仍执行
    // （UI 预览），返回 {ok:false, error, manifest}——payload '{}' 解析为 {} 而非 null
    let manifest = null
    if (payloadJson) {
      try { manifest = JSON.parse(String(payloadJson)) } catch (parseError) {
        return json({ ok: false, error: `manifest 解析失败: ${parseError.message}` })
      }
    }
    return json({ ok: false, error, manifest })
  }
  const baseline = parse(payloadJson || '{}')
  if (!baseline || !Array.isArray(baseline.items)) return json({ ok: false, error: 'manifest 结构异常（缺 items 数组）' })
  if (baseline.items.some(x => !x || !x.path || !x.sha256)) return json({ ok: false, error: 'manifest items 每项需含 path 与 sha256' })
  try {
    const downloaded = {}; const localSha = {}; const remoteSha = {}; const baselineSha = {}
    for (const item of baseline.items) {
      const rel = String(item.path)
      if (!SCOPE.includes(rel)) continue
      const response = await dav(record, 'GET', rel, undefined, {}, 120000, MAX_BYTES)
      if (response.status !== 200) return json({ ok: false, error: `下载 ${rel} 失败: ${davError(response.status, response.data)}` })
      downloaded[rel] = response.data; remoteSha[rel] = sha(response.data)
      localSha[rel] = fileSha(path.join(CONFIG_DIR, rel)); baselineSha[rel] = item.sha256
    }
    const verdict = classify(localSha, remoteSha, baselineSha); const policy = record.conflict_policy || 'ask'
    const restorePlan = [
      ...verdict.only_local.map(p => ({ path: p, action: 'keep_local' })),
      ...verdict.only_remote.map(p => ({ path: p, action: 'download' })),
      ...verdict.conflicts.map(x => ({ path: x.path, action: policy === 'remote_wins' ? 'download' : policy === 'keep_both' ? 'keep_both' : policy === 'local_wins' ? 'keep_local' : 'ask' })),
    ]
    if (policy === 'ask' && verdict.conflicts.length) return json({ ok: false, need_decision: true, conflicts: verdict.conflicts, plan: restorePlan, error: `检测到 ${verdict.conflicts.length} 个冲突文件，需用户选择合并策略` })
    const applied = []; const kept = []
    for (const item of restorePlan) {
      if (item.action === 'download') {
        const target = path.join(CONFIG_DIR, item.path); ensureDir(path.dirname(target))
        const tmp = `${target}.${process.pid}.restore.tmp`; await fsp.writeFile(tmp, downloaded[item.path]); await fsp.rename(tmp, target)
        if (fileSha(target) !== remoteSha[item.path]) return json({ ok: false, error: `落盘校验失败：${item.path}` })
        applied.push(item.path)
      } else if (item.action === 'keep_both') {
        const ext = path.extname(item.path); const base = item.path.slice(0, -ext.length || undefined)
        let target = path.join(CONFIG_DIR, `${base}.${Date.now()}${ext}`); let n = 1
        while (fs.existsSync(target)) target = path.join(CONFIG_DIR, `${base}.${Date.now()}-${n++}${ext}`)
        await fsp.writeFile(target, downloaded[item.path]); kept.push(target)
      }
    }
    return json({ ok: true, applied, kept_both: kept, plan: restorePlan, verdict,
      summary: `恢复完成：覆盖 ${applied.length}，另存 ${kept.length}，冲突 ${verdict.conflicts.length}（策略 ${policy}）` })
  } catch (error) { return json({ ok: false, error: `恢复失败: ${error.message}` }) }
}
