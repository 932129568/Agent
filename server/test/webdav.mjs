import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-dav-'))
process.env.HARBOR_CONFIG_DIR = path.join(tmp, 'config')
process.env.DATABASE_URL = `file:${path.join(tmp, 'app.db')}`
process.env.LOG_LEVEL = 'silent'
fs.mkdirSync(process.env.HARBOR_CONFIG_DIR, { recursive: true })
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
const results = []; const check = (name, fn) => { fn(); results.push(name) }

/* P0-1c WD1/WD2：未配置态语义（webdav_service.get_config/save_config/_record_for_io） */
const noConfig = JSON.parse(await webdav.webdavGetConfig())
check('WD1 未配置态 get → {ok, config:null}（文件不存在）', () => {
  assert.deepEqual(noConfig, { ok: true, config: null })
})
const noPwd = JSON.parse(await webdav.webdavSaveConfig(JSON.stringify({ url: config.url, username: 'user' })))
check('WD1 密码必填才落盘（校验失败文件不写）', () => {
  assert.equal(noPwd.ok, false)
  assert.equal(noPwd.error, '缺少 WebDAV 密码')
  assert.equal(fs.existsSync(path.join(process.env.HARBOR_CONFIG_DIR, 'webdav.json')), false)
})
const untested = JSON.parse(await webdav.webdavTest('{}'))
check('WD2 未配置检测在前（test 文案）', () => {
  assert.equal(untested.error, '未配置 WebDAV（设置 → 数据与备份）')
})
const unexported = JSON.parse(await webdav.webdavExport())
check('WD2 未配置导出仍返回 plan（三文件清单；本测试环境文件已在 → sha256 项）', () => {
  assert.equal(unexported.error, '未配置 WebDAV（设置 → 数据与备份）')
  assert.deepEqual(unexported.plan.map(x => x.path), ['config.json', 'sessions.json', 'audit_log.jsonl'])
})
const unrestored = JSON.parse(await webdav.webdavRestore('{}'))
check('WD2 未配置恢复返回 manifest 键（payload {} 解析为 {}）', () => {
  assert.equal(unrestored.error, '未配置 WebDAV（设置 → 数据与备份）')
  assert.deepEqual(unrestored.manifest, {})
})
const saved = JSON.parse(await webdav.webdavSaveConfig(JSON.stringify(config)))
check('WD1 合法保存 → {ok, config(无 password 回显)}', () => {
  assert.equal(saved.ok, true)
  assert.equal(saved.config.username, 'user')
  assert.equal(saved.config.password, undefined)
  assert.ok(fs.existsSync(path.join(process.env.HARBOR_CONFIG_DIR, 'webdav.json')))
})
const reread = JSON.parse(await webdav.webdavGetConfig())
check('WD1 保存后回读 → config 键白名单视图', () => {
  assert.equal(reread.ok, true)
  assert.equal(reread.config.url, config.url)
  assert.equal(reread.config.remote_path, '/backup')
})
const tested = JSON.parse(await webdav.webdavTest(JSON.stringify(config)))
check('OPTIONS + PROPFIND 连通性与 Basic Auth', () => assert.equal(tested.ok, true))
const exported = JSON.parse(await webdav.webdavExport())
check('导出 MKCOL + 三文件 + manifest', () => {
  assert.equal(exported.ok, true)
  assert.deepEqual(exported.uploaded.sort(), ['audit_log.jsonl', 'config.json', 'sessions.json'])
  assert.ok(methods.includes('MKCOL'))
  assert.equal(exported.manifest.items.length, 3)
})
check('远端 manifest 与文件已实际保存', () => {
  assert.ok([...remote.keys()].some(k => k.endsWith('/backup/manifest.json')))
  assert.ok([...remote.keys()].some(k => k.endsWith('/backup/config.json')))
})
// 模拟另一台机器推进了远端版本：本地与远端都相对零基线变化，形成真冲突。
for (const key of remote.keys()) {
  if (!key.endsWith('manifest.json')) remote.set(key, Buffer.from(`remote:${path.basename(key)}`))
}
const baseline = { version: 1, items: exported.manifest.items.map(x => ({ ...x, sha256: '0'.repeat(64) })) }
const restored = JSON.parse(await webdav.webdavRestore(JSON.stringify(baseline)))
check('冲突按 remote_wins 下载并原子落盘', () => {
  assert.equal(restored.ok, true)
  assert.equal(restored.applied.length, 3)
  assert.equal(fs.readFileSync(path.join(process.env.HARBOR_CONFIG_DIR, 'config.json'), 'utf8'), 'remote:config.json')
})
const evil = JSON.parse(await webdav.webdavTest(JSON.stringify({ ...config, remote_path: '/a/../../etc' })))
check('远端目录穿越被拒绝', () => assert.ok(evil.error.includes('..') || evil.error.includes('穿越')))
const insecure = JSON.parse(await webdav.webdavTest(JSON.stringify({ ...config, url: 'http://example.com' })))
check('非本机明文 HTTP 被拒绝', () => assert.ok(insecure.error.includes('https')))
await new Promise(resolve => server.close(resolve))
console.log(JSON.stringify({ ok: true, checks: results.length, results }, null, 2))
