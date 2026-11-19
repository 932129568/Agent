/**
 * 命令执行沙箱验证（P0-1b T02 断言更新：legacy 方言 {exit_code,output} /
 * 去重 {info,skipped} / 超时拍平 {error} / admin fail-closed 人审门——
 * 断言附 Python cmd_service.py 行号对照）。
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
const { guardSaveConfig } = guard
const { setCwd } = await import('../src/runtime.js')

setCwd(tmp)
await guardSaveConfig(JSON.stringify({ tiers: { run_command: 'always', run_powershell: 'always', run_admin_command: 'always' } }))

const results = []
const check = (name, fn) => { fn(); results.push(name) }
const tokenFor = async cmd => JSON.parse(await guard.guardConfirmToken('run_command', { cmd })).token

// 无 token 拒绝（enforce 文案含档位）
const refused = JSON.parse(await commands.runCommand('echo hi', 10, null))
check('无 token 时拒绝执行', () => assert.ok(refused.error.includes('确认')))

// token 参数摘要必须与 {cmd} 同源（错误形状不能误放行）
const wrongShapeToken = JSON.parse(await guard.guardConfirmToken('run_command', { command: 'echo shape' })).token
const wrongShape = JSON.parse(await commands.runCommand('echo shape', 10, wrongShapeToken))
check('错误参数形状的 token 不能执行', () => assert.ok(wrongShape.error.includes('确认')))

// run_admin_command 参数顺序 (cmd, token, timeout)：无 token 在人审门前拒绝
const adminRefused = JSON.parse(await commands.runAdminCommand('echo admin', null, 1))
check('提权命令无 token 时拒绝', () => assert.ok(adminRefused.error.includes('确认')))

// 正常执行：legacy 方言 {exit_code, output}
const echoCmd = 'echo harbor-sandbox-ok'
const okToken = await tokenFor(echoCmd)
const okResult = JSON.parse(await commands.runCommand(echoCmd, 10, okToken))
check('携带 token 正常执行回传 {exit_code, output}', () => {
  assert.equal(okResult.exit_code, 0)
  assert.ok(String(okResult.output).includes('harbor-sandbox-ok'))
  assert.equal(okResult.ok, undefined)   // legacy 方言无 ok 键
  assert.equal(okResult.stdout, undefined)
})

// 相同命令去重：{info, skipped:true}（cmd_service.py RunDeduper 文案逐字）
const dupToken = await tokenFor(echoCmd)
const dup = JSON.parse(await commands.runCommand(echoCmd, 10, dupToken))
check('相同命令短窗口去重 {info, skipped}', () => {
  assert.equal(dup.skipped, true)
  assert.ok(dup.info.includes('与上一条命令完全相同'))
})

// 黑名单
const badCmd = 'del /s /q C:\\'
const badToken = await tokenFor(badCmd)
const bad = JSON.parse(await commands.runCommand(badCmd, 10, badToken))
check('黑名单命令即使有 token 也拒绝', () => {
  assert.ok(bad.error.includes('黑名单'))
})

// 超时：拍平 {error:'命令执行超时(<t>s)'} + 去重登记回滚（W1：可立即重试）
const sleepCmd = 'powershell -NoProfile -Command Start-Sleep -Seconds 8'
const sleepToken = await tokenFor(sleepCmd)
const started = Date.now()
const timedOut = JSON.parse(await commands.runCommand(sleepCmd, 1, sleepToken))
check('超时命令拍平为 {error: 命令执行超时(Ns)}（N=max(5,入参) 夹逼，Python 同口径）', () => {
  assert.ok(timedOut.error.includes('命令执行超时(5s)'))
  assert.ok(Date.now() - started < 15000)
})
const retryToken = await tokenFor(sleepCmd)
const retried = JSON.parse(await commands.runCommand(sleepCmd, 1, retryToken))
check('超时后去重登记已回滚（合法重试不再被去重拦截）', () => {
  assert.ok(!retried.info || !retried.info.includes('与上一条命令'))
  assert.ok(retried.error.includes('命令执行超时'))
})

// admin 人审门 fail-closed：无 seam 无 UI 钩子 → 拒绝（E4 收紧）
const adminToken = JSON.parse(await guard.guardConfirmToken('run_admin_command', { cmd: 'echo admin' })).token
const adminDenied = JSON.parse(await commands.runAdminCommand('echo admin', adminToken, 1))
check('admin 人审门 fail-closed 拒绝（无 seam 时 IDNO 同款回执）', () => {
  assert.equal(adminDenied.skipped, true)
  assert.ok(adminDenied.info.includes('用户拒绝了本次管理员命令'))
})

// 输出截断（用临时脚本而非 node -e，避免 cmd.exe 嵌套引号改变参数语义）
fs.writeFileSync(path.join(tmp, 'big.js'), "console.log('x'.repeat(100000))")
const bigCmd = 'node big.js'
const bigToken = await tokenFor(bigCmd)
const big = JSON.parse(await commands.runCommand(bigCmd, 30, bigToken))
check('超长输出按 6000 字截断并附 toolcache 续读引用', () => {
  assert.equal(big.exit_code, 0)
  assert.ok(big.output.includes('已截断'))
  assert.ok(/id=tc\d+_\d+, 用 read_more 分段获取/.test(big.output))
  assert.ok(big.output.length < 3200)
})

console.log(JSON.stringify({ ok: true, node: process.version, checks: results.length, results }, null, 2))
