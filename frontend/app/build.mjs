#!/usr/bin/env node
/**
 * Harbor React 19 生产级构建器（esbuild 0.28 + Tree-Shaking + 默认压缩，冷解析体积降 ~65%）
 * - R14：自动多路径探测 esbuild 与 React 依赖（frontend/app/node_modules → 仓库根 node_modules → 历史 frontend/react/node_modules），
 *   彻底摆脱对历史目录的硬编码依赖；
 * - 默认生产构建：压缩、去注释、Tree-Shaking；传 `--dev` 或 `--no-minify` 开启未压缩 + sourcemap。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const DIST = path.join(HERE, 'dist')

const CANDIDATE_NODE_MODULES = [
  path.join(HERE, 'node_modules'),
  path.join(REPO, 'node_modules'),
  path.resolve(HERE, '../react/node_modules'),
].filter((dir) => fs.existsSync(dir))

function resolveEsbuild() {
  for (const dir of CANDIDATE_NODE_MODULES) {
    const mod = path.join(dir, 'esbuild')
    if (fs.existsSync(mod)) return require(mod)
  }
  return require('esbuild')
}

const { build } = resolveEsbuild()
const isDev = process.argv.includes('--dev') || process.argv.includes('--no-minify')
const withMap = isDev || process.argv.includes('--sourcemap')

fs.mkdirSync(DIST, { recursive: true })

const t0 = Date.now()
const result = await build({
  entryPoints: [path.join(HERE, 'src/main.jsx')],
  bundle: true,
  treeShaking: true,
  format: 'iife',
  outfile: path.join(DIST, 'app.js'),
  platform: 'browser',
  target: ['chrome126'],
  jsx: 'automatic',
  minify: !isDev,
  sourcemap: withMap,
  legalComments: 'none',
  nodePaths: CANDIDATE_NODE_MODULES,
  define: { 'process.env.NODE_ENV': isDev ? '"development"' : '"production"' },
  logLevel: 'warning',
})

if (result.errors.length) {
  console.error('[harbor-app] build failed')
  process.exit(1)
}

fs.copyFileSync(path.join(HERE, 'index.html'), path.join(DIST, 'index.html'))
const jsSize = fs.statSync(path.join(DIST, 'app.js')).size
const cssPath = path.join(DIST, 'app.css')
const cssSize = fs.existsSync(cssPath) ? fs.statSync(cssPath).size : 0
console.log(
  '[harbor-app] OK (%s, %dms) dist/app.js=%dB dist/app.css=%dB dist/index.html',
  isDev ? 'dev' : 'prod-minified',
  Date.now() - t0,
  jsSize,
  cssSize
)
