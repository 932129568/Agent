/**
 * 契约完整性门：js_api 公开面 + _V12_EXTRA 隐身面 与 Node handlers 双向对齐。
 *
 * 深扫描发现的真实盲区：contract-golden.mjs 只校验 51 个公开方法，
 * 而 backend/api.py 还有 116 个 _V12_EXTRA 隐身方法（R89 起 +1 个 Node 侧
 * 灰度元工具 inspect_tool_schema = 117）；其中
 * memory_context_build / memory_audit_query 曾在 Node 侧漏注册，
 * 前端调用会得到 NOT_MIGRATED。本门用静态解析封住该缺口。
 *
 * 用法：node server/test/method-surface.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.resolve(serverRoot, '..')
const regSrc = fs.readFileSync(path.join(serverRoot, 'src/registry.js'), 'utf8')

// 删除前置：改读冻结快照 hidden_methods（原解析 backend/api.py 的 _V12_EXTRA frozenset）
const frozenPath = path.join(ROOT, 'deliverables/dev-plan/frozen-python-surface.json')
const frozen = JSON.parse(fs.readFileSync(frozenPath, 'utf8'))
const pythonExtra = new Set(frozen.hidden_methods)
assert.equal(pythonExtra.size, 117, '冻结快照隐身面应为 117 方法')

// Node 公开面（仍从 registry.js 解析；Node 侧仍在）
const pubBlock = regSrc.match(/const PUBLIC_API_METHODS\s*=\s*\[([\s\S]*?)\]/)
assert.ok(pubBlock, 'registry.js 应定义 PUBLIC_API_METHODS')
const nodePublic = new Set([...pubBlock[1].matchAll(/'([a-z0-9_]+)'/g)].map(m => m[1]))

// Node 实际注册
const registered = new Set([...regSrc.matchAll(/^register\('([a-z0-9_]+)'/gm)].map(m => m[1]))

const expected = new Set([...pythonExtra, ...nodePublic])
const missing = [...expected].filter(n => !registered.has(n)).sort()
const ghost = [...registered].filter(n => !expected.has(n)).sort()

assert.equal(nodePublic.size, 51, 'Node 公开面应为 51 方法')
assert.equal(expected.size, 168, '公开面与隐身面并集应为 51+117=168')
assert.deepEqual(missing, [], '以下方法在 Python 契约面存在但 Node 未注册: ' + missing.join(', '))
assert.deepEqual(ghost, [], '以下 Node 注册不在 Python 契约面: ' + ghost.join(', '))

// 运行时抽查两个补漏方法确实可调用（隔离 CONFIG_DIR）
const isoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-surface-'))
process.env.HARBOR_CONFIG_DIR = isoDir
process.on('exit', () => {
  try { fs.rmSync(isoDir, { recursive: true, force: true }) } catch { /* Windows 文件锁：容忍 */ }
})
const registry = await import('../src/registry.js')
for (const name of ['memory_context_build', 'memory_audit_query']) {
  const out = await registry.invoke(name, [])
  const parsed = typeof out === 'string' ? JSON.parse(out) : out
  assert.equal(parsed.enabled, true, name + ' 应可用且返回 enabled:true')
  assert.ok(!('error' in parsed), name + ' 不应返回错误: ' + JSON.stringify(parsed))
}
console.log(JSON.stringify({
  ok: true,
  publicMethods: nodePublic.size,
  hiddenMethods: pythonExtra.size,
  nodeRegistered: registered.size,
  missingInNode: missing,
  ghostsInNode: ghost,
  smokeTested: ['memory_context_build', 'memory_audit_query'],
  note: '公开面与隐身面双向零差集；contract-golden 只覆盖前者，本门覆盖全集',
}, null, 2))
