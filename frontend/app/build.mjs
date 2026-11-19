#!/usr/bin/env node
/**
 * 规范化 React 工程的骨架构建（规范 §10）。
 *
 * 当前阶段**不接入生产链**：只产出 frontend/app/dist/harbor-app.iife.js 供评审与
 * 骨架自检，绝不写 harbor.html、绝不覆盖 frontend/react/dist/ 的现有产物。
 * 评审确认后，把 outfile 接入 frontend/build.js 的 prebuilt 链即为正式构建。
 */
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { statSync } from 'node:fs'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const REACT_MODULES = resolve(HERE, '../react/node_modules')
const { build } = require('../react/node_modules/esbuild')

const result = await build({
  entryPoints: [resolve(HERE, 'src/main.jsx')],
  bundle: true,
  format: 'iife',
  globalName: 'HarborApp',
  outfile: resolve(HERE, 'dist/harbor-app.iife.js'),
  platform: 'browser',
  target: ['chrome110'],
  jsx: 'automatic',
  minify: false,
  legalComments: 'none',
  nodePaths: [REACT_MODULES],
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: '/* Harbor normalized React app (R68 skeleton) - generated, do not edit. */' },
  logLevel: 'warning',
})
if (result.errors.length) {
  console.error('[app-build] 失败')
  process.exit(1)
}
console.log('[app-build] OK dist/harbor-app.iife.js %d B',
  statSync(resolve(HERE, 'dist/harbor-app.iife.js')).size)
