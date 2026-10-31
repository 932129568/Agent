/**
 * 差分 harness · Node 侧桩预载（`node --import server/test/diff/preload-mocks.mjs`）。
 *
 * 仅当编排器注入 HARBOR_DIFF_MOCKS 含 "subprocess" 时激活。读取与 Python 侧
 * tools/diff/fakes.py 相同的共享 mock 表（tools/diff/mock-table.json），
 * 以同一套匹配语义补丁 node:child_process 的 execFile 导出：
 *   - file=basename（忽略大小写与 .exe 后缀差异）+ argvContains 全部命中；
 *   - kind=cmd（cmd.exe /c 载荷）与 kind=powershell（-Command 载荷）通道匹配；
 *   - stdoutRepeat 展开（{char,count}）；timeout=true → killed/signal 超时错误；
 *   - 未命中一律放行真实 execFile（prisma db push 等基础设施调用不受影响）。
 *
 * 不改动任何生产服务代码；本文件在服务模块 import 之前生效（--import 时点）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const MOCKS = String(process.env.HARBOR_DIFF_MOCKS || '')
  .split(',').map(x => x.trim()).filter(Boolean)
if (!MOCKS.includes('subprocess')) process.exit(0)

const require = createRequire(import.meta.url)
const promisifySymbol = Symbol.for('nodejs.util.promisify.custom')

function loadTable() {
  const tablePath = process.env.HARBOR_DIFF_MOCK_TABLE
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)),
      '..', '..', '..', 'tools', 'diff', 'mock-table.json')
  return JSON.parse(fs.readFileSync(tablePath, 'utf8'))
}

function normFile(name) {
  const base = path.basename(String(name || '').trim().replace(/^"|"$/g, '')).toLowerCase()
  return base.endsWith('.exe') ? base.slice(0, -4) : base
}

function expandStdout(entry) {
  const rep = entry.stdoutRepeat
  if (rep) return String(rep.char || 'X').repeat(Number(rep.count) || 0)
  return String(entry.stdout || '')
}

function matchEntry(entry, norm, text) {
  if (entry.file) {
    if (normFile(entry.file) !== norm) return false
    return (entry.argvContains || []).every(c => text.includes(String(c)))
  }
  if (entry.kind === 'cmd') {
    if (!['cmd', 'cmd.exe'].includes(norm)) return false
  } else if (entry.kind === 'powershell') {
    if (!['powershell', 'pwsh'].includes(norm)) return false
  } else return false
  return (entry.contains || []).every(c => text.includes(String(c)))
}

const table = loadTable()
const entries = table.exec || []
const cp = require('node:child_process')
const realExecFile = cp.execFile

function findMatch(file, args) {
  const norm = normFile(file)
  const text = (Array.isArray(args) ? args : []).map(String).join(' ')
  return entries.find(entry => matchEntry(entry, norm, text)) || null
}

function patchedExecFile(file, ...rest) {
  const original = [file, ...rest]
  let callback = null
  if (typeof rest[rest.length - 1] === 'function') callback = rest.pop()
  let args = []
  if (Array.isArray(rest[0])) args = rest.shift()
  const options = rest[0] && typeof rest[0] === 'object' ? rest[0] : {}

  if (!callback) return realExecFile(...original) // 非回调调用形态（ChildProcess）一律放行
  const entry = findMatch(file, args)
  if (!entry) return realExecFile(...original)

  if (entry.timeout) {
    const err = Object.assign(new Error('Command timed out'), {
      killed: true, signal: 'SIGKILL', code: null,
      stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
    })
    return setTimeout(() => callback(err), 10)
  }
  const stdout = Buffer.from(expandStdout(entry), 'utf8')
  const stderr = Buffer.from(String(entry.stderr || ''), 'utf8')
  const code = Number(entry.exitCode || 0)
  if (code !== 0) {
    const err = Object.assign(new Error(`Command failed with exit code ${code}`), {
      code, killed: false, signal: null, stdout, stderr,
    })
    return setTimeout(() => callback(err, stdout, stderr), 10)
  }
  return setTimeout(() => callback(null, stdout, stderr), 10)
}

// promisify(execFile) 走 custom 符号时必须仍进入本桩：自定义实现直接以
// error-first 三参回调调用 patchedExecFile，保持 {stdout, stderr} 解构语义。
patchedExecFile[promisifySymbol] = (file, ...rest) => new Promise((resolve, reject) => {
  patchedExecFile(file, ...rest, (err, stdout, stderr) => {
    if (err) { Object.assign(err, { stdout, stderr }); reject(err) }
    else resolve({ stdout, stderr })
  })
})

cp.execFile = patchedExecFile
