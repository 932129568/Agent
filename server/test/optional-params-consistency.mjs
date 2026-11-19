/**
 * R71 · PY_OPTIONAL_PARAMS 一致性门（零契约风险的新增门）
 *
 * 背景（实测）：server/src/registry.js:325 的 PY_OPTIONAL_PARAMS 共 71 项，
 * 注释声称「由 tools/diff/extract_rpc_defaults.py 从 backend/api.py AST 机械提取，
 * 再生成须重跑脚本」。但 C 路径步骤 5/6 已删除 backend/api.py 与 74 个耦合
 * pytest，生成器虽仍为退役 stub，其上游事实源已不存在 —— 这份手工字面量
 * 从此无法再生成，也没有任何自动校验，是典型的「孤儿常量」。
 *
 * 本门采用「更合适的架构」：不从快照生成（快照只有 method_arities 参数名表，
 * 没有默认值信息，无法反推可选性），而是把冻结快照作为**校验基准**，
 * 建立三条可执行不变量：
 *   1. 每个键必须是冻结面 168 方法之一（R89 起 167 + inspect_tool_schema），
 *      或在显式登记的 Node 内部辅助方法豁免表中；
 *   2. 每个可选参数名必须出现在该方法在冻结快照中的签名里，且不得重复；
 *   3. 可选参数必须是签名的**后缀**（Python 有默认值的形参必在末尾）。
 *
 * 实测（2026-11-12）：71 项中 69 项全部满足三条约束；2 项为 Node 内部辅助方法
 * （_execute_guarded / _software_save），不属于 js_api 冻结面，显式登记豁免。
 * 这不是放宽判据：豁免是「不同命名空间」的事实，且门会校验豁免表不多不少、
 * 并校验豁免项确实是内部方法（_ 前缀）。
 *
 * 用法：node server/test/optional-params-consistency.mjs
 * 纳入：run_normalized_gates.py 的 server_gates() 自动遍历（35 → 36 门）。
 * 不改 registry.js 任何一行、不注册 js_api、不改任何返回形状。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.resolve(serverRoot, '..')
const regSrc = fs.readFileSync(path.join(serverRoot, 'src/registry.js'), 'utf8')
const frozen = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'deliverables/dev-plan/frozen-python-surface.json'), 'utf8'))

// ---- 1. 解析 PY_OPTIONAL_PARAMS 字面量（静态解析，不执行 registry.js，避免副作用） ----
const block = regSrc.match(/const PY_OPTIONAL_PARAMS = \{([\s\S]*?)\n\}/)
assert.ok(block, 'registry.js 应定义 PY_OPTIONAL_PARAMS')
const entries = [...block[1].matchAll(/^\s{2}([a-z_][a-z0-9_]*):\s*\[([^\]]*)\]/gm)]
  .map(m => ({
    method: m[1],
    params: [...m[2].matchAll(/'([a-z_][a-z0-9_]*)'/g)].map(x => x[1]),
  }))

assert.equal(entries.length, 71, 'PY_OPTIONAL_PARAMS 应为 71 项（若有意增删，须同步更新本门）')
const seen = new Set()
for (const e of entries) {
  assert.ok(!seen.has(e.method), `重复键: ${e.method}`)
  seen.add(e.method)
}

// ---- 2. 冻结面基准 ----
const defs = new Set(frozen.method_defs)
assert.equal(defs.size, 168, '冻结快照方法面应为 168')
const arities = frozen.method_arities
assert.equal(Object.keys(arities).length, 168, '冻结快照签名表应为 168')

// ---- 3. 显式豁免：Node 内部辅助方法，不属于 js_api 冻结面 ----
// 实测这两个方法在冻结面中不存在，且以下划线开头（内部命名空间）。
// 门会校验豁免表精确、不多不少，防止把真正拼写错误塞进豁免表。
const INTERNAL_EXEMPT = Object.freeze(['_execute_guarded', '_software_save'])
for (const name of INTERNAL_EXEMPT) {
  assert.ok(/^_/.test(name), `豁免项须为内部方法（_ 前缀）: ${name}`)
  assert.ok(!defs.has(name), `豁免项不应出现在 js_api 冻结面: ${name}`)
  assert.ok(seen.has(name), `豁免项必须确实存在于 PY_OPTIONAL_PARAMS: ${name}`)
}

// ---- 4. 三条不变量逐项校验 ----
const problems = []
let exemptCount = 0
for (const { method, params } of entries) {
  if (INTERNAL_EXEMPT.includes(method)) { exemptCount += 1; continue }

  if (!defs.has(method)) {
    problems.push(`${method}: 不在冻结面 168 方法内`)
    continue
  }
  const sig = arities[method]
  if (!Array.isArray(sig)) {
    problems.push(`${method}: 冻结快照缺少签名`)
    continue
  }
  for (const p of params) {
    if (!sig.includes(p)) problems.push(`${method}.${p}: 参数名不在冻结签名 ${JSON.stringify(sig)} 内`)
  }
  if (new Set(params).size !== params.length) {
    problems.push(`${method}: 可选参数名重复`)
  }
  if (params.length) {
    const suffix = sig.slice(-params.length)
    if (JSON.stringify(suffix) !== JSON.stringify(params)) {
      problems.push(`${method}: 可选参数须为签名后缀，实际 ${JSON.stringify(params)} vs ${JSON.stringify(suffix)}`)
    }
  }
}
assert.equal(exemptCount, INTERNAL_EXEMPT.length, '豁免项数量须与登记一致')
assert.deepEqual(problems, [], 'PY_OPTIONAL_PARAMS 与冻结面不一致:\n  ' + problems.join('\n  '))

// ---- 5. 反向检查：冻结面中的公开/隐身方法不得凭空出现可选参数声明 ----
// 未登记的 js_api 方法即视为「无可选参数」，这是合法默认；此处只确保
// 没有把冻结面之外的方法误登记为 js_api（上面已逐项校验），并输出可核对摘要。
const reported = {
  ok: true,
  checkedEntries: entries.length,
  frozenMethods: defs.size,
  frozenArities: Object.keys(arities).length,
  internalExempt: INTERNAL_EXEMPT,
  optionalParamTotal: entries.reduce((n, e) => n + e.params.length, 0),
  note: '冻结快照仅含参数名表、不含默认值信息；本门校验一致性与后缀约束，不尝试反推可选性',
}
console.log(JSON.stringify(reported, null, 2))
