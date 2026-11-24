/**
 * 本地模型端点、工具清单、系统提示词与杂项工具。
 * 网络探测仅允许 http(s)，且带超时与响应大小上限。
 */
import fs from 'node:fs'
import { projectRulesSection } from './projectRules.mjs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { CONFIG_DIR, atomicWriteJson } from '../paths.js'
import { readConfigJson } from './jsonstore.js'
import { runtime } from '../runtime.js'
import { ctxSid, ctxRoot, purgeSid } from '../session-context.js'
import { prisma } from '../db.js'
import { cacheToolOutput as cacheOutput, clearFileCaches } from './files.js'
import { consumeExportPath } from './system.js'
import { ensureLocalProxyRunning } from './local-proxy.js'
import { guardAudit } from './audit.js'
import { rememberDeletedId } from './session-migrate.js'
// R88（D-09）：MCP 折叠阈值唯一事实源改由 harness 注册表导出，禁止本地重复声明。
import { MCP_FOLD_THRESHOLD } from './harness/progressiveToolRegistry.mjs'

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
  try { url = new URL(String(target || '')) } catch { return { ok: false, error: '端点 URL 无效', kind: 'other' } }
  if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, error: '仅支持 http(s) 端点', kind: 'other' }
  if (url.protocol === 'http:' && !loopback(url.hostname)) return { ok: false, error: '明文 http 仅允许回环地址', kind: 'other' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeout) || 15) * 1000)
  const started = Date.now()
  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'error' })
    const text = await response.text()
    return { ok: response.ok, status: response.status, body: text.slice(0, 2 * 1024 * 1024),
      ms: Date.now() - started, kind: response.ok ? 'ok' : 'http' }
  } catch (error) {
    // 错误分类（P0-1c PR5：local_model_service._probe_error_text 同构口径）
    const aborted = error?.name === 'AbortError' || /aborted|timed? ?out/i.test(String(error?.message || ''))
    const causeCode = error?.cause?.code || ''
    const refused = causeCode === 'ECONNREFUSED' || /ECONNREFUSED|10061/i.test(String(error?.cause || error))
    const kind = aborted ? 'timeout' : refused ? 'refused' : 'other'
    return { ok: false, error: String(error?.message || error), cause: String(error?.cause || ''), ms: Date.now() - started, kind }
  } finally { clearTimeout(timer) }
}

/** 探测失败原因人话（_probe_error_text 同构）。 */
function probeErrorText(result) {
  if (result.kind === 'http') return `HTTP ${result.status}（端口有服务但非预期响应）`
  if (result.kind === 'timeout') return '连接超时（端口无响应）'
  if (result.kind === 'refused') return '端口未监听（服务未启动）'
  return (result.error || result.cause || '').slice(0, 120) || '连接失败'
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

export async function getLocalProxy() {
  // R61c（P0-4 真机缺口收口）：补齐 Python 时代 LocalCorsProxy 的 Node 镜像。
  // 旧实现「如实返回无监听器」→ 前端回落直连 → Chromium 走系统代理被拦成
  // Failed to fetch。现启动 127.0.0.1:0 懒单例，所有模型请求由 Node 进程转发
  // （Node 不读 Windows 系统代理）。响应形状 {ok,port,base_url} 保持不变。
  const { port, base_url } = await ensureLocalProxyRunning()
  return okJson({ ok: true, port, base_url })
}

export async function localModels(baseUrl, apiKey = '') {
  // PR5：错误分类人话（local_model_service.models 口径——'获取模型清单失败: <分类>'）
  const base = normalizeBase(baseUrl)
  if (!base) return okJson({ ok: false, error: 'base_url 不能为空', models: [] })
  const result = await request(modelsUrl(base), { headers: { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) } })
  if (!result.ok) {
    const classified = result.kind === 'refused' ? '端口未监听（服务未启动）'
      : result.kind === 'timeout' ? '连接超时（端口无响应）'
        : result.kind === 'http' ? `HTTP ${result.status}（端口有服务但非预期响应）`
          : (result.error || '').slice(0, 120) || '连接失败'
    return okJson({ ok: false, error: `获取模型清单失败: ${classified}` })
  }
  const payload = parseJson(result.body)
  const models = modelIds(payload).map(id => ({ id, ...modelMeta(id) }))
  return okJson({ ok: true, base_url: base, models })
}

export async function localProbe(portsInput = null) {
  let input = portsInput
  if (typeof input === 'string' && input.trim()) {
    try { input = JSON.parse(input) } catch { return okJson({ error: 'ports 需要是 JSON 数组，如 [11434,1234]' }) }
  }
  const values = Array.isArray(input) && input.length ? input : [11434, 1234, 8000, 8080, 1919]
  const seen = new Set()
  const clean = []
  for (const value of values) {
    const num = Number(value)
    if (Number.isInteger(num) && num >= 1 && num <= 65535 && !seen.has(num)) { seen.add(num); clean.push(num) }
  }
  const ports = clean.slice(0, 16).length ? clean.slice(0, 16) : [11434, 1234, 8000, 8080, 1919]
  const kinds = { 11434: 'ollama', 1234: 'lmstudio', 8000: 'vllm', 8080: 'llamacpp', 1919: 'freetoken' }
  const started = Date.now()
  const results = await Promise.all(ports.map(async port => {
    const base = `http://127.0.0.1:${port}/v1`
    const one = await request(modelsUrl(base), { timeout: 2, headers: { Accept: 'application/json' } })
    const reachable = !!one.ok
    return { base_url: base, kind: kinds[port] || 'custom', reachable,
      models: reachable ? modelIds(parseJson(one.body)) : [], latency_ms: one.ms || 0,
      ...(reachable ? {} : { error: probeErrorText(one) }) }
  }))
  return okJson({ ok: true, reachable: results.filter(x => x.reachable),
    unreachable: results.filter(x => !x.reachable), elapsed_ms: Date.now() - started })
}

/** PR4：readiness 纯函数评分（local_model_service.readiness:877-972 全量表移植）。
 * 8 项 {name, score, max:2, ok, detail}、总分 16、verdict full(≥12)/partial(≥8)/cloud。 */
export function readinessScore(modelMeta = {}, cfg = {}, info = {}) {
  const items = []
  const unreachable = info.reachable === false
  const add = (name, score, detail) => items.push({ name, score, max: 2, ok: score === 2, detail })

  // ① tag 固定
  if (modelMeta.estimated === false && modelMeta.id) {
    add('model_tagged', 2, `模型 ${modelMeta.id} 元数据已识别（ctx=${modelMeta.ctx_window}）`)
  } else if (modelMeta.id) {
    add('model_tagged', 1, `模型 ${modelMeta.id} 为保守估计值（ctx/工具能力按默认推）`)
  } else {
    add('model_tagged', 0, '未获取到模型元数据（探测失败或清单为空）')
  }
  // ② 工具能力
  if (modelMeta.tool_capable === true) add('tool_capable', 2, '模型支持工具调用')
  else if (modelMeta.tool_capable === false) add('tool_capable', 0, '模型无工具调用能力（本地仅可做纯文本草稿）')
  else add('tool_capable', 1, '工具能力未知（按不可用保守处理）')
  // ③ schema 输出
  add('schema_json', info.schema_json ? 2 : 1,
    info.schema_json ? '本地支持 JSON 约束输出（grammar/json mode）'
      : '未确认 JSON 约束能力（提示词约束可达标，幻觉参数风险略高）')
  // ④ 迭代上限
  const iters = cfg.local_max_iter
  if (Number.isInteger(iters) && iters >= 1 && iters <= 3) add('iteration_headroom', 2, `迭代上限 ${iters}（本地预算内可完成）`)
  else if (Number.isInteger(iters) && iters > 3) add('iteration_headroom', 1, `迭代上限 ${iters} 偏大（本地 5s/3s 预算内可能超时降级）`)
  else add('iteration_headroom', 1, '迭代上限未配置（按默认 1 次）')
  // ⑤ 路径护栏（不可达时收 0——「不知道」而非「配了」）
  add('path_guard', unreachable ? 0 : (info.path_guard !== false ? 2 : 0),
    info.path_guard !== false ? '本地产出路径经工作区门禁归一' : '本地产出未过路径门禁（幻觉路径有越界风险）')
  // ⑥ 结构化错误
  if (info.error_kind) add('structured_errors', 2, `错误已分类：${info.error_kind}`)
  else if (info.reachable === false) add('structured_errors', 0, '端点不可达（连接层错误未分类）')
  else add('structured_errors', 1, '错误分类能力未确认')
  // ⑦ 日志可见
  add('logging_visible', unreachable ? 0 : (info.logging_visible !== false ? 2 : 0),
    info.logging_visible !== false ? '路由日志落盘（hybrid-route.jsonl）' : '路由日志未启用（降级不可追溯）')
  // ⑧ keep_alive 提示
  if (unreachable) add('keep_alive_hint', 0, '端点不可达，无法确认 keep_alive 配置')
  else if (info.keep_alive) add('keep_alive_hint', 2, 'keep_alive 已配置（防冷启时延）')
  else add('keep_alive_hint', 1, '未配置 keep_alive（本地阶段可能偶发冷启时延）')

  const score = items.reduce((acc, item) => acc + item.score, 0)
  const verdict = score >= 12 ? 'full' : score >= 8 ? 'partial' : 'cloud'
  const suggestions = []
  if (verdict !== 'full') {
    for (const item of items) {
      if (item.score < 2) suggestions.push(`${item.name}：${item.detail}`)
    }
  }
  return { ok: true, score, max: 16, verdict, items, suggestions }
}

export async function localReadiness(baseUrl, model = '', apiKey = '') {
  // api.py:1069-1105 同构：models 拉元数据 → 评分 → model 字段回填
  const cfg = {}
  try {
    const c = readConfigJson('config.json', {})
    cfg.local_model = c.local_model
    cfg.local_ctx_window = c.local_ctx_window
    cfg.local_max_iter = c.local_max_iter
  } catch { /* 配置读取失败按空 cfg 保守评分 */ }
  let meta = {}
  let reachable = null
  try {
    const lst = JSON.parse(await localModels(baseUrl, apiKey))
    reachable = !!lst.ok
    const want = String(model || cfg.local_model || '')
    const models = lst.models || []
    meta = models.find(m => m.id === want) || {}
    if (!meta.id && models.length) meta = models[0]
  } catch { reachable = false }
  const info = {
    reachable: reachable === null ? false : reachable,
    keep_alive: true, path_guard: true, logging_visible: true, schema_json: true,
  }
  const result = readinessScore(meta, cfg, info)
  result.model = meta.id || String(model || cfg.local_model || '')
  return okJson(result)
}

/** A5 本地端点测试（local_model_service.test_local_endpoint:671-728 同构）：
 * 免 Key、503/文案含 loading → state='loading'（冷启动等待）而非失败。 */
async function testLocalEndpoint(target, model, timeout = 30) {
  const result = await request(target, { method: 'POST', timeout,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5, stream: false }) })
  const payload = parseJson(result.body)
  if (result.ok) {
    if (!payload || typeof payload !== 'object' || !('choices' in payload)) {
      return okJson({ ok: false, error: 'HTTP 200 但响应结构异常（非 OpenAI 兼容格式）' })
    }
    return okJson({ ok: true, url: target, model, state: 'ready',
      reply: String(payload.choices?.[0]?.message?.content || '').slice(0, 80) })
  }
  if (result.kind === 'http') {
    const snippet = String(result.body || '')
    const b = snippet.toLowerCase()
    // classify_local_error:317-319：503 或 loading 文案 → 冷启动等待态
    if (result.status === 503 || b.includes('loading') || b.includes('is loading')) {
      return okJson({ ok: true, url: target, model, state: 'loading',
        message: '模型正在加载（Ollama 首次提问需 10-60s），已自动等待重试' })
    }
    return okJson({ ok: false, error: `HTTP ${result.status}: ${snippet.slice(0, 300)}`, status: result.status })
  }
  return okJson({ ok: false, error: `连接失败: ${result.error}` })
}

export async function testProviderEndpoint(baseUrl, apiKey, model, timeout = 15, local = false) {
  // PR5：provider_service.test_endpoint 口径——前置校验文案、错误路径不回显
  // url/model/state（库文本片段 → ID-203 登记）；成功 {ok, url, model, reply}
  const target = chatUrl(baseUrl)
  if (!target) return okJson({ ok: false, error: '缺少 Base URL' })
  if (!local && !String(apiKey || '').trim()) return okJson({ ok: false, error: '缺少 API Key' })
  if (!String(model || '').trim()) return okJson({ ok: false, error: '缺少模型名' })
  if (local) return testLocalEndpoint(target, String(model).trim(), timeout || 30)
  const result = await request(target, { method: 'POST', timeout: timeout || (local ? 30 : 15),
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model: String(model).trim(), messages: [{ role: 'user', content: 'ping' }], max_tokens: 5, stream: false }) })
  const payload = parseJson(result.body)
  if (result.ok) {
    if (!payload || typeof payload !== 'object' || !('choices' in payload)) {
      return okJson({ ok: false, error: `HTTP 200 但响应结构异常（非 OpenAI 兼容格式）: ${JSON.stringify(payload).slice(0, 120)}` })
    }
    const reply = String(payload.choices?.[0]?.message?.content || '')
    return okJson({ ok: true, url: target, model, reply: reply.slice(0, 80) })
  }
  if (result.kind === 'http') {
    const snippet = String(result.body || '').slice(0, 300)
    return okJson({ ok: false, error: `HTTP ${result.status}: ${snippet}`, status: result.status })
  }
  // 连接层失败：库文本片段（urlopen/undici 实现差异 → ID-203）
  return okJson({ ok: false, error: `连接失败: ${result.error}${result.cause && result.cause !== result.error ? ` ${result.cause}` : ''}`.trim() })
}

/** 面向模型的工具清单：与 legacy tools_schema.build 同数据源/同顺序。 */
const tool = (name, description, properties = {}, required = null, strict = false) => ({
  // PR2：required=null 省略键（take_screenshot/clipboard_read 等 Python 字面量无此键）；
  // required=[] 显式保留（list_processes/kill_process/browser_extract 等字面量为空数组）
  type: 'function', function: { name, description,
    parameters: { type: 'object', properties,
      ...(required ? { required } : {}),
      ...(strict ? { additionalProperties: false } : {}) } },
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
  tool('list_processes', '列出进程(按内存降序, 可关键字过滤), 配合 kill_process', { keyword: { type: 'string' } }, []),
  tool('kill_process', '结束进程(按 pid 或进程名), 请先 list_processes 确认再杀', { pid: { type: 'integer' }, name: { type: 'string' } }, []),
  tool('append_memory', '写入跨会话长期记忆', MEMORY, ['content']),
]
const AGENT_TOOLS = [
  // R57 A1：三段式与 Python tools_schema.py 逐字对齐（原 Electron 链停在同源拆分前的旧单段文案）
  tool('browser_search', '需要联网搜索资料或查最新信息时|受控次窗搜索+正文提取+缓存,遇验证页返回 CAPTCHA_REQUIRED 等待人工|已知网址直接抓取用 browser_open,GLM 端点走云端原生 web_search',
    { query: { type: 'string' }, engine: { type: 'string' }, site: { type: 'string' }, filetype: { type: 'string' },
      time_range: { type: 'string' }, lang: { type: 'string' }, max_results: { type: 'integer' }, extract: { type: 'string' } }, ['query']),
  tool('browser_open', '已知URL要读取网页正文时|readability/selector 提取正文,超长自动截断落盘|要搜索发现页面用 browser_search,要点击/填表等交互用 browser_navigate 系',
    { url: { type: 'string' }, selector: { type: 'string' }, max_chars: { type: 'integer' } }, ['url']),
  tool('software_call', '要用已注册的外部软件能力时(git/ffmpeg/7z/python/node 等)|action 按注册表执行,参数不符返回 SCHEMA_INVALID+修正示例|普通文件读写用内置文件工具,任意命令用 run_command',
    { software: { type: 'string' }, action: { type: 'string' }, args: { type: 'object' }, timeout: { type: 'integer' }, source: { type: 'string' } }, ['software', 'action']),
  tool('browser_navigate', '导航浏览器会话到URL并等待就绪|返回统一observation与@eN元素索引,模型可直接据此决策下一步|纯文本抓取用browser_open,仅支持http(s)公网页面',
    { url: { type: 'string' }, wait_selector: { type: 'string' }, timeout: { type: 'integer' }, mode: { type: 'string', enum: ['hidden', 'visible'] } }, ['url'], true),
  tool('browser_extract', '提取当前会话页面正文|导航后取结构化内容并附统一observation|未导航时先browser_navigate',
    { selector: { type: 'string' }, mode: { type: 'string', enum: ['markdown', 'text', 'links'] } }, [], true),
  tool('browser_snapshot', '获取当前页面语义快照与@eN稳定引用索引|点击/填表前按@eN定位元素比截图省token且标识稳定|纯读正文用browser_extract,视觉取证用browser_screenshot',
    { selector: { type: 'string' }, max_chars: { type: 'integer' } }, [], true),
  tool('browser_click', '点击页面元素(需确认)|优先用快照给出的@eN引用,回落selector或可见文本,返回动作后observation与diff|敏感确认弹窗类页面交给用户接管', { target: { type: 'string' } }, ['target'], true),
  tool('browser_fill', '填充表单字段(需确认)|支持@eN或selector定位,返回动作后observation与diff且不回显原文|密码/文件字段拒绝填充',
    { selector: { type: 'string' }, text: { type: 'string' } }, ['selector', 'text'], true),
  tool('browser_screenshot', '截取当前会话页面|交互后取证或视觉复核|全屏截图用take_screenshot', { full_page: { type: 'boolean' } }, [], true),
  tool('browser_close', '关闭浏览器会话释放资源|任务完成或页面不再需要时|活跃会话不必要关闭', { session_id: { type: 'string' } }, [], true),
  // R57 A1：R42 记忆工具族补齐（原 Electron 链 schema 缺失——模型永远调不到）
  tool('memory_write', '需要长期记住的用户事实/偏好/项目约束时|写入长期记忆库(门控校验,敏感字段拒写,重复返回去重结果;分层由分类器按句式自动判定)|临时任务状态用计划卡,单次会话内容不要写入',
    { text: { type: 'string', description: '一句话事实（含主语与具体值）' } }, ['text'], true),
  tool('memory_search', '回答前怀疑长期记忆里有相关事实/偏好/约束时|按相关度检索记忆库,返回带来源/置信度/命中时间的条目|系统提示已注入的记忆不必重复检索,会话内近期上下文直接引用',
    { query: { type: 'string' }, limit: { type: 'integer' } }, ['query'], true),
]
// R44（F2d 改进⑤）：MCP 渐进披露——mcp__ 全量 > 阈值时折叠为 mcp_search 元工具
// R88（D-09）：阈值常量已上移至 ./harness/progressiveToolRegistry.mjs 单源导出。
const MCP_SEARCH_TOOL = tool('mcp_search', '需要调用MCP服务器工具但工具面只有本检索器时|按相关度检索全部MCP工具,返回含参数schema的完整条目,随后直接按name调用|工具面已直接列出的mcp__工具不必检索',
  { query: { type: 'string' }, limit: { type: 'integer' } }, ['query'])
/**
 * 组装「未折叠」的工具面（buildTools 默认路径，同时是 V4-H 渐进式工具面的输入源）。
 *
 * 抽成独立导出而非内联，是为了让 inspect_tool_schema 元工具能拿到**全量**工具集：
 * buildTools 在灰度开启时只返回 6 个活跃工具，若复用它做 Schema 查询，未激活的
 * 工具将全部查不到（元工具失去意义）。
 * @param {string} [role='full'] 'full' | 'ro' | 'chat'
 * @param {boolean} [includeMcp=false] 是否展开 MCP 工具
 * @param {boolean} [includeAgent=false] 是否挂载 Agent 工具族（browser_* / memory_*）
 * @param {boolean} [isGlmEndpoint=false] DeepSeek 端点屏蔽 browser_* 族
 * @returns {Promise<Array<object>>} OpenAI function-calling 工具列表
 */
export async function assembleToolList(role = 'full', includeMcp = false, includeAgent = false, isGlmEndpoint = false) {
  if (role === 'chat') return []
  const tools = [READ_MORE]
  if (role === 'full') {
    const { getWsEnabled } = await import('./workspace.js')
    const wsOn = JSON.parse(await getWsEnabled(ctxSid())).enabled !== false
    if (wsOn) tools.push(...FILE_TOOLS)
    tools.push(...FULL_TOOLS)
    if (includeMcp) {
      // R57 B5：MCP 渐进披露对齐 Python（>25 折叠为 mcp_search 元工具——
      // 原 Electron 链全量下发，10-30% 上下文吞噬源且 mcp_search 永不下发）
      const { mcpToolSchemas } = await import('./mcp.js')
      const mcpTools = await mcpToolSchemas()
      if (mcpTools.length > MCP_FOLD_THRESHOLD) tools.push(MCP_SEARCH_TOOL)
      else tools.push(...mcpTools)
    }
    if (includeAgent) tools.push(...AGENT_TOOLS.filter(x => !isGlmEndpoint || !x.function.name.startsWith('browser_')))
  } else if (role === 'ro') {
    // R57 A1④：ro 角色文案与 Python tools_schema ro 分支逐字对齐
    tools.push(...FILE_TOOLS
        .filter(x => ['read_file', 'list_dir', 'get_file_info'].includes(x.function.name))
        .map(x => x.function.name === 'read_file'
          ? tool('read_file', '读文件片段(带行号)',
              { ...PATH, offset: { type: 'integer' }, limit: { type: 'integer' }, force: { type: 'boolean' } }, ['path'])
          : x.function.name === 'list_dir'
            ? tool('list_dir', '列目录', PATH, ['path']) : x),
      tool('run_powershell', '执行 PowerShell 命令', { cmd: { type: 'string' } }, ['cmd']),
      tool('open_app', '打开软件/文件', PATH, ['path']), tool('take_screenshot', '截取当前屏幕'),
      tool('clipboard_read', '读取系统剪贴板文本'), tool('list_processes', '列出进程(按内存降序)', { keyword: { type: 'string' } }),
      tool('append_memory', '写入跨会话长期记忆', MEMORY, ['content']))
  }
  return tools
}

// ---- V4-H（残留 #4）：工具面短周期缓存 -------------------------------------
// jsapi 前置护栏每请求都要取一次全量工具面做 Schema 回查（assembleToolList），
// 实测 ~1.83ms/请求，且每次都要读工作区开关 + 组装 30+ 工具定义。按「sid + 参数」
// 做 1500ms 短周期缓存：既避免逐请求重复组装，又让开关切换在一个交互帧量级内生效。
// 缓存键必须带 sid —— wsOn 是按会话解析的，全局键会把 A 会话的工作区开关串给 B 会话。
const TOOL_LIST_CACHE_TTL_MS = 1500
const _toolListCache = new Map()

/**
 * assembleToolList 的短周期缓存版（仅供 jsapi 护栏回查 Schema 使用，不参与下发）。
 * @param {string} [role='full']
 * @param {boolean} [includeMcp=false]
 * @param {boolean} [includeAgent=false]
 * @param {boolean} [isGlmEndpoint=false]
 * @returns {Promise<Array<object>>}
 */
export async function assembleToolListCached(role = 'full', includeMcp = false, includeAgent = false, isGlmEndpoint = false) {
  const key = `${ctxSid()}|${role}|${includeMcp}|${includeAgent}|${isGlmEndpoint}`
  const now = Date.now()
  const hit = _toolListCache.get(key)
  if (hit && hit.exp > now) return hit.tools
  const tools = await assembleToolList(role, includeMcp, includeAgent, isGlmEndpoint)
  if (_toolListCache.size > 32) {
    for (const [k, v] of Array.from(_toolListCache.entries())) {
      if (v.exp <= now) _toolListCache.delete(k)
    }
  }
  _toolListCache.set(key, { tools, exp: now + TOOL_LIST_CACHE_TTL_MS })
  return tools
}

/** 仅供测试/诊断：清空工具面缓存（默认无需调用） */
export function __resetToolListCache() {
  _toolListCache.clear()
}

export async function buildTools(role = 'full', includeMcp = false, includeAgent = false, isGlmEndpoint = false) {
  if (role === 'chat') return '[]'
  const tools = await assembleToolList(role, includeMcp, includeAgent, isGlmEndpoint)
  // LIGHTWELL V4-H 灰度开关（默认关闭，行为零变化）：
  // LIGHTWELL_HARNESS_V4H=1 时改走“高频只读常驻 + 按需 inspect 激活”的渐进式工具面。
  // 走动态 import，开关关闭时不产生任何额外加载开销，也不影响 method-surface 168 断言
  if (process.env.LIGHTWELL_HARNESS_V4H === '1' && role === 'full') {
    const { buildProgressiveToolSurface } = await import('./harness/providerBridge.mjs')
    const mcpList = includeMcp ? await (await import('./mcp.js')).mcpToolSchemas() : []
    // 缺陷 A：只把「基础工具」交给 bridge，MCP 单列传入；memory_search / browser_snapshot
    // 是否在场完全由 includeAgent 决定，由 bridge 内部按「已知可选」跳过，此处不做特判。
    const baseWithoutMcp = tools.filter((t) => !t.function?.name?.startsWith('mcp__'))
    const { activeTools } = buildProgressiveToolSurface(baseWithoutMcp, mcpList)
    return JSON.stringify(activeTools)
  }
  return JSON.stringify(tools)
}

/**
 * V4-H（C1）：inspect_tool_schema 元工具的后端实现——按名返回单个工具的完整 JSON Schema。
 *
 * 契约：只读、幂等、无副作用。每次调用都新建一次性注册表（不写盘、不改任何全局态、
 * 不触碰渐进式注册表的全局单例——本项目干脆没有单例）。
 * MCP 工具不在此覆盖：它们仍走既有 mcp_search 渐进披露链（mcp__ 全量 > 阈值时折叠）。
 * @param {string} name 目标工具名（与轻量目录逐字一致；非字符串一律拒绝）
 * @returns {Promise<string>} { ok:true, name, riskLevel, schema } 或 { ok:false, error }
 */
export async function inspectToolSchema(name) {
  // 严格类型前置：数组/对象/数字等一律拒绝——否则 String(['write_file']) 会静默
  // 变成合法工具名（'write_file'），把调用方的类型错误掩盖成「查得到」的假阳性。
  if (typeof name !== 'string') {
    return okJson({
      ok: false,
      error: { code: 'V4H_UNKNOWN_TOOL', message: '工具名必须是字符串' },
    })
  }
  const toolName = name.trim()
  if (!toolName) {
    return okJson({ ok: false, error: { code: 'V4H_UNKNOWN_TOOL', message: '工具名不能为空' } })
  }
  try {
    const { buildProgressiveToolSurface } = await import('./harness/providerBridge.mjs')
    const tools = await assembleToolList('full', false, true, false)
    const baseWithoutMcp = tools.filter(t => !t.function?.name?.startsWith('mcp__'))
    const { registry } = buildProgressiveToolSurface(baseWithoutMcp)
    const found = registry.inspectSchema(toolName)
    if (!found || found.ok !== true) {
      return okJson({
        ok: false,
        error: {
          code: 'V4H_UNKNOWN_TOOL',
          message: `未注册工具: ${toolName}`,
          hint: '工具名须与系统提示词中的工具目录逐字一致（区分大小写与下划线）',
        },
      })
    }
    return okJson({ ok: true, name: toolName, riskLevel: found.riskLevel, schema: found.schema })
  } catch (error) {
    return okJson({
      ok: false,
      error: { code: 'V4H_INSPECT_FAILED', message: String((error && error.message) || error) },
    })
  }
}

function loadPrompt(promptId) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(PROMPTS_DIR, 'manifest.json'), 'utf8'))
    const entry = manifest.prompts?.[promptId]
    if (!entry) return null
    let file = String(entry.file || `${promptId}.md`)
    if (path.basename(file) !== file || file.includes('..')) file = `${promptId}.md`
    // PR3：读入 LF 归一（Windows checkout CRLF 是环境产物；Python 侧读用
    // newline='' 语义——文件本身 LF，双侧字节对齐）
    const text = fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf8').replace(/\r\n/g, '\n')
    return { text, version: String(entry.version || '1.0.0') }
  } catch { return null }
}
function renderPrompt(promptId, values = {}) {
  const loaded = loadPrompt(promptId)
  if (!loaded) return ''
  return loaded.text.replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match)
}
// P1-1：按名排序加载工作区 prompts/*.md 与 phases/*.md（不存在返回空串，绝不伪造；按 mtime+size 缓存）
const _wsPromptsCache = new Map()
function workspacePromptsSection(wsDir) {
  const root = String(wsDir || '').trim()
  if (!root || !fs.existsSync(root)) return ''
  const found = []
  for (const sub of ['prompts', 'phases']) {
    const dir = path.join(root, sub)
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue
      for (const name of fs.readdirSync(dir).sort()) {
        if (!/\.md$/i.test(name)) continue
        if (/^(?:AGENTS|CLAUDE)\.md$/i.test(name)) continue
        const abs = path.join(dir, name)
        const st = fs.statSync(abs)
        if (st.isFile() && st.size > 0 && st.size <= 16384) {
          found.push({ rel: `${sub}/${name}`, abs, sig: `${sub}/${name}:${st.mtimeMs}:${st.size}` })
        }
      }
    } catch {}
  }
  if (!found.length) return ''
  const sig = found.map(x => x.sig).join('|')
  const hit = _wsPromptsCache.get(root)
  if (hit && hit.sig === sig) return hit.text
  let total = 0
  const blocks = []
  for (const item of found) {
    try {
      const txt = fs.readFileSync(item.abs, 'utf8').replace(/\r\n/g, '\n').trim()
      if (!txt) continue
      if (total + txt.length > 24576) break
      total += txt.length
      blocks.push(`### [${item.rel}]\n${txt}`)
    } catch {}
  }
  const out = blocks.length ? `\n\n工作区规范与阶段契约（L1.5）：\n${blocks.join('\n\n')}` : ''
  _wsPromptsCache.set(root, { sig, text: out })
  return out
}
async function memoryTail(query) {
  let tail = ''
  try {
    const memory = await import('./memory.js')
    const allItems = JSON.parse(await memory.getMemory())
    // I14：跨项目隔离——只注入「本项目 + 全局」的记忆，别把别的项目的规则带进来。
    const wsRoot = ctxRoot()
    const items = (typeof memory.memoryFilterByProject === 'function')
      ? memory.memoryFilterByProject(allItems, wsRoot) : allItems
    if (Array.isArray(items) && items.length) {
      const standing = items.filter(x => ['rule', 'preference'].includes(x.kind)).slice(-3)
      const picked = [...standing]
      if (query) {
        const relatedRaw = JSON.parse(await memory.memoryRetrieve(query, 2)).items || []
        // 检索结果同样要按项目过滤：memoryRetrieve 是全局检索，不筛就会把别的项目的条目带进来
        const related = (typeof memory.memoryFilterByProject === 'function')
          ? memory.memoryFilterByProject(relatedRaw, wsRoot) : relatedRaw
        for (const item of related) if (!picked.some(x => x.text === item.text)) picked.push(item)
      }
      if (picked.length) tail = `\n\n用户长期记忆（仅作偏好与约束参考）：\n${picked.map(x => `- ${x.text}`).join('\n')}`
    }
  } catch { /* 记忆读取失败不阻塞主提示词 */ }
  // R38 扩展段（db_service.extras_block 同口径）：仅当 memory.db 有非 legacy
  // 结构化记忆时非空——标题「【长期记忆·扩展】」/ attribute 字母序 / pin 置前。
  // 异常静默（注入失败不改变既有提示词），config.json 零污染。
  try {
    const { memoryExtrasBlock } = await import('./pybridge.js')
    const extras = await memoryExtrasBlock(String(query || ''))
    if (extras) tail = tail ? `${tail}\n\n${extras}` : `\n\n${extras}`
  } catch { /* 扩展段失败不阻塞 */ }
  return tail
}

/**
 * V4-H（C2）：把渐进式注册表的轻量工具目录注入 system prompt 的工具面说明段。
 *
 * 灰度关闭时返回空串 —— 默认路径的 prompt 输出逐字节不变（红线：零漂移）。
 * 目录由 providerBridge.buildProgressiveToolSurface() 的 catalogMarkdown 产出，
 * 与 build_tools 的活跃工具面同源：常驻工具已直接下发，目录只列「未激活」的工具，
 * 模型据此按需调 inspect_tool_schema 取完整 Schema。
 * @returns {Promise<string>} 可直接拼接的段落（含前导空行）；灰度关闭/异常时为空串
 */
async function v4hToolCatalogSection() {
  if (process.env.LIGHTWELL_HARNESS_V4H !== '1') return ''
  try {
    const { buildProgressiveToolSurface } = await import('./harness/providerBridge.mjs')
    // 目录与 build_tools(full, 无 MCP, 带 Agent 族) 同源；MCP 工具走 mcp_search 披露链。
    const tools = await assembleToolList('full', false, true, false)
    const { catalogMarkdown } = buildProgressiveToolSurface(tools)
    const catalog = String(catalogMarkdown || '').trim()
    if (!catalog) return ''
    const count = catalog.split('\n').length
    // D-09：MCP 工具不进本目录（它们走 mcp_search 渐进披露链），必须在提示词里
    // 显式给出第二条发现路径，否则模型只知道 inspect_tool_schema，遇到 MCP 能力即失明。
    return `\n\n可用工具目录（渐进式工具面，共 ${count} 项；这些工具的完整参数 Schema 未直接下发，`
      + `调用前先调 inspect_tool_schema 取回 Schema，再按 name 调用）：\n${catalog}`
      + `\n\nMCP 服务器工具不在上述目录内：当 MCP 工具面超过折叠阈值时，用 mcp_search 检索`
      + `（返回含参数 Schema 的条目，随后按 name 直接调用）。`
  } catch { /* 目录注入失败不阻塞主提示词：灰度特性 fail-open 回原提示词 */ }
  return ''
}

export async function buildSystemPrompt(query = '') {
  // PR1：编码形态对齐——legacy ok(text)=json.dumps(text)（HTTP body 是 JSON
  // 编码字符串）。沙箱尾注不注入（Node 无 Job 沙箱，不伪造安全声明 → ID-201）。
  // R39 口径裁决（S2-19，双端同轮定案）：此为**有意分叉**非缺陷——沙箱尾注
  // 描述的是 Python 侧 pywebview 桥的 Job 沙箱事实；Node 桥若照搬即伪造安全
  // 声明。差分基线将该行登记为预期差异（differential allowlist）。
  const { getWsEnabled } = await import('./workspace.js')
  const enabled = JSON.parse(await getWsEnabled(ctxSid())).enabled !== false
  const root = ctxRoot()
  const tail = await memoryTail(String(query || ''))
  const rendered = renderPrompt(enabled ? 'system-base' : 'system-ws-off', { ws_root: root })
  // V4-H（C2）：灰度开启时追加轻量工具目录；关闭时恒为空串 → 下方三个分支逐字节不变。
  const catalog = await v4hToolCatalogSection()
  // I06 + P1-1：项目规则（L1.5）+ 工作区 prompts/*.md & phases/*.md（无文件时均为空串，逐字节不变）
  const rules = enabled ? projectRulesSection(root) : ''
  const wsPrompts = enabled ? workspacePromptsSection(root) : ''
  // P1-1（5× 前缀缓存重排）：静态段（L1 宪章 → L1.5 项目规则/阶段规范 → Tool Catalog）焊死在头部，
  // 随 query 检索变化的 memoryTail 压到最尾部，保住多轮对话前方公共前缀缓存。
  if (rendered) return okJson(rendered + rules + wsPrompts + catalog + tail)
  if (!enabled) return okJson('你是 Harbor 内置编程助手。当前**未启用工作区**：不要假设或猜测任何工作区路径，不要主动列出/创建/修改文件或文件夹；用户要求文件操作时，先请其启用工作区。\n始终用简体中文回复，除非用户明确要求其它语言。' + catalog + tail)
  return okJson(`你是 Harbor 内置编程助手。当前工作区: ${root}\n始终用简体中文回复，除非用户明确要求其它语言。\n硬规则:\n1. 文件操作只用工具, 禁止用 Get-Content/Set-Content(后端已强制 UTF-8)。\n2. 写文件串行: 一次一个 write_file/append_file/search_replace, 等返回成功再写下一个。\n3. 超长命令输出会截断并给缓存 id, 需要全文用 read_more 分段取。${rules}${wsPrompts}${catalog}${tail}`)
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
  // DEF-02：生成并记住当前 trace id，供 begin_task / 护栏 span 共用
  // （对应 Python session._current_trace()）；返回形状保持不变。
  const { newTraceId } = await import('./pybridge.js')
  return okJson({ ok: true, trace: newTraceId() })
}

export async function uiNudge(visibility = 'visible') {
  // PR7：{nudged, reason}（无 visibility 键——api.py:405-416 口径）。
  // R39 修复（S2-18）：Electron 宿主注册 redraw provider 后接真窗逼帧
  // （webContents.invalidate()，对齐 Python 侧 RedrawWindow 语义）——原恒
  // {nudged:false}，流式期间宿主逼帧空转。无宿主（纯 Node/差分环境）行为不变。
  try {
    const { getHostRedrawProvider } = await import('../host.js')
    const host = getHostRedrawProvider()
    if (host && typeof host.redraw === 'function') {
      const done = host.redraw()
      return okJson({ nudged: done === true, reason: done === true ? 'host-redraw' : 'window-not-ready' })
    }
  } catch { /* host 不可达 → 回落如实报告 */ }
  return okJson({ nudged: false, reason: 'window-not-ready' })
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
  // R33：先落墓碑，确保 legacy sessions.json 下次启动 merge 时不会把它复活
  rememberDeletedId(sid)

  const existing = await prisma.session.findUnique({ where: { id: String(sid) } })
  if (existing) {
    await prisma.session.delete({ where: { id: String(sid) } })
    removed.sessions = 1
  }
  if (runtime.sessionWs[sid]) {
    delete runtime.sessionWs[sid]
    removed.ws = 1
  }
  // P0-3 T02：session_purge 挂接 per-sid 容器清理（trust/grant/budget/dedup/
  // sessionCwds/cursor 全清——其他 sid 不受影响）
  purgeSid(sid)
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
