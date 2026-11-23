// I05 · 自检闭环的**端到端**用例（不依赖模型）
//
// 判据：造语法错 → Agent 宣布完成前自动发现。模型"修不修"不归代码管，
// 但代码该负责的三段必须真跑通：
//   ① 从 `.harbor/verify` 解析命令 → ② **真实子进程**执行 → ③ 失败时把输出回灌成 system
// 本用例用 vm 加载前端模块（它是裸声明、无 ESM 导出），注入真实的 readFile/runCommand，
// 于是这三段都是真的，只有"模型会不会改"被跳过。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { spawn } from 'node:child_process'

const SRC = path.resolve('frontend/src/agent/self-check.js')
const code = fs.readFileSync(SRC, 'utf8')

function loadModule() {
  const ctx = { console, Date, JSON, Math, Number, String, Array, Object, Promise, setTimeout }
  vm.createContext(ctx)
  vm.runInContext(code + '\n;globalThis.__api = { selfCheckAfterWrites, selfCheckResolveCmd, selfCheckRun, selfCheckPickNpmScript };', ctx)
  return ctx.__api
}

// 必须在**工作区里**执行：`node --check broken.js` 是相对路径，
// 在仓库根跑会变成"文件不存在"（第一版就是这么红的，报错内容也不是 SyntaxError）。
function runCmdIn(cwd) {
  return (cmd, timeout) => runCmd(cmd, timeout, cwd)
}

function runCmd(cmd, timeout, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, windowsHide: true, cwd: cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', b => { out += b })
    child.stderr.on('data', b => { out += b })
    const t = setTimeout(() => { try { child.kill() } catch (e) {} }, timeout || 20000)
    child.on('close', (c) => { clearTimeout(t); resolve(JSON.stringify({ ok: c === 0, code: c, stdout: out, stderr: '' })) })
    child.on('error', e => { clearTimeout(t); resolve(JSON.stringify({ ok: false, code: -1, stdout: '', stderr: String(e.message) })) })
  })
}

const api = loadModule()

function mkws() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i05-'))
  fs.mkdirSync(path.join(dir, '.harbor'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.harbor', 'verify'), 'node --check broken.js\n')
  return dir
}

test('语法错：真实 node --check 失败，输出被回灌成 system', async () => {
  const ws = mkws()
  try {
    fs.writeFileSync(path.join(ws, 'broken.js'), 'function x( { return 1 }\n')   // 故意语法错
    const session = { id: 's1', messages: [] }
    const run = {}
    const injected = []
    const r = await api.selfCheckAfterWrites({
      session, run,
      readFile: async (p) => fs.existsSync(path.join(ws, p)) ? fs.readFileSync(path.join(ws, p), 'utf8') : null,
      runCommand: runCmdIn(ws),
      pushSystem: (s, text) => { s.messages.push({ role: 'system', content: text, __selfCheck: true }); injected.push(text) },
    })
    assert.equal(r.ran, true, '应当真的执行了验收命令')
    assert.equal(r.ok, false, '语法错必须判失败')
    assert.equal(r.injected, true, '失败应回灌')
    assert.equal(injected.length, 1)
    assert.match(injected[0], /SyntaxError|Unexpected token|Invalid/, '回灌内容应含真实错误输出')
    assert.ok(session.messages.length === 1 && session.messages[0].__selfCheck === true)
  } finally { fs.rmSync(ws, { recursive: true, force: true }) }
})

test('修好之后：同一会话重跑自检应为通过且不再回灌', async () => {
  const ws = mkws()
  try {
    fs.writeFileSync(path.join(ws, 'broken.js'), 'function x( { return 1 }\n')
    const session = { id: 's2', messages: [] }
    await api.selfCheckAfterWrites({
      session, run: {},
      readFile: async (p) => fs.existsSync(path.join(ws, p)) ? fs.readFileSync(path.join(ws, p), 'utf8') : null,
      runCommand: runCmdIn(ws),
      pushSystem: (s, t) => s.messages.push({ role: 'system', content: t, __selfCheck: true }),
    })
    const firstLen = session.messages.length
    // 模拟"模型修好了文件"
    fs.writeFileSync(path.join(ws, 'broken.js'), 'function x() { return 1 }\n')
    const r2 = await api.selfCheckAfterWrites({
      session, run: {},   // 新 run：attempts 重置
      readFile: async (p) => fs.existsSync(path.join(ws, p)) ? fs.readFileSync(path.join(ws, p), 'utf8') : null,
      runCommand: runCmdIn(ws),
      pushSystem: (s, t) => s.messages.push({ role: 'system', content: t, __selfCheck: true }),
    })
    assert.equal(r2.ok, true, '修好后应判通过')
    assert.equal(r2.injected, false, '通过时不得回灌')
    assert.equal(session.messages.length, firstLen, '通过时不应新增 system')
    assert.equal(session.__verifyLast.ok, true)
  } finally { fs.rmSync(ws, { recursive: true, force: true }) }
})

test('没有 verify 配置：不跑、不回灌（不猜命令）', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'i05b-'))
  try {
    const r = await api.selfCheckAfterWrites({
      session: { id: 's3', messages: [] }, run: {},
      readFile: async () => null, runCommand: runCmdIn(ws), pushSystem: () => {},
    })
    assert.equal(r.ran, false)
    assert.equal(r.reason, 'no-verify-cmd')
  } finally { fs.rmSync(ws, { recursive: true, force: true }) }
})
