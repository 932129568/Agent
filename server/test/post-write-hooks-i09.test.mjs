// v3.4 I09 · 沙箱 Hooks：写后自动执行 + **零孤儿进程**
// 判据（施工总册 I09）：写文件后自动跑格式化，零孤儿进程泄漏。
// 孤儿 = 超时后仍存活的孙进程。只 kill 直接子进程时，会留下后代继续跑。
// 因此本用例把 hook 写成"启动一个稍后写标记的孙进程"，断言超时后该标记**永不出现**。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { runPostWriteHook, loadHooks } from '../src/services/postWriteHooks.mjs'

const wait = (ms) => new Promise(r => setTimeout(r, ms))

function mkws(hooks, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-hooks-'))
  if (hooks) {
    fs.mkdirSync(path.join(dir, '.harbor'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.harbor', 'hooks.json'), typeof hooks === 'string' ? hooks : JSON.stringify(hooks))
  }
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body)
  return dir
}
function rmws(dir) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) {} }

test('没有配置 ⇒ 一次都不跑（ran=false）', async () => {
  const ws = mkws(null)
  try {
    assert.equal(loadHooks(ws), null)
    assert.equal((await runPostWriteHook(ws, 'a.txt')).ran, false)
  } finally { rmws(ws) }
})

test('配置合法 ⇒ 真的执行，且 {file} 被替换成相对路径', async () => {
  const ws = mkws({ post_write: 'node mark.cjs {file}' }, {
    'mark.cjs': [
      "const fs = require('fs'), path = require('path')",
      "const p = process.argv[2]",
      "fs.mkdirSync(path.dirname(p), { recursive: true })",
      "fs.writeFileSync(p, 'ran')",
      "",
    ].join('\n'),
  })
  try {
    const r = await runPostWriteHook(ws, 'sub/a.txt')
    assert.equal(r.ran, true)
    assert.equal(r.ok, true, 'hook 应成功: ' + r.output)
    assert.equal(fs.readFileSync(path.join(ws, 'sub/a.txt'), 'utf8'), 'ran')
  } finally { rmws(ws) }
})

test('配置是坏 JSON ⇒ 当没有配置，不跑也不抛', async () => {
  const ws = mkws('{ this is not json')
  try {
    assert.equal(loadHooks(ws), null)
    assert.equal((await runPostWriteHook(ws, 'a.txt')).ran, false)
  } finally { rmws(ws) }
})

test('超时 ⇒ timedOut，且**孙进程不再存活**（零孤儿）', async () => {
  // hook 启一个 detached 孙进程：2.5s 后写 late.txt；自身进入死循环。
  // timeout 300ms 时必须把整棵树杀掉，否则 2.5s 后 late.txt 会出现。
  const ws = mkws({ post_write: 'node orphan.cjs' }, {
    'orphan.cjs': [
      "const cp = require('child_process')",
      "const code = \"setTimeout(()=>require('fs').writeFileSync('late.txt','orphan'),2500)\"",
      "cp.spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' }).unref()",
      "setInterval(()=>{}, 1000)",
      "",
    ].join('\n'),
  })
  try {
    const t0 = Date.now()
    const r = await runPostWriteHook(ws, 'x.txt', { timeoutMs: 300 })
    const cost = Date.now() - t0
    assert.equal(r.ran, true)
    assert.equal(r.timedOut, true, '应超时')
    assert.ok(cost < 2000, '超时后应及时返回，实际 ' + cost + 'ms')
    await wait(3200)   // 等过孙进程 2500ms 的触发点
    assert.equal(fs.existsSync(path.join(ws, 'late.txt')), false, '孙进程写出的 late.txt 存在 ⇒ 有孤儿存活')
  } finally { rmws(ws) }
})

test('hook 非零退出 ⇒ ok=false + code，但不抛异常', async () => {
  const ws = mkws({ post_write: 'node fail.cjs' }, { 'fail.cjs': 'process.exit(3)\n' })
  try {
    const r = await runPostWriteHook(ws, 'a.txt')
    assert.equal(r.ran, true)
    assert.equal(r.ok, false)
    assert.equal(r.code, 3)
  } finally { rmws(ws) }
})
