/* R59：生成/校验 frontend/deps-allowlist.json（前向隐藏边冻结清单）。
 * 无参=重生成冻结清单；--check=棘轮门禁（重算与已提交清单比对，清单外新增
 * 前向边即退出 1）。剥离/计数实现 = 唯一事实源（build 门禁经本脚本承载，
 * 避免 build 内联实现的字符串剥离语义分叉——R59 实测教训）。
 *
 * R62 修复（引号状态机漂移）：原实现用三条字符串正则**各自独立**全局替换，
 * 互不感知且完全不识别正则字面量——代码里 `@[^\s@…"']{1,12}` 这类含引号的
 * 正则会让引号配对错位，吞掉不同代码区；同一文件的前向边集合随无关编辑
 * 漂移（R58 已记录同类坑），棘轮对 group.js 误报「新增 2 条」。改为单遍
 * 词法扫描（R64 抽至 tools/lib/js-lexer.mjs 共享——module-inventory 同源）：注释/字符串/模板字面量（${} 内按代码递归）/正则字面量（含
 * [字符类] 与 prev-token 除法消歧）之外原样保留，边集合自此稳定。 */
import fs from 'node:fs'
import path from 'node:path'
import { stripCode } from './lib/js-lexer.mjs'

const root = path.resolve('.')

const manifest = JSON.parse(fs.readFileSync('frontend/manifest.json', 'utf8'))
const provides = new Map()
for (const entry of manifest.scripts) {
  for (const symbol of entry.provides) {
    if (!provides.has(symbol)) provides.set(symbol, [])
    provides.get(symbol).push(entry.path)
  }
}
const order = new Map(manifest.scripts.map((e, i) => [e.path, i]))
const forward = {}
for (const entry of manifest.scripts) {
  const clean = stripCode(fs.readFileSync(path.join(root, entry.path), 'utf8'))
  const declared = new Set(entry.requires)
  for (const m of clean.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const sym = m[0]
    if (sym === 'uiSeamCall') continue   // R59 缝原语：经注册表间接，不计前向边（原 strip 同语义）
    for (const t of provides.get(sym) || []) {
      if (t === entry.path || (order.get(t) ?? -1) <= order.get(entry.path)) continue
      if (declared.has(sym)) continue
      forward[entry.path + '::' + sym] = t
    }
  }
}
const out = {
  _comment: 'R59 单向依赖棘轮冻结清单：前向隐藏边（调用更晚加载模块的 provided 符号且未声明 requires）。只减不增——tests/test_r59_deps.py 经 --check 模式对清单外新增即拒。键=模块::符号，值=目标模块。',
  _note: '消灭方式：拆缝（uiSeamCall 注册表）/函数下沉早位叶模块/声明 requires（仅当目标更早）。由 tools/gen_allowlist.mjs 生成（与门禁同源实现）。',
  forwardHidden: Object.fromEntries(Object.entries(forward).sort()),
}

/* --check 模式（棘轮门禁）：重算与已提交清单比对——清单外新增前向边即退出 1。
 * 清单内条目消失（边被拆掉）→ 通过并提示可重生成（不自动写回，防测试写文件）。 */
if (process.argv.includes('--check')) {
  const file = path.join(root, 'frontend', 'deps-allowlist.json')
  let committed = {}
  try {
    committed = JSON.parse(fs.readFileSync(file, 'utf8')).forwardHidden || {}
  } catch (e) {
    console.error('[deps-ratchet] 冻结清单缺失或损坏:', e.message)
    process.exit(1)
  }
  const added = Object.keys(forward).filter(k => !(k in committed))
  const removed = Object.keys(committed).filter(k => !(k in forward))
  if (added.length) {
    console.error('[deps-ratchet] 新增未声明前向引用 ' + added.length + ' 条（拆缝/下沉叶模块，或经评审后 node tools/gen_allowlist.mjs 重生成冻结清单）:')
    for (const k of added.slice(0, 12)) console.error('  ' + k + ' -> ' + forward[k])
    process.exit(1)
  }
  console.log('[deps-ratchet] 通过：前向隐藏边 ' + Object.keys(forward).length +
    ' 条（冻结 ' + Object.keys(committed).length + ' 条' +
    (removed.length ? '，本轮已拆 ' + removed.length + ' 条——请重生成清单' : '）'))
  process.exit(0)
}

fs.writeFileSync(path.join(root, 'frontend/deps-allowlist.json'),
  JSON.stringify(out, null, 2) + '\n')
console.log('frozen:', Object.keys(forward).length, 'edges')
