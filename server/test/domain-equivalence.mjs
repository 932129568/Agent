/**
 * C 路径 · 步骤 4 第二批：域等价映射门。
 *
 * 校验 frontend/app/docs/domain-equivalence-map.json 中 9 个 backend.domains
 * 子域的 Node 服务实现与 server 测试门是否真实存在，并把「24 个可跑门禁 +
 * 1 个历史迁移脚本」的口径钉死，防止后续误把非门禁脚本算进覆盖率。
 *
 * 诚实边界：本门只证明**实现与测试门的存在性**，不证明行为逐条等价；
 * 逐条复核仍按处置台账的 reviewRequired 推进。
 *
 * 用法：node server/test/domain-equivalence.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(serverRoot, '..')
const mapPath = path.join(root, 'frontend/app/docs/domain-equivalence-map.json')
const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'))

// 删除前置：改读冻结快照 domains（原检查 backend/domains/<name> 目录存在）
const frozenPath = path.join(root, 'deliverables/dev-plan/frozen-python-surface.json')
const frozen = JSON.parse(fs.readFileSync(frozenPath, 'utf8'))
const frozenDomains = new Set(frozen.domains)

assert.equal(map.domains.length, 9, '应覆盖 9 个 backend.domains 子域')
assert.equal(frozen.domains.length, 9, '冻结快照应冻结 9 个 Python 子域')
assert.equal(map.equivalenceStatus, 'mapped-not-behavior-verified',
  '不得把「定位到门」冒充「行为已验证」')

let services = 0
let gates = 0
const perDomain = []
for (const domain of map.domains) {
  assert.ok(frozenDomains.has(domain.name), '冻结快照缺少 Python 子域: ' + domain.name)
  for (const file of domain.nodeServices) {
    assert.ok(fs.existsSync(path.join(root, file)), '缺少 Node 服务: ' + file)
    services += 1
  }
  for (const file of domain.nodeGates) {
    assert.ok(fs.existsSync(path.join(root, file)), '缺少 Node 测试门: ' + file)
    gates += 1
  }
  perDomain.push({
    domain: domain.name,
    pythonModules: domain.pythonModuleCount,
    nodeServices: domain.nodeServices.length,
    nodeGates: domain.nodeGates.length,
  })
}
for (const file of map.defaultGates) {
  assert.ok(fs.existsSync(path.join(root, file)), '缺少默认门: ' + file)
}

// 映射表记录的是本门加入前的 24 个可跑门禁；之后新增的门只会让总数增加。
// 用下界断言而非精确相等，避免每加一个门都要改计数（已实证踩过两次）。
// auth-migrate.mjs 是历史一次性迁移脚本（依赖已移除的具名导出），不计入门禁。
const testDir = path.join(serverRoot, 'test')
const allGates = fs.readdirSync(testDir).filter(n => n.endsWith('.mjs'))
const nonGates = map.nonGateScripts.map(s => path.basename(s.file))
const totalRunnableGates = allGates.length - nonGates.length
assert.ok(totalRunnableGates >= map.serverGateCount + 1,
  '可跑门禁数不应少于 baseline + 本门自身')
for (const name of nonGates) {
  assert.ok(allGates.includes(name), '历史脚本登记失效: ' + name)
}

console.log(JSON.stringify({
  ok: true,
  domains: map.domains.length,
  nodeServiceRefs: services,
  nodeGateRefs: gates,
  preExistingRunnableGates: map.serverGateCount,
  totalRunnableGates,
  addedSinceBaseline: totalRunnableGates - map.serverGateCount,
  nonGateScripts: nonGates,
  perDomain,
  coverage: 'existence-only（行为逐条复核仍待推进）',
}, null, 2))
