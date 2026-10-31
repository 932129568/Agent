/** js_api 参数个数契约：防止“方法名对了，但位置参数顺序/数量漂移”。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listSignatures } from '../src/registry.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = fs.readFileSync(path.join(root, 'backend', 'api.py'), 'utf8')
const legacy = {}
const pattern = /^    def ([a-z][a-z0-9_]*)\(self,?\s*([\s\S]*?)\):/gm
for (const match of source.matchAll(pattern)) {
  const params = []; let current = ''; let depth = 0; let quote = ''
  for (const ch of match[2]) {
    if (quote) { current += ch; if (ch === quote) quote = ''; continue }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue }
    if ('([{'.includes(ch)) depth++
    if (')]}'.includes(ch)) depth--
    if (ch === ',' && depth === 0) { params.push(current.trim()); current = ''; continue }
    current += ch
  }
  if (current.trim()) params.push(current.trim())
  legacy[match[1]] = params.filter(x => x && x !== 'self' && !x.startsWith('*'))
    .map(x => x.split('=')[0].trim())
}
const node = listSignatures()
const mismatches = Object.keys(node).filter(name => {
  if (legacy[name] == null || legacy[name].length !== node[name].length) return true
  return legacy[name].some((param, index) => param !== node[name][index])
}).map(name => ({ name, legacy_signature: legacy[name], node_signature: node[name] }))
  .sort((a, b) => a.name.localeCompare(b.name))
console.log(JSON.stringify({ ok: mismatches.length === 0, checked: Object.keys(node).length, mismatches }, null, 2))
assert.deepEqual(mismatches, [], 'js_api 参数名/顺序与 legacy 不一致')
