// v3.4 I14 · 原子记忆：零脏段落入库
// 判据（施工总册 I14）：零脏段落入库。本项目口径的"脏"= 能证明是垃圾且会毒化提示的内容：
//   ① C0 控制字符（除 \n \t）② 超长整段（>800 字）③ 纯控制字符条目 ④ CRLF 混入
// 注意：**不做语义改写**——只清除能证明是垃圾的部分。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-mem-')), 'memory.json')
process.env.HARBOR_MEMORY_FILE = tmpFile
const mod = await import('../src/services/memory.js')
const { appendMemory, getMemory, sanitizeMemoryText } = mod

function reset() { try { fs.rmSync(tmpFile, { force: true }) } catch (e) {} }

test('控制字符被清除（保留换行与制表）', () => {
  const r = sanitizeMemoryText('a\u0000b\u0007c\td\ne')
  assert.equal(r.text, 'abc\td\ne')
  assert.equal(r.dirty, true)
})

test('CRLF 归一为 LF，3+ 空行压成 1 个空行', () => {
  const r = sanitizeMemoryText('a\r\nb\n\n\n\nc')
  assert.equal(r.text, 'a\nb\n\nc')
})

test('超长条目截断并打标记（不静默）', () => {
  const r = sanitizeMemoryText('x'.repeat(1200))
  assert.equal(r.truncated, true)
  assert.ok(r.text.endsWith('…(已截断)'))
  assert.equal(r.text.length, 801 + '…(已截断)'.length - 1 + 1 - 1)  // 800 + 标记
})

test('纯控制字符的条目不入库（原文非空但清洗后为空）', async () => {
  reset()
  const res = JSON.parse(await appendMemory(JSON.stringify({ text: '\u0000\u0001\u0002' })))
  assert.equal(res.skipped, true)
  assert.equal(res.reason, 'dirty')
  const all = JSON.parse(await getMemory())
  assert.equal(all.length, 0, '脏条目不得落库')
})

test('正常条目原样入库，不带 cleaned 标记', async () => {
  reset()
  const res = JSON.parse(await appendMemory(JSON.stringify({ text: '决定采用方案 A', kind: 'rule' })))
  assert.equal(res.ok, true)
  assert.equal(res.cleaned, undefined)
  const all = JSON.parse(await getMemory())
  assert.equal(all.length, 1)
  assert.equal(all[0].text, '决定采用方案 A')
})

test('截断条目入库时带 truncated 标记，存的也是截断后的文本', async () => {
  reset()
  const big = 'y'.repeat(1000)
  const res = JSON.parse(await appendMemory(JSON.stringify({ text: big })))
  assert.equal(res.truncated, true)
  const all = JSON.parse(await getMemory())
  assert.equal(all.length, 1)
  assert.ok(all[0].text.length < 1000)
  assert.ok(all[0].text.endsWith('…(已截断)'))
})
