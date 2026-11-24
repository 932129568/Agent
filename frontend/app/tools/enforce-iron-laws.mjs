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
      if (/services\/bridge\.js/.test(spec)) {
        fail('LAW-14', file, lineNoAt(clean, im.index), `禁止 features/${myDomain} 绕过 state/ 切片直连 services/bridge.js`)
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

// LAW-13（R14 静态 TDZ 防线）：扫描函数体顶层顺序求值的 const/let 声明，
// 若同一块作用域的同步初始化表达式中在声明行之前就引用了该变量，立即报错（把 R13 级白屏拦截在构建前）。
function stripStringsAndTemplates(src) {
  return src
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, (m) => m.replace(/[^\n]/g, ' '))
}

function checkBlockTdz(filePath, cleanSrc) {
  const noStr = stripStringsAndTemplates(cleanSrc)
  const lines = noStr.split('\n')
  // 匹配顶层函数/组件体起始：`export default function Foo(...) {` 或 `function Foo(...) {`
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.test(lines[i])) continue
    // 找到函数体的开大括号
    let braceLine = i
    let openCol = lines[i].indexOf('{')
    while (openCol < 0 && braceLine + 1 < Math.min(lines.length, i + 15)) {
      braceLine++
      openCol = lines[braceLine].indexOf('{')
    }
    if (openCol < 0) continue

    // 提取函数体 depth===1（即函数体直接顶层，不含内部回调/子函数）的语句行
    let depth = 0
    const topLines = []
    for (let ln = braceLine; ln < lines.length; ln++) {
      const s = lines[ln]
      let topChars = ''
      for (let c = (ln === braceLine ? openCol : 0); c < s.length; c++) {
        const ch = s[c]
        if (ch === '{') {
          depth++
          if (depth === 1) continue
        } else if (ch === '}') {
          depth--
          if (depth === 0) break
        }
        if (depth === 1) topChars += ch
      }
      if (topChars.trim()) topLines.push({ lineNo: ln + 1, text: topChars })
      if (depth === 0) break
    }

    // 收集函数体直接顶层 const/let 简单变量声明及其声明行号（跳过箭头函数回调行）
    const decls = []
    for (const item of topLines) {
      const m = /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/.exec(item.text)
      if (m) decls.push({ name: m[1], lineNo: item.lineNo })
    }
    if (decls.length < 2) continue

    for (const d of decls) {
      const idRe = new RegExp(`(?<![.\\w$])${d.name}(?![\\w$])`)
      const keyRe = new RegExp(`(?<![.\\w$])${d.name}\\s*:`, 'g')
      for (const item of topLines) {
        if (item.lineNo >= d.lineNo) break
        // 跳过函数/回调定义行（如 `const handler = (...) => ...` 或 `useEffect(() => ...)`），因为回调不在此刻同步求值
        if (/=>|\bfunction\b|\buseEffect\s*\(|\buseLayoutEffect\s*\(|\buseCallback\s*\(|\breturn\s*\(/.test(item.text)) continue
        // 忽略对象字面量键 `foo:`
        const scrubbed = item.text.replace(keyRe, '')
        if (idRe.test(scrubbed)) {
          fail('LAW-13', filePath, item.lineNo, `疑似 TDZ（先引用后声明）：变量 "${d.name}" 在第 ${item.lineNo} 行同步求值，但直到第 ${d.lineNo} 行才用 const/let 声明`)
        }
      }
    }
  }
}

for (const f of jsFiles) {
  checkBlockTdz(f, stripCommentsPreserveLines(fs.readFileSync(f, 'utf8')))
}

// LAW-12（收口严格模式）：全量切换完成后，禁止仓库残存旧遗产与未被 main.jsx 引用的死文件
if (STRICT) {
  for (const legacyPath of [
    'frontend/src', 'frontend/react/src', 'frontend/react/dist', 'frontend/styles/legacy.css',
    'frontend/skin/lightwellShell.js', 'electron/wallpaper.js', 'harbor.html',
    'frontend/app/src/features/_template', 'frontend/app/src/state/actions',
    'frontend/app/src/state/createStore.js', 'frontend/app/src/ui/DossierTokens.js',
  ]) {
    if (fs.existsSync(path.join(REPO_ROOT, legacyPath))) {
      fail('LAW-12', path.join(REPO_ROOT, legacyPath), 0, `严格模式下禁止保留旧架构遗产或 R67 孤儿文件: ${legacyPath}（请运行 cleanup-legacy.mjs --execute）`)
    }
  }
  const entryFile = path.join(SRC_ROOT, 'main.jsx')
  if (fs.existsSync(entryFile)) {
    const visited = new Set()
    const q = [entryFile]
    while (q.length) {
      const cur = q.shift()
      if (visited.has(cur) || !fs.existsSync(cur)) continue
      visited.add(cur)
      if (!/\.(?:js|jsx|mjs)$/.test(cur)) continue
      const txt = stripCommentsPreserveLines(fs.readFileSync(cur, 'utf8'))
      const re = /(?:from|import)\s+['"](\.[^'"]+)['"]/g
      let m
      while ((m = re.exec(txt)) !== null) {
        const tgt = path.resolve(path.dirname(cur), m[1])
        if (!visited.has(tgt) && fs.existsSync(tgt)) q.push(tgt)
      }
    }
    for (const f of [...jsFiles, ...cssFiles]) {
      if (!visited.has(f)) {
        fail('LAW-12', f, 0, '死文件/孤儿模块未被 main.jsx 引用（请运行 cleanup-legacy.mjs --execute 清理）')
      }
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
