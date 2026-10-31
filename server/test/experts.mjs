import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-expert-'))
process.env.HARBOR_CONFIG_DIR = path.join(tmp, 'config')
process.env.DATABASE_URL = `file:${path.join(tmp, 'app.db')}`
process.env.LOG_LEVEL = 'silent'
const pkg = path.join(tmp, 'package')
fs.mkdirSync(path.join(pkg, '.codebuddy-plugin'), { recursive: true })
fs.mkdirSync(path.join(pkg, 'agents'), { recursive: true })
fs.mkdirSync(path.join(pkg, 'skills', 'demo'), { recursive: true })
fs.writeFileSync(path.join(pkg, '.codebuddy-plugin', 'plugin.json'), JSON.stringify({ name: 'demo-expert', version: '1.2.3', expertType: 'agent', agents: ['./agents/main.md'], skills: ['./skills/demo'] }))
fs.writeFileSync(path.join(pkg, 'agents', 'main.md'), '# Demo Agent\n只读提示词')
fs.writeFileSync(path.join(pkg, 'skills', 'demo', 'SKILL.md'), '# Demo Skill')

const experts = await import('../src/services/experts.js')
const results = []; const check = (name, fn) => { fn(); results.push(name) }
const imported = JSON.parse(await experts.expertImportDirectory(pkg))
check('目录导入生成内容寻址快照', () => {
  assert.equal(imported.ok, true); assert.equal(imported.package_id, 'demo-expert'); assert.match(imported.snapshot_id, /^[0-9a-f]{64}$/)
})
const listed = JSON.parse(await experts.expertList('demo'))
check('列表检索返回版本与启停状态', () => { assert.equal(listed.packages.length, 1); assert.equal(listed.packages[0].enabled, false) })
// P0-1c E1：内置专家包导入（backend/experts_builtin/ 8 包，source.builtin 标记）
const allPackages = JSON.parse(await experts.expertList(''))
check('内置包导入 8 个（design-engine 等，source=builtin）', () => {
  const builtins = allPackages.packages.filter(p => p.source && p.source.kind === 'builtin')
  assert.equal(builtins.length, 8)
  assert.ok(builtins.some(p => p.id === 'design-engine'))
})
check('内置 team 包带 AGENT_LIMIT_INTERSECTED 警告（validator maxTurns 超限）', () => {
  const design = allPackages.packages.find(p => p.id === 'design-engine')
  assert.ok(design.warnings.some(w => w.startsWith('AGENT_LIMIT_INTERSECTED:agents/')))
})
const got = JSON.parse(await experts.expertGet('demo-expert'))
check('读取快照元数据与 agents', () => { assert.equal(got.package.version, '1.2.3'); assert.deepEqual(got.package.agents, ['agents/main.md']) })
const enabled = JSON.parse(await experts.expertSetEnabled('demo-expert', true, imported.snapshot_id))
check('启用并激活指定快照', () => { assert.equal(enabled.enabled, true); assert.equal(enabled.active_snapshot, imported.snapshot_id) })
const resource = JSON.parse(await experts.expertReadResource(imported.snapshot_id, 'agents/main.md'))
check('只读资源返回文本与 provenance', () => { assert.ok(resource.text.includes('Demo Agent')); assert.equal(resource.provenance.snapshotId, imported.snapshot_id) })
const escaped = JSON.parse(await experts.expertReadResource(imported.snapshot_id, '../../config.json'))
check('资源目录穿越被拒绝', () => assert.equal(escaped.ok, false))
const snapshotFile = path.join(process.env.HARBOR_CONFIG_DIR, 'experts', 'snapshots', 'demo-expert', imported.snapshot_id, 'agents', 'main.md')
fs.writeFileSync(snapshotFile, 'tampered')
const tampered = JSON.parse(await experts.expertReadResource(imported.snapshot_id, 'agents/main.md'))
check('快照内容篡改被 hash 校验拒绝', () => assert.ok(tampered.error.message.includes('hash')))
fs.writeFileSync(snapshotFile, '# Demo Agent\n只读提示词')
const prefs = JSON.parse(await experts.expertSavePreferences(JSON.stringify({ limits: { maxFiles: 256 } })))
check('偏好只允许收紧限额', () => assert.equal(prefs.limits.maxFiles, 256))
const invalidPrefs = JSON.parse(await experts.expertSavePreferences(JSON.stringify({ limits: { unknown: 1 } })))
check('未知偏好字段返回结构化错误', () => assert.equal(invalidPrefs.error.code, 'INVALID_PREFERENCES'))
const deleted = JSON.parse(await experts.expertDeletePackage('demo-expert'))
check('删除注册项但保留内容快照', () => {
  assert.equal(deleted.deleted, true)
  assert.ok(fs.existsSync(path.join(process.env.HARBOR_CONFIG_DIR, 'experts', 'snapshots', 'demo-expert', imported.snapshot_id)))
})
console.log(JSON.stringify({ ok: true, checks: results.length, results }, null, 2))
