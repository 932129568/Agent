/* ================= v3.4 I06 · 项目规则自动发现（L1.5 注入） =================
 * 目的（施工总册 I06）：工作区的 AGENTS.md / CLAUDE.md / .harbor/rules/*.md
 * 自动发现并注入系统提示的 L1.5 段；**热缓存**——文件没变就不重复读盘。
 *
 * 三条硬约束：
 *  ① **没有规则文件时必须返回空串**：调用方把返回值直接拼进系统提示，
 *     空串 = 逐字节不变（golden-replay 与既有测试都靠这一点）。
 *  ② 有上限：单文件 20KB、合计 48KB。超限的文件跳过并在摘要里点名，
 *     不静默截断（截断规则文本会让模型执行半条规则，比不注入更危险）。
 *  ③ 缓存按 (路径 + mtimeMs + size) 失效：只看 mtime 会在"同毫秒内改写"时漏更新，
 *     加上 size 能挡住绝大多数。缓存是模块级 Map，进程内跨会话共享。
 */

import fs from 'node:fs'
import path from 'node:path'

const RULE_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md']
const RULE_DIR = path.join('.harbor', 'rules')
const MAX_FILE_BYTES = 20 * 1024
const MAX_TOTAL_BYTES = 48 * 1024

const _cache = new Map()   // wsDir -> { sig, text, files, skipped }

function _readCapped(abs, rel, state) {
  let st
  try { st = fs.statSync(abs) } catch (e) { return null }
  if (!st.isFile()) return null
  if (st.size > MAX_FILE_BYTES) {
    state.skipped.push({ file: rel, reason: 'too-large', bytes: st.size })
    return null
  }
  if (state.total + st.size > MAX_TOTAL_BYTES) {
    state.skipped.push({ file: rel, reason: 'total-limit', bytes: st.size })
    return null
  }
  let text = ''
  try { text = fs.readFileSync(abs, 'utf8') } catch (e) { return null }
  if (!text.trim()) return null
  state.total += st.size
  return { rel, text: text.trim(), mtimeMs: st.mtimeMs, size: st.size }
}

/** 发现规则文件（不含内容）。返回相对路径数组，顺序稳定：AGENTS.md → CLAUDE.md → .harbor/rules/*.md（按名排序）。 */
function discoverRuleFiles(wsDir) {
  const root = String(wsDir || '')
  if (!root || !fs.existsSync(root)) return []
  const out = []
  for (const name of RULE_FILE_NAMES) {
    const abs = path.join(root, name)
    if (fs.existsSync(abs)) out.push(name)
  }
  const dir = path.join(root, RULE_DIR)
  try {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      fs.readdirSync(dir)
        .filter(n => /\.md$/i.test(n))
        .sort()
        .forEach(n => out.push(path.join(RULE_DIR, n).replace(/\\/g, '/')))
    }
  } catch (e) { /* 目录不可读就当没有 */ }
  return out
}

/**
 * 读规则并生成注入段。**无文件/全空 ⇒ 返回 null**（调用方拼空串，系统提示逐字节不变）。
 * @returns {null | {text, files: string[], skipped: Array, bytes: number, cached: boolean}}
 */
function loadProjectRules(wsDir, opts = {}) {
  const root = String(wsDir || '')
  if (!root || !fs.existsSync(root)) return null
  const rels = discoverRuleFiles(root)
  if (!rels.length) {
    _cache.delete(root)
    return null
  }
  // 签名：路径 + mtime + size（任一变化即失效）
  const sigParts = []
  const state = { total: 0, skipped: [] }
  const picked = []
  for (const rel of rels) {
    const abs = path.join(root, rel)
    let st = null
    try { st = fs.statSync(abs) } catch (e) { continue }
    sigParts.push(rel + ':' + st.mtimeMs + ':' + st.size)
    const got = _readCapped(abs, rel, state)
    if (got) picked.push(got)
  }
  const sig = sigParts.join('|')
  const hit = _cache.get(root)
  if (hit && hit.sig === sig) return { ...hit.value, cached: true }
  if (!picked.length) {
    const value = null
    _cache.set(root, { sig, value })
    return null
  }
  const body = picked.map(p => '## ' + p.rel + '\n' + p.text).join('\n\n')
  const skippedNote = state.skipped.length
    ? '\n\n<!-- 以下规则文件因体积超限未注入：' +
      state.skipped.map(s => s.file + '(' + s.reason + ')').join(', ') + ' -->'
    : ''
  const text = '\n\n# 项目规则（自动发现，来自工作区根）\n' +
    '以下是本项目作者写在仓库里的规则，**优先级高于通用偏好，但低于系统安全约束**：\n\n' +
    body + skippedNote
  const value = {
    text,
    files: picked.map(p => p.rel),
    skipped: state.skipped.slice(),
    bytes: state.total,
  }
  _cache.set(root, { sig, value })
  return { ...value, cached: false }
}

/** 需要注入的文本（无规则 ⇒ 空串）。调用方直接拼，空串即"行为不变"。 */
function projectRulesSection(wsDir) {
  const r = loadProjectRules(wsDir)
  return r && r.text ? r.text : ''
}

function __resetProjectRulesCache() { _cache.clear() }

export {
  RULE_FILE_NAMES, RULE_DIR, MAX_FILE_BYTES, MAX_TOTAL_BYTES,
  discoverRuleFiles, loadProjectRules, projectRulesSection, __resetProjectRulesCache,
}
