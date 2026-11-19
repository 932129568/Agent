/**
 * 群文件写/读链回归（R62 C3：R57 只移植读侧四方法，group_files_write/read 恒
 * NOT_MIGRATED——前端归档静默吞错，群文件面板永远为空，真机实证）。
 * 运行：node server/test/group-files.mjs
 *
 * 走 fastify inject 真实路由（含注册表白名单断言）+ 落盘数据契约对齐
 * group_files_service.py（目录哈希 g<digest*131 % 10^10> / 头部元信息 / 同秒
 * 同名序号 / root 监狱）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-group-files-'))
process.env.HARBOR_CONFIG_DIR = path.join(tmp, 'config')
process.env.DATABASE_URL = `file:${path.join(tmp, 'app.db')}`
process.env.LOG_LEVEL = 'silent'

const { pathToFileURL } = await import('node:url')
const { buildServer } = await import('../src/app.js')
const app = await buildServer()

const SID = 's_group_test_1'
const post = async (name, args) => {
  const r = await app.inject({
    method: 'POST', url: '/jsapi/' + name,
    headers: { 'x-harbor-sid': SID },
    payload: { args: args || [] },
  })
  return JSON.parse(r.body)
}

const results = []
const check = (name, fn) => { fn(); results.push(name) }

/* 1) write：NOT_MIGRATED 根因回归——jsapi 必须真落盘 */
const w1 = await post('group_files_write', [SID, '👥 测试群', '主持人', '接口规划', '本次产出：接口字段表\n- GET /items', JSON.stringify({ to: '前端', round: 1, keywords: '接口 字段' })])
check('group_files_write 返回 ok + 落盘路径（不再 NOT_MIGRATED）', () => {
  assert.equal(w1.ok, true, 'write 失败: ' + JSON.stringify(w1))
  assert.ok(w1.path && fs.existsSync(w1.path))
  assert.match(w1.name, /^\d{8}-\d{6}_主持人_接口规划\.md$/)
})

/* 2) 头部元信息契约（检索加权数据源） */
const head = fs.readFileSync(w1.path, 'utf8')
check('头部 harbor-group-file 元信息（group/member/to/title/keywords/round）', () => {
  assert.match(head, /<!--\s*harbor-group-file/)
  assert.match(head, /member: 主持人/)
  assert.match(head, /to: 前端/)
  assert.match(head, /title: 接口规划/)
  assert.match(head, /keywords: 接口 字段/)
  assert.match(head, /round: 1/)
  assert.ok(head.includes('GET /items'))
})

/* 3) 目录哈希对齐 Python：digest*131 % 10^10 → g<digest> */
check('目录哈希对齐 group_files_service.py（g<digest>）', () => {
  let digest = 0
  for (const ch of SID) digest = (digest * 131 + ch.charCodeAt(0)) % 10 ** 10
  assert.equal(path.dirname(w1.path), path.join(process.env.HARBOR_CONFIG_DIR, 'group_files', 'g' + digest))
})

/* 4) 同名写入：同秒追加序号 -2，跨秒用新时间戳；两种情形都绝不覆盖。
 * R69：原断言硬编码 -2.md，两次 HTTP 写入跨秒时会偶发失败（命名实现的时间戳
 * 精确到秒）。此处按实际秒戳分支断言，同秒仍严格要求 -2，未放宽任何语义。 */
const w2 = await post('group_files_write', [SID, '👥 测试群', '主持人', '接口规划', '第二份'])
check('同名写入绝不覆盖（同秒序号 / 跨秒新时间戳）', () => {
  assert.equal(w2.ok, true)
  assert.notEqual(w2.name, w1.name)
  assert.ok(fs.existsSync(w1.path) && fs.existsSync(w2.path))
  assert.match(w2.name, /^\d{8}-\d{6}_主持人_接口规划(?:-\d+)?\.md$/)
  if (w1.name.slice(0, 15) === w2.name.slice(0, 15)) {
    assert.match(w2.name, /-2\.md$/, '同秒同名必须追加序号 -2')
  }
})

/* 5) list：索引与扫盘双通道都能见到 */
const l1 = await post('group_files_list', [SID, '👥 测试群'])
check('group_files_list 含新归档（最新在前）', () => {
  assert.equal(l1.ok, true)
  const names = (l1.files || []).map(f => f.name)
  assert.ok(names.includes(w1.name) && names.includes(w2.name))
  assert.equal(l1.files[0].name, w2.name)
})

/* 6) search：标题/关键词/正文加权命中 */
const s1 = await post('group_files_search', [SID, '接口字段', 8])
check('group_files_search 命中并回片段', () => {
  assert.equal(s1.ok, true)
  assert.ok((s1.count || 0) >= 1)
  assert.ok((s1.hits || []).some(h => h.name === w1.name && h.snippet))
})

/* 7) read：绝对路径读全文 + root 监狱 */
const r1 = await post('group_files_read', [w1.path])
check('group_files_read 回全文（不再 NOT_MIGRATED）', () => {
  assert.equal(r1.ok, true)
  assert.ok(r1.text.includes('GET /items'))
  assert.equal(r1.path, w1.path)
})
fs.writeFileSync(path.join(tmp, 'outside.md'), 'x')   // 存在但仍在监狱外
const r2 = await post('group_files_read', [path.join(tmp, 'outside.md')])
check('read 监狱：群文件目录外拒绝', () => {
  assert.equal(r2.ok, undefined)
  assert.match(String(r2.error || ''), /路径越界/)
})

/* 8) 空内容拒绝 */
const w3 = await post('group_files_write', [SID, '👥 测试群', '主持人', '空文档', '   '])
check('空交接文档内容拒绝', () => {
  assert.equal(w3.ok, undefined)
  assert.match(String(w3.error || ''), /内容为空/)
})

/* 9) delete：文件与索引同步摘除 */
const d1 = await post('group_files_delete', [SID, w2.name])
const l2 = await post('group_files_list', [SID, '👥 测试群'])
check('group_files_delete 摘除文件与索引', () => {
  assert.equal(d1.ok, true)
  assert.ok(!fs.existsSync(w2.path))
  assert.ok(!(l2.files || []).some(f => f.name === w2.name))
})

/* 10) config get/set（R63 补移植——「保存目录」曾恒 [object Object]） */
const c0 = await post('group_files_config_get', [])
check('config_get 回默认目录（custom=false）', () => {
  assert.equal(c0.ok, true)
  assert.equal(c0.custom, false)
  assert.ok(c0.root && c0.default_root)
})
const customDir = path.join(tmp, 'gf-custom')
const c1 = await post('group_files_config_set', [JSON.stringify({ root: customDir })])
check('config_set 绑定自定义目录并建目录', () => {
  assert.equal(c1.ok, true, 'set 失败: ' + JSON.stringify(c1))
  assert.equal(c1.custom, true)
  assert.ok(fs.existsSync(customDir))
})
const w4 = await post('group_files_write', [SID, '👥 测试群', '主持人', '自定义目录归档', '落在自定义根'])
check('config_set 后 write 落到自定义根', () => {
  assert.equal(w4.ok, true)
  assert.ok(w4.path.startsWith(customDir))
})
const c2 = await post('group_files_config_set', [JSON.stringify({ root: 'C:\\Windows' })])
check('config_set 拒绝系统目录（Python R37 N6 同口径）', () => {
  assert.equal(c2.ok, undefined)
  assert.match(String(c2.error || ''), /系统目录/)
})
const c3 = await post('group_files_config_set', ['not-json'])
check('config_set 拒绝非法 JSON', () => {
  assert.equal(c3.ok, undefined)
  assert.match(String(c3.error || ''), /JSON/)
})
const c4 = await post('group_files_config_set', [JSON.stringify({ root: '' })])
check('config_set 空串恢复默认', () => {
  assert.equal(c4.ok, true)
  assert.equal(c4.custom, false)
})

await app.close()
console.log('group-files: ' + results.length + ' checks PASS\n  ' + results.join('\n  '))
