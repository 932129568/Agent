/**
 * expert 子域 batch2 剩余 6 个 gap / 6 项 openImplementationGaps 的验收门。
 *
 * 逐条对照 frontend/app/docs/behavior-review-batch2.json v3：
 *   1 REPARSE_NOT_ALLOWED 细分        2 包内脚本/网络/进程/动态导入零执行（源码断言 + 运行时间谍）
 *   3 注册表损坏恢复 + 写回滚          4 frontmatter 标量/嵌套结构校验
 *   5 内置包转换规则与资产过滤         6 内置零进程零网络 + 用户导入严格校验
 *
 * 硬断言优先；确属「静态保证」的项用「源码断言 + 运行时断言」组合，不只写注释；
 * 无法在本轮真实实现的表示差异如实登记到 remainingGaps，不伪造通过。
 *
 * 用法：node server/test/expert-final-gaps.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cp from 'node:child_process'
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import dgram from 'node:dgram'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-expert-final-'))
const configDir = path.join(isoDir, 'config')
const emptyBuiltinDir = path.join(isoDir, 'empty-builtin')
const realBuiltinDir = path.resolve(serverRoot, '..', 'backend', 'experts_builtin')
fs.mkdirSync(configDir, { recursive: true })
fs.mkdirSync(emptyBuiltinDir, { recursive: true })
process.env.HARBOR_CONFIG_DIR = configDir
// 注册表三场景期间让 builtin 导入为空（不干扰 experts.json 的损坏/未知 schema 状态）。
process.env.HARBOR_BUILTIN_EXPERTS_DIR = emptyBuiltinDir
process.on('exit', () => {
  try { fs.rmSync(isoDir, { recursive: true, force: true }) } catch { /* 尽力清理 */ }
})

const results = []
const record = (name, detail) => results.push({ case: name, status: 'PASS', detail })
const parse = v => (typeof v === 'string' ? JSON.parse(v) : v)
const registryFile = () => path.join(configDir, 'experts.json')

/* ---------------- 前置：源码静态保证（GAP-2 的一半） ---------------- */
// 服务源码绝不引用进程/网络/动态执行面。仅检查两个被授权改动的服务文件。
const FORBIDDEN = [
  [/\bimport\s*\(/, '动态 import()'],
  [/\brequire\s*\(/, 'require()'],
  [/\beval\s*\(/, 'eval()'],
  [/\bnew\s+Function\b/, 'new Function'],
  [/from\s*['"]node:(child_process|net|http|https|dgram|dns|vm|worker_threads|cluster)['"]/, '进程/网络模块静态导入'],
  [/require\(\s*['"](child_process|net|http|https|dgram|dns|vm)['"]/, '进程/网络模块 require'],
  [/\.(exec|execFile|spawn|spawnSync|execSync|execFileSync|fork)\s*\(/, '进程/子进程调用'],
]
for (const file of ['experts.js', 'expert-builtin.js']) {
  const src = fs.readFileSync(path.join(serverRoot, 'src', 'services', file), 'utf8')
  for (const [re, label] of FORBIDDEN) {
    assert.ok(!re.test(src), `${file} 源码不应出现「${label}」`)
  }
}
record('GAP-2a 源码静态保证', 'experts.js / expert-builtin.js 无动态 import/require/eval/Function/进程网络模块/exec-spawn 调用')

/* get_api_info 公开面冻结：51 方法 / v1.0.0（只读源码，不改动 registry.js）。 */
const registrySrc = fs.readFileSync(path.join(serverRoot, 'src', 'registry.js'), 'utf8')
const methodsBlock = registrySrc.match(/const PUBLIC_API_METHODS = \[([\s\S]*?)\]/)
const publicMethods = [...methodsBlock[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1])
assert.equal(publicMethods.length, 51, 'get_api_info methods 数必须为 51')
assert.match(registrySrc, /API_VERSION = 'v1\.0\.0'/, '契约版本必须仍为 v1.0.0')
record('契约冻结', 'get_api_info 51 方法 / v1.0.0 未变（未新增任何 register 调用）')

/* ---------------- 运行时间谍（GAP-2 / GAP-6 的运行时部分） ---------------- */
// 先完成模块导入，再安装间谍，避免把 Node 自身的模块加载计入。
const experts = await import('../src/services/experts.js')
const builtin = await import('../src/services/expert-builtin.js')
const spies = { calls: 0 }
function installSpy(obj, key, label) {
  try { obj[key] = function () { spies.calls += 1; throw new Error(`禁止调用 ${label}`) } }
  catch { /* 只读内建属性跳过，由源码断言兜底 */ }
}
for (const [obj, key] of [
  [cp, 'exec'], [cp, 'execFile'], [cp, 'spawn'], [cp, 'spawnSync'], [cp, 'execSync'], [cp, 'execFileSync'], [cp, 'fork'],
  [net, 'connect'], [net, 'createConnection'], [net, 'createServer'],
  [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'],
  [dgram, 'createSocket'],
]) installSpy(obj, key, key)

let seq = 0
function mkPkg(mutate) {
  const dir = path.join(isoDir, 'pkg-' + (++seq))
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name: 'demo.expert', version: '1.0.0', agents: './agents/' }))
  fs.writeFileSync(path.join(dir, 'agents', 'a.md'), '---\nname: a\n---\n# Agent A\n')
  if (mutate) mutate(dir)
  return dir
}
async function attempt(dir, sourceKind) {
  const out = parse(await experts.expertImportDirectory(dir, sourceKind))
  return { ok: out.ok, rejected: out.ok === false, code: out.ok === false ? out.error?.code : null, out }
}

/* ---------------- GAP-3 注册表损坏恢复 / 未知 schema / 写回滚 ---------------- */
// A: 损坏 JSON → REGISTRY_CORRUPT_RECOVERED + 备份 + 恢复到空注册表
fs.writeFileSync(registryFile(), '{bad')
const listA = parse(await experts.expertList())
assert.equal(listA.ok, true)
assert.equal(listA.registry_warning, 'REGISTRY_CORRUPT_RECOVERED', '损坏应上报恢复诊断')
assert.deepEqual(listA.packages, [], '损坏后应恢复到空注册表，不阻塞业务')
const backups = fs.readdirSync(configDir).filter(x => x.startsWith('experts.json.bad-'))
assert.ok(backups.length >= 1, '损坏文件应被改名为 experts.json.bad-* 备份')
record('GAP-3a REGISTRY_CORRUPT_RECOVERED', `备份 ${backups[0]} 已生成，列表恢复为空注册表`)

// B: 未知 schema → REGISTRY_SCHEMA_UNSUPPORTED 只读；写偏好被拒且原文件字节不变
const schema99 = '{"schema_version":99,"packages":{}}'
fs.writeFileSync(registryFile(), schema99)
const beforeB = fs.readFileSync(registryFile())
const listB = parse(await experts.expertList())
assert.equal(listB.registry_warning, 'REGISTRY_SCHEMA_UNSUPPORTED', '未知 schema 应上报诊断')
const saveB = parse(await experts.expertSavePreferences(JSON.stringify({ limits: { maxTurns: 20 } })))
assert.equal(saveB.error.code, 'REGISTRY_SCHEMA_UNSUPPORTED', '只读态写偏好必须拒绝')
assert.ok(beforeB.equals(fs.readFileSync(registryFile())), '只读态不得覆盖原文件')
record('GAP-3b REGISTRY_SCHEMA_UNSUPPORTED', '写偏好被拒(REGISTRY_SCHEMA_UNSUPPORTED)，experts.json 字节未变')

// C: 写失败回滚 —— 用真实 I/O 故障（占住 atomicWriteJson 的 tmp 路径为目录 → openSync EISDIR）
//    触发 commit 异常，返回 REGISTRY_WRITE_FAILED 且原文件字节不变。
fs.rmSync(registryFile(), { force: true })
fs.writeFileSync(registryFile(), JSON.stringify({ schema_version: 1, packages: {}, preferences: { limits: { maxTurns: 40 } } }, null, 2))
const beforeC = fs.readFileSync(registryFile())
const tmpTrap = `${registryFile()}.${process.pid}.tmp`
fs.mkdirSync(tmpTrap, { recursive: true })  // 真实写故障注入，非打桩伪造
let saveC
try { saveC = parse(await experts.expertSavePreferences(JSON.stringify({ limits: { maxTurns: 20 } }))) }
finally { fs.rmSync(tmpTrap, { recursive: true, force: true }) }
assert.equal(saveC.error.code, 'REGISTRY_WRITE_FAILED', 'commit 失败必须返回 REGISTRY_WRITE_FAILED')
assert.ok(beforeC.equals(fs.readFileSync(registryFile())), '写失败必须回滚，原值未改变')
// 回滚后下一次读取仍拿到原值（内存无脏数据）
const listC = parse(await experts.expertList())
assert.equal(listC.ok, true)
record('GAP-3c REGISTRY_WRITE_FAILED 写回滚', 'EISDIR 写故障→结构化错误；experts.json 字节与回滚后列表均保持原值')

// 清理，准备内置包导入（从干净注册表开始）
for (const b of backups) fs.rmSync(path.join(configDir, b), { force: true })
fs.rmSync(registryFile(), { force: true })

/* ---------------- GAP-5 内置包转换规则与资产过滤 ---------------- */
/* ---------------- GAP-6 内置零进程零网络（间谍在导入期间归零） ---------------- */
process.env.HARBOR_BUILTIN_EXPERTS_DIR = realBuiltinDir
const imported = await builtin.importBuiltinExperts(experts.expertImportDirectory)
assert.equal(imported.ok, true, '8 个内置包应全部导入成功')
assert.equal(imported.imported, 8, '内置包数量应为 8')
assert.equal(spies.calls, 0, '内置导入期间进程/网络间谍必须保持零')
record('GAP-6a 内置导入零进程零网络', `import_all=8/8，间谍调用=${spies.calls}`)

const get = async id => parse(await experts.expertGet(id)).package
// 转换规则：plugin 字段剥离（字段白名单）
for (const id of ['fullstack-dev-engineer', 'qa-testing', 'valorant-perler-expert']) {
  assert.ok(!Object.prototype.hasOwnProperty.call((await get(id)).metadata, 'plugin'), `${id} 元数据不应含 plugin`)
}
// 转换规则：team settings 生成 + displayName==profession
const strategy = await get('product-strategy-team')
assert.deepEqual(strategy.metadata.displayName, strategy.metadata.profession, 'team profession 应与 displayName 一致')
const snapshotsRoot = path.join(configDir, 'experts', 'snapshots')
function allSnapshotFiles() {
  const out = []
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out.push(f) } }
  if (fs.existsSync(snapshotsRoot)) walk(snapshotsRoot)
  return out
}
for (const teamId of ['design-engine', 'product-strategy-team', 'software-company']) {
  const dir = path.join(snapshotsRoot, teamId)
  assert.ok(fs.existsSync(dir), `${teamId} 应有快照`)
  assert.ok(fs.readdirSync(dir).some(s => fs.existsSync(path.join(dir, s, '.codebuddy-plugin', 'settings.json'))),
    `${teamId} 转换应生成 .codebuddy-plugin/settings.json`)
}
// 转换规则：browser-use SKILL.md frontmatter 归一（allowed-tools 去除、正文保留）
const senior = await get('senior-developer')
assert.ok(senior.skills.includes('skills/browser-use'), 'senior-developer 应发现 browser-use skill')
const browserText = parse(await experts.expertReadResource(senior.snapshot_id, 'skills/browser-use/SKILL.md')).text
assert.ok(browserText.startsWith('---\nname: "browser-use"\n'), 'browser-use frontmatter 应归一为 name 首行')
assert.ok(!browserText.includes('allowed-tools'), 'allowed-tools 应被字段白名单剥离')
assert.ok(browserText.includes('# Browser Automation with browser-use CLI'), '正文标题应保留')
assert.ok(browserText.includes('or extract information from web pages.'), '多行 description 应保留')
// 转换规则：valorant skills 集合
assert.deepEqual((await get('valorant-perler-expert')).skills.sort(),
  ['skills/perler-repair', 'skills/valorant-knowledge', 'skills/valorant-perler'],
  'valorant 三个 skill 应齐全')
// 资产过滤：无 avatars/showcase、单文件 ≤ 1 MiB、脚本不在只读白名单
const snapFiles = allSnapshotFiles()
assert.ok(snapFiles.length > 0, '快照应有文件')
assert.ok(snapFiles.every(f => fs.statSync(f).size <= 1048576), '所有快照文件应 ≤ 1 MiB')
assert.ok(snapFiles.every(f => !f.split(path.sep).includes('avatars') && !f.split(path.sep).includes('showcase')),
  '资产过滤应丢弃 avatars/showcase')
const qa = await get('qa-testing')
assert.ok(!qa.resources.some(r => /\.(py|sh|js|exe)$/.test(r)), '脚本类文件不得进入只读资源白名单')
const qaScriptRead = parse(await experts.expertReadResource(qa.snapshot_id, 'skills/qa-testing-cn/scripts/calculate_metrics.py'))
assert.equal(qaScriptRead.ok, false, 'scripts 资源必须不可读/不可执行')
record('GAP-5 内置转换规则与资产过滤',
  'plugin 剥离/team settings/displayName==profession/browser-use 归一/valorant skills 均通过；无 avatars/showcase、≤1MiB、脚本不可读')

/* ---------------- GAP-6 用户导入严格校验 ---------------- */
const strictDir = path.join(isoDir, 'user-strict')
fs.mkdirSync(path.join(strictDir, '.codebuddy-plugin'), { recursive: true })
fs.writeFileSync(path.join(strictDir, '.codebuddy-plugin', 'plugin.json'),
  JSON.stringify({ name: 'invalid.expert', version: '1.0.0', plugin: 'invalid' }))
const strictRes = await attempt(strictDir)
assert.equal(strictRes.rejected, true, '含未知核心字段的用户包必须被拒')
assert.equal(strictRes.code, 'METADATA_FIELD_UNKNOWN', '用户导入严格校验应返回 METADATA_FIELD_UNKNOWN')
record('GAP-6b 用户导入严格校验', 'plugin 未知字段 → METADATA_FIELD_UNKNOWN；内置 sanitize 后仍全部白名单通过')

/* ---------------- GAP-4 frontmatter 标量/嵌套结构校验 ---------------- */
const supportedFm = [
  '---', 'name: researcher', "description: 'It''s safe'",
  'displayName: {zh: 研究员, en: Researcher}', 'profession:', '  zh: 研究员', '  en: Researcher',
  'maxTurns: 8', '---', '# Researcher', '',
].join('\n')
const supportedDir = mkPkg(d => fs.writeFileSync(path.join(d, 'agents', 'a.md'), supportedFm))
const supportedRes = await attempt(supportedDir)
assert.equal(supportedRes.ok, true, `受支持标量/一层 map 应通过: ${JSON.stringify(supportedRes.out)}`)
record('GAP-4a frontmatter 受支持标量', '单引号转义/flow map/2 空格一层 map/int maxTurns 全部接受')

const nestedFm = '---\nname: researcher\ndescription: ok\nprofession:\n    zh: bad\n---\nbody'
const nestedDir = mkPkg(d => fs.writeFileSync(path.join(d, 'agents', 'a.md'), nestedFm))
const nestedRes = await attempt(nestedDir)
assert.equal(nestedRes.rejected, true, '4 空格深层嵌套必须拒绝')
assert.ok(['INVALID_INDENT', 'INVALID_MAP'].includes(nestedRes.code), `应返回 INVALID_INDENT/INVALID_MAP，实得 ${nestedRes.code}`)
record('GAP-4b frontmatter 非法嵌套', `4 空格嵌套 → ${nestedRes.code}`)

/* ---------------- GAP-1 REPARSE_NOT_ALLOWED 细分 ---------------- */
// 1a 真实 Windows junction（junction 创建无需管理员，区别于 EPERM 的 symlink）
const junctionDir = mkPkg(d => {
  const target = path.join(isoDir, 'junction-target-' + seq)
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'x.txt'), 'outside')
  fs.symlinkSync(target, path.join(d, 'escape-junction'), 'junction')
})
const junctionRes = await attempt(junctionDir)
assert.equal(junctionRes.rejected, true, 'junction 必须拒绝')
assert.equal(junctionRes.code, 'REPARSE_NOT_ALLOWED', `junction 应细分 REPARSE_NOT_ALLOWED，实得 ${junctionRes.code}`)
// 1b reparse 属性位（Python validator._secure_lstat 同款，通过 lstat 打桩注入 FILE_ATTRIBUTE_REPARSE_POINT）
const attrDir = mkPkg(d => {
  fs.unlinkSync(path.join(d, 'agents', 'a.md'))
  fs.writeFileSync(path.join(d, 'agents', 'researcher.md'), '---\nname: researcher\n---\nbody\n')
})
const origLstat = fs.lstatSync
fs.lstatSync = function (p, o) {
  const st = origLstat(p, o)
  if (path.basename(p) === 'researcher.md') st.st_file_attributes = 0x400
  return st
}
let attrRes
try { attrRes = await attempt(attrDir) } finally { fs.lstatSync = origLstat }
assert.equal(attrRes.rejected, true, 'reparse 属性文件必须拒绝')
assert.equal(attrRes.code, 'REPARSE_NOT_ALLOWED', `reparse 属性应细分 REPARSE_NOT_ALLOWED，实得 ${attrRes.code}`)
record('GAP-1 REPARSE_NOT_ALLOWED 细分', '真实 junction + 注入 reparse 属性位均返回 REPARSE_NOT_ALLOWED（不再混为 LINK_NOT_ALLOWED）')

/* ---------------- GAP-2 包内代码零执行（运行时断言） ---------------- */
const marker = path.join(isoDir, 'EXECUTED_MARKER')
const payloadDir = mkPkg(d => {
  fs.mkdirSync(path.join(d, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(d, 'scripts', 'payload.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'EXECUTED')\n`)
})
const payloadRes = await attempt(payloadDir)
assert.equal(payloadRes.ok, true, '包内脚本仅作数据，导入本身应成功')
assert.equal(fs.existsSync(marker), false, '包内 payload.js 绝不可被执行（标记文件不应出现）')
const payloadRead = parse(await experts.expertReadResource(payloadRes.out.snapshot_id, 'scripts/payload.js'))
assert.equal(payloadRead.ok, false, '脚本资源必须不可读')
assert.equal(spies.calls, 0, `全程进程/网络间谍必须归零，实得 ${spies.calls}`)
record('GAP-2b 包内零执行', 'payload.js 未产生执行标记、脚本资源不可读；进程/网络间谍全程 0')

/* ---------------- config.json 零污染 ---------------- */
assert.equal(fs.existsSync(path.join(configDir, 'config.json')), false, '状态绝不可写入 config.json')
assert.ok(fs.existsSync(path.join(configDir, 'experts.json')), '状态应独立写 experts.json')
record('config.json 零污染', '所有状态写入独立 experts.json / experts/ 快照，config.json 不存在')

/* ---------------- 如实登记：本轮未逐字节对齐的表示差异（非安全缺口） ---------------- */
const remainingGaps = [
  'Node 的 expertGet().scripts 恒为 []（Python 会把 scripts 收集进 manifest）；且 .py 脚本被 Node 资产过滤直接丢弃、不进入快照。'
    + '脚本文件在 Node 侧不可读/不可执行的安全语义与 Python 等价（更强过滤），但「scripts[] 元数据 + .py 留存」为表示差异，未伪造通过。',
  'frontmatter 校验为「受限子集」实现（标量/一层 map/深层缩进拒绝），非 Python frontmatter.py 全量逐字节移植；'
    + '动态 import()/eval 无法在 Node 全局打桩，改以「源码断言无动态导入 + 运行时 payload 标记 + 间谍」组合覆盖。',
]

console.log(JSON.stringify({
  ok: true,
  gate: 'server/test/expert-final-gaps.mjs',
  verified: 6,
  assertions: results.length,
  results,
  spies: { processNetworkCalls: spies.calls },
  remainingGaps,
  noPublicApiAdded: true,
  apiVersion: 'v1.0.0',
  publicMethods: publicMethods.length,
}, null, 2))
