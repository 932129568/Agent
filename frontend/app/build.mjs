#!/usr/bin/env node
/**
 * Harbor React 19 全量构建器（复用 frontend/react/node_modules，零额外依赖）
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

fs.mkdirSync(DIST, { recursive: true })

const result = await build({
  entryPoints: [path.join(HERE, 'src/main.jsx')],
  bundle: true,
  format: 'iife',
  outfile: path.join(DIST, 'app.js'),
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'automatic',
  minify: process.argv.includes('--minify'),
  sourcemap: process.argv.includes('--sourcemap'),
  legalComments: 'none',
  nodePaths: [REACT_MODULES],
  define: { 'process.env.NODE_ENV': '"production"' },
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
console.log('[harbor-app] OK dist/app.js=%dB dist/app.css=%dB dist/index.html', jsSize, cssSize)
