/**
 * 命令执行沙箱验证：护栏强制、黑名单、超时强杀、输出截断、去重、工作目录。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-cmd-'))
process.env.HARBOR_CONFIG_DIR = path.join(tmp, 'config')
process.env.DATABASE_URL = `file:${path.join(tmp, 'app.db')}`
process.env.LOG_LEVEL = 'silent'

const commands = await import('../src/services/commands.js')
const guard = await import('../src/services/guard.js')
const { mergeConfig } = await import('../src/services/jsonstore.js')
const { setCwd } = await import('../src/runtime.js')

setCwd(tmp)
mergeConfig('guard.json', JSON.stringify({ tiers: { run_command: 'always', run_powershell: 'always' } }))

const results = []
const check = (name, fn) => { fn(); results.push(name) }
const tokenFor = async cmd => JSON.parse(await guard.guardConfirmToken('run_command', { cmd })).token

// 无 token 拒绝
const refused = JSON.parse(await commands.runCommand('echo hi', 10, null))
check('无 token 时拒绝执行', () => assert.ok(refused.error.includes('确认')))

// token 参数摘要必须与前端/legacy 的 {cmd} 同源，错误形状不能误放行
const wrongShapeToken = JSON.parse(await guard.guardConfirmToken('run_command', { command: 'echo shape' })).token
const wrongShape = JSON.parse(await commands.runCommand('echo shape', 10, wrongShapeToken))
check('错误参数形状的 token 不能执行', () => assert.ok(wrongShape.error.includes('确认')))

// run_admin_command 的参数顺序是 (cmd, token, timeout)，无 token 时必须在 UAC 前拒绝
const adminRefused = JSON.parse(await commands.runAdminCommand('echo admin', null, 1))
check('提权命令无 token 时在 UAC 前拒绝', () => assert.ok(adminRefused.error.includes('确认')))

// 正常执行
const echoCmd = 'echo harbor-sandbox-ok'
const okToken = await tokenFor(echoCmd)
const okResult = JSON.parse(await commands.runCommand(echoCmd, 10, okToken))
check('携带 token 正常执行并回传 stdout', () => {
  assert.equal(okResult.code, 0)
  assert.ok(okResult.stdout.includes('harbor-sandbox-ok'))
})
check('执行目录为有效工作区', () => assert.equal(okResult.cwd, tmp))

// 相同命令去重
const dupToken = await tokenFor(echoCmd)
const dup = JSON.parse(await commands.runCommand(echoCmd, 10, dupToken))
check('相同命令短窗口去重', () => assert.equal(dup.deduped, true))

// 黑名单
const badCmd = 'del /s /q C:\\'
const badToken = await tokenFor(badCmd)
const bad = JSON.parse(await commands.runCommand(badCmd, 10, badToken))
check('黑名单命令即使有 token 也拒绝', () => {
  assert.ok(bad.error.includes('黑名单'))
})

// 超时强杀
const sleepCmd = 'powershell -NoProfile -Command Start-Sleep -Seconds 8'
const sleepToken = await tokenFor(sleepCmd)
const started = Date.now()
const timedOut = JSON.parse(await commands.runCommand(sleepCmd, 1, sleepToken))
check('超时命令被强杀并标记 timeout', () => {
  assert.equal(timedOut.timeout, true)
  assert.ok(Date.now() - started < 15000)
})

// 输出截断（用临时脚本而非 node -e，避免 cmd.exe 嵌套引号改变参数语义）
fs.writeFileSync(path.join(tmp, 'big.js'), "console.log('x'.repeat(100000))")
const bigCmd = 'node big.js'
const bigToken = await tokenFor(bigCmd)
const big = JSON.parse(await commands.runCommand(bigCmd, 30, bigToken))
check('超长输出被截断并标记', () => {
  assert.equal(big.truncated, true)
  assert.ok(big.stdout.length < 70000)
})

// software_list / software_probe / software_call：真实注册表与 argv 分发
const channels = JSON.parse(await commands.softwareList())
check('software_list 返回内置软件与动作 schema', () => {
  const node = channels.software.find(x => x.name === 'node')
  assert.ok(node)
  assert.ok(node.actions.some(x => x.name === 'run_script'))
})
const probe = JSON.parse(await commands.softwareProbe('node'))
check('software_probe 验证 Node 身份', () => {
  assert.equal(probe.ok, true)
  assert.equal(probe.probed[0].status, 'probed')
})
const version = JSON.parse(await commands.softwareCall({ software: 'node', action: 'version', args: {} }))
check('software_call 以 argv 执行只读动作并标记 UNTRUSTED', () => {
  assert.equal(version.ok, true, JSON.stringify(version))
  assert.equal(version.exit_code, 0)
  assert.ok(version.stdout.includes(process.version))
  assert.equal(version.untrusted, true)
})
fs.writeFileSync(path.join(tmp, 'safe script.js'), "console.log('software-argv-ok')")
const invalid = JSON.parse(await commands.softwareCall({ software: 'node', action: 'run_script', args: {} }))
check('缺 script 返回 SCHEMA_INVALID 与修正示例', () => {
  assert.equal(invalid.error.code, 'SCHEMA_INVALID')
  assert.ok(invalid.error.example.script)
})
const scriptDenied = JSON.parse(await commands.softwareCall({ software: 'node', action: 'run_script', args: { script: 'safe script.js' } }))
check('高危脚本无 token 拒绝', () => assert.equal(scriptDenied.error.code, 'CONFIRM_REQUIRED'))
const scriptToken = JSON.parse(await guard.guardConfirmToken('software_call', { software: 'node', action: 'run_script' })).token
const scriptResult = JSON.parse(await commands.softwareCall({ software: 'node', action: 'run_script', args: { script: 'safe script.js' } }, scriptToken))
check('高危脚本携带 token 后按工作区相对路径执行', () => {
  assert.equal(scriptResult.ok, true, JSON.stringify(scriptResult))
  assert.ok(scriptResult.stdout.includes('software-argv-ok'))
})
const escapedScript = JSON.parse(await commands.softwareCall({ software: 'node', action: 'run_script', args: { script: '../outside.js' } }))
check('软件路径参数越出工作区被 SCHEMA_INVALID 拒绝', () => assert.equal(escapedScript.error.code, 'SCHEMA_INVALID'))

console.log(JSON.stringify({ ok: true, node: process.version, checks: results.length, results }, null, 2))
