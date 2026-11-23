// v3.4 I14（后半）· 跨项目记忆隔离
// 判据（施工总册 I14）：跨项目记忆严格隔离。
// 口径：条目带 ws（项目根）⇒ 只对同项目可见；无 ws 的 legacy 条目视为**全局**（向后兼容）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-memiso-'))
process.env.HARBOR_MEMORY_FILE = path.join(tmpDir, 'memory.json')
const mod = await import('../src/services/memory.js')
const { appendMemory, getMemory, memoryFilterByProject, _normWs } = mod

function reset() { try { fs.rmSync(path.join(tmpDir, 'memory.json'), { force: true }) } catch (e) {} }

test('归一：去尾斜杠、统一斜杠；空 ⇒ 全局', () => {
  // 反斜杠在多层转义里会被吃掉（连 String.raw 都救不了），改用 charCode 构造
  const BS = String.fromCharCode(92)
  assert.equal(_normWs('C:' + BS + 'work' + BS + 'a' + BS), 'C:/work/a')
  assert.equal(_normWs(''), '')
  assert.equal(_normWs(null), '')
})

test('过滤：同项目 + 全局可见，其他项目不可见', () => {
  const items = [
    { text: 'A 的规则', kind: 'rule', ws: '/proj/a' },
    { text: 'B 的规则', kind: 'rule', ws: '/proj/b' },
    { text: '全局规则', kind: 'rule' },
  ]
  const forA = memoryFilterByProject(items, '/proj/a').map(x => x.text)
  assert.deepEqual(forA, ['A 的规则', '全局规则'])
  const forB = memoryFilterByProject(items, '/proj/b').map(x => x.text)
  assert.deepEqual(forB, ['B 的规则', '全局规则'])
  // 反向对照：不能把 B 的规则给 A
  assert.ok(!forA.includes('B 的规则'))
})

test('无项目上下文 ⇒ 只看全局（不误放行任何项目私有条目）', () => {
  const items = [{ text: 'A', ws: '/proj/a' }, { text: 'G' }]
  assert.deepEqual(memoryFilterByProject(items, '').map(x => x.text), ['G'])
})

test('写入带 ws，读取能区分', async () => {
  reset()
  await appendMemory(JSON.stringify({ text: 'A 项目偏好', kind: 'rule', ws: '/proj/a' }))
  await appendMemory(JSON.stringify({ text: 'B 项目偏好', kind: 'rule', ws: '/proj/b' }))
  await appendMemory(JSON.stringify({ text: '全局约束', kind: 'rule' }))
  const all = JSON.parse(await getMemory())
  assert.equal(all.length, 3)
  assert.equal(all.find(x => x.text === 'A 项目偏好').ws, '/proj/a')
  assert.equal(all.find(x => x.text === '全局约束').ws, '')
  const forA = memoryFilterByProject(all, '/proj/a').map(x => x.text).sort()
  assert.deepEqual(forA, ['A 项目偏好', '全局约束'])
})

test('去重更新保留原 ws（不把项目记忆洗成全局）', async () => {
  reset()
  await appendMemory(JSON.stringify({ text: '重复规则', kind: 'rule', ws: '/proj/a' }))
  await appendMemory(JSON.stringify({ text: '重复规则', kind: 'rule' }))   // 同文本、未带 ws
  const all = JSON.parse(await getMemory())
  assert.equal(all.length, 1, '同文本规则应去重')
  assert.equal(all[0].ws, '/proj/a', '去重更新不得把 ws 清空（否则私有记忆泄漏成全局）')
})
