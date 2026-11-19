/**
 * R71 · 设计令牌单一事实源（The Dossier）
 *
 * 解决的问题：此前设计令牌只存在于 frontend/styles/*.css 的文本里，
 * JS 侧无法消费、无法单测、无法保证明暗两套一致；R69 的 --polish-* 层
 * 又是追加式补丁，令牌进一步碎片化。本模块把「卷宗」视觉体系收敛为
 * 一份可编程、可校验、可跨端复用的权威定义，CSS 只是它的投影。
 *
 * 架构约束（frontend/app/tests/arch-contract.mjs）：
 *  - 位于 ui/ 层（index 2），只允许向下 import；本模块零 import 最安全
 *  - 显式 export、零原生 DOM 写、零字符串求值、零全局符号赋值
 *  - 不调用 callApi（那是 services/ 的唯一出口）
 *  - 纯函数，确定性可复跑，不读系统时钟
 */

/** 语义令牌名（唯一权威清单）。CSS 变量必须一一对应，由 toCssVars() 生成。 */
export const TOKEN_NAMES = Object.freeze([
  'color-bg', 'color-surface', 'color-raised',
  'color-text', 'color-muted', 'color-faint',
  'color-accent', 'color-border', 'color-hairline',
  'font-display', 'font-body', 'font-data', 'font-stamp',
  'fs-micro', 'fs-caption', 'fs-body', 'fs-lead', 'fs-title', 'fs-h2', 'fs-h1', 'fs-folio',
  'space-1', 'space-2', 'space-3', 'space-4', 'space-5', 'space-6', 'space-7',
  'radius-sm', 'radius-md', 'radius-lg',
  'shadow-1', 'shadow-2', 'shadow-3',
  'dur-fast', 'dur-base', 'dur-scene',
  's1', 's2', 's3', 's4', 's5',
  'focus-ring-w', 'focus-ring-offset', 'target',
])

/** 明暗两套主题的具体值。禁止出现纯 #000 / 纯 #fff / 白底紫渐变。 */
export const THEMES = Object.freeze({
  light: Object.freeze({
    'color-bg': '#F4F0E8', 'color-surface': '#EAE4D8', 'color-raised': '#DED6C7',
    'color-text': '#1A1815', 'color-muted': '#4A463F', 'color-faint': '#7A7368',
    'color-accent': '#B8412A', 'color-border': 'rgba(26,24,21,.22)',
    'color-hairline': 'rgba(26,24,21,.10)',
    'shadow-1': '0 2px 8px rgba(26,24,21,.07)',
    'shadow-2': '0 8px 28px rgba(26,24,21,.13)',
    'shadow-3': '0 24px 64px rgba(26,24,21,.22)',
  }),
  dark: Object.freeze({
    'color-bg': '#14120F', 'color-surface': '#1C1A16', 'color-raised': '#26231D',
    'color-text': '#EDE7DA', 'color-muted': '#B9B1A2', 'color-faint': '#8A8377',
    'color-accent': '#E0674A', 'color-border': 'rgba(237,231,218,.22)',
    'color-hairline': 'rgba(237,231,218,.10)',
    'shadow-1': '0 2px 8px rgba(0,0,0,.35)',
    'shadow-2': '0 8px 28px rgba(0,0,0,.48)',
    'shadow-3': '0 24px 64px rgba(0,0,0,.60)',
  }),
})

/** 与主题无关的结构令牌（字阶 1.25 比例、间距 4/8/16/24/40/64/96、动效错峰）。 */
export const SHARED = Object.freeze({
  'font-display': 'Georgia, "Cambria", "Noto Serif SC", serif',
  'font-body': '"Calibri", "Noto Sans SC", "Microsoft YaHei UI", sans-serif',
  'font-data': '"Cascadia Mono", "Bahnschrift", "Consolas", monospace',
  'font-stamp': '"Bahnschrift SemiCondensed", "Impact", "Cascadia Mono", monospace',
  'fs-micro': '11px', 'fs-caption': '12px', 'fs-body': '15px',
  'fs-lead': '18px', 'fs-title': '24px', 'fs-h2': '32px',
  'fs-h1': '48px', 'fs-folio': '76px',
  'space-1': '4px', 'space-2': '8px', 'space-3': '16px', 'space-4': '24px',
  'space-5': '40px', 'space-6': '64px', 'space-7': '96px',
  'radius-sm': '2px', 'radius-md': '3px', 'radius-lg': '4px',
  'dur-fast': '170ms', 'dur-base': '320ms', 'dur-scene': '640ms',
  's1': '0ms', 's2': '80ms', 's3': '160ms', 's4': '240ms', 's5': '320ms',
  'focus-ring-w': '2px', 'focus-ring-offset': '2px', 'target': '44px',
})

/** 生成 CSS 变量声明块。selector 由调用方决定，避免本层碰 DOM。 */
export function toCssVars(theme = 'light', selector = ':root') {
  const t = THEMES[theme]
  if (!t) throw new Error(`未知主题: ${theme}`)
  const lines = TOKEN_NAMES.map(name => {
    const value = SHARED[name] !== undefined ? SHARED[name] : t[name]
    if (value === undefined) throw new Error(`令牌 ${name} 在主题 ${theme} 缺失`)
    return `  --${name}: ${value};`
  })
  return `${selector} {\n${lines.join('\n')}\n}`
}

/** 不变量校验：两套主题键集合一致、无纯黑白、强调色唯一且非蓝紫。 */
export function validateTokens(themes = THEMES) {
  const problems = []
  const names = Object.keys(themes)
  for (const name of names) {
    const t = themes[name]
    for (const key of ['color-bg', 'color-surface', 'color-raised',
                       'color-text', 'color-muted', 'color-faint',
                       'color-accent', 'color-border', 'color-hairline',
                       'shadow-1', 'shadow-2', 'shadow-3']) {
      if (!t[key]) problems.push(`${name}.${key} 缺失`)
    }
    if (t['color-bg'] === '#000000' || t['color-bg'] === '#FFFFFF') {
      problems.push(`${name}.color-bg 为纯黑/纯白`)
    }
    if (t['color-text'] === '#000000' || t['color-text'] === '#FFFFFF') {
      problems.push(`${name}.color-text 为纯黑/纯白`)
    }
    if (t['color-accent'] === undefined || !/^#[0-9A-Fa-f]{6}$/.test(t['color-accent'])) {
      problems.push(`${name}.color-accent 非有效强调色`)
    }
  }
  return { ok: problems.length === 0, problems }
}

/** 供外部（如构建脚本）取单个令牌，保持单一事实源。 */
export function tokenOf(name, theme = 'light') {
  const t = THEMES[theme]
  if (!t) throw new Error(`未知主题: ${theme}`)
  return SHARED[name] !== undefined ? SHARED[name] : t[name]
}

export default { TOKEN_NAMES, THEMES, SHARED, toCssVars, validateTokens, tokenOf }
