#!/usr/bin/env node
/**
 * Harbor Setup 打包前全检门禁（R21）：
 * 检查生产前端构建产物、图标、现代化 NSIS 安装器素材、内置专家目录与 server 依赖完整性，
 * 确保 `npm run dist:win` 一次打出干净可用的 Windows Setup 安装包。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REQUIRED_FILES = [
  'electron/main.js',
  'electron/preload.js',
  'electron-builder.yml',
  'electron/build-resources/installerSidebar.bmp',
  'electron/build-resources/uninstallerSidebar.bmp',
  'electron/build-resources/installerHeader.bmp',
  'electron/build-resources/installer.nsh',
  'assets/harbor.ico',
  'frontend/app/dist/index.html',
  'frontend/app/dist/app.js',
  'frontend/app/dist/app.css',
  'server/package.json',
  'server/src/app.js',
  'server/src/services/local-proxy.js',
  'VERSION',
]

const missing = REQUIRED_FILES.filter((rel) => !fs.existsSync(path.join(ROOT, rel)))
const expertsDir = path.join(ROOT, 'backend', 'experts_builtin')
const expertCount = fs.existsSync(expertsDir)
  ? fs.readdirSync(expertsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).length
  : 0

if (missing.length > 0) {
  console.error('[DIST-CHECK] FAIL — 缺少以下打包必需文件：')
  for (const m of missing) console.error('  -', m)
  process.exit(1)
}
if (expertCount < 18) {
  console.error(`[DIST-CHECK] FAIL — 内置专家包数量不足（当前 ${expertCount}，期望 >= 18）`)
  process.exit(1)
}

const appJsSize = fs.statSync(path.join(ROOT, 'frontend/app/dist/app.js')).size
const appCssSize = fs.statSync(path.join(ROOT, 'frontend/app/dist/app.css')).size
console.log(
  `[DIST-CHECK] PASS — 全部 ${REQUIRED_FILES.length} 项安装器与运行时资产齐备 | 内置专家 ${expertCount} 套 | app.js=${appJsSize}B | app.css=${appCssSize}B`
)
