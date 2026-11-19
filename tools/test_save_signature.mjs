/**
 * saveSessions 变更签名回归测试（真实 store.js 源码，Node VM）。
 *
 * 背景：持久化短路依赖签名比对，签名漏字段 = 该字段单独变化时丢状态。
 * 本测试固定 normalizeSessions 保留的持久化字段都会改变签名。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'frontend/src/sessions/store.js'), 'utf8')

const start = source.indexOf('function _sessionSaveSignature')
const end = source.indexOf('function _sessionSignatures')
assert.ok(start > 0 && end > start, '签名函数定位失败')

const sandbox = { JSON, Array, Object, Number, String }
vm.createContext(sandbox)
vm.runInContext(source.slice(start, end) + '\nthis.__sig = _sessionSaveSignature;', sandbox)
const sig = sandbox.__sig

const base = () => ({
  id: 's1', title: 't', createdAt: 1, updatedAt: 100,
  messages: [{ role: 'user', content: 'a' }],
  runStatus: 'working', projectId: 'p1', plan: { task_id: 'task1' },
})

const results = []
const expectChange = (name, mutate) => {
  const a = base()
  const b = base()
  mutate(b)
  assert.notEqual(sig(a), sig(b), `${name} 变化未被签名捕获`)
  results.push(name)
}

// 未变更必须相等（否则短路失效，退化为每次全量写）
assert.equal(sig(base()), sig(base()))
results.push('未变更时签名一致（短路有效）')

expectChange('updatedAt', s => { s.updatedAt += 1 })
expectChange('messages 条数', s => { s.messages.push({ role: 'assistant', content: 'b' }) })
expectChange('runStatus', s => { s.runStatus = 'completed' })
expectChange('title', s => { s.title = 'x' })
expectChange('autoResume', s => { s.autoResume = 2 })
expectChange('plan.task_id', s => { s.plan.task_id = 'task2' })
expectChange('projectId', s => { s.projectId = 'p2' })
expectChange('_spentTokens', s => { s._spentTokens = 512 })
expectChange('apiFrozen（冻结参数）', s => { s.apiFrozen = { model: 'glm-x', temperature: 0.3 } })
expectChange('_readKeys（已读键）', s => { s._readKeys = ['k1'] })
expectChange('worklogInjected', s => { s.worklogInjected = true })
expectChange('__budgetWarned', s => { s.__budgetWarned = true })
expectChange('expert', s => { s.expert = { id: 'expert-a' } })
expectChange('_compactBackup', s => { s._compactBackup = { msgs: [{ role: 'user' }] } })
expectChange('uiGenerative', s => { s.uiGenerative = { specs: [{ specId: 'g1', revision: 1 }] } })

console.log(JSON.stringify({ ok: true, node: process.version, checks: results.length, results }, null, 2))
