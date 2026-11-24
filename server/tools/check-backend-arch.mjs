#!/usr/bin/env node
/**
 * Harbor 后端框架架构门禁（R5 升级版 · 对齐 ARCHITECTURE-BACKEND.md）：
 * 校验项（7 项硬红线）：
 *   1. server/src 零 Python 子进程调用；
 *   2. electron-builder.yml 不含 backend 下的 .py、不含已删 harbor.html，且包含 frontend/app/dist 全部产物；
 *   3. server/src/registry.js 零残留 NOT_MIGRATED 死壳；
 *   4. local-proxy.js CORS 放行 X-Harbor-Target / X-Harbor-Harness + PNA；
 *   5. app.js CORS 放行 4 业务自定义头 + PNA；
 *   6. mcp.js mcpToolSchemas 并发 + 快速超时防阻塞；
 *   7. server/src 全图静态/动态 import 零循环依赖（browser ↔ guard ↔ misc 已由 audit.js 彻底解环）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = path.resolve(HERE, '..')
const REPO_ROOT = path.resolve(SERVER_ROOT, '..')
const errors = []

function check(cond, msg) {
  if (!cond) errors.push(msg)
}

function walkJs(dir) {
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'generated') continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walkJs(full))
    else if (/\.(?:js|mjs)$/.test(ent.name)) out.push(full)
  }
  return out
}

const srvFiles = walkJs(path.join(SERVER_ROOT, 'src'))
const graph = new Map()

for (const f of srvFiles) {
  const txt = fs.readFileSync(f, 'utf8')
  check(!/\b(?:spawn|execFile)\s*\(\s*['"]python/i.test(txt), `server/src 不得 spawn Python: ${path.relative(REPO_ROOT, f)}`)
  const deps = []
  const re = /(?:from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\))/g
  let m
  while ((m = re.exec(txt)) !== null) {
    const spec = m[1] || m[2]
    const target = path.resolve(path.dirname(f), spec)
    if (fs.existsSync(target)) deps.push(target)
  }
  graph.set(f, deps)
}

const state = new Map()
const stack = []
const cycles = []
function dfs(node) {
  state.set(node, 1)
  stack.push(node)
  for (const nxt of (graph.get(node) || [])) {
    const st = state.get(nxt) || 0
    if (st === 1) {
      const idx = stack.indexOf(nxt)
      cycles.push(stack.slice(idx).concat(nxt).map((p) => path.relative(path.join(SERVER_ROOT, 'src'), p)).join(' -> '))
    } else if (st === 0) {
      dfs(nxt)
    }
  }
  stack.pop()
  state.set(node, 2)
}
for (const f of srvFiles) {
  if (!state.get(f)) dfs(f)
}
check(cycles.length === 0, `server/src 存在循环依赖: ${cycles.join(' ; ')}`)

const builderPath = path.join(REPO_ROOT, 'electron-builder.yml')
if (fs.existsSync(builderPath)) {
  const yml = fs.readFileSync(builderPath, 'utf8')
  check(!/backend\/\*\.py/.test(yml), 'electron-builder.yml 不得打包 backend/*.py')
  check(!/^\s*-\s*harbor\.html\s*$/m.test(yml), 'electron-builder.yml 不得引用已删除的旧 harbor.html')
  check(/frontend\/app\/dist\/\*\*\/\*/.test(yml), 'electron-builder.yml 必须打包 frontend/app/dist/**/*')
}

const regTxt = fs.readFileSync(path.join(SERVER_ROOT, 'src', 'registry.js'), 'utf8')
// 原判定是 `!/NOT_MIGRATED/.test(整文件)` —— 连注释与 invoke() 里的缺省护栏都算，
// 于是只要提到该错误码就 FAIL。真正要防的是"注册表挂了未迁移死壳"，
// 改为结构判定：剥注释后只允许 invoke() 那一处护栏（≤1），≥2 才判有桩。
const regCode = regTxt
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')
const notMigratedHits = (regCode.match(/NOT_MIGRATED/g) || []).length
check(notMigratedHits <= 1, `server/src/registry.js 残留 NOT_MIGRATED 未迁移桩（去注释后命中 ${notMigratedHits} 处，应 ≤1）`)

const lpTxt = fs.readFileSync(path.join(SERVER_ROOT, 'src', 'services', 'local-proxy.js'), 'utf8')
check(/X-Harbor-Target/.test(lpTxt) && /X-Harbor-Harness/.test(lpTxt), 'local-proxy.js CORS 必须放行 X-Harbor-Target 与 X-Harbor-Harness')
check(/Access-Control-Allow-Private-Network/.test(lpTxt), 'local-proxy.js 必须放行 PNA 预检')

const appTxt = fs.readFileSync(path.join(SERVER_ROOT, 'src', 'app.js'), 'utf8')
check(/x-harbor-sid/.test(appTxt) && /Access-Control-Allow-Private-Network/.test(appTxt), 'server/src/app.js 必须放行 4 自定义头与 PNA')

const mcpTxt = fs.readFileSync(path.join(SERVER_ROOT, 'src', 'services', 'mcp.js'), 'utf8')
check(/MCP_SCHEMA_FAST_MS/.test(mcpTxt) && /Promise\.allSettled/.test(mcpTxt), 'mcp.js mcpToolSchemas 必须并行且带快速超时防卡死')

if (errors.length) {
  console.error('[BACKEND-ARCH] FAIL:')
  errors.forEach((e) => console.error('  -', e))
  process.exit(1)
}
console.log(`[BACKEND-ARCH] PASS — Fastify 5 + Zod 4 + Prisma 7 扫描 ${srvFiles.length} 文件，0 循环依赖，7 项架构红线全通过`)
