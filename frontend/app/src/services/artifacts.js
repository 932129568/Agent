/**
 * 实时交互式 Artifact 沙箱提取与封装引擎（R15 前沿特性 · 纯函数，可直接 L1 单测）：
 * - 从任意 Markdown 回答中自动识别可实时渲染的 HTML / SVG / 独立 CSS+JS 交付块；
 * - 生成严格隔离的沙箱预览文档（供 `<iframe sandbox="allow-scripts">` srcDoc 实时交互渲染）；
 * - 支持多 Artifact 切换、文件名推导与安全导出。
 */

const FENCE_RE = /```([a-zA-Z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g

function inferTitle(lang, code, index) {
  const titleMatch = String(code || '').match(/<title>([^<]{1,60})<\/title>/i)
  if (titleMatch && titleMatch[1].trim()) return titleMatch[1].trim()
  const h1Match = String(code || '').match(/<h1[^>]*>([^<]{1,48})<\/h1>/i)
  if (h1Match && h1Match[1].trim()) return h1Match[1].trim()
  if (lang === 'svg') return `矢量图形 #${index + 1}`
  return `交互网页预览 #${index + 1}`
}

export function extractArtifactsFromMarkdown(markdown = '') {
  const src = String(markdown || '')
  if (!src || !src.includes('```')) return []
  const items = []
  let m
  FENCE_RE.lastIndex = 0
  while ((m = FENCE_RE.exec(src)) !== null) {
    const lang = String(m[1] || '').trim().toLowerCase()
    const code = String(m[2] || '').trim()
    if (!code || code.length < 24) continue

    const isHtml = lang === 'html' || lang === 'htm' || (!lang && /<!doctype\s+html|<html[\s>]/i.test(code))
    const isSvg = lang === 'svg' || (!lang && /^<svg[\s>]/i.test(code))
    if (!isHtml && !isSvg) continue

    const kind = isSvg ? 'svg' : 'html'
    const title = inferTitle(kind, code, items.length)
    items.push({
      id: `art_${items.length}_${code.length}`,
      kind,
      lang: kind,
      title,
      filename: `${title.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 32) || 'artifact'}.${kind}`,
      code,
    })
  }
  return items
}

/** 将片段式 HTML / SVG 自动补齐为响应式中立底板文档，保证在沙箱 iframe 中即开即美。 */
export function buildArtifactSandboxDoc(artifact, theme = 'light') {
  if (!artifact || !artifact.code) return ''
  const raw = String(artifact.code)
  const isDark = theme === 'dark'
  if (artifact.kind === 'html' && /<!doctype\s+html|<html[\s>]/i.test(raw)) {
    return raw
  }
  const bg = isDark ? '#181a20' : '#faf8f4'
  const fg = isDark ? '#f5f4ef' : '#1b1a18'
  const bodyContent = artifact.kind === 'svg'
    ? `<div style="display:grid;place-items:center;min-height:100vh;padding:20px;box-sizing:border-box;">${raw}</div>`
    : raw
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${String(artifact.title || 'Harbor Artifact').replace(/</g, '&lt;')}</title>`,
    `<style>html,body{margin:0;padding:0;min-height:100%;background:${bg};color:${fg};font-family:"Segoe UI","PingFang SC",system-ui,sans-serif;}svg{max-width:100%;height:auto;}</style>`,
    '</head>',
    `<body>${bodyContent}</body>`,
    '</html>',
  ].join('\n')
}
