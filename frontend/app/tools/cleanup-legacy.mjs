#!/usr/bin/env node
/**
 * Harbor 全仓过时文件物理清仓脚本（R5 完整版）：
 * - 默认清理：旧前端残余 + R67 阶段留下的 25 个孤儿骨架文件 + 过期测试脚本 + frontend/vendor；
 * - 追加 `--include-python`：同步清除根目录已退役的 Python/PyInstaller 遗留文件；
 * - 默认 --dry-run 仅列出，传 --execute 才真正删除。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../..')
const EXEC = process.argv.includes('--execute')
const INCLUDE_PY = process.argv.includes('--include-python')

const LEGACY_TARGETS = [
  'frontend/src',
  'frontend/styles',
  'frontend/build.js',
  'frontend/vendor',
  'harbor.html',
  'electron/wallpaper.js',
  'electron/test-wallpaper.cjs',
  'server/test/lightwell-skin-gate.mjs',
  'frontend/app/src/layout',
  'frontend/app/src/features/_template',
  'frontend/app/src/state/actions',
  'frontend/app/src/platform/env.js',
  'frontend/app/src/services/cache.js',
  'frontend/app/src/services/index.js',
  'frontend/app/src/services/tools.js',
  'frontend/app/src/state/ExhibitState.js',
  'frontend/app/src/state/createStore.js',
  'frontend/app/src/state/selectors.js',
  'frontend/app/src/state/slices.js',
  'frontend/app/src/state/storeContext.jsx',
  'frontend/app/src/ui/Button.jsx',
  'frontend/app/src/ui/DossierTokens.js',
  'frontend/app/src/ui/Icon.jsx',
  'frontend/app/src/ui/Panel.jsx',
  'frontend/app/src/ui/Spinner.jsx',
  'frontend/app/tests/arch-contract.mjs',
  'frontend/app/tests/audit-freshness.mjs',
  'frontend/app/tests/smoke-render.mjs',
  'frontend/app/tools/gen-layout.mjs',
  'tools/scc_ratchet.py',
  'tools/gen_allowlist.mjs',
  'tools/contract_diff.py',
]

const PY_RETIRED = [
  'harness',
  'agent_memory',
  'Harbor.spec',
  'Harbor-mac.spec',
  'requirements-ci.txt',
  'requirements-mac.txt',
  'requirements-win.txt',
]

const list = INCLUDE_PY ? [...LEGACY_TARGETS, ...PY_RETIRED] : LEGACY_TARGETS
let count = 0
for (const rel of list) {
  const abs = path.join(REPO, rel)
  if (!fs.existsSync(abs)) continue
  count++
  if (EXEC) {
    fs.rmSync(abs, { recursive: true, force: true })
    console.log(`[DELETED] ${rel}`)
  } else {
    console.log(`[DRY-RUN] will delete: ${rel}`)
  }
}

if (count === 0) {
  console.log('[CLEANUP] 仓库已 100% 干净，无待清理过时文件')
} else if (!EXEC) {
  console.log(`\n共发现 ${count} 处过时目录/孤儿文件。确认后运行：node frontend/app/tools/cleanup-legacy.mjs --execute`)
} else {
  console.log(`\n已完成清仓（共删除 ${count} 处），请运行 node frontend/app/tools/enforce-iron-laws.mjs --strict 复验。`)
}
