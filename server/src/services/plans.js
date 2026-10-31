/** 计划、澄清与检查点：plans/<task>.json + checkpoints/<task>/manifest.json。 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CONFIG_DIR, atomicWriteJson, readJsonIfExists } from '../paths.js'
import { effectiveRoot, runtime } from '../runtime.js'

const run = promisify(execFile)
const PLANS_DIR = path.join(CONFIG_DIR, 'plans')
const CHECKPOINTS_DIR = path.join(CONFIG_DIR, 'checkpoints')
const CKPT_MAX_BYTES = 200 * 1024 * 1024
const CKPT_MAX_FILES = 500
const CKPT_KEEP = 3
const STEP_STATUSES = new Set(['pending', 'doing', 'done', 'blocked', 'skipped'])
const PLAN_STATUSES = new Set(['planning', 'approved', 'running', 'done', 'blocked'])
const TID_ERROR = 'task_id 非法（仅限字母数字 _ -，≤64）'
const json = value => JSON.stringify(value)
const error = message => json({ ok: false, error: String(message) })
const now = () => new Date().toISOString()

function safeTid(taskId) {
  const tid = String(taskId || '').trim()
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(tid)) throw new Error(TID_ERROR)
  return tid
}
function planPath(taskId) { return path.join(PLANS_DIR, `${safeTid(taskId)}.json`) }
function checkpointDir(taskId) { return path.join(CHECKPOINTS_DIR, safeTid(taskId)) }
function parseJson(value, fallback) {
  if (value == null) return fallback
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return fallback }
}
function safeJoin(root, relative) {
  const rel = String(relative || '')
  if (!rel || path.isAbsolute(rel)) return null
  const base = path.resolve(root)
  const full = path.resolve(base, rel)
  if (full !== base && !full.startsWith(base + path.sep)) return null
  return full
}
function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') } catch { return '' }
}

export async function planCreate(title, steps, taskId = '') {
  let tid
  try { tid = taskId ? safeTid(taskId) : `task_${Date.now()}` } catch { return error(TID_ERROR) }
  const input = parseJson(steps, []) || []
  if (!Array.isArray(input)) return error('steps 必须是数组')
  const norm = input.map((raw, index) => {
    const step = typeof raw === 'string' ? { text: raw } : (raw || {})
    const item = { text: String(step.text || `步骤 ${index + 1}`).slice(0, 200),
      risk: String(step.risk || '').slice(0, 4), status: 'pending' }
    if (Array.isArray(step.tools) && step.tools.length) item.tools = step.tools.map(x => String(x).slice(0, 40)).slice(0, 8)
    if (Number.isInteger(step.eta_seconds) && step.eta_seconds > 0) item.eta_seconds = Math.min(step.eta_seconds, 86400)
    return item
  })
  if (!norm.length) return error('计划至少需要 1 个步骤')
  const riskOrder = { l0: 3, dangerous: 3, l2: 2, mutate: 2, read: 1, l1: 1, '': 0 }
  const riskMax = norm.map(x => x.risk).sort((a, b) => (riskOrder[b] || 0) - (riskOrder[a] || 0))[0] || ''
  const stamp = now()
  const plan = { task_id: tid, title: String(title || '任务计划').slice(0, 120), status: 'planning',
    steps: norm, created_at: stamp, updated_at: stamp, eta_seconds: Math.min(norm.length * 40, 86400),
    risk_max: riskMax, scope: { modifies: [], no_access: [] } }
  try {
    fs.mkdirSync(PLANS_DIR, { recursive: true })
    atomicWriteJson(planPath(tid), plan)
    return json({ ok: true, task_id: tid, plan })
  } catch (err) { return error(`计划落盘失败: ${err.message}`) }
}

export async function planGet(taskId) {
  try {
    const plan = readJsonIfExists(planPath(taskId), null)
    if (!plan) return error(`计划不存在: ${taskId}`)
    if (typeof plan !== 'object' || !Array.isArray(plan.steps)) return error('计划文件损坏')
    return json({ ok: true, plan })
  } catch (err) { return error(err.message === TID_ERROR ? TID_ERROR : `计划读取失败: ${err.message}`) }
}

export async function planList(limit = 20) {
  if (!fs.existsSync(PLANS_DIR)) return json({ ok: true, plans: [] })
  const plans = fs.readdirSync(PLANS_DIR).filter(name => name.endsWith('.json'))
    .map(name => readJsonIfExists(path.join(PLANS_DIR, name), null)).filter(Boolean)
    .map(plan => ({ task_id: plan.task_id, title: plan.title, status: plan.status, created_at: plan.created_at }))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
  const size = Math.max(0, Number(limit) || 20)
  return json({ ok: true, plans: plans.slice(0, size) })
}

export async function planUpdate(taskId, status = '', stepIndex = null, stepStatus = '') {
  const got = JSON.parse(await planGet(taskId))
  if (!got.ok) return json(got)
  const plan = got.plan
  if (status) {
    if (!PLAN_STATUSES.has(String(status))) return error(`status 非法（合法值: ${[...PLAN_STATUSES].join('/')}）`)
    plan.status = String(status)
    if (plan.status === 'approved' && !plan.approved_at) plan.approved_at = now()
  }
  if (stepIndex !== null && stepIndex !== undefined && stepStatus) {
    const index = Number(stepIndex)
    if (!Number.isInteger(index)) return error('step_index 必须是整数')
    if (index < 0 || index >= plan.steps.length) return error('step_index 越界')
    if (!STEP_STATUSES.has(String(stepStatus))) return error(`step_status 非法（合法值: ${[...STEP_STATUSES].join('/')}）`)
    plan.steps[index].status = String(stepStatus)
  }
  plan.updated_at = now()
  try { atomicWriteJson(planPath(taskId), plan); return json({ ok: true, plan }) }
  catch (err) { return error(`计划保存失败: ${err.message}`) }
}

export async function clarifyCollect(questions, answers) {
  const qs = parseJson(questions, []) || []
  const ans = parseJson(answers, {}) || {}
  const resolved = (Array.isArray(qs) ? qs : []).map((raw, index) => {
    const q = typeof raw === 'string' ? { q: raw } : (raw || {})
    const options = Array.isArray(q.options) ? q.options : []
    let pick = Number(ans[String(index)] ?? ans[index] ?? q.default ?? 0)
    if (!Number.isInteger(pick) || pick < 0 || pick >= options.length) pick = Number(q.default || 0)
    if (!Number.isInteger(pick) || pick < 0 || pick >= options.length) pick = 0
    return { q: q.q || q.question || '', answer: options.length ? options[pick] : '' }
  })
  return json({ ok: true, resolved })
}

async function gitHead(ws) {
  try {
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: ws, timeout: 15000, windowsHide: true })
    return stdout.trim()
  } catch { return '' }
}
async function gitFileSha(ws, head, rel) {
  try {
    const { stdout } = await run('git', ['show', `${head}:${rel}`], { cwd: ws, timeout: 30000,
      maxBuffer: CKPT_MAX_BYTES, encoding: 'buffer', windowsHide: true })
    return crypto.createHash('sha256').update(stdout).digest('hex')
  } catch { return null }
}
function pruneCheckpoints() {
  if (!fs.existsSync(CHECKPOINTS_DIR)) return []
  const entries = fs.readdirSync(CHECKPOINTS_DIR, { withFileTypes: true }).filter(x => x.isDirectory()).map(entry => {
    const manifest = readJsonIfExists(path.join(CHECKPOINTS_DIR, entry.name, 'manifest.json'), {})
    return { name: entry.name, created: manifest.created_at || '' }
  }).sort((a, b) => String(b.created).localeCompare(String(a.created)))
  const removed = entries.slice(CKPT_KEEP).map(x => x.name)
  for (const name of removed) fs.rmSync(path.join(CHECKPOINTS_DIR, name), { recursive: true, force: true })
  return removed
}

export async function checkpointCreate(taskId, files, wsDir = '') {
  let tid
  try { tid = safeTid(taskId) } catch { return json({ ok: false, error: { code: 'BAD_PARAMS', message: 'task_id 非法（防路径逃逸）' } }) }
  const ws = path.resolve(String(wsDir || effectiveRoot(runtime.currentSid)))
  let list = parseJson(files, files)
  if (typeof list === 'string') list = list.split(',').map(x => x.trim()).filter(Boolean)
  if (!Array.isArray(list)) list = []
  const head = await gitHead(ws)
  const manifest = { task_id: tid, ws_dir: ws, git_head: head, created_at: now(), files: [], label: '', kind: '' }
  const dest = checkpointDir(tid)
  const warnings = []
  let total = 0; let count = 0
  for (const raw of list) {
    const rel = String(raw)
    const full = safeJoin(ws, rel)
    if (!full) { warnings.push(`越界路径已跳过: ${rel}`); continue }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      if (head) {
        manifest.files.push({ path: rel, snapshot: false, present: false, sha256: null, size: 0 })
        warnings.push(`创建时不存在（回滚将移除同名后建文件）: ${rel}`)
      } else warnings.push(`文件不存在已跳过: ${rel}`)
      continue
    }
    const size = fs.statSync(full).size
    if (count >= CKPT_MAX_FILES || total + size > CKPT_MAX_BYTES) {
      warnings.push(`超出检查点上限（${CKPT_MAX_FILES} 文件 / 200MB），后续文件仅记录清单`)
      manifest.files.push({ path: rel, snapshot: false }); continue
    }
    if (!head) {
      try {
        const target = path.join(dest, rel)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(full, target)
        count += 1; total += size
      } catch (err) { warnings.push(`快照失败 ${rel}: ${err.message}`); manifest.files.push({ path: rel, snapshot: false }); continue }
    }
    manifest.files.push({ path: rel, snapshot: !head, present: true,
      sha256: head ? await gitFileSha(ws, head, rel) : sha256File(full), size })
  }
  try {
    fs.mkdirSync(dest, { recursive: true })
    atomicWriteJson(path.join(dest, 'manifest.json'), manifest)
  } catch (err) { return error(`检查点清单落盘失败: ${err.message}`) }
  const pruned = pruneCheckpoints()
  if (pruned.length) warnings.push(`已轮换清理 ${pruned.length} 份旧检查点（保留最近 ${CKPT_KEEP} 份）`)
  return json({ ok: true, mode: head ? 'git' : (count ? 'snapshot' : 'none'), git_head: head,
    snapshot_count: count, pruned, warnings })
}

export async function checkpointList(taskId = '') {
  if (!taskId) {
    if (!fs.existsSync(CHECKPOINTS_DIR)) return json({ ok: true, items: [], keep: CKPT_KEEP })
    const items = fs.readdirSync(CHECKPOINTS_DIR, { withFileTypes: true }).filter(x => x.isDirectory()).map(entry => {
      const manifest = readJsonIfExists(path.join(CHECKPOINTS_DIR, entry.name, 'manifest.json'), null)
      if (!manifest) return null
      let size = 0
      const walk = dir => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name); if (item.isDirectory()) walk(full); else size += fs.statSync(full).size } }
      walk(path.join(CHECKPOINTS_DIR, entry.name))
      return { id: entry.name, mode: manifest.git_head ? 'git' : 'snapshot', git_head: manifest.git_head,
        label: manifest.label || '', created_at: manifest.created_at, file_count: (manifest.files || []).length,
        size_mb: Math.round(size / 1048576 * 100) / 100 }
    }).filter(Boolean).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    return json({ ok: true, items, keep: CKPT_KEEP })
  }
  try {
    const manifest = readJsonIfExists(path.join(checkpointDir(taskId), 'manifest.json'), null)
    if (!manifest) return json({ ok: true, files: [], mode: 'none' })
    return json({ ok: true, files: (manifest.files || []).map(x => ({ path: x.path, snapshot: !!x.snapshot })),
      mode: manifest.git_head ? 'git' : 'snapshot', git_head: manifest.git_head,
      ws_dir: manifest.ws_dir, label: manifest.label || '', created_at: manifest.created_at || '' })
  } catch { return json({ ok: false, error: { code: 'BAD_PARAMS', message: 'task_id 非法（防路径逃逸）' } }) }
}

function backupCurrent(file) {
  if (!fs.existsSync(file)) return
  let backup = `${file}.rollback-bak`
  if (fs.existsSync(backup)) backup = `${file}.rollback-bak.${Date.now()}`
  fs.copyFileSync(file, backup)
}

export async function checkpointRollback(taskId, wsDir = '', confirm = false) {
  if (!confirm) return json({ ok: false, error: { code: 'CONFIRM_REQUIRED',
    message: '回滚需显式确认（前端三态对话框「确认态」后携带 confirm=true 调用）——禁误触' } })
  let dest
  try { dest = checkpointDir(taskId) } catch { return json({ ok: false, error: { code: 'BAD_PARAMS', message: 'task_id 非法（防路径逃逸）' } }) }
  const manifest = readJsonIfExists(path.join(dest, 'manifest.json'), null)
  if (!manifest) return error(`未找到检查点: ${taskId}（可能创建时超限降级为仅记录）`)
  const ws = path.resolve(String(wsDir || manifest.ws_dir || effectiveRoot(runtime.currentSid)))
  const restored = []; const deleted = []; const failed = []
  if (manifest.git_head && !(manifest.files || []).length) {
    return json({ ok: true, mode: 'git', restored, deleted, failed, verified: true,
      note: `锚点检查点（无声明文件），git HEAD=${manifest.git_head.slice(0, 8)}` })
  }
  for (const item of manifest.files || []) {
    const rel = item.path; const full = safeJoin(ws, rel)
    if (!full) { failed.push(rel); continue }
    try {
      backupCurrent(full)
      if (item.present === false) {
        if (fs.existsSync(full)) {
          if (!fs.statSync(full).isFile()) throw new Error('目标不是普通文件，未移除')
          fs.rmSync(full); deleted.push(rel)
        }
      } else if (manifest.git_head) {
        await run('git', ['checkout', manifest.git_head, '--', rel], { cwd: ws, timeout: 60000, windowsHide: true })
        restored.push(rel)
      } else if (item.snapshot) {
        const source = path.join(dest, rel)
        if (!fs.existsSync(source)) throw new Error('快照文件缺失')
        fs.mkdirSync(path.dirname(full), { recursive: true })
        fs.copyFileSync(source, full); restored.push(rel)
      }
    } catch (err) { failed.push(`${rel}: ${err.message}`) }
  }
  const byPath = Object.fromEntries((manifest.files || []).map(x => [x.path, x]))
  const verified = restored.every(rel => !byPath[rel]?.sha256 || sha256File(path.join(ws, rel)) === byPath[rel].sha256)
  return json({ ok: failed.length === 0, mode: manifest.git_head ? 'git' : 'snapshot', restored, deleted, failed, verified })
}
