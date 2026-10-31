/**
 * P0-2 T03 跨语言 DPAPI 互解验证（Q4 许可：一次性 Python 解密脚本，临时文件上）。
 *   node tools/verify-dpapi-interop.mjs
 *
 * 双向各 ≥1 例：
 *   A. Node 加密 → Python mcp_dpapi.decrypt_value 解密（临时文件传递标记）；
 *   B. Python encrypt_value 加密（模拟历史密文）→ Node 解密。
 * 只调用 backend 模块函数、零 backend/ 改动、全程临时目录、验证用例为非真实密钥。
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PYTHON = 'C:/Users/陈/.workbuddy/binaries/python/envs/default/Scripts/python.exe'
const SECRET = '互解验证-非真实密钥-🚀-2026'
const { isAvailable, encryptValue, decryptValue } = await import(
  pathToFileURL(path.join(ROOT, 'server', 'src', 'services', 'dpapi.js')).href)

const available = await isAvailable()
console.log('DPAPI available:', available)
assert.equal(available, true, '本环境 DPAPI 应可用（PowerShell ProtectedData 主路径）')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-dpapi-interop-'))
const markerFile = path.join(work, 'marker.txt')

// ---------- A. Node 加密 → Python 解密 ----------
const nodeMarker = await encryptValue(SECRET)
assert.ok(nodeMarker.startsWith('dpapi:'), 'Node 加密应产出 dpapi: 前缀')
fs.writeFileSync(markerFile, nodeMarker, 'utf8')
const plainFile = path.join(work, 'plain.txt')
// 解密结果写 UTF-8 文件（不经控制台——消除 Windows GBK 控制台编码变量）
const pyDecrypt = await execFileAsync(PYTHON, ['-c', `
import sys
sys.path.insert(0, ${JSON.stringify(ROOT)})
from backend.domains.integrations.mcp import mcp_dpapi
marker = open(${JSON.stringify(markerFile)}, encoding='utf-8').read().strip()
plain = mcp_dpapi.decrypt_value(marker)
open(${JSON.stringify(plainFile)}, 'w', encoding='utf-8', newline='').write(plain)
`], { maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
stepA: {
  const plain = fs.readFileSync(plainFile, 'utf8')
  assert.equal(plain, SECRET, `Node 密文 Python 解密不符: ${plain}`)
  console.log('PASS A: Node 加密 → Python mcp_dpapi.decrypt_value 解密一致（含中文+emoji）')
}

// ---------- B. Python 加密（历史密文）→ Node 解密 ----------
const pyEncrypt = await execFileAsync(PYTHON, ['-c', `
import sys
sys.path.insert(0, ${JSON.stringify(ROOT)})
from backend.domains.integrations.mcp import mcp_dpapi
marker = mcp_dpapi.encrypt_value(${JSON.stringify(SECRET)})
assert marker.startswith('dpapi:')
open(${JSON.stringify(markerFile)}, 'w', encoding='utf-8').write(marker)
print('py-encrypted')
`], { maxBuffer: 4 * 1024 * 1024 })
const pyMarker = fs.readFileSync(markerFile, 'utf8').trim()
const nodePlain = await decryptValue(pyMarker)
assert.equal(nodePlain, SECRET, `Python 密文 Node 解密不符: ${nodePlain}`)
console.log('PASS B: Python encrypt_value 加密（历史密文）→ Node 解密一致')

console.log(JSON.stringify({ ok: true, available, interop: ['node→python', 'python→node'], sample: SECRET.length }, null, 2))
