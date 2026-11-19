#!/usr/bin/env node
/**
 * B4 群聊域 · 两个 deferred-to-react-migration 行为钉的 Node 等价门。
 *
 * 销口对象（frontend/app/docs/behavior-review-batch1.json:
 *   test_group_context_handoff_preserved_and_out_of_window_note
 *   test_group_context_no_handoff_unchanged
 * Python 断言原文：tests/test_r46_final.py:12 / :46 —— 测试体是 JS VM 调
 *   frontend/src/group/group.js::groupContextFor，属前端群聊行为钉。
 *
 * 手法（与 Python tests/test_connect_merge.py::_JS_PRELUDE 及
 * server/test/parallel.mjs:204-209 同源）：
 *   用 node:vm 的 createContext + runInContext 直接加载【未修改的】
 *   frontend/src/group/group.js，取出真实 groupContextFor 执行。
 *   不手写实现副本、不改 frontend/src/、不加载 files.js / features.js，
 *   精确复现 Python _run_group 里只 __run(ctx, __fe('group.js')) 的条件。
 *
 * 为什么能复现：groupContextFor 是纯函数，只依赖入参 + 同文件 groupNextInRoster
 *   + 常量 GROUP_LIMITS；对 featGroupSummaryEnabled / groupFilesContextLines
 *   均有 typeof 守卫，沙箱里不提供即走默认分支（summary 默认 true → 注入
 *   窗口外归档提示；群文件索引默认 ''）。与 Python 测试完全一致。
 *
 * 现状核实：server/src 内无 groupContextFor / groupContext 符号；frontend/app/src
 *   内无等价群聊上下文组件/服务（仅 MainShell.jsx 的 UI 入口按钮与模板文字）。
 *   故本门复用 legacy 真实实现，而非任何 Node/React 侧等价物。
 *
 * 用法：node server/test/group-context-equivalence.mjs
 * 退出码：0 = 两场景断言全通过（输出 ok:true）；1 = 断言失败（输出 ok:false）。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const GROUP_JS = path.join(ROOT, 'frontend', 'src', 'group', 'group.js')

try {
  const results = []

  // ---- 0. 锚点：证明复用的是磁盘上的真实实现，不是内联字面量副本 ----
  const groupSrc = fs.readFileSync(GROUP_JS, 'utf8')
  const sourceSha = createHash('sha256').update(groupSrc).digest('hex')
  assert.ok(groupSrc.includes('function groupContextFor'),
    'group.js 应含 groupContextFor 定义')
  for (const lit of ['已不在上下文', '【交接文档】', '交接文档过长已截断', 'slice(0, 300)']) {
    assert.ok(groupSrc.includes(lit), 'group.js 应含 R46 行为字面量: ' + lit)
  }

  // ---- 1. VM 沙箱：忠实镜像 Python __ctx 的宿主桩 ----
  // groupContextFor 本身不碰 document/callApi，桩仅为与 __ctx 对齐、防意外；
  // 刻意不提供 featGroupSummaryEnabled / groupFilesContextLines（见文件头）。
  const mkEl = () => ({
    style: {}, dataset: {}, children: [], value: '', checked: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    appendChild() {}, removeChild() {}, setAttribute() {}, addEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] }, focus() {},
  })
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    AbortController,
    callApi: async () => '{}',
    toast: () => {},
    document: {
      getElementById: () => null,
      createElement: mkEl,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      body: mkEl(),
    },
  }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  // function 声明会挂到 vm context 全局；追加一句把引用显式回传宿主侧。
  vm.runInContext(groupSrc + '\n;this.__groupContextFor = groupContextFor;',
    sandbox, { timeout: 30000 })
  const groupContextFor = sandbox.__groupContextFor

  assert.equal(typeof groupContextFor, 'function',
    '应从真实源码取出可调用的 groupContextFor')
  // 证明可选全局确实未注入 → groupContextFor 走默认分支，与 Python _run_group 等价。
  assert.equal(vm.runInContext('typeof featGroupSummaryEnabled', sandbox),
    'undefined', '沙箱不应注入 featGroupSummaryEnabled')
  assert.equal(vm.runInContext('typeof groupFilesContextLines', sandbox),
    'undefined', '沙箱不应注入 groupFilesContextLines')
  results.push('vm 加载 frontend/src/group/group.js 真实 groupContextFor；两个可选全局走默认分支（与 Python 一致）')

  // ---- 2. 场景 1：长交接文档 + 30 条早期发言 + 窗口外归档提示 ----
  // 逐行复刻 tests/test_r46_final.py:14-43 的测试体与四项断言。
  const longHandoff = '方案要点先行。' + 'A'.repeat(400) + '\n【交接文档】\n' +
    '- 交接给: UI设计\n- 本次产出: 登录页实现清单\n' +
    '- 完整说明: ' + 'B'.repeat(600) + '\n- 对下一棒的要求: 1) 实现表单 2) 校验\n'
  const fillers = []
  for (let i = 0; i < 30; i++) {
    fillers.push({ role: 'assistant', member: { id: 'a', name: '主持人' },
      content: '早期发言 ' + i })
  }
  const s1 = {
    id: 's1', title: '群',
    messages: fillers.concat([
      { role: 'assistant', member: { id: 'a', name: '主持人' }, content: longHandoff },
      { role: 'assistant', member: { id: 'b', name: 'UI设计' }, content: '收到' },
    ]),
    group: {
      members: [
        { id: 'a', name: '主持人', host: true, model: '', role: '' },
        { id: 'b', name: 'UI设计', host: false, model: '', role: '' },
      ],
      phase: 'running', turn: 'a', round: 1,
    },
  }
  const msgs1 = groupContextFor(s1, s1.group.members[1])
  assert.ok(Array.isArray(msgs1) && msgs1.length > 1,
    'groupContextFor 应返回消息数组（真实执行，非空）')
  const joined1 = JSON.stringify(msgs1)
  const other1 = msgs1.find(m => m.role !== 'system' &&
    m.content.indexOf('【交接文档】') >= 0 && m.content.indexOf('【更早讨论】') < 0)

  const outOfWindowNote = joined1.indexOf('已不在上下文') >= 0
  const handoffKept = !!(other1 && other1.content.indexOf('【交接文档】') >= 0 &&
    other1.content.indexOf('1) 实现表单') >= 0)
  const headSummarized = !!(other1 && other1.content.indexOf('…') >= 0)
  const tailNotDropped = !!(other1 && other1.content.indexOf('对下一棒的要求') >= 0)

  assert.ok(outOfWindowNote, '窗口外归档提示缺失')
  assert.ok(handoffKept, '交接文档节被 300 字一刀切截掉（摘要回传未生效）')
  assert.ok(headSummarized, '正文头应摘要化')
  assert.ok(tailNotDropped, '交接文档结构字段必须保留')
  results.push('场景1 四项断言 outOfWindowNote/handoffKept/headSummarized/tailNotDropped 全真')

  // ---- 3. 场景 2：无交接文档 → 行为不变（他人发言 300 字截断） ----
  // 逐行复刻 tests/test_r46_final.py:48-59。
  const s2 = {
    id: 's1', title: '群',
    messages: [{ role: 'assistant', member: { id: 'a', name: '主持人' },
      content: 'x'.repeat(500) }],
    group: {
      members: [
        { id: 'a', name: '主持人', host: true, model: '', role: '' },
        { id: 'b', name: 'UI设计', host: false, model: '', role: '' },
      ],
      phase: 'running', turn: 'a', round: 1,
    },
  }
  const msgs2 = groupContextFor(s2, s2.group.members[1])
  const other2 = msgs2.find(m => m.content.indexOf('【主持人】') >= 0)
  assert.ok(other2, '应存在带【主持人】前缀的他人发言消息')
  const len2 = other2.content.length
  assert.ok(len2 <= 300 + 10,
    '无交接文档时他人发言应维持 300 字截断（前缀 + 300），实测 ' + len2)
  // 行为不变的补充钉：单条消息不应触发窗口外归档提示。
  const joined2 = JSON.stringify(msgs2)
  assert.ok(joined2.indexOf('已不在上下文') < 0,
    '单条消息不应注入窗口外归档提示（行为不变）')
  results.push('场景2 无交接文档：他人发言 300 字截断 len=' + len2 + '<=310，无窗口外提示')

  // ---- 4. 输出 ----
  console.log(JSON.stringify({
    ok: true,
    gate: 'group-context-equivalence',
    source: 'frontend/src/group/group.js::groupContextFor（node:vm 加载真实实现，未修改源码）',
    sourceBytes: groupSrc.length,
    sourceSha256: sourceSha.slice(0, 16),
    scenarios: [
      {
        name: 'test_group_context_handoff_preserved_and_out_of_window_note',
        status: 'PASS',
        assertions: { outOfWindowNote, handoffKept, headSummarized, tailNotDropped },
        evidence: {
          msgs: msgs1.length,
          otherFound: !!other1,
          otherLen: other1 ? other1.content.length : 0,
          longHandoffChars: longHandoff.length,
          headEllipsis: other1 ? other1.content.indexOf('…') : -1,
        },
      },
      {
        name: 'test_group_context_no_handoff_unchanged',
        status: 'PASS',
        assertions: { lenLe310: len2 <= 310, noOutOfWindowNote: joined2.indexOf('已不在上下文') < 0 },
        evidence: { otherLen: len2 },
      },
    ],
    checks: results.length,
    results,
    nodeSideEquivalent: 'none（server/src 内无 groupContextFor / groupContext 符号）',
    frontendAppEquivalent: 'none（frontend/app/src 仅有 MainShell.jsx 的群聊 UI 入口按钮与模板文字，无 groupContext 组件/服务；B4 未产出等价实现）',
  }, null, 2))
} catch (e) {
  console.log(JSON.stringify({
    ok: false,
    gate: 'group-context-equivalence',
    error: String((e && e.message) || e),
  }, null, 2))
  process.exit(1)
}
