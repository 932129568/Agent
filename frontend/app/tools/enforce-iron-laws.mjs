#!/usr/bin/env node
/**
 * Harbor React 19 全量架构 · 十二条铁律自动化门禁 v2（零外部依赖，Node 20+ / 27 ESM）
 *
 * 口径更新（v2）：
 *  - 透色口径：启用 Electron 原生实时窗外透色（Win11 backgroundMaterial: 'acrylic'/'mica' +
 *    backgroundColor: '#00000000'；macOS vibrancy: 'under-window'），彻底禁止旧的假壁纸
 *    截图方案（wallpaper.js / HARBOR_WP / --wp-url / #lw-ambient-wallpaper）。
 *  - 动效口径：允许并鼓励基于 React 状态机 + Canvas/SVG + WAAPI/解析弹簧的四幕编排动效，
 *    但严禁旧式 2015 三红点(.typing-dots)、整框旋转斜红线(cmFlow)、transition:all 与散落裸时长。
 *
 * 用法：
 *   node frontend/app/tools/enforce-iron-laws.mjs            # 扫描 frontend/app/src + electron
 *   node frontend/app/tools/enforce-iron-laws.mjs --strict   # 收口严格模式：禁止仓库残存旧遗产
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(HERE, '..')
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..')
const SRC_ROOT = path.join(APP_ROOT, 'src')
const STRICT = process.argv.includes('--strict')

const violations = []
function fail(law, file, line, detail) {
  const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/')
  violations.push({ law, rel, line, detail })
}

function walk(dir, exts) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name.startsWith('.')) continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walk(full, exts))
    else if (exts.some(e => ent.name.endsWith(e))) out.push(full)
  }
  return out.sort()
}

function stripCommentsPreserveLines(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (_, p) => p)
}

function lineNoAt(src, index) {
  let n = 1
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) n++
  return n
}

function scanRegex(law, file, cleanSrc, re, hint) {
  re.lastIndex = 0
  let m
  while ((m = re.exec(cleanSrc)) !== null) {
    fail(law, file, lineNoAt(cleanSrc, m.index), `${hint}: ${m[0].trim().slice(0, 80)}`)
  }
}

const jsFiles = walk(SRC_ROOT, ['.js', '.jsx', '.ts', '.tsx', '.mjs'])
const cssFiles = walk(SRC_ROOT, ['.css'])

for (const file of jsFiles) {
  const rel = path.relative(SRC_ROOT, file).replace(/\\/g, '/')
  const raw = fs.readFileSync(file, 'utf8')
  const clean = stripCommentsPreserveLines(raw)
  const isPlatform = rel.startsWith('platform/')
  const isServices = rel.startsWith('services/')
  const isTest = /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)
  if (isTest) continue

  // LAW-01：React 是唯一 DOM 所有者（仅 platform/dom.js、platform/theme.js、main.jsx 白名单豁免）
  if (rel !== 'platform/dom.js' && rel !== 'platform/theme.js' && rel !== 'main.jsx') {
    scanRegex('LAW-01', file, clean,
      /\bdocument\.(?:getElementById|querySelector|querySelectorAll|createElement)\b|\.(?:innerHTML|outerHTML|insertAdjacentHTML|appendChild)\b|\.style\.cssText\b/g,
      '禁止在 React 组件/业务层使用命令式 DOM API（请用 React state / useRef + JSX）')
  }

  // LAW-02：禁止全局业务符号污染、内联事件桥与动态求值
  if (rel !== 'main.jsx' && !isPlatform) {
    scanRegex('LAW-02', file, clean,
      /\b(?:window|globalThis)\.[A-Za-z_$][\w$]*\s*=[^=]|\bdata-h-events\b|\bnew\s+Function\b|\beval\s*\(/g,
      '禁止挂载业务全局符号 / data-h-events / eval')
  }

  // LAW-03：网络与宿主桥单一出口
  if (!isServices && !isPlatform) {
    scanRegex('LAW-03', file, clean,
      /\bfetch\s*\(|\bcallApi\s*\(|\bHARBOR_API_BASE\b|\bHarborBridge\b|\bwindow\.pywebview\b/g,
      '禁止 UI/State 层直接 fetch 或 callApi（必须经 services/ 出口）')
  }

  // LAW-04：富文本唯一净化通道
  if (rel !== 'ui/MarkdownView.jsx' && rel !== 'ui/MarkdownView.tsx') {
    scanRegex('LAW-04', file, clean, /\bdangerouslySetInnerHTML\b/g,
      '禁止绕过 ui/MarkdownView 裸用 dangerouslySetInnerHTML')
  }

  // LAW-05：统一图层栈（禁止 popover="manual" / showPopover() 破坏层级压字）
  scanRegex('LAW-05', file, clean,
    /\bshowPopover\s*\(|\bhidePopover\s*\(|popover\s*=\s*["']manual["']/g,
    '禁止使用 popover="manual" / showPopover() 破坏图层栈（统一走 OverlayRoot）')

  // LAW-06：禁止假壁纸 JPEG 拷贝方案（必须走 Electron 原生实时窗外透色 backgroundMaterial / vibrancy）
  scanRegex('LAW-06', file, clean,
    /\bHARBOR_WP\b|harbor:wp|lw-ambient-wallpaper|attachWallpaperToWindow/g,
    '禁止引入静态桌面壁纸假透色方案（请使用 Electron 原生实时窗外透色 backgroundMaterial / vibrancy）')

  // LAW-07：严格单向依赖与零跨 Feature 直连
  const imports = [...clean.matchAll(/import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g)]
  for (const im of imports) {
    const spec = im[1]
    if (spec.includes('frontend/src/') || spec.includes('../../src/')) {
      fail('LAW-07', file, lineNoAt(clean, im.index), `禁止导入 legacy 模块: ${spec}`)
    }
    if (rel.startsWith('ui/') && /\/(features|state|services|app)\//.test(spec)) {
      fail('LAW-07', file, lineNoAt(clean, im.index), `ui/ 基础组件不得反向依赖上层: ${spec}`)
    }
    if (rel.startsWith('state/') && /\/(features|ui|layout|app)\//.test(spec)) {
      fail('LAW-07', file, lineNoAt(clean, im.index), `state/ 不得反向依赖 UI 层: ${spec}`)
    }
    if (rel.startsWith('services/') && /\/(features|ui|layout|state|app)\//.test(spec)) {
      fail('LAW-07', file, lineNoAt(clean, im.index), `services/ 不得反向依赖 UI/State 层: ${spec}`)
    }
    if (rel.startsWith('features/')) {
      const myDomain = rel.split('/')[1]
      const mFeat = spec.match(/features\/([^/]+)\//)
      if (mFeat && mFeat[1] !== myDomain) {
        fail('LAW-07', file, lineNoAt(clean, im.index), `禁止 features/${myDomain} 跨特征直连 features/${mFeat[1]}`)
      }
    }
  }
}

for (const file of cssFiles) {
  const rel = path.relative(SRC_ROOT, file).replace(/\\/g, '/')
  const raw = fs.readFileSync(file, 'utf8')
  const clean = stripCommentsPreserveLines(raw)
  const isTokens = rel.endsWith('tokens.css') || rel.endsWith('layers.css')

  // LAW-08：CSS 零 !important（仅 motion.css 的 fx-off 降级块豁免）
  if (!rel.endsWith('motion.css')) {
    scanRegex('LAW-08', file, clean, /!important\b/g, '禁止使用 !important（靠 @layer 与 CSS Modules 解决层叠）')
  }

  // LAW-09：严禁散落手写数字 z-index（必须使用 var(--z-*) 令牌）
  if (!isTokens) {
    scanRegex('LAW-09', file, clean, /\bz-index\s*:\s*-?\d+/g,
      '禁止手写裸数字 z-index（必须使用 var(--z-base / --z-dock / --z-modal / --z-toast)）')
  }

  // LAW-10：动效契约——禁 transition: all、禁组件内裸时长
  scanRegex('LAW-10', file, clean, /\btransition(?:-property)?\s*:\s*[^;}]*\ball\b/g,
    '禁止 transition: all（必须显式声明 transform / opacity / clip-path / border-color 等属性）')
  if (!isTokens && !rel.endsWith('motion.css')) {
    scanRegex('LAW-10', file, clean,
      /\b(?:animation|transition)(?:-duration)?\s*:\s*[^;}]*\b\d+(?:\.\d+)?(?:ms|s)\b/g,
      '禁止裸时长（必须使用 var(--dur-*) 令牌）')
  }

  // LAW-06（CSS 侧）：禁假壁纸变量与已淘汰丑效类名
  scanRegex('LAW-06', file, clean,
    /--wp-url\b|#lw-ambient-wallpaper\b|\bcmFlow\b|\.typing-dots\b/g,
    '禁止遗留静态壁纸假透色变量或已淘汰动效类名')
}

// LAW-11：Electron 宿主层校验——禁止假壁纸镜像，且 Windows 下禁止 transparent:true 与 backgroundMaterial 混用冲突
const elecMain = path.join(REPO_ROOT, 'electron', 'main.js')
if (fs.existsSync(elecMain)) {
  const cleanMain = stripCommentsPreserveLines(fs.readFileSync(elecMain, 'utf8'))
  if (/\battachWallpaperToWindow\s*\(/.test(cleanMain)) {
    fail('LAW-11', elecMain, 1, 'electron/main.js 仍残留假桌面壁纸镜像 attachWallpaperToWindow()，请改用原生 backgroundMaterial')
  }
  if (/backgroundMaterial\s*:/.test(cleanMain) && /transparent\s*:\s*true/.test(cleanMain)) {
    fail('LAW-11', elecMain, 1, 'Windows Electron 中 transparent:true 与 backgroundMaterial 冲突会导致原生亚克力失效，请只用 backgroundColor:"#00000000" + backgroundMaterial')
  }
}

// LAW-12（收口严格模式）：全量切换完成后，禁止仓库残存旧遗产
if (STRICT) {
  for (const legacyPath of [
    'frontend/src', 'frontend/react/src', 'frontend/react/dist', 'frontend/styles/legacy.css',
    'frontend/skin/lightwellShell.js', 'electron/wallpaper.js',
  ]) {
    if (fs.existsSync(path.join(REPO_ROOT, legacyPath))) {
      fail('LAW-12', path.join(REPO_ROOT, legacyPath), 0, `严格模式下禁止保留旧架构遗产: ${legacyPath}`)
    }
  }
}

if (violations.length) {
  console.error(`[IRON-LAWS] FAIL — 发现 ${violations.length} 条铁律违例：`)
  for (const v of violations) {
    console.error(`  [${v.law}] ${v.rel}:${v.line} -> ${v.detail}`)
  }
  process.exit(1)
}
console.log(`[IRON-LAWS] PASS — 已扫描 ${jsFiles.length} 个脚本 + ${cssFiles.length} 份样式表，0 违例${STRICT ? '（strict 模式）' : ''}`)
