/**
 * 文件工具族验证（P0-1c T02 F1-F6 断言更新：read_file 全语义——keepends 尾行/
 * offset-oob note/auto-limit 自适应/BUDGET 截断/64MB/difflib 猜错/binary 信息性
 * 载荷；写族键集与路径口径；Python file_service.py 行号对照）。
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
const madeDir = JSON.parse(await files.makeDir('notes/deep'))
check('make_dir 返回绝对路径（file_service.py:362-364）', () => {
  assert.ok(fs.existsSync(path.join(ws, 'notes', 'deep')))
  assert.equal(path.isAbsolute(madeDir.path), true)
})

const written = JSON.parse(await files.writeFile('notes/a.txt', '第一行\n第二行\n第三行\n'))
check('write_file 响应 {ok,path(短),bytes}', () => {
  assert.equal(written.ok, true)
  assert.equal(written.path, 'notes/a.txt')
  assert.equal(written.bytes, Buffer.byteLength('第一行\n第二行\n第三行\n', 'utf8'))
})

const read = JSON.parse(await files.readFile('notes/a.txt', 0, 0, true))
check('read_file keepends：无尾行幻影（file_service.py:219-220 splitlines）', () => {
  assert.equal(read.ok, true)
  assert.equal(read.total_lines, 3)
  assert.ok(!read.content.includes('4\t'))
  assert.equal(read.encoding, undefined)   // F1：无 encoding/offset/returned 回显键
})

const again = JSON.parse(await files.readFile('notes/a.txt'))
check('二次读取命中 unchanged 快路径（offset==0 且整文件 served）', () => {
  assert.equal(again.unchanged, true)
  assert.equal(again.note.includes('原文应仍在上文中'), true)
})

const forced = JSON.parse(await files.readFile('notes/a.txt', 0, 0, true))
check('force=true 绕过 unchanged', () => assert.ok(forced.content.includes('第一行')))

// offset 越界 note（file_service.py:225-227）
const oob = JSON.parse(await files.readFile('notes/a.txt', 3, 10, true))
check('offset>=total 返回 note 无 content（file_service.py:225-227）', () => {
  assert.equal(oob.ok, true)
  assert.ok(oob.note.includes('offset=3 已超出文件末尾（共 3 行）'))
  assert.equal(oob.content, undefined)
})

// auto_limit 自适应：≤2000 行一次读全（file_service.py:221-222）
const midFile = Array.from({ length: 150 }, (_, i) => `M${i + 1}`).join('\n')
await files.writeFile('notes/mid.txt', `${midFile}\n`)
const midRead = JSON.parse(await files.readFile('notes/mid.txt', 0, 0, true))
check('auto_limit ≤2000 行一次读全（limit 自适应 2000）', () => {
  assert.equal(midRead.total_lines, 150)
  assert.ok(midRead.content.includes('150\tM150'))
  assert.equal(midRead.hint, undefined)   // 整文件 served 无续读 hint
})

// >2000 行分页 1200（file_service.py:222）
const bigLines = Array.from({ length: 2100 }, (_, i) => `B${i + 1}`).join('\n')
await files.writeFile('notes/huge.txt', `${bigLines}\n`)
const paged = JSON.parse(await files.readFile('notes/huge.txt', 0, 0, true))
check('auto_limit >2000 行分页 1200 + hint 续读（file_service.py:222,235-236）', () => {
  assert.equal(paged.total_lines, 2100)
  assert.ok(paged.hint.includes('还有 900 行未读，可传 offset=1200 继续读'))
})

// BUDGET 截断（240000 字符预算，file_service.py:228-234）
const budgetLine = 'X'.repeat(500)
const budgetText = Array.from({ length: 700 }, () => budgetLine).join('\n')
await files.writeFile('notes/budget.txt', `${budgetText}\n`)
const budgeted = JSON.parse(await files.readFile('notes/budget.txt', 0, 0, true))
check('240000 字符预算截断 + 截断标记（file_service.py:228-234）', () => {
  assert.ok(budgeted.content.includes('…(超大文件截断，可传 offset 继续读)'))
})

// 分页读取：limit 钳制 50..20000
const clamped = JSON.parse(await files.readFile('notes/mid.txt', 0, 5, true))
check('limit 小于 50 时按 50 钳制（file_service.py:168-169）', () => {
  assert.ok(clamped.content.includes('50\tM50'))
})

// 缺文件：difflib 猜错提示 + 绝对路径（file_service.py:172-190）
fs.writeFileSync(path.join(ws, 'notes', 'readme.md'), '# readme')
const missing = JSON.parse(await files.readFile('notes/readme.md.txt'))
check('缺文件错误含绝对路径与猜错提示（file_service.py:172-190）', () => {
  assert.ok(missing.error.includes('文件不存在: '))
  assert.ok(path.isAbsolute(missing.error.split('文件不存在: ')[1]?.split('（')[0]))
  assert.ok(missing.error.includes('最接近的文件: readme.md'))
})

// 二进制：信息性载荷（ok/error 语义反转——file_service.py:211-213）
fs.writeFileSync(path.join(ws, 'notes', 'bin.dat'), Buffer.from([0, 1, 2, 3]))
const bin = JSON.parse(await files.readFile('notes/bin.dat'))
check('二进制文件返回信息性载荷（无 ok 键非错误，file_service.py:211-213）', () => {
  assert.equal(bin.binary, true)
  assert.ok(bin.info.includes('二进制文件，read_file 不适用'))
  assert.equal(bin.ok, undefined)
  assert.equal(path.isAbsolute(bin.path), true)
})

// 追加：bytes 回显（F3，file_service.py:273-299）
const appended = JSON.parse(await files.appendFile('notes/a.txt', '第四行\n'))
const afterAppend = JSON.parse(await files.readFile('notes/a.txt', 0, 0, true))
check('append_file 响应 {ok,path,bytes}（F3）', () => {
  assert.equal(appended.bytes, Buffer.byteLength('第四行\n', 'utf8'))
  assert.ok(afterAppend.content.includes('4\t第四行'))
})

// 搜索替换：原编码写回 + 键集（file_service.py:303-353）
await files.writeFile('notes/r.txt', 'foo bar foo\n')
const multi = JSON.parse(await files.searchReplace('notes/r.txt', 'foo', 'baz'))
check('多处匹配未指定 replace_all 时中止（file_service.py:336-338）', () => {
  assert.ok(multi.error.includes('匹配到 2 处'))
})
const replaced = JSON.parse(await files.searchReplace('notes/r.txt', 'foo', 'baz', true))
check('replace_all 全量替换并计数（file_service.py:339-341）', () => {
  assert.equal(replaced.ok, true)
  assert.equal(replaced.path, 'notes/r.txt')
  assert.equal(replaced.replaced, 2)
})
const noMatch = JSON.parse(await files.searchReplace('notes/r.txt', 'zzz', 'x'))
check('无匹配时报错且不改文件（file_service.py:330-335）', () => {
  assert.ok(noMatch.error.includes('未找到匹配内容'))
})

// 列目录与信息
const listing = JSON.parse(await files.listDir('notes'))
check('list_dir 目录优先且含子目录标记', () => {
  assert.ok(listing.entries.some(e => e.name === 'deep/'))
  assert.equal(listing.entries[0].name, 'deep/')
})
const info = JSON.parse(await files.getFileInfo('notes/a.txt'))
check('get_file_info {path(绝对),is_dir,size,mtime}（F5，file_service.py:468-475）', () => {
  assert.equal(info.is_dir, false)
  assert.ok(info.size > 0)
  assert.ok(path.isAbsolute(info.path))
  assert.match(info.mtime, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  assert.equal(info.ok, undefined)   // F5：无 ok/exists 键
})

// GBK 编码（file_service.py:113-133）
const gbkPath = path.join(ws, 'notes', 'gbk.txt')
fs.writeFileSync(gbkPath, iconv.encode('中文内容 GBK', 'gbk'))
const gbkRead = JSON.parse(await files.readFile('notes/gbk.txt', 0, 0, true))
check('GBK 文件正确解码（utf-8→gbk 顺序探测）', () => {
  assert.ok(gbkRead.content.includes('中文内容 GBK'))
})

// read_more 缓存未命中文案（F2，toolcache_service.py:82-83）
const miss = JSON.parse(await files.readMore('tc999_999', 0, 10))
check('read_more 缓存未命中文案（F2）', () => {
  assert.ok(miss.error.includes('缓存不存在或已清理，请重新执行原命令获取'))
})

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
