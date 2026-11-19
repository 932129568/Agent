#!/usr/bin/env node
/**
 * R67 · 全量 React 化构建工具：模板静态 DOM → JSX 组件树。
 *
 * 输入：frontend/index.template.html 的 body（优先取 <template id="harbor-legacy-fallback">
 *       内的契约文本；改造前则取 body 内 <script> 之前的全部内容）。
 * 输出：frontend/react/src/generated/{Area}.jsx + App.jsx + ids.json。
 *
 * 设计要点（决定功能等价性，勿随意简化）：
 *  1. 内联 on* 事件不转 React 合成事件，而是编码进 data-h-events，由运行时
 *     以「元素属性式」绑定（el.onclick = fn），从而保留 this / event / return false
 *     语义，并允许 legacy 后续覆盖该属性（与浏览器内联 onclick 完全一致）。
 *  2. 原样保留全部 id / class / aria / data 属性，legacy 的 453 处 getElementById
 *     与 331 处 querySelector 继续命中 React 生成的真实 DOM。
 *  3. value/checked/selected 转非受控 defaultValue/defaultChecked，避免 React
 *     把 legacy 直接写 DOM 的输入框变成只读受控组件。
 *  4. 组件树是纯静态树（无 state），首屏 flushSync 渲染一次后不再重渲染，
 *     因此 legacy 的 innerHTML / appendChild / classList 写入不会被 React 覆盖。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const TEMPLATE = join(ROOT, 'frontend/index.template.html')
const OUT_DIR = join(ROOT, 'frontend/react/src/generated')

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'])
const EVENT_RE = /^on[a-z]+$/
const ATTR_MAP = {
  class: 'className', for: 'htmlFor', tabindex: 'tabIndex', readonly: 'readOnly',
  maxlength: 'maxLength', minlength: 'minLength', autocomplete: 'autoComplete',
  spellcheck: 'spellCheck', contenteditable: 'contentEditable',
  colspan: 'colSpan', rowspan: 'rowSpan', enctype: 'encType',
  'stroke-width': 'strokeWidth', 'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin', 'stroke-dasharray': 'strokeDasharray',
  'stroke-dashoffset': 'strokeDashoffset', 'stroke-miterlimit': 'strokeMiterlimit',
  'fill-rule': 'fillRule', 'clip-rule': 'clipRule', 'clip-path': 'clipPath',
  'stop-color': 'stopColor', 'stop-opacity': 'stopOpacity',
  'font-size': 'fontSize', 'font-family': 'fontFamily', 'font-weight': 'fontWeight',
  'text-anchor': 'textAnchor', 'xlink:href': 'xlinkHref',
  'accept-charset': 'acceptCharset', 'http-equiv': 'httpEquiv',
}
const BOOL_ATTRS = new Set(['hidden', 'disabled', 'multiple', 'readonly', 'checked',
  'selected', 'autofocus', 'required', 'novalidate', 'ismap', 'reversed'])

/** 顶层 10 个区域 → 组件名。顺序与模板 body 顶层节点严格对应。 */
const AREAS = ['IconDefs', 'AuroraBg', 'StreamBar', 'Rail', 'Sidebar',
  'SidebarBackdrop', 'MainShell', 'ProjectModal', 'ExpertCenter', 'HubMarket']

function findTagEnd(src, start) {
  let quote = null
  for (let j = start + 1; j < src.length; j++) {
    const c = src[j]
    if (quote) { if (c === quote) quote = null; continue }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '>') return j
  }
  return -1
}

function parseAttributes(raw) {
  const attrs = []
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
  let m
  while ((m = re.exec(raw))) {
    const name = m[1]
    if (!name || name === '/') continue
    const value = m[2] !== undefined ? m[2]
      : m[3] !== undefined ? m[3]
        : m[4] !== undefined ? m[4] : null
    attrs.push({ name, value })
  }
  return attrs
}

function parseNodes(src) {
  const root = { children: [] }
  const stack = [root]
  let i = 0
  while (i < src.length) {
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4)
      const stop = end < 0 ? src.length : end
      stack[stack.length - 1].children.push({ type: 'comment', text: src.slice(i + 4, stop) })
      i = end < 0 ? src.length : end + 3
      continue
    }
    if (src[i] === '<' && /^<\/?[A-Za-z!]/.test(src.slice(i, i + 3))) {
      const close = findTagEnd(src, i)
      if (close < 0) break
      const raw = src.slice(i, close + 1)
      if (raw.startsWith('</')) { if (stack.length > 1) stack.pop(); i = close + 1; continue }
      const tagMatch = /^<\s*([A-Za-z][\w:-]*)/.exec(raw)
      if (!tagMatch) {
        stack[stack.length - 1].children.push({ type: 'text', text: raw })
        i = close + 1
        continue
      }
      const tag = tagMatch[1]
      const selfClose = raw.endsWith('/>') || VOID.has(tag.toLowerCase())
      const attrEnd = selfClose && raw.endsWith('/>') ? -2 : -1
      const node = {
        type: 'element', tag,
        attrs: parseAttributes(raw.slice(tagMatch[0].length, attrEnd)),
        children: [],
      }
      stack[stack.length - 1].children.push(node)
      if (!selfClose) stack.push(node)
      i = close + 1
      continue
    }
    const next = src.indexOf('<', i)
    const end = next < 0 ? src.length : next
    const text = src.slice(i, end)
    if (text) stack[stack.length - 1].children.push({ type: 'text', text })
    i = end
  }
  return root.children
}

function cssToObject(text) {
  const entries = []
  for (const part of String(text).split(';')) {
    const at = part.indexOf(':')
    if (at < 0) continue
    const rawKey = part.slice(0, at).trim()
    const value = part.slice(at + 1).trim()
    if (!rawKey || !value) continue
    const key = rawKey.startsWith('--') ? JSON.stringify(rawKey)
      : rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    entries.push((key.startsWith('"') ? '[' + key + ']' : key) + ': ' + JSON.stringify(value))
  }
  return '{' + entries.join(', ') + '}'
}

function selectedDefault(node) {
  for (const child of node.children || []) {
    if (child.type !== 'element') continue
    if (child.tag === 'option') {
      const sel = child.attrs.find(a => a.name.toLowerCase() === 'selected')
      if (sel) {
        const val = child.attrs.find(a => a.name.toLowerCase() === 'value')
        if (val) return val.value
      }
    }
    const nested = selectedDefault(child)
    if (nested !== null) return nested
  }
  return null
}

function jsxText(text) {
  return text.replace(/[{<>]/g, ch => ({ '{': "{'{'}", '}': "{'}'}", '<': "{'<'}", '>': "{'>'}" }[ch] || ch))
}

function renderAttrs(node) {
  const events = []
  const out = []
  const tag = node.tag.toLowerCase()
  for (const { name, value } of node.attrs) {
    const lower = name.toLowerCase()
    if (EVENT_RE.test(lower) && value !== null) {
      events.push({ type: lower.slice(2), code: value })
      continue
    }
    if (lower === 'style') { out.push('style={' + cssToObject(value || '') + '}'); continue }
    if (lower === 'value' && (tag === 'input' || tag === 'textarea')) {
      out.push('defaultValue=' + JSON.stringify(value || '')); continue
    }
    if (lower === 'checked' && tag === 'input') { out.push('defaultChecked={true}'); continue }
    if (lower === 'selected' && tag === 'option') continue
    if (lower === 'readonly') { out.push('readOnly={true}'); continue }
    if (BOOL_ATTRS.has(lower) && value === null) { out.push(ATTR_MAP[lower] || lower + '={true}'); continue }
    const mapped = ATTR_MAP[lower] || name
    out.push(mapped + '=' + JSON.stringify(value === null ? '' : value))
  }
  if (tag === 'select') {
    const def = selectedDefault(node)
    if (def !== null) out.push('defaultValue=' + JSON.stringify(def))
  }
  if (events.length) out.push('data-h-events={' + JSON.stringify(JSON.stringify(events)) + '}')
  return out.length ? ' ' + out.join(' ') : ''
}

function collectIds(node, into) {
  if (node.type !== 'element') return
  for (const a of node.attrs) if (a.name.toLowerCase() === 'id') into.push(a.value)
  for (const c of node.children || []) collectIds(c, into)
}

function renderNode(node, indent) {
  const pad = ' '.repeat(indent)
  if (node.type === 'comment') {
    const safe = node.text.replace(/\*\//g, '* /')
    return pad + '{/*' + safe + '*/}'
  }
  if (node.type === 'text') {
    if (!node.text.trim()) return ''
    return pad + jsxText(node.text)
  }
  const attrs = renderAttrs(node)
  const tag = node.tag
  if (!node.children || !node.children.length) {
    return pad + '<' + tag + attrs + ' />'
  }
  const kids = node.children.map(c => renderNode(c, indent + 2)).filter(Boolean)
  if (!kids.length) return pad + '<' + tag + attrs + ' />'
  return pad + '<' + tag + attrs + '>\n' + kids.join('\n') + '\n' + pad + '</' + tag + '>'
}

function main() {
  const html = readFileSync(TEMPLATE, 'utf8')
  const bodyStart = html.indexOf('<body>')
  if (bodyStart < 0) throw new Error('模板缺少 <body>')
  const fallbackOpen = '<template id="harbor-legacy-fallback">'
  const fallbackAt = html.indexOf(fallbackOpen, bodyStart)
  let markup
  if (fallbackAt >= 0) {
    const from = fallbackAt + fallbackOpen.length
    const to = html.indexOf('</template>', from)
    if (to < 0) throw new Error('契约 fallback 模板未闭合')
    markup = html.slice(from, to)
  } else {
    const from = bodyStart + '<body>'.length
    const scriptAt = html.indexOf('<script>', from)
    markup = html.slice(from, scriptAt < 0 ? html.length : scriptAt)
  }
  const nodes = parseNodes(markup)
  const top = nodes.filter(n => n.type === 'element')
  if (top.length !== AREAS.length) {
    throw new Error('顶层区域数变化：期望 ' + AREAS.length + '，实际 ' + top.length +
      '。请同步更新 html-to-jsx.mjs 的 AREAS 映射')
  }
  mkdirSync(OUT_DIR, { recursive: true })
  const banner = '/* AUTO-GENERATED by frontend/react/tools/html-to-jsx.mjs — 请勿手改。\n' +
    ' * 源：frontend/index.template.html#harbor-legacy-fallback\n' +
    ' * 重新生成：node frontend/react/tools/html-to-jsx.mjs\n' +
    ' * 说明：本组件只负责 DOM 结构；交互经 data-h-events 由 legacy 服务层接管，\n' +
    ' *       后续逐域把逻辑搬进 React 后再删对应 data-h-events。 */\n'
  const idsByArea = {}
  AREAS.forEach((name, index) => {
    const ids = []
    collectIds(top[index], ids)
    idsByArea[name] = ids.sort()
    const code = banner + '\nexport default function ' + name + '() {\n  return (\n' +
      renderNode(top[index], 4) + '\n  )\n}\n'
    writeFileSync(join(OUT_DIR, name + '.jsx'), code, 'utf8')
  })
  const imports = AREAS.map(n => "import " + n + " from './" + n + ".jsx'").join('\n')
  const app = banner + '\n' + imports + '\n\n/** 全量 UI 外壳：所有用户可见 DOM 均由 React 生成。 */\n' +
    'export default function App() {\n  return (\n    <>\n' +
    AREAS.map(n => '      <' + n + ' />').join('\n') +
    '\n    </>\n  )\n}\n'
  writeFileSync(join(OUT_DIR, 'App.jsx'), app, 'utf8')
  const allIds = Object.values(idsByArea).flat()
  writeFileSync(join(OUT_DIR, 'ids.json'), JSON.stringify({
    source: 'frontend/index.template.html#harbor-legacy-fallback',
    areas: AREAS,
    idsByArea,
    idCount: allIds.length,
    ids: allIds.sort(),
  }, null, 2) + '\n', 'utf8')
  console.log('[html-to-jsx] %d 个区域组件, %d 个 id -> %s', AREAS.length, allIds.length, OUT_DIR)
}

main()
