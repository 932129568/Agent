/**
 * 状态类服务族验证：工作区绑定、记忆、计划/检查点、独立配置、审计。
 * 全部在临时目录隔离执行。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-state-'))
process.env.HARBOR_CONFIG_DIR = path.join(tmp, 'config')
process.env.DATABASE_URL = `file:${path.join(tmp, 'app.db')}`
process.env.LOG_LEVEL = 'silent'

const { setCwd, setCurrentSid } = await import('../src/runtime.js')
const workspace = await import('../src/services/workspace.js')
const memory = await import('../src/services/memory.js')
const plans = await import('../src/services/plans.js')
const misc = await import('../src/services/misc.js')
const { readConfigText, mergeConfig } = await import('../src/services/jsonstore.js')

// delete_path 已接入护栏：本用例显式设为 off 档以测试文件语义本身
mergeConfig('guard.json', JSON.stringify({ tiers: { delete_path: 'off' } }))

const ws = path.join(tmp, 'ws')
fs.mkdirSync(ws, { recursive: true })   // set_session_ws 要求目录已存在（与 legacy 一致）
setCwd(ws)
setCurrentSid('s_state')

const results = []
const check = (name, fn) => { fn(); results.push(name) }

/* 工作区 */
await workspace.setSessionWs('s_state', ws)
const eff = JSON.parse(await workspace.getEffectiveWs('s_state'))
check('绑定后 get_effective_ws 返回 {sid,ws,source,exists}（W1 无 ok/bound 键）', () => {
  assert.equal(eff.sid, 's_state')
  assert.equal(eff.ws, ws)
  assert.equal(eff.source, 'session')
  assert.equal(eff.exists, true)
  assert.equal(eff.ok, undefined)
  assert.equal(eff.bound, undefined)
})
await workspace.setWsEnabled('s_state', false)
const enabled = JSON.parse(await workspace.getWsEnabled('s_state'))
check('set_ws_enabled(false) 后 get_ws_enabled 为 {enabled:false}（W3 无 ok 键）', () => {
  assert.equal(enabled.enabled, false)
  assert.equal(enabled.ok, undefined)
})
const wsState = JSON.parse(await workspace.getWsState('s_state'))
check('get_ws_state 返回 {ws,bound,enabled,recent}（W4 无 ok/exists）', () => {
  assert.equal(wsState.enabled, false)
  assert.equal(wsState.bound, true)
  assert.ok(Array.isArray(wsState.recent))
  assert.equal(wsState.recent[0].path, ws)
  assert.equal(wsState.recent[0].name, 'ws')
  assert.equal(typeof wsState.recent[0].ts, 'number')
})
const recentList = JSON.parse(await workspace.listRecentWs())
check('list_recent_ws 裸 JSON 数组 [{path,name,ts}]（W5）', () => {
  assert.ok(Array.isArray(recentList))
  assert.equal(recentList[0].path, ws)
  assert.equal(recentList[0].name, 'ws')
})

const saved = await workspace.saveWorkspaceFile('a.md', '内容')
check('save_workspace_file 返回裸绝对路径 + YYYYMMDD_HHMMSS_ 前缀（W6）', () => {
  assert.equal(typeof saved, 'string')
  assert.ok(path.isAbsolute(saved))
  assert.match(path.basename(saved), /^\d{8}_\d{6}_a\.md$/)
  assert.ok(fs.existsSync(saved))
})
const del = JSON.parse(await workspace.deletePath(saved, true))
check('delete_path 回报 mode=回收站（P0-1c F6：VB FileIO 真实回收站，与 send2trash 同因同果）', () => {
  assert.equal(del.ok, true)
  assert.equal(del.mode, '回收站')
  assert.equal(path.isAbsolute(del.path), true)
})

/* 记忆 */
const ruleResult = JSON.parse(await memory.appendMemory({ text: '必须保留现有模型文件' }))
check('append_memory 自动归类为 rule', () => assert.equal(ruleResult.kind, 'rule'))
const dup = JSON.parse(await memory.appendMemory({ text: '必须保留现有模型文件' }))
check('rule 文本去重', () => assert.equal(dup.deduped, true))
const factResult = JSON.parse(await memory.appendMemory({ text: '用户在做 Harbor 升级' }))
check('普通内容归类为 fact', () => assert.equal(factResult.kind, 'fact'))
const retrieved = JSON.parse(await memory.memoryRetrieve('模型文件', 3))
check('memory_retrieve 命中相关记忆', () => {
  assert.ok(retrieved.items.length > 0)
  assert.ok(retrieved.items[0].text.includes('模型文件'))
})
const all = JSON.parse(await memory.getMemory())
check('get_memory 返回结构化数组且条目带 ts/ts_iso 双字段（M1）', () => {
  assert.ok(all.length >= 2)
  assert.ok(all.every(x => typeof x.ts === 'string' && typeof x.ts_iso === 'string'))
  assert.match(all[0].ts_iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/)
})
const deleted = JSON.parse(await memory.memoryDelete(0))
check('memory_delete 按索引删除 → {ok,remaining}（M3 无 total 键）', () => {
  assert.equal(deleted.ok, true)
  assert.equal(typeof deleted.remaining, 'number')
  assert.equal(deleted.total, undefined)
})
const oob = JSON.parse(await memory.memoryDelete(99))
check('memory_delete 越界 → BAD_PARAMS 结构化（M4）', () => {
  assert.equal(oob.ok, false)
  assert.equal(oob.error.code, 'BAD_PARAMS')
  assert.equal(oob.error.message, `序号越界：当前共 ${all.length - 1} 条记忆`)
  assert.equal(oob.error.hint, '刷新列表后重试；序号从 0 开始')
})
const nonInt = JSON.parse(await memory.memoryDelete(true))
check('memory_delete 非整数 → BAD_PARAMS + hint（M4 对齐 _coerce_index）', () => {
  assert.equal(nonInt.ok, false)
  assert.equal(nonInt.error.code, 'BAD_PARAMS')
  assert.equal(nonInt.error.message, '序号需要是整数')
  assert.equal(nonInt.error.hint, '传入要删除的记忆序号（从 0 开始）')
})
const nonIntStr = JSON.parse(await memory.memoryDelete('abc'))
check('memory_delete 非数字串 → %r 收到值（M4 对齐 _coerce_index）', () => {
  assert.equal(nonIntStr.error.code, 'BAD_PARAMS')
  assert.equal(nonIntStr.error.message, "序号需要是整数（收到 'abc'）")
})
const numericStr = JSON.parse(await memory.memoryDelete('0'))
check('memory_delete 数字串按 int 解析（M4 对齐 _coerce_index）', () => {
  assert.equal(numericStr.ok, true)
  assert.equal(typeof numericStr.remaining, 'number')
})

/* 计划与检查点（legacy 参数/返回形状） */
const created = JSON.parse(await plans.planCreate('迁移全部方法', [
  { text: '核对契约', risk: 'read', tools: ['read_file'] },
  { text: '完成迁移', risk: 'l2' },
], 'task_state'))
check('plan_create 返回 task_id 与 planning 计划', () => {
  assert.equal(created.task_id, 'task_state')
  assert.equal(created.plan.status, 'planning')
  assert.equal(created.plan.steps.length, 2)
})
const got = JSON.parse(await plans.planGet(created.task_id))
check('plan_get 返回 {ok,plan}', () => assert.equal(got.plan.title, '迁移全部方法'))
const updated = JSON.parse(await plans.planUpdate(created.task_id, 'approved', 0, 'done'))
const listed = JSON.parse(await plans.planList(20))
check('plan_update + plan_list 反映状态', () => {
  assert.equal(updated.plan.status, 'approved')
  assert.equal(updated.plan.steps[0].status, 'done')
  assert.equal(listed.plans[0].status, 'approved')
})
const invalidStep = JSON.parse(await plans.planUpdate(created.task_id, '', 0, 'invalid'))
check('非法步骤状态被显式拒绝', () => assert.ok(invalidStep.error))
const clarified = JSON.parse(await plans.clarifyCollect([
  { q: '选择范围', options: ['全部', '部分'], default: 0 },
], { 0: 1 }))
check('clarify_collect 返回 resolved 选项', () => assert.equal(clarified.resolved[0].answer, '部分'))
fs.writeFileSync(path.join(ws, 'note.txt'), 'snapshot-content')
const cp = JSON.parse(await plans.checkpointCreate(created.task_id, ['note.txt'], ws))
check('checkpoint_create 生成指定文件快照', () => {
  assert.equal(cp.mode, 'snapshot')
  assert.equal(cp.snapshot_count, 1)
})
const cpList = JSON.parse(await plans.checkpointList(created.task_id))
check('checkpoint_list 返回文件清单', () => assert.equal(cpList.files[0].path, 'note.txt'))
fs.writeFileSync(path.join(ws, 'note.txt'), 'changed-after-snapshot')
const refusedRollback = JSON.parse(await plans.checkpointRollback(created.task_id, ws, false))
check('回滚缺 confirm 时返回 CONFIRM_REQUIRED', () => {
  assert.equal(refusedRollback.error.code, 'CONFIRM_REQUIRED')
  assert.equal(fs.readFileSync(path.join(ws, 'note.txt'), 'utf8'), 'changed-after-snapshot')
})
const rollback = JSON.parse(await plans.checkpointRollback(created.task_id, ws, true))
check('确认后恢复快照、保留回滚前备份并校验哈希', () => {
  assert.equal(rollback.ok, true)
  assert.deepEqual(rollback.restored, ['note.txt'])
  assert.equal(rollback.verified, true)
  assert.equal(fs.readFileSync(path.join(ws, 'note.txt'), 'utf8'), 'snapshot-content')
  assert.equal(fs.readFileSync(path.join(ws, 'note.txt.rollback-bak'), 'utf8'), 'changed-after-snapshot')
})
const escapedCheckpoint = JSON.parse(await plans.checkpointCreate('task_escape', ['../outside.txt'], ws))
check('检查点路径穿越被跳过', () => {
  assert.equal(escapedCheckpoint.snapshot_count, 0)
  assert.ok(escapedCheckpoint.warnings.some(x => x.includes('越界')))
})

/* 独立配置 */
check('guard_get_config 缺文件返回 {}', () => assert.equal(readConfigText('nonexistent-config.json'), '{}'))
mergeConfig('guard.json', '{"tiers":{"run_command":"always"}}')
check('guard_save_config 合并写入', () => {
  assert.ok(readConfigText('guard.json').includes('run_command'))
})
check('guard_save_config 拒绝非对象', () => {
  assert.ok(mergeConfig('guard.json', '[1]').includes('error'))
})

/* 审计与历史目录 */
await misc.guardAudit('write_file', { path: 'a.txt' }, 'decision', 'allow')
const audit = JSON.parse(await misc.getAuditLog(10, 0))
check('guard_audit + get_audit_log 回读', () => {
  assert.ok(audit.total >= 1)
  assert.equal(audit.entries[0].op, 'write_file')
})
await misc.historyDirSet(tmp)
const hd = JSON.parse(await misc.historyDirGet())
check('history_dir_set/get 回读目录', () => assert.equal(hd.dir, tmp))

console.log(JSON.stringify({ ok: true, node: process.version, checks: results.length, results }, null, 2))
