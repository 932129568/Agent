#!/usr/bin/env node
/**
 * 阶段 5 · 物理清仓脚本：删除全部已淘汰的旧前端、假壁纸、单文件巨石与过时旧前端门禁，
 * 随后自动运行 enforce-iron-laws.mjs --strict 锁定终态。
 *
 * 用法：
 *   node frontend/app/tools/cleanup-legacy.mjs --dry-run    # 仅打印将删除的列表
 *   node frontend/app/tools/cleanup-legacy.mjs --execute    # 执行物理删除 + 跑 --strict 验收
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const EXEC = process.argv.includes('--execute')
const INCLUDE_PY = process.argv.includes('--include-python')
const PY_RETIRED = ['harness', 'agent_memory', 'Harbor.spec', 'Harbor-mac.spec', 'requirements-ci.txt', 'requirements-mac.txt', 'requirements-win.txt']

const TARGETS = [
  // 旧命令式前端 & 过渡 React 岛 & 外挂皮肤 & 单文件巨石
  'frontend/src',
  'frontend/styles',
  'frontend/react/src',
  'frontend/react/dist',
  'frontend/react/tools',
  'frontend/skin/lightwellShell.js',
  'frontend/index.template.html',
  'frontend/build.js',
  'frontend/manifest.json',
  'frontend/deps-allowlist.json',
  'harbor.html',
  // 旧静态桌面壁纸假透色文件
  'electron/wallpaper.js',
  'electron/test-wallpaper.cjs',
  // 旧 R67 过期静态投影目录（若仍残留）
  'frontend/app/src/layout',
  'frontend/app/src/services/sanitize.js',
  // 锁死旧全局符号与假壁纸的过时前端门禁
  'server/test/lightwell-skin-gate.mjs',
  'tools/scc_ratchet.py',
  'tools/gen_allowlist.mjs',
  'tools/contract_diff.py',
]

console.log(`[cleanup-legacy] mode = ${EXEC ? 'EXECUTE (物理删除)' : 'DRY-RUN (仅预览)'}`)
let count = 0
for (const rel of (INCLUDE_PY ? [...TARGETS, ...PY_RETIRED] : TARGETS)) {
  const full = path.join(REPO_ROOT, rel)
  if (!fs.existsSync(full)) continue
  count++
  if (EXEC) {
    fs.rmSync(full, { recursive: true, force: true })
    console.log(`  [DELETED] ${rel}`)
  } else {
    console.log(`  [WOULD DELETE] ${rel}`)
  }
}

// 提示保留 frontend/react/node_modules（供 frontend/app/build.mjs 复用 react + esbuild，零外网安装）
console.log(`[cleanup-legacy] 共处理 ${count} 项遗产（保留 frontend/react/node_modules 供 esbuild/react 复用，保留全部 server/src 后端与测试）`)

if (EXEC) {
  const r = spawnSync(process.execPath, [path.join(HERE, 'enforce-iron-laws.mjs'), '--strict'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  })
  process.exit(r.status ?? 1)
}
