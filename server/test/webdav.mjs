import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-dav-'))
process.env.HARBOR_CONFIG_DIR = path.join(tmp, 'config')
process.env.DATABASE_URL = `file:${path.join(tmp, 'app.db')}`
process.env.LOG_LEVEL = 'silent'
fs.mkdirSync(process.env.HARBOR_CONFIG_DIR, { recursive: true })
// T04 起本组测试使用 Prisma 会话库（物化导出/恢复导入）——先建表
await execFileAsync(process.execPath,
  ['node_modules/prisma/build/index.js', 'db', 'push', '--schema=./prisma/schema.prisma'],
  { cwd: serverRoot, env: process.env })
fs.writeFileSync(path.join(process.env.HARBOR_CONFIG_DIR, 'config.json'), '{"model":"demo"}')
fs.writeFileSync(path.join(process.env.HARBOR_CONFIG_DIR, 'sessions.json'), '[{"id":"s1"}]')
fs.writeFileSync(path.join(process.env.HARBOR_CONFIG_DIR, 'audit_log.jsonl'), '{"ok":true}\n')

const remote = new Map(); const methods = []
const server = http.createServer(async (req, res) => {
  methods.push(req.method)
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks)
  if (req.headers.authorization !== `Basic ${Buffer.from('user:pass').toString('base64')}`) { res.writeHead(401); res.end('bad auth'); return }
  if (req.method === 'OPTIONS') { res.writeHead(200, { DAV: '1,2' }); res.end(); return }
  if (req.method === 'PROPFIND') { res.writeHead(207); res.end('<multistatus/>'); return }
  if (req.method === 'MKCOL') { res.writeHead(201); res.end(); return }
  if (req.method === 'PUT') { remote.set(req.url, body); res.writeHead(201); res.end(); return }
  if (req.method === 'GET' && remote.has(req.url)) { res.writeHead(200); res.end(remote.get(req.url)); return }
  res.writeHead(404); res.end('missing')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const config = { url: `http://127.0.0.1:${port}`, username: 'user', password: 'pass', remote_path: '/backup', conflict_policy: 'remote_wins' }

const webdav = await import('../src/services/webdav.js')
const sessions = await import('../src/services/sessions.js')
const results = []; const check = async (name, fn) => { await fn(); results.push(name) }

/* P0-1c WD1/WD2：未配置态语义（webdav_service.get_config/save_config/_record_for_io） */
const noConfig = JSON.parse(await webdav.webdavGetConfig())
await check('WD1 未配置态 get → {ok, config:null}（文件不存在）', () => {
  assert.deepEqual(noConfig, { ok: true, config: null })
})
const noPwd = JSON.parse(await webdav.webdavSaveConfig(JSON.stringify({ url: config.url, username: 'user' })))
await check('WD1 密码必填才落盘（校验失败文件不写）', () => {
  assert.equal(noPwd.ok, false)
  assert.equal(noPwd.error, '缺少 WebDAV 密码')
  assert.equal(fs.existsSync(path.join(process.env.HARBOR_CONFIG_DIR, 'webdav.json')), false)
})
const untested = JSON.parse(await webdav.webdavTest('{}'))
await check('WD2 未配置检测在前（test 文案）', () => {
  assert.equal(untested.error, '未配置 WebDAV（设置 → 数据与备份）')
})
const unexported = JSON.parse(await webdav.webdavExport())
await check('WD2 未配置导出仍返回 plan（三文件清单；本测试环境文件已在 → sha256 项）', () => {
  assert.equal(unexported.error, '未配置 WebDAV（设置 → 数据与备份）')
  assert.deepEqual(unexported.plan.map(x => x.path), ['config.json', 'sessions.json', 'audit_log.jsonl'])
})
const unrestored = JSON.parse(await webdav.webdavRestore('{}'))
await check('WD2 未配置恢复返回 manifest 键（payload {} 解析为 {}）', () => {
  assert.equal(unrestored.error, '未配置 WebDAV（设置 → 数据与备份）')
  assert.deepEqual(unrestored.manifest, {})
})
const saved = JSON.parse(await webdav.webdavSaveConfig(JSON.stringify(config)))
await check('WD1 合法保存 → {ok, config(无 password 回显)}', () => {
  assert.equal(saved.ok, true)
  assert.equal(saved.config.username, 'user')
  assert.equal(saved.config.password, undefined)
  assert.ok(fs.existsSync(path.join(process.env.HARBOR_CONFIG_DIR, 'webdav.json')))
})
const reread = JSON.parse(await webdav.webdavGetConfig())
await check('WD1 保存后回读 → config 键白名单视图', () => {
  assert.equal(reread.ok, true)
  assert.equal(reread.config.url, config.url)
  assert.equal(reread.config.remote_path, '/backup')
})

/* P0-2 T03：DPAPI 字段级加密（Password 密文落盘 / 读取解密 / IO 前解密） */
const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.HARBOR_CONFIG_DIR, 'webdav.json'), 'utf8'))
await check('T03 password 以 dpapi: 前缀密文落盘（文件无明文）', () => {
  assert.ok(onDisk.password.startsWith('dpapi:'))
  assert.ok(!onDisk.password.includes('pass'))
})
await check('T03 get_config 解密回显明文 password', () => {
  assert.equal(reread.config.password, 'pass')
})
const savedAgain = JSON.parse(await webdav.webdavSaveConfig(JSON.stringify(config)))
await check('T03 DPAPI 可用时无 W17 warning；重复保存幂等', () => {
  assert.equal(savedAgain.ok, true)
  assert.equal(savedAgain.warning, undefined)
})
const tested = JSON.parse(await webdav.webdavTest(JSON.stringify(config)))
await check('OPTIONS + PROPFIND 连通性与 Basic Auth', () => assert.equal(tested.ok, true))
// T04 前置：DB 写入一条会话（物化导出数据源）
await sessions.saveSessions(JSON.stringify([{ id: 'dav-s1', title: '备份会话', updatedAt: 1000,
  messages: [{ role: 'user', content: '备份内容🚀' }] }]))
const exported = JSON.parse(await webdav.webdavExport())
await check('导出 MKCOL + 三文件 + manifest', () => {
  assert.equal(exported.ok, true)
  assert.deepEqual(exported.uploaded.sort(), ['audit_log.jsonl', 'config.json', 'sessions.json'])
  assert.ok(methods.includes('MKCOL'))
  assert.equal(exported.manifest.items.length, 3)
})
await check('T04：sessions.json 由 DB 物化生成（含 dav-s1 与 messages 全文）', () => {
  const key = [...remote.keys()].find(k => k.endsWith('/backup/sessions.json'))
  assert.ok(key, '远端应有 sessions.json（物化导出）')
  const arr = JSON.parse(remote.get(key).toString('utf8'))
  assert.equal(arr.length, 1)
  assert.equal(arr[0].id, 'dav-s1')
  assert.equal(arr[0].messages[0].content, '备份内容🚀')
})
await check('远端 manifest 与文件已实际保存', () => {
  assert.ok([...remote.keys()].some(k => k.endsWith('/backup/manifest.json')))
  assert.ok([...remote.keys()].some(k => k.endsWith('/backup/config.json')))
})
// 模拟另一台机器推进了远端版本：本地与远端都相对零基线变化，形成真冲突。
// sessions.json 远端必须是合法 JSON 数组（T04：恢复经 DB 导入而非写文件）
for (const key of remote.keys()) {
  if (key.endsWith('manifest.json')) continue
  if (key.endsWith('sessions.json')) {
    remote.set(key, Buffer.from(JSON.stringify([{ id: 'remote-s1', title: '远端会话', updatedAt: 2000, messages: [] }])))
  } else remote.set(key, Buffer.from(`remote:${path.basename(key)}`))
}
const baseline = { version: 1, items: exported.manifest.items.map(x => ({ ...x, sha256: '0'.repeat(64) })) }
const restored = JSON.parse(await webdav.webdavRestore(JSON.stringify(baseline)))
await check('冲突按 remote_wins 下载并原子落盘', () => {
  assert.equal(restored.ok, true)
  assert.equal(restored.applied.length, 3)
  assert.equal(fs.readFileSync(path.join(process.env.HARBOR_CONFIG_DIR, 'config.json'), 'utf8'), 'remote:config.json')
})
await check('T04：sessions.json 恢复经 importLegacySessions(replace) 写回 DB', async () => {
  const after = JSON.parse(await sessions.getSessions())
  assert.deepEqual(after.map(x => x.id), ['remote-s1'])
})
await check('T04：restore 前自动备份当前 DB（harbor.db.pre-restore.bak）', () => {
  assert.ok(fs.existsSync(path.join(process.env.HARBOR_CONFIG_DIR, 'harbor.db.pre-restore.bak')))
})
const evil = JSON.parse(await webdav.webdavTest(JSON.stringify({ ...config, remote_path: '/a/../../etc' })))
await check('远端目录穿越被拒绝', () => assert.ok(evil.error.includes('..') || evil.error.includes('穿越')))
const insecure = JSON.parse(await webdav.webdavTest(JSON.stringify({ ...config, url: 'http://example.com' })))
await check('非本机明文 HTTP 被拒绝', () => assert.ok(insecure.error.includes('https')))
await new Promise(resolve => server.close(resolve))
console.log(JSON.stringify({ ok: true, checks: results.length, results }, null, 2))
