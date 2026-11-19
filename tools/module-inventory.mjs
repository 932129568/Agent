/** R64：全库模块盘点器（整体模块优化的数据源）。
 *
 * 用法：node tools/module-inventory.mjs [--out deliverables/dev-plan/module-inventory-r64.json]
 * 输出：JSON（全部原始数据）+ 控制台摘要。
 *
 * 采集面：
 * - 前端 117 模块：字节/行数/provides/requires/引用边（符号级→模块级）/前向边/入度出度
 * - 环：引用图强连通分量（SCC >1 = 载入顺序下互相前向引用的真环）
 * - 重复定义：同一符号被多个模块 provides / 顶层定义
 * - 死 provides：无任何其他模块引用、且模板/岛层不触的导出符号
 * - server：src 全部模块 字节/行数/import 图/SCC
 * - jsapi 面：registry 注册清单 vs 前端 callApi 实调清单（死接口候选）
 * - 产物体积：harbor.html / island / libs / electron
 */
import fs from 'node:fs'
import path from 'node:path'
import { stripCode, topLevelSymbols } from './lib/js-lexer.mjs'

const root = path.resolve('.')
const out = { generatedAt: new Date().toISOString(), frontend: null, server: null, jsapi: null, artifacts: null }

/* ---------------- 前端 ---------------- */
const manifest = JSON.parse(fs.readFileSync('frontend/manifest.json', 'utf8'))
const providesMap = new Map()   // symbol -> [modulePath]
for (const e of manifest.scripts) for (const s of e.provides) {
  if (!providesMap.has(s)) providesMap.set(s, [])
  providesMap.get(s).push(e.path)
}
const order = new Map(manifest.scripts.map((e, i) => [e.path, i]))

const feModules = []
const feEdgeSym = new Map()   // "from->to" -> Set(symbol)
for (const entry of manifest.scripts) {
  const fp = path.join(root, entry.path)
  const raw = fs.readFileSync(fp, 'utf8')
  const clean = stripCode(raw)
  const refs = new Map()   // symbol -> [targetModule]
  for (const m of clean.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    for (const t of providesMap.get(m[0]) || []) {
      if (t === entry.path) continue
      if (!refs.has(m[0])) refs.set(m[0], new Set())
      refs.get(m[0]).add(t)
    }
  }
  const edgeTargets = new Set()
  for (const [, targets] of refs) for (const t of targets) edgeTargets.add(t)
  for (const t of edgeTargets) {
    const k = entry.path + '->' + t
    if (!feEdgeSym.has(k)) feEdgeSym.set(k, new Set())
    for (const [sym, targets] of refs) if (targets.has(t)) feEdgeSym.get(k).add(sym)
  }
  feModules.push({
    path: entry.path,
    bytes: Buffer.byteLength(raw, 'utf8'),
    lines: raw.split('\n').length,
    provides: entry.provides.length,
    requires: entry.requires.length,
    refOut: edgeTargets.size,
    refsDetail: Object.fromEntries([...refs].map(([s, ts]) => [s, [...ts]])),
  })
}
// 入度（被多少模块引用）
const feIn = new Map()
for (const m of feModules) {
  for (const t of Object.values(m.refsDetail)) for (const tp of t) {
    feIn.set(tp, (feIn.get(tp) || 0) + 1)
  }
}
for (const m of feModules) m.refIn = feIn.get(m.path) || 0

// SCC（Tarjan 迭代版）——模块级引用图
function scc(nodes, edges) {
  const idx = new Map(), low = new Map(), on = new Set(), stack = [], out = []
  let counter = 0
  const strong = (v0) => {
    const work = [[v0, 0]]
    idx.set(v0, counter); low.set(v0, counter); counter++
    stack.push(v0); on.add(v0)
    while (work.length) {
      const [v, pi] = work[work.length - 1]
      const es = edges.get(v) || []
      if (pi < es.length) {
        work[work.length - 1][1]++
        const w = es[pi]
        if (!idx.has(w)) {
          idx.set(w, counter); low.set(w, counter); counter++
          stack.push(w); on.add(w)
          work.push([w, 0])
        } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)))
      } else {
        work.pop()
        if (work.length) {
          const parent = work[work.length - 1][0]
          low.set(parent, Math.min(low.get(parent), low.get(v)))
        }
        if (low.get(v) === idx.get(v)) {
          const comp = []
          for (;;) {
            const w = stack.pop(); on.delete(w); comp.push(w)
            if (w === v) break
          }
          if (comp.length > 1) out.push(comp.sort())
        }
      }
    }
  }
  for (const v of nodes) if (!idx.has(v)) strong(v)
  return out
}
const feEdgeAdj = new Map()
for (const m of feModules) feEdgeAdj.set(m.path, [])
for (const k of feEdgeSym.keys()) {
  const [a, b] = k.split('->')
  feEdgeAdj.get(a).push(b)
}
const feCycles = scc(feModules.map(m => m.path), feEdgeAdj)

// 死 provides 候选：符号名未出现在任何其他模块骨架、也不在模板/岛层源码里
const tpl = fs.readFileSync(path.join(root, 'frontend', 'index.template.html'), 'utf8')
const islandSrc = ['index.jsx', 'SessionHistory.jsx'].map(f => {
  const p = path.join(root, 'frontend/react/src', f)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}).join('\n')
const deadProvides = []
for (const [sym, mods] of providesMap) {
  let used = false
  for (const m of feModules) {
    if (mods.includes(m.path)) continue
    if (m.refsDetail[sym]) { used = true; break }
  }
  if (!used && !tpl.includes(sym) && !islandSrc.includes(sym)) {
    deadProvides.push({ symbol: sym, modules: mods })
  }
}

// 重复 provides（同一符号多模块导出）
const dupProvides = []
for (const [sym, mods] of providesMap) if (mods.length > 1) dupProvides.push({ symbol: sym, modules: mods })

out.frontend = {
  moduleCount: feModules.length,
  totalBytes: feModules.reduce((n, m) => n + m.bytes, 0),
  totalLines: feModules.reduce((n, m) => n + m.lines, 0),
  modules: feModules.sort((a, b) => b.bytes - a.bytes),
  edges: [...feEdgeSym.entries()].map(([k, v]) => ({ edge: k, symbols: [...v] })),
  cycles: feCycles,
  deadProvides,
  dupProvides,
}

/* ---------------- server ---------------- */
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '__pycache__') walk(fp, acc) }
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) acc.push(fp)
  }
  return acc
}
const serverFiles = walk(path.join(root, 'server', 'src'))
const svModules = []
const svEdgeAdj = new Map()
const svByAbs = new Map()
for (const fp of serverFiles) {
  const rel = path.relative(root, fp).replace(/\\/g, '/')
  const raw = fs.readFileSync(fp, 'utf8')
  const imports = []
  for (const m of raw.matchAll(/import\s+[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = m[1] || m[2] || m[3]
    if (!spec || !spec.startsWith('.')) continue
    const resolved = path.relative(root, path.resolve(path.dirname(fp), spec)).replace(/\\/g, '/')
    imports.push(resolved)
  }
  svByAbs.set(rel, { raw, imports })
  svModules.push({ path: rel, bytes: Buffer.byteLength(raw, 'utf8'), lines: raw.split('\n').length, imports })
  svEdgeAdj.set(rel, imports)
}
const svCycles = scc(svModules.map(m => m.path), svEdgeAdj)
out.server = {
  moduleCount: svModules.length,
  totalBytes: svModules.reduce((n, m) => n + m.bytes, 0),
  totalLines: svModules.reduce((n, m) => n + m.lines, 0),
  modules: svModules.sort((a, b) => b.bytes - a.bytes),
  cycles: svCycles,
}

/* ---------------- jsapi 面：注册 vs 前端实调 ---------------- */
const registrySrc = fs.readFileSync(path.join(root, 'server', 'src', 'registry.js'), 'utf8')
const registered = [...registrySrc.matchAll(/register\(\s*'([a-z0-9_]+)'/g)].map(m => m[1])
const feAll = feModules.map(m => fs.readFileSync(path.join(root, m.path), 'utf8')).join('\n')
const called = new Set([...feAll.matchAll(/callApi\(\s*'([a-z0-9_]+)'/g)].map(m => m[1]))
const tplCalled = new Set([...tpl.matchAll(/callApi\(\s*'([a-z0-9_]+)'/g)].map(m => m[1]))
for (const n of tplCalled) called.add(n)
const islandCalls = [...islandSrc.matchAll(/callApi\(\s*'([a-z0-9_]+)'/g)].map(m => m[1])
for (const n of islandCalls) called.add(n)
// 前端还有 callApi(name 变量) 形态——统计直接字符串面为准
out.jsapi = {
  registeredCount: registered.length,
  calledFromFrontend: [...called].sort(),
  registeredNeverCalled: registered.filter(n => !called.has(n)).sort(),
  calledNotRegistered: [...called].filter(n => !registered.includes(n)).sort(),
}

/* ---------------- 产物体积 ---------------- */
const sizeOf = p => { try { return fs.statSync(path.join(root, p)).size } catch { return 0 } }
out.artifacts = {
  'harbor.html': sizeOf('harbor.html'),
  'island': sizeOf('frontend/react/dist/harbor-island.iife.js'),
  'libs/highlight.min.js': sizeOf('libs/highlight.min.js'),
  'libs/marked.min.js': sizeOf('libs/marked.min.js'),
  'libs/purify.min.js': sizeOf('libs/purify.min.js'),
  'libs/ui-schema.bundle.js': sizeOf('libs/ui-schema.bundle.js'),
  'electron/main.js': sizeOf('electron/main.js'),
  'electron/preload.js': sizeOf('electron/preload.js'),
}

if (process.argv.includes('--out')) {
  const oi = process.argv.indexOf('--out')
  const dest = path.join(root, process.argv[oi + 1] || 'deliverables/dev-plan/module-inventory-r64.json')
  fs.writeFileSync(dest, JSON.stringify(out, null, 1), 'utf8')
  console.log('[inventory] written:', dest)
}

/* ---------------- 控制台摘要 ---------------- */
const kb = n => (n / 1024).toFixed(1) + 'K'
console.log('== 前端 ' + out.frontend.moduleCount + ' 模块，共 ' + kb(out.frontend.totalBytes) + 'B / ' + out.frontend.totalLines + ' 行')
console.log('-- 体积 Top12')
out.frontend.modules.slice(0, 12).forEach(m => console.log('   ' + kb(m.bytes).padStart(7) + ' ' + String(m.lines).padStart(5) + '行  入' + String(m.refIn).padStart(2) + ' 出' + String(m.refOut).padStart(2) + '  ' + m.path))
console.log('-- 入度 Top10（被最多模块引用——下沉候选/改动热点）')
feModules.slice().sort((a, b) => b.refIn - a.refIn).slice(0, 10).forEach(m => console.log('   入' + String(m.refIn).padStart(3) + '  ' + m.path))
console.log('-- 环（SCC>1）：' + out.frontend.cycles.length)
out.frontend.cycles.forEach(c => console.log('   ' + c.map(x => x.replace('frontend/src/', '')).join(' <-> ')))
console.log('-- 死 provides 候选：' + deadProvides.length)
deadProvides.slice(0, 20).forEach(d => console.log('   ' + d.symbol + '  @' + d.modules.join(',')))
console.log('-- 重复 provides：' + dupProvides.length)
dupProvides.forEach(d => console.log('   ' + d.symbol + '  @' + d.modules.map(x => x.replace('frontend/src/', '')).join(',')))
console.log('== server ' + out.server.moduleCount + ' 模块，共 ' + kb(out.server.totalBytes) + 'B / ' + out.server.totalLines + ' 行')
console.log('-- 体积 Top12')
out.server.modules.slice(0, 12).forEach(m => console.log('   ' + kb(m.bytes).padStart(7) + ' ' + String(m.lines).padStart(5) + '行  ' + m.path))
console.log('-- 环：' + out.server.cycles.length)
out.server.cycles.forEach(c => console.log('   ' + c.join(' <-> ')))
console.log('== jsapi：注册 ' + out.jsapi.registeredCount + '，前端实调 ' + out.jsapi.calledFromFrontend.length + '，注册未调 ' + out.jsapi.registeredNeverCalled.length + '，调未注册 ' + out.jsapi.calledNotRegistered.length)
if (out.jsapi.calledNotRegistered.length) console.log('   调未注册（潜在断链）: ' + out.jsapi.calledNotRegistered.join(', '))
console.log('== 产物：' + Object.entries(out.artifacts).map(([k, v]) => k + '=' + kb(v)).join('  '))
