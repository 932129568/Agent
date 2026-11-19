/**
 * T05 验收①（P0-4 §8 T05-①）：升级语义端到端（隔离目录模拟，真实 ~/.glm-chat 零污染）。
 *
 * 预置「旧版态」（模拟 Python 链/旧版本遗留数据）：
 *   - sessions.json（legacy 数组原文，Python json.dumps ensure_ascii=false 形态）
 *   - config.json（旧版配置）
 *   - webdav.json.password = PS .NET ProtectedData(CurrentUser) 密文（'dpapi:' 前缀）
 *   - mcp_servers.json env 含存量明文密钥（触发 migratePlaintextSecrets）
 *   - 旧版 DB（harbor.db：prisma db push 同构建表 + 1 条旧版本会话）
 * → win-unpacked 首启（HARBOR_HEADLESS=1，隔离 CONFIG_DIR）→ bootstrap 导入 + DPAPI
 *   迁移 → HTTP 读回断言 + 文件面断言（原文件零丢失、备份先行、config.json 零污染）。
 *
 * 用法：node tools/verify-upgrade-e2e.mjs [--artifact <Harbor.exe>] [--keep]
 * 退出码：0 全过；1 存在失败；2 基础设施错误。
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const artifact = args.includes('--artifact')
  ? path.resolve(args[args.indexOf('--artifact') + 1])
  : path.join(PROJECT_ROOT, 'dist-electron', 'win-unpacked', 'Harbor.exe')
const keep = args.includes('--keep')

if (!fs.existsSync(artifact)) {
  console.error(`产物不存在: ${artifact}`)
  process.exit(2)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-t05-upgrade-'))
const cfg = path.join(tmp, 'config')
fs.mkdirSync(cfg, { recursive: true })
const OLD_WEBDAV_PASS = 't05-old-pass-密码-Upgrade2026'

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}
async function jsapi(base, method, callArgs = []) {
  const res = await fetch(`${base}/jsapi/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args: callArgs }),
    signal: AbortSignal.timeout(30000),
  })
  return { status: res.status, body: await res.text() }
}

/* ---------- 1. 旧版态预置 ---------- */
const legacySessions = [
  { id: 'legacy_a', title: '旧版会话A·升级验证', createdAt: 1000, updatedAt: 1000,
    messages: [{ role: 'user', content: '来自 Python 链的会话' }] },
  { id: 'legacy_b', title: '旧版会话B·升级验证', createdAt: 2000, updatedAt: 2000, messages: [] },
]
// Python json.dumps(ensure_ascii=False) 形态（', '/': ' 分隔）
const legacyText = `[${legacySessions.map(s => JSON.stringify(s, null, 0)
  .replace(/, /g, ', ').replace(/": "/g, '": "')).join(', ')}]`
fs.writeFileSync(path.join(cfg, 'sessions.json'), legacyText, 'utf8')
fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({
  api_key: 't05-fake-key-not-real', temperature: 0.7, top_p: 0.95, model: 'glm-4.5-flash',
  enable_search: true, search_engine: 'search_pro', test: 1,
}, null, 2), 'utf8')
fs.writeFileSync(path.join(cfg, 'mcp_servers.json'), JSON.stringify({
  mcpServers: { 't05-old-server': { command: 'node', args: ['server.js'], env: { T05_SECRET: 'plain-t05-secret-xyz' } } },
}, null, 2), 'utf8')

// webdav 密码：PS .NET ProtectedData(CurrentUser) 加密（旧链产出形态）
const psScript = `
Add-Type -AssemblyName System.Security
$bytes = [System.Text.Encoding]::UTF8.GetBytes('${OLD_WEBDAV_PASS}')
$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($enc)
`
const { stdout: psOut } = await execFileAsync('powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', psScript], { encoding: 'utf8' })
const dpapiMarker = `dpapi:${psOut.trim()}`
if (!dpapiMarker.startsWith('dpapi:') || dpapiMarker.length < 40) {
  console.error('PS DPAPI 加密失败:', psOut.slice(0, 200)); process.exit(2)
}
fs.writeFileSync(path.join(cfg, 'webdav.json'), JSON.stringify({
  url: 'https://dav.t05.invalid/', username: 't05user', password: dpapiMarker,
  remote_path: '/harbor', auto_sync: false, conflict_policy: 'local',
}, null, 2), 'utf8')

// 旧版 DB：与现 schema 同构（本批无 schema 变更）——db.js ensureSchema + 1 条旧版本会话
process.env.HARBOR_CONFIG_DIR = cfg
process.env.DATABASE_URL = `file:${path.join(cfg, 'harbor.db').replaceAll('\\', '/')}`
process.env.LOG_LEVEL = 'silent'
{
  const { prisma, ensureSchema, disconnectDb } = await import(
    pathToFileURL(path.join(PROJECT_ROOT, 'server', 'src', 'db.js')).href)
  await ensureSchema(prisma)
  await prisma.session.create({ data: {
    id: 'old_db_s1', title: '旧库会话(旧版本写入)', createdAt: 900n, updatedAt: 900n,
    payload: JSON.stringify({ id: 'old_db_s1', title: '旧库会话(旧版本写入)',
      createdAt: 900, updatedAt: 900, messages: [] }),
  } })
  await disconnectDb()
}

const preBootHashes = {}
for (const name of ['sessions.json', 'config.json', 'webdav.json', 'mcp_servers.json']) {
  preBootHashes[name] = sha256File(path.join(cfg, name))
}

/* ---------- 2. win-unpacked 首启（HARBOR_HEADLESS=1） ---------- */
const port = await freePort()
const base = `http://127.0.0.1:${port}`
const child = spawn(artifact, [], {
  cwd: tmp,
  env: {
    ...process.env,
    HARBOR_HEADLESS: '1',
    HARBOR_CONFIG_DIR: cfg,
    DATABASE_URL: `file:${path.join(cfg, 'harbor.db').replaceAll('\\', '/')}`,
    HOST: '127.0.0.1', PORT: String(port), LOG_LEVEL: 'silent',
    HARBOR_UPDATE_DIR: path.join(tmp, 'update'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let stdoutAll = ''
child.stdout.on('data', d => { stdoutAll += String(d) })
let stderrAll = ''
child.stderr.on('data', d => { stderrAll += String(d) })

async function waitHealthy() {
  const deadline = Date.now() + 90000
  let last = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return await res.json()
      last = `HTTP ${res.status}`
    } catch (e) { last = e.message }
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error(`产物 /health 未就绪: ${last} | stderr: ${stderrAll.slice(-300)}`)
}
const health = await waitHealthy()

// bootstrap 后台链（listen 后非阻塞）——轮询 stdout 直到两条迁移完成/失败线出现
async function waitBootstrapLogs() {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const hasLegacy = /legacy sessions 迁移完成|legacy sessions 迁移失败/.test(stdoutAll)
    const hasDpapi = /存量明文密钥 DPAPI 迁移完成|存量明文密钥迁移延后|存储迁移后台任务异常/.test(stdoutAll)
    if (hasLegacy && hasDpapi) return
    await new Promise(r => setTimeout(r, 300))
  }
}

/* ---------- 3. HTTP 读回断言 ---------- */
const checks = []
const check = (name, fn) => {
  try { fn(); checks.push({ name, ok: true }) } catch (e) { checks.push({ name, ok: false, detail: String(e.message || e).slice(0, 300) }) }
}

try {
  await waitBootstrapLogs()
  const sessions = JSON.parse((await jsapi(base, 'get_sessions')).body)
  check('① bootstrap 导入：get_sessions 含旧库+导入共 3 会话', () => {
    const ids = sessions.map(s => String(s.id)).sort()
    if (!(ids.join(',') === 'legacy_a,legacy_b,old_db_s1')) throw new Error(`ids=${ids}`)
  })
  check('① legacy 会话字段读回正确', () => {
    const a = sessions.find(s => s.id === 'legacy_a')
    if (!a || a.title !== '旧版会话A·升级验证' || a.messages?.[0]?.content !== '来自 Python 链的会话') {
      throw new Error(JSON.stringify(a).slice(0, 200))
    }
  })
  const webdav = JSON.parse((await jsapi(base, 'webdav_get_config')).body)
  check('① PS 加密字段（webdav.password）升级后解密读回正确', () => {
    const pass = webdav && webdav.config ? webdav.config.password : webdav.password
    if (pass !== OLD_WEBDAV_PASS) throw new Error(`password=${String(pass).slice(0, 40)}`)
  })
  const conf = JSON.parse((await jsapi(base, 'get_config')).body)
  check('① config.json 语义读回正确（零污染且在位）', () => {
    const c = conf.config || conf
    if (c.api_key !== 't05-fake-key-not-real' || c.model !== 'glm-4.5-flash') {
      throw new Error(JSON.stringify(c).slice(0, 160))
    }
  })
  const mcp = JSON.parse((await jsapi(base, 'mcp_list_servers')).body)
  check('① mcp 旧服务器条目在位', () => {
    const names = JSON.stringify(mcp)
    if (!names.includes('t05-old-server')) throw new Error(names.slice(0, 200))
  })

  /* ---------- 4. 文件面断言 ---------- */
  check('① config.json 逐字节零漂移（升级零污染）', () => {
    if (sha256File(path.join(cfg, 'config.json')) !== preBootHashes['config.json']) throw new Error('config.json 被改写')
  })
  check('① sessions.json 原文件保留 + 备份先行（.pre-node-migration.bak）', () => {
    if (sha256File(path.join(cfg, 'sessions.json')) !== preBootHashes['sessions.json']) throw new Error('原文件被改写')
    const bak = `${path.join(cfg, 'sessions.json')}.pre-node-migration.bak`
    if (!fs.existsSync(bak)) throw new Error('备份缺失')
    if (sha256File(bak) !== preBootHashes['sessions.json']) throw new Error('备份内容不符')
  })
  check('① webdav.json（PS 密文）零改写', () => {
    if (sha256File(path.join(cfg, 'webdav.json')) !== preBootHashes['webdav.json']) throw new Error('webdav.json 被改写')
  })
  check('① mcp_servers.json 存量明文已 DPAPI 迁移（__enc__ + 备份）', () => {
    const after = JSON.parse(fs.readFileSync(path.join(cfg, 'mcp_servers.json'), 'utf8'))
    const marker = after.mcpServers['t05-old-server'].env.T05_SECRET
    if (!(marker && typeof marker === 'object' && String(marker.__enc__ || '').startsWith('dpapi:'))) {
      throw new Error(`未迁移: ${JSON.stringify(marker).slice(0, 80)}`)
    }
    if (!fs.existsSync(`${path.join(cfg, 'mcp_servers.json')}.pre-dpapi.bak`)) throw new Error('备份缺失')
  })
  check('① harbor.db 在位（DB 数据源）', () => {
    if (!fs.existsSync(path.join(cfg, 'harbor.db'))) throw new Error('harbor.db 缺失')
  })
} finally {
  try { child.kill() } catch { /* already dead */ }
  await new Promise(r => setTimeout(r, 1200))
  try { if (child.exitCode === null) child.kill('SIGKILL') } catch { /* gone */ }
}

const okAll = checks.every(c => c.ok)
const evidence = {
  ok: okAll,
  artifact,
  configDir: cfg,
  health: { methods: health.methods, node: health.node },
  bootstrapLog: stdoutAll.split('\n').filter(l => l.includes('[harbor]')).slice(0, 12),
  checks,
}
console.log(JSON.stringify(evidence, null, 1))
if (keep) console.log(`[verify-upgrade-e2e] 保留现场: ${tmp}`)
else {
  // 产物进程 cwd 挂在 tmp：等待句柄释放后多拍清理（Windows 句柄延迟释放实测 ~2s）
  await new Promise(r => setTimeout(r, 2500))
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(tmp, { recursive: true, force: true, retryDelay: 500, maxRetries: 5 }); break } catch { /* 再等一拍 */ }
    await new Promise(r => setTimeout(r, 1500))
  }
}
process.exit(okAll ? 0 : 1)
