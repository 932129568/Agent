/**
 * Harbor 桌面壳（P0-4 T01：Electron 壳基座与桥切换，A1 主进程宿主口径）。
 *
 * §2.3 启动时序（T02 修订：env 注入最先行）：单实例锁（HEADLESS 跳过）→
 *   whenReady → env 注入（DATABASE_URL 绝对路径锚定 CONFIG_DIR）→ safeStorage
 *   探测日志 + codec 路径披露 → dynamic import server/src/app.js（A1：fastify
 *   宿主于主进程）→ 动态端口 → ensureSchema 建表 → bootstrap 迁移后台链 →
 *   BrowserWindow(preload, contextIsolation:true, nodeIntegration:false)（HEADLESS
 *   跳过）→ loadFile harbor.html → 关窗优雅停机（app.close 触发 onClose 钩子的
 *   mcpShutdown + browserShutdown → disconnectDb → app.quit）。
 *
 * spike 结论（2026-10-31，electron 45.2.1，实测见交付报告）：
 *   a. 内嵌 Node 24.22.1 ≥ 24.22 实测验证基线 —— A1 维持，不触发 A1→A3 降级；
 *   b. `./generated/prisma/client.ts` 类型擦除在本运行时可用（Prisma 23.6+ 默认开）；
 *   c. @libsql（napi 原生绑定）在 Electron 运行时可加载、可执行 SQL；
 *   d. asar：开发模式不打包（loadFile + 相对路径 libs/ 实测可用）。生产打包为
 *      T04 范围——原生模块 asarUnpack；PROJECT_ROOT 相对链在 asar 内若解析失败，
 *      按预设路径改 env 锚 process.resourcesPath（HARBOR_BUILTIN_EXPERTS_DIR /
 *      prompts 定位已 env 化，改动面收敛）。
 *
 * T02 增量（2026-10-31）：
 *   - fresh-DB 建表：listen 后先 ensureSchema（幂等 DDL，db.js SCHEMA_DDL），
 *     再挂 bootstrap 迁移后台链（bootstrapLegacyImport → migratePlaintextSecrets，
 *     与 index.js 生产入口语义同构：listen 后、不阻塞、不在 import 期、零新迁移
 *     代码——P0-2 §3.2 挂接纪律）；
 *   - HARBOR_HEADLESS=1 server-only 分支（§6.2/Q10，先例=main.py GLM_CDP_PORT
 *     seam）：不开窗、不持单实例锁（产物验收可多实例隔离并行），env 缺省零行为；
 *   - DPAPI codec 裁决（T02 互解实测偏差）：electron 45.2.1 safeStorage 密文为
 *     'v10'+AES-GCM（userData Local State 密钥），违反 dpapi.js 'dpapi:' CurrentUser
 *     裸 blob 契约、四向互解不成立 → dpapi.js 路径 1 默认停用（HARBOR_SAFESTORAGE=1
 *     选回），全宿主统一 PS ProtectedData 保跨语言/双轨回退兼容。
 *
 * T03 增量（2026-10-31）：admin 人审对话框 provider（§4.2/Q7 原生 dialog）——
 *   listen 后注册 setHostDialogProvider（HEADLESS 不注册=fail-closed 桩）；
 *   并发人审经 Promise 队列串行弹窗、按 requestId 路由回执；sid 标注=DB 会话
 *   名（不可查则短 sid）；默认按钮/Esc=拒绝（fail-closed）。
 *
 * 红线对位：main.py / backend/ Python 零改动；config.json 零污染（shell 配置仅
 * 经本进程 env 注入）；server 只绑 127.0.0.1；dist/ 不触碰。
 */
const { app, BrowserWindow, dialog, safeStorage } = require('electron')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '..')

/** §6.2/Q10：HARBOR_HEADLESS=1 → server-only（产物验收基建；env 缺省零行为） */
const HEADLESS = process.env.HARBOR_HEADLESS === '1'

/** @type {BrowserWindow|null} */
let win = null
/** @type {import('fastify').FastifyInstance|null} A1 宿主：fastify 实例 */
let serverApp = null
/** @type {import('node:module').Module|null|undefined} db 模块缓存（ESM 单例） */
let dbModule
let shuttingDown = false

async function importDb() {
  if (!dbModule) dbModule = await import(pathToFileURL(path.join(ROOT, 'server', 'src', 'db.js')).href)
  return dbModule
}

/**
 * §2.3 env 注入——必须先于 server 模块 import：server 的 config.js / paths.js
 * 在模块加载时读取 env。已显式设置的变量一律尊重（隔离 CONFIG_DIR 测试与
 * 开发调试依赖该语义）；HOST 强制 127.0.0.1（红线：只绑 loopback）。
 */
function injectEnv() {
  const configDir = process.env.HARBOR_CONFIG_DIR || path.join(os.homedir(), '.glm-chat')
  process.env.HARBOR_CONFIG_DIR = configDir
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = `file:${path.join(configDir, 'harbor.db')}`
  }
  process.env.HOST = '127.0.0.1'
  if (!process.env.PORT) process.env.PORT = '0' // 动态端口（listen 后回读实际值）
  // 桥 CORS：页面经 loadFile 以 file:// 加载，源为不透明 "null"；server 的 CORS
  // 默认关闭会拦下桥调用。按 config.js 既有口径（「浏览器直开 file:// 调试时
  // CORS_ORIGIN=null」）显式放行；env 作用域仅本进程，不影响差分环境。
  if (!process.env.CORS_ORIGIN) process.env.CORS_ORIGIN = 'null'
}

async function boot() {
  // 时序⓪：env 注入必须最先行——server 侧 config.js / paths.js（含 logger 传递
  // 依赖）在模块加载期读取 env；本函数后续任何 server 模块 import（含 codec
  // 路径披露的 dpapi.js）都不得先于本调用（T02 实测教训：codec 日志先于
  // injectEnv 触发 config.js 加载，DATABASE_URL 冻结为 dev 默认值）。
  injectEnv()

  // 时序①：safeStorage 探测日志（先于 server 启动）+ DPAPI codec 路径披露
  // （T02：路径 1 默认停用、HARBOR_SAFESTORAGE=1 选回——见 dpapi.js T02 修订注）
  try {
    console.log('[harbor] safeStorage.isEncryptionAvailable =', safeStorage.isEncryptionAvailable())
    const { activeCodecPath } = await import(
      pathToFileURL(path.join(ROOT, 'server', 'src', 'services', 'dpapi.js')).href)
    console.log('[harbor] dpapi codec path =', activeCodecPath())
  } catch (error) {
    console.log('[harbor] safeStorage probe failed:', error && error.message)
  }

  // A1：server 宿主于主进程——进程内即 DPAPI codec 宿主（T02 裁决：默认 PS 路径，
  // HARBOR_SAFESTORAGE=1 选回 safeStorage）；onClose 钩子（mcpShutdown +
  // browserShutdown）随 app.close 触发。
  const appModule = await import(pathToFileURL(path.join(ROOT, 'server', 'src', 'app.js')).href)
  serverApp = await appModule.buildServer()
  const base = await serverApp.listen({
    host: process.env.HOST,
    port: Number(process.env.PORT),
  })
  const port = serverApp.server.address().port
  console.log('[harbor] server listening:', base, '(methods 面 /health)')

  // T03（§4.2）：admin 人审对话框 provider 注册——任何 run_admin_command 人审
  // 请求经 host 接缝路由到本进程的原生 dialog（并发排队串行 + requestId 回执
  // 路由 + 会话名标注）。HEADLESS（server-only 验收）不注册 → 维持无宿主
  // fail-closed 桩语义（与差分/dev 环境一致）。
  if (!HEADLESS) {
    const host = await import(pathToFileURL(path.join(ROOT, 'server', 'src', 'host.js')).href)
    host.setHostDialogProvider({ adminMessageBox: adminMessageBoxProvider })
    console.log('[harbor] host dialog provider registered (adminMessageBox)')
  }

  // 时序③（T02）：fresh-DB 建表先行——ensureSchema 幂等 DDL（db.js SCHEMA_DDL
  // 与 prisma db push 逐字一致），避免首窗 /health、会话面与 bootstrap 后台链
  // 的建表竞态；失败=数据库不可用，按 fail-fast 处理（boot 失败退出）。
  const db = await importDb()
  await db.ensureSchema(db.prisma)
  console.log('[harbor] db schema ready:', db.currentDbPath())

  // 时序④（P0-2 §3.2 / T02）：bootstrap 迁移后台链——与 index.js 生产入口语义
  // 同构（listen 后、不阻塞、不在 import 期，零新迁移代码）：① legacy
  // sessions.json → DB 增量 merge 导入；② 存量明文密钥 DPAPI 迁移。
  ;(async () => {
    const { bootstrapLegacyImport } = await import(
      pathToFileURL(path.join(ROOT, 'server', 'src', 'services', 'session-migrate.js')).href)
    const { migratePlaintextSecrets } = await import(
      pathToFileURL(path.join(ROOT, 'server', 'src', 'services', 'dpapi-migrate.js')).href)
    const migrated = await bootstrapLegacyImport()
    if (migrated.error) console.error('[harbor] legacy sessions 迁移失败（下回启动重试）:', migrated.error)
    else console.log('[harbor] legacy sessions 迁移完成: imported=' + migrated.imported, 'skipped=' + migrated.skipped)
    const secrets = await migratePlaintextSecrets()
    if (secrets.error) console.warn('[harbor] 存量明文密钥迁移延后（W17）:', secrets.error, 'pending=' + secrets.pending)
    else console.log('[harbor] 存量明文密钥 DPAPI 迁移完成: migrated=' + secrets.migrated)
  })().catch(error => {
    console.error('[harbor] 存储迁移后台任务异常（下回启动重试）:', error && error.message)
  })

  // HARBOR_HEADLESS=1（§6.2/Q10）：server-only 到此为止——不开窗，进程保持
  // （listen 事件循环），SIGINT/SIGTERM 走既有优雅停机。T05/T06 live-replay /
  // 产物验收以 /health 轮询就绪、以信号收尾。
  if (HEADLESS) {
    console.log('[harbor] HARBOR_HEADLESS=1 → server-only ready:', base)
    return
  }

  // 时序②：桥切换注点（§2.4）——preload 经本进程 env 继承读取后 exposeInMainWorld，
  // 前端 frontend/src 零改动（bridge.js 判序 pywebview → HARBOR_API_BASE）。
  process.env.HARBOR_API_BASE = `http://127.0.0.1:${port}`

  win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // 显式声明口径（默认值亦为 true）
      nodeIntegration: false,
    },
  })
  // UNTRUSTED DATA 纪律（红线 4 / §2.3）：禁 window.open 逃逸面
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.on('closed', () => {
    win = null
    gracefulShutdown()
  })
  await win.loadFile(path.join(ROOT, 'harbor.html'))
  console.log('[harbor] window loaded; bridge base =', process.env.HARBOR_API_BASE)
}

/* ================= T03：admin 人审对话框 provider（§4.2 / Q7 原生 dialog） =================
 * 注册进 server/src/host.js 接缝：runAdminCommand 人审点经 hasHost() 调到此处。
 * - 形态：Electron 原生 dialog.showMessageBox（模态、含命令全文 + 来源会话标识 +
 *   允许/拒绝按钮；安全门独立于渲染进程存活——页面卡死人审仍可达）；
 * - 并发排队（§4.2）：多并行 run 同时触发人审 → Promise 队列串行弹窗，每个请求
 *   分配递增 requestId，回执携带 requestId 路由回对应调用方，杜绝「确认框与来源
 *   会话错位」；
 * - sid 标注：commands.js 经 ALS ctxSid() 传 sid → DB 可查会话名则标注会话名，
 *   否则短 sid 兜底；
 * - fail-closed：dialog 失败/异常一律回 {allow:false}（R9：唯一提权门不 fail-open）；
 *   默认按钮与 Esc 均为「拒绝」（回车误触不提权）；
 * - HARBOR_HEADLESS=1（server-only 验收）不注册：无 UI 可交互，维持无宿主
 *   fail-closed 桩语义（与差分/dev 环境一致）。 */
let adminDialogSeq = 0
let adminDialogTail = Promise.resolve()

async function adminSessionLabel(sid) {
  const id = String(sid || '').trim()
  if (!id) return '（未知会话）'
  try {
    const db = await importDb()
    const row = await db.prisma.session.findUnique({ where: { id } })
    const title = row && row.title ? String(row.title).trim() : ''
    if (title) return title
  } catch (error) { /* DB 不可查（未就绪/已断连）：短 sid 兜底 */ }
  return id.length > 12 ? id.slice(0, 8) + '…' + id.slice(-4) : id
}

/** 单次弹窗（队列串行化后逐个执行）；回执 {allow, requestId}。 */
async function showAdminMessageBoxOnce(requestId, req) {
  const cmdText = String((req && req.cmd) || '')
  const label = await adminSessionLabel(req && req.sid)
  const opts = {
    type: 'warning',
    buttons: ['允许执行', '拒绝'],
    defaultId: 1,   // 回车=拒绝（fail-closed 默认）
    cancelId: 1,    // Esc=拒绝
    noLink: true,
    title: 'Harbor 管理员命令人审',
    message: `AI 请求以管理员权限执行命令（请求 #${requestId}）`,
    detail: `来源会话：${label}\n命令全文：\n${cmdText}\n\n允许后将弹出 UAC 提权确认；拒绝则该命令不执行。`,
  }
  try {
    const parent = win && !win.isDestroyed() ? win : undefined
    const { response } = parent
      ? await dialog.showMessageBox(parent, opts)
      : await dialog.showMessageBox(opts)
    console.log(`[harbor] admin dialog #${requestId} resolved: response=${response} sid=${(req && req.sid) || ''}`)
    return { allow: response === 0, requestId }
  } catch (error) {
    console.error(`[harbor] admin dialog #${requestId} failed (fail-closed):`, error && error.message)
    return { allow: false, requestId }
  }
}

/** provider 入口：并发请求入 Promise 队列（串行弹窗），回执按 requestId 路由。 */
function adminMessageBoxProvider(req) {
  const requestId = ++adminDialogSeq
  const run = adminDialogTail.then(() => showAdminMessageBoxOnce(requestId, req))
  adminDialogTail = run.then(() => {}, () => {})   // 队尾吞错：后续请求不受前序失败阻塞
  return run
}

/** 关窗优雅停机（§2.3）：mcp/browser（app.close→onClose 钩子）→ db 断连 → quit。 */
async function gracefulShutdown() {
  if (shuttingDown) return
  shuttingDown = true
  console.log('[harbor] graceful shutdown: app.close(mcp/browser) → disconnectDb → quit')
  try {
    if (serverApp) await serverApp.close()
  } catch (error) {
    console.error('[harbor] server close error:', error && error.message)
  }
  try {
    const db = await importDb()
    await db.disconnectDb()
  } catch (error) {
    console.error('[harbor] db disconnect error:', error && error.message)
  }
  app.quit()
}

// §2.3：防双开双 server。HEADLESS 分支不持锁——产物验收（T05/T06）常需在
// 真机桌面应用旁并行拉起隔离 CONFIG_DIR 的 server-only 实例；缺省（不开
// HARBOR_HEADLESS）单实例锁语义逐字不变。
const gotLock = HEADLESS || app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  if (HEADLESS) {
    console.log('[harbor] HARBOR_HEADLESS=1 → server-only（不开窗、不持单实例锁）')
    // headless 无窗口：'window-all-closed' 永不触发，改挂进程信号收尾
    // （仅 headless 分支注册——缺省模式信号行为零变化）。
    process.on('SIGINT', () => { gracefulShutdown() })
    process.on('SIGTERM', () => { gracefulShutdown() })
  } else {
    app.on('second-instance', () => {
      if (win) {
        if (win.isMinimized()) win.restore()
        win.focus()
      }
    })
  }
  app.whenReady().then(boot).catch(error => {
    console.error('[harbor] boot failed:', error)
    app.quit()
  })
  app.on('window-all-closed', () => { gracefulShutdown() })
}
