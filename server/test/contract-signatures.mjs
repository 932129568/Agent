/** js_api 参数个数契约：防止“方法名对了，但位置参数顺序/数量漂移”。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// QA（任务 #13）修复：registry.js 拉起 experts.js 顶层 await 内置导入器，
// 未隔离 CONFIG_DIR 时写真实 ~/.glm-chat——先重定向再动态 import。
const registryIsoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-contract-regiso-'))
process.env.HARBOR_CONFIG_DIR = registryIsoDir
process.on('exit', () => {
  try { fs.rmSync(registryIsoDir, { recursive: true, force: true }) } catch { /* 容忍 */ }
})
const { listSignatures } = await import('../src/registry.js')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
// 删除前置：Python 契约层已退役，参数名/顺序改读冻结快照（唯一事实源）
const frozen = JSON.parse(fs.readFileSync(path.join(root,
  'deliverables', 'dev-plan', 'frozen-python-surface.json'), 'utf8'))
const legacy = frozen.method_arities
const node = listSignatures()
// R70 / I12：空对象恒真修复。原先只比对 mismatches，`node` 或 `legacy` 被注入
// 成 {} 时 mismatches 为空 → 假 PASS。两侧签名表必须恰为 168 键（R89 起 +1）。
assert.equal(Object.keys(node).length, 168,
  `Node 签名表应为 168 键，实际 ${Object.keys(node).length}`)
assert.equal(Object.keys(legacy).length, 168,
  `冻结快照签名表应为 168 键，实际 ${Object.keys(legacy).length}`)
const mismatches = Object.keys(node).filter(name => {
  if (legacy[name] == null || legacy[name].length !== node[name].length) return true
  return legacy[name].some((param, index) => param !== node[name][index])
}).map(name => ({ name, legacy_signature: legacy[name], node_signature: node[name] }))
  .sort((a, b) => a.name.localeCompare(b.name))
console.log(JSON.stringify({ ok: mismatches.length === 0, checked: Object.keys(node).length, mismatches }, null, 2))
assert.deepEqual(mismatches, [], 'js_api 参数名/顺序与 legacy 不一致')
