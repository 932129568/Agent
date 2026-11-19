/**
 * R70 / I19：readJsonIfExists 零行为变更回归（node --test）。
 *
 * 裁决 3 口径：函数仍返回 fallback、不抛异常；但非 ENOENT / 非 SyntaxError
 * 的意外 I/O 异常必须写入有界结构化 readJsonWarnings（含 code/path），
 * 不得静默吞掉。本用例覆盖「损坏 JSON → fallback」与「模拟 EACCES → warnings 非空」。
 *
 * 文件用 .js 后缀：server_gates() 只 glob *.mjs，故本用例不新增门禁、不破坏
 * 现行 35 门统计；由 `node --test server/test/paths-readjson.test.js` 显式运行。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readJsonIfExists, readJsonWarnings } from '../src/paths.js'

/** 创建临时目录并返回其路径（用例结束由调用方清理）。 */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-i19-'))
}

test('损坏 JSON 返回 fallback，且不产生 warning（预期路径不记噪声）', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'broken.json')
  fs.writeFileSync(file, '{ not valid json', 'utf8')
  const before = readJsonWarnings.length
  try {
    assert.deepEqual(readJsonIfExists(file, { fallback: true }), { fallback: true })
    assert.equal(readJsonWarnings.length, before, 'SyntaxError 属预期情形，不应记 warning')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('文件缺失（ENOENT）返回 fallback，且不产生 warning', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'missing.json')
  const before = readJsonWarnings.length
  try {
    assert.equal(readJsonIfExists(file, 'FALLBACK'), 'FALLBACK')
    assert.equal(readJsonWarnings.length, before, 'ENOENT 属预期情形，不应记 warning')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('模拟 EACCES：仍返回 fallback 且 warnings 非空（含 code/path）', () => {
  const original = fs.readFileSync
  const before = readJsonWarnings.length
  const target = path.join(tmpDir(), 'eacces.json')
  fs.readFileSync = () => {
    const error = new Error('simulated permission denied')
    error.code = 'EACCES'
    throw error
  }
  try {
    assert.equal(readJsonIfExists(target, 'FALLBACK'), 'FALLBACK',
      '零行为变更：意外 I/O 异常也不得抛出')
    assert.equal(readJsonWarnings.length, before + 1, 'EACCES 必须留痕')
    const last = readJsonWarnings[readJsonWarnings.length - 1]
    assert.equal(last.code, 'EACCES')
    assert.equal(last.path, target)
  } finally {
    fs.readFileSync = original
  }
})

test('warnings 有界：连续注入 40 次后长度不超过上限 32', () => {
  const original = fs.readFileSync
  fs.readFileSync = () => {
    const error = new Error('simulated')
    error.code = 'EIO'
    throw error
  }
  try {
    for (let i = 0; i < 40; i += 1) {
      assert.equal(readJsonIfExists('any.json', null), null)
    }
    assert.ok(readJsonWarnings.length <= 32,
      'warnings 必须有界，不能随长跑无限增长')
  } finally {
    fs.readFileSync = original
  }
})
