/**
 * Harbor 桌面壳（React 19 全量架构 · 真窗外硬件透色 + 严格白名单协议）
 *
 * 完整保留 r156 验证通过的后端宿主链：
 *   单实例锁 → env 注入 → safeStorage 探测 → Fastify 主进程宿主 → admin 原生弹窗人审 →
 *   ensureSchema 建表 → legacy/DPAPI 后台迁移 → 优雅停机。
 *
 * v2 架构升级：
 *   1. 彻底移除旧静态桌面壁纸假透色（wallpaper.js / attachWallpaperToWindow）；
 *   2. 启用操作系统硬件实时窗外透色：Windows 11 用 backgroundColor:'#00000000' + backgroundMaterial:'acrylic'
 *      （严禁混用 transparent:true），macOS 用 vibrancy:'under-window'；
 *   3. harbor://app/ 严格白名单映射 frontend/app/dist/* 与 libs/*（补齐 .css/.svg/.woff2 MIME）。
 */
const { app, BrowserWindow, dialog, safeStorage, protocol, ipcMain, Menu } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '..')
const APP_DIST = path.join(ROOT, 'frontend', 'app', 'dist')
const HEADLESS = process.env.HARBOR_HEADLESS === '1'
const SMOKE = process.env.HARBOR_SMOKE === '1'
const HARBOR_SCHEME = 'harbor'
const USE_CUSTOM_PROTOCOL = process.env.HARBOR_LEGACY_FILE_PROTOCOL !== '1'

if (USE_CUSTOM_PROTOCOL) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: HARBOR_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        codeCache: true,
      },
    },
  ])
}

/** 协议资源白名单：精确映射 dist 产物与只读 libs，拒绝任何目录遍历。 */
const DIST_FILES = new Set(['index.html', 'app.js', 'app.css', 'app.js.map', 'app.css.map'])
const ASSET_FILES = new Set(['harbor.ico', 'harbor-icon.png'])
const LIB_FILES = new Set([
  'libs/marked.min.js',
  'libs/purify.min.js',
  'libs/flate.js',
  'libs/highlight.min.js',
  'libs/ui-schema.bundle.js',
  'libs/hub-catalog.json',
])

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

/** @type {BrowserWindow|null} */
let win = null
/** @type {import('fastify').FastifyInstance|null} */
let serverApp = null
let dbModule
let shuttingDown = false
let currentBackdrop = process.platform === 'win32' ? 'acrylic' : (process.platform === 'darwin' ? 'under-window' : 'none')

async function importDb() {
  if (!dbModule) dbModule = await import(pathToFileURL(path.join(ROOT, 'server', 'src', 'db.js')).href)
  return dbModule
}

function injectEnv() {
  const configDir = process.env.HARBOR_CONFIG_DIR || path.join(os.homedir(), '.glm-chat')
  process.env.HARBOR_CONFIG_DIR = configDir
  if (!process.env.NODE_COMPILE_CACHE) {
    const ccDir = path.join(configDir, 'compile_cache')
    try { fs.mkdirSync(ccDir, { recursive: true }) } catch (e) {}
    process.env.NODE_COMPILE_CACHE = ccDir
  }
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = `file:${path.join(configDir, 'harbor.db')}`
  }
  process.env.HOST = '127.0.0.1'
  if (!process.env.PORT) process.env.PORT = '0'
  if (!process.env.CORS_ORIGIN) {
    process.env.CORS_ORIGIN = USE_CUSTOM_PROTOCOL ? 'null,harbor://app' : 'null'
  }
}

function applyNativeBackdrop(targetWin, mode) {
  if (!targetWin || targetWin.isDestroyed()) return { ok: false, mode: 'none' }
  const next = String(mode || 'acrylic')
  const isWin = process.platform === 'win32'
  const isMac = process.platform === 'darwin'
  if (isWin && typeof targetWin.setBackgroundMaterial === 'function') {
    const allowed = new Set(['acrylic', 'mica', 'tabbed', 'none'])
    const safe = allowed.has(next) ? next : 'acrylic'
    try {
      targetWin.setBackgroundMaterial(safe)
      currentBackdrop = safe
      return { ok: true, mode: safe }
    } catch (e) {
      currentBackdrop = 'none'
      return { ok: false, mode: 'none' }
    }
  }
  if (isMac && typeof targetWin.setVibrancy === 'function') {
    try {
      const vib = next === 'none' ? null : 'under-window'
      targetWin.setVibrancy(vib)
      currentBackdrop = vib || 'none'
      return { ok: true, mode: next === 'none' ? 'none' : 'acrylic' }
    } catch (e) {
      currentBackdrop = 'none'
      return { ok: false, mode: 'none' }
    }
  }
  currentBackdrop = 'none'
  return { ok: false, mode: 'none' }
}

async function boot() {
  const __t0 = Date.now()
  const __mark = n => { if (process.env.HARBOR_PERF_MARKS === '1') console.log('[perf] ' + n + ' +' + (Date.now() - __t0) + 'ms') }
  __mark('boot:start')
  injectEnv()

  if (HEADLESS) app.setPath('userData', path.join(process.env.HARBOR_CONFIG_DIR, 'electron-profile'))
  if (SMOKE) app.setPath('userData', path.join(process.env.HARBOR_CONFIG_DIR, 'electron-smoke-profile'))

  try {
    console.log('[harbor] safeStorage.isEncryptionAvailable =', safeStorage.isEncryptionAvailable())
    const { activeCodecPath } = await import(
      pathToFileURL(path.join(ROOT, 'server', 'src', 'services', 'dpapi.js')).href)
    console.log('[harbor] dpapi codec path =', activeCodecPath())
  } catch (error) {
    console.log('[harbor] safeStorage probe failed:', error && error.message)
  }

  const appModule = await import(pathToFileURL(path.join(ROOT, 'server', 'src', 'app.js')).href)
  serverApp = await appModule.buildServer()
  const base = await serverApp.listen({
    host: process.env.HOST,
    port: Number(process.env.PORT),
  })
  const port = serverApp.server.address().port
  console.log('[harbor] server listening:', base, '(methods 面 /health)')

  if (!HEADLESS) {
    const host = await import(pathToFileURL(path.join(ROOT, 'server', 'src', 'host.js')).href)
    host.setHostDialogProvider({ adminMessageBox: adminMessageBoxProvider })
    host.setHostRedrawProvider({
      redraw: () => {
        try {
          if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false
          win.webContents.invalidate()
          return true
        } catch (e) { return false }
      },
    })
  }

  const db = await importDb()
  await db.ensureSchema(db.prisma)
  console.log('[harbor] db schema ready:', db.currentDbPath())

  ;(async () => {
    const { bootstrapLegacyImport } = await import(
      pathToFileURL(path.join(ROOT, 'server', 'src', 'services', 'session-migrate.js')).href)
    const { migratePlaintextSecrets } = await import(
      pathToFileURL(path.join(ROOT, 'server', 'src', 'services', 'dpapi-migrate.js')).href)
    const migrated = await bootstrapLegacyImport()
    if (migrated.error) console.error('[harbor] legacy sessions 迁移失败:', migrated.error)
    const secrets = await migratePlaintextSecrets()
    if (secrets.error) console.warn('[harbor] 存量明文密钥迁移延后:', secrets.error)
  })().catch(error => {
    console.error('[harbor] 存储迁移后台任务异常:', error && error.message)
  })

  if (HEADLESS) {
    console.log('[harbor] HARBOR_HEADLESS=1 → server-only ready:', base)
    return
  }

  process.env.HARBOR_API_BASE = `http://127.0.0.1:${port}`

  // 受控 IPC：设置页运行期切换真窗外材质（acrylic / mica / tabbed / none）
  ipcMain.removeHandler('harbor:set-backdrop')
  ipcMain.handle('harbor:set-backdrop', (_e, mode) => applyNativeBackdrop(win, mode))
  ipcMain.removeHandler('harbor:get-backdrop')
  ipcMain.handle('harbor:get-backdrop', () => ({ ok: currentBackdrop !== 'none', mode: currentBackdrop, platform: process.platform }))

  if (USE_CUSTOM_PROTOCOL) {
    protocol.handle(HARBOR_SCHEME, async (request) => {
      try {
        const u = new URL(request.url)
        if (u.hostname !== 'app') return new Response('not found', { status: 404 })
        const rel = decodeURIComponent(u.pathname.replace(/^\/+/, '')) || 'index.html'
        let abs = null
        if (DIST_FILES.has(rel)) abs = path.join(APP_DIST, rel)
        else if (LIB_FILES.has(rel) || ASSET_FILES.has(rel)) abs = path.join(ROOT, rel)
        if (!abs) return new Response('not found', { status: 404 })
        const body = await fs.promises.readFile(abs)
        const type = MIME[path.extname(rel)] || 'application/octet-stream'
        return new Response(body, { headers: { 'Content-Type': type } })
      } catch (error) {
        console.error('[harbor] protocol.handle 失败:', error && error.message)
        return new Response('error', { status: 500 })
      }
    })
  }

  const isWin = process.platform === 'win32'
  const isMac = process.platform === 'darwin'
  if (isMac) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]))
  } else {
    Menu.setApplicationMenu(null)
  }
  const iconFile = path.join(ROOT, 'assets', 'harbor.ico')
  // 铁律 LAW-11：Windows 下只用 backgroundColor:'#00000000' + backgroundMaterial:'acrylic'，绝不混写 transparent:true
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 920,
    minHeight: 620,
    show: !SMOKE,
    autoHideMenuBar: true,
    ...(fs.existsSync(iconFile) ? { icon: iconFile } : {}),
    backgroundColor: '#00000000',
    ...(isWin ? { backgroundMaterial: 'acrylic' } : {}),
    ...(isMac ? { vibrancy: 'under-window', visualEffectState: 'followWindow', titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  try {
    const LOOPBACK_RESPONSE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//i
    win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      try {
        if (!LOOPBACK_RESPONSE.test(String(details.url || ''))) {
          callback({ responseHeaders: details.responseHeaders })
          return
        }
        const original = details.responseHeaders || {}
        if (Object.keys(original).some(k => k.toLowerCase() === 'access-control-allow-origin')) {
          callback({ responseHeaders: details.responseHeaders })
          return
        }
        const headers = Object.assign({}, original)
        headers['Access-Control-Allow-Origin'] = ['*']
        callback({ responseHeaders: headers })
      } catch (e) { callback({ responseHeaders: details.responseHeaders }) }
    })
  } catch (e) {}

  const PAGE_ORIGIN_OK = USE_CUSTOM_PROTOCOL
    ? (u => String(u || '').startsWith(HARBOR_SCHEME + '://app/'))
    : (u => String(u || '').startsWith('file://'))
  win.webContents.on('will-navigate', (event, url) => {
    if (!PAGE_ORIGIN_OK(url)) event.preventDefault()
  })
  win.on('closed', () => {
    win = null
    gracefulShutdown()
  })

  if (USE_CUSTOM_PROTOCOL) {
    await win.loadURL(`${HARBOR_SCHEME}://app/index.html`)
  } else {
    await win.loadFile(path.join(APP_DIST, 'index.html'))
  }
  __mark('window-loaded')
  console.log('[harbor] React 19 window loaded; bridge base =', process.env.HARBOR_API_BASE, '| backdrop =', currentBackdrop)

  if (SMOKE) {
    const actual = win.webContents.getURL()
    console.log('[harbor] smoke: url =', actual)
    gracefulShutdown()
  }
}

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
  } catch (error) {}
  return id.length > 12 ? id.slice(0, 8) + '…' + id.slice(-4) : id
}

async function showAdminMessageBoxOnce(requestId, req) {
  const cmdText = String((req && req.cmd) || '')
  const label = await adminSessionLabel(req && req.sid)
  const opts = {
    type: 'warning',
    buttons: ['允许执行', '拒绝'],
    defaultId: 1,
    cancelId: 1,
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
    return { allow: response === 0, requestId }
  } catch (error) {
    return { allow: false, requestId }
  }
}

function adminMessageBoxProvider(req) {
  const requestId = ++adminDialogSeq
  const run = adminDialogTail.then(() => showAdminMessageBoxOnce(requestId, req))
  adminDialogTail = run.then(() => {}, () => {})
  return run
}

async function gracefulShutdown() {
  if (shuttingDown) return
  shuttingDown = true
  try { if (serverApp) await serverApp.close() } catch (error) { console.error('[harbor] server close error:', error && error.message) }
  try { const db = await importDb(); await db.disconnectDb() } catch (error) { console.error('[harbor] db disconnect error:', error && error.message) }
  app.quit()
}

const MODEL_PROXY_BYPASS = process.env.HARBOR_PROXY_BYPASS !== undefined
  ? process.env.HARBOR_PROXY_BYPASS
  : '*.bigmodel.cn;*.deepseek.com;*.moonshot.cn;*.aliyuncs.com;models.github.ai;127.0.0.1;localhost;::1'
if (MODEL_PROXY_BYPASS) app.commandLine.appendSwitch('proxy-bypass-list', MODEL_PROXY_BYPASS)

const gotLock = HEADLESS || app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  if (HEADLESS) {
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
