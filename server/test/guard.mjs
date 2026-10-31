/**
 * 护栏判定链验证（P0-1b T01 断言更新：形状对齐 legacy guard_service.py——
 * 每处断言附 Python 源码行号对照，QA 抽查锚点）。
 *
 * 覆盖：判定顺序（名单→规则→授权→持久信任→档位）、GUARD_OPS 白名单、
 * confirm 回执 label（guard_service.py OP_LABELS）、token {token,ttl:60}
 * （guard_service.py issue_confirm_token）、scope 枚举与 TTL 范围（task_grant）、
 * armed 语义（guard_service.py:476 未武装放行）、审计链五维条目与哈希链
 * （audit_chain.py）、配置归一化（guard_service.py _load/_write_cfg_locked）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-guard-'))
process.env.HARBOR_CONFIG_DIR = path.join(tmp, 'config')
process.env.DATABASE_URL = `file:${path.join(tmp, 'app.db')}`
process.env.LOG_LEVEL = 'silent'
process.env.HARBOR_GUARD_ARMED = 'false' // 未武装环境（与 Python 测试态同构；armed 语义单测见下）

const guard = await import('../src/services/guard.js')
const workspace = await import('../src/services/workspace.js')
const system = await import('../src/services/system.js')
const misc = await import('../src/services/misc.js')
const { guardSaveConfig } = guard
const { setCwd, setCurrentSid } = await import('../src/runtime.js')

setCwd(tmp)
setCurrentSid('s_guard')
const results = []
const check = (name, fn) => { fn(); results.push(name) }
const decision = async (op, detail) => JSON.parse(await guard.guardCheck(op, detail))
const writeCfg = async obj => {
  const r = JSON.parse(await guardSaveConfig(JSON.stringify(obj)))
  assert.equal(r.ok ?? (r.error === undefined), true, `guard_save_config 失败: ${JSON.stringify(r)}`)
}

// ⓪ GUARD_OPS 白名单：之外的操作不设防（guard_service.py GUARD_OPS；api 无执行点）
const unknownOp = await decision('no_such_op', {})
check('GUARD_OPS 之外的 op 直接 allow（契约设计）', () => {
  assert.equal(unknownOp.action, 'allow')
  assert.equal(unknownOp.via, undefined)
})

// ① 保护名单优先于一切（guard_service.py _path_protected：protect_paths 路径模式）
await writeCfg({ protect_paths: [path.join(tmp, 'ws', '.git').toLowerCase()] })
const protectedVerdict = await decision('delete_path', { path: path.join(tmp, 'ws', '.git', 'config') })
check('保护名单路径命中即 block（文案含名单模式）', () => {
  assert.equal(protectedVerdict.action, 'block')
  assert.ok(protectedVerdict.reason.includes('命中保护名单'))
})

// ② allow 规则（guard_service.py rule_add：窄规则优先）
const addedRule = JSON.parse(await guard.guardRuleAdd('^delete_path$', 'attachments/', '放行附件目录'))
check('allow 规则创建返回 rule_id', () => assert.ok(addedRule.rule_id))
const ruled = await decision('delete_path', { path: 'attachments/a.txt' })
check('allow 规则命中放行 via=rule', () => {
  assert.equal(ruled.action, 'allow')
  assert.equal(ruled.via, 'rule')
})
const ruledMiss = await decision('delete_path', { path: 'src/a.txt' })
check('窄规则 detail 未命中不适用（回落档位）', () => assert.notEqual(ruledMiss.via, 'rule'))

// ③ 危险宽白名单创建即拒（guard_service.py _rule_covered_by_deny：delete_path/
//    kill_process 无 detail 窄约束 → GUARD_DENIED；Python 无独立 deny_rules——
//    deny 语义由保护名单承担）
const broadDeny = JSON.parse(await guard.guardRuleAdd('.*', '', '危险宽规则'))
check('危险操作无 detail 宽白名单被拒绝（GUARD_DENIED）', () => {
  assert.equal(broadDeny.code, 'GUARD_DENIED')
  assert.ok(broadDeny.error)
})

// ④ 任务授权：scope 枚举校验 + fail-closed（guard_service.py task_grant/_OP_GRANT_SCOPES）
const badScope = JSON.parse(await guard.guardTaskGrant(['fs:read'], 30))
check('bogus scope 拒绝（枚举校验，不静默接受）', () => {
  assert.ok(badScope.error && badScope.error.includes('workspace_write/exec/app_launch'))
})
const badTtl = JSON.parse(await guard.guardTaskGrant(['exec'], 30))
check('TTL 越界拒绝（安全参数不夹逼）', () => assert.ok(badTtl.error && badTtl.error.includes('60-86400')))
const grantResult = JSON.parse(await guard.guardTaskGrant(['workspace_write'], 7200))
check('授权响应全键（expires_at/idle_deadline/remaining_s/granted_by）', () => {
  assert.equal(grantResult.ok, true)
  assert.ok(grantResult.grant_id)
  assert.ok(grantResult.expires_at)
  assert.ok(grantResult.idle_deadline)
  assert.equal(typeof grantResult.remaining_s, 'number')
  assert.deepEqual(grantResult.scope, ['workspace_write'])
  assert.equal(grantResult.granted_by, 'user')
})
const granted = await decision('delete_path', { path: 'src/b.txt' })
check('授权 scope 内的映射 op 放行 via=grant（规则不命中时）', () => {
  assert.equal(granted.action, 'allow')
  assert.equal(granted.via, 'grant')
})
const outOfScope = await decision('take_screenshot', {})
check('未映射 scope 的操作不因授权放行（fail-closed：走档位 confirm）', () => {
  assert.equal(outOfScope.action, 'confirm')
})
const revoked = JSON.parse(await guard.guardTaskRevoke())
check('任务授权撤销返回 revoked=true', () => assert.equal(revoked.revoked, true))
const revokedAgain = JSON.parse(await guard.guardTaskRevoke())
check('重复撤销幂等返回 revoked=false', () => assert.equal(revokedAgain.revoked, false))

// ⑤ 持久信任（guard_service.py _load：trustedOps 白名单过滤）
await writeCfg({ trustedOps: ['take_screenshot'] })
const persistent = await decision('take_screenshot', {})
check('trustedOps 持久信任放行', () => {
  assert.equal(persistent.action, 'allow')
  assert.equal(persistent.via, 'trusted-persistent')
})
const badTrustOps = JSON.parse(await guardSaveConfig(JSON.stringify({ trustedOps: ['no_such_op'] })))
check('未知 op 的持久信任在保存面拒绝（不静默过滤）', () => {
  assert.ok(badTrustOps.error && badTrustOps.error.includes('未知的信任操作'))
})
const filteredCfg = JSON.parse(await guard.guardGetConfig())
check('拒绝后 trustedOps 保持原值（写入被整体拒绝）', () => {
  assert.deepEqual(filteredCfg.trustedOps, ['take_screenshot'])
})

// ⑥ 会话信任：op 白名单 + check 面不消费（guard_service.py trust_session / check）
const badTrust = JSON.parse(await guard.guardSessionTrust('no_such_op'))
check('会话信任未知 op 拒绝', () => assert.ok(badTrust.error && badTrust.error.includes('未知护栏操作')))
await guard.guardSessionTrust('clipboard_read')
const trustInCheck = await decision('clipboard_read', {})
check('check 面不受会话信任影响（仅执行点消费）', () => {
  assert.notEqual(trustInCheck.via, 'trusted-session')
})

// ⑦ 档位：默认矩阵 + confirm 回执 label（guard_service.py DEFAULT_TIERS/OP_LABELS）
const defaultRun = await decision('run_command', {})
check('run_command 默认 off 直接放行', () => assert.equal(defaultRun.action, 'allow'))
const confirmShape = await decision('clipboard_read', {})
check('confirm 回执带 label（人话标签，非 tier）', () => {
  assert.equal(confirmShape.action, 'confirm')
  assert.equal(confirmShape.op, 'clipboard_read')
  assert.equal(confirmShape.label, '读取剪贴板')
  assert.equal(confirmShape.tier, undefined)
})
await writeCfg({ tiers: { take_screenshot: 'off' } })
const offNow = await decision('take_screenshot', {})
check('提档/降档后按矩阵走', () => assert.equal(offNow.action, 'allow'))

// ⑧ token：{token, ttl:60}（guard_service.py TOKEN_TTL=60）+ 一次性 + 参数绑定
const issued = JSON.parse(await guard.guardConfirmToken('take_screenshot', { note: 'dir' }))
check('confirm_token 签发 {token, ttl:60}', () => {
  assert.ok(issued.token)
  assert.equal(issued.ttl, 60)
  assert.equal(issued.ok, undefined) // Python 契约无 ok 键
})
const badTokenOp = JSON.parse(await guard.guardConfirmToken('no_such_op', {}))
check('confirm_token 未知 op 拒绝', () => assert.ok(badTokenOp.error && badTokenOp.error.includes('未知护栏操作')))
const firstUse = await guard.consumeToken('take_screenshot', { note: 'dir' }, issued.token)
assert.equal(firstUse, true)
results.push('token 首次消费成功')
const secondUse = await guard.consumeToken('take_screenshot', { note: 'dir' }, issued.token)
check('token 不可重复使用', () => assert.equal(secondUse, false))
const issued2 = JSON.parse(await guard.guardConfirmToken('take_screenshot', { note: 'dir' }))
const mismatched = await guard.consumeToken('take_screenshot', { note: 'ls' }, issued2.token)
check('参数变化后 token 无效', () => assert.equal(mismatched, false))

// ⑨ 规则列表与删除（guard_service.py rule_list/rule_remove：幂等 removed 键）
const rules = JSON.parse(await guard.guardRuleList())
check('规则列表可读（归一字段）', () => {
  assert.ok(rules.rules.length >= 1)
  assert.ok(rules.rules[0].op_pattern)
})
const removeNope = JSON.parse(await guard.guardRuleRemove('r_nonexistent'))
check('删除不存在规则幂等 removed=false', () => {
  assert.equal(removeNope.ok, true)
  assert.equal(removeNope.removed, false)
})
await guard.guardRuleRemove(rules.rules[0].rule_id)
const afterRemove = JSON.parse(await guard.guardRuleList())
check('规则删除生效', () => assert.equal(afterRemove.rules.length, rules.rules.length - 1))

// ⑩ 预算读写（guard_service.py approval_budget：越界 BAD_PARAMS 文案）
const badBudget = JSON.parse(await guard.guardApprovalBudget(0))
check('approval_budget 拒绝越界值（1-100 整数）', () => {
  assert.ok(badBudget.error && badBudget.error.includes('1-100 的整数'))
})
const budget = JSON.parse(await guard.guardApprovalBudget(50))
check('approval_budget 设置并回读 limit/used/remaining/grant_active', () => {
  assert.equal(budget.ok, true)
  assert.equal(budget.limit, 50)
  assert.ok(budget.used >= 1)
  assert.ok(budget.remaining <= 49)
  assert.equal(budget.grant_active, false)
})

// ⑪ 未武装执行点放行（guard_service.py:476；本测试全程 HARBOR_GUARD_ARMED=false）
await writeCfg({ tiers: { delete_path: 'always' } })
// P0-1c W6：save_workspace_file 返回带时间戳前缀的裸绝对路径——按返回值删
const victimPath = await workspace.saveWorkspaceFile('victim.txt', 'x')
const unarmedDelete = JSON.parse(await workspace.deletePath(victimPath, true))
check('未武装环境执行点放行（armed=false 跳过档位确认）', () => {
  assert.equal(unarmedDelete.ok, true)
})

// ⑫ 审计链（audit_chain.py：条目五维 + prev_hash/hash 衔接；get_audit_log 链块）
const auditLog = JSON.parse(await misc.getAuditLog(20, 0, false))
check('get_audit_log {ok,total,entries} + 链块 valid', () => {
  assert.equal(auditLog.ok, true)
  assert.ok(Number.isInteger(auditLog.total))
  assert.ok(Array.isArray(auditLog.entries))
  assert.ok(auditLog.chain.head_full)
  assert.equal(auditLog.chain.valid, true)
  assert.ok(Number.isInteger(auditLog.chain.len))
  assert.equal(auditLog.offset, undefined) // Python 契约无回显键
})
check('审计条目五维 + 哈希链字段', () => {
  const entry = auditLog.entries[0]
  assert.ok(entry.ts && entry.op && entry.action)
  assert.ok(entry.identity && entry.identity.principal === 'user')
  assert.ok(entry.intent && typeof entry.intent.summary === 'string')
  assert.ok(entry.prev_hash && entry.hash)
})

// ⑬ 配置归一化（guard_service.py _load：默认全量 + 覆盖；get_config 归一全量）
const fullCfg = JSON.parse(await guard.guardGetConfig())
check('guard_get_config 返回归一全量（17 档矩阵）', () => {
  assert.equal(Object.keys(fullCfg.tiers).length, 17)
  assert.equal(fullCfg.tiers.run_command, 'off')           // 默认矩阵
  assert.equal(fullCfg.tiers.delete_path, 'always')        // c07 覆盖后仍归一
  assert.ok(Array.isArray(fullCfg.protect_paths))
  assert.ok(Array.isArray(fullCfg.protect_processes))
  assert.ok(Array.isArray(fullCfg.trustedOps))
  assert.ok(fullCfg.approval_budget && Number.isInteger(fullCfg.approval_budget.limit))
})
const persisted = JSON.parse(fs.readFileSync(path.join(process.env.HARBOR_CONFIG_DIR, 'guard.json'), 'utf8'))
check('guard.json 整写归一形状（无杂键）', () => {
  assert.ok(persisted.tiers && persisted.protect_paths && persisted.trustedOps)
  assert.equal(persisted.rules, undefined) // 旧增量写法的杂键不再出现
})

// ⑭ kill_process 的护栏面已由 ⑪ 覆盖（未武装放行）；其 pid→名称反查拒杀
// （Python resolve_name_by_id）属 os-system 族行为对齐（T05 范围），不在本组断言。

console.log(JSON.stringify({ ok: true, node: process.version, checks: results.length, results }, null, 2))
