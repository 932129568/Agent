/**
 * 差分编排器（设计 §2.1/§5.4）—— diff / diff:all / diff:coverage 入口。
 *
 *   node run-diff.mjs                 # 八优先族（diff-config defaultFamilies）
 *   node run-diff.mjs meta            # 指定家族（可逗号分隔多个）
 *   node run-diff.mjs --all           # 全部 fixture（diff:all）
 *   node run-diff.mjs --coverage      # 覆盖率静态门禁（diff:coverage；T05 常规化）
 *
 * 关键行为：
 *   - 子进程环境净化（白名单透传 + HARBOR_x/GLM_x/DATABASE_URL 等一律不继承；D3）；
 *   - 单 fixture 双侧总超时（默认 300s），超时/崩溃记 error 并续跑后续 fixture；
 *   - 严格按 familyOrder 顺序单线程执行（确定性优先）；
 *   - 退出码：0 = 全部 match/intentional（且 --coverage 时门禁通过）；
 *             1 = 存在 suspect（或覆盖率缺口）；2 = 基础设施错误。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadRules } from './normalize.mjs'
import { loadIntentionalDeltas, compareCall, compareSideEffects } from './compare.mjs'
import { buildReportJson, renderMarkdown, writeReports } from './report.mjs'
import { listMethods } from '../../src/registry.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = path.resolve(HERE, '..', '..')
const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..')
const DIFF_DIR = path.join(PROJECT_ROOT, 'tools', 'diff')
const FIXTURES_DIR = path.join(DIFF_DIR, 'fixtures')
const PY_DRIVER = path.join(DIFF_DIR, 'python_driver.py')
const NODE_DRIVER = path.join(HERE, 'node-driver.mjs')
const PRELOAD = path.join(HERE, 'preload-mocks.mjs')
const MOCK_TABLE = path.join(DIFF_DIR, 'mock-table.json')

/* ---------------- CLI ---------------- */
function parseArgs(argv) {
  const args = { families: [], all: false, coverage: false }
  for (const item of argv.slice(2)) {
    if (item === '--all') args.all = true
    else if (item === '--coverage') args.coverage = true
    else if (item === '--keep-temp') args.keepTemp = true
    else if (item.startsWith('--')) throw new Error(`未知参数: ${item}`)
    else args.families.push(...item.split(',').map(x => x.trim()).filter(Boolean))
  }
  return args
}

/* ---------------- 配置 ---------------- */
const config = JSON.parse(fs.readFileSync(path.join(DIFF_DIR, 'diff-config.json'), 'utf8'))
const PYTHON_BIN = process.env.HARBOR_DIFF_PYTHON || config.pythonBin || 'python'
const NODE_BIN = process.env.NODE_BIN || process.execPath
const TIMEOUT_MS = Number(config.driverTimeoutSeconds || 300) * 1000

const ENV_WHITELIST = ['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'WINDIR', 'TEMP', 'TMP',
  'PATHEXT', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'LOCALAPPDATA', 'APPDATA',
  'ALLUSERSPROFILE', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'OS', 'SYSTEMDRIVE']

function childEnv(extra) {
  const env = {}
  for (const key of ENV_WHITELIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return { ...env, ...extra } // HARBOR 前缀 / GLM 前缀 / DATABASE_URL 等一律不继承
}

/** 双侧驱动退出后清扫本 runId 的临时根（进程已退，句柄全释放；残留=泄漏）。 */
function sweepTempRoots(tag) {
  if (process.env.HARBOR_DIFF_KEEP_TEMP === '1') return
  const dir = os.tmpdir()
  let removed = 0
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(`${tag}-`)) continue
      try {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true, retryDelay: 200, maxRetries: 5 })
        removed += 1
      } catch { /* 容忍个别句柄竞争残留 */ }
    }
  } catch { /* tmpdir 不可读时跳过 */ }
  return removed
}

function spawnAsync(bin, args, options) {
  return new Promise(resolve => {
    const child = spawn(bin, args, options)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* already dead */ }
    }, options.timeoutMs || TIMEOUT_MS)
    let timedOut = false
    child.on('error', err => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: `${stderr}${err}` }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }) })
  })
}

function discoverFixtures(families) {
  const familyOrder = config.familyOrder || []
  const wanted = new Set(families)
  const found = []
  for (const family of familyOrder) {
    const dir = path.join(FIXTURES_DIR, family)
    if (!fs.existsSync(dir)) continue
    if (wanted.size && !wanted.has(family)) continue
    for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort()) {
      found.push({ family, file: path.join(dir, name) })
    }
  }
  return found
}

async function runPythonListMethods() {
  const res = await spawnAsync(PYTHON_BIN, [PY_DRIVER, '--list-methods'], {
    cwd: PROJECT_ROOT, env: childEnv({ PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }),
    timeoutMs: TIMEOUT_MS,
  })
  if (res.code !== 0) throw new Error(`python --list-methods 失败: ${res.stderr.slice(0, 400)}`)
  return JSON.parse(res.stdout).methods
}

async function runFixture(spec, rawDir, tempTag) {
  const fixture = JSON.parse(fs.readFileSync(spec.file, 'utf8'))
  const mocks = (fixture.mocks || []).join(',')
  const sharedEnv = {
    HARBOR_DIFF_MOCK_TABLE: MOCK_TABLE,
    HARBOR_DIFF_MOCKS: mocks,
    HARBOR_DIFF_DIALOG_REL: 'out/report.txt',
    HARBOR_DIFF_TEMP_TAG: tempTag,
    HARBOR_DIFF_KEEP_TEMP: process.env.HARBOR_DIFF_KEEP_TEMP === '1' ? '1' : '0',
  }

  const pyResultPath = path.join(rawDir, `${fixture.id}.py.json`)
  const nodeResultPath = path.join(rawDir, `${fixture.id}.node.json`)

  const pyRun = await spawnAsync(PYTHON_BIN, [PY_DRIVER, spec.file, '--result', pyResultPath], {
    cwd: PROJECT_ROOT,
    env: childEnv({ ...sharedEnv, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }),
    timeoutMs: TIMEOUT_MS,
  })
  const nodeRun = await spawnAsync(NODE_BIN,
    [...(mocks.includes('subprocess') ? ['--import', pathToFileURL(PRELOAD).href] : []), NODE_DRIVER, spec.file, '--result', nodeResultPath], {
      cwd: PROJECT_ROOT,
      env: childEnv(sharedEnv),
      timeoutMs: TIMEOUT_MS,
    })

  const readResult = p => {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
  }
  const pyResult = readResult(pyResultPath)
  const nodeResult = readResult(nodeResultPath)

  const errors = []
  if (pyRun.code !== 0) errors.push(`python driver exit=${pyRun.code}${pyRun.timedOut ? '（超时）' : ''}: ${pyRun.stderr.slice(0, 300)}`)
  if (nodeRun.code !== 0) errors.push(`node driver exit=${nodeRun.code}${nodeRun.timedOut ? '（超时）' : ''}: ${nodeRun.stderr.slice(0, 300)}`)

  if (!pyResult || !nodeResult) {
    return {
      fixture, error: errors.join(' | ') || '双侧驱动结果缺失', verdicts: [],
      pyResult, nodeResult,
    }
  }

  const rules = loadRules()
  const deltaRegistry = loadIntentionalDeltas()
  const pyById = new Map(pyResult.calls.map(c => [c.id, { ...c, meta: pyResult.meta }]))
  const nodeById = new Map(nodeResult.calls.map(c => [c.id, { ...c, meta: nodeResult.meta }]))
  const allCalls = [
    ...(fixture.setup?.callsBefore || []),
    ...(fixture.calls || []),
  ]
  const verdicts = allCalls.map(call => compareCall(
    fixture, call, pyById.get(call.id), nodeById.get(call.id), rules, deltaRegistry))
  verdicts.push(...compareSideEffects(fixture, pyResult, nodeResult, rules))
  return { fixture, error: null, verdicts, pyResult, nodeResult }
}

async function computeCoverage() {
  const nodeMethodSet = new Set(listMethods())
  const pythonMethods = await runPythonListMethods()
  const pythonSet = new Set(pythonMethods)
  const uncovered = JSON.parse(fs.readFileSync(path.join(DIFF_DIR, 'uncovered.json'), 'utf8'))
  const uncoveredMethods = new Set((uncovered.entries || []).map(e => e.method))
  const coveredByFixtures = new Set()
  // T05 门禁常规化：静态口径——扫描全部 fixture 文件（不依赖本轮实际跑了哪些族），
  // 与「fixture 覆盖 ∪ uncovered 登记 = 145」的验收定义一致
  for (const spec of discoverFixtures([])) {
    try {
      const fixture = JSON.parse(fs.readFileSync(spec.file, 'utf8'))
      for (const call of [...(fixture.setup?.callsBefore || []), ...(fixture.calls || [])]) {
        coveredByFixtures.add(call.method)
      }
    } catch { /* 坏 fixture 由差分运行期报 error，这里跳过 */ }
  }
  const universe = new Set([...nodeMethodSet, ...pythonSet])
  const covered = new Set([...coveredByFixtures].filter(m => universe.has(m)))
  const gaps = [...universe].filter(m => !covered.has(m) && !uncoveredMethods.has(m)).sort()
  return {
    nodeMethods: nodeMethodSet.size,
    pythonMethods: pythonSet.size,
    universe: universe.size,
    coveredByFixtures: covered.size,
    registeredUncovered: [...uncoveredMethods].filter(m => universe.has(m)).length,
    fixtureMethodsNotInRegistry: [...coveredByFixtures].filter(m => !universe.has(m)).sort(),
    gaps,
  }
}

/* ---------------- 主流程 ---------------- */
const args = parseArgs(process.argv)
if (args.keepTemp) process.env.HARBOR_DIFF_KEEP_TEMP = '1'
const startedAt = new Date()
const runId = startedAt.toISOString().replace(/\D/g, '').slice(0, 14)
const outDir = path.join(PROJECT_ROOT, 'outputs', 'diff', runId)
const rawDir = path.join(outDir, 'raw')
fs.mkdirSync(rawDir, { recursive: true })

const families = args.all ? [] : (args.families.length ? args.families : config.defaultFamilies || [])
const fixtureSpecs = discoverFixtures(families)
if (!fixtureSpecs.length) {
  console.error('没有匹配的 fixture（家族顺序见 tools/diff/diff-config.json）')
  process.exit(2)
}

console.log(`[diff] runId=${runId} fixtures=${fixtureSpecs.length} families=[${[...new Set(fixtureSpecs.map(s => s.family))].join(',')}]`)
const tempTag = `harbor-diff-${runId}`
const results = []
let infraErrors = 0
for (const spec of fixtureSpecs) {
  process.stdout.write(`[diff] ${spec.family}/${path.basename(spec.file)} … `)
  const result = await runFixture(spec, rawDir, tempTag)
  const counts = result.verdicts.reduce((acc, v) => { acc[v.verdict] = (acc[v.verdict] || 0) + 1; return acc }, {})
  if (result.error) infraErrors += 1
  console.log(`match=${counts.match || 0} intentional=${counts.intentional || 0} `
    + `suspect=${counts.suspect || 0} error=${counts.error || 0}${result.error ? ' [DRIVER-ERROR]' : ''}`)
  results.push(result)
  // 双侧驱动已退出（句柄全释放）：清扫本轮临时根，零残留
  sweepTempRoots(tempTag)
}

let coverage = null
if (args.coverage) {
  try {
    coverage = await computeCoverage()
  } catch (error) {
    console.error(`[diff] 覆盖率计算失败: ${error.message}`)
    infraErrors += 1
  }
}

const finishedAt = new Date()
const reportJson = buildReportJson({
  runId, fixtures: results, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
  config: { pythonBin: PYTHON_BIN, nodeBin: NODE_BIN }, coverage,
})
const uncoveredEntries = JSON.parse(fs.readFileSync(path.join(DIFF_DIR, 'uncovered.json'), 'utf8')).entries || []
const reportMd = renderMarkdown(reportJson, uncoveredEntries)
const { jsonPath, mdPath } = writeReports(outDir, reportJson, reportMd)

const s = reportJson.summary
console.log('')
console.log(`[diff] 完成：fixtures=${s.fixtures} calls=${s.calls} `
  + `match=${s.match} intentional=${s.intentional} suspect=${s.suspect} error=${s.error} skipped=${s.skipped}`)
if (coverage) {
  console.log(`[diff] 覆盖率：fixture 覆盖 ${coverage.coveredByFixtures}/${coverage.universe}，`
    + `uncovered 登记 ${coverage.registeredUncovered}，缺口 ${coverage.gaps.length}`)
  if (coverage.gaps.length) console.log(`[diff] 缺口方法：${coverage.gaps.join(', ')}`)
}
console.log(`[diff] report: ${mdPath}`)

let exitCode = 0
if (s.suspect > 0) exitCode = 1
if (infraErrors > 0 || s.error > 0) exitCode = 2
if (args.coverage && coverage && coverage.gaps.length) exitCode = exitCode === 0 ? 1 : exitCode
process.exit(exitCode)
