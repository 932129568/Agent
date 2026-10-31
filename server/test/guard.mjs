/**
 * 护栏判定链验证：判定顺序、token 一次性与参数绑定、会话信任、规则、
 * 任务授权 fail-closed、以及危险操作的执行点强制。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-guard-'))
process.env.HARBOR_CONFIG_DIR = path.join(tmp, 'config')
process.env.DATABASE_URL = `file:${path.join(tmp, 'app.db')}`
process.env.LOG_LEVEL = 'silent'

const guard = await import('../src/services/guard.js')
const workspace = await import('../src/services/workspace.js')
const system = await import('../src/services/system.js')
const { mergeConfig } = await import('../src/services/jsonstore.js')
const { setCwd, setCurrentSid } = await import('../src/runtime.js')

setCwd(tmp)
setCurrentSid('s_guard')
const results = []
const check = (name, fn) => { fn(); results.push(name) }
const decision = async (op, detail) => JSON.parse(await guard.guardCheck(op, detail))

// ① 保护名单优先于一切
mergeConfig('guard.json', JSON.stringify({ protect: { enabled: true, names: ['.git'] } }))
const protectedVerdict = await decision('read_file', { path: 'C:/work/.git/config' })
check('保护名单目录名命中即 block', () => assert.equal(protectedVerdict.action, 'block'))

// ② allow 规则（legacy op_pattern/detail_pattern/note 三参）
const addedRule = JSON.parse(await guard.guardRuleAdd('^read_file$', 'notes/', '放行笔记目录'))
check('allow 规则创建返回 rule_id', () => assert.ok(addedRule.rule_id))
const ruled = await decision('read_file', { path: 'notes/a.txt' })
assert.equal(ruled.action, 'allow')
assert.equal(ruled.via, 'rule')
results.push('allow 规则命中放行')

// ③ deny 规则优先于 allow（deny 清单走独立配置，不经 allow 规则创建 API）
mergeConfig('guard.json', JSON.stringify({ rules: [
  { rule_id: 'd_secret', op: 'read_file', pattern: 'secret', action: 'deny' },
] }))
const denied = await decision('read_file', { path: 'notes/secret.txt' })
check('deny 规则阻断', () => assert.equal(denied.action, 'block'))
const broadDeny = JSON.parse(await guard.guardRuleAdd('.*', '', '危险宽规则'))
check('危险操作无 detail 宽白名单被拒绝', () => assert.equal(broadDeny.code, 'GUARD_DENIED'))

// ④ 任务授权 fail-closed
await guard.guardTaskGrant(['fs:read'], 30)
const granted = await decision('list_dir', {})
check('授权 scope 内的操作放行', () => {
  assert.equal(granted.action, 'allow')
  assert.equal(granted.via, 'grant')
})
const outOfScope = await decision('run_command', {})
check('未映射 scope 的操作不因授权放行（fail-closed）', () => {
  assert.notEqual(outOfScope.action, 'allow')
})
const revoked = JSON.parse(await guard.guardTaskRevoke())
check('任务授权撤销返回 revoked=true', () => assert.equal(revoked.revoked, true))
const revokedAgain = JSON.parse(await guard.guardTaskRevoke())
check('重复撤销幂等返回 revoked=false', () => assert.equal(revokedAgain.revoked, false))

// ⑤ 持久信任
mergeConfig('guard.json', JSON.stringify({ trustedOps: ['get_file_info'] }))
const persistent = await decision('get_file_info', {})
check('trustedOps 持久信任放行', () => {
  assert.equal(persistent.action, 'allow')
  assert.equal(persistent.via, 'trusted-persistent')
})

// ⑥ 会话信任与切换失效
await guard.guardSessionTrust('write_file')
const trusted = await decision('write_file', {})
check('会话信任放行', () => {
  assert.equal(trusted.action, 'allow')
  assert.equal(trusted.via, 'trusted-session')
})
setCurrentSid('s_other')
const afterSwitch = await decision('write_file', {})
check('切换会话后信任失效', () => assert.notEqual(afterSwitch.via, 'trusted-session'))
setCurrentSid('s_guard')

// ⑦ 档位
mergeConfig('guard.json', JSON.stringify({ tiers: { read_more: 'off', run_command: 'always' } }))
const off = await decision('read_more', {})
assert.equal(off.action, 'allow')
results.push('off 档直接放行')
const always = await decision('run_command', {})
check('always 档要求确认', () => assert.equal(always.action, 'confirm'))

// ⑧ token：一次性 + 参数摘要绑定
const issued = JSON.parse(await guard.guardConfirmToken('run_command', { command: 'dir' }))
check('confirm_token 签发', () => assert.ok(issued.token))
const firstUse = await guard.consumeToken('run_command', { command: 'dir' }, issued.token)
assert.equal(firstUse, true)
results.push('token 首次消费成功')
const secondUse = await guard.consumeToken('run_command', { command: 'dir' }, issued.token)
check('token 不可重复使用', () => assert.equal(secondUse, false))
const issued2 = JSON.parse(await guard.guardConfirmToken('run_command', { command: 'dir' }))
const mismatched = await guard.consumeToken('run_command', { command: 'ls' }, issued2.token)
check('参数变化后 token 无效', () => assert.equal(mismatched, false))

// ⑨ 规则列表与删除
const rules = JSON.parse(await guard.guardRuleList())
check('规则列表可读', () => assert.ok(rules.rules.length >= 1))
await guard.guardRuleRemove(rules.rules[0].rule_id)
const afterRemove = JSON.parse(await guard.guardRuleList())
check('规则删除生效', () => assert.equal(afterRemove.rules.length, rules.rules.length - 1))

// ⑩ 预算读写与参数校验
const badBudget = JSON.parse(await guard.guardApprovalBudget(0))
check('approval_budget 拒绝越界值', () => assert.ok(badBudget.error))
const budget = JSON.parse(await guard.guardApprovalBudget(50))
check('approval_budget 设置并回读 limit/used/remaining', () => {
  assert.equal(budget.ok, true)
  assert.equal(budget.limit, 50)
  assert.ok(budget.used >= 1)
  assert.ok(budget.remaining <= 49)
})

// ⑪ 危险操作执行点强制：无 token 拒绝，有 token 放行
mergeConfig('guard.json', JSON.stringify({ tiers: { delete_path: 'always' } }))
await workspace.saveWorkspaceFile('victim.txt', 'x')
const refused = JSON.parse(await workspace.deletePath('attachments/victim.txt', true))
check('delete_path 无 token 被拒绝', () => {
  assert.ok(refused.error && refused.error.includes('确认'))
})
const token = JSON.parse(await guard.guardConfirmToken('delete_path', { path: 'attachments/victim.txt' })).token
const allowed = JSON.parse(await workspace.deletePath('attachments/victim.txt', true, token))
check('delete_path 携带有效 token 放行', () => assert.equal(allowed.ok, true))

const killRefused = JSON.parse(await system.killProcess(12345, null, null))
check('kill_process 无 token 同样被拒绝（不实际杀进程）', () => {
  assert.ok(killRefused.error && killRefused.error.includes('确认'))
})

console.log(JSON.stringify({ ok: true, node: process.version, checks: results.length, results }, null, 2))
