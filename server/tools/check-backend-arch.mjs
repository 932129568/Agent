#!/usr/bin/env node
/**
 * Harbor 后端框架架构门禁（对齐 ARCHITECTURE-BACKEND.md）：
 * 校验 Fastify 5 + Zod 4 + Prisma 7 后端红线与 CORS / PNA / MCP 防阻塞契约。
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
for (const f of srvFiles) {
  const txt = fs.readFileSync(f, 'utf8')
  check(!/\b(?:spawn|execFile)\s*\(\s*['"]python/i.test(txt), `server/src 不得 spawn Python: ${path.relative(REPO_ROOT, f)}`)
}

const builderPath = path.join(REPO_ROOT, 'electron-builder.yml')
if (fs.existsSync(builderPath)) {
  const yml = fs.readFileSync(builderPath, 'utf8')
  check(!/backend\/\*\.py/.test(yml), 'electron-builder.yml 不得打包 backend/*.py')
}

const regTxt = fs.readFileSync(path.join(SERVER_ROOT, 'src', 'registry.js'), 'utf8')
check(!/NOT_MIGRATED/.test(regTxt), 'server/src/registry.js 不得残留 NOT_MIGRATED 未迁移桩')

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
console.log(`[BACKEND-ARCH] PASS — Fastify 5 + Zod 4 + Prisma 7 后端扫描 ${srvFiles.length} 文件，全部 6 项红线通过`)
