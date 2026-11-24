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
  groupFiles: [],
  writtenFiles: [],
  chatRequests: [],
  triggerGroupToolOnce: false,
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
    else if (method === 'get_ws_state') out = { enabled: true, effective: REPO_ROOT }
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
    else if (method === 'group_files_list') out = { ok: true, dir: 'C:/harbor-test/group_files', files: stubState.groupFiles }
    else if (method === 'group_files_write') {
      const name = `handoff_${stubState.groupFiles.length + 1}.md`
      const entry = { name, path: `C:/harbor-test/group_files/${name}`, title: String(args[3] || name), member: String(args[2] || '主持人'), content: String(args[4] || ''), size: String(args[4] || '').length, mtime: Date.now() / 1000 }
      stubState.groupFiles.unshift(entry)
      out = { ok: true, name, path: entry.path }
    }
    else if (method === 'group_files_read') {
      const hit = stubState.groupFiles.find((f) => f.path === args[0] || f.name === args[0])
      out = { ok: true, content: hit ? hit.content : '# 交接文档内容' }
    }
    else if (method === 'group_files_delete') {
      stubState.groupFiles = stubState.groupFiles.filter((f) => f.name !== args[1])
      out = { ok: true }
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
    const hasToolRole = Array.isArray(body.messages) && body.messages.some((m) => m && m.role === 'tool')
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
   * Suite A · 群聊能力路由、自定义角色/模型与暂停续跑三态
   * ======================================================================== */
  await page.locator('.hb-rail-btn[title="角色群聊"]').click()
  await page.waitForSelector('.gp-root')

  // A1: 默认工程铁三角收到视频议题 → 智能能力路由触发诚实缺失预警
  await page.locator('.gp-input').fill('帮我制作一段 60 秒科技产品宣传视频分镜脚本')
  await page.locator('.gp-bar button:has-text("发起接力")').click()
  await page.waitForSelector('.gp-warn', { timeout: 5000 })
  const warnText = await page.locator('.gp-warn').textContent()
  record('Suite-A', '智能能力路由：无视频角色时触发诚实预警', /视频制作/.test(warnText || ''), (warnText || '').slice(0, 60))

  // 中止该轮回退接力，准备测自定义视频班底
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
  await page.locator('.gp-controls button:has-text("预览光梭接力动画")').click()
  await page.waitForSelector('.rt-stage[data-status="running"]', { timeout: 4000 })

  const eqCount = await page.locator('.rt-eq-bar').count()
  const chamberCount = await page.locator('.lc-chamber').count()
  const h1 = await page.locator('.rt-eq-bar').evaluateAll((els) => els.map((e) => e.style.height))
  await page.waitForTimeout(280)
  const h2 = await page.locator('.rt-eq-bar').evaluateAll((els) => els.map((e) => e.style.height))
  const eqAnimated = h1.join(',') !== h2.join(',')
  record(
    'Suite-B',
    '独立冷色轨道舞台 + 16 柱示波器真实动态跳动（非主对话流体波）',
    eqCount === 16 && eqAnimated && chamberCount === 0,
    `eqBars=${eqCount}, animated=${eqAnimated}, lcChamber=${chamberCount}`
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
  const eqAfterDone = await page.locator('.rt-eq').count()
  const doneNodes = await page.locator('.rt-node[data-state="done"]').count()
  record(
    'Suite-B',
    '接力完成后全部站点点亮 done 且示波器卸载（0% 后台空转）',
    eqAfterDone === 0 && doneNodes === 4,
    `doneNodes=${doneNodes}, eqAfterDone=${eqAfterDone}`
  )

  /* ======================================================================== *
   * Suite C · 设置中心上下文长度 / 最大输出 / 8 档与自定义思考档位
   * ======================================================================== */
  await page.locator('.hb-top-btn:has-text("透色与设置")').click()
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
  await page.locator('.hb-top-btn:has-text("透色与设置")').click()
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
  const toolsSorted = JSON.stringify(chatReqs[1] && chatReqs[1].toolNames) === JSON.stringify(['read_file', 'write_file'])
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
    `sysEqual=${sys1 === sys2}, toolsSorted=${toolsSorted}, dynInTail=${dynInTail}, antBp=${hasAnthropicBp}, ribbon=${(ribbonTxt || '').slice(0, 64)}`
  )

  /* ======================================================================== *
   * Suite F · R6 真机新能力（安全护栏设置 / 群聊真工具调用 / 长文折叠收纳 / 群文件面板）
   * ======================================================================== */
  // F1: 安全护栏一键关闭命令拦截
  await page.locator('.hb-top-btn:has-text("透色与设置")').click()
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
  await page.locator('.gp-controls button:has-text("群文件")').click()
  await page.waitForSelector('.gp-files-panel', { timeout: 3000 })
  const filesPanelVisible = await page.locator('.gp-files-panel').isVisible()
  const fileRowCount = await page.locator('.gp-file-row').count()
  await page.locator('.gp-files-panel button:has-text("×")').click()
  record(
    'Suite-F',
    '群聊真工具写文件 + 长交付无遮挡折叠 + 完成轨道自动收束 + 群文件悬浮抽屉零裁切',
    wroteHtml && collapsedCount > 0 && compactDoneTrack === 1 && gpNoOverflow && filesPanelVisible && fileRowCount > 0,
    `wroteHtml=${wroteHtml}, collapsed=${collapsedCount}, compactTrack=${compactDoneTrack}, noOverflow=${gpNoOverflow}, files=${fileRowCount}`
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
    '行业专家市场（12大热门包/分类筛选/零裁切/直入胶囊）+ 普通对话上下文环形指示器',
    totalCuratedCards === 12 && noHorizOverflow && officeCards >= 2 && chipAttached && chatRingOk,
    `cards=${totalCuratedCards}, office=${officeCards}, noOverflow=${noHorizOverflow}, chip=${chipAttached}, chatRing=${chatRingLabel}`
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
