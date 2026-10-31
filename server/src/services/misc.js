/**
 * 审计日志、搜索缓存统计、历史目录配置。
 * 均为只读或独立文件写入，不触碰命令执行面。
 */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_DIR, readTextIfExists } from '../paths.js'
import { readConfigJson, mergeConfig } from './jsonstore.js'

const AUDIT_FILE = path.join(CONFIG_DIR, 'audit_log.jsonl')
const AUDIT_CHAIN_FILE = path.join(CONFIG_DIR, 'audit_chain.json')

const okJson = value => JSON.stringify(value)

/** 审计读取：倒序窗口 + 链头信息（与 legacy get_audit_log 的消费形态一致）。 */
export async function getAuditLog(limit = 50, offset = 0, verifyAll = false) {
  const text = readTextIfExists(AUDIT_FILE, '')
  const lines = text.split('\n').filter(Boolean)
  const entries = []
  for (const line of lines) {
    try { entries.push(JSON.parse(line)) } catch (error) { /* 跳过坏行 */ }
  }
  const size = Math.max(1, Math.min(Number(limit) || 50, 500))
  const start = Math.max(0, Number(offset) || 0)
  const window = entries.slice().reverse().slice(start, start + size)
  let chain = null
  try {
    chain = JSON.parse(readTextIfExists(AUDIT_CHAIN_FILE, 'null'))
  } catch (error) { chain = null }
  return okJson({
    ok: true, entries: window, total: entries.length, offset: start, limit: size,
    chain: chain ? { head: chain.head, len: chain.len, updated_at: chain.updated_at } : null,
    verify_all: !!verifyAll,
  })
}

/** 追加一条审计（工具执行后的记录入口）。 */
export async function guardAudit(op, detailJson, action = 'check', decision = null) {
  let detail = detailJson
  if (typeof detail === 'string') {
    try { detail = JSON.parse(detail) } catch (error) { detail = { raw: String(detailJson).slice(0, 200) } }
  }
  const entry = {
    ts: new Date().toISOString().replace('T', ' ').slice(0, 19),
    op: String(op || ''),
    action: String(action || 'check'),
    detail: Object.fromEntries(Object.entries(detail || {}).map(([k, v]) => [k, String(v).slice(0, 200)])),
  }
  if (decision) entry.decision = decision
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', 'utf8')
  return '{"ok":true}'
}

export async function searchCacheStats() {
  const dir = path.join(CONFIG_DIR, 'search_cache')
  if (!fs.existsSync(dir)) return okJson({ ok: true, entries: 0, bytes: 0 })
  let entries = 0
  let bytes = 0
  for (const name of fs.readdirSync(dir)) {
    const stat = fs.statSync(path.join(dir, name))
    if (stat.isFile()) { entries += 1; bytes += stat.size }
  }
  return okJson({ ok: true, entries, bytes })
}

export async function searchReaderStats() {
  return okJson({ ok: true, note: 'reader 统计在浏览器驱动迁移后提供', entries: 0 })
}

export async function searchStatus(taskId = '') {
  const { searchStatus: browserSearchStatus } = await import('./browser.js')
  return browserSearchStatus(taskId)
}

export async function historyDirGet() {
  const cfg = readConfigJson('history.json', {})
  const dir = cfg.dir || ''
  const effective = dir && fs.existsSync(dir) ? dir : CONFIG_DIR
  return okJson({ ok: true, dir, default_dir: CONFIG_DIR, sessions_file: path.join(effective, 'sessions.json') })
}

export async function historyDirSet(dirPath, migrate = false) {
  const input = String(dirPath || '').trim()
  if (!input) {
    await mergeConfig('history.json', JSON.stringify({ dir: '' }))
    return okJson({ ok: true, dir: '', migrated: false, migrated_from: '' })
  }
  let target
  try { target = fs.realpathSync(path.resolve(input)) } catch { return okJson({ error: `目录不存在：${input}（请先创建）` }) }
  if (!fs.statSync(target).isDirectory()) return okJson({ error: `目录不存在：${input}（请先创建）` })
  try { fs.accessSync(target, fs.constants.W_OK) } catch { return okJson({ error: `目录不可写：${target}` }) }
  const normalized = target.replace(/[\\/]+$/, '').toLowerCase()
  const sensitive = [process.env.WINDIR || 'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)']
    .filter(Boolean).map(x => path.resolve(x).replace(/[\\/]+$/, '').toLowerCase())
  const driveRoot = path.parse(target).root.replace(/[\\/]+$/, '').toLowerCase()
  if (normalized === driveRoot || sensitive.some(x => normalized === x || normalized.startsWith(x + path.sep))) {
    return okJson({ error: `不能使用系统目录：${target}` })
  }
  const previous = readConfigJson('history.json', {}).dir || ''
  const source = path.join(previous || CONFIG_DIR, 'sessions.json')
  let migrated = false; let migratedFrom = ''
  if (migrate && fs.existsSync(source) && path.dirname(fs.realpathSync(source)) !== target) {
    const destination = path.join(target, 'sessions.json')
    if (!fs.existsSync(destination)) {
      try { fs.copyFileSync(source, destination); migrated = true; migratedFrom = source }
      catch (error) { return okJson({ error: `迁移失败: ${error.message}` }) }
    }
  }
  await mergeConfig('history.json', JSON.stringify({ dir: target }))
  return okJson({ ok: true, dir: target, migrated, migrated_from: migratedFrom })
}
