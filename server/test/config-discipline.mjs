/**
 * C 路径 · 步骤 4 第一批：config.json 零污染纪律的 Node 侧等价门。
 *
 * 对应旧钉 `tests/test_v19_paths.py` 的前三项（六独立配置常量 / config.json
 * 路径零改动 / ensure_dirs 幂等）。第四项钉的是 pywebview 的 Harbor.spec，
 * 属历史链，随步骤 5 删实现一并退役，不在 Node 侧复刻（见处置台账）。
 *
 * 用法：node server/test/config-discipline.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 与 contract-*.mjs 同范式：先隔离 CONFIG_DIR 再动态 import，绝不写真实 ~/.glm-chat。
const isoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-config-discipline-'))
process.env.HARBOR_CONFIG_DIR = isoDir
process.on('exit', () => {
  try { fs.rmSync(isoDir, { recursive: true, force: true }) } catch { /* 容忍 */ }
})
const paths = await import('../src/paths.js')

// 1. config.json 路径本身零改动，且 CONFIG_DIR 可被隔离（等价 fresh_home 前置）
assert.equal(paths.CONFIG_DIR, isoDir, 'CONFIG_DIR 未受 HARBOR_CONFIG_DIR 隔离')
assert.equal(paths.CONFIG_PATH, path.join(isoDir, 'config.json'))

// 2. 运行态一律独立文件，不并入 config.json
assert.notEqual(paths.RUNTIME_PATH, paths.CONFIG_PATH)
assert.equal(path.basename(paths.RUNTIME_PATH), 'harbor-node-runtime.json')
const runtimeSource = fs.readFileSync(path.join(serverRoot, 'src/runtime.js'), 'utf8')
assert.match(runtimeSource, /RUNTIME_PATH/, '运行态必须写独立 runtime 文件')

// 3. 独立配置族：扫描 src 下 path.join(CONFIG_DIR, '<file>') 的声明
const sources = []
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) walk(p)
    else if (name.endsWith('.js')) sources.push(fs.readFileSync(p, 'utf8'))
  }
}
walk(path.join(serverRoot, 'src'))
const declared = new Set()
for (const src of sources) {
  for (const m of src.matchAll(/path\.join\(CONFIG_DIR,\s*'([^']+)'\)/g)) declared.add(m[1])
}
assert.ok(declared.size >= 4, '独立配置文件声明过少: ' + declared.size)
const jsonLeaves = [...declared].filter(n => n.endsWith('.json') && n !== 'config.json')
assert.ok(jsonLeaves.length >= 3, '独立 JSON 配置族过少: ' + jsonLeaves.length)
assert.ok(declared.has('harbor-node-runtime.json'), '运行态独立文件必须显式声明')
assert.equal(new Set(jsonLeaves).size, jsonLeaves.length, '独立配置常量必须互异')

// 4. ensureDir 幂等（等价 ensure_dirs 建 PLATFORM_DIR 且重复调用不抛）
paths.ensureDir(path.join(isoDir, 'platform'))
assert.ok(fs.statSync(path.join(isoDir, 'platform')).isDirectory())
paths.ensureDir(path.join(isoDir, 'platform'))
assert.ok(fs.statSync(isoDir).isDirectory())

console.log(JSON.stringify({
  ok: true,
  config_path_ok: true,
  runtime_independent: true,
  independent_json_files: jsonLeaves.sort(),
  declared_config_leaves: [...declared].sort(),
  ensure_dir_idempotent: true,
  coverage: 'config.json 零污染纪律 + 独立配置族 + 目录幂等（Harbor.spec 历史钉随步骤 5 退役）',
}, null, 2))
