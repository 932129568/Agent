/**
 * C 路径 · 步骤 4 第四批：记忆域 Node 等价门。
 *
 * 销口对象（docs/behavior-review-batch1.json 中判为 gap/partial 的钉）：
 *   - test_remember_gate_rejects_sensitive  → 敏感字段拒写（AGENTS.md 红线）
 *   - test_legacy_multi_note_no_supersede  → 重复内容 NOOP 去重
 *   - test_erase_soft_scrubs_and_stats     → 擦除（部分）
 *   - test_hard_erase_tombstone            → 硬擦除（部分）
 *
 * 实现依据：server/src/services/pybridge.js::memoryWrite。
 * 第四批先按 QA 口径停测回传 DEF-01（去重查 fact_records 却写 profile_kv）；
 * 用户随即「授权」修复，故本门第 4 项已恢复为硬断言。
 * 引擎代码仅 memoryWrite 一处最小改动（补查 profile_kv），其余不动。
 *
 * 协议形状差异（如实登记）：Python 内部服务 svc.remember() 返回
 * {action:'rejected', reason:'sensitive...'}；Node 侧返回 {error:'...'}。
 * 两者语义同为「拒绝写入」，但**不是逐字节等价**，不得据此宣称契约零漂移。
 *
 * 用法：node server/test/memory-gate.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 与其他 contract-* 门同范式：先隔离 CONFIG_DIR 再动态 import，绝不写真实 ~/.glm-chat。
const isoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-memory-gate-'))
process.env.HARBOR_CONFIG_DIR = isoDir
process.on('exit', () => {
  try { fs.rmSync(isoDir, { recursive: true, force: true }) } catch { /* 容忍 */ }
})
const pb = await import('../src/services/pybridge.js')
const parse = value => (typeof value === 'string' ? JSON.parse(value) : value)

const checks = []

// 1. 空内容拒绝
const empty = parse(await pb.memoryWrite('   '))
assert.ok(!empty.ok && empty.error, '空内容必须拒绝')
checks.push('空内容拒绝')

// 2. 敏感字段拒写（对应 Python 钉 test_remember_gate_rejects_sensitive）
const sensitiveTexts = [
  '我的api_key是 sk-abcdef1234567890abcd',
  'password=123456',
  'secret: abcdef',
  '这是我的密钥 abc',
  '凭据 tencent-cloud-token',
  'API KEY = xyz',
]
for (const text of sensitiveTexts) {
  const out = parse(await pb.memoryWrite(text))
  assert.ok(!out.ok, '敏感内容不得写入: ' + text)
  assert.match(String(out.error || ''), /敏感|密钥|密码|凭据/, '拒绝原因缺失: ' + text)
}
checks.push('6 类敏感文本全部拒绝且给出原因')

// 3. 拒写后未落库
const entries = parse(await pb.memoryEntriesList())
assert.ok(!JSON.stringify(entries).includes('sk-abcdef1234567890abcd'),
  '敏感内容不得落库')
checks.push('拒写内容未落库')

// 4. 正常写入 + 重复写入 NOOP 去重（对应 test_legacy_multi_note_no_supersede）
// DEF-01 已获用户授权修复（2026-11-10）：memoryWrite 补查 profile_kv 后恢复硬断言。
const first = parse(await pb.memoryWrite('用户偏好使用简体中文回复'))
assert.equal(first.ok, true, '正常内容应可写入')
assert.equal(first.action, 'upsert', '首次写入应为 upsert')
const second = parse(await pb.memoryWrite('用户偏好使用简体中文回复'))
assert.equal(second.action, 'noop', '重复内容必须 NOOP 去重（DEF-01 回归）')
assert.equal(second.reason, 'duplicate')
checks.push('正常写入 + 重复 NOOP 去重（DEF-01 已修复）')

// 5. 擦除接口可用（对应 erase 相关 partial 钉的能力面）
const eraseSoft = parse(await pb.memoryErase(null, false))
assert.ok(eraseSoft && typeof eraseSoft === 'object', '软擦除应返回对象')
const eraseHard = parse(await pb.memoryErase(null, true))
assert.ok(eraseHard && typeof eraseHard === 'object', '硬擦除应返回对象')
checks.push('软/硬擦除接口可用')

console.log(JSON.stringify({
  ok: true,
  checks: checks.length,
  results: checks,
  coveredPins: [
    'test_remember_gate_rejects_sensitive（敏感字段拒写，6 类文本 + 未落库）',
    'test_legacy_multi_note_no_supersede（重复写入 NOOP 去重，DEF-01 修复后）',
    'test_erase_soft_scrubs_and_stats（擦除能力面，scrub/stats 仍 partial）',
    'test_hard_erase_tombstone（擦除能力面，tombstone 语义仍 partial）',
  ],
  implementationDefects: [],
  defectsFixed: [{
    id: 'DEF-01',
    component: 'server/src/services/pybridge.js::memoryWrite',
    fix: '去重保留 fact_records 查询，并补查 profile_kv 的 (user_id, value)；命中即返回 noop/duplicate',
    authorizedBy: '用户「授权」（2026-11-10）',
    verifiedBy: '本门第 4 项硬断言：首次 upsert、重复 noop + reason=duplicate',
  }],
  caveat: 'Python 内部服务 {action:rejected,reason:sensitive...} 与 Node {error:...} 形状不同，语义等价但非逐字节等价',
}, null, 2))
