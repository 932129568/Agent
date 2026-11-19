/**
 * expert 安全矩阵 Node 等价门（batch2 逐条复核的验证延伸）。
 *
 * 授权修复轮（2026-11-11）：A/B 两组**全部硬断言拒绝**，并校验返回
 * 与 Python backend/domains/expert/validator.py 同款的细粒度错误码。
 * 符号链接在 Windows 因 EPERM 无法创建时如实 SKIP，不伪造通过。
 *
 * 用法：node server/test/expert-security.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-expert-sec-'))
process.env.HARBOR_CONFIG_DIR = isoDir
process.on('exit', () => {
  try { fs.rmSync(isoDir, { recursive: true, force: true }) } catch { /* 容忍 */ }
})
const experts = await import('../src/services/experts.js')
const parse = v => (typeof v === 'string' ? JSON.parse(v) : v)

let seq = 0
function base(mutate) {
  const dir = path.join(isoDir, 'pkg-' + (++seq))
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    name: 'demo.expert', version: '1.0.0', agents: './agents/',
  }))
  fs.writeFileSync(path.join(dir, 'agents', 'a.md'), '---\nname: a\n---\n# Agent A\n')
  mutate(dir)
  return dir
}
async function attempt(dir) {
  const out = parse(await experts.expertImportDirectory(dir))
  return { rejected: out.ok === false, code: out.ok === false ? out.error?.code : null,
           message: out.ok === false ? out.error?.message : 'IMPORTED' }
}

// ---- A 组：Node 已实现的安全校验（异常统一包装为 EXPERT_IMPORT_INVALID）----
const enforced = []
const skipped = []

// A1 符号链接（Windows 无权限时如实 SKIP）
{
  const dir = base(d => {
    try { fs.symlinkSync(path.join(d, 'agents', 'a.md'), path.join(d, 'link.md')) }
    catch (e) { skipped.push('symlink: ' + e.code) }
  })
  if (!skipped.length) enforced.push(['symlink', await attempt(dir)])
}
// A2 硬链接
{
  const dir = base(d => fs.linkSync(path.join(d, 'agents', 'a.md'), path.join(d, 'hard.md')))
  enforced.push(['hardlink', await attempt(dir)])
}
// A3 凭证文件
{
  const dir = base(d => fs.writeFileSync(path.join(d, '.env'), 'SECRET=1\n'))
  enforced.push(['secret-file', await attempt(dir)])
}
// A4 单文件超 1 MiB
{
  const dir = base(d => fs.writeFileSync(path.join(d, 'big.bin'), Buffer.alloc(1048577)))
  enforced.push(['file-too-large', await attempt(dir)])
}
// A5 agents 声明路径越界
{
  const dir = base(d => fs.writeFileSync(path.join(d, 'plugin.json'), JSON.stringify({
    name: 'demo.expert', version: '1.0.0', agents: '../evil.md',
  })))
  enforced.push(['agents-path-escape', await attempt(dir)])
}
// A6 缺少 plugin.json
{
  const dir = base(d => fs.unlinkSync(path.join(d, 'plugin.json')))
  enforced.push(['missing-metadata', await attempt(dir)])
}
const A_CODES = {
  symlink: 'LINK_NOT_ALLOWED', hardlink: 'HARDLINK_NOT_ALLOWED',
  'secret-file': 'SECRET_FILE_NOT_ALLOWED', 'file-too-large': 'FILE_TOO_LARGE',
  'agents-path-escape': 'PATH_ESCAPE', 'missing-metadata': 'METADATA_NOT_FOUND',
}
for (const [name, result] of enforced) {
  assert.equal(result.rejected, true, `${name} 必须拒绝: ${JSON.stringify(result)}`)
  assert.equal(result.code, A_CODES[name], `${name} 错误码应对齐 Python: ${result.code}`)
}

// ---- B 组：授权修复后应全部拒绝，且返回 Python 同款细粒度错误码 ----
const B_CODES = {
  'metadata-conflict': 'METADATA_CONFLICT',
  'casefold-collision': 'CASEFOLD_COLLISION',
  'unclosed-frontmatter': 'UNCLOSED_BLOCK',
  'metadata-too-large': 'METADATA_TOO_LARGE',
}
const unchecked = []
// B1 两份冲突的 plugin.json
{
  const dir = base(d => {
    fs.mkdirSync(path.join(d, '.codebuddy-plugin'), { recursive: true })
    fs.writeFileSync(path.join(d, '.codebuddy-plugin', 'plugin.json'),
      JSON.stringify({ name: 'other.expert', version: '9.9.9', agents: './agents/' }))
  })
  unchecked.push(['metadata-conflict', await attempt(dir)])
}
// B2 NFC/case-fold 冲突：Windows 大小写不敏感，A.md 与 a.md 是同一文件无法构造，
// 改用 Unicode NFC('café') 与 NFD('cafe'+U+0301) 两个真实不同的 NTFS 文件名。
{
  const dir = base(d => {
    fs.writeFileSync(path.join(d, 'agents', 'caf\u00e9.md'), '# nfc\n')
    fs.writeFileSync(path.join(d, 'agents', 'cafe\u0301.md'), '# nfd\n')
  })
  unchecked.push(['casefold-collision', await attempt(dir)])
}
// B3 frontmatter 未闭合
{
  const dir = base(d => fs.writeFileSync(path.join(d, 'agents', 'a.md'), '---\nname: a\n# no close\n'))
  unchecked.push(['unclosed-frontmatter', await attempt(dir)])
}
// B4 plugin.json 超过 64 KiB（未超单文件 1 MiB 上限）
{
  const dir = base(d => fs.writeFileSync(path.join(d, 'plugin.json'), JSON.stringify({
    name: 'demo.expert', version: '1.0.0', agents: './agents/', padding: 'x'.repeat(70000),
  })))
  unchecked.push(['metadata-too-large', await attempt(dir)])
}
for (const [name, result] of unchecked) {
  assert.equal(result.rejected, true, `${name} 修复后必须拒绝: ${JSON.stringify(result)}`)
  assert.equal(result.code, B_CODES[name], `${name} 错误码应对齐 Python: ${result.code}`)
}
const implementationGaps = []

console.log(JSON.stringify({
  ok: true,
  enforced: enforced.map(([name, r]) => ({ case: name, rejected: r.rejected, code: r.code })),
  skipped,
  newlyEnforced: unchecked.map(([name, r]) => ({ case: name, rejected: r.rejected, code: r.code })),
  implementationGaps,
  protocolCaveat: 'Node 拒绝行为现返回与 Python 同款的细粒度错误码；'
    + '仍非逐字节等价（message 文案、details 结构与部分边界码有差异）。',
  defectsFixed: ['EXPERT-01 metadata 冲突', 'EXPERT-02 case-fold 冲突',
                 'EXPERT-03 frontmatter 未闭合', 'EXPERT-04 metadata 超限',
                 'EXPERT-05 细粒度错误码矩阵'],
  authorizedBy: '用户「授权」（2026-11-11）',
}, null, 2))
