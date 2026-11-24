/**
 * 实时交互式 Artifact 沙箱提取与安全封装引擎（R17 加固版 · 纯函数，可直接 L1 单测）：
 * - 从 Markdown 自动识别 HTML / SVG 交付块；
 * - 强制为所有文档（含完整 <!doctype html>）注入「沙箱导航与异常守护脚本」：
 *   1) 拦截 <a href> 相对/空/外链跳转与 <form> 默认提交（根治在 srcDoc iframe 中点按钮/链接时
 *      继承父文档 base URL 导致把整个 Harbor 项目网页重新套娃打开的严重缺陷！）；
 *   2) 捕获沙箱内 JS 运行时异常并经 postMessage 回传宿主显示诊断条。
 */

const FENCE_RE = /```([a-zA-Z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g

const SANDBOX_GUARD_SCRIPT = `<script data-harbor-guard="1">(function(){
var d=document,w=self;
var notify=function(kind,detail){try{parent.postMessage({__harborArtifact:true,kind:kind,detail:String(detail||'')},'*')}catch(e){}};
d.addEventListener('click',function(e){
  var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;
  if(!a)return;
  var href=(a.getAttribute('href')||'').trim();
  if(href.startsWith('#')){
    e.preventDefault();
    if(href.length>1){try{var t=d.getElementById(href.slice(1));if(t)t.scrollIntoView({behavior:'smooth'});}catch(ex){}}
    return;
  }
  e.preventDefault();
  notify('nav_blocked',href||'empty-href');
},true);
d.addEventListener('submit',function(e){
  if(!e.defaultPrevented){
    e.preventDefault();
    notify('form_blocked',(e.target&&e.target.getAttribute&&e.target.getAttribute('action'))||'form-submit');
  }
},false);
try{Object.defineProperty(w,'open',{value:function(u){notify('nav_blocked',u||'open');return null;},configurable:true});}catch(e){}
w.addEventListener('error',function(ev){notify('runtime_error',(ev&&ev.message)||'Script error');});
w.addEventListener('unhandledrejection',function(ev){notify('runtime_error',(ev&&ev.reason&&(ev.reason.message||ev.reason))||'Unhandled rejection');});
})();</script>`

function injectSandboxGuard(htmlDoc) {
  const doc = String(htmlDoc || '')
  if (!doc || doc.includes('data-harbor-guard="1"')) return doc
  if (/<head[^>]*>/i.test(doc)) {
    return doc.replace(/<head[^>]*>/i, (m) => `${m}\n${SANDBOX_GUARD_SCRIPT}`)
  }
  if (/<body[^>]*>/i.test(doc)) {
    return doc.replace(/<body[^>]*>/i, (m) => `${m}\n${SANDBOX_GUARD_SCRIPT}`)
  }
  return `${SANDBOX_GUARD_SCRIPT}\n${doc}`
}

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

/** 构造带防套娃导航守护与异常回传的沙箱预览文档（完整页面与片段统一守护）。 */
export function buildArtifactSandboxDoc(artifact, theme = 'light') {
  if (!artifact || !artifact.code) return ''
  const raw = String(artifact.code)
  const isDark = theme === 'dark'
  if (artifact.kind === 'html' && /<!doctype\s+html|<html[\s>]/i.test(raw)) {
    return injectSandboxGuard(raw)
  }
  const bg = isDark ? '#181a20' : '#faf8f4'
  const fg = isDark ? '#f5f4ef' : '#1b1a18'
  const bodyContent = artifact.kind === 'svg'
    ? `<div style="display:grid;place-items:center;min-height:100vh;padding:20px;box-sizing:border-box;">${raw}</div>`
    : raw
  const full = [
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
  return injectSandboxGuard(full)
}
