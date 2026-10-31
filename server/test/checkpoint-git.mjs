/** git 检查点：只恢复声明文件；未声明改动与回滚前版本均保留。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-checkpoint-git-'))
const ws = path.join(tmp, 'repo')
fs.mkdirSync(ws, { recursive: true })
process.env.HARBOR_CONFIG_DIR = path.join(tmp, 'config')
process.env.DATABASE_URL = `file:${path.join(tmp, 'app.db')}`
process.env.LOG_LEVEL = 'silent'
const plans = await import('../src/services/plans.js')
const git = async (...args) => run('git', args, { cwd: ws, windowsHide: true })
const results = []
const check = (name, fn) => { fn(); results.push(name) }
try {
  await git('init')
  await git('config', 'user.email', 'harbor-test@example.invalid')
  await git('config', 'user.name', 'Harbor Test')
  fs.writeFileSync(path.join(ws, 'tracked.txt'), 'head-version')
  fs.writeFileSync(path.join(ws, 'unrelated.txt'), 'unrelated-head')
  await git('add', 'tracked.txt', 'unrelated.txt')
  await git('commit', '-m', 'initial')
  fs.writeFileSync(path.join(ws, 'tracked.txt'), 'pre-checkpoint-work')
  const created = JSON.parse(await plans.checkpointCreate('task_git', ['tracked.txt', 'new-later.txt'], ws))
  check('git 检查点记录 HEAD 与创建时缺失文件', () => {
    assert.equal(created.ok, true, JSON.stringify(created))
    assert.equal(created.mode, 'git')
    assert.ok(created.git_head)
    assert.equal(created.snapshot_count, 0)
  })
  fs.writeFileSync(path.join(ws, 'tracked.txt'), 'after-checkpoint')
  fs.writeFileSync(path.join(ws, 'new-later.txt'), 'created-after-checkpoint')
  fs.writeFileSync(path.join(ws, 'unrelated.txt'), 'user-change-must-survive')
  const refused = JSON.parse(await plans.checkpointRollback('task_git', ws, false))
  check('git 回滚仍需显式 confirm', () => assert.equal(refused.error.code, 'CONFIRM_REQUIRED'))
  const rolled = JSON.parse(await plans.checkpointRollback('task_git', ws, true))
  check('差异恢复声明文件并删除后建同名文件', () => {
    assert.equal(rolled.ok, true, JSON.stringify(rolled))
    assert.equal(rolled.verified, true)
    assert.deepEqual(rolled.restored, ['tracked.txt'])
    assert.deepEqual(rolled.deleted, ['new-later.txt'])
    assert.equal(fs.readFileSync(path.join(ws, 'tracked.txt'), 'utf8'), 'head-version')
    assert.equal(fs.existsSync(path.join(ws, 'new-later.txt')), false)
  })
  check('未声明文件与回滚前版本均保留', () => {
    assert.equal(fs.readFileSync(path.join(ws, 'unrelated.txt'), 'utf8'), 'user-change-must-survive')
    assert.equal(fs.readFileSync(path.join(ws, 'tracked.txt.rollback-bak'), 'utf8'), 'after-checkpoint')
    assert.equal(fs.readFileSync(path.join(ws, 'new-later.txt.rollback-bak'), 'utf8'), 'created-after-checkpoint')
  })
  const invalid = JSON.parse(await plans.checkpointCreate('../escape', [], ws))
  check('task_id 路径穿越返回 BAD_PARAMS', () => assert.equal(invalid.error.code, 'BAD_PARAMS'))
  console.log(JSON.stringify({ ok: true, checks: results.length, results }, null, 2))
} catch (error) {
  if (/ENOENT/.test(error.message || '') && /git/.test(error.message || '')) {
    console.log(JSON.stringify({ ok: true, skipped: 'git 不可用', checks: 0 }))
  } else throw error
}
