/**
 * 生成式 UI 规范校验与提取器（对齐原 generative/schemas.js v1 全部 14 组件与 5 布局）：
 * - 严格体积上限 64KB、最多 16 块、嵌套深度 <=3；
 * - 从 Assistant 正文中提取 ```ui-spec / ```harbor-ui JSON 代码块并做结构安全验证；
 * - 未注册组件或非法字段自动降级为 EmptyState，绝不崩溃。
 */
export const UI_LIMITS = Object.freeze({ specBytes: 64 * 1024, blocks: 16, depth: 3, title: 200, text: 10000 })
export const UI_LAYOUTS = Object.freeze(['single-column', 'two-column', 'card-grid', 'table-focus', 'timeline'])
export const UI_COMPONENTS = Object.freeze([
  'Table', 'Card', 'KeyValue', 'Timeline', 'BarChart', 'TextBlock', 'EmptyState', 'Skeleton',
  'StatTile', 'Progress', 'Checklist', 'Chips', 'Callout', 'SectionHeader',
])

const LAYOUT_SET = new Set(UI_LAYOUTS)
const COMP_SET = new Set(UI_COMPONENTS)

function validateBlock(block, depth) {
  if (depth > UI_LIMITS.depth) return { ok: false, error: 'MAX_DEPTH_EXCEEDED' }
  if (!block || typeof block !== 'object') return { ok: false, error: 'INVALID_BLOCK' }
  const blockId = String(block.blockId || `b_${depth}_${Math.random().toString(36).slice(2, 6)}`)
  const component = String(block.component || '')
  if (!COMP_SET.has(component)) {
    return {
      ok: true,
      block: {
        blockId,
        component: 'EmptyState',
        props: { title: '未注册的生成式组件', body: `组件名「${component || '未知'}」不在白名单内，已安全降级` },
        actions: [],
      },
      fallback: 'unknown_component',
    }
  }
  const props = (block.props && typeof block.props === 'object' && !Array.isArray(block.props)) ? block.props : {}
  const actions = Array.isArray(block.actions)
    ? block.actions.filter((a) => a && ['copy', 'export', 'refresh'].includes(a.name)).slice(0, 2)
    : []
  let children
  if (Array.isArray(block.children)) {
    children = block.children.slice(0, UI_LIMITS.blocks).map((ch) => {
      const r = validateBlock(ch, depth + 1)
      return r.ok ? r.block : { blockId: 'fb', component: 'EmptyState', props: { title: '子块超限', body: r.error }, actions: [] }
    })
  }
  return { ok: true, block: { blockId, component, props, actions, ...(children ? { children } : {}) } }
}

export function validateUiSpec(raw) {
  let obj = raw
  if (typeof raw === 'string') {
    if (raw.length > UI_LIMITS.specBytes) return { ok: false, error: 'SPEC_TOO_LARGE' }
    try { obj = JSON.parse(raw) } catch { return { ok: false, error: 'INVALID_JSON' } }
  }
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'SPEC_NOT_OBJECT' }
  if (obj.schemaVersion !== 1) return { ok: false, error: 'UNSUPPORTED_SCHEMA_VERSION' }
  const layout = LAYOUT_SET.has(obj.layout) ? obj.layout : 'single-column'
  if (!Array.isArray(obj.blocks)) return { ok: false, error: 'MISSING_BLOCKS' }

  const blocks = obj.blocks.slice(0, UI_LIMITS.blocks).map((b) => {
    const res = validateBlock(b, 1)
    return res.ok ? res.block : { blockId: 'err', component: 'EmptyState', props: { title: '区块校验失败', body: res.error }, actions: [] }
  })

  return {
    ok: true,
    spec: {
      schemaVersion: 1,
      specId: String(obj.specId || 'spec_' + Date.now()),
      title: obj.title ? String(obj.title).slice(0, UI_LIMITS.title) : '',
      layout,
      blocks,
    },
  }
}

export function extractUiSpecsFromMarkdown(markdownText) {
  const src = String(markdownText || '')
  const specs = []
  const re = /```(?:ui-spec|harbor-ui)\s*\n([\s\S]*?)```/gi
  let m
  while ((m = re.exec(src)) !== null) {
    const res = validateUiSpec(m[1].trim())
    if (res.ok) specs.push(res.spec)
  }
  const cleanMarkdown = specs.length ? src.replace(re, '').trim() : src
  return { cleanMarkdown, specs }
}
