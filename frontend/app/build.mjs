#!/usr/bin/env node
/**
 * Harbor React 19 生产级构建器（esbuild 0.28 + Tree-Shaking + 默认压缩，冷解析体积降 ~65%）
 * - 默认生产构建：压缩、去注释、Tree-Shaking；
 * - 开发调试构建：传 `--dev` 或 `--no-minify` 开启未压缩输出 + sourcemap。
 * 产出：frontend/app/dist/{index.html, app.js, app.css}
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(HERE, 'dist')
const REACT_MODULES = path.resolve(HERE, '../react/node_modules')
const { build } = require(path.join(REACT_MODULES, 'esbuild'))

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
  nodePaths: [REACT_MODULES],
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
