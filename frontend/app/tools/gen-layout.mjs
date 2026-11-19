#!/usr/bin/env node
/**
 * B0 · 真实结构迁移脚手架（可复跑、幂等）。
 *
 * 把 R67 的 frontend/react/src/generated/<Area>.jsx **真实区域结构**投影进
 * frontend/app/src/layout/<Area>.jsx，完成规范工程 B0 的结构迁移：
 *  1. 剥离 data-h-events（事件桥是迁移期兼容层，规范工程的事件走 React 合成事件）；
 *  2. 给根元素注入稳定的 data-area，供 L2 冒烟与后续域定位；
 *  3. 保留全部 id / class / style / aria / defaultValue 等结构属性（300 个 id 的等价面）。
 *
 * 仍然不接生产链：R67 的 frontend/react/ 与 harbor.html 零修改。
 * 用法：node frontend/app/tools/gen-layout.mjs
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..')
const ROOT = resolve(APP, '../..')
const GENERATED = join(ROOT, 'frontend/react/src/generated')
const LAYOUT = join(APP, 'src/layout')

export const AREAS = [
  ['IconDefs', 'icon-defs'],
  ['AuroraBg', 'aurora-bg'],
  ['StreamBar', 'stream-bar'],
  ['Rail', 'rail'],
  ['Sidebar', 'sidebar'],
  ['SidebarBackdrop', 'sidebar-backdrop'],
  ['MainShell', 'main-shell'],
  ['ProjectModal', 'project-modal'],
  ['ExpertCenter', 'expert-center'],
  ['HubMarket', 'hub-market'],
]

/** data-h-events 的值是 JSON.stringify 后的 JS 字符串字面量，内部可含 } 与转义引号。 */
const EVENT_ATTR = /\s*data-h-events=\{("(?:[^"\\]|\\.)*")\}/g
const ROOT_TAG = /(return \(\s*\n\s*<[A-Za-z][\w.-]*)/

function project(name, key) {
  const source = join(GENERATED, name + '.jsx')
  if (!existsSync(source)) throw new Error('缺少 R67 真实结构源: ' + source)
  let body = readFileSync(source, 'utf8')
  const events = (body.match(EVENT_ATTR) || []).length
  body = body.replace(EVENT_ATTR, '')
  if (/document\.|innerHTML|appendChild/.test(body)) {
    throw new Error(name + ' 剥离事件桥后仍含原生 DOM API，需人工处理')
  }
  if (!ROOT_TAG.test(body)) throw new Error(name + ' 无法定位根元素以注入 data-area')
  body = body.replace(ROOT_TAG, '$1 data-area="' + key + '"')
  const header = '/* B0 真实结构迁移：由 frontend/app/tools/gen-layout.mjs 从\n' +
    ' * frontend/react/src/generated/' + name + '.jsx 投影，已剥离 ' + events + ' 处事件桥。\n' +
    ' * AUTO-GENERATED — 请勿手改；改 R67 源后重跑本脚本。\n' +
    ' * 规范：React 唯一 DOM 所有者、零业务状态、零后端调用、零原生 DOM API。 */\n'
  // 去掉源文件的 AUTO-GENERATED 头注释，保留 export default 函数体
  const exportAt = body.indexOf('export default function')
  if (exportAt < 0) throw new Error(name + ' 缺少 export default')
  return { code: header + body.slice(exportAt), events }
}

mkdirSync(LAYOUT, { recursive: true })
let totalEvents = 0
for (const [name, key] of AREAS) {
  const { code, events } = project(name, key)
  totalEvents += events
  writeFileSync(join(LAYOUT, name + '.jsx'), code, 'utf8')
}
console.log('[gen-layout] B0 真实结构 %d 个区域，剥离 %d 处事件桥 -> %s',
  AREAS.length, totalEvents, LAYOUT)
