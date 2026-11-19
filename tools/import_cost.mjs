/* R59：逐服务模块导入耗时分解（node ESM，data: URL 隔离计数）。 */
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve('.')
const mods = [
  'server/src/config.js', 'server/src/logger.js', 'server/src/db.js',
  'server/src/paths.js', 'server/src/runtime.js', 'server/src/session-context.js',
  'server/src/services/sessions.js', 'server/src/services/config.js',
  'server/src/services/worklog.js', 'server/src/services/files.js',
  'server/src/services/jsonstore.js', 'server/src/services/config-specs.js',
  'server/src/services/workspace.js', 'server/src/services/memory.js',
  'server/src/services/plans.js', 'server/src/services/misc.js',
  'server/src/services/system.js', 'server/src/services/provider.js',
  'server/src/services/guard.js', 'server/src/services/commands.js',
  'server/src/services/update.js', 'server/src/services/webdav.js',
  'server/src/services/experts.js', 'server/src/services/mcp.js',
  'server/src/services/browser.js', 'server/src/services/software.js',
  'server/src/services/expert-builtin.js', 'server/src/services/dpapi.js',
  'server/src/services/dpapi-migrate.js', 'server/src/services/session-migrate.js',
  'server/src/registry.js', 'server/src/routes/jsapi.js',
  'server/src/app.js',
]
const rows = []
for (const m of mods) {
  const t0 = performance.now()
  try {
    await import(pathToFileURL(path.join(root, m)).href)
    rows.push([m, performance.now() - t0, 'ok'])
  } catch (e) {
    rows.push([m, performance.now() - t0, 'ERR ' + String(e).slice(0, 60)])
  }
}
rows.sort((a, b) => b[1] - a[1])
for (const [m, ms, st] of rows.slice(0, 16)) {
  console.log(ms.toFixed(1).padStart(8) + 'ms  ' + m + (st !== 'ok' ? '  ' + st : ''))
}
const total = rows.reduce((s, r) => s + r[1], 0)
console.log('sum(individual):', total.toFixed(1) + 'ms')
