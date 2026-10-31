/**
 * 文件工具族验证：真实服务工作区（临时目录），覆盖读写回环、编码、
 * 截断续读、搜索替换、目录列举、以及**路径越狱必须被拒**。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import iconv from 'iconv-lite'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-files-'))
process.env.HARBOR_CONFIG_DIR = path.join(tmp, 'config')
process.env.DATABASE_URL = `file:${path.join(tmp, 'app.db')}`
process.env.LOG_LEVEL = 'silent'

const { setCwd } = await import('../src/runtime.js')
const files = await import('../src/services/files.js')
const { resolveWs } = await import('../src/services/jail.js')

const ws = path.join(tmp, 'ws')
setCwd(ws)

const results = []
const check = (name, fn) => { fn(); results.push(name) }

// 建目录与写入
await files.makeDir('notes/deep')
check('make_dir 递归创建', () => assert.ok(fs.existsSync(path.join(ws, 'notes', 'deep'))))

await files.writeFile('notes/a.txt', '第一行\n第二行\n第三行')
const read = JSON.parse(await files.readFile('notes/a.txt'))
check('write_file + read_file 回环（带行号）', () => {
  assert.equal(read.ok, true)
  assert.ok(read.content.includes('1\t第一行'))
  assert.ok(read.content.includes('3\t第三行'))
})

const again = JSON.parse(await files.readFile('notes/a.txt'))
check('二次读取命中 unchanged 快路径', () => assert.equal(again.unchanged, true))

const forced = JSON.parse(await files.readFile('notes/a.txt', 0, 0, true))
check('force=true 绕过 unchanged', () => assert.ok(forced.content.includes('第一行')))

// 截断与续读
const longText = Array.from({ length: 30 }, (_, i) => `L${i + 1}`).join('\n')
await files.writeFile('notes/long.txt', longText)
const clamped = JSON.parse(await files.readFile('notes/long.txt', 0, 5))
check('limit 小于 50 时按 50 钳制（legacy 口径）', () => {
  assert.equal(clamped.returned, 30)
  assert.equal(clamped.truncated, undefined)
})

const bigText = Array.from({ length: 120 }, (_, i) => `B${i + 1}`).join('\n')
await files.writeFile('notes/big.txt', bigText)
const part = JSON.parse(await files.readFile('notes/big.txt', 0, 60))
check('limit 截断并给出 cache_id', () => {
  assert.equal(part.truncated, true)
  assert.ok(part.cache_id)
  assert.equal(part.total_lines, 120)
  assert.equal(part.returned, 60)
})
const more = JSON.parse(await files.readMore(part.cache_id, 60, 60))
check('read_more 续读后续行', () => {
  assert.ok(more.content.includes('61\tB61'))
  assert.ok(more.content.includes('120\tB120'))
})

// 追加
await files.appendFile('notes/a.txt', '\n第四行')
const afterAppend = JSON.parse(await files.readFile('notes/a.txt', 0, 0, true))
check('append_file 追加生效', () => assert.ok(afterAppend.content.includes('第四行')))

// 搜索替换
await files.writeFile('notes/r.txt', 'foo bar foo')
const multi = JSON.parse(await files.searchReplace('notes/r.txt', 'foo', 'baz'))
check('多处匹配未指定 replace_all 时中止', () => assert.ok(multi.error.includes('多处') || multi.error.includes('匹配到')))
const replaced = JSON.parse(await files.searchReplace('notes/r.txt', 'foo', 'baz', true))
check('replace_all 全量替换并计数', () => assert.equal(replaced.replaced, 2))
const noMatch = JSON.parse(await files.searchReplace('notes/r.txt', 'zzz', 'x'))
check('无匹配时报错且不改文件', () => assert.ok(noMatch.error.includes('未找到')))

// 列目录与信息
const listing = JSON.parse(await files.listDir('notes'))
check('list_dir 目录优先且含子目录标记', () => {
  assert.ok(listing.entries.some(e => e.name === 'deep/'))
  assert.equal(listing.entries[0].name, 'deep/')
})
const info = JSON.parse(await files.getFileInfo('notes/a.txt'))
check('get_file_info 返回大小与类型', () => {
  assert.equal(info.exists, true)
  assert.equal(info.is_dir, false)
  assert.ok(info.size > 0)
})

// GBK 编码
const gbkPath = path.join(ws, 'notes', 'gbk.txt')
fs.writeFileSync(gbkPath, iconv.encode('中文内容 GBK', 'gbk'))
const gbkRead = JSON.parse(await files.readFile('notes/gbk.txt', 0, 0, true))
check('GBK 文件正确解码', () => {
  assert.equal(gbkRead.encoding, 'gbk')
  assert.ok(gbkRead.content.includes('中文内容 GBK'))
})

// 二进制短路
fs.writeFileSync(path.join(ws, 'notes', 'bin.dat'), Buffer.from([0, 1, 2, 3]))
const bin = JSON.parse(await files.readFile('notes/bin.dat'))
check('二进制文件拒绝读取', () => assert.ok(bin.error.includes('二进制')))

// 路径越狱（相对与绝对两种）
check('相对路径 .. 越狱被拒', () => {
  assert.throws(() => resolveWs('../../../../etc/passwd'), /路径越界/)
})
check('绝对路径出工作区被拒', () => {
  assert.throws(() => resolveWs(path.resolve(os.tmpdir())), /路径越界|ENOENT/)
})
check('工作区内绝对路径放行', () => {
  assert.equal(resolveWs(path.join(ws, 'notes', 'a.txt')), path.join(ws, 'notes', 'a.txt'))
})

console.log(JSON.stringify({ ok: true, node: process.version, checks: results.length, results }, null, 2))
