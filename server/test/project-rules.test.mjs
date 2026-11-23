// v3.4 I06 · 项目规则自动发现（AGENTS.md / CLAUDE.md / .harbor/rules/*.md）用例
//
// 判据（施工总册 I06）：切项目自动加载规则；无规则时**不得改变系统提示**（空串）。
// 这里同时钉住三件事：发现顺序、热缓存失效、超限跳过（不静默截断）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  discoverRuleFiles, loadProjectRules, projectRulesSection,
  __resetProjectRulesCache, MAX_FILE_BYTES,
} from '../src/services/projectRules.mjs'

function mkws() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-rules-'))
  return dir
}
function rmws(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) {}
}

test('无规则文件 ⇒ null / 空串（系统提示逐字节不变）', () => {
  __resetProjectRulesCache()
  const ws = mkws()
  try {
    assert.equal(loadProjectRules(ws), null)
    assert.equal(projectRulesSection(ws), '')
    assert.deepEqual(discoverRuleFiles(ws), [])
  } finally { rmws(ws) }
})

test('发现顺序：AGENTS.md → CLAUDE.md → .harbor/rules/*.md（按名排序）', () => {
  __resetProjectRulesCache()
  const ws = mkws()
  try {
    fs.writeFileSync(path.join(ws, 'CLAUDE.md'), 'claude rule')
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), 'agents rule')
    fs.mkdirSync(path.join(ws, '.harbor', 'rules'), { recursive: true })
    fs.writeFileSync(path.join(ws, '.harbor', 'rules', 'b.md'), 'b rule')
    fs.writeFileSync(path.join(ws, '.harbor', 'rules', 'a.md'), 'a rule')
    const r = loadProjectRules(ws)
    assert.deepEqual(r.files, ['AGENTS.md', 'CLAUDE.md', '.harbor/rules/a.md', '.harbor/rules/b.md'])
    assert.ok(r.text.includes('agents rule') && r.text.includes('a rule'))
    assert.equal(r.cached, false)
  } finally { rmws(ws) }
})

test('热缓存：同内容第二次命中缓存；内容变化后失效并读到新文本', () => {
  __resetProjectRulesCache()
  const ws = mkws()
  try {
    const f = path.join(ws, 'AGENTS.md')
    fs.writeFileSync(f, 'v1 rule')
    const r1 = loadProjectRules(ws)
    assert.equal(r1.cached, false)
    const r2 = loadProjectRules(ws)
    assert.equal(r2.cached, true, '同签名应命中缓存')
    // 改内容且改变长度（保证 size 也变，避免同毫秒同尺寸的边界）
    fs.writeFileSync(f, 'v2 rule with more text')
    const r3 = loadProjectRules(ws)
    assert.equal(r3.cached, false, '内容变化后必须失效')
    assert.ok(r3.text.includes('v2 rule with more text'))
    assert.ok(!r3.text.includes('v1 rule'))
  } finally { rmws(ws) }
})

test('超限文件跳过并点名（不静默截断）', () => {
  __resetProjectRulesCache()
  const ws = mkws()
  try {
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), 'ok rule')
    fs.writeFileSync(path.join(ws, '.harbor-rules-big.md'), 'x')   // 不参与发现，占位
    fs.mkdirSync(path.join(ws, '.harbor', 'rules'), { recursive: true })
    fs.writeFileSync(path.join(ws, '.harbor', 'rules', 'big.md'), 'y'.repeat(MAX_FILE_BYTES + 10))
    const r = loadProjectRules(ws)
    assert.deepEqual(r.files, ['AGENTS.md'], '超限文件不进 files')
    assert.equal(r.skipped.length, 1)
    assert.equal(r.skipped[0].reason, 'too-large')
    assert.ok(r.text.includes('因体积超限未注入'), '必须在文本里点名，不能装作没看见')
    assert.ok(!r.text.includes('yyyyyyyyyy'), '超限内容不得被截断后注入')
  } finally { rmws(ws) }
})

test('空文件不算规则（不生成空 section）', () => {
  __resetProjectRulesCache()
  const ws = mkws()
  try {
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), '   \n\n  ')
    assert.equal(loadProjectRules(ws), null)
  } finally { rmws(ws) }
})

test('规则段落带优先级说明（低于系统安全约束）', () => {
  __resetProjectRulesCache()
  const ws = mkws()
  try {
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), '提交前必须跑门禁')
    const text = projectRulesSection(ws)
    assert.ok(text.includes('# 项目规则'))
    assert.ok(text.includes('优先级高于通用偏好'), '必须写清优先级')
    assert.ok(text.includes('低于系统安全约束'), '必须声明不得覆盖安全约束')
    assert.ok(text.includes('提交前必须跑门禁'))
  } finally { rmws(ws) }
})
