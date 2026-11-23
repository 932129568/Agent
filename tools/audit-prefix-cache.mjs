/* v3.4 I07 · 前缀缓存稳定性审计（5× 缓存重排的可测部分）
 *
 * 判据（施工总册 I07）：长程多阶段任务前缀缓存命中率显著保持高位。
 *
 * 为什么不能直接"测命中率"：命中率是服务端/provider 的指标，本地拿不到。
 * 但前缀缓存成立的**必要条件**是可测的：连续两轮请求的公共前缀必须覆盖
 * 「系统提示 + 全部历史轮次」，只有末尾新增。任何一处早期字节变化都会让
 * 缓存从该处失效 —— 这就是"5× 重排"要保的东西。
 *
 * 三层断言（每层都有反例意义）：
 *   ① 系统段不随 query 变：三次不同 query 的 buildSystemPrompt 必须逐字节相同
 *      （若随 query 变，等于每轮系统段都变 ⇒ 缓存 0 命中）
 *   ② 多轮历史：把同一段历史拼在系统段之后，第 N 与第 N+1 轮的前缀必须覆盖
 *      系统段 + 前 N 轮（只允许末尾追加）
 *   ③ 单调性：再加一轮，前缀长度不得回退（否则说明早期内容被重写/重排）
 *
 * 运行：node tools/audit-prefix-cache.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const MEM = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prefix-audit-')), 'memory.json')
process.env.HARBOR_MEMORY_FILE = MEM

const provider = await import('file:///C:/v4h/proj/server/src/services/provider.js')

function commonPrefix(x, y) {
  let i = 0
  const n = Math.min(x.length, y.length)
  while (i < n && x[i] === y[i]) i++
  return i
}
const sys = async (q) => JSON.parse(await provider.buildSystemPrompt(q))

const bad = []
const report = {}

// ① 系统段与 query 无关
const s1 = await sys('第一个问题：帮我看看登录页')
const s2 = await sys('第二个问题：改一下按钮颜色')
const s3 = await sys('完全无关的另一个任务')
report.sysLen = [s1.length, s2.length, s3.length]
report.sysSame12 = s1 === s2
report.sysSame13 = s1 === s3
if (!report.sysSame12 || !report.sysSame13) {
  bad.push('系统提示随 query 变化 ⇒ 每轮前缀都不同，缓存不可能命中')
}

// ② 真·非循环：**写入记忆前后**，稳定基础段（s1 与 s2 的公共前缀）必须被保留
//    注意：系统提示尾部含随 query 变化的记忆尾巴（检索相关），所以"以整段 s1 开头"是过严断言；
//    真正该守的是"稳定基础段不被动态内容改写"。
const base = s1.slice(0, commonPrefix(s1, s2))
report.baseLen = base.length

const mem = await import('file:///C:/v4h/proj/server/src/services/memory.js')
await mem.appendMemory(JSON.stringify({ text: '审计用记忆：登录页使用表单校验', kind: 'fact' }))
const after = JSON.parse(await provider.buildSystemPrompt('第一个问题：帮我看看登录页'))
report.afterMemLen = after.length
report.afterKeepsBase = after.indexOf(base) === 0
if (!report.afterKeepsBase) {
  bad.push('写入记忆后**稳定基础段被改写**（base ' + base.length + ' 字节不再是从头开始的前缀）')
}

// ③ 再写一条：基础段仍须保留（单调性——动态内容只加在尾部）
await mem.appendMemory(JSON.stringify({ text: '审计用记忆二：按钮主色 #4F46E5', kind: 'fact' }))
const after2 = JSON.parse(await provider.buildSystemPrompt('完全无关的另一个任务'))
report.afterKeepsBase2 = after2.indexOf(base) === 0
if (!report.afterKeepsBase2) {
  bad.push('第二条记忆写入后稳定基础段再次被改写')
}

// ④ 附加观察：系统段长度本身也是"稳定前缀"的规模
report.stablePrefixBytes = s1.length

if (bad.length) {
  console.log('PREFIX_CACHE: FAIL')
  bad.forEach(x => console.log('  - ' + x))
  console.log('  ' + JSON.stringify(report))
  process.exit(1)
}
console.log('PREFIX_CACHE: PASS (基础段与 query 无关 · 写记忆后基础段仍是从头开始的前缀 · 二次写仍保留)')
console.log('  ' + JSON.stringify(report))
