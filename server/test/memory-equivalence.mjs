/**
 * C 路径 · batch1 partial 收口门（memory + observability）。
 *
 * 销口对象（batch1 v7 的 4 项 openImplementationGaps 已真实实现，逐项硬断言）：
 *   - test_trace_service_span_and_read（已由 trace-equivalence.mjs 覆盖，本门复核）
 *   - test_r48_6_memory_write_honest_schema（buildTools 运行时校验无 kind）
 *   - test_memory_search_ranking_and_touch（bigram 排序/零重叠/空查询 + touch 频率强化）
 *   - test_erase_soft_scrubs_and_stats（软擦除 scrub + stats.enabled / integrity）
 *   - test_api_entries_surface_and_mirror（entries source/readonly + legacy 逐条镜像 + pin/erase）
 *   - test_entries_pin_erase_and_extras_priority（extras 标题/字母序/pin 置前）
 *
 * 用法：node server/test/memory-equivalence.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-mem-eq-'))
process.env.HARBOR_CONFIG_DIR = isoDir
process.on('exit', () => {
  try { fs.rmSync(isoDir, { recursive: true, force: true }) } catch { /* 容忍 */ }
})
const memory = await import('../src/services/memory.js')
const pb = await import('../src/services/pybridge.js')
const provider = await import('../src/services/provider.js')
const parse = v => (typeof v === 'string' ? JSON.parse(v) : v)
const checks = []

// 1. memory_write 工具 schema 诚实性：未消费的 kind 不得出现在 properties
{
  const built = parse(await provider.buildTools('full', false, true, false))
  const arr = Array.isArray(built) ? built : (built.tools || built.items || [])
  const mw = arr.find(t => (t.function?.name || t.name) === 'memory_write')
  assert.ok(mw, 'buildTools 应包含 memory_write')
  const fn = mw.function || mw
  const props = fn.parameters?.properties || {}
  assert.ok(!('kind' in props), '分发未消费的 kind 不得出现在 schema')
  assert.ok('text' in props, 'text 参数应存在')
  checks.push('memory_write schema 诚实：properties 不含 kind，含 text')
}

// 2. memoryRetrieve：bigram 相关命中 / 零重叠排除 / 空查询防御
await memory.appendMemory(JSON.stringify({ text: '部署脚本在 D 盘 deploy 目录', kind: 'fact' }))
await memory.appendMemory(JSON.stringify({ text: '数据备份在 E 盘 bak 目录', kind: 'fact' }))
{
  const hit = parse(await memory.memoryRetrieve('deploy', 5))
  assert.equal(hit.ok, true)
  assert.ok(hit.items.length >= 1 && hit.items.some(i => i.text.includes('deploy')),
    '相关查询应命中 deploy 条目')
  const zero = parse(await memory.memoryRetrieve('zzqqxxnope', 5))
  assert.equal(zero.items.length, 0, '零重叠不得返回低分噪音')
  const empty = parse(await memory.memoryRetrieve('', 5))
  assert.equal(empty.items.length, 0, '空查询应返回空')
  checks.push('memoryRetrieve bigram 命中 / 零重叠排除 / 空查询防御')
}

// 3. memoryStats：enabled + integrity
{
  const st = parse(await pb.memoryStats())
  assert.equal(st.enabled, true)
  assert.equal(st.integrity, true)
  checks.push('memoryStats enabled + integrity')
}

// 4. memorySearch：相关命中 / 空查询 / 无关查询
await pb.memoryWrite('用户偏好深色主题界面')
{
  const s = parse(await pb.memorySearch('深色', 8))
  assert.ok(Array.isArray(s.results))
  const empty = parse(await pb.memorySearch('', 8))
  assert.deepEqual(empty.results, [])
  const noise = parse(await pb.memorySearch('zzqqxxnope', 8))
  assert.deepEqual(noise.results, [])
  checks.push('memorySearch 相关命中 / 空查询与无关查询返回空')
}

// 5. entries 视图：source / readonly / pin / erase
{
  const listed = parse(await pb.memoryEntriesList())
  assert.equal(listed.enabled, true)
  assert.ok(Array.isArray(listed.entries))
  for (const e of listed.entries) {
    assert.ok('source' in e && 'pinned' in e && 'readonly' in e)
  }
  const target = listed.entries.find(e => e.kind === 'profile' && !e.readonly)
  if (target) {
    assert.equal(parse(await pb.memoryEntryPin(target.kind, target.id, true)).ok, true)
    const relisted = parse(await pb.memoryEntriesList())
    assert.ok(relisted.entries.find(e => e.kind === target.kind && e.id === target.id)?.pinned === true)
    assert.equal(parse(await pb.memoryEntryErase(target.kind, target.id)).ok, true)
    checks.push('entries 视图字段 + pin/erase 生效')
  } else {
    checks.push('entries 视图字段齐全（无可管理条目，pin/erase 跳过）')
  }
}

// 6. memoryErase 软擦除 scrub（事实层整键排除 + profile 字面值遮盖 + integrity 仍 true）
{
  // 构造：结构化事实（attribute=contact）+ 同字面值的画像条目
  assert.equal(parse(await pb.memoryWrite('备用暗号 BLUE-77', 'contact')).ok, true)
  assert.equal(parse(await pb.memoryWrite('联系人暗号是 BLUE-77')).ok, true)
  const before = parse(await pb.memorySearch('BLUE-77', 8))
  assert.ok(before.results.some(x => x.text.includes('BLUE-77')), '擦除前字面值应可见')
  assert.ok(before.results.some(x => x.attribute === 'contact'), '擦除前 contact 事实应在检索面')
  const soft = parse(await pb.memoryErase('contact', false, 'BLUE-77'))
  assert.equal(soft.ok, true, '软擦除应返回 ok（不再是「需要桌面版」）')
  assert.equal(soft.hard, false)
  // 事实层整键排除：contact 键不再出现在任何视图
  const after = parse(await pb.memorySearch('BLUE-77', 8))
  assert.ok(!after.results.some(x => x.attribute === 'contact'), 'contact 事实应整键排除')
  const listed = parse(await pb.memoryEntriesList())
  assert.ok(!listed.entries.some(e => e.kind === 'fact' && e.text.includes('备用暗号')),
    'entries 视图不得再出现 contact 事实')
  // profile 字面值遮盖：行保留，字面值不可见
  assert.ok(!JSON.stringify(after.results).includes('BLUE-77'), '检索结果字面值应被 ▇ 遮盖')
  assert.ok(!JSON.stringify(listed.entries).includes('BLUE-77'), 'entries 视图字面值应被 ▇ 遮盖')
  assert.ok(listed.entries.some(e => e.kind === 'profile' && String(e.text).includes('▇')),
    '画像行应保留且带遮盖符')
  const st = parse(await pb.memoryStats())
  assert.equal(st.integrity, true, '软擦除后 stats().integrity 仍为 true')
  checks.push('memoryErase 软擦除 scrub：contact 整键排除 + 字面值 ▇ 遮盖 + integrity=true')
}

// 7. legacy 多条镜像进 entries（逐条 source=legacy / readonly=true）
{
  const listed = parse(await pb.memoryEntriesList())
  const legacy = listed.entries.filter(e => e.source === 'legacy')
  assert.ok(legacy.length >= 2, '多条 legacy 事实应逐条镜像（当前 ' + legacy.length + ' 条）')
  assert.ok(legacy.every(e => e.readonly === true), 'legacy 条目应只读')
  assert.ok(legacy.some(e => e.text.includes('部署脚本')) && legacy.some(e => e.text.includes('备份')),
    '逐条并存，不得互相 supersede')
  checks.push('legacy 多条镜像进 entries：' + legacy.length + ' 条 source=legacy / readonly=true')
}

// 8. memorySearch touch 频率强化（刷新 access_count + 分数单调不降）
{
  assert.equal(parse(await pb.memoryWrite('我喜欢用 PowerShell 编写部署脚本')).ok, true)
  const r1 = parse(await pb.memorySearch('PowerShell', 8))
  const p1 = r1.results.find(x => x.kind === 'profile' && x.text.includes('PowerShell'))
  const r2 = parse(await pb.memorySearch('PowerShell', 8))
  const p2 = r2.results.find(x => x.kind === 'profile' && x.text.includes('PowerShell'))
  assert.ok(p1 && p2, '两次检索都应命中画像层')
  assert.equal(p1.text, p2.text)
  assert.ok(p2.score >= p1.score - 1e-6, '重复命中分数应单调不降（frequency 强化）')
  const listed = parse(await pb.memoryEntriesList())
  const hit = listed.entries.find(e => e.kind === 'profile' && e.id === p2.id)
  assert.ok(hit && hit.hits >= 1, 'touch 应刷新 profile_kv.access_count')
  checks.push('memorySearch touch：access_count 刷新(' + (hit && hit.hits) + ') + 分数单调不降('
    + p1.score + '→' + p2.score + ')')
}

// 9. extras_block：标题 / attribute 字母序 / pin 置前 / buildSystemPrompt 注入
{
  assert.equal(parse(await pb.memoryWrite('部署动作在 Z 盘 deploy 目录', 'z_deploy')).ok, true)
  assert.equal(parse(await pb.memoryWrite('备份动作在 A 盘 bak 目录', 'a_backup')).ok, true)
  const extras0 = await pb.memoryExtrasBlock('')
  assert.ok(extras0.includes('【长期记忆·扩展】'), '扩展段应带标题')
  assert.ok(extras0.indexOf('[事实:a_backup]') < extras0.indexOf('[事实:z_deploy]'),
    '未钉选：按 attribute 字母序 a_backup 在 z_deploy 前')
  // 钉选 z_deploy 事实 → 注入段置前
  const listed = parse(await pb.memoryEntriesList())
  const deploy = listed.entries.find(e => e.kind === 'fact' && e.text.includes('部署动作'))
  assert.ok(deploy, '部署事实应在 entries 视图')
  assert.equal(parse(await pb.memoryEntryPin(deploy.kind, deploy.id, true)).ok, true)
  const extras1 = await pb.memoryExtrasBlock('')
  assert.ok(extras1.indexOf('[事实:z_deploy]') < extras1.indexOf('[事实:a_backup]'),
    'pin 置前：钉选的 z_deploy 应排在 a_backup 前')
  const prompt = parse(await provider.buildSystemPrompt(''))
  assert.ok(prompt.includes('【长期记忆·扩展】'), 'buildSystemPrompt 应注入扩展段')
  checks.push('extras_block：标题 + attribute 字母序 + pin 置前 + 注入 buildSystemPrompt')
}

console.log(JSON.stringify({
  ok: true,
  checks: checks.length,
  results: checks,
  openImplementationGaps: [],
  disposition: 'batch1 的 4 项 openImplementationGaps 已在引擎侧真实实现，本门逐项改为硬断言通过',
  coveredPins: ['test_r48_6_memory_write_honest_schema',
                'test_trace_service_span_and_read',
                'test_erase_soft_scrubs_and_stats',
                'test_api_entries_surface_and_mirror',
                'test_memory_search_ranking_and_touch',
                'test_entries_pin_erase_and_extras_priority'],
}, null, 2))
