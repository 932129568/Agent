/**
 * 差分 harness · live 模式（P0-4 §6.2/Q10，T05 落地；dev 工具，不进 145 契约面）。
 *
 * 对打包产物内嵌 server（HARBOR_HEADLESS=1 server-only + 隔离 CONFIG_DIR）走 HTTP
 * 驱动，回放「只读+低副作用子集」，期望值锚定最近一次源码树全量差分 raw 的 node 侧
 * （同宿主语义：node-driver 与产物同为 Node 后端实现）。系统性捕捉产物资产/环境漂移
 * （prompts 缺失 → build_system_prompt 即刻 suspect；工具 schema 漂移 → build_tools
 * 即刻 suspect）。真实 ~/.glm-chat 零污染（全程隔离临时目录）。
 *
 * 用法：
 *   node tools/diff/live-replay.mjs [runId] [--artifact <Harbor.exe>] [--only id,id]
 *        [--keep-temp] [--health-timeout-ms N] [--list]
 *
 *   runId        锚定的差分 runId（outputs/diff/<runId>/raw）；缺省=编号最大的含 raw 目录
 *   --artifact   产物 exe；缺省 dist-electron/win-unpacked/Harbor.exe
 *   --only       逗号分隔 fixture id 过滤（缺省全子集 6 fixture / 67 calls）
 *   --keep-temp  保留各 fixture 临时根（调试；缺省退出前清扫）
 *   --list       只打印子集清单与锚定信息，不执行
 *
 * 子集口径（§6.2「meta/sessions 读/guard 读/misc-config 读/provider prompts 等」；
 * 副作用仅限隔离 CONFIG_DIR / 隔离 DB 内的写，无真实桌面/网络外部性——prompts-tools
 * 的网络探测均指向回环 59998 拒绝 / 58111 挂起监听器，与差分双侧驱动同构）：
 *   meta/api-info(1) + sessions-basic(7) + sessions-validation(6) + guard-chain(23)
 *   + config-family(16) + prompts-tools(14) = 67 calls。
 *
 * 复用纪律（本文件不改差分面）：归一引擎 server/test/diff/normalize.mjs（唯一实现）、
 * firstDiff/loadIntentionalDeltas 取自 compare.mjs（只 import 不修改）、fixture/参数
 * 映射与 node-driver 同构（侧路径占位 {ROOT}/{WS}/{CFG}/{PICKED} → 本侧路径）。
 * intentional 登记命中仅作标注（node↔node 同实现预期零命中）。
 *
 * 退出码：0 = suspect=0 且 error=0；1 = 存在 suspect；2 = 基础设施错误（产物拉起失败等）。
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadRules, normalizeForCompare } from '../../server/test/diff/normalize.mjs'
import { firstDiff, loadIntentionalDeltas } from '../../server/test/diff/compare.mjs'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIFF_DIR = path.join(PROJECT_ROOT, 'tools', 'diff')
const FIXTURES_DIR = path.join(DIFF_DIR, 'fixtures')
const OUTPUTS_DIR = path.join(PROJECT_ROOT, 'outputs', 'diff')
const DEFAULT_ARTIFACT = path.join(PROJECT_ROOT, 'dist-electron', 'win-unpacked', 'Harbor.exe')

/** §6.2 live 子集（fixture id → 参与比对的 call id 过滤；空=全部 calls）。 */
const LIVE_FIXTURES = [
  { id: 'meta/api-info', note: 'get_api_info 契约面（version/methods 逐项）' },
  { id: 'sessions-basic', note: '会话读写/当前会话/purge（隔离 DB）' },
  { id: 'sessions-validation', note: '会话校验拒绝路径（zod/JSON 错误面）' },
  { id: 'guard-chain', note: '护栏判定/确认 token/信任/审计链（隔离 CONFIG_DIR）' },
  { id: 'config-family', note: 'misc-config 读/写/校验（hybrid/model_prefs/reader/sandbox/search）' },
  { id: 'prompts-tools', note: 'prompts 资产链/工具清单/缓存/本地探测（回环离线路径）' },
]

/* ---------------- CLI ---------------- */
function parseArgs(argv) {
  const args = { only: [], keepTemp: false, healthTimeoutMs: 90000, list: false, artifact: DEFAULT_ARTIFACT, runId: null }
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]
    if (item === '--only') args.only = String(argv[++i] || '').split(',').map(x => x.trim()).filter(Boolean)
    else if (item === '--artifact') args.artifact = path.resolve(argv[++i])
    else if (item === '--keep-temp') args.keepTemp = true
    else if (item === '--list') args.list = true
    else if (item === '--health-timeout-ms') args.healthTimeoutMs = Number(argv[++i]) || 90000
    else if (item.startsWith('--')) throw new Error(`未知参数: ${item}`)
    else args.runId = String(item)
  }
  return args
}
const args = parseArgs(process.argv.slice(2))

/* ---------------- 锚定 runId 解析 ---------------- */
function findAnchorRunId(requested) {
  if (requested) {
    const dir = path.join(OUTPUTS_DIR, requested, 'raw')
    if (!fs.existsSync(dir)) throw new Error(`锚定 runId 不存在: ${requested}（缺 ${dir}）`)
    return requested
  }
  const candidates = fs.readdirSync(OUTPUTS_DIR)
    .filter(name => /^\d{14}$/.test(name) && fs.existsSync(path.join(OUTPUTS_DIR, name, 'raw')))
    .sort()
  if (!candidates.length) throw new Error('outputs/diff 下没有含 raw/ 的差分 run 目录')
  // 缺省锚定「最近一次全量差分」：子集族 fixture 锚全部在 raw 才入选
  // （单族补跑如 `run-diff.mjs update` 的 raw 目录不是合法锚）
  const needed = LIVE_FIXTURES.map(s => `${s.id}.node.json`)
  for (let i = candidates.length - 1; i >= 0; i--) {
    const raw = path.join(OUTPUTS_DIR, candidates[i], 'raw')
    if (needed.every(n => fs.existsSync(path.join(raw, n)))) return candidates[i]
  }
  throw new Error(`最近 ${candidates.length} 个差分 run 无一包含 live 子集全锚（先跑 npm run diff:all）`)
}
const anchorRunId = findAnchorRunId(args.runId)
const anchorRawDir = path.join(OUTPUTS_DIR, anchorRunId, 'raw')
const anchorReportPath = path.join(OUTPUTS_DIR, anchorRunId, 'report.json')
const anchorReport = fs.existsSync(anchorReportPath)
  ? JSON.parse(fs.readFileSync(anchorReportPath, 'utf8'))
  : null

/* ---------------- fixture 文件发现 ---------------- */
function discoverFixtureFile(id) {
  const familyOrder = JSON.parse(fs.readFileSync(path.join(DIFF_DIR, 'diff-config.json'), 'utf8')).familyOrder || []
  for (const family of familyOrder) {
    const candidate = path.join(FIXTURES_DIR, family, `${id}.json`)
    if (fs.existsSync(candidate)) return candidate
    const dir = path.join(FIXTURES_DIR, family)
    if (!fs.existsSync(dir)) continue
    // fixture id 含族前缀（如 meta/api-info）时文件名可能为 api-info.json
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name)
      try {
        if (name.endsWith('.json') && JSON.parse(fs.readFileSync(file, 'utf8')).id === id) return file
      } catch { /* 坏文件跳过 */ }
    }
  }
  return null
}

const selected = []
for (const spec of LIVE_FIXTURES) {
  if (args.only.length && !args.only.includes(spec.id)) continue
  const file = discoverFixtureFile(spec.id)
  if (!file) throw new Error(`fixture 未找到: ${spec.id}`)
  const fixture = JSON.parse(fs.readFileSync(file, 'utf8'))
  const anchorFile = path.join(anchorRawDir, `${spec.id}.node.json`)
  if (!fs.existsSync(anchorFile)) throw new Error(`锚定 raw 缺失: ${anchorFile}（runId=${anchorRunId} 是否全量差分？）`)
  const anchor = JSON.parse(fs.readFileSync(anchorFile, 'utf8'))
  selected.push({ ...spec, fixture, file, anchor })
}
const totalCalls = selected.reduce((acc, s) => acc + s.fixture.calls.length, 0)

console.log(`[live-replay] anchor=${anchorRunId}${anchorReport ? `（锚定报告 summary=${JSON.stringify(anchorReport.summary?.calls != null ? anchorReport.summary.calls : '?')} calls）` : '（无 report.json）'}`)
console.log(`[live-replay] artifact=${args.artifact}`)
for (const s of selected) console.log(`[live-replay]   ${s.id.padEnd(22)} calls=${String(s.fixture.calls.length).padStart(2)} ${s.note}`)
console.log(`[live-replay] subset fixtures=${selected.length} calls=${totalCalls}`)
if (args.list) process.exit(0)

if (!fs.existsSync(args.artifact)) {
  console.error(`[live-replay] 产物不存在: ${args.artifact}（--artifact 指定或先 npm run dist:win）`)
  process.exit(2)
}

/* ---------------- 进程自保护：registry import 前重定向 CONFIG_DIR ----------------
 * registry.js 顶层 await 触发内置专家导入器（run-diff.mjs QA #13 同款）——主进程
 * 未隔离 CONFIG_DIR 时会写真实 ~/.glm-chat。live-replay 自身 import registry 取
 * 签名表，必须先重定向；退出时清扫。 */
const selfIsoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-live-replay-selfiso-'))
process.env.HARBOR_CONFIG_DIR = selfIsoDir
process.on('exit', () => { try { fs.rmSync(selfIsoDir, { recursive: true, force: true }) } catch { /* 句柄竞争容忍 */ } })
const { pathToFileURL } = await import('node:url')
const { listSignatures } = await import(pathToFileURL(path.join(PROJECT_ROOT, 'server', 'src', 'registry.js')).href)
const signatures = listSignatures()

/* ---------------- 参数映射（与 node-driver callArgs 同构） ---------------- */
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
function callArgs(call, p) {
  const argv = deepSubstitute(call.args || [], p)
  const kwargs = deepSubstitute(call.kwargs || {}, p)
  if (!kwargs || typeof kwargs !== 'object' || Array.isArray(kwargs)) return argv
  const names = signatures[call.method] || []
  const mapped = names.map(name => (Object.hasOwn(kwargs, name) ? kwargs[name] : undefined))
  while (mapped.length && mapped[mapped.length - 1] === undefined) mapped.pop()
  return [...argv, ...mapped]
}

/* ---------------- 产物生命周期 ---------------- */
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

/** 挂起监听器（node-driver 同构：TCP accept 但不响应）。返回关闭函数。 */
function hangListener(port) {
  const server = net.createServer(socket => { socket.pause() })
  server.listen(Number(port), '127.0.0.1')
  return () => { try { server.close() } catch { /* already closed */ } }
}

function seedWorkspace(wsDir, fixture) {
  fs.mkdirSync(wsDir, { recursive: true })
  for (const spec of fixture.setup?.workspaceFiles || []) {
    const target = path.join(wsDir, String(spec.path || '').replace(/^[/\\]+/, ''))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const encoding = String(spec.encoding || 'utf-8')
    if (encoding === 'binary-hex') fs.writeFileSync(target, Buffer.from(String(spec.content || ''), 'hex'))
    else fs.writeFileSync(target, String(spec.content ?? ''), 'utf8')
  }
}

async function waitHealthy(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return await res.json()
      lastError = `HTTP ${res.status}`
    } catch (error) { lastError = error.message }
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error(`产物 /health 未就绪（${timeoutMs}ms）：${lastError}`)
}

function killArtifact(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null || child.killed) return resolve()
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already dead */ } }, 8000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    try { child.kill() } catch { clearTimeout(timer); resolve() }
  })
}

function rmRfRetry(dir) {
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true, retryDelay: 200, maxRetries: 5 }); return } catch { /* retry */ }
    const buf = new SharedArrayBuffer(4)
    Atomics.wait(new Int32Array(buf), 0, 0, 300)
  }
}

async function runFixtureLive(spec) {
  const { fixture } = spec
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `harbor-live-${anchorRunId}-`))
  const side = {
    root: tmp,
    ws: path.join(tmp, 'Desktop', 'GLM-Workspace'),
    cfg: path.join(tmp, 'config'),
    picked: path.join(tmp, 'out', 'report.txt'),
  }
  seedWorkspace(side.ws, fixture)
  fs.mkdirSync(side.cfg, { recursive: true })
  const closeHangs = (fixture.setup?.listenPorts || []).map(port => hangListener(port))

  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const childEnv = {
    HARBOR_HEADLESS: '1',
    HARBOR_CONFIG_DIR: side.cfg,
    DATABASE_URL: `file:${path.join(side.cfg, 'harbor.db').replaceAll('\\', '/')}`,
    HOST: '127.0.0.1',
    PORT: String(port),
    LOG_LEVEL: 'silent',
    HARBOR_GUARD_ARMED: 'false', // 对齐差分环境未武装语义（锚定 raw 的生成口径）
    HARBOR_UPDATE_DIR: path.join(tmp, 'update'),
    CORS_ORIGIN: 'null',
  }
  const startedAt = Date.now()
  const child = spawn(args.artifact, [], {
    env: { ...process.env, ...childEnv },
    // cwd 对齐 node-driver 的 process.chdir(ws)（runtime.cwd = process.cwd()，
    // build_system_prompt/get_cwd 等披露当前工作区——锚定 raw 的生成口径）
    cwd: side.ws,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderrTail = ''
  child.stderr.on('data', d => { stderrTail = (stderrTail + String(d)).slice(-2000) })
  let health = null
  try {
    health = await waitHealthy(base, args.healthTimeoutMs)
  } catch (error) {
    await killArtifact(child)
    for (const close of closeHangs) close()
    if (!args.keepTemp) rmRfRetry(tmp)
    return { spec, error: `${error.message}${stderrTail ? ` | stderr: ${stderrTail.slice(-400)}` : ''}`, calls: [], health: null }
  }
  const bootMs = Date.now() - startedAt

  const calls = []
  try {
    for (const call of fixture.calls) {
      const entry = { id: call.id, method: String(call.method || '') }
      try {
        const res = await fetch(`${base}/jsapi/${entry.method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ args: callArgs(call, side) }),
          signal: AbortSignal.timeout(60000),
        })
        entry.status = res.status // fetch Response（app.inject 的 statusCode 对应物）
        entry.raw = await res.text()
      } catch (error) {
        entry.exception = `${error.name}: ${error.message}`
      }
      calls.push(entry)
    }
  } finally {
    await killArtifact(child)
    for (const close of closeHangs) close()
    if (!args.keepTemp) rmRfRetry(tmp)
  }
  return { spec, error: null, calls, health, bootMs, pid: child.pid, side }
}

/* ---------------- 比对（归一引擎唯一实现复用） ---------------- */
const rules = loadRules()
const deltaRegistry = loadIntentionalDeltas()

function brief(value, limit = 400) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

let currentFixtureId = ''

function verdictFor(anchorSide, anchorEntry, liveSide, liveEntry, call) {
  const base = { callId: call.id, method: call.method, note: call.note || '' }
  if (!anchorEntry) return { ...base, verdict: 'error', diffPath: 'anchor-missing', anchorSummary: '', liveSummary: '' }
  if (!liveEntry) return { ...base, verdict: 'error', diffPath: 'live-missing', anchorSummary: '', liveSummary: '' }
  const a = normalizeForCompare(anchorEntry.raw ?? anchorEntry.exception ?? null, anchorSide, rules)
  const b = normalizeForCompare(liveEntry.raw ?? liveEntry.exception ?? null, liveSide, rules)
  const summaries = { anchorSummary: brief(a.value), liveSummary: brief(b.value) }
  if (liveEntry.exception) return { ...base, verdict: 'suspect', diffPath: `live.exception: ${liveEntry.exception}`, ...summaries }
  const anchorStatus = anchorEntry.status ?? 200
  if (anchorStatus !== liveEntry.status) {
    return { ...base, verdict: 'suspect', diffPath: `status（anchor=${anchorStatus} live=${liveEntry.status}）`, ...summaries }
  }
  const diffPath = firstDiff(a.value, b.value)
  if (!diffPath) return { ...base, verdict: 'match', ...summaries }
  const delta = deltaRegistry.byKey.get(`${currentFixtureId}|${call.id}`)
  if (delta && !delta.expired) {
    return { ...base, verdict: 'intentional-delta-noted', deltaId: delta.id, diffPath, ...summaries }
  }
  return { ...base, verdict: 'suspect', diffPath, ...summaries }
}

/* ---------------- 主流程 ---------------- */
const startedAt = new Date()
const liveRunId = startedAt.toISOString().replace(/\D/g, '').slice(0, 14)
const outDir = path.join(OUTPUTS_DIR, 'live-replay', `${anchorRunId}-${liveRunId.slice(8)}`)
fs.mkdirSync(outDir, { recursive: true })

const fixtureResults = []
let infraErrors = 0
for (const spec of selected) {
  process.stdout.write(`[live-replay] ${spec.id} … `)
  currentFixtureId = spec.id
  const result = await runFixtureLive(spec)
  if (result.error) {
    infraErrors += 1
    console.log(`ERROR: ${result.error}`)
    fixtureResults.push({ fixture: spec.id, error: result.error, verdicts: [], health: result.health })
    continue
  }
  const anchorById = new Map(result.spec.anchor.calls.map(c => [c.id, c]))
  const liveById = new Map(result.calls.map(c => [c.id, c]))
  const anchorSide = result.spec.anchor.meta || {}
  const verdicts = result.spec.fixture.calls.map(call => verdictFor(anchorSide, anchorById.get(call.id), result.side, liveById.get(call.id), call))
  // 产物资产自检（§6.2：health 145 = 方法面/资产在位的直证）
  const healthVerdict = {
    callId: 'health', method: 'GET /health', note: '产物资产自检：methods=145',
    verdict: result.health && result.health.methods === 145 ? 'match' : 'suspect',
    diffPath: result.health && result.health.methods !== 145 ? `methods=${result.health.methods}` : '',
    anchorSummary: 'methods=145', liveSummary: `methods=${result.health?.methods} node=${result.health?.node}`,
  }
  verdicts.push(healthVerdict)
  const counts = verdicts.reduce((acc, v) => { acc[v.verdict] = (acc[v.verdict] || 0) + 1; return acc }, {})
  console.log(`match=${counts.match || 0} suspect=${counts.suspect || 0} error=${counts.error || 0}`
    + ` intentional-delta-noted=${counts['intentional-delta-noted'] || 0} boot=${result.bootMs}ms`)
  fixtureResults.push({
    fixture: spec.id, verdicts, health: result.health, bootMs: result.bootMs, pid: result.pid,
  })
}

const allVerdicts = fixtureResults.flatMap(r => r.verdicts || [])
const callVerdicts = allVerdicts.filter(v => v.callId !== 'health')
const healthVerdicts = allVerdicts.filter(v => v.callId === 'health')
const summary = {
  anchorRunId,
  artifact: args.artifact,
  fixtures: fixtureResults.length,
  calls: callVerdicts.length,
  match: callVerdicts.filter(v => v.verdict === 'match').length,
  suspect: callVerdicts.filter(v => v.verdict === 'suspect').length,
  error: callVerdicts.filter(v => v.verdict === 'error').length,
  intentionalDeltaNoted: callVerdicts.filter(v => v.verdict === 'intentional-delta-noted').length,
  healthChecks: { total: healthVerdicts.length, match: healthVerdicts.filter(v => v.verdict === 'match').length },
}
summary.ok = summary.suspect === 0 && summary.error === 0

const report = {
  runId: `live-${anchorRunId}-${liveRunId}`,
  kind: 'live-replay（P0-4 §6.2/Q10 dev 工具）',
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  anchor: { runId: anchorRunId, rawDir: anchorRawDir, summary: anchorReport?.summary || null },
  artifact: { exe: args.artifact, exists: fs.existsSync(args.artifact) },
  subset: LIVE_FIXTURES.filter(s => !args.only.length || args.only.includes(s.id)),
  summary,
  fixtures: fixtureResults,
}
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1), 'utf8')

const lines = [
  `# live-replay 报告（P0-4 §6.2/Q10 dev 工具）`, '',
  `- 锚定：差分 runId ${anchorRunId}（raw: \`${anchorRawDir}\`）`,
  `- 产物：\`${args.artifact}\``,
  `- 子集：fixtures=${summary.fixtures} calls=${summary.calls}（+1 health 资产自检/fixture）`,
  `- 结果：match=${summary.match} suspect=${summary.suspect} error=${summary.error} intentional-delta-noted=${summary.intentionalDeltaNoted}`,
  `- 结论：${summary.ok ? 'PASS（suspect=0）' : 'FAIL'}`, '',
]
for (const fr of fixtureResults) {
  lines.push(`## ${fr.fixture}${fr.error ? ` — ERROR: ${fr.error}` : ''}`)
  if (fr.health) lines.push(`- health: methods=${fr.health.methods} node=${fr.health.node} boot=${fr.bootMs}ms pid=${fr.pid}`)
  for (const v of fr.verdicts || []) {
    if (v.verdict === 'match' && v.callId !== 'health') continue
    lines.push(`- [${v.verdict}] ${v.callId} ${v.method}${v.diffPath ? ` — ${v.diffPath}` : ''}`)
    if (v.verdict !== 'match') {
      lines.push(`  - anchor: ${v.anchorSummary}`)
      lines.push(`  - live:   ${v.liveSummary}`)
    }
  }
  lines.push('')
}
fs.writeFileSync(path.join(outDir, 'report.md'), lines.join('\n'), 'utf8')

console.log('')
console.log(`[live-replay] 完成：fixtures=${summary.fixtures} calls=${summary.calls} `
  + `match=${summary.match} suspect=${summary.suspect} error=${summary.error} delta-noted=${summary.intentionalDeltaNoted}`)
console.log(`[live-replay] report: ${path.join(outDir, 'report.md')}`)

process.exit(summary.ok && infraErrors === 0 ? 0 : (infraErrors > 0 ? 2 : 1))
