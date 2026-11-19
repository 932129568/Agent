/**
 * C 路径 · 步骤 2：Node 侧 golden 契约门。
 *
 * 定位：在删除 Python 契约层之前，先证明 Node 运行时仍能提供与 legacy 冻结面
 * 等价的公开自省面，并且 golden 快照本身未被篡改。
 *
 * 校验四层：
 *   1. golden 快照 sha256 与 frontend/app/docs/golden-manifest.json 一致（防篡改）；
 *   2. golden 的调用序列数与 manifest 一致，get_api_info 结构合法；
 *   3. **Node 运行时重放 get_api_info()**：version 与 methods 集合必须与 frozen
 *      golden 完全一致（exe 字段按实现不同允许差异）；
 *   4. Node registry 无 legacy 中不存在的幽灵方法（沿用 contract-coverage 口径）。
 *
 * 诚实边界：本门覆盖**公开契约面**（51 个公开方法集合 + 版本），
 * 尚未逐输出重放 95 项调用序列——那需要 Node 侧 fake stubs 与 Python 侧等价，
 * 属于步骤 2b，不能冒充已完成。
 *
 * 用法：node server/test/contract-golden.mjs
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(serverRoot, '..')
const goldenPath = path.join(root, 'deliverables/dev-plan/contract-golden/api-suite.json')
const manifestPath = path.join(root, 'frontend/app/docs/golden-manifest.json')

// ---- 1/2. golden 完整性与结构 ----
const goldenRaw = fs.readFileSync(goldenPath)
const goldenSha = crypto.createHash('sha256').update(goldenRaw).digest('hex')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
assert.equal(goldenSha, manifest.sha256, 'golden 快照哈希与冻结 manifest 不一致')

const golden = JSON.parse(goldenRaw.toString('utf8'))
assert.equal(Object.keys(golden).length, manifest.sequenceCount,
  'golden 调用序列数与 manifest 不一致')
assert.ok(golden.get_api_info, 'golden 缺少 get_api_info')
const frozenInfo = JSON.parse(golden.get_api_info)
assert.equal(frozenInfo.version, 'v1.0.0', '冻结的契约版本漂移')
// A3 锚点同步：51 个公开方法集合，严格相等（原先 >=40 的下界过松）。
assert.ok(Array.isArray(frozenInfo.methods) && frozenInfo.methods.length === 51,
  '冻结的公开方法集合异常（应恰为 51 个公开方法）')

// ---- 3. Node 运行时重放自省面 ----
// 与 contract-coverage.mjs 同口径：先隔离 CONFIG_DIR，避免写真实 ~/.glm-chat。
const isoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-golden-iso-'))
process.env.HARBOR_CONFIG_DIR = isoDir
process.on('exit', () => {
  try { fs.rmSync(isoDir, { recursive: true, force: true }) } catch { /* 容忍 */ }
})
const { invoke, listMethods, API_VERSION } = await import('../src/registry.js')

const nodeInfo = JSON.parse(await invoke('get_api_info'))
assert.equal(nodeInfo.version, API_VERSION)
assert.equal(nodeInfo.version, frozenInfo.version, 'Node 契约版本与 frozen 不一致')
const frozenMethods = [...frozenInfo.methods].sort()
const nodeMethods = [...nodeInfo.methods].sort()
assert.deepEqual(nodeMethods, frozenMethods,
  'Node 公开方法集合与 frozen golden 不一致')

// ---- 4. 无幽灵方法 ----
// 删除前置：改读冻结快照 method_defs（backend/api.py 删除后不再依赖 Python 源码正则提取）
const frozenPath = path.join(root, 'deliverables/dev-plan/frozen-python-surface.json')
const frozenSurface = JSON.parse(fs.readFileSync(frozenPath, 'utf8'))
const legacyDefs = new Set(frozenSurface.method_defs)
const ghosts = listMethods().filter(name => !legacyDefs.has(name))
assert.deepEqual(ghosts, [], `出现 legacy 中不存在的方法名: ${ghosts.join(', ')}`)

console.log(JSON.stringify({
  ok: true,
  golden_sha256: goldenSha,
  frozen_sequences: Object.keys(golden).length,
  frozen_public_methods: frozenMethods.length,
  node_public_methods: nodeMethods.length,
  order_identical: JSON.stringify(nodeInfo.methods) === JSON.stringify(frozenInfo.methods),
  registered_methods: listMethods().length,
  ghosts: ghosts.length,
  coverage: 'public contract surface (逐输出重放属步骤 2b，未完成)',
}, null, 2))
