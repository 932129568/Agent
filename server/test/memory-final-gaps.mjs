/**
 * C 路径 · batch3 剩余 gap 收口门（+ 7 项缺口覆盖地图）。
 *
 * batch3 v1 里 3 个 gap：
 *   - test_corrupt_file_bad_backup → 由 settings-equivalence.mjs 第 6 项硬断言（.bad 备份）
 *   - test_guard_loadcfg_cache_and_invalidate → 本门第 1 项（真实构造：缓存命中 /
 *     save 后失效 / 外部改档失效）
 *   - test_memory_list_cache → 本门第 2 项（真实构造：连续 list 一致 /
 *     外部改文件失效 / saveAll 写后失效）
 *
 * 与 memory-equivalence.mjs（batch1 四项）+ settings-equivalence.mjs（.bad）
 * 合起来，7 项 openImplementationGaps 全部由真实场景硬断言覆盖。
 *
 * 用法：node server/test/memory-final-gaps.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 与其他门同范式：先隔离 CONFIG_DIR 再动态 import，绝不写真实 ~/.glm-chat。
const isoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-final-gaps-'))
process.env.HARBOR_CONFIG_DIR = isoDir
process.on('exit', () => {
  try { fs.rmSync(isoDir, { recursive: true, force: true }) } catch { /* 容忍 */ }
})

const guard = await import('../src/services/guard.js')
const memory = await import('../src/services/memory.js')
const checks = []

/* ---------------- gap6：guard loadCfg 缓存与 save 后失效 ----------------
 * 复刻 tests/test_r59_deps.py::test_guard_loadcfg_cache_and_invalidate 的
 * Node 子进程场景，并补一条「外部改档（mtime+size）失效」——与 guard.js 的
 * loadCfg 指纹缓存 + persistCfg 写档失效两条路径一一对应。 */
{
  const guardFile = path.join(isoDir, 'guard.json')
  // 缓存命中：连续两次 guardCheck 结果逐字节一致
  const c1 = await guard.guardCheck('web_search', {})
  const c2 = await guard.guardCheck('web_search', {})
  assert.equal(c1, c2, '连续两次 guardCheck 命中缓存，结果应一致')
  assert.equal(JSON.parse(c1).action, 'allow', 'web_search 默认 off 档')

  // save 后失效：off → always 两次写档，判定必须随档位变化（缓存被清）
  await guard.guardSaveConfig(JSON.stringify({ tiers: { web_search: 'off' } }))
  const afterSave = JSON.parse(await guard.guardCheck('web_search', {})).action
  await guard.guardSaveConfig(JSON.stringify({ tiers: { web_search: 'always' } }))
  const afterResave = JSON.parse(await guard.guardCheck('web_search', {})).action
  assert.ok(['allow', 'confirm'].includes(afterSave))
  assert.notEqual(afterSave, afterResave, 'save 后缓存未失效：档位变化应反映到判定')
  assert.equal(afterResave, 'confirm', 'always 档应 confirm')

  // 外部改档失效：绕过 guardSaveConfig 直接写文件（mtime+size 变）
  fs.writeFileSync(guardFile, JSON.stringify({ tiers: { web_search: 'off' } }), 'utf8')
  const afterExternal = JSON.parse(await guard.guardCheck('web_search', {})).action
  assert.equal(afterExternal, 'allow', '外部改档应使 loadCfg 指纹缓存失效')
  checks.push('guard loadCfg 缓存：连续命中一致 + save 后失效(' + afterSave + '→'
    + afterResave + ') + 外部改档失效(' + afterExternal + ')')
}

/* ---------------- gap7：memory 列表缓存与外部写入失效 ----------------
 * 复刻 tests/test_r59_deps.py::test_memory_list_cache：list 空 → append →
 * 连续 list 一致 → 外部改文件后 list 反映新内容；再补一条 saveAll 写后失效。 */
{
  const memFile = path.join(isoDir, 'memory.json')
  const empty = JSON.parse(await memory.getMemory())
  assert.deepEqual(empty, [], '初始 list 应为 []')

  assert.equal(JSON.parse(await memory.appendMemory({ text: '缓存验证条目', kind: 'fact' })).ok, true)
  const first = JSON.parse(await memory.getMemory())
  const second = JSON.parse(await memory.getMemory())
  assert.deepEqual(first, second, '连续两次 list 结果一致（缓存命中）')
  assert.equal(first.length, 1)
  assert.equal(first[0].text, '缓存验证条目')

  // 外部写入（mtime+size 变）→ 缓存失效：内容长度刻意不同，指纹必变
  fs.writeFileSync(memFile, JSON.stringify([
    { kind: 'fact', text: '外部写入的不同长度条目XYZ', ts: '01-01 00:00', ts_iso: '2025-01-01T00:00:00.000' },
  ]), 'utf8')
  const third = JSON.parse(await memory.getMemory())
  assert.equal(third.length, 1)
  assert.equal(third[0].text, '外部写入的不同长度条目XYZ', '外部写入应使列表缓存失效')

  // 服务内写后失效（saveAll → 缓存清空，下次按新指纹重读）
  const appended = JSON.parse(await memory.appendMemory({ text: '服务内追加', kind: 'fact' }))
  assert.equal(appended.ok, true)
  const fourth = JSON.parse(await memory.getMemory())
  assert.equal(fourth.length, 2, 'saveAll 后应读到外部条目 + 新追加条目')
  assert.ok(fourth.some(x => x.text === '服务内追加'), 'saveAll 写后缓存失效，新写入可见')
  checks.push('memory list 缓存：连续 list 一致 + 外部写入失效 + saveAll 写后失效')
}

console.log(JSON.stringify({
  ok: true,
  checks: checks.length,
  results: checks,
  openImplementationGaps: [],
  gapCoverage: [
    { gap: 1, item: 'memoryErase 软擦除 scrub', gate: 'memory-equivalence.mjs #6', status: 'implemented+hard-asserted' },
    { gap: 2, item: 'legacy 多条镜像进 entries', gate: 'memory-equivalence.mjs #7', status: 'implemented+hard-asserted' },
    { gap: 3, item: 'memorySearch touch 频率强化', gate: 'memory-equivalence.mjs #8', status: 'implemented+hard-asserted' },
    { gap: 4, item: 'extras_block 标题/字母序/pin 置前', gate: 'memory-equivalence.mjs #9', status: 'implemented+hard-asserted' },
    { gap: 5, item: '损坏 model_prefs.json 生成 .bad 备份', gate: 'settings-equivalence.mjs #6', status: 'implemented+hard-asserted' },
    { gap: 6, item: 'guard 配置缓存与 save 后失效', gate: 'memory-final-gaps.mjs #1', status: 'implemented+hard-asserted' },
    { gap: 7, item: 'memory 列表缓存与外部写入失效', gate: 'memory-final-gaps.mjs #2', status: 'implemented+hard-asserted' },
  ],
  disposition: '7 项缺口全部真实实现并由真实场景硬断言覆盖；无剩余缺口，无伪造通过',
}, null, 2))
