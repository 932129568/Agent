/**
 * 差分 harness · Node 侧驱动（每 fixture 一个子进程，设计 §5.3）。
 *
 * 调用约定（编排器 run-diff.mjs spawn）：
 *   node [--import server/test/diff/preload-mocks.mjs] node-driver.mjs <fixture.json> --result <out.json>
 * 环境注入（编排器）：HARBOR_DIFF_MOCK_TABLE / HARBOR_DIFF_MOCKS / HARBOR_DIFF_DIALOG_REL
 *
 * 职责：
 * 1. 临时环境自建：HARBOR_CONFIG_DIR / DATABASE_URL / LOG_LEVEL 在子进程内设置
 *    （config.json 零污染——绝不写真实 ~/.glm-chat 或项目正式库）；
 * 2. 种子工作区（tmp/ws，占位符未替换的原文种入——fixture 数据侧不出现本机路径）；
 * 3. prisma db push（复用 smoke.mjs 的 execFile(process.execPath, prisma CLI) 模式）；
 * 4. 经 app.inject() 走真实 POST /jsapi/:method 路由（zod/错误映射在比对边界内）；
 * 5. 工作区快照 + probeConfigFiles 内容；
 * 6. 只产 raw（status + body 原文），不做任何归一。
 *
 * 退出码契约：0 正常；4 驱动自身崩溃。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import iconv from 'iconv-lite'

const execFileAsync = promisify(execFile)

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const HERE = path.dirname(fileURLToPath(import.meta.url))

function parseArgv() {
  const argv = process.argv.slice(2)
  const fixture = argv.find(a => !a.startsWith('--'))
  const resultIdx = argv.indexOf('--result')
  return { fixture, result: resultIdx >= 0 ? argv[resultIdx + 1] : null }
}

const { fixture: fixturePath, result: resultPath } = parseArgv()
if (!fixturePath || !resultPath) {
  process.stderr.write('usage: node-driver.mjs <fixture.json> --result <out.json>\n')
  process.exit(4)
}
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))

/* ---------- 0. fixture env 字段（方案 §6 修复T02）：按侧注入进程环境 ---------- */
for (const [key, value] of Object.entries(fixture.env?.node || {})) {
  process.env[String(key)] = String(value)
}

/* ---------- 1. 临时环境（子进程内设置；先于任何 src import 生效） ---------- */
const tempTag = String(process.env.HARBOR_DIFF_TEMP_TAG || 'harbor-diff-node')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${tempTag}-n-`))
process.env.HARBOR_CONFIG_DIR = path.join(tmp, 'config')
process.env.DATABASE_URL = `file:${path.join(tmp, 'diff.db').replaceAll('\\', '/')}`
process.env.LOG_LEVEL = 'silent'
// P0-1b B1：差分环境对齐 Python 未武装语义（生产缺省武装，入口永不设置本变量）
process.env.HARBOR_GUARD_ARMED = 'false'
const wsDir = path.join(tmp, 'ws')
const configDir = process.env.HARBOR_CONFIG_DIR

const dialogRel = String(process.env.HARBOR_DIFF_DIALOG_REL || 'out/report.txt')
const pickedPath = path.join(tmp, ...dialogRel.split('/'))
fs.mkdirSync(path.dirname(pickedPath), { recursive: true })
if (fixture.mocks?.includes('dialog')) process.env.HARBOR_TEST_PICKED_PATH = pickedPath

/* ---------- 2. 种子工作区 ---------- */
function substitute(text, p) {
  let out = String(text)
  for (const key of ['PICKED', 'WS', 'CFG', 'ROOT']) out = out.replaceAll(`{${key}}`, p[key.toLowerCase()])
  return out
}
function deepSubstitute(value, p) {
  if (typeof value === 'string') return substitute(value, p)
  if (Array.isArray(value)) return value.map(v => deepSubstitute(v, p))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepSubstitute(v, p)]))
  return value
}
function seedWorkspace(dir) {
  fs.mkdirSync(dir, { recursive: true })
  for (const spec of fixture.setup?.workspaceFiles || []) {
    const target = path.join(dir, String(spec.path || '').replace(/^[/\\]+/, ''))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const encoding = String(spec.encoding || 'utf-8')
    if (encoding === 'binary-hex') fs.writeFileSync(target, Buffer.from(String(spec.content || ''), 'hex'))
    else if (encoding === 'gbk') fs.writeFileSync(target, iconv.encode(String(spec.content || ''), 'gbk'))
    else fs.writeFileSync(target, String(spec.content ?? ''), 'utf8')
  }
  for (const d of fixture.setup?.dirs || []) fs.mkdirSync(path.join(tmp, String(d)), { recursive: true })
}
const sidePaths = { root: tmp, ws: wsDir, cfg: configDir, picked: pickedPath }
seedWorkspace(wsDir)
// cwd 对齐 Python（config_service.cwd 默认 ~/Desktop/GLM-Workspace）：
// runtime.cwd = process.cwd()，因此先 chdir 再 import
process.chdir(wsDir)

/* ---------- 3. prisma db push（官方迁移路径建表） ---------- */
await execFileAsync(process.execPath,
  ['node_modules/prisma/build/index.js', 'db', 'push', '--schema=./prisma/schema.prisma'],
  { cwd: serverRoot })

/* ---------- 4. buildServer + app.inject 逐 call ---------- */
const { buildServer } = await import('../../src/app.js')
const { disconnectDb } = await import('../../src/db.js')
const { listSignatures } = await import('../../src/registry.js')
const signatures = listSignatures()

function callArgs(call) {
  const args = deepSubstitute(call.args || [], sidePaths)
  const kwargs = deepSubstitute(call.kwargs || {}, sidePaths)
  if (!kwargs || typeof kwargs !== 'object' || Array.isArray(kwargs)) return args
  const names = signatures[call.method] || []
  const mapped = names.map(name => (Object.hasOwn(kwargs, name) ? kwargs[name] : undefined))
  while (mapped.length && mapped[mapped.length - 1] === undefined) mapped.pop()
  return [...args, ...mapped]
}

async function runOne(app, call) {
  const entry = { id: call.id || '', method: String(call.method || '') }
  try {
    const res = await app.inject({
      method: 'POST',
      url: `/jsapi/${call.method}`,
      payload: { args: callArgs(call) },
    })
    entry.status = res.statusCode
    entry.raw = res.body
  } catch (error) {
    entry.exception = `${error.name}: ${error.message}`
  }
  return entry
}

/* ---------- 5. 快照 ---------- */
function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** P0-1c H1②/③：快照哈希前的环境产物归一（Q4 裁定口径，与 fakes.py 同构）——
 * CRLF→LF（文本模式换行翻译是平台产物）+ _glm_worklog.md 的 [MM-DD HH:MM]
 * 行级掩蔽 [TS]（分钟级运行时刻）+ 含 NUL 的二进制不归一（字节即语义）。 */
function stripCrLf(raw) {
  const marker = Buffer.from([0x0d, 0x0a])
  const parts = []
  let start = 0
  for (;;) {
    const idx = raw.indexOf(marker, start)
    if (idx === -1) { parts.push(raw.subarray(start)); break }
    parts.push(raw.subarray(start, idx))
    start = idx + 2
  }
  return Buffer.concat(parts)
}
function sha256FileNormalized(file) {
  const raw = fs.readFileSync(file)
  if (raw.subarray(0, 8192).includes(0)) return crypto.createHash('sha256').update(raw).digest('hex')
  let data = stripCrLf(raw)
  if (path.basename(file).toLowerCase() === '_glm_worklog.md') {
    data = Buffer.from(data.toString('utf8').replace(/\[\d{2}-\d{2} \d{2}:\d{2}\]/g, '[TS]'), 'utf8')
  }
  return crypto.createHash('sha256').update(data).digest('hex')
}
function snapshotWorkspace(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  const walk = (base, rel) => {
    for (const item of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(base, item.name)
      const relPath = rel ? `${rel}/${item.name}` : item.name
      if (item.isDirectory()) walk(full, relPath)
      else out.push({ path: relPath, sha256: sha256FileNormalized(full) })
    }
  }
  walk(dir, '')
  return out.sort((a, b) => a.path.localeCompare(b.path))
}
function snapshotProbeFiles(names) {
  const out = {}
  for (const name of names || []) {
    const target = path.join(configDir, String(name))
    if (!fs.existsSync(target)) { out[String(name)] = null; continue }
    try { out[String(name)] = JSON.parse(fs.readFileSync(target, 'utf8')) }
    catch (error) { out[String(name)] = { _raw: fs.readFileSync(target, 'utf8') } }
  }
  return out
}

/* ---------- 主流程 ---------- */
const app = await buildServer()
const calls = []
try {
  for (const call of fixture.setup?.callsBefore || []) calls.push(await runOne(app, call))
  for (const call of fixture.calls || []) calls.push(await runOne(app, call))
} finally {
  await app.close().catch(() => {})
  await disconnectDb().catch(() => {})
}

const result = {
  side: 'node',
  fixture: String(fixture.id || ''),
  meta: { root: tmp, ws: wsDir, cfg: configDir, picked: pickedPath },
  calls,
  sideEffects: {
    workspace: snapshotWorkspace(wsDir),
    probeFiles: snapshotProbeFiles(fixture.sideEffects?.probeConfigFiles || []),
  },
}

fs.mkdirSync(path.dirname(path.resolve(resultPath)), { recursive: true })
fs.writeFileSync(resultPath, JSON.stringify(result, null, 1), 'utf8')

if (process.env.HARBOR_DIFF_KEEP_TEMP !== '1') {
  // 先把 CWD 移出临时根（Windows 不允许删除进程工作目录），再整树清理。
  // libsql 的 WAL/SHM 句柄可能延迟释放：重试三拍，仍失败则容忍残留（不入比对面）。
  try { process.chdir(os.tmpdir()) } catch { /* already gone */ }
  for (let i = 0; i < 3; i += 1) {
    try { fs.rmSync(tmp, { recursive: true, force: true, retryDelay: 200, maxRetries: 5 }); break } catch { /* 下一拍再试 */ }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
}
process.exit(0)
