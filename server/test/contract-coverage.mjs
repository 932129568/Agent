/**
 * 方法名契约覆盖校验：Node 注册表 vs legacy backend/api.py。
 *
 * 防止两类事故：
 *   1. 命名漂移（例如把 model_prefs_get 错写成 model_prefs_get_config）；
 *   2. 出现 legacy 中不存在的“幽灵方法”。
 *
 * 未迁移的方法不算失败（它们返回 NOT_MIGRATED），但**多出来的名字必须是失败**。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 删除前置：Python 契约层已退役，legacy 方法面改读冻结快照（唯一事实源）
const frozen = JSON.parse(fs.readFileSync(path.join(serverRoot, '..',
  'deliverables', 'dev-plan', 'frozen-python-surface.json'), 'utf8'))
const legacy = new Set(frozen.method_defs)

// QA（任务 #13）修复：registry.js 拉起 experts.js 顶层 await 内置导入器，
// 未隔离 CONFIG_DIR 时写真实 ~/.glm-chat——先重定向再动态 import。
const registryIsoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-contract-regiso-'))
process.env.HARBOR_CONFIG_DIR = registryIsoDir
process.on('exit', () => {
  try { fs.rmSync(registryIsoDir, { recursive: true, force: true }) } catch { /* 容忍 */ }
})
const { listMethods } = await import('../src/registry.js')
const registered = new Set(listMethods())

const ghosts = [...registered].filter(name => !legacy.has(name))
const missing = [...legacy].filter(name => !registered.has(name))

// R70 / I11：空集恒真修复。原先只 assert.deepEqual(ghosts, []), missing 仅打印——
// 把 listMethods monkeypatch 成 [] 时 ghosts/missing 皆空，门会假 PASS。
// 两侧方法面必须恰为 168（冻结快照 method_defs 与 Node registry 双向零差集下界；
// R89 起 167 + inspect_tool_schema 元工具）。
assert.equal(legacy.size, 168, `冻结快照方法面应为 168，实际 ${legacy.size}`)
assert.equal(registered.size, 168, `Node 注册表方法面应为 168，实际 ${registered.size}`)
assert.deepEqual(ghosts, [], `出现 legacy 中不存在的方法名: ${ghosts.join(', ')}`)

console.log(JSON.stringify({
  ok: true,
  legacy_methods: legacy.size,
  migrated: registered.size,
  not_migrated: missing.length,
  ghosts: ghosts.length,
  remaining: missing.sort(),
}, null, 2))
