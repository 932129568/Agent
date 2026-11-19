// R55 pybridge 验证
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HARBOR_CONFIG_DIR = path.join(os.tmpdir(), 'r55-test-' + Date.now())
process.env.DATABASE_URL = `file:${path.join(process.env.HARBOR_CONFIG_DIR, 'test.db')}`
process.env.LOG_LEVEL = 'silent'
fs.mkdirSync(process.env.HARBOR_CONFIG_DIR, { recursive: true })

const { invoke } = await import('../src/registry.js')
const results = []
const tests = [
  ['notes_append', ['test-sid', '功能验证笔记内容XYZ']],
  ['notes_get', ['test-sid']],
  ['memory_stats', []],
  ['memory_remember', ['E2E写入测试记忆条目']],
  ['memory_search', ['测试记忆']],
  ['memory_entries_list', []],
  ['trace_recent', [10]],
  ['memory_entry_pin', ['profile', 'test-key', true]],
  ['memory_entry_erase', ['profile', 'test-key']],
]
for (const [method, args] of tests) {
  try {
    const r = await invoke(method, args)
    const parsed = typeof r === 'string' ? JSON.parse(r) : r
    const ok = !parsed.error && !parsed.code
    results.push({ method, ok, detail: JSON.stringify(parsed).slice(0, 100) })
  } catch (e) {
    results.push({ method, ok: false, detail: e.message?.slice(0, 100) })
  }
}
let pass = 0
for (const r of results) {
  console.log(r.ok ? '✓' : '✗', r.method, r.detail)
  if (r.ok) pass++
}
console.log('TOTAL: %d/%d PASS', pass, results.length)
process.exit(pass === results.length ? 0 : 1);
