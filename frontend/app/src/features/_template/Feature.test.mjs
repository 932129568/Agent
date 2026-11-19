/**
 * 迁移模板自身的契约测试（规范 §4：每个 feature 目录必须带 *.test.*）。
 * 防止模板退化成"能看不能用"的空壳：四件套齐全、各自显式 export、零禁用 API。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))
const REQUIRED = ['TEMPLATE.md', 'Feature.jsx', 'useFeature.js', 'service.js']
const FORBIDDEN = /innerHTML|appendChild|document\.getElementById|new\s+Function|data-h-events/

test('模板四件套齐全', () => {
  for (const name of REQUIRED) {
    assert.ok(existsSync(join(DIR, name)), '缺少模板文件: ' + name)
  }
})

test('模板源文件显式 export 且零禁用 API', () => {
  for (const name of REQUIRED.filter(n => /\.jsx?$/.test(n))) {
    const text = readFileSync(join(DIR, name), 'utf8')
    assert.match(text, /\bexport\b/, name + ' 必须显式 export')
    assert.doesNotMatch(text, FORBIDDEN, name + ' 含禁用 API')
  }
})

test('模板 checklist 含 R65 教训条目', () => {
  const md = readFileSync(join(DIR, 'TEMPLATE.md'), 'utf8')
  assert.match(md, /旧 vm harness 钉/)
  assert.match(md, /为何该钉不再以旧形态存在/)
  assert.match(md, /生产零调用/)
})

test('模板依赖方向向下（不 import app/）', () => {
  for (const name of ['Feature.jsx', 'useFeature.js', 'service.js']) {
    const text = readFileSync(join(DIR, name), 'utf8')
    assert.doesNotMatch(text, /\.\.\/\.\.\/app\//, name + ' 不得反向依赖 app/')
    assert.doesNotMatch(text, /from\s+['"]\.\.\/\.\.\/main\.jsx['"]/)
  }
})

test('规范工程存在可复跑脚手架', () => {
  const root = resolve(DIR, '../../..')
  assert.ok(existsSync(join(root, 'tools/gen-layout.mjs')))
  assert.ok(existsSync(join(root, 'docs/skeleton-manifest.json')))
})
