/**
 * OS 原生与杂项服务验证（隔离环境；GUI 类能力单列为 UNCOVERED）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-sys-'))
process.env.HARBOR_CONFIG_DIR = path.join(tmp, 'config')
process.env.DATABASE_URL = `file:${path.join(tmp, 'app.db')}`
process.env.LOG_LEVEL = 'silent'
// K1 四层防线用未武装路径（与差分环境同构；武装态 resolve-failed 阻断由 guard 面覆盖）
process.env.HARBOR_GUARD_ARMED = 'false'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
await promisify(execFile)(process.execPath,
  ['node_modules/prisma/build/index.js', 'db', 'push', '--schema=./prisma/schema.prisma'],
  { cwd: serverRoot, env: process.env })

const system = await import('../src/services/system.js')
const provider = await import('../src/services/provider.js')
const { setCwd } = await import('../src/runtime.js')
const { invoke, listMethods } = await import('../src/registry.js')
const { saveSessions } = await import('../src/services/sessions.js')
const { readMore } = await import('../src/services/files.js')
const { mergeConfig } = await import('../src/services/jsonstore.js')

// OS 语义测试只隔离文件/剪贴板行为；护栏本身的拒绝路径由 test:guard 覆盖。
mergeConfig('guard.json', JSON.stringify({ tiers: { clipboard_read: 'off', clipboard_write: 'off' } }))

setCwd(tmp)
const results = []
const check = (name, fn) => { fn(); results.push(name) }

const platform = JSON.parse(await system.getPlatformInfo())
check('get_platform_info 返回平台与 Node 版本', () => {
  assert.equal(platform.node, process.version)
  assert.ok(platform.platform)
})

const processes = JSON.parse(await system.listProcesses('node'))
check('list_processes 返回带 pid 的数组', () => {
  assert.ok(Array.isArray(processes))
  assert.ok(processes.length > 0)
  assert.ok(processes[0].pid > 0)
})

// 剪贴板：先备份原文，测试后恢复（不污染用户状态）
let clipboardBackup = null
try { clipboardBackup = await system.getClipboard() } catch (error) { clipboardBackup = null }
await system.setClipboard('harbor-clipboard-test')
const clip = await system.getClipboard()
check('set/get_clipboard 回环', () => assert.equal(clip, 'harbor-clipboard-test'))
if (clipboardBackup !== null) await system.setClipboard(clipboardBackup)

const tools = JSON.parse(await provider.buildTools('full', false, false))
check('build_tools 输出完整 function-calling 结构', () => {
  assert.ok(Array.isArray(tools))
  assert.ok(tools.some(t => t.function.name === 'read_file'))
  assert.ok(tools.some(t => t.function.name === 'run_command'))
  assert.equal(tools[0].function.name, 'read_more')
})
const agentTools = JSON.parse(await provider.buildTools('full', false, true))
check('include_agent 追加浏览器与外部软件工具', () => {
  assert.ok(agentTools.some(t => t.function.name === 'browser_navigate'))
  assert.ok(agentTools.some(t => t.function.name === 'software_call'))
})
const glmTools = JSON.parse(await provider.buildTools('full', false, true, true))
check('GLM 端点过滤 browser_* 避免双搜索', () => {
  assert.ok(!glmTools.some(t => t.function.name.startsWith('browser_')))
  assert.ok(glmTools.some(t => t.function.name === 'software_call'))
})

const prompt = await provider.buildSystemPrompt('')
check('build_system_prompt 含工作区路径', () => assert.ok(prompt.includes(tmp)))
const versionedPrompt = JSON.parse(await provider.promptGet('system-base'))
check('prompt_get 返回版本化提示词', () => {
  assert.equal(versionedPrompt.ok, true)
  assert.ok(versionedPrompt.version)
  assert.ok(versionedPrompt.text.length > 0)
})

const cached = JSON.parse(await provider.cacheToolOutput('v1'))
const cachedMore = JSON.parse(await readMore(cached.id, 0, 10))
check('cache_tool_output 返回 id 且 read_more 同源', () => {
  assert.ok(cached.id)
  assert.equal(cachedMore.content, 'v1')
})
const cleared = await provider.clearCaches()
check('clear_caches 返回 legacy ok 文本', () => assert.equal(cleared, 'ok'))

const trace = JSON.parse(await provider.traceNew())
check('trace_new 返回 uuid', () => assert.ok(trace.trace.length >= 32))

const clarified = JSON.parse(await provider.clarifyCollect([
  { q: '范围', options: ['全部', '部分'], default: 0 },
], { 0: 1 }))
check('clarify_collect 返回 resolved', () => assert.equal(clarified.resolved[0].answer, '部分'))

const exportTarget = path.join(tmp, 'report.md')
const exported = JSON.parse(await provider.saveExportFile(exportTarget, '# 标题'))
check('save_export_file 拒绝未登记路径且不写文件', () => {
  assert.ok(exported.error.includes('对话框'))
  assert.equal(fs.existsSync(exportTarget), false)
})

// session_purge：先造一条会话与计划，再删
await saveSessions(JSON.stringify([{ id: 's_purge', title: 't', messages: [] }]))
const purged = JSON.parse(await provider.sessionPurge('s_purge'))
check('session_purge 删除会话记录', () => assert.equal(purged.removed.sessions, 1))

const rpcResult = await invoke('rpc', ['get_api_info', '{}'])
check('rpc 透传到 get_api_info', () => {
  assert.equal(JSON.parse(rpcResult).version, 'v1.0.0')
})
const rpcKwargs = await invoke('rpc', ['build_tools', JSON.stringify({ role: 'chat', include_agent: true })])
check('rpc 按 legacy kwargs 映射参数', () => assert.equal(rpcKwargs, '[]'))
fs.writeFileSync(path.join(tmp, 'rpc.txt'), 'a')
const rpcReplace = JSON.parse(await invoke('rpc', ['search_replace',
  JSON.stringify({ path: 'rpc.txt', old: 'a', new: 'b', replace_all: false })]))
check('rpc 对保留字 new 使用显式签名映射', () => {
  assert.equal(rpcReplace.ok, true)
  assert.equal(fs.readFileSync(path.join(tmp, 'rpc.txt'), 'utf8'), 'b')
})

const probeResult = JSON.parse(await provider.localProbe('[]'))
check('local_probe 返回 reachable/unreachable 分组', () => {
  assert.equal(probeResult.ok, true)
  assert.ok(Array.isArray(probeResult.reachable))
  assert.ok(Array.isArray(probeResult.unreachable))
})

const killRefused = JSON.parse(await system.killProcess(999999, null, null))
check('kill_process 进程不存在 → 成功形状 + 非零 exit_code（Agent 判断力）', () => {
  assert.ok(listMethods().includes('kill_process'))
  assert.equal(killRefused.ok, false)
  assert.equal(typeof killRefused.exit_code, 'number')
  assert.ok(killRefused.exit_code !== 0)
})

// P0-1c K1 四层防线（未武装路径——与差分环境同构；process_service.py:126-164 逐层对照）
const fakeKill = JSON.parse(await system.killProcess('abc', null, null))
check('K1-C1 非数字 pid 拒绝（%r 单引号）', () => {
  assert.ok(fakeKill.error && fakeKill.error.includes("pid 必须是数字: 'abc'"))
})
const wildcard = JSON.parse(await system.killProcess(null, '*', null))
check('K1-S3 通配符进程名拒绝（taskkill /IM 批量强杀面）', () => {
  assert.ok(wildcard.error && wildcard.error.includes('不支持通配符'))
})
const protectedName = JSON.parse(await system.killProcess(null, 'lsass.exe', null))
check('K1-P4 保护名单拒绝（guard ①层内置名单，token 后仍生效）', () => {
  assert.ok(protectedName.error && protectedName.error.includes('属于保护名单'))
})
const selfPid = JSON.parse(await system.killProcess(process.pid, null, null))
check('K1-P4 自身 pid 拒绝（Harbor 自身）', () => {
  assert.ok(selfPid.error && selfPid.error.includes('Harbor 自身'))
})

console.log(JSON.stringify({
  ok: true, node: process.version, checks: results.length, results,
  uncovered: ['open_app/open_url（启动外部进程）', 'pick_folder/pick_save_path（GUI 对话框）', 'take_screenshot（GUI 截图）'],
}, null, 2))
