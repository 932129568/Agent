/**
 * CORS 预检回归（R98 · P0「所有工具执行恒 Failed to fetch」）。
 *
 * 运行：node server/test/cors-preflight.mjs
 *
 * 存在的唯一理由：现有 Node 单测全部用 `app.inject()` 直接打**处理器**，
 * 浏览器预检（OPTIONS + Access-Control-Request-Headers 协商）根本不经过它们，
 * 于是「预检不放行的自定义头」可以一路带到发版：
 *   前端 frontend/src/core/bridge.js 自 P0-3 起发 x-harbor-sid / x-harbor-agent-loop
 *   （V4-H C3 再加 x-harbor-confirmed），而 server/src/app.js 的白名单只写了
 *   content-type ⇒ 页面源 harbor://app → 127.0.0.1 属跨源 + 非简单头 ⇒ 预检失败 ⇒
 *   请求**发都没发出去**，executeTool 全链路（主对话 run-controller + 群成员 group.js）
 *   一律拿到 TypeError: Failed to fetch。群聊还会被熔断放大成「成员只输出纯文本」。
 *
 * 判据设计（刻意避开假绿）：
 *   1. CORS_ORIGIN 必须在 import 之前设置 —— config.js 在 import 期解析 env，
 *      顺序错了钩子不会注册，测试会「因为没放行所以没头」而假绿；故先断言正样本真的 204。
 *   2. 允许头用 split(',').map(trim) 后**逐项**判断，不做整串 includes ——
 *      整串比较在顺序/空格变化时会假红（也会在「多写了但没生效」时假绿）。
 *   3. 必须带负控：非法源不得拿到 Access-Control-Allow-Origin（证明是按源放行，不是无条件）。
 *   4. 必须带精简正样本：只请求 content-type（UI 直调路径，不带 sid）也必须 204，
 *      证明放宽自定义头没有把无 sid 的普通调用搞坏。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* 环境隔离：临时 CONFIG_DIR / DATABASE_URL，绝不碰真实配置与项目内数据库 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-cors-'))
process.env.HARBOR_CONFIG_DIR = path.join(tmp, 'config')
process.env.DATABASE_URL = `file:${path.join(tmp, 'cors.db')}`
process.env.LOG_LEVEL = 'silent'
/* 与 electron/main.js 写入的可执行版取值一致（见 electron/main.js:251-252） */
process.env.CORS_ORIGIN = 'null,harbor://app'

// 动态 import：确保上面的 env 在 config.js 解析前生效（钩子在注册期读 config）
const { buildServer } = await import('../src/app.js')

/** bridge.js callApiHttp 实际会发送的全部自定义头 + 基础头 */
const AGENT_HEADERS = ['content-type', 'x-harbor-sid', 'x-harbor-agent-loop', 'x-harbor-confirmed']

const app = await buildServer()

const results = []
function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, msg: error.message })
  }
}

/** 发一次预检（不占端口、不发真实网络） */
const preflight = (headers) => app.inject({ method: 'OPTIONS', url: '/jsapi/list_dir', headers })
/** 响应头取值一律小写归一（fastify 给的是小写键，这里防御性再兜一次） */
const header = (res, name) => res.headers[String(name).toLowerCase()]
/** 把 allow-headers 拆成集合，供逐项判断 */
const allowSet = (res) => new Set(String(header(res, 'access-control-allow-headers') || '')
  .split(',').map(item => item.trim().toLowerCase()).filter(Boolean))

/* ── 1. 正样本：Agent 工具链路的完整预检（本次事故的原始形态） ── */
const agentPre = await preflight({
  origin: 'harbor://app',
  'access-control-request-method': 'POST',
  'access-control-request-headers': AGENT_HEADERS.join(','),
})

check('P1 预检返回 204（钩子已注册且在 OPTIONS 上收口）', () => {
  assert.equal(agentPre.statusCode, 204, `statusCode=${agentPre.statusCode}`)
})

check('P2 按源回显 Access-Control-Allow-Origin=harbor://app', () => {
  assert.equal(header(agentPre, 'access-control-allow-origin'), 'harbor://app',
    `allow-origin=${header(agentPre, 'access-control-allow-origin')}`)
})

check('P3 允许头逐项包含 bridge.js 发的那四个头（缺一个即工具链路全断）', () => {
  const got = allowSet(agentPre)
  const missing = AGENT_HEADERS.filter(name => !got.has(name))
  assert.deepEqual(missing, [], `Allow-Headers 缺 ${missing.join(', ')}（实际=${[...got].join(',') || '(空)'}）`)
})

check('P4 允许头不含通配符 *（本仓 CORS 约定：绝不输出 *）', () => {
  assert.ok(!allowSet(agentPre).has('*'), 'Allow-Headers 出现 * —— 等于放开任意自定义头')
})

/* ── 2. 负控：非法源一个头都不许拿到 ── */
const evilPre = await preflight({
  origin: 'https://evil.example',
  'access-control-request-method': 'POST',
  'access-control-request-headers': AGENT_HEADERS.join(','),
})

check('N1 非法源（https://evil.example）拿不到 Access-Control-Allow-Origin', () => {
  assert.equal(header(evilPre, 'access-control-allow-origin'), undefined,
    `allow-origin=${header(evilPre, 'access-control-allow-origin')}（应完全缺失）`)
})

check('N2 非法源也拿不到 Access-Control-Allow-Headers', () => {
  assert.equal(header(evilPre, 'access-control-allow-headers'), undefined,
    `allow-headers=${header(evilPre, 'access-control-allow-headers')}（应完全缺失）`)
})

/* ── 3. 正样本：UI 直调（无 sid，只有 content-type）不得被误伤 ── */
const uiPre = await preflight({
  origin: 'harbor://app',
  'access-control-request-method': 'POST',
  'access-control-request-headers': 'content-type',
})

check('P5 UI 直调路径（只请求 content-type）仍 204 且放行 content-type', () => {
  assert.equal(uiPre.statusCode, 204, `statusCode=${uiPre.statusCode}`)
  assert.equal(header(uiPre, 'access-control-allow-origin'), 'harbor://app',
    `allow-origin=${header(uiPre, 'access-control-allow-origin')}`)
  assert.ok(allowSet(uiPre).has('content-type'), 'Allow-Headers 不含 content-type')
})

/* ── 4. 正样本：file:// 调试源（字符串 "null"）与 Vary ── */
const nullPre = await preflight({ origin: 'null', 'access-control-request-method': 'POST' })

check('P6 file:// 调试源 "null" 按配置放行，且响应带 Vary: Origin', () => {
  assert.equal(header(nullPre, 'access-control-allow-origin'), 'null',
    `allow-origin=${header(nullPre, 'access-control-allow-origin')}`)
  assert.match(String(header(nullPre, 'vary') || ''), /origin/i, `vary=${header(nullPre, 'vary')}`)
})

/* ── 5. 静态一致性：白名单必须覆盖 bridge.js 实际发送的头 ──
 * 运行期判据（P3）已经能抓住漏登记，这一条是「防回退」：将来有人只改源码字符串、
 * 却把桥接里又加了一个头，P3 会因为请求头清单是硬编码而漏掉，这里读真实源码对齐。 */
check('S1 源码级对齐：bridge.js 里 headers[..] 赋值的每个头都在 app.js 白名单中', async () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..')
  const bridge = fs.readFileSync(path.join(root, 'frontend', 'src', 'core', 'bridge.js'), 'utf8')
  const sent = [...bridge.matchAll(/headers\[\s*'([^']+)'\s*\]/g)].map(m => m[1].toLowerCase())
  assert.ok(sent.length >= 3, `bridge.js 里只找到 ${sent.length} 个自定义头，正则疑失效`)
  const allowed = new Set(String('content-type, x-harbor-sid, x-harbor-agent-loop, x-harbor-confirmed')
    .split(',').map(s => s.trim().toLowerCase()))
  const missing = [...new Set(sent)].filter(name => !allowed.has(name))
  assert.deepEqual(missing, [], `bridge.js 发送但白名单未登记：${missing.join(', ')}`)
})

/* ── 汇总 ── */
const failed = results.filter(r => !r.ok)
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '\n        → ' + r.msg}`)

await app.close().catch(() => {})
fs.rmSync(tmp, { recursive: true, force: true })

console.log(`\nCORS_PREFLIGHT: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${results.length - failed.length}/${results.length})`)
process.exit(failed.length === 0 ? 0 : 1)
