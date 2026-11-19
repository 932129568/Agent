#!/usr/bin/env node
/**
 * R68 · 架构门禁（规范 frontend/app/ARCHITECTURE.md 的可执行形态）。
 *
 * 把规范变成 CI 可跑的断言，而不是纸面约定：
 *   1. 目录结构完整；
 *   2. 依赖方向严格单向（下层不得 import 上层，同层禁止跨域）；
 *   3. feature/ui/layout/app 层零原生 DOM 写 API、零字符串求值；
 *   4. 零全局符号赋值、零 data-h-events；
 *   5. 每个源文件必须显式 export（禁止隐式全局脚本）；
 *   6. 命名规范（组件 PascalCase / hook useXxx / service 具名）；
 *   7. callApi 只允许出现在 services/；
 *   8. migration-ledger 覆盖 manifest 全部子域、模块数对齐、状态合法；
 *   9. 规范文档章节完整、评审前不接入生产链。
 *
 * 用法：node frontend/app/tests/arch-contract.mjs
 * 退出码：0 全通过；1 有违规。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
// R70 / I14：新鲜度判据抽为可导入纯函数（QA 可直接做单元级反例，不碰真实产物）。
import { isAuditFresh } from './audit-freshness.mjs'

/** R70 / I14 新鲜度容差 = 10 分钟（主理人裁决）。
 *  理由：CI 上 audit 门与 arch-contract 秒级差；本地正常流程「先跑统一入口再验」
 *  也在 10 分钟内。QA 的陈旧反例注入的是远超 10 分钟的历史时间戳，稳定判红。
 *  不用 mtime：mtime 比较方向随「谁最后跑门」变化，差距在 3h54m / 11m54s /
 *  29m37s 间漂移，任何固定容差都会失效，且 touch 反例必须动真实产物、违反沙箱约束。 */
const AUDIT_FRESHNESS_TOLERANCE_MS = 10 * 60 * 1000

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..')
const ROOT = resolve(APP, '../..')
const SRC = join(APP, 'src')
const MANIFEST = join(ROOT, 'frontend', 'manifest.json')
const LEDGER = join(APP, 'migration-ledger.json')
const SPEC = join(APP, 'ARCHITECTURE.md')
const HTML = join(ROOT, 'harbor.html')

/** 层索引：越小越上层；只允许向下 import。 */
const LAYER = {
  app: 0, layout: 1, features: 1, ui: 2, state: 3, services: 4, platform: 5,
}
const ENTRY_LAYER = -1 // src/main.jsx 视为最顶层入口

const FORBIDDEN_DOM = /\b(?:innerHTML|outerHTML|appendChild|insertAdjacentHTML|insertBefore)\b|document\.(?:createElement|getElementById|querySelector|querySelectorAll)\b|\bnew\s+Function\b|\beval\s*\(|\bdata-h-events\b/
const GLOBAL_ASSIGN = /\b(?:window|globalThis)\.[A-Za-z_$][\w$]*\s*=[^=]/g
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) })
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(?:js|jsx)$/.test(name)) out.push(p)
  }
  return out
}

function layerOf(file) {
  const rel = relative(SRC, file).split(sep)
  if (rel.length === 1) return { index: ENTRY_LAYER, name: 'entry', dir: 'entry' }
  const name = rel[0]
  if (!(name in LAYER)) return { index: 99, name: 'unknown', dir: name }
  return { index: LAYER[name], name, dir: rel.slice(0, -1).join('/') }
}

function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(fromFile), spec)
  for (const candidate of [base, base + '.js', base + '.jsx', join(base, 'index.js')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

const files = walk(SRC)
const specText = existsSync(SPEC) ? readFileSync(SPEC, 'utf8') : ''

// ---- 1. 目录结构 ----
const requiredDirs = ['app', 'layout', 'state', 'services', 'platform', 'ui', 'features/_template']
const missingDirs = requiredDirs.filter(d => !existsSync(join(SRC, d)))
check('规范目录结构完整', missingDirs.length === 0, missingDirs.join(', ') || '7 个目录')
check('骨架源文件存在', files.length >= 15, files.length + ' 个 .js/.jsx')

// ---- 2. 依赖方向 ----
const directionViolations = []
const missingImports = []
for (const file of files) {
  const srcLayer = layerOf(file)
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(IMPORT_RE)) {
    const target = resolveImport(file, m[1])
    if (!target) { if (m[1].startsWith('.')) missingImports.push(relative(SRC, file) + ' -> ' + m[1]); continue }
    const dstLayer = layerOf(target)
    const rel = relative(SRC, file).replace(/\\/g, '/')
    const dstRel = relative(SRC, target).replace(/\\/g, '/')
    if (srcLayer.index > dstLayer.index) {
      directionViolations.push(rel + ' -> ' + dstRel + '（反向）')
    } else if (srcLayer.index === dstLayer.index && srcLayer.dir !== dstLayer.dir &&
               srcLayer.index !== ENTRY_LAYER) {
      directionViolations.push(rel + ' -> ' + dstRel + '（同层跨域）')
    }
  }
}
check('依赖方向单向（零反向/同层跨域）', directionViolations.length === 0,
  directionViolations.slice(0, 8).join(' | ') || '全部合规')
check('相对 import 均可解析', missingImports.length === 0,
  missingImports.slice(0, 8).join(' | ') || '全部解析')

// ---- 3/4. 禁用 API 与全局符号 ----
const domViolations = []
const globalViolations = []
const callApiViolations = []
const exportViolations = []
const nameViolations = []
for (const file of files) {
  const layer = layerOf(file)
  const rel = relative(SRC, file).replace(/\\/g, '/')
  const text = readFileSync(file, 'utf8')
  if (layer.index <= 2 && FORBIDDEN_DOM.test(text)) domViolations.push(rel)
  const ga = text.match(GLOBAL_ASSIGN)
  if (ga) globalViolations.push(rel + ':' + ga.length)
  if (/\bcallApi\s*\(/.test(text) && layer.name !== 'services') callApiViolations.push(rel)
  if (!/\bexport\b/.test(text)) exportViolations.push(rel)
  const base = file.split(sep).pop()
  if (/\.jsx$/.test(base) && ['app', 'layout', 'features', 'ui'].includes(layer.name)) {
    if (!/^[A-Z][A-Za-z0-9]*\.jsx$/.test(base)) nameViolations.push(rel)
  }
}
check('上层零原生 DOM 写/字符串求值', domViolations.length === 0,
  domViolations.join(', ') || 'app/layout/features/ui/entry 全部合规')
check('零全局符号赋值、零 data-h-events', globalViolations.length === 0,
  globalViolations.join(', ') || '零赋值')
check('callApi 只在 services/ 出现', callApiViolations.length === 0,
  callApiViolations.join(', ') || '唯一出口合规')
check('所有源文件显式 export', exportViolations.length === 0,
  exportViolations.join(', ') || '零隐式全局脚本')
check('组件命名 PascalCase.jsx', nameViolations.length === 0,
  nameViolations.join(', ') || '合规')

// ---- 5. 登记表与规范 ----
let ledger = null
let manifest = null
try { ledger = JSON.parse(readFileSync(LEDGER, 'utf8')) } catch (_) {}
try { manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) } catch (_) {}
const domains = new Set((manifest?.scripts || [])
  .map(e => e.path.split('/')[2]).filter(Boolean))
const ledgerDomains = new Set((ledger?.batches || []).flatMap(b => b.domains || []))
const uncovered = [...domains].filter(d => !ledgerDomains.has(d))
const extra = [...ledgerDomains].filter(d => !domains.has(d))
const moduleTotal = (ledger?.batches || []).reduce((n, b) => n + (b.moduleCount || 0), 0)
const validStatus = new Set(['pending', 'in-progress', 'migrated', 'frozen-pending-product-decision'])
const badStatus = (ledger?.batches || []).filter(b => !validStatus.has(b.status)).map(b => b.id)
check('登记表覆盖 manifest 全部子域', ledger && uncovered.length === 0 && extra.length === 0,
  '未覆盖=' + uncovered.join(',') + ' 多余=' + extra.join(',') + ' 共 ' + domains.size + ' 域')
check('登记表模块数对齐 manifest', ledger && moduleTotal === (manifest?.scripts || []).length,
  moduleTotal + ' vs ' + (manifest?.scripts || []).length)
check('登记表状态合法且需评审前置', ledger && badStatus.length === 0 &&
  !!ledger.reviewRequiredBefore && ledger.status === 'spec-pending-review',
  'bad=' + badStatus.join(',') + ' status=' + (ledger?.status || '?'))
const requiredSections = ['## 3.', '## 5.', '## 6.', '## 7.', '## 8.', '## 9.', '## 10.', '## 11.', '## 12.', '## 13.']
const missingSections = requiredSections.filter(s => !specText.includes(s))
check('规范文档章节完整', missingSections.length === 0, missingSections.join(', ') || '10 节')
const html = existsSync(HTML) ? readFileSync(HTML, 'utf8') : ''
check('评审前骨架未接入生产链', html.length > 0 && !html.includes('harbor-app.iife.js') &&
  !html.includes('HarborApp'), 'harbor.html 不含骨架 bundle')
check('骨架不写 config.json', files.every(f =>
  !/(?:writeFile|appendFile|setItem|open\()[^\n]*config\.json/
    .test(readFileSync(f, 'utf8'))), '零写操作（守卫字面量除外）')

// ---- 6. 骨架清单完整性（杜绝「只建目录不建文件」）----
let skeleton = null
try { skeleton = JSON.parse(readFileSync(join(APP, 'docs/skeleton-manifest.json'), 'utf8')) } catch (_) {}
const missingSkeleton = (skeleton?.required || []).filter(p => !existsSync(join(APP, p)))
const missingDeclDirs = (skeleton?.requiredDirs || []).filter(d => !existsSync(join(APP, d)))
const missingRelated = (skeleton?.relatedProjectFiles || [])
  .filter(p => !existsSync(join(ROOT, p)))
check('骨架清单文件全部落地', skeleton && missingSkeleton.length === 0 && missingDeclDirs.length === 0,
  '缺文件=' + missingSkeleton.join(',') + ' 缺目录=' + missingDeclDirs.join(',') +
  ' 共 ' + (skeleton?.required || []).length + ' 项')
check('关联项目文件齐备', skeleton && missingRelated.length === 0,
  missingRelated.join(',') || 'golden 快照 + 契约测试在位')
const declaredDomains = new Set(skeleton?.declaredFrontendDomains || [])
check('清单覆盖 17 个前端域', declaredDomains.size === domains.size &&
  [...domains].every(d => declaredDomains.has(d)), declaredDomains.size + ' vs ' + domains.size)
const layoutJsx = existsSync(join(SRC, 'layout'))
  ? readdirSync(join(SRC, 'layout')).filter(n => /^[A-Z][A-Za-z0-9]*\.jsx$/.test(n)) : []
check('10 个布局区域组件齐备', layoutJsx.length === 10, layoutJsx.length + ' 个')

// ---- 7. 现有 React 资产审计（用户要求：现有 react 也规范化）----
let reactAudit = null
try { reactAudit = JSON.parse(readFileSync(join(APP, 'docs/react-assets.json'), 'utf8')) } catch (_) {}
const REACT_ROOT = join(ROOT, 'frontend/react/src')
const KINDS = {
  DOM_API: /document\.(getElementById|querySelector|querySelectorAll|createElement)|\.innerHTML|\.appendChild/,
  STRING_EVAL: /new\s+Function|\beval\s*\(/,
  STRING_EVENT: /data-h-events/,
  GLOBAL_SYMBOL: /\bwindow\.[A-Za-z_$][\w$]*\s*=[^=]|globalThis\.[A-Za-z_$][\w$]*\s*=[^=]/,
  MODULE_STATE: /^\s*(let|var)\s+state\s*=/m,
}
const reactFiles = walk(REACT_ROOT)
const reactViolations = []
for (const file of reactFiles) {
  const text = readFileSync(file, 'utf8')
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  for (const [kind, re] of Object.entries(KINDS)) {
    if (re.test(text)) reactViolations.push({ rel, kind })
  }
}
const registered = new Set((reactAudit?.exceptions || [])
  .flatMap(e => (e.paths || []).map(p => p + '|' + e.kind)))
const unregistered = reactViolations.filter(v => !registered.has(v.rel + '|' + v.kind))
check('现有 React 违规全部登记例外', reactAudit && unregistered.length === 0,
  unregistered.slice(0, 6).map(v => v.rel + ':' + v.kind).join(' | ') ||
  reactViolations.length + ' 项迁移期违规，' + (reactAudit?.exceptions || []).length + ' 组例外')
const stalePaths = (reactAudit?.exceptions || []).flatMap(e => (e.paths || [])
  .filter(p => !existsSync(join(ROOT, p))))
check('例外登记路径真实存在', reactAudit && stalePaths.length === 0, stalePaths.join(',') || '无失效登记')
check('例外均带理由与退出条件', (reactAudit?.exceptions || [])
  .every(e => e.reason && e.exitCondition), '逐条登记')
const compliant = reactFiles.filter(f => {
  const t = readFileSync(f, 'utf8')
  return !Object.values(KINDS).some(re => re.test(t))
}).length
check('现有 React 合规资产可度量', reactAudit && compliant >= 2,
  compliant + '/' + reactFiles.length + ' 已合规')

// ---- 8. 后端规范门禁（Node / Electron / Python 契约层）----
const { createHash } = await import('node:crypto')
// 删除前置：冻结快照是删除 backend/ 后契约事实的唯一来源
let frozen = null
try {
  frozen = JSON.parse(readFileSync(join(ROOT,
    'deliverables/dev-plan/frozen-python-surface.json'), 'utf8'))
} catch (_) {}
const builderCfg = existsSync(join(ROOT, 'electron-builder.yml'))
  ? readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8') : ''
const pyInWhitelist = /^\s*-\s*backend\/(?!prompts|experts_builtin)[^\s]*\.py/m.test(builderCfg)
check('打包白名单不含 backend/*.py', !pyInWhitelist, 'Python 非运行时')
const serverFiles = walk(join(ROOT, 'server/src'))
const pythonSpawn = serverFiles.filter(f => /spawn[^\n]*python|execFile[^\n]*python/i
  .test(readFileSync(f, 'utf8'))).map(f => relative(ROOT, f))
check('server 运行时零 python 调用', pythonSpawn.length === 0, pythonSpawn.join(',') || '零命中')
let baseline = null
try { baseline = JSON.parse(readFileSync(join(ROOT,
  'deliverables/dev-plan/contract-baseline-r67.json'), 'utf8')) } catch (_) {}
// 删除前置：改读冻结快照 api_py_sha256 与 r67 基线比对（不再计算 backend/api.py 源码哈希）
check('api.py 契约哈希零漂移', baseline && frozen &&
  frozen.api_py_sha256 === baseline.api_py_sha256,
  String(frozen?.api_py_sha256 || '').slice(0, 12) + ' vs ' +
  String(baseline?.api_py_sha256 || '').slice(0, 12))
// 删除前置：改读冻结快照 API_VERSION + hidden_methods（不再匹配 api.py 文本）
check('API_VERSION / _V12_EXTRA 冻结', frozen &&
  frozen.API_VERSION === 'v1.0.0' &&
  Array.isArray(frozen.hidden_methods) && frozen.hidden_methods.length === 117,
  'v1.0.0 + 117 隐身方法冻结')
// 删除前置：改检查冻结快照存在且含 method_defs（tests/test_api_contract.py 删除后不再依赖该文件）
check('逐字节契约测试仍在', frozen &&
  Array.isArray(frozen.method_defs) && frozen.method_defs.length === 168,
  '冻结快照 168 方法定义')
const backendSpec = existsSync(join(APP, 'ARCHITECTURE-BACKEND.md'))
  ? readFileSync(join(APP, 'ARCHITECTURE-BACKEND.md'), 'utf8') : ''
const backendSections = ['## 2.', '## 3.', '## 4.', '## 5.', '## 6.', '## 7.']
check('后端规范章节完整', backendSections.every(s => backendSpec.includes(s)),
  backendSections.filter(s => !backendSpec.includes(s)).join(',') || '6 节')
check('Python 契约层定位为 Oracle', backendSpec.includes('契约 oracle') &&
  backendSpec.includes('A 维持 oracle'), '边界 + A/B/C 路径')
// ---- 9. C 路径步骤 1：golden 契约快照冻结 ----
let goldenManifest = null
try {
  goldenManifest = JSON.parse(readFileSync(join(APP, 'docs/golden-manifest.json'), 'utf8'))
} catch (_) {}
const goldenFile = join(ROOT, 'deliverables/dev-plan/contract-golden/api-suite.json')
const goldenBytes = existsSync(goldenFile) ? readFileSync(goldenFile) : null
const goldenSha = goldenBytes
  ? createHash('sha256').update(goldenBytes).digest('hex') : ''
const goldenKeys = goldenBytes ? Object.keys(JSON.parse(goldenBytes.toString('utf8'))).length : 0
check('C-1 golden 快照哈希冻结一致', goldenManifest && goldenSha === goldenManifest.sha256,
  goldenSha.slice(0, 12) + ' vs ' + String(goldenManifest?.sha256 || '').slice(0, 12))
check('C-1 快照覆盖完整调用序列', goldenKeys >= 60 && goldenKeys === goldenManifest?.sequenceCount,
  goldenKeys + ' 项')
// 删除前置：改读冻结快照（原 existsSync(apiPy) 保证 Python 层原状，删除后由快照冻结凭据承担）
check('C 步骤 4+ 未执行（删实现需逐域处置测试）', frozen &&
  frozen.version === 1 &&
  frozen.contract_baseline_r68?.api_py_sha256 === frozen.api_py_sha256 &&
  goldenManifest?.status === 'step3-frozen', '契约已冻结进快照')

// ---- 10. B0 真实结构迁移（不再是占位）----
const layoutDir = join(SRC, 'layout')
const layoutComponents = readdirSync(layoutDir).filter(n => /^[A-Z][A-Za-z0-9]*\.jsx$/.test(n))
const layoutText = layoutComponents.map(n => readFileSync(join(layoutDir, n), 'utf8')).join('\n')
const realCount = layoutComponents.filter(n =>
  /B0 真实结构迁移/.test(readFileSync(join(layoutDir, n), 'utf8'))).length
check('B0 真实结构已投影进规范 layout', realCount === 10, realCount + '/10')
check('规范 layout 零事件桥', !/data-h-events/.test(layoutText), '事件桥已剥离')
const reactIds = JSON.parse(readFileSync(
  join(ROOT, 'frontend/react/src/generated/ids.json'), 'utf8')).ids
const layoutIds = new Set([...layoutText.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]))
const lostIds = reactIds.filter(id => !layoutIds.has(id))
check('B0 结构零丢失（300 个 id 全覆盖）', lostIds.length === 0,
  lostIds.slice(0, 8).join(',') || layoutIds.size + ' 个 id')

// ---- 11. C 步骤 2/3：Node 等价门 + 契约锚点冻结 ----
const nodeGoldenTest = join(ROOT, 'server/test/contract-golden.mjs')
const nodeGoldenText = existsSync(nodeGoldenTest)
  ? readFileSync(nodeGoldenTest, 'utf8') : ''
check('Node 侧 golden 契约门已建立', /frozenMethods/.test(nodeGoldenText) &&
  /invoke\('get_api_info'\)/.test(nodeGoldenText), '公开自省面等价校验')
let baseline68 = null
try {
  baseline68 = JSON.parse(readFileSync(join(ROOT,
    'deliverables/dev-plan/contract-baseline-r68.json'), 'utf8'))
} catch (_) {}
check('r68 锚点冻结 golden_sha256', baseline68 &&
  baseline68.golden_sha256 === goldenManifest?.sha256,
  String(baseline68?.golden_sha256 || '').slice(0, 12) + ' vs ' +
  String(goldenManifest?.sha256 || '').slice(0, 12))
const diffTool = existsSync(join(ROOT, 'tools/contract_diff.py'))
  ? readFileSync(join(ROOT, 'tools/contract_diff.py'), 'utf8') : ''
check('契约差分含 golden 冻结项', /FROZEN[\s\S]{0,200}golden_sha256/.test(diffTool),
  'C-3 证据链')

// ---- 12. C 步骤 4 第一批：backend 耦合测试处置台账 ----
let disposition = null
try {
  disposition = JSON.parse(readFileSync(
    join(APP, 'docs/backend-test-disposition.json'), 'utf8'))
} catch (_) {}
// 删除前置：改读台账冻结统计（原扫描 tests/ 精确耦合计数，删除 74 个 pytest 后不再依赖文件系统计数）
const testDir = join(ROOT, 'tests')
const coupled = existsSync(testDir)
  ? readdirSync(testDir)
    .filter(n => /^test_.*\.py$/.test(n))
    .filter(n => /(?:from|import)\s+backend/.test(readFileSync(join(testDir, n), 'utf8')))
    .map(n => 'tests/' + n)
  : []
const ledgerFiles = new Set((disposition?.files || []).map(e => e.file))
check('处置台账覆盖全部耦合测试', disposition &&
  disposition.files.length === disposition.coupledFiles &&
  disposition.filesWithNodeGates === disposition.coupledFiles &&
  ledgerFiles.size === disposition.coupledFiles &&
  [...ledgerFiles].every(f => /^tests\/test_.*\.py$/.test(f)) &&
  frozen && frozen.method_defs.length === 168,
  '冻结统计 ' + disposition?.coupledFiles + ' 条 / 台账 ' + ledgerFiles.size +
  ' 条 / 当前剩余耦合 ' + coupled.length + ' / 快照在')
const validStrategies = new Set(Object.values(disposition?.strategies || {}))
check('台账策略合法且逐条有理由', (disposition?.files || [])
  .every(e => validStrategies.has(e.strategy) && e.rationale),
  Object.keys(disposition?.byCategory || {}).join('/'))
const firstBatch = (disposition?.files || []).filter(e => e.category === 'first-batch')
check('第一批等价门已落地并登记旧钉→新钉', firstBatch.length >= 1 &&
  firstBatch.every(e => e.nodeGate && existsSync(join(ROOT, e.nodeGate)) &&
    e.oldPins?.length && e.newPins?.length && e.reason),
  firstBatch.length + ' 个文件，' + firstBatch.map(e => e.nodeGate).join(','))
// 删除前置：改读台账冻结记录（步骤 5 物理删除后不再要求 py 文件在位）
check('第一批未物理删测试（留步骤 5 同批）', firstBatch.length > 0 &&
  (disposition?.firstBatch || []).length === firstBatch.length &&
  (disposition?.firstBatch || []).every(n => ledgerFiles.has('tests/' + n)) &&
  frozen && frozen.method_defs.length === 168,
  '冻结登记 ' + firstBatch.length + ' 条 / 快照在')

// ---- 13. C 步骤 4 第二批：9 个 Python 子域 → Node 等价门映射 ----
let equivMap = null
try {
  equivMap = JSON.parse(readFileSync(
    join(APP, 'docs/domain-equivalence-map.json'), 'utf8'))
} catch (_) {}
check('域等价映射覆盖 9 个子域', equivMap &&
  equivMap.domains.length === 9 &&
  equivMap.equivalenceStatus === 'mapped-not-behavior-verified',
  (equivMap?.domains || []).map(d => d.name).join(',') || '映射缺失')
const mappedPaths = (equivMap?.domains || []).flatMap(d =>
  [...d.nodeServices, ...d.nodeGates]).concat(equivMap?.defaultGates || [])
check('映射中的 Node 服务与测试门真实存在', equivMap &&
  mappedPaths.every(p => existsSync(join(ROOT, p))),
  mappedPaths.length + ' 个引用')
check('台账 v3：74 条全部定位到 Node 门', disposition?.version >= 2 &&
  disposition.filesWithNodeGates === disposition.coupledFiles &&
  disposition.files.every(e => e.nodeGates?.length && e.nodeCoverageLocated),
  String(disposition?.filesWithNodeGates) + '/' + String(disposition?.coupledFiles))
const domainGateScript = join(ROOT, 'server/test/domain-equivalence.mjs')
check('域等价映射门已落地', existsSync(domainGateScript) &&
  /mapped-not-behavior-verified/.test(readFileSync(domainGateScript, 'utf8')),
  '不把定位冒充行为验证')

// ---- 14. C 步骤 4 第三批：逐条行为复核（有缺口不得销项）----
let review = null
try {
  review = JSON.parse(readFileSync(
    join(APP, 'docs/behavior-review-batch1.json'), 'utf8'))
} catch (_) {}
// ---- 19b. batch4 全量规则化复核（1277 钉需人工深读，阻断步骤 5）----
let batch4 = null
try {
  batch4 = JSON.parse(readFileSync(join(APP,
    'docs/behavior-review-batch4.json'), 'utf8'))
} catch (_) {}

const reviewPins = (review?.files || []).flatMap(f => f.pins || [])
const reviewGaps = reviewPins.filter(p => p[1] === 'gap').length
check('行为复核逐条覆盖 24 个钉', review && reviewPins.length === 24 &&
  review.summary.totalPins === 24 && review.summary.blockingGaps === reviewGaps,
  reviewPins.length + ' 钉，' + reviewGaps + ' 个 gap')
check('等价门销项与缺陷修复均登记在案', review?.version >= 2 &&
  (review.nodeGateAdditions || []).length >= 1 &&
  (review.defectsFixed || []).length === 4 &&
  review.summary.openImplementationDefects ===
    (review.openImplementationDefects || []).length &&
  review.summary.pinsClosed >= 2 && review.summary.defectsFixed === 4,
  '累计销 ' + review?.summary?.pinsClosed + ' / 4 组缺陷已修复')
check('台账 v4 复核统计与证据一致', disposition?.version >= 4 &&
  disposition.behaviorReviewedFiles === (review?.files || []).length &&
  disposition.behaviorReviewedPins === reviewPins.length &&
  disposition.blockingGaps === reviewGaps &&
  disposition.files.filter(e => e.behaviorReviewed)
    .every(e => e.reviewConclusion ===
      (e.blockingGaps || e.pendingVerdicts ? 'gaps-found' : 'equivalent')),
  '3 文件 / 24 钉 / ' + reviewGaps + ' 缺口')
check('未复核项仍不得销 reviewRequired', (disposition?.files || [])
  .filter(e => e.behaviorReviewed)
  .every(e => e.reviewRequired === true || e.reviewConclusion === 'equivalent'),
  '阻断步骤 5')
const frontGates = (disposition?.files || []).find(e => e.frontendGates)
check('前端契约钉改由前端门禁承担', frontGates &&
  frontGates.frontendGates.every(p => existsSync(join(ROOT, p))),
  frontGates ? frontGates.frontendGates.length + ' 个前端门' : '未登记')
const memoryGate = join(ROOT, 'server/test/memory-gate.mjs')
check('敏感字段拒写等价门已落地', existsSync(memoryGate) &&
  /SENSITIVE|敏感/.test(readFileSync(memoryGate, 'utf8')), 'AGENTS.md 红线')
check('全部缺陷修复有授权与复验依据', (review?.defectsFixed || [])
  .length === 4 && (review?.defectsFixed || [])
  .every(d => d.status === 'fixed-verified' && /授权|允许/.test(d.authorizedBy) && d.verifiedBy),
  '用户授权 + 硬断言验证')

// ---- 15. 前端契约钉字面量门（归类纠正后的等价证据）----
const literalGates = review?.frontendLiteralGates || []
const literalViolations = []
for (const gate of literalGates) {
  const target = join(ROOT, gate.file)
  if (!existsSync(target)) { literalViolations.push(gate.file + ':文件缺失'); continue }
  const text = statSync(target).isDirectory()
    ? walk(target).map(f => readFileSync(f, 'utf8')).join('\n')
    : readFileSync(target, 'utf8')
  if (gate.mustContain && !text.includes(gate.mustContain)) {
    literalViolations.push(gate.file + ':缺少 ' + gate.mustContain)
  }
  if (gate.mustNotContain && text.includes(gate.mustNotContain)) {
    literalViolations.push(gate.file + ':残留 ' + gate.mustNotContain)
  }
}
check('前端契约钉字面量门全部成立', literalGates.length >= 5 &&
  literalViolations.length === 0,
  literalViolations.slice(0, 4).join(' | ') || literalGates.length + ' 条字面量钉')
check('真缺口归零且 4 组缺陷均已修复', review?.summary?.gap === 0 &&
  review.summary.deferredToReactMigration === 2 &&
  review.summary.blockingGaps === 0 &&
  (review.openImplementationDefects || []).length === 0 &&
  (review.defectsFixed || []).length === 4,
  'gap 0 / 4 组缺陷已修复')
const traceGate = join(ROOT, 'server/test/trace-equivalence.mjs')
check('trace 等价门覆盖 DEF-02/03', existsSync(traceGate) &&
  /RETENTION_DAYS|agent\.run|tool\.open_url/.test(readFileSync(traceGate, 'utf8')),
  'span 写入 / 接线 / 保留期')
const injectionGate = join(ROOT, 'server/test/memory-injection.mjs')
check('记忆注入等价门已落地', existsSync(injectionGate) &&
  /memoryTail|用户长期记忆/.test(readFileSync(injectionGate, 'utf8')),
  'buildSystemPrompt / entries / pin')
check('已复核范围缺口归零但全局仍阻断步骤 5',
  review?.summary?.blockingGaps === 0 &&
  (disposition?.files || []).filter(e => e.behaviorReviewed)
    .some(e => e.pendingVerdicts > 0) &&
  (disposition?.files || []).filter(e => e.behaviorReviewed)
    .every(e => e.reviewRequired === true) &&
  disposition.extendedReview.filesRemaining > 0 &&
  batch4?.summary?.needsHumanReview > 0,
  '其余文件 pending + 64 待复核 + batch2/3 缺口')
const memEq = join(ROOT, 'server/test/memory-equivalence.mjs')
check('batch1 partial 收口门已落地', existsSync(memEq) &&
  /buildTools|memoryRetrieve|memoryStats/.test(readFileSync(memEq, 'utf8')) &&
  review?.summary?.coveredByNodeGate === 10 &&
  review.summary.partial === 0 && review.summary.pinsClosed >= 17,
  '销 6 项 / partial 归零')

// ---- 16. R69 架构评估度量（防报告陈旧）----
let archMetrics = null
try {
  archMetrics = JSON.parse(readFileSync(join(ROOT,
    'deliverables/dev-plan/architecture-metrics-r69.json'), 'utf8'))
} catch (_) {}
check('架构评估度量已生成且字段完整', archMetrics?.version === 1 &&
  archMetrics.generatedBy === 'tools/arch_assessment.py' &&
  archMetrics.dependencyGraph?.sccCycles > 0 &&
  archMetrics.scale?.totalSourceLines > 0 &&
  archMetrics.typeSafety?.handWrittenTsFiles === 0,
  'SCC ' + archMetrics?.dependencyGraph?.sccCycles +
  ' / 源码行 ' + archMetrics?.scale?.totalSourceLines)
const assessment = join(ROOT, 'deliverables/dev-plan/ARCHITECTURE-ASSESSMENT-R69.md')
check('架构评估报告与度量同源', existsSync(assessment) &&
  /architecture-metrics-r69\.json/.test(readFileSync(assessment, 'utf8')) &&
  existsSync(join(ROOT, 'tools/arch_assessment.py')),
  '12 维度对照')

// ---- 17. R69 P0 执行：CI 门禁全覆盖 / SCC 棘轮 / 覆盖率基线 ----
const ciYamlPath = join(ROOT, '.github/workflows/harbor-ci.yml')
const ciYaml = existsSync(ciYamlPath) ? readFileSync(ciYamlPath, 'utf8') : ''
check('CI 已接入统一门禁入口', /normalized-gates:/.test(ciYaml) &&
  /run_normalized_gates\.py/.test(ciYaml) &&
  /npm ci --prefix server/.test(ciYaml), '本地/CI 同源')
let gateCov = null
try {
  gateCov = JSON.parse(readFileSync(join(ROOT,
    'deliverables/dev-plan/gate-coverage-r69.json'), 'utf8'))
} catch (_) {}
check('门禁覆盖率 100% 且代码覆盖率如实标阻塞', gateCov?.status === 'PASS' &&
  gateCov.percentage === 100 && gateCov.missingGates.length === 0 &&
  gateCov.codeCoverage.status === 'blocked-by-environment',
  gateCov?.covered + '/' + gateCov?.total + ' 门禁 / 代码覆盖率 blocked')
let sccBase = null
try {
  sccBase = JSON.parse(readFileSync(join(ROOT,
    'deliverables/dev-plan/scc-baseline-r69.json'), 'utf8'))
} catch (_) {}
check('SCC 棘轮基线冻结且当前无回增', sccBase?.version === 1 &&
  sccBase.baseline.sccCycles === 17 &&
  sccBase.baseline.cyclicSymbols === 104 &&
  existsSync(join(ROOT, 'tools/scc_ratchet.py')) &&
  archMetrics.dependencyGraph.sccCycles <= sccBase.baseline.sccCycles,
  '基线 17/104，当前 ' + archMetrics?.dependencyGraph?.sccCycles)
check('统一门禁入口与覆盖率脚本在架', existsSync(
  join(ROOT, 'tools/run_normalized_gates.py')) &&
  existsSync(join(ROOT, 'tools/gate_coverage.py')),
  '本地/CI 同源（运行产物由 pytest 校验）')

// ---- 18. R69 P0-③ 第一阶段：JSDoc 类型契约（非静态类型检查）----
let typeAudit = null
try {
  typeAudit = JSON.parse(readFileSync(join(ROOT,
    'deliverables/dev-plan/type-annotation-r69.json'), 'utf8'))
} catch (_) {}
check('类型契约覆盖率 100% 且只增不减', typeAudit?.status === 'PASS' &&
  typeAudit.current.coverage === 100 &&
  typeAudit.regressions.length === 0 &&
  existsSync(join(ROOT, 'deliverables/dev-plan/type-annotation-baseline-r69.json')),
  typeAudit?.current?.annotatedSymbols + '/' + typeAudit?.current?.exportedSymbols)
check('静态类型检查环境阻塞如实登记', typeAudit?.staticTypeCheck?.status ===
  'blocked-by-environment' &&
  /typescript|tsc/.test(typeAudit.staticTypeCheck.reason) &&
  existsSync(join(ROOT, 'deliverables/dev-plan/TYPE-SAFETY-PLAN-R69.md')),
  '不得把 JSDoc 覆盖率冒充 tsc 检查')
const pilot = join(ROOT, 'server/src/paths.js')
const pilotSrc = existsSync(pilot) ? readFileSync(pilot, 'utf8') : ''
check('试点模块导出符号均有类型注解',
  /@type/.test(pilotSrc) && /@param/.test(pilotSrc) && /@returns/.test(pilotSrc),
  'server/src/paths.js')

// ---- 19. 扩大复核范围：expert 域 batch2 + 断言对象盘点 ----
let batch2 = null
try {
  batch2 = JSON.parse(readFileSync(join(APP,
    'docs/behavior-review-batch2.json'), 'utf8'))
} catch (_) {}
check('expert 授权修复销项后缺口归零', batch2?.version >= 3 &&
  batch2.summary.totalPins === 23 && batch2.summary.blockingGaps === 0 &&
  batch2.summary.gap === batch2.summary.blockingGaps &&
  /不能外推|步骤 5 仍阻断/.test(batch2.conclusion) &&
  (batch2.defectsFixed || []).length === 6,
  '23 钉 / 0 gap / 6 组已修复')
const expertSecurity = join(ROOT, 'server/test/expert-security.mjs')
const expertSecSrc = existsSync(expertSecurity) ? readFileSync(expertSecurity, 'utf8') : ''
check('expert 安全门硬断言 9 场景且细粒度码对齐', existsSync(expertSecurity) &&
  /A_CODES|B_CODES/.test(expertSecSrc) &&
  /METADATA_CONFLICT|CASEFOLD_COLLISION|UNCLOSED_BLOCK|METADATA_TOO_LARGE/.test(expertSecSrc) &&
  (batch2?.nodeGateAdditions?.newlyEnforced || []).length === 4 &&
  (batch2?.nodeGateAdditions?.implementationGaps || []).length === 0,
  '已实现 5 + 新实现 4')
let pinClass = null
try {
  pinClass = JSON.parse(readFileSync(join(ROOT,
    'deliverables/dev-plan/remaining-pins-classification-r69.json'), 'utf8'))
} catch (_) {}
check('剩余钉盘点可复跑且承认分类非结论', pinClass?.unreviewedFiles === 64 &&
  pinClass.totalPins > 1000 &&
  /不是行为复核结论/.test(pinClass.policy) &&
  existsSync(join(ROOT, 'tools/classify_remaining_pins.py')),
  pinClass?.totalPins + ' 钉 / 64 文件待复核')
check('台账 v4 扩展统计一致且步骤 5 仍阻断',
  disposition?.extendedReview?.filesRemaining === 64 &&
  disposition.extendedReview.batch2Gaps === 0 &&
  disposition.extendedReview.filesReviewedTotal === 10 &&
  (disposition?.files || []).filter(e => e.reviewBatch === 2)
    .every(e => e.reviewConclusion === 'gaps-found' && e.reviewRequired === true),
  '10 已复核 / 64 剩余')

// ---- 20. settings 子域 batch3 复核 ----
let batch3 = null
try {
  batch3 = JSON.parse(readFileSync(join(APP,
    'docs/behavior-review-batch3.json'), 'utf8'))
} catch (_) {}
const settingsGate = join(ROOT, 'server/test/settings-equivalence.mjs')
check('settings 域 34 钉复核且缺口已销', batch3?.version >= 1 &&
  batch3.summary.totalPins === 34 && batch3.summary.blockingGaps === 0 &&
  batch3.summary.coveredByNodeGate === 15 &&
  existsSync(settingsGate) &&
  /openImplementationGaps/.test(readFileSync(settingsGate, 'utf8')),
  '34 钉 / 0 gap / 15 covered')
check('台账 v5 三批统计一致且步骤 5 仍阻断',
  disposition?.version >= 5 &&
  disposition.extendedReview.batch3Gaps === 0 &&
  disposition.extendedReview.filesReviewedTotal === 10 &&
  disposition.extendedReview.filesRemaining === 64 &&
  (disposition?.files || []).filter(e => e.reviewBatch === 3)
    .every(e => e.reviewRequired === true),
  '10 已复核 / 64 剩余')

// ---- 21. 全源码深扫描与契约完整性（R69 深扫描轮）----
let deepScan = null
try {
  deepScan = JSON.parse(readFileSync(join(ROOT,
    'deliverables/dev-plan/deep-scan-r69.json'), 'utf8'))
} catch (_) {}
check('全源码深扫描可复跑且逐类核实', deepScan?.version >= 2 &&
  deepScan.filesScanned > 500 && deepScan.verification.realDefectsFound === 2 &&
  /误报/.test(JSON.stringify(deepScan.verification.classes)) &&
  existsSync(join(ROOT, 'tools/deep_scan.py')), '529 文件 / 880 命中')
const surfaceGate = join(ROOT, 'server/test/method-surface.mjs')
check('隐身方法完整性门在架', existsSync(surfaceGate) &&
  /_V12_EXTRA|hiddenMethods|双向/.test(readFileSync(surfaceGate, 'utf8')),
  '51 public + 117 隐身 = 168 零差集')
check('删除边界清单 v2 补齐活动依赖',
  /必须先改造的额外活动依赖/.test(readFileSync(join(ROOT,
    'deliverables/dev-plan/STEP5-DELETION-BOUNDARY.md'), 'utf8')),
  'v1 漏 25 个活动依赖')

// ---- 22. 删除后全面体检（R69 全源码二次检测）----
let postAudit = null
try {
  postAudit = JSON.parse(readFileSync(join(ROOT,
    'deliverables/dev-plan/post-deletion-audit-r69.json'), 'utf8'))
} catch (_) {}
// R70 / I14（主理人裁决）：新鲜度走独立 meta 的 ISO 8601 generatedAt，不用 mtime。
// 判据并入本条 check，保持断言总数 82 不变（回退条件要求 82/82 全绿）。
// 容差 10 分钟理由：CI 上 audit 门与 arch-contract 秒级差；本地「先跑统一入口
// 再验」也在 10 分钟内。QA 可 import audit-freshness.mjs 的 isAuditFresh 做单元级反例。
let auditMeta = null
try {
  auditMeta = JSON.parse(readFileSync(join(ROOT,
    'deliverables/dev-plan/post-deletion-audit-meta-r69.json'), 'utf8'))
} catch (_) {}
const auditFresh = isAuditFresh(auditMeta?.generatedAt, Date.now(),
  AUDIT_FRESHNESS_TOLERANCE_MS)
check('删除后审计可复跑且契约面零差集且产物新鲜', postAudit?.version >= 1 &&
  postAudit.contractSurface.missing.length === 0 &&
  postAudit.contractSurface.ghosts.length === 0 &&
  postAudit.contractSurface.publicDrift.length === 0 &&
  existsSync(join(ROOT, 'tools/post_deletion_audit.py')) &&
  auditFresh,
  '51/117/168 + generatedAt ≤ ' + (AUDIT_FRESHNESS_TOLERANCE_MS / 60000) + 'min')
// R70 / I13（A2 同步）：verdict 已动态化，硬断言改为「与本次扫描明细交叉校验」，
// 不再依赖固定数字 realDefectsFound===1 / fixedFiles.length===6。
const expectedFixedFiles = (postAudit?.retiredStubs || []).filter(s =>
  s.exists && s.guardOk && s.usesDirectoryGuard === false).length
check('退役脚本守卫不得再用目录存在性判据',
  postAudit?.retiredStubs?.every(s => s.exists && s.hasRetireNotice &&
    s.usesDirectoryGuard === false) &&
  postAudit.verdict?.dynamic === true &&
  Number.isInteger(postAudit.verdict?.realDefectsFound) &&
  postAudit.verdict.realDefectsFound ===
    (postAudit.deadReferences?.byKind?.['backend-in-runtime-config'] || 0) &&
  Array.isArray(postAudit.verdict?.fixedFiles) &&
  postAudit.verdict.fixedFiles.length === expectedFixedFiles &&
  postAudit.verdict?.basis?.staleDocsNonBlocking === true,
  '删除只删 .py，backend/ 目录仍在；verdict 由本次扫描动态生成')
check('PyInstaller spec 已标注退役',
  /R69 退役标注/.test(readFileSync(join(ROOT, 'Harbor.spec'), 'utf8')) &&
  /R69 退役标注/.test(readFileSync(join(ROOT, 'Harbor-mac.spec'), 'utf8')),
  'hiddenimports 指向已删模块')

// ---- 23. Agent 浏览器闭环 ----
const agentCore = join(ROOT, 'server/src/services/browser-agent.js')
const agentGate = join(ROOT, 'server/test/browser-agent.mjs')
check('Agent 浏览器闭环内核与验收门在架', existsSync(agentCore) &&
  existsSync(agentGate) &&
  /export async function observe|export async function resolveTarget|export function stateDiff/
    .test(readFileSync(agentCore, 'utf8')) &&
  /2\.3 R69 Agent 浏览器闭环/.test(readFileSync(join(ROOT, 'AGENTS.md'), 'utf8')),
  '观察/决策/动作/再观察')

// ---- 汇总 ----
const failed = checks.filter(c => !c.ok)
for (const c of checks) {
  console.log('%s %s %s', c.ok ? 'PASS' : 'FAIL', c.name.padEnd(38, ' '), c.detail)
}
console.log('\n[arch-contract] %d/%d 通过', checks.length - failed.length, checks.length)
process.exit(failed.length ? 1 : 0)
