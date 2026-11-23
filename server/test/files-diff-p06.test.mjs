// 手册 P0-6 · 写前 Diff 的永久用例
// 判据：writeFile 覆盖写入时给出 before=原内容、after=新内容；新建文件 before=''；
//       searchReplace 的 before/after 是"被替换片段"而不是整文件；超长必须截断。
//
// 如何拿到可写工作区：ctxRoot() 回退到 runtime.cwd —— 直接把 runtime.cwd 指到临时目录即可，
// 不需要改生产代码、也不需要往安装目录写文件（第一版就是因为往安装目录写被守卫拒绝，
// 于是这项一直标着"未运行时验证"）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpMem = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p06mem-')), 'memory.json')
process.env.HARBOR_MEMORY_FILE = tmpMem
const { runtime } = await import('../src/runtime.js')
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'p06ws-'))
runtime.cwd = ws
const files = await import('../src/services/files.js')

test('覆盖写入：before=原内容，after=新内容', async () => {
  fs.writeFileSync(path.join(ws, 'a.txt'), 'OLD-CONTENT')
  const r = JSON.parse(await files.writeFile('a.txt', 'NEW-CONTENT'))
  assert.equal(r.ok, true)
  assert.equal(r.diff.before, 'OLD-CONTENT')
  assert.equal(r.diff.after, 'NEW-CONTENT')
})

test('新建文件：before 为空串', async () => {
  const r = JSON.parse(await files.writeFile('b.txt', 'FRESH'))
  assert.equal(r.ok, true)
  assert.equal(r.diff.before, '')
  assert.equal(r.diff.after, 'FRESH')
})

test('searchReplace：diff 是片段，不是整文件', async () => {
  fs.writeFileSync(path.join(ws, 'c.txt'), 'AAA BBB CCC')
  const r = JSON.parse(await files.searchReplace('c.txt', 'BBB', 'ZZZ'))
  assert.equal(r.ok, true)
  assert.equal(r.diff.before, 'BBB')
  assert.equal(r.diff.after, 'ZZZ')
  assert.equal(fs.readFileSync(path.join(ws, 'c.txt'), 'utf8'), 'AAA ZZZ CCC')
})

test('超长内容截断（防 Token 膨胀）', async () => {
  const r = JSON.parse(await files.writeFile('d.txt', 'x'.repeat(30000)))
  assert.equal(r.ok, true)
  assert.ok(r.diff.after.length <= 20000, 'after 未截断: ' + r.diff.after.length)
})
