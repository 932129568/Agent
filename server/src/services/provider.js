/**
 * 本地模型端点、工具清单、系统提示词与杂项工具。
 * 网络探测仅允许 http(s)，且带超时与响应大小上限。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { CONFIG_DIR, atomicWriteJson } from '../paths.js'
import { readConfigJson } from './jsonstore.js'
import { effectiveRoot, runtime } from '../runtime.js'
import { prisma } from '../db.js'
import { cacheToolOutput as cacheOutput, clearFileCaches } from './files.js'
import { consumeExportPath } from './system.js'
import { guardAudit } from './misc.js'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const PROMPTS_DIR = path.join(PROJECT_ROOT, 'backend', 'prompts')

const okJson = value => JSON.stringify(value)
const errJson = message => JSON.stringify({ error: String(message) })

function localBase() {
  const cfg = readConfigJson('config.json', {})
  return String(cfg.local_base_url || cfg.base_url || 'http://127.0.0.1:1919/v1').replace(/\/+$/, '')
}
const normalizeBase = value => String(value || '').trim().replace(/\/+$/, '')
const modelsUrl = base => normalizeBase(base).endsWith('/models') ? normalizeBase(base) : `${normalizeBase(base)}/models`
const chatUrl = base => normalizeBase(base).endsWith('/chat/completions') ? normalizeBase(base) : `${normalizeBase(base)}/chat/completions`
const loopback = hostname => ['localhost', '127.0.0.1', '::1'].includes(String(hostname || '').toLowerCase())

async function request(target, { method = 'GET', headers = {}, body = null, timeout = 15 } = {}) {
  let url
  try { url = new URL(String(target || '')) } catch { return { ok: false, error: '端点 URL 无效' } }
  if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, error: '仅支持 http(s) 端点' }
  if (url.protocol === 'http:' && !loopback(url.hostname)) return { ok: false, error: '明文 http 仅允许回环地址' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeout) || 15) * 1000)
  const started = Date.now()
  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'error' })
    const text = await response.text()
    return { ok: response.ok, status: response.status, body: text.slice(0, 2 * 1024 * 1024), ms: Date.now() - started }
  } catch (error) {
    return { ok: false, error: String(error?.message || error), ms: Date.now() - started }
  } finally { clearTimeout(timer) }
}
function parseJson(text) { try { return JSON.parse(text) } catch { return null } }
function modelIds(payload) {
  const items = payload?.data || payload?.models || []
  return Array.isArray(items) ? items.map(x => typeof x === 'string' ? x : x?.id || x?.name).filter(Boolean).map(String) : []
}
function modelMeta(id) {
  const name = String(id || '').toLowerCase()
  const rules = [
    ['qwen3.5', 262144, true], ['qwen2.5', 32768, true], ['qwen3', 32768, true],
    ['llama3.1:8b', 8192, true], ['llama3.1', 131072, true], ['mistral', 32768, true],
    ['deepseek-r1', 65536, false], ['gemma2', 8192, true], ['phi3.5', 131072, true],
  ]
  const hit = rules.find(([prefix]) => name.includes(prefix))
  return hit ? { ctx_window: hit[1], tool_capable: hit[2], estimated: true }
    : { ctx_window: 8192, tool_capable: false, estimated: true }
}

export async function getLocalProxy() { return okJson({ ok: true, base_url: localBase() }) }

export async function localModels(baseUrl, apiKey = '') {
  const base = normalizeBase(baseUrl)
  if (!base) return okJson({ ok: false, error: 'base_url 不能为空', models: [] })
  const result = await request(modelsUrl(base), { headers: { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) } })
  if (!result.ok) return okJson({ ok: false, base_url: base, models: [], error: result.error || `HTTP ${result.status}` })
  const payload = parseJson(result.body)
  const models = modelIds(payload).map(id => ({ id, ...modelMeta(id) }))
  return okJson({ ok: true, base_url: base, models })
}

export async function localProbe(ports = null) {
  let input = ports
  if (typeof input === 'string' && input.trim()) {
    try { input = JSON.parse(input) } catch { return okJson({ error: 'ports 需要是 JSON 数组，如 [11434,1234]' }) }
  }
  const values = Array.isArray(input) && input.length ? input : [11434, 1234, 8000, 8080, 1919]
  const clean = [...new Set(values.map(Number).filter(x => Number.isInteger(x) && x >= 1 && x <= 65535))].slice(0, 16)
  const kinds = { 11434: 'ollama', 1234: 'lmstudio', 8000: 'vllm', 8080: 'llamacpp', 1919: 'freetoken' }
  const started = Date.now()
  const results = await Promise.all(clean.map(async port => {
    const base = `http://127.0.0.1:${port}/v1`
    const one = await request(modelsUrl(base), { timeout: 2, headers: { Accept: 'application/json' } })
    const reachable = !!one.ok
    return { base_url: base, kind: kinds[port] || 'custom', reachable,
      models: reachable ? modelIds(parseJson(one.body)) : [], latency_ms: one.ms || 0,
      ...(reachable ? {} : { error: one.error || `HTTP ${one.status}（端口有服务但非预期响应）` }) }
  }))
  return okJson({ ok: true, reachable: results.filter(x => x.reachable),
    unreachable: results.filter(x => !x.reachable), elapsed_ms: Date.now() - started })
}

export async function localReadiness(baseUrl, model = '', apiKey = '') {
  const result = JSON.parse(await localModels(baseUrl, apiKey))
  const selected = result.models?.find(x => x.id === model) || result.models?.[0]
  const checks = [
    ['endpoint', !!result.ok, '本地端点可连接'], ['models', (result.models || []).length > 0, '可读取模型清单'],
    ['selected', !!selected, '存在可用模型'], ['context', !!selected?.ctx_window, '具备上下文窗口元数据'],
    ['tools', !!selected?.tool_capable, '工具调用能力'], ['schema', true, 'OpenAI 兼容 schema'],
    ['guard', true, '工作区路径护栏'], ['errors', true, '结构化错误返回'],
  ]
  const score = checks.filter(x => x[1]).length
  const verdict = score >= 7 ? 'full' : score >= 4 ? 'partial' : 'cloud'
  return okJson({ ok: true, score, max: checks.length, verdict,
    items: checks.map(([id, pass, label]) => ({ id, ok: pass, label })),
    suggestions: checks.filter(x => !x[1]).map(x => `未完成：${x[2]}`), model: selected?.id || model || '' })
}

export async function testProviderEndpoint(baseUrl, apiKey, model, timeout = 15, local = false) {
  if (!local && !String(apiKey || '')) return okJson({ ok: false, error: 'API Key 不能为空' })
  const target = chatUrl(baseUrl)
  const result = await request(target, { method: 'POST', timeout: timeout || (local ? 30 : 15),
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model: String(model || ''), messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }) })
  const payload = parseJson(result.body)
  if (result.ok) return okJson({ ok: true, url: target, model, state: 'ready',
    reply: payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.text || '' })
  return okJson({ ok: false, url: target, model, state: local && result.status === 503 ? 'loading' : 'error',
    status: result.status, error: result.error || payload?.error?.message || `HTTP ${result.status}` })
}

/** 面向模型的工具清单：与 legacy tools_schema.build 同数据源/同顺序。 */
const tool = (name, description, properties = {}, required = [], strict = false) => ({
  type: 'function', function: { name, description,
    parameters: { type: 'object', properties, required, ...(strict ? { additionalProperties: false } : {}) } },
})
const PATH = { path: { type: 'string' } }
const CMD = { cmd: { type: 'string' }, timeout: { type: 'integer' } }
const MEMORY = { content: { type: 'string' } }
const READ_MORE = tool('read_more', '分页读取之前被截断的工具输出全文',
  { cache_id: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, ['cache_id'])
const FILE_TOOLS = [
  tool('read_file', '读文件(带行号,一次可读2万行,常规文件一次读全;同版本重复读被拦截,需原文传force=true)',
    { ...PATH, offset: { type: 'integer' }, limit: { type: 'integer' }, force: { type: 'boolean' } }, ['path']),
  tool('write_file', '整文件写入(UTF-8)。已存在且>20KB 会被拒,改用 search_replace', { ...PATH, content: { type: 'string' } }, ['path', 'content']),
  tool('append_file', '追加到文件末尾。10 分钟内同文件限 6 次', { ...PATH, content: { type: 'string' } }, ['path', 'content']),
  tool('search_replace', '精确原文局部替换,优先于整文件重写',
    { ...PATH, old: { type: 'string' }, new: { type: 'string' }, replace_all: { type: 'boolean' } }, ['path', 'old', 'new']),
  tool('list_dir', '列目录,超过 200 项只回前 200+总数', PATH, ['path']),
  tool('make_dir', '创建文件夹', PATH, ['path']),
  tool('delete_path', '删除文件/目录(进回收站)', PATH, ['path']),
  tool('move_path', '移动/重命名', { ...PATH, new_path: { type: 'string' } }, ['path', 'new_path']),
  tool('copy_path', '复制文件/目录', { ...PATH, new_path: { type: 'string' } }, ['path', 'new_path']),
  tool('get_file_info', '文件大小/修改时间', PATH, ['path']),
]
const FULL_TOOLS = [
  tool('run_command', '执行 cmd 命令,输出超长自动截断落盘', CMD, ['cmd']),
  tool('run_powershell', '执行 PowerShell 命令,输出超长自动截断落盘', CMD, ['cmd']),
  tool('run_admin_command', '管理员权限命令,会弹原生确认框', { cmd: { type: 'string' } }, ['cmd']),
  tool('open_app', '打开软件/文件/文件夹', PATH, ['path']),
  tool('open_url', '用默认浏览器打开网页', { url: { type: 'string' } }, ['url']),
  tool('take_screenshot', '截取当前屏幕; 可选区域参数 left/top/width/height',
    { left: { type: 'integer' }, top: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' } }),
  tool('clipboard_read', '读取系统剪贴板文本'), tool('clipboard_write', '写入系统剪贴板文本', { text: { type: 'string' } }, ['text']),
  tool('list_processes', '列出进程(按内存降序, 可关键字过滤), 配合 kill_process', { keyword: { type: 'string' } }),
  tool('kill_process', '结束进程(按 pid 或进程名), 请先 list_processes 确认再杀', { pid: { type: 'integer' }, name: { type: 'string' } }),
  tool('append_memory', '写入跨会话长期记忆', MEMORY, ['content']),
]
const AGENT_TOOLS = [
  tool('browser_search', '浏览器搜索(受控次窗+正文提取+实时检索;遇验证页返回 CAPTCHA_REQUIRED 等待人工)',
    { query: { type: 'string' }, engine: { type: 'string' }, site: { type: 'string' }, filetype: { type: 'string' },
      time_range: { type: 'string' }, lang: { type: 'string' }, max_results: { type: 'integer' }, extract: { type: 'string' } }, ['query']),
  tool('browser_open', '打开网页提取正文(readability/selector;超长截断落盘)',
    { url: { type: 'string' }, selector: { type: 'string' }, max_chars: { type: 'integer' } }, ['url']),
  tool('software_call', '调用外部软件(git/ffmpeg/7z/python/node 等;action 按注册表,参数不符返回 SCHEMA_INVALID+修正示例)',
    { software: { type: 'string' }, action: { type: 'string' }, args: { type: 'object' }, timeout: { type: 'integer' }, source: { type: 'string' } }, ['software', 'action']),
  tool('browser_navigate', '导航浏览器会话到URL并等待就绪|需要渲染页面或后续交互前的定位步骤|纯文本抓取用browser_open',
    { url: { type: 'string' }, wait_selector: { type: 'string' }, timeout: { type: 'integer' }, mode: { type: 'string', enum: ['hidden', 'visible'] } }, ['url'], true),
  tool('browser_extract', '提取当前会话页面正文|导航后取结构化内容|未导航时先browser_navigate',
    { selector: { type: 'string' }, mode: { type: 'string', enum: ['markdown', 'text', 'links'] } }, [], true),
  tool('browser_click', '点击页面元素(需确认)|selector或可见文本定位|敏感确认弹窗类页面交给用户接管', { target: { type: 'string' } }, ['target'], true),
  tool('browser_fill', '填充表单字段(需确认)|selector定位输入框并填入文本|密码/文件字段拒绝填充',
    { selector: { type: 'string' }, text: { type: 'string' } }, ['selector', 'text'], true),
  tool('browser_screenshot', '截取当前会话页面|交互后取证或视觉复核|全屏截图用take_screenshot', { full_page: { type: 'boolean' } }, [], true),
  tool('browser_close', '关闭浏览器会话释放资源|任务完成或页面不再需要时|活跃会话不必要关闭', { session_id: { type: 'string' } }, [], true),
]
export async function buildTools(role = 'full', includeMcp = false, includeAgent = false, isGlmEndpoint = false) {
  if (role === 'chat') return '[]'
  const tools = [READ_MORE]
  if (role === 'full') {
    const { getWsEnabled } = await import('./workspace.js')
    const wsOn = JSON.parse(await getWsEnabled(runtime.currentSid)).enabled !== false
    if (wsOn) tools.push(...FILE_TOOLS)
    tools.push(...FULL_TOOLS)
    if (includeMcp) {
      const { mcpToolSchemas } = await import('./mcp.js')
      tools.push(...await mcpToolSchemas())
    }
    if (includeAgent) tools.push(...AGENT_TOOLS.filter(x => !isGlmEndpoint || !x.function.name.startsWith('browser_')))
  } else if (role === 'ro') {
    tools.push(...FILE_TOOLS.filter(x => ['read_file', 'list_dir', 'get_file_info'].includes(x.function.name)),
      tool('run_powershell', '执行 PowerShell 命令', { cmd: { type: 'string' } }, ['cmd']),
      tool('open_app', '打开软件/文件', PATH, ['path']), tool('take_screenshot', '截取当前屏幕'),
      tool('clipboard_read', '读取系统剪贴板文本'), tool('list_processes', '列出进程(按内存降序)', { keyword: { type: 'string' } }),
      tool('append_memory', '写入跨会话长期记忆', MEMORY, ['content']))
  }
  return JSON.stringify(tools)
}

function loadPrompt(promptId) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(PROMPTS_DIR, 'manifest.json'), 'utf8'))
    const entry = manifest.prompts?.[promptId]
    if (!entry) return null
    let file = String(entry.file || `${promptId}.md`)
    if (path.basename(file) !== file || file.includes('..')) file = `${promptId}.md`
    const text = fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf8')
    return { text, version: String(entry.version || '1.0.0') }
  } catch { return null }
}
function renderPrompt(promptId, values = {}) {
  const loaded = loadPrompt(promptId)
  if (!loaded) return ''
  return loaded.text.replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match)
}
async function memoryTail(query) {
  try {
    const memory = await import('./memory.js')
    const items = JSON.parse(await memory.getMemory())
    if (!Array.isArray(items) || !items.length) return ''
    const standing = items.filter(x => ['rule', 'preference'].includes(x.kind)).slice(-3)
    const picked = [...standing]
    if (query) {
      const related = JSON.parse(await memory.memoryRetrieve(query, 2)).items || []
      for (const item of related) if (!picked.some(x => x.text === item.text)) picked.push(item)
    }
    return picked.length ? `\n\n用户长期记忆（仅作偏好与约束参考）：\n${picked.map(x => `- ${x.text}`).join('\n')}` : ''
  } catch { return '' }
}

export async function buildSystemPrompt(query = '') {
  const { getWsEnabled } = await import('./workspace.js')
  const enabled = JSON.parse(await getWsEnabled(runtime.currentSid)).enabled !== false
  const root = effectiveRoot(runtime.currentSid)
  const tail = await memoryTail(String(query || ''))
  const rendered = renderPrompt(enabled ? 'system-base' : 'system-ws-off', { ws_root: root })
  if (rendered) return rendered + tail
  if (!enabled) return '你是 Harbor 内置编程助手。当前**未启用工作区**：不要假设或猜测任何工作区路径，不要主动列出/创建/修改文件或文件夹；用户要求文件操作时，先请其启用工作区。' + tail
  return `你是 Harbor 内置编程助手。当前工作区: ${root}\n硬规则:\n1. 文件操作只用工具, 禁止用 Get-Content/Set-Content(后端已强制 UTF-8)。\n2. 写文件串行: 一次一个 write_file/append_file/search_replace, 等返回成功再写下一个。\n3. 超长命令输出会截断并给缓存 id, 需要全文用 read_more 分段取。${tail}`
}

export async function promptGet(promptId) {
  const id = String(promptId || '')
  const loaded = loadPrompt(id)
  if (!loaded) return okJson({ error: `未知提示词 id: ${id.slice(0, 40)}` })
  return okJson({ ok: true, id, version: loaded.version, text: loaded.text })
}

export async function cacheToolOutput(content) {
  const id = await cacheOutput(String(content ?? ''))
  return okJson({ ok: true, id })
}

export async function clearCaches() { return clearFileCaches() }

export async function traceNew() {
  return okJson({ ok: true, trace: crypto.randomUUID() })
}

export async function uiNudge(visibility = 'visible') {
  // Node 服务没有 pywebview 原生窗口；明确报告未逼帧，不能返回伪成功。
  return okJson({ nudged: false, reason: 'window-not-ready', visibility: String(visibility || 'visible') })
}

export async function clarifyCollect(questions, answers) {
  const { clarifyCollect: collect } = await import('./plans.js')
  return collect(questions, answers)
}

export async function saveExportFile(targetPath, content) {
  const target = String(targetPath || '').trim()
  if (!target) return okJson({ error: '保存路径为空' })
  const text = String(content ?? '')
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > 8 * 1024 * 1024) return okJson({ error: '导出内容超过 8MB 上限' })
  if (!fs.existsSync(path.dirname(path.resolve(target)))) return okJson({ error: `目标目录不存在: ${path.dirname(path.resolve(target))}` })
  if (!consumeExportPath(target)) {
    await guardAudit('save_export_file', { path: target }, 'block', 'unregistered-path')
    return okJson({ error: '保存路径须由导出对话框选择（安全约束）' })
  }
  try {
    fs.writeFileSync(target, text, 'utf8')
    await guardAudit('save_export_file', { path: target, bytes }, 'ok', 'saved')
    return okJson({ ok: true, path: target, bytes })
  } catch (error) { return okJson({ error: `写入失败: ${error.message}` }) }
}

export async function sessionPurge(sid, taskIdsJson = '[]') {
  if (!sid) return errJson('缺少 sid')
  let taskIds = []
  try { taskIds = JSON.parse(String(taskIdsJson)) } catch (error) { taskIds = [] }
  const removed = { sessions: 0, plans: 0, checkpoints: 0, ws: 0 }

  const existing = await prisma.session.findUnique({ where: { id: String(sid) } })
  if (existing) {
    await prisma.session.delete({ where: { id: String(sid) } })
    removed.sessions = 1
  }
  if (runtime.sessionWs[sid]) {
    delete runtime.sessionWs[sid]
    removed.ws = 1
  }
  const plansDir = path.join(CONFIG_DIR, 'plans')
  const ids = Array.isArray(taskIds) && taskIds.length ? taskIds : [sid]
  for (const id of ids) {
    const planFile = path.join(plansDir, `${String(id).replace(/[^\w.-]/g, '_')}.json`)
    if (fs.existsSync(planFile)) { fs.rmSync(planFile); removed.plans += 1 }
    const cpDir = path.join(CONFIG_DIR, 'checkpoints', String(id).replace(/[^\w.-]/g, '_'))
    if (fs.existsSync(cpDir)) { fs.rmSync(cpDir, { recursive: true, force: true }); removed.checkpoints += 1 }
  }
  return okJson({ ok: true, sid: String(sid ?? ''), removed })
}
