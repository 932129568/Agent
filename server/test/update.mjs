import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-update-test-'))
process.env.HARBOR_UPDATE_DIR = path.join(tmp, 'update')
process.env.HARBOR_CONFIG_DIR = path.join(tmp, 'config')
process.env.DATABASE_URL = `file:${path.join(tmp, 'app.db')}`
process.env.LOG_LEVEL = 'silent'

const payload = Buffer.from('harbor-signed-update-payload')
const sha256 = crypto.createHash('sha256').update(payload).digest('hex')
const realFetch = globalThis.fetch
let mode = 'manifest'
globalThis.fetch = async (url, options) => {
  assert.equal(options.redirect, 'error')
  if (mode === 'manifest') {
    return new Response(JSON.stringify({ version: '99.0.0', url: 'https://updates.invalid/app.exe', sha256, notes: 'test' }),
      { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (mode === 'bad') return new Response('corrupted', { status: 200 })
  return new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } })
}

const update = await import('../src/services/update.js')
const results = []
const check = (name, fn) => { fn(); results.push(name) }

const manifest = JSON.parse(await update.checkUpdate('https://updates.invalid/manifest.json'))
check('manifest 检查识别新版本且禁重定向', () => {
  assert.equal(manifest.update_available, true)
  assert.equal(manifest.latest, '99.0.0')
})
const httpManifest = JSON.parse(await update.checkUpdate('http://localhost/x'))
check('http manifest 被拒绝', () => assert.ok(httpManifest.error.includes('https')))
const httpDownload = JSON.parse(await update.startUpdateDownload('http://localhost/x', sha256, '2.0.0'))
check('http 下载地址被拒绝', () => assert.ok(httpDownload.error.includes('https')))
const badVersion = JSON.parse(await update.startUpdateDownload('https://localhost/x', sha256, '../x'))
check('路径穿越版本号被拒绝', () => assert.ok(badVersion.error.includes('非法字符')))
const noSha = JSON.parse(await update.startUpdateDownload('https://localhost/x', '', '2.0.0'))
check('缺 sha256 被拒绝', () => assert.ok(noSha.error.includes('sha256')))

mode = 'download'
assert.equal(JSON.parse(await update.startUpdateDownload('https://updates.invalid/app.exe', sha256, '2.0.0')).ok, true)
let progress
for (let i = 0; i < 100; i++) {
  progress = JSON.parse(await update.getUpdateProgress())
  if (progress.state !== 'downloading') break
  await new Promise(resolve => setTimeout(resolve, 20))
}
check('后台下载完成并通过 SHA256 校验', () => {
  assert.equal(progress.state, 'done')
  assert.equal(progress.pct, 100)
  assert.equal(fs.readFileSync(progress.path, 'utf8'), payload.toString())
})
const restart = JSON.parse(await update.startUpdateDownload('https://updates.invalid/app.exe', sha256, '2.0.1'))
check('重复下载完成态可再次启动', () => assert.equal(restart.ok, true))
for (let i = 0; i < 100 && JSON.parse(await update.getUpdateProgress()).state === 'downloading'; i++) await new Promise(r => setTimeout(r, 20))
const applied = JSON.parse(await update.applyUpdate())
check('开发模式 apply 明确拒绝且不自替换', () => assert.ok(applied.error.includes('开发模式')))

globalThis.fetch = realFetch
console.log(JSON.stringify({ ok: true, checks: results.length, results }, null, 2))
