/**
 * DEF-02 / DEF-03 授权修复的验收门。
 *
 * 对齐两个 Python 行为钉：
 *   - test_trace_wired_into_guarded_and_begin_task：begin_task 落 agent.run，
 *     护栏操作落 tool.open_url，trace_recent 可读回；
 *   - test_r48_8_trace_retention：RETENTION_DAYS == 14，span() 后 20 天前
 *     的 gen_ai-*.jsonl 被清理，当天文件保留。
 *
 * 同时校验 js_api 公开自省面仍为 51 方法（契约零漂移）。
 * 不启动外部浏览器：open_url 接线用源码断言 + 直接 span 写入验证。
 *
 * 用法：node server/test/trace-equivalence.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(serverRoot, '..')
const isoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-trace-eq-'))
process.env.HARBOR_CONFIG_DIR = isoDir
process.on('exit', () => {
  try { fs.rmSync(isoDir, { recursive: true, force: true }) } catch { /* 容忍 */ }
})

const pb = await import('../src/services/pybridge.js')
const registry = await import('../src/registry.js')
const parse = value => (typeof value === 'string' ? JSON.parse(value) : value)
const tracesDir = path.join(isoDir, 'traces')
const checks = []

// 1. 保留期常量与清理（DEF-03）
assert.equal(pb.TRACE_RETENTION_DAYS, 14, 'RETENTION_DAYS 应为 14')
fs.mkdirSync(tracesDir, { recursive: true })
const oldFile = path.join(tracesDir, 'gen_ai-20000101.jsonl')
fs.writeFileSync(oldFile, '{"old":true}\n', 'utf8')
const oldTime = Date.now() - 20 * 86400 * 1000
fs.utimesSync(oldFile, new Date(oldTime), new Date(oldTime))

// 2. 写入 span（DEF-02）
const traceId = pb.newTraceId()
assert.ok(traceId && traceId.length > 10, 'trace id 应可生成')
pb.traceSpan(traceId, 'agent.run', 'run', { attrs: { sid: 's1' } })
pb.traceSpan(traceId, 'tool.open_url', 'open_url',
  { status: 'ok', durationMs: 12.34 })
assert.ok(!fs.existsSync(oldFile), '20 天前的轨迹文件应被清理')
const todayFiles = fs.readdirSync(tracesDir).filter(n => n.startsWith('gen_ai-'))
assert.ok(todayFiles.length >= 1, '当天轨迹文件应保留')
checks.push('RETENTION_DAYS=14；span 写入后清理 20 天旧文件、保留当天文件')

// 3. trace_recent 读回并校验 gen_ai.* 字段
const recent = parse(await pb.traceRecent(50))
assert.ok(Array.isArray(recent.events), 'trace_recent 应返回 events')
const spans = recent.events.map(e => e['gen_ai.span'])
assert.ok(spans.includes('agent.run'), '缺 agent.run span')
assert.ok(spans.includes('tool.open_url'), '缺 tool.open_url span')
const run = recent.events.find(e => e['gen_ai.span'] === 'agent.run')
assert.equal(run['gen_ai.operation.name'], 'run')
assert.equal(run['gen_ai.request.trace_id'], traceId)
assert.equal(run.status, 'ok')
assert.equal(run.sid, 's1')
const tool = recent.events.find(e => e['gen_ai.span'] === 'tool.open_url')
assert.equal(tool['gen_ai.duration_ms'], 12.3)
checks.push('trace_recent 读回 agent.run / tool.open_url，字段与 gen_ai.* 一致')

// 4. 运行时接线：invoke('begin_task') 应落 agent.run
const before = parse(await pb.traceRecent(500)).events.length
assert.equal(await registry.invoke('begin_task'), 'ok')
const after = parse(await pb.traceRecent(500)).events
assert.ok(after.length > before, 'begin_task 应追加 span')
assert.ok(after.slice(0, after.length - before)
  .some(e => e['gen_ai.span'] === 'agent.run'), 'begin_task 应落 agent.run')
checks.push("invoke('begin_task') 运行时落 agent.run span")

// 5. 护栏接线源码断言（不启动外部浏览器）
const systemSrc = fs.readFileSync(path.join(serverRoot, 'src/services/system.js'), 'utf8')
assert.match(systemSrc, /emitGuardSpan\('open_url'/)
assert.match(systemSrc, /tool\.\$\{op\}/)
const commandsSrc = fs.readFileSync(path.join(serverRoot, 'src/services/commands.js'), 'utf8')
assert.match(commandsSrc, /'agent\.run'/)
const providerSrc = fs.readFileSync(path.join(serverRoot, 'src/services/provider.js'), 'utf8')
assert.match(providerSrc, /newTraceId\(\)/)
checks.push('system.js / commands.js / provider.js 接线在源码中可核验')

// 6. 契约零漂移：公开自省面仍为 51 方法
const info = parse(await registry.invoke('get_api_info'))
assert.equal(info.version, 'v1.0.0')
assert.equal(info.methods.length, 51)
checks.push('get_api_info 公开面 51 方法、版本 v1.0.0 零漂移')

console.log(JSON.stringify({
  ok: true,
  checks: checks.length,
  results: checks,
  defectsFixed: ['DEF-02', 'DEF-03'],
}, null, 2))
