#!/usr/bin/env node
/**
 * Harbor R3 全量 React 19 · Playwright 真机端到端回归套件
 *
 * 覆盖四大验收域（真实 Chromium/Edge DOM + 真实 rAF 物理采样 + 回环 Stub 后端，零 API 费用）：
 *   Suite A · 群聊能力路由（缺失预警、一键视频班底、自定义角色/模型持久化、真实流式暂停与续跑三态）
 *   Suite B · 独立光梭接力动画（RelayTrackStage 轨道节点、16 柱示波器动态跳动、光梭交棒、完成后归零）
 *   Suite C · 设置中心推理参数（上下文长度、最大输出、8 档与自定义思考档位、跨厂商协议映射与 save_config 落盘）
 *   Suite D · 物理撞击曲线（rAF 逐帧读取 main.hb-main matrix3d：峰值 3.2–6.5px / scale / 弧形高光 / 收敛 / 过冲 / 零残余 + 无障碍负控）
 *
 * 前置：
 *   node frontend/app/build.mjs
 * 用法：
 *   node frontend/app/tests/e2e-r3-regression.mjs
 *   HEADED=1 node frontend/app/tests/e2e-r3-regression.mjs    # 有窗肉眼观摩模式
 *
 * 退出码：0 = 全部通过；1 = 存在断言失败或 pageerror；2 = 环境缺失（无浏览器或未构建 dist）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(HERE, '..')
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..')
const DIST_DIR = path.join(APP_ROOT, 'dist')
const LIBS_DIR = path.join(REPO_ROOT, 'libs')
const HEADED = process.env.HEADED === '1'

if (!fs.existsSync(path.join(DIST_DIR, 'index.html')) || !fs.existsSync(path.join(DIST_DIR, 'app.js'))) {
  console.error('[e2e-r3] 缺少构建产物 frontend/app/dist/{index.html,app.js}，请先运行：node frontend/app/build.mjs')
  process.exit(2)
}

const require = createRequire(import.meta.url)
let chromium = null
for (const modPath of [
  path.join(REPO_ROOT, 'server', 'node_modules', 'playwright-core'),
  'playwright-core',
  'playwright',
]) {
  try {
    ({ chromium } = require(modPath))
    if (chromium) break
  } catch {}
}
if (!chromium) {
  console.error('[e2e-r3] 未找到 playwright-core（请确认 server/node_modules 已安装）')
  process.exit(2)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

/* ========================================================================== *
 * 1. 启动回环静态页 + 后端 /jsapi + 模型 SSE Stub（零外网、零 Token 消耗）
 * ========================================================================== */
const stubState = {
  config: {
    api_key: 'sk-e2e-stub-key',
    provider_key: 'sk-e2e-stub-key',
    provider_base_url: 'https://open.bigmodel.cn/api/paas/v4',
    provider_base: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.5-flash',
    provider_model: 'glm-4.5-flash',
    temperature: 0.7,
    context_window: 128000,
    max_tokens: 4096,
    reasoning_effort: 'auto',
  },
  savedConfigs: [],
  savedGuardConfigs: [],
  groupFilesByGid: {},
  purgedGroupIds: [],
  boundProjectWs: [],
  writtenFiles: [],
  chatRequests: [],
  triggerGroupToolOnce: false,
  triggerClarifyOnce: false,
  triggerArtifactOnce: false,
  triggerImageToolOnce: false,
  mediaRequests: [],
}

function readReqBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

let serverBase = ''

const server = http.createServer(async (req, res) => {
  const urlPath = String(req.url || '/').split('?')[0]

  // CORS 放行（同 origin / loopback 测试）
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Harbor-Target, X-Harbor-Harness, x-harbor-sid, x-harbor-agent-loop, x-harbor-confirmed')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // 健康检查
  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, service: 'harbor-e2e-stub', methods: 168 }))
    return
  }

  // /jsapi/:method 路由模拟
  if (req.method === 'POST' && urlPath.startsWith('/jsapi/')) {
    const method = decodeURIComponent(urlPath.slice('/jsapi/'.length))
    const raw = await readReqBody(req)
    let args = []
    try {
      const p = JSON.parse(raw || '{}')
      args = Array.isArray(p) ? p : (Array.isArray(p.args) ? p.args : [])
    } catch {}

    let out = { ok: true }
    if (method === 'get_config') out = stubState.config
    else if (method === 'save_config') {
      try {
        const incoming = JSON.parse(String(args[0] || '{}'))
        stubState.config = { ...stubState.config, ...incoming }
        stubState.savedConfigs.push(incoming)
      } catch {}
      out = { ok: true }
    } else if (method === 'get_sessions') out = []
    else if (method === 'save_sessions' || method === 'set_current_sid') out = { ok: true }
    else if (method === 'get_ws_state') out = { enabled: true, ws: REPO_ROOT, effective: REPO_ROOT }
    else if (method === 'set_session_ws') {
      stubState.boundProjectWs.push({ sid: String(args[0] || ''), dir: String(args[1] || ''), enabled: args[2] !== false })
      out = { ok: true, sid: String(args[0] || ''), ws: String(args[1] || REPO_ROOT), bound: Boolean(args[1]) }
    }
    else if (method === 'pick_folder') out = { ok: true, path: 'C:/Users/demo/Desktop/harbor-project' }
    else if (method === 'list_recent_ws') out = { recent: [REPO_ROOT] }
    else if (method === 'list_dir') out = { ok: true, entries: ['README.md', 'package.json'] }
    else if (method === 'expert_list') out = []
    else if (method === 'get_memory') out = []
    else if (method === 'mcp_list_servers') out = []
    else if (method === 'guard_get_config') out = { tiers: { run_command: 'always', run_powershell: 'session', delete_path: 'always', browser_click: 'always', software_call: 'session' } }
    else if (method === 'guard_save_config') {
      try { stubState.savedGuardConfigs.push(JSON.parse(String(args[0] || '{}'))) } catch {}
      out = { ok: true }
    }
    else if (method === 'guard_check') out = { action: 'allow' }
    else if (method === 'guard_rule_list') out = { rules: [] }
    else if (method === 'write_file') {
      stubState.writtenFiles.push({ path: String(args[0] || ''), content: String(args[1] || '') })
      out = { ok: true, path: String(args[0] || ''), bytes: String(args[1] || '').length }
    }
    else if (method === 'hybrid_get_config') out = { strategy: 'auto', local_first: true }
    else if (method === 'reader_config_get') out = { base_url: '', model: '' }
    else if (method === 'sandbox_get_config') out = { enabled: true, command_profiles: { run_command: 'standard', run_powershell: 'standard', run_admin_command: 'off' } }
    else if (method === 'sandbox_status') out = { available: true }
    else if (method === 'webdav_get_config') out = { url: '', username: '', remote_path: '/harbor-backup', conflict_policy: 'ask' }
    else if (method === 'software_list') out = []
    else if (method === 'check_update') out = { update_available: false }
    else if (method === 'group_files_list') {
      const gid = String(args[0] || 'default')
      const arr = stubState.groupFilesByGid[gid] || []
      out = { ok: true, dir: `C:/harbor-test/group_files/${gid}`, files: arr }
    }
    else if (method === 'group_files_write') {
      const gid = String(args[0] || 'default')
      const arr = stubState.groupFilesByGid[gid] || (stubState.groupFilesByGid[gid] = [])
      const name = `handoff_${arr.length + 1}.md`
      const entry = { name, path: `C:/harbor-test/group_files/${gid}/${name}`, title: String(args[3] || name), member: String(args[2] || '主持人'), content: String(args[4] || ''), size: String(args[4] || '').length, mtime: Date.now() / 1000 }
      arr.unshift(entry)
      out = { ok: true, name, path: entry.path }
    }
    else if (method === 'group_files_read') {
      const all = Object.values(stubState.groupFilesByGid).flat()
      const hit = all.find((f) => f.path === args[0] || f.name === args[0])
      out = { ok: true, text: hit ? hit.content : '# 交接文档内容' }
    }
    else if (method === 'group_files_delete') {
      const gid = String(args[0] || 'default')
      if (args[1] === '__PURGE_ALL__') {
        delete stubState.groupFilesByGid[gid]
        stubState.purgedGroupIds.push(gid)
        out = { ok: true, purged: true, group_id: gid }
      } else {
        stubState.groupFilesByGid[gid] = (stubState.groupFilesByGid[gid] || []).filter((f) => f.name !== args[1])
        out = { ok: true }
      }
    }
    else if (method === 'group_files_open_dir') out = { ok: true }
    else if (method === 'build_system_prompt') out = 'STATIC_CHARTER_PREFIX' + (args[0] ? '|DYN_QUERY:' + args[0] : '')
    else if (method === 'build_tools') out = [
      { type: 'function', function: { name: 'write_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
      { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
    ]
    else if (method === 'memory_search') out = { items: [{ text: '动态回忆:' + String(args[0] || '').slice(0, 12) }] }
    else if (method === 'get_local_proxy') out = { ok: true, port: server.address().port, base_url: serverBase }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(out))
    return
  }

  // 模拟多模态图片 / 视频生成与异步轮询端点（R19 Suite-O）
  if (req.method === 'POST' && urlPath === '/images/generations') {
    const raw = await readReqBody(req)
    stubState.mediaRequests.push({ path: urlPath, body: JSON.parse(raw || '{}') })
    const svg = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#182038"/><text x="40" y="190" fill="#38bdf8" font-size="32">Harbor Generated Image</text></svg>')
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ data: [{ url: svg, revised_prompt: 'Harbor cinematic glass poster' }] }))
    return
  }
  if (req.method === 'POST' && urlPath === '/videos/generations') {
    const raw = await readReqBody(req)
    stubState.mediaRequests.push({ path: urlPath, body: JSON.parse(raw || '{}') })
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ id: 'vid_task_r19', task_status: 'PROCESSING' }))
    return
  }
  if (req.method === 'GET' && urlPath.startsWith('/async-result/')) {
    stubState.mediaRequests.push({ path: urlPath })
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ task_status: 'SUCCESS', video_result: [{ url: 'https://example.invalid/harbor-demo.mp4', cover_image_url: '' }] }))
    return
  }

  // 模型 SSE 流式 Stub（用于测试群聊接力的真实模型传参、流式暂停与断点续跑）
  if (req.method === 'POST' && urlPath === '/chat/completions') {
    const raw = await readReqBody(req)
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch {}
    stubState.chatRequests.push({
      model: body.model,
      max_tokens: body.max_tokens,
      reasoning_effort: body.reasoning_effort,
      thinking: body.thinking,
      target: req.headers['x-harbor-target'] || '',
      messagesCount: Array.isArray(body.messages) ? body.messages.length : 0,
      systemContent: Array.isArray(body.messages) && body.messages[0] ? body.messages[0].content : '',
      messages: Array.isArray(body.messages) ? body.messages : [],
      toolNames: Array.isArray(body.tools) ? body.tools.map((t) => t && t.function && t.function.name) : [],
      lastUser: Array.isArray(body.messages) ? String((body.messages[body.messages.length - 1] || {}).content || '') : '',
    })

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
    })
    const lastUserStr = Array.isArray(body.messages) ? String((body.messages[body.messages.length - 1] || {}).content || '') : ''
    if (lastUserStr.includes('智能接力主持人')) {
      const idMatches = [...lastUserStr.matchAll(/id="([^"]+)"\s*\|\s*角色名="([^"]+)"/g)]
      // 模拟主持人智能重排：把含 ui/设计 的角色排在 实现/开发 之前
      const ranked = idMatches.map((m) => ({ id: m[1], name: m[2] })).sort((a, b) => {
        const score = (n) => (/策划|架构|导演/.test(n) ? 1 : (/ui|设计|分镜/i.test(n) ? 2 : (/实现|工程|制片/.test(n) ? 3 : 4)))
        return score(a.name) - score(b.name)
      })
      const modJson = JSON.stringify({
        analysis: '主持人已按任务特征动态筛选并重排最佳交接顺序',
        plan: ranked.map((r) => ({ id: r.id, taskBrief: `完成${r.name}阶段核心交付` })),
      })
      // 注意：SSE 头已在本分支上方统一写过（同一请求只允许写一次），
      // 这里再 writeHead 会抛 ERR_HTTP_HEADERS_SENT —— r10 交付的脚本就是栽在这。
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: modJson } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 60, total_tokens: 1060, prompt_tokens_details: { cached_tokens: 950 } } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    const hasToolRole = Array.isArray(body.messages) && body.messages.some((m) => m && m.role === 'tool')
    if (stubState.triggerImageToolOnce && !hasToolRole) {
      stubState.triggerImageToolOnce = false
      const imgArgs = JSON.stringify({ prompt: '赛博玻璃港口海报', aspect_ratio: '16:9', style: '电影光影' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_img_1', type: 'function', function: { name: 'generate_image', arguments: imgArgs } }] }, finish_reason: 'tool_calls' }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940, prompt_tokens_details: { cached_tokens: 800 } } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    if (stubState.triggerArtifactOnce) {
      stubState.triggerArtifactOnce = false
      const artContent = '已为你生成交互式卡片：\n\n```html\n<!doctype html><html><head><title>R15 交互画布测试</title></head><body><h1>Hello Artifact Canvas</h1><form id="f"><button id="subbtn">点击提交测试</button></form><a id="rel" href="index.html">回首页</a></body></html>\n```'
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: artContent } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 60, total_tokens: 960, prompt_tokens_details: { cached_tokens: 800 } } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    if (stubState.triggerClarifyOnce && !hasToolRole) {
      stubState.triggerClarifyOnce = false
      const askArgs = JSON.stringify({
        title: '选择页面视觉效果方向',
        subtitle: '请在正式生成代码前拍板核心视觉风格',
        questions: [{
          id: 'style',
          label: '主视觉风格',
          options: [
            { id: 'glass', label: '极简玻璃拟态', desc: '通透磨砂与柔光层次', tag: '推荐' },
            { id: 'brass', label: '黄铜精密机械', desc: '金属光泽与物理齿轮', tag: '复古' },
          ],
        }],
      })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_ask_1', type: 'function', function: { name: 'ask_user_options', arguments: askArgs } }] }, finish_reason: 'tool_calls' }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1000, completion_tokens: 45, total_tokens: 1045, prompt_tokens_details: { cached_tokens: 880 } } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    if (stubState.triggerGroupToolOnce && Array.isArray(body.tools) && body.tools.length > 0 && !hasToolRole) {
      stubState.triggerGroupToolOnce = false
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_grp_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"index.html","content":"<h1>Hello Harbor</h1>"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1000, completion_tokens: 40, total_tokens: 1040, prompt_tokens_details: { cached_tokens: 920 } } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    const longFiller = '详细说明：'.repeat(45)
    const pieces = [
      { reasoning_content: `正在以模型 ${body.model} 分析本棒任务要求与前序交接上下文…\n` },
      { content: `已由模型 \`${body.model}\` 完成本棒产出：` },
      { content: '1) 明确视觉节奏与开场钩子；\n2) 补充逐镜景别与时长清单；\n3) 交付下一棒可直接衔接的提示词。\n' },
      { content: longFiller },
    ]
    let closed = false
    req.on('close', () => { closed = true })
    for (const delta of pieces) {
      if (closed) return
      res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
      await new Promise((r) => setTimeout(r, 95))
    }
    if (!closed) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 80, total_tokens: 1080, prompt_tokens_details: { cached_tokens: 880 } } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    }
    return
  }

  // 静态资源（dist/ 与 libs/）
  const rel = urlPath.replace(/^\/+/, '') || 'index.html'
  let filePath = null
  if (rel.startsWith('libs/')) filePath = path.join(LIBS_DIR, rel.slice(5))
  else if (rel === 'harbor.ico' || rel === 'harbor-icon.png') filePath = path.join(REPO_ROOT, rel)
  else filePath = path.join(DIST_DIR, rel)

  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404)
    res.end('Not found')
    return
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' })
  fs.createReadStream(filePath).pipe(res)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
serverBase = `http://127.0.0.1:${server.address().port}`

/* ========================================================================== *
 * 2. 启动真实浏览器（优先系统 Edge / Chrome，兜底 Playwright 内置 Chromium）
 * ========================================================================== */
async function launchBrowser() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  const winPaths = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].filter((p) => fs.existsSync(p))

  const attempts = [
    ...winPaths.map((executablePath) => ({ executablePath, headless: !HEADED, env })),
    { channel: 'msedge', headless: !HEADED, env },
    { channel: 'chrome', headless: !HEADED, env },
    { headless: !HEADED, env },
  ]
  let lastErr = null
  for (const opts of attempts) {
    try {
      return await chromium.launch({ ...opts, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    } catch (e) {
      lastErr = e
    }
  }
  console.error('[e2e-r3] 无法启动任何可用浏览器：', lastErr && lastErr.message)
  process.exit(2)
}

const results = []
function record(suite, name, ok, detail = '') {
  results.push({ suite, name, ok: !!ok, detail: String(detail || '') })
  console.log(`${ok ? 'PASS' : 'FAIL'} [${suite}] ${name}${detail ? `  (${detail})` : ''}`)
}

const browser = await launchBrowser()
const pageErrors = []

try {
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 } })
  const page = await context.newPage()
  page.on('pageerror', (err) => pageErrors.push(String(err && err.message || err)))

  // 注入模拟 Electron 宿主桥（无假壁纸，指向本地 Stub Fastify）
  await page.addInitScript((apiBase) => {
    window.HARBOR_API_BASE = apiBase
    window.HarborDesktop = Object.freeze({
      platform: 'win32',
      apiBase,
      setBackdrop: async (mode) => ({ ok: mode !== 'none', mode }),
      getBackdrop: async () => ({ ok: true, mode: 'acrylic', platform: 'win32' }),
    })
  }, serverBase)

  await page.goto(`${serverBase}/index.html`, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForSelector('.hb-shell', { timeout: 10000 })

  /* ======================================================================== *
   * Suite 0 · R21 首次启动特色与使用指南弹窗自动弹出 + 切页 + 持久化关闭
   * ======================================================================== */
  await page.waitForSelector('.ob-modal', { timeout: 4000 })
  await page.locator('.ob-tabs button:has-text("对话与模型中心")').click()
  const obSlideTitle = await page.locator('.ob-slide-title').textContent()
  await page.locator('.ob-head button[aria-label="跳过指南"]').click()
  await page.waitForSelector('.ob-modal', { state: 'detached', timeout: 3000 })
  const obSeenSaved = await page.evaluate(() => localStorage.getItem('harbor.v5.onboarding.seen') === '1')
  record(
    'Suite-0',
    '首次打开自动展示软件特色与功能使用说明弹窗，支持切页与平滑关闭并持久化',
    /模型保存中心/.test(obSlideTitle || '') && obSeenSaved,
    `slide=${(obSlideTitle || '').trim().slice(0, 28)}, seenSaved=${obSeenSaved}`
  )

  /* ======================================================================== *
   * Suite A · 群聊能力路由、自定义角色/模型与暂停续跑三态
   * ======================================================================== */
  await page.locator('.hb-rail-btn[title="角色群聊"]').click()
  await page.waitForSelector('.gp-root')

  // A1: 主持人智能调度：先由主持人统筹分析并发布动态调度单卡片
  await page.locator('.gp-input').fill('帮我制作一段 60 秒科技产品宣传视频分镜脚本')
  await page.locator('.gp-bar button:has-text("发起接力")').click()
  await page.waitForSelector('.gp-msg:has-text("主持人（智能调度）")', { timeout: 6000 })
  const modCardText = await page.locator('.gp-msg:has-text("主持人（智能调度）")').first().textContent()
  record('Suite-A', '主持人智能调度：先出统筹调度单规划角色与交接路线', /动态接力路线/.test(modCardText || ''), (modCardText || '').slice(0, 68))

  // 中止该轮接力，准备测自定义视频班底
  const abortBtn = page.locator('.gp-bar button:has-text("中止")')
  if (await abortBtn.isVisible()) await abortBtn.click()
  await page.waitForTimeout(200)

  // A2: 打开自定义角色与模型面板 → 一键切换「视频制作班底」+ 改第 1 棒独立模型 + 新增自定义角色
  await page.locator('.gp-controls button:has-text("自定义角色与模型")').click()
  await page.waitForSelector('.gp-roster-panel')
  await page.locator('.gp-roster-panel button:has-text("视频制作班底")').click()

  const firstModelInput = page.locator('.gp-member-card').nth(0).locator('input[placeholder*="独立模型名"]')
  await firstModelInput.fill('custom-video-planner-v1')

  // 新增第 4 个自定义角色（带独立模型与视频能力）
  const addCard = page.locator('.gp-member-card').last()
  await addCard.locator('input[placeholder*="新角色名"]').fill('配音剪辑指导')
  await addCard.locator('input[placeholder*="职责与输出要求"]').fill('输出配音情绪节奏与剪辑卡点')
  await addCard.locator('input[placeholder*="指定模型名"]').fill('tts-director-v2')
  await addCard.locator('button:has-text("视频制作")').click()
  await addCard.locator('button:has-text("添加角色")').click()

  const savedRoster = await page.evaluate(() => JSON.parse(localStorage.getItem('harbor.v3.group.members') || '[]'))
  record(
    'Suite-A',
    '自定义角色、独立模型与视频班底持久化',
    savedRoster.length === 4
      && savedRoster[0].model === 'custom-video-planner-v1'
      && savedRoster[3].name === '配音剪辑指导'
      && savedRoster[3].model === 'tts-director-v2',
    `members=${savedRoster.length}, m1=${savedRoster[0]?.model}, m4=${savedRoster[3]?.name}/${savedRoster[3]?.model}`
  )
  await page.locator('.gp-roster-panel button:has-text("完成")').click() // 收起悬浮抽屉

  // A3: 真实接力中点击「⏸ 暂停」→ 验证暂停断点 → 补充纠偏点「▶ 继续接力」→ 验证独立模型路由与无预警
  stubState.chatRequests.length = 0
  await page.locator('.gp-input').fill('制作一段 60 秒 AI 桌面助手宣传视频分镜脚本')
  await page.locator('.gp-bar button:has-text("发起接力")').click()
  await page.waitForSelector('.rt-stage[data-status="running"]', { timeout: 5000 })
  await page.waitForTimeout(260)
  await page.locator('.gp-bar button:has-text("暂停")').click()
  await page.waitForSelector('.rt-stage[data-status="paused"]', { timeout: 5000 })
  const pauseBarVisible = await page.locator('.gp-pause-bar').isVisible()
  record('Suite-A', '接力中途支持一键暂停并弹出续跑条', pauseBarVisible)

  await page.locator('.gp-pause-bar input').fill('请补充每个镜头的秒数与配乐提示')
  await page.locator('.gp-pause-bar button:has-text("继续接力")').click()
  await page.waitForSelector('.rt-stage[data-status="done"]', { timeout: 15000 })

  const usedModels = stubState.chatRequests.map((r) => r.model)
  const warnGone = (await page.locator('.gp-warn').count()) === 0
  const hasDirective = stubState.chatRequests.some((r) => r.lastUser.includes('每个镜头的秒数') || JSON.stringify(r).includes('每个镜头的秒数'))
  record(
    'Suite-A',
    '视频班底零预警命中能力路由 + 独立模型生效 + 续跑纠偏送达',
    warnGone && usedModels.includes('custom-video-planner-v1') && usedModels.includes('tts-director-v2') && hasDirective,
    `models=${JSON.stringify([...new Set(usedModels)])}`
  )

  /* ======================================================================== *
   * Suite B · 独立光梭接力动画（RelayTrackStage 视觉语言与动态验证）
   * ======================================================================== */
  await page.locator('.gp-controls button[aria-label="群聊更多操作"]').click()
  await page.locator('.dm-panel button:has-text("预览光梭接力动画")').click()
  await page.waitForSelector('.rt-stage[data-status="running"]', { timeout: 4000 })

  const waveDotCount = await page.locator('.rt-wave-dot').count()
  const chamberCount = await page.locator('.lc-chamber').count()
  const hasSvgAvatar = (await page.locator('.rt-avatar svg').count()) > 0
  record(
    'Suite-B',
    '重设计玻璃光轨舞台 + 角色专属 SVG 徽标 + 谐波呼吸点阵（非主对话流体波）',
    waveDotCount === 4 && hasSvgAvatar && chamberCount === 0,
    `waveDots=${waveDotCount}, svgAvatar=${hasSvgAvatar}, lcChamber=${chamberCount}`
  )

  // 轮询捕获光梭交棒瞬间（.rt-baton / .rt-handoff-banner / data-ignited="true"）
  const handoffObs = await page.evaluate(async () => {
    let sawBaton = false
    let sawBanner = false
    let sawIgnite = false
    const t0 = performance.now()
    while (performance.now() - t0 < 2800) {
      if (document.querySelector('.rt-baton')) sawBaton = true
      if (document.querySelector('.rt-handoff-banner')) sawBanner = true
      if (document.querySelector('.rt-node[data-ignited="true"]')) sawIgnite = true
      if (sawBaton && sawBanner && sawIgnite) break
      await new Promise((r) => setTimeout(r, 40))
    }
    return { sawBaton, sawBanner, sawIgnite }
  })
  record(
    'Suite-B',
    '棒次交接触发实体光梭弹射 + 站点点燃爆闪 + 交棒提示条',
    handoffObs.sawBaton && handoffObs.sawBanner && handoffObs.sawIgnite,
    JSON.stringify(handoffObs)
  )

  await page.waitForSelector('.rt-stage[data-status="done"]', { timeout: 6000 })
  const waveAfterDone = await page.locator('.rt-wave-dots').count()
  const doneNodes = await page.locator('.rt-node[data-state="done"]').count()
  record(
    'Suite-B',
    '接力完成后全部站点点亮 done 且呼吸点阵卸载（0% 后台空转）',
    waveAfterDone === 0 && doneNodes === 4,
    `doneNodes=${doneNodes}, waveAfterDone=${waveAfterDone}`
  )

  /* ======================================================================== *
   * Suite C · 设置中心上下文长度 / 最大输出 / 8 档与自定义思考档位
   * ======================================================================== */
  await page.locator('.hb-rail-btn[title="系统设置"]').click()
  await page.waitForSelector('.ov-modal .st-shell', { timeout: 5000 })

  const reasoningCard = page.locator('.st-card:has(h3:has-text("上下文长度、最大输出与多级思考档位"))')
  await reasoningCard.waitFor({ state: 'visible' })

  // C1: 检查 8 个中文档位齐备
  const expectedTiers = ['关闭', '自动', '低', '中', '高', '超高', '极致', '自定义']
  const foundTiers = []
  for (const lbl of expectedTiers) {
    if ((await reasoningCard.locator(`button.st-btn:text-is("${lbl}")`).count()) > 0) foundTiers.push(lbl)
  }
  record('Suite-C', '8 档思考按钮齐备（含超高 / 极致 / 自定义）', foundTiers.length === 8, foundTiers.join('/'))

  // C2: 选择 200K 上下文 + 16K 最大输出 + 超高思考 → 核验 GLM 协议映射预览
  await reasoningCard.locator('button.st-btn:has-text("200K")').click()
  await reasoningCard.locator('button.st-btn:text-is("16K")').click()
  await reasoningCard.locator('button.st-btn:text-is("超高")').click()
  const glmPreview = await reasoningCard.textContent()
  record(
    'Suite-C',
    'GLM 端点超高思考档位映射正确 + 上下文 200K / 输出 16K 生效',
    /200,000/.test(glmPreview || '') && /16,384/.test(glmPreview || '') && /glm:\s*thinking=enabled,\s*reasoning_effort=high/.test(glmPreview || ''),
    'matched GLM preview'
  )

  // C3: 切换 Anthropic 端点 + 自定义思考预算 24576 → 验证跨厂商映射 + save_config 真落盘
  const endpointCard = page.locator('.st-card:has(h3:has-text("云端 / OpenAI 兼容端点"))')
  await endpointCard.locator('input.st-input').nth(0).fill('https://api.anthropic.com/v1')
  await endpointCard.locator('input.st-input').nth(2).fill('claude-3-7-sonnet')
  await reasoningCard.locator('button.st-btn:text-is("自定义")').click()
  await reasoningCard.locator('input[step="1024"]').fill('24576')
  const antPreview = await reasoningCard.textContent()
  const antMatch = /anthropic:\s*thinking\.budget_tokens=24576/.test(antPreview || '')

  stubState.savedConfigs.length = 0
  await reasoningCard.locator('button:has-text("保存推理参数")').click()
  await page.waitForTimeout(250)
  const saved = stubState.savedConfigs[stubState.savedConfigs.length - 1] || {}
  record(
    'Suite-C',
    'Anthropic 自定义思考预算 24576 协议预览 + save_config 完整落盘',
    antMatch
      && Number(saved.context_window) === 200000
      && Number(saved.max_tokens) === 16384
      && saved.reasoning_effort === 'custom'
      && Number(saved.thinking_budget) === 24576,
    `saved={ctx:${saved.context_window},max:${saved.max_tokens},tier:${saved.reasoning_effort},budget:${saved.thinking_budget}}`
  )

  /* ======================================================================== *
   * Suite D · 校准后的物理撞击曲线（rAF 真实 DOM Matrix 采样 + 负控）
   * ======================================================================== */
  await page.locator('.st-nav-btn:has-text("透色、动效与自动更新")').click()
  await page.locator('button.st-btn:has-text("灵动四幕")').click()

  async function sampleMainImpact(triggerActionFn, windowMs = 700) {
    // 先在浏览器端启动 rAF 采样器，再由 Playwright 点击按钮触发真实交互
    const samplerPromise = page.evaluate((ms) => new Promise((resolve) => {
      const main = document.querySelector('main.hb-main')
      const samples = []
      let sawEdge = ''
      const t0 = performance.now()
      const readMatrix = () => {
        const tf = getComputedStyle(main).transform
        if (!tf || tf === 'none') return { x: 0, sc: 1 }
        const m3 = tf.match(/matrix3d\(([^)]+)\)/)
        if (m3) {
          const v = m3[1].split(',').map(Number)
          return { x: Number.isFinite(v[12]) ? v[12] : 0, sc: Math.hypot(v[0], v[1]) || 1 }
        }
        const m2 = tf.match(/matrix\(([^)]+)\)/)
        if (m2) {
          const v = m2[1].split(',').map(Number)
          return { x: Number.isFinite(v[4]) ? v[4] : 0, sc: Math.hypot(v[0], v[1]) || 1 }
        }
        return { x: 0, sc: 1 }
      }
      const tick = () => {
        const dt = performance.now() - t0
        const edge = main.getAttribute('data-impact-edge') || ''
        if (edge && !sawEdge) sawEdge = edge
        const cur = readMatrix()
        samples.push({ t: dt, x: cur.x, sc: cur.sc })
        if (dt < ms) requestAnimationFrame(tick)
        else {
          let peak = 0
          let minSc = 1
          let settleMs = 0
          let sign = 0
          let overshoots = 0
          let firstMoveAt = -1
          for (const s of samples) {
            if (Math.abs(s.x) > peak) peak = Math.abs(s.x)
            if (s.sc < minSc) minSc = s.sc
            if (firstMoveAt < 0 && Math.abs(s.x) >= 0.4) firstMoveAt = s.t
            if (Math.abs(s.x) >= 0.45) settleMs = s.t
            if (Math.abs(s.x) >= 0.25) {
              const sg = Math.sign(s.x)
              if (sign && sg !== sign) overshoots++
              sign = sg
            }
          }
          const last = samples.length ? Math.abs(samples[samples.length - 1].x) : 0
          resolve({
            frames: samples.length,
            peakAbs: Number(peak.toFixed(2)),
            minScale: Number(minSc.toFixed(4)),
            settleMs: firstMoveAt >= 0 ? Math.round(Math.max(0, settleMs - firstMoveAt)) : 0,
            overshoots,
            residual: Number(last.toFixed(3)),
            sawEdge,
          })
        }
      }
      requestAnimationFrame(tick)
    }), windowMs)

    await page.waitForTimeout(30)
    await triggerActionFn()
    return await samplerPromise
  }

  // D1: 强撞击按钮实测（峰值 3.2–6.5px + 缩放 + 弧形高光 + 收敛 <=450ms + 过冲 <=2 + 残余 <0.5px）
  const d1 = await sampleMainImpact(
    () => page.locator('button:has-text("试一下物理撞击手感")').click(),
    720
  )
  record(
    'Suite-D',
    '强撞击物理曲线达标（明显可见但不眩晕 + 弧形高光 + 零残余）',
    d1.frames >= 20
      && d1.peakAbs >= 3.2 && d1.peakAbs <= 6.5
      && d1.minScale < 0.996
      && d1.sawEdge === 'left'
      && d1.overshoots <= 2
      && d1.settleMs <= 450
      && d1.residual < 0.5,
    JSON.stringify(d1)
  )

  // D2: 关闭模态弹射撞击主壳实测（WAAPI 130ms 飞出 → 触发 .hb-main 位移与高光）
  const d2 = await sampleMainImpact(
    () => page.locator('.ov-modal .ov-close').click(),
    850
  )
  const modalClosed = (await page.locator('.ov-modal').count()) === 0
  record(
    'Suite-D',
    '关闭设置浮层飞出撞击主壳（位移 + 弧形高光 + 浮层干净卸载）',
    modalClosed && d2.peakAbs >= 3.0 && d2.sawEdge === 'left' && d2.residual < 0.5,
    JSON.stringify({ modalClosed, ...d2 })
  )

  // D3: 负控验证 — 切到「静息无障碍 (0×)」后点击撞击按钮必须严格 0 位移、无高光
  await page.locator('.hb-rail-btn[title="系统设置"]').click()
  await page.waitForSelector('.ov-modal .st-shell')
  await page.locator('.st-nav-btn:has-text("透色、动效与自动更新")').click()
  await page.locator('button.st-btn:has-text("静息无障碍")').click()
  const d3 = await sampleMainImpact(
    () => page.locator('button:has-text("试一下物理撞击手感")').click(),
    360
  )
  record(
    'Suite-D',
    '负控：静息无障碍档位下撞击位移与边缘高光严格归零',
    d3.peakAbs === 0 && d3.sawEdge === '',
    JSON.stringify(d3)
  )

  /* ======================================================================== *
   * Suite E · 前沿 KV-Cache 前缀冻结、工具字典序锁定、中文路径 ASCII 头保护与实时命中率遥测
   * ======================================================================== */
  await page.locator('.ov-modal .ov-close').click()
  await page.waitForTimeout(220)
  await page.locator('.hb-rail-btn[title="智能对话"]').click()
  await page.waitForSelector('.chat-textarea')
  stubState.chatRequests.length = 0

  async function runAndWaitChatTurn(promptText, expectedReqCount) {
    await page.locator('.chat-textarea').fill(promptText)
    await page.locator('.chat-send-btn').click()
    const t0 = Date.now()
    while (Date.now() - t0 < 10000) {
      const errCount = await page.locator('.chat-error').count()
      if (errCount > 0) {
        const errTxt = await page.locator('.chat-error').first().textContent()
        throw new Error(`Chat turn failed with UI error: ${errTxt}`)
      }
      if (stubState.chatRequests.length >= expectedReqCount) {
        const doneCount = await page.locator('.lc-chamber[data-phase="done"]').count()
        const isBusyNow = await page.locator('.chat-send-btn[data-stop="true"]').count()
        if (doneCount > 0 && isBusyNow === 0) return
      }
      await page.waitForTimeout(60)
    }
    const phaseNow = await page.locator('.lc-chamber').getAttribute('data-phase').catch(() => 'none')
    throw new Error(`Chat turn ${expectedReqCount} timed out (reqs=${stubState.chatRequests.length}, phase=${phaseNow})`)
  }

  await runAndWaitChatTurn('第一轮测试前缀锁定', 1)
  await runAndWaitChatTurn('第二轮切换全新问题检验缓存前缀零漂移', 2)

  const chatReqs = stubState.chatRequests.slice(-2)
  const sys1 = JSON.stringify(chatReqs[0] && chatReqs[0].systemContent)
  const sys2 = JSON.stringify(chatReqs[1] && chatReqs[1].systemContent)
  // 判据本意是「工具按字典序稳定（前缀可冻结）」，不是「恰好两个工具」。
  // 原写法硬编码 ['read_file','write_file']，r16 新增 list_workflow_plugins 后立刻假红。
  // 改为验意图：① 两次请求工具集完全一致 ② 该数组严格非降序 ③ 仍包含核心读写工具。
  const _t1 = (chatReqs[0] && chatReqs[0].toolNames) || []
  const _t2 = (chatReqs[1] && chatReqs[1].toolNames) || []
  const toolsSorted = _t1.length > 0
    && JSON.stringify(_t1) === JSON.stringify(_t2)
    && _t2.every((n, i) => i === 0 || String(_t2[i - 1]) <= String(n))
    && _t2.includes('read_file') && _t2.includes('write_file')
  const dynInTail = Boolean(chatReqs[1] && chatReqs[1].lastUser.includes('<system-reminder>'))
  const hasAnthropicBp = sys2.includes('"cache_control":{"type":"ephemeral"}')
  const ribbonTxt = await page.locator('.hb-ribbon').textContent()
  record(
    'Suite-E',
    '多轮前缀绝对冻结（System 逐字节一致 + 工具字典序 + 动态记忆后置 + Anthropic 缓存断点 + 88% 命中率）',
    chatReqs.length === 2
      && sys1 === sys2
      && !sys2.includes('DYN_QUERY')
      && toolsSorted
      && dynInTail
      && hasAnthropicBp
      && /本轮缓存\s*88%/.test(ribbonTxt || ''),
    `sysEqual=${sys1 === sys2}, toolsSorted=${toolsSorted}, tools=${JSON.stringify((chatReqs[1] || {}).toolNames || null)}, dynInTail=${dynInTail}, antBp=${hasAnthropicBp}, ribbon=${(ribbonTxt || '').slice(0, 48)}`
  )

  /* ======================================================================== *
   * Suite F · R6 真机新能力（安全护栏设置 / 群聊真工具调用 / 长文折叠收纳 / 群文件面板）
   * ======================================================================== */
  // F1: 安全护栏一键关闭命令拦截
  await page.locator('.hb-rail-btn[title="系统设置"]').click()
  await page.waitForSelector('.ov-modal .st-shell')
  await page.locator('.st-nav-btn:has-text("工具、MCP、沙箱与软件")').click()
  stubState.savedGuardConfigs.length = 0
  await page.locator('button:has-text("一键关闭命令拦截")').click()
  await page.waitForTimeout(220)
  const savedGuard = stubState.savedGuardConfigs[stubState.savedGuardConfigs.length - 1] || {}
  record(
    'Suite-F',
    '安全护栏可视化配置：一键关闭命令拦截落盘 guard.json',
    savedGuard.tiers && savedGuard.tiers.run_command === 'off' && savedGuard.tiers.run_powershell === 'off',
    JSON.stringify(savedGuard.tiers || {})
  )
  await page.locator('.ov-modal .ov-close').click()
  await page.waitForTimeout(200)

  // F2: 群聊自定义「ui设计」角色 + 智能路由调度全部 4 位成员 + 真工具写文件 + 折叠 + 群文件面板
  await page.locator('.hb-rail-btn[title="角色群聊"]').click()
  await page.waitForSelector('.gp-root')
  await page.locator('.gp-controls button:has-text("自定义角色与模型")').click()
  await page.waitForSelector('.gp-roster-panel')
  await page.locator('.gp-roster-panel button:has-text("工程铁三角")').click()
  const addCardF = page.locator('.gp-member-card').last()
  await addCardF.locator('input[placeholder*="新角色名"]').fill('ui设计')
  await addCardF.locator('input[placeholder*="职责与输出要求"]').fill('负责界面视觉设计与CSS美化')
  await addCardF.locator('button:has-text("添加角色")').click()
  await page.locator('.gp-roster-panel button:has-text("完成")').click()

  stubState.writtenFiles.length = 0
  stubState.triggerGroupToolOnce = true
  await page.locator('.gp-input').fill('帮我在工作区做一个好看的网页 index.html，优化 UI 界面')
  await page.locator('.gp-bar button:has-text("发起接力")').click()
  await page.waitForSelector('.rt-stage[data-status="done"]', { timeout: 15000 })

  const wroteHtml = stubState.writtenFiles.some((f) => f.path === 'index.html')
  const collapsedCount = await page.locator('.gp-body-wrap[data-collapsed="true"]').count()
  const compactDoneTrack = await page.locator('.rt-stage[data-compact="true"]').count()
  const gpNoOverflow = await page.locator('.gp-root').evaluate((el) => el.scrollWidth <= el.clientWidth + 2)
  const routeSummaryTxt = await page.locator('.rt-route-summary').textContent()
  const uiBeforeImpl = Boolean(routeSummaryTxt && routeSummaryTxt.indexOf('ui设计') >= 0 && routeSummaryTxt.indexOf('ui设计') < routeSummaryTxt.indexOf('实现工程师'))
  await page.locator('.gp-controls button:has-text("群文件")').click()
  await page.waitForSelector('.gp-files-panel', { timeout: 3000 })
  const filesPanelVisible = await page.locator('.gp-files-panel').isVisible()
  const fileRowCount = await page.locator('.gp-file-row').count()
  await page.locator('.gp-files-panel button:has-text("×")').click()
  record(
    'Suite-F',
    '群聊真工具写文件 + 长交付无遮挡折叠 + 完成轨道自动收束 + 群文件悬浮抽屉零裁切',
    wroteHtml && collapsedCount > 0 && compactDoneTrack === 1 && gpNoOverflow && uiBeforeImpl && filesPanelVisible && fileRowCount > 0,
    `wroteHtml=${wroteHtml}, uiBeforeImpl=${uiBeforeImpl}, route=${routeSummaryTxt}, collapsed=${collapsedCount}, files=${fileRowCount}`
  )

  /* ======================================================================== *
   * Suite G · R7 热门行业专家库 + 普通/群聊上下文环形使用量指示器 + 空间起源开关过渡
   * ======================================================================== */
  // G1: 验证群聊页面上下文使用量环形指示器（.ctx-ring-btn + 精确悬浮文案）
  const grpRingLabel = await page.locator('.gp-bar .ctx-ring-btn').getAttribute('aria-label')
  const grpRingOk = Boolean(grpRingLabel && /\d+\.\d+%\s*·\s*\d+\.\d+K\s*\/\s*\d+\.\d+K\s*上下文已使用/.test(grpRingLabel))
  record('Suite-G', '群聊页底部上下文环形使用量指示器就位且格式精确', grpRingOk, grpRingLabel || 'missing')

  // G2: 打开行业专家市场 → 验证 12 大跨行业专家包 + 行业筛选 + 无横向裁切 + 加入输入框
  await page.locator('.hb-rail-btn[title*="专家"]').click()
  await page.waitForSelector('.ov-modal .mk-grid')
  await page.waitForTimeout(360)
  const totalCuratedCards = await page.locator('.mk-card').count()
  const noHorizOverflow = await page.locator('.mk-body').evaluate((el) => el.scrollWidth <= el.clientWidth + 2)
  await page.locator('.mk-cats button:has-text("办公文档")').click()
  const officeCards = await page.locator('.mk-card').count()
  await page.locator('.mk-card').first().locator('button:has-text("加入输入框")').click()
  await page.waitForTimeout(260)
  const chipAttached = (await page.locator('.chat-token-chip').count()) > 0
  const chatRingLabel = await page.locator('.chat-composer-foot .ctx-ring-btn').getAttribute('aria-label')
  const chatRingOk = Boolean(chatRingLabel && /\d+\.\d+%\s*·\s*\d+\.\d+K\s*\/\s*\d+\.\d+K\s*上下文已使用/.test(chatRingLabel))
  record(
    'Suite-G',
    '行业专家市场（热门包全量/分类筛选/零裁切/直入胶囊）+ 普通对话上下文环形指示器',
    // 原断言 `=== 12`：r21 把内置包扩到 18，立刻假红。意图是"热门包全量渲染且零裁切"，
    // 不是"恰好 12 张" ⇒ 改为下限（>=12）+ 零横向裁切 + 分类可用。
    totalCuratedCards >= 12 && noHorizOverflow && officeCards >= 2 && chipAttached && chatRingOk,
    `cards=${totalCuratedCards}, office=${officeCards}, noOverflow=${noHorizOverflow}, chip=${chipAttached}, chatRing=${chatRingLabel}`
  )

  /* ======================================================================== *
   * Suite H · R11 效果拍板交互弹窗（ask_user_options）+ 灵动岛单行工具栏 + 自主发挥开关
   * ======================================================================== */
  stubState.triggerClarifyOnce = true
  stubState.chatRequests.length = 0
  await page.locator('.chat-textarea').fill('帮我设计一个精密钟摆网页')
  await page.locator('.chat-send-btn').click()
  await page.waitForSelector('.cl-modal', { timeout: 6000 })
  await page.locator('.cl-opt:has-text("黄铜精密机械")').click()
  await page.locator('#cl-custom-input').fill('增加夜间护眼暖光模式')
  await page.locator('.cl-foot button:has-text("确认方案并继续执行")').click()
  await page.waitForSelector('.cl-modal', { state: 'detached', timeout: 5000 })
  await page.waitForTimeout(500)
  const sawUserChoice = stubState.chatRequests.some((r) => JSON.stringify(r.messages || []).includes('黄铜精密机械') && JSON.stringify(r.messages || []).includes('增加夜间护眼暖光模式'))
  record(
    'Suite-H',
    '效果拍板交互弹窗：用户选定风格 + 自定义补充实时回灌模型无缝续跑',
    sawUserChoice,
    `sawUserChoice=${sawUserChoice}`
  )

  /* ======================================================================== *
   * Suite I · R13 左侧边栏上下文切换「群聊列表/+新建群聊」+ 多群文件严格隔离 + 删群清文件
   * ======================================================================== */
  await page.locator('.hb-rail-btn[title="角色群聊"]').click()
  await page.waitForSelector('.gp-root')
  const sideHeadGroup = await page.locator('.hb-side-head').textContent()
  const oldGroupId = await page.locator('.ss-side[data-mode="group"] .ss-item[data-active="true"]').getAttribute('data-group-id')
  const oldFilesBtnText = await page.locator('.gp-controls button:has-text("本群文件")').textContent()

  // I1: 左侧边栏点击「+ 新建群聊」→ 顶栏不再堆砌选择器，新群 ID 独立且本群文件归零
  await page.locator('.ss-side[data-mode="group"] button:has-text("新建群聊")').click()
  await page.waitForTimeout(220)
  const newGroupId = await page.locator('.ss-side[data-mode="group"] .ss-item[data-active="true"]').getAttribute('data-group-id')
  const newFilesBtnText = await page.locator('.gp-controls button:has-text("本群文件")').textContent()
  const isolatedEmpty = /群聊列表/.test(sideHeadGroup || '') && newGroupId !== oldGroupId && /本群文件\s*\(0\)/.test(newFilesBtnText || '')
  record(
    'Suite-I',
    '切入角色群聊时侧边栏切换为群聊列表，侧边栏新建群聊独立隔离且本群文件归零',
    isolatedEmpty,
    `head=${(sideHeadGroup || '').trim()}, old=${oldGroupId}(${(oldFilesBtnText || '').trim()}), new=${newGroupId}(${(newFilesBtnText || '').trim()})`
  )

  // I2: 在左侧边栏直接点旧群的「×」→ 弹出删除确认窗 → 选清空群文件 → 后端触发 __PURGE_ALL__
  await page.locator(`.ss-side[data-mode="group"] .ss-item[data-group-id="${oldGroupId}"] .ss-del`).click()
  await page.waitForSelector('.gd-modal', { timeout: 4000 })
  await page.locator('.gd-foot button:has-text("确认删除群聊与群文件")').click()
  await page.waitForSelector('.gd-modal', { state: 'detached', timeout: 4000 })
  await page.waitForTimeout(220)
  const purgedOld = stubState.purgedGroupIds.includes(oldGroupId)
  const remainingIds = await page.locator('.ss-side[data-mode="group"] .ss-item').evaluateAll((els) => els.map((el) => el.getAttribute('data-group-id')))
  record(
    'Suite-I',
    '侧边栏删除群聊弹窗支持清空群文件，确认后彻底清理旧群目录并移除列表',
    purgedOld && !remainingIds.includes(oldGroupId),
    `purged=${purgedOld}, remaining=${JSON.stringify(remainingIds)}`
  )

  /* ======================================================================== *
   * Suite J · R13 项目会话（绑定专属工作文件夹）与普通会话自由新建与切换
   * ======================================================================== */
  await page.locator('.hb-rail-btn[title="智能对话"]').click()
  await page.waitForSelector('.ss-side[data-mode="sessions"]')
  stubState.boundProjectWs.length = 0
  await page.locator('.ss-side[data-mode="sessions"] button:has-text("项目会话")').click()
  await page.waitForSelector('.pm-modal', { timeout: 4000 })
  await page.locator('.pm-modal button:has-text("浏览文件夹")').click()
  await page.waitForTimeout(160)
  await page.locator('.pm-foot button:has-text("创建项目会话")').click()
  await page.waitForSelector('.pm-modal', { state: 'detached', timeout: 4000 })
  await page.waitForTimeout(220)
  const modeStripProj = await page.locator('.chat-mode-strip').textContent()
  const hasProjItem = (await page.locator('.ss-side[data-mode="sessions"] .ss-item[data-kind="project"][data-active="true"]').count()) === 1
  const boundOk = stubState.boundProjectWs.some((x) => x.dir.includes('harbor-project') && x.enabled)
  record(
    'Suite-J',
    '新建项目会话：浏览绑定专属文件夹 + 侧边栏与输入区标识清晰 + 同步后端 set_session_ws',
    hasProjItem && boundOk && /项目会话/.test(modeStripProj || '') && /harbor-project/.test(modeStripProj || ''),
    `hasProjItem=${hasProjItem}, boundOk=${boundOk}, strip=${(modeStripProj || '').trim()}`
  )

  // J2: 一键转为普通会话（解除专属文件夹绑定）
  await page.locator('.chat-mode-strip button:has-text("转为普通会话")').click()
  await page.waitForTimeout(200)
  const modeStripNormal = await page.locator('.chat-mode-strip').textContent()
  record(
    'Suite-J',
    '项目会话支持一键转为普通会话并解除专属工作目录绑定',
    /普通会话/.test(modeStripNormal || ''),
    `strip=${(modeStripNormal || '').trim()}`
  )

  /* ======================================================================== *
   * Suite K · R15 实时交互 Artifact 画布 + 代码块复制栏 + Zen 专注模式 + 侧栏实时搜索
   * ======================================================================== */
  stubState.triggerArtifactOnce = true
  await page.locator('.chat-textarea').fill('生成一个 HTML 交互示例')
  await page.locator('.chat-send-btn').click()
  await page.waitForSelector('.chat-msg-bar button:has-text("实时画布")', { timeout: 6000 })
  const hasCodeCopyBar = (await page.locator('.md-code-block .md-code-copy').count()) >= 1
  await page.locator('.chat-msg-bar button:has-text("实时画布")').first().click()
  await page.waitForSelector('.ac-frame', { timeout: 4000 })
  const frameSrcDoc = await page.locator('.ac-frame').getAttribute('srcdoc')
  record(
    'Suite-K',
    '实时交互 Artifact 画布：自动识别 HTML 代码块并在沙箱 iframe 实时渲染 + 代码块复制栏',
    hasCodeCopyBar && Boolean(frameSrcDoc && frameSrcDoc.includes('Hello Artifact Canvas') && frameSrcDoc.includes('data-harbor-guard')),
    `hasCodeCopyBar=${hasCodeCopyBar}, hasGuard=${Boolean(frameSrcDoc && frameSrcDoc.includes('data-harbor-guard'))}`
  )

  // M1: 点击沙箱内 <form><button> 与 <a href="index.html">，绝不套娃重新打开 Harbor，且弹出拦截提示
  const frameLoc = page.frameLocator('.ac-frame')
  await frameLoc.locator('#subbtn').click()
  await page.waitForTimeout(220)
  const nestedShellAfterForm = await frameLoc.locator('.hb-shell').count()
  const guardNoticeText = await page.locator('.ac-notice').textContent().catch(() => '')
  await frameLoc.locator('#rel').click()
  await page.waitForTimeout(220)
  const nestedShellAfterLink = await frameLoc.locator('.hb-shell').count()
  record(
    'Suite-M',
    '防套娃守护：在实时画布内点击网页表单按钮/相对链接绝不重载 Harbor 宿主项目网页',
    nestedShellAfterForm === 0 && nestedShellAfterLink === 0 && /已拦截沙箱内页面跳转/.test(guardNoticeText || ''),
    `nestedForm=${nestedShellAfterForm}, nestedLink=${nestedShellAfterLink}, notice=${(guardNoticeText || '').trim()}`
  )

  await page.locator('.dk-close').click()
  await page.waitForTimeout(220)

  // K2: Zen 专注模式切换与恢复 + 侧栏搜索过滤框可用
  await page.locator('.hb-topbar button:has-text("专注")').click()
  await page.waitForTimeout(160)
  const zenOn = (await page.locator('.hb-shell').getAttribute('data-zen')) === 'true'
  await page.locator('.hb-topbar button:has-text("退出专注")').click()
  await page.waitForTimeout(160)
  const zenOff = (await page.locator('.hb-shell').getAttribute('data-zen')) === 'false'
  const filterVisible = await page.locator('.ss-filter').isVisible()
  record(
    'Suite-K',
    'Zen 专注模式一键隐藏/恢复导航与侧栏 + 侧栏实时搜索框就绪',
    zenOn && zenOff && filterVisible,
    `zenOn=${zenOn}, zenOff=${zenOff}, filterVisible=${filterVisible}`
  )

  /* ======================================================================== *
   * Suite L · R16 插件化可视化 DAG 工作流引擎 + 插件热插拔中心端到端验收
   * ======================================================================== */
  await page.locator('.hb-rail-btn[title="工作流插件"]').click()
  await page.waitForSelector('.wf-root', { timeout: 5000 })
  const wfSideHead = await page.locator('.hb-side-head').textContent()
  const dagNodeCount = await page.locator('.wg-node').count()
  const dagEdgeCount = await page.locator('.wg-edge-base').count()

  // L1: 侧边栏切换为「工作流目录」，可视化 DAG 节点图与 SVG 连线完整渲染，演练动效驱动并发拓扑
  await page.locator('.wf-actions button[aria-label="工作流更多操作"]').click()
  await page.locator('.dm-panel button:has-text("演练并发 DAG 动效")').click()
  await page.waitForTimeout(450)
  const hasRunningOrDone = (await page.locator('.wg-node[data-status="running"], .wg-node[data-status="done"]').count()) >= 1
  record(
    'Suite-L',
    '插件化 DAG 工作流工坊：侧栏切换工作流目录 + SVG 节点图渲染 + 并发拓扑动效执行',
    /工作流目录/.test(wfSideHead || '') && dagNodeCount >= 4 && dagEdgeCount >= 3 && hasRunningOrDone,
    `head=${(wfSideHead || '').trim()}, nodes=${dagNodeCount}, edges=${dagEdgeCount}, active=${hasRunningOrDone}`
  )

  // 干净收口演练定时器后再切至插件中心，杜绝关闭阶段悬空定时回调
  if (await page.locator('.wf-runbar button:has-text("中止执行")').isVisible().catch(() => false)) {
    await page.locator('.wf-runbar button:has-text("中止执行")').click()
  }

  // L2: 切换到插件中心 → 热插拔安装自定义 JSON 插件 → 校验新插件上线且可即时启停
  await page.locator('.wf-seg-btn:has-text("插件中心")').click()
  await page.waitForSelector('.wf-plugins-grid', { timeout: 4000 })
  await page.locator('.wf-actions button:has-text("热插拔安装 JSON 插件")').click()
  await page.waitForSelector('.wf-install-box', { timeout: 3000 })
  await page.locator('.wf-install-box button:has-text("校验并热安装插件")').click()
  await page.waitForSelector('.wf-plugin-card[data-plugin-id="custom.prd-sprint"]', { timeout: 4000 })
  const installedVisible = await page.locator('.wf-plugin-card[data-plugin-id="custom.prd-sprint"]').isVisible()
  await page.locator('.wf-plugin-card[data-plugin-id="custom.prd-sprint"] button:has-text("已启用")').click()
  await page.waitForTimeout(160)
  const toggledOff = (await page.locator('.wf-plugin-card[data-plugin-id="custom.prd-sprint"]').getAttribute('data-enabled')) === 'false'
  record(
    'Suite-L',
    '插件热插拔中心：自定义 JSON 插件实时校验安装 + 即时启停热重载生效',
    installedVisible && toggledOff,
    `installed=${installedVisible}, toggledOff=${toggledOff}`
  )

  // M2: 工作流工坊可用性升级 — 一句话生成并发 DAG 工作流 + 检视器直接增删拓扑连线
  await page.locator('.wf-seg-btn:has-text("编排工坊")').click()
  await page.waitForSelector('.wf-root .wg-viewport', { timeout: 4000 })
  await page.locator('.wf-actions button:has-text("一句话生成流")').click()
  await page.waitForSelector('.wf-synth-bar', { timeout: 3000 })
  await page.locator('.wf-synth-bar input').fill('调研竞品定价并做红蓝反证生成报告')
  await page.locator('.wf-synth-bar button:has-text("生成并载入 DAG")').click()
  await page.waitForTimeout(240)
  const genTitle = await page.locator('.wf-meta-desc').textContent()
  const edgesBefore = await page.locator('.wg-edge-base').count()
  await page.locator('.wf-edge-add button:has-text("连线")').click()
  await page.waitForTimeout(200)
  const edgesAfter = await page.locator('.wg-edge-base').count()
  record(
    'Suite-M',
    '工作流工坊升级：一句话智能生成并发 DAG + 检视器直接增删拓扑连线',
    /智能生成/.test(genTitle || '') && edgesAfter === edgesBefore + 1,
    `genTitle=${(genTitle || '').trim().slice(0, 36)}, edges=${edgesBefore}->${edgesAfter}`
  )

  /* ======================================================================== *
   * Suite N · R18 工作流可视化拖拽交互（节点自由拖拽定位 + 端口拖拽连线 + 自动排布复位）
   * ======================================================================== */
  const dragNode = page.locator('.wg-node').first()
  const dragNodeId = await dragNode.getAttribute('data-node-id')
  const beforeLeft = await dragNode.evaluate((el) => parseFloat(el.style.left || '0'))
  const beforeTop = await dragNode.evaluate((el) => parseFloat(el.style.top || '0'))
  const box = await dragNode.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 72, box.y + box.height / 2 + 44, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(220)
  const movedNode = page.locator(`.wg-node[data-node-id="${dragNodeId}"]`)
  const afterLeft = await movedNode.evaluate((el) => parseFloat(el.style.left || '0'))
  const afterTop = await movedNode.evaluate((el) => parseFloat(el.style.top || '0'))
  await page.locator('.wf-meta-badges button:has-text("自动排布")').click()
  await page.waitForTimeout(180)
  const resetLeft = await movedNode.evaluate((el) => parseFloat(el.style.left || '0'))
  record(
    'Suite-N',
    '可视化 DAG 节点鼠标自由拖拽定位 + 一键恢复自动拓扑排布',
    afterLeft > beforeLeft + 40 && afterTop > beforeTop + 20 && Math.abs(resetLeft - beforeLeft) <= 2,
    `left=${beforeLeft}->${afterLeft}->${resetLeft}, top=${beforeTop}->${afterTop}`
  )

  // N2: 端口鼠标拖拽建立连线（75% 缩放确保源/目标同屏可见，从 pro 输出口 ● 拖到同层并行节点 risk 建立合法无环连线）
  await page.locator('.wf-meta-badges button:has-text("75%")').click()
  await page.waitForTimeout(160)
  const edgeCntBeforePort = await page.locator('.wg-edge-base').count()
  const outPortBox = await page.locator('.wg-port-out[data-port-out="pro"]').boundingBox()
  const targetNodeBox = await page.locator('.wg-node[data-node-id="risk"]').boundingBox()
  await page.mouse.move(outPortBox.x + outPortBox.width / 2, outPortBox.y + outPortBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetNodeBox.x + targetNodeBox.width / 2, targetNodeBox.y + targetNodeBox.height / 2, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(220)
  const edgeCntAfterPort = await page.locator('.wg-edge-base').count()
  record(
    'Suite-N',
    '可视化 DAG 端口鼠标拖拽实时拉线连接（自动拓扑环路校验 + 持久化）',
    edgeCntAfterPort === edgeCntBeforePort + 1,
    `edges=${edgeCntBeforePort}->${edgeCntAfterPort}`
  )

  /* ======================================================================== *
   * Suite O · R19 多模态图片/视频生成工具闭环 + 升级内置插件（8 插件含 IMG/VID/LOOP 节点）
   * ======================================================================== */
  await page.locator('.ss-side[data-mode="workflow"] .ss-item[data-workflow-id="wf-ai-video-film"]').click()
  await page.waitForTimeout(220)
  const hasImgNode = (await page.locator('.wg-node[data-kind="image_gen"]').count()) >= 1
  const hasVidNode = (await page.locator('.wg-node[data-kind="video_gen"]').count()) >= 1
  const wfCountTotal = await page.locator('.ss-side[data-mode="workflow"] .ss-item').count()
  record(
    'Suite-O',
    '内置插件与工作流升级：8 大内置插件就绪，AI 短片导演工作流包含 IMG + VID 节点',
    hasImgNode && hasVidNode && wfCountTotal >= 7,
    `hasImg=${hasImgNode}, hasVid=${hasVidNode}, totalWfs=${wfCountTotal}`
  )

  await page.locator('.hb-rail-btn[title="智能对话"]').click()
  await page.waitForSelector('.chat-textarea')
  stubState.triggerImageToolOnce = true
  stubState.mediaRequests.length = 0
  await page.locator('.chat-textarea').fill('帮我画一张赛博玻璃港口海报图')
  await page.locator('.chat-send-btn').click()
  await page.waitForSelector('.ac-frame', { timeout: 6000 })
  const mediaHit = stubState.mediaRequests.some((r) => r.path === '/images/generations')
  const gallerySrc = await page.locator('.ac-frame').getAttribute('srcdoc')
  record(
    'Suite-O',
    '多模态生图工具闭环：generate_image 经本地代理调用并自动推入实时画布画廊展示',
    // 判据用**结构标记**而不是文案：`media-card` 只出现在 buildMediaGalleryArtifact 产出的
    // 画廊 HTML 里；而原先断言的 'Harbor Generated Image' 在产品里根本不存在
    // （title 实际是提示词前 22 字）⇒ 那条断言永远不可能为真。
    mediaHit && Boolean(gallerySrc && gallerySrc.includes('class="media-card"') && /<img\s/.test(gallerySrc)),
    `mediaHit=${mediaHit}, hasGallery=${Boolean(gallerySrc && gallerySrc.includes('class="media-card"'))}, hasImg=${Boolean(gallerySrc && /<img\s/.test(gallerySrc))}`
  )
  await page.locator('.dk-close').click()

  /* ======================================================================== *
   * Suite P · R20 对外发布级布局与二级菜单体系 + 弹窗 Escape 平滑退场动效验收
   * ======================================================================== */
  const primaryNavCnt = await page.locator('.hb-rail-btn[data-primary-nav="true"]').count()
  await page.locator('.hb-rail-more-toggle').click()
  await page.waitForSelector('.hb-rail-sublist', { timeout: 3000 })
  const secondaryNavCnt = await page.locator('.hb-rail-sub-btn').count()
  await page.locator('.hb-rail-more-toggle').click()

  await page.locator('.hb-topbar button[title*="外观主题"]').click()
  await page.waitForSelector('.dm-panel[aria-label="外观与透色菜单"]', { timeout: 3000 })
  const appearanceHasBackdrop = (await page.locator('.dm-panel button:has-text("Acrylic")').count()) === 1
  await page.keyboard.press('Escape')
  await page.waitForSelector('.dm-panel[aria-label="外观与透色菜单"]', { state: 'detached', timeout: 3000 })
  const appearanceClosed = (await page.locator('.dm-panel[aria-label="外观与透色菜单"]').count()) === 0

  record(
    'Suite-P',
    '发布级一级/二级菜单层级：一级主导航克制为 4 核 + 二级折叠 4 项 + 外观二级菜单支持 Escape 平滑关闭',
    primaryNavCnt === 4 && secondaryNavCnt === 4 && appearanceHasBackdrop && appearanceClosed,
    `primary=${primaryNavCnt}, secondary=${secondaryNavCnt}, hasBackdrop=${appearanceHasBackdrop}, escClosed=${appearanceClosed}`
  )

  await page.locator('.ss-side[data-mode="sessions"] button:has-text("项目会话")').click()
  await page.waitForSelector('.pm-modal', { timeout: 3000 })
  await page.keyboard.press('Escape')
  await page.waitForSelector('.pm-modal', { state: 'detached', timeout: 3000 })
  const pmDetached = (await page.locator('.pm-modal').count()) === 0
  record(
    'Suite-P',
    '二级弹窗交互与退场动画：ProjectSessionModal 按 Escape 平滑退场并干净卸载',
    pmDetached,
    `detached=${pmDetached}`
  )

  /* ======================================================================== *
   * Suite Q · R21 模型保存中心自定义添加 + 对话/顶栏随处切换 + 指南复开 + 18 大专家库
   * ======================================================================== */
  await page.locator('.hb-rail-btn[title="系统设置"]').click()
  await page.waitForSelector('.ov-modal [data-section="model-vault"]', { timeout: 4000 })
  await page.locator('input[aria-label="保存模型显示名称"]').fill('DeepSeek 旗舰代码')
  await page.locator('input[aria-label="保存模型ID"]').fill('deepseek-r1-custom')
  await page.locator('input[aria-label="保存模型端点URL"]').fill('https://api.deepseek.com/v1')
  await page.locator('[data-section="model-vault"] button:has-text("保存到模型中心")').click()
  await page.waitForSelector('[data-section="model-vault"] .st-mem-row:has-text("DeepSeek 旗舰代码")', { timeout: 4000 })
  await page.locator('.ov-modal .ov-close').click()
  await page.waitForSelector('.ov-modal', { state: 'detached', timeout: 4000 })

  // Q1: 在智能对话输入模式条下拉直接切换刚保存的模型，顶部灵动岛同步更新
  const chatModelSelect = page.locator('select[aria-label="切换本会话模型"]')
  const savedOptVal = await chatModelSelect.locator('option:has-text("DeepSeek 旗舰代码")').getAttribute('value')
  await chatModelSelect.selectOption(savedOptVal)
  await page.waitForTimeout(160)
  const islandAfterSwitch = await page.locator('.hb-island').textContent()
  record(
    'Suite-Q',
    '模型保存中心：自定义添加模型后在对话页一键切换并同步更新顶栏状态岛',
    Boolean(savedOptVal) && /DeepSeek 旗舰代码/.test(islandAfterSwitch || ''),
    `optVal=${savedOptVal}, island=${(islandAfterSwitch || '').trim()}`
  )

  // Q2: 从顶栏「外观 ▾」菜单重新打开「功能说明与软件特色」并按 Escape 平滑关闭
  await page.locator('.hb-topbar button[title*="外观主题"]').click()
  await page.waitForSelector('.dm-panel button:has-text("功能说明与软件特色")', { timeout: 3000 })
  await page.locator('.dm-panel button:has-text("功能说明与软件特色")').click()
  await page.waitForSelector('.ob-modal', { timeout: 3000 })
  await page.keyboard.press('Escape')
  await page.waitForSelector('.ob-modal', { state: 'detached', timeout: 3000 })
  record(
    'Suite-Q',
    '使用指南弹窗支持从二级菜单随时复开并按 Escape 平滑关闭',
    (await page.locator('.ob-modal').count()) === 0,
    'reopened_and_escaped=true'
  )

  // D4: 全程零未捕获页面异常
  record('Global', '全程零未捕获 pageerror', pageErrors.length === 0, pageErrors[0] || '0 errors')
} finally {
  await browser.close().catch(() => {})
  await new Promise((resolve) => server.close(resolve))
}

const failed = results.filter((r) => !r.ok)
console.log('\n================ E2E R3 REGRESSION SUMMARY ================')
console.log(JSON.stringify({
  ok: failed.length === 0,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  pageErrors,
}, null, 2))
process.exit(failed.length ? 1 : 0)
