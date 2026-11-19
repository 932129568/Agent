/**
 * C 路径 · settings 子域契约/行为等价门（batch3）。
 *
 * 逐条复核对象：test_model_prefs.py / test_release_discipline.py /
 * test_r59_deps.py 中可由 Node 侧验证的部分。
 * 静态发布线（VERSION / check_release.py）与 Python import 环不在此门范围，
 * 在 behavior-review-batch3.json 中按断言对象单独归类。
 *
 * 用法：node server/test/settings-equivalence.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-settings-eq-'))
process.env.HARBOR_CONFIG_DIR = isoDir
process.on('exit', () => {
  try { fs.rmSync(isoDir, { recursive: true, force: true }) } catch { /* 容忍 */ }
})
const registry = await import('../src/registry.js')
const parse = v => (typeof v === 'string' ? JSON.parse(v) : v)
const get = async () => parse(await registry.invoke('model_prefs_get', []))
const save = async obj => parse(await registry.invoke('model_prefs_save',
  [typeof obj === 'string' ? obj : JSON.stringify(obj)]))
const checks = []

// 1. 默认值
{
  const d = await get()
  assert.equal(d.ok, true)
  assert.equal(d.thinking, 'auto')
  assert.equal(d.ctx_k, 0)
  checks.push('model_prefs 缺省 thinking=auto / ctx_k=0 / ok=true')
}
// 2. 保存往返
{
  const r = await save({ thinking: 'high', ctx_k: 300 })
  assert.equal(r.ok, true)
  assert.equal(r.thinking, 'high')
  assert.equal(r.ctx_k, 300)
  const g = await get()
  assert.equal(g.thinking, 'high')
  assert.equal(g.ctx_k, 300)
  checks.push('model_prefs_save/get 往返一致')
}
// 3. 接受 JSON 字符串
{
  const r = await save(JSON.stringify({ thinking: 'off' }))
  assert.equal(r.ok, true)
  assert.equal((await get()).thinking, 'off')
  checks.push('model_prefs_save 接受 JSON 字符串')
}
// 4. thinking 白名单拒绝且默认不变
{
  const bad = await save({ thinking: 'bogus' })
  assert.ok(bad.error, '非法 thinking 应返回 error')
  assert.equal((await get()).thinking, 'off', '拒绝后原值不变')
  checks.push('thinking 白名单拒绝且不污染现值')
}
// 5. ctx_k 边界与钳制（Python _ctx_k_clamp 同款）
{
  assert.ok((await save({ thinking: 'auto', ctx_k: -1 })).error, '负数应拒绝')
  const c1 = await save({ thinking: 'auto', ctx_k: 200 })
  assert.equal(c1.ok, true)
  assert.equal(c1.ctx_k, 128, '200 应收敛到 128')
  const c2 = await save({ thinking: 'auto', ctx_k: 100 })
  assert.equal(c2.ctx_k, 32, '100 应收敛到 32')
  const c3 = await save({ thinking: 'auto', ctx_k: 2048 })
  assert.equal(c3.ok, true)
  assert.equal(c3.ctx_k, 1024, '2048 应收敛到 1024')
  checks.push('ctx_k 边界拒绝 + 收敛到前端支持低档（200→128 / 100→32 / 2048→1024）')
}
// 6. 损坏文件：回退默认 + 生成 .bad 备份（Python model_prefs_service._bad_backup 同口径）
{
  const fp = path.join(isoDir, 'model_prefs.json')
  fs.writeFileSync(fp, '{corrupt!!!', 'utf8')
  const d = await get()
  assert.equal(d.ok, true)
  assert.equal(d.thinking, 'auto')
  assert.equal(d.ctx_k, 0)
  assert.ok(fs.existsSync(fp + '.bad'), '损坏 model_prefs.json 应生成 .bad 备份')
  assert.ok(fs.readFileSync(fp + '.bad', 'utf8').includes('corrupt'), '.bad 应保留损坏现场')
  checks.push('损坏文件回退默认 + 生成 .bad 备份（保留损坏现场）')
}
// 7. config.json 零污染：偏好独立文件，不写主配置
// 先做一次合法保存以恢复上一节损坏的文件（恢复路径本身也是可验证行为）
{
  const recovered = await save({ thinking: 'auto', ctx_k: 0 })
  assert.equal(recovered.ok, true, '损坏后应能通过合法保存恢复')
  const main = path.join(isoDir, 'config.json')
  if (fs.existsSync(main)) {
    const cfg = JSON.parse(fs.readFileSync(main, 'utf8'))
    assert.ok(!('model_prefs' in cfg) && !('thinking' in cfg) && !('ctx_k' in cfg))
  }
  assert.ok(fs.existsSync(path.join(isoDir, 'model_prefs.json')),
    '偏好应落独立 model_prefs.json')
  checks.push('config.json 零污染，偏好落独立文件')
}
// 8. 隐身注册与公开自省面零漂移
{
  const info = parse(await registry.invoke('get_api_info', []))
  assert.equal(info.version, 'v1.0.0')
  assert.equal(info.methods.length, 51)
  for (const m of ['model_prefs_get', 'model_prefs_save',
                   'trace_new', 'trace_recent']) {
    assert.ok(!info.methods.includes(m), `${m} 应隐身不进公开面`)
  }
  checks.push('get_api_info 51 方法 / v1.0.0；model_prefs 与 trace 方法隐身')
}

console.log(JSON.stringify({
  ok: true,
  checks: checks.length,
  results: checks,
  openImplementationGaps: [],
  scope: 'settings 子域：model_prefs 10 钉 + release_discipline 契约子集 + r59_deps 契约子集',
  outOfScope: [
    'VERSION 文件 / APP_VERSION 发布线（由用户管理的 VERSION 与 tools/check_release.py 承担）',
    'tools/check_release.py 自身行为（Python 工具脚本）',
    'Python import 图无环（Python 侧静态扫描）',
    'UI 缝星形拓扑 / 层模块下游化（前端静态钉，由 arch-contract 承担）',
  ],
  disposition: '损坏 model_prefs.json 的 .bad 备份已在引擎侧（config-specs.js 读取钩子）真实实现，改硬断言通过',
}, null, 2))
