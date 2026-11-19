/**
 * C 路径 · 步骤 4 第七批：记忆注入 / entries 视图 / pin 的 Node 等价门。
 *
 * 销口对象：test_entries_pin_erase_and_extras_priority（原判 gap）。
 * 核实结论：Node 侧虽把 memory_context_build 标为 NOT_MIGRATED，但
 *   - provider.buildSystemPrompt() 经 memoryTail() 注入长期记忆段；
 *   - pybridge.memoryEntriesList() 返回带 source/pinned 的条目视图；
 *   - pybridge.memoryEntryPin() 可置位并在视图中反映。
 * 因此该钉是**部分覆盖**，不是完全实现缺口，verdict 由 gap 降为 partial。
 *
 * 未复刻（如实登记，不宣称等价）：Python extras_block 的
 * 「【长期记忆·扩展】」标题、attribute 字母序、pin 置前排序。
 *
 * 用法：node server/test/memory-injection.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-memory-injection-'))
process.env.HARBOR_CONFIG_DIR = isoDir
process.on('exit', () => {
  try { fs.rmSync(isoDir, { recursive: true, force: true }) } catch { /* 容忍 */ }
})

const memory = await import('../src/services/memory.js')
const provider = await import('../src/services/provider.js')
const pb = await import('../src/services/pybridge.js')
const parse = value => (typeof value === 'string' ? JSON.parse(value) : value)
const checks = []

// 1. 系统提示注入长期记忆段（对应 Python extras_block 的注入职责）
await memory.appendMemory(JSON.stringify({ text: '用户偏好深色主题', kind: 'rule' }))
const prompt = parse(await provider.buildSystemPrompt(''))
assert.ok(typeof prompt === 'string' && prompt.length > 0, '系统提示应可生成')
assert.ok(prompt.includes('用户长期记忆'), '应注入长期记忆段')
assert.ok(prompt.includes('用户偏好深色主题'), '应包含具体记忆文本')
checks.push('buildSystemPrompt 注入长期记忆段 + 具体条目')

// 2. entries 视图带 source / pinned 字段
const written = parse(await pb.memoryWrite('部署脚本在 D 盘 deploy 目录'))
assert.equal(written.ok, true)
const listed = parse(await pb.memoryEntriesList())
assert.equal(listed.enabled, true, 'entries 视图应可用')
assert.ok(Array.isArray(listed.entries) && listed.entries.length >= 1)
const entry = listed.entries[0]
assert.ok('source' in entry && 'pinned' in entry, '条目应带 source/pinned')
assert.equal(entry.pinned, false, '初始未钉选')
checks.push('entries 视图含 source/pinned，初始未钉选')

// 3. pin 置位在视图中反映
const pinned = parse(await pb.memoryEntryPin(entry.kind, entry.id, true))
assert.equal(pinned.ok, true)
const relisted = parse(await pb.memoryEntriesList())
const hit = relisted.entries.find(e => e.kind === entry.kind && e.id === entry.id)
assert.ok(hit && hit.pinned === true, '钉选后视图应反映 pinned=true')
const unpinned = parse(await pb.memoryEntryPin(entry.kind, entry.id, false))
assert.equal(unpinned.ok, true)
checks.push('pin 置位/取消在 entries 视图中反映')

console.log(JSON.stringify({
  ok: true,
  checks: checks.length,
  results: checks,
  verdict: 'test_entries_pin_erase_and_extras_priority: gap -> partial',
  notEquivalent: [
    'Python extras_block 的「【长期记忆·扩展】」标题未复刻',
    'attribute 字母序注入未复刻',
    'pin 置前排序未复刻（Node 侧仅标记 pinned，不改注入顺序）',
  ],
}, null, 2))
