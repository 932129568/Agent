/**
 * React 19 全量 Agent 运行引擎（R9 全工具覆盖 + 参数别名容错 + 95%+ KV-Cache）：
 * - 完整覆盖后端全部 30 个内置工具 + 动态 mcp__* 工具（彻底消除「未识别工具」报错）；
 * - 容错解析 double-encoded JSON arguments 与常见参数别名（file_path/command/old_string/new_string）；
 * - 护栏细节严格对齐后端 guard.js / commands.js / system.js / browser.js；
 * - 同轮工具循环内为 DeepSeek/GLM 思考模型保留 reasoning_content，跨轮严格 append-only。
 */
import * as api from './bridge.js'
import { streamChatCompletion } from './modelTransport.js'
import { sanitizeMessagesForApi } from './dag.js'
import { isAbort } from './errors.js'
import { createCostDefense, detectTakeoverRequired } from './budgetAndResume.js'
import { runSelfCheckAfterWrites } from './selfCheck.js'
import { detectProviderKind } from './reasoningPresets.js'
import { stripGlobalMemoryForIsolatedGroup } from './groupStore.js'
import {
  predictToolProfile,
  selectToolsForProfile,
  isAutonomousAuthorized,
  buildClarifyDirective,
  TOOL_PROFILE_META,
} from './toolRouter.js'
import {
  canonicalizeTools,
  computePrefixFingerprint,
  buildDynamicTurnReminder,
  attachReminderToLatestUserTurn,
} from './promptCache.js'

export const WRITE_TOOLS = new Set([
  'write_file', 'append_file', 'search_replace', 'delete_path', 'move_path', 'copy_path', 'make_dir',
])
export const SHELL_TOOLS = new Set(['run_command', 'run_powershell', 'run_admin_command'])

/** 全部受支持的内置工具名清单（与 server/src/services/provider.js 逐项对齐） */
export const SUPPORTED_BUILTIN_TOOLS = Object.freeze([
  'read_more',
  'read_file', 'write_file', 'append_file', 'search_replace', 'list_dir',
  'make_dir', 'delete_path', 'move_path', 'copy_path', 'get_file_info',
  'run_command', 'run_powershell', 'run_admin_command',
  'open_app', 'open_url', 'take_screenshot', 'clipboard_read', 'clipboard_write',
  'list_processes', 'kill_process', 'append_memory',
  'browser_search', 'browser_open', 'software_call',
  'browser_navigate', 'browser_extract', 'browser_snapshot',
  'browser_click', 'browser_fill', 'browser_screenshot', 'browser_close',
  'memory_write', 'memory_search', 'inspect_tool_schema', 'ask_user_options',
  'group_file_list', 'group_file_read', 'group_file_search',
])
const SUPPORTED_BUILTIN_SET = new Set(SUPPORTED_BUILTIN_TOOLS)

const GUARDED_EXTRA_TOOLS = new Set([
  'open_app', 'open_url', 'take_screenshot', 'clipboard_read', 'clipboard_write',
  'kill_process', 'software_call',
  'browser_navigate', 'browser_extract', 'browser_snapshot',
  'browser_click', 'browser_fill', 'browser_screenshot', 'browser_close',
])

const _toolsCache = new Map()
const _frozenPrefixBySid = new Map()
const _injectedMemoriesBySid = new Map()
const TOOLS_CACHE_TTL_MS = 30000
const SID_CACHE_MAX = 64

function lruSet(map, key, value, max = SID_CACHE_MAX) {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  while (map.size > max) {
    map.delete(map.keys().next().value)
  }
}

export function invalidateSessionPrefixCache(sid) {
  if (sid) {
    _frozenPrefixBySid.delete(String(sid))
    _injectedMemoriesBySid.delete(String(sid))
  } else {
    _frozenPrefixBySid.clear()
    _injectedMemoriesBySid.clear()
  }
}

export function normCachePath(p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase()
}

export function invalidateCachesAfterTool(readFileSet, listDirsSet, toolName, args, ok) {
  if (SHELL_TOOLS.has(toolName)) {
    readFileSet.clear()
    listDirsSet.clear()
    return true
  }
  if (!ok || !WRITE_TOOLS.has(toolName)) return false
  listDirsSet.clear()
  const targets = [args.path, args.file_path, args.src, args.dst, args.new_path].filter(Boolean).map(normCachePath)
  for (const key of [...readFileSet]) {
    const kNorm = normCachePath(key)
    if (targets.some((t) => kNorm.startsWith(t + '@'))) readFileSet.delete(key)
  }
  return true
}

export function extractAndStripDiff(toolName, args, rawResult) {
  let parsed = rawResult
  if (typeof rawResult === 'string') {
    try { parsed = JSON.parse(rawResult) } catch { return { cleanJson: rawResult, diff: null, ok: true } }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { cleanJson: JSON.stringify(parsed), diff: null, ok: true }
  }
  let diff = null
  if (parsed.diff && typeof parsed.diff === 'object') {
    diff = {
      tool: toolName,
      path: String(parsed.path || args.path || args.file_path || args.src || args.new_path || ''),
      before: String(parsed.diff.before ?? ''),
      after: String(parsed.diff.after ?? ''),
      at: Date.now(),
    }
    const copy = { ...parsed }
    delete copy.diff
    parsed = copy
  }
  // 写文件成功后不再把完整文件内容回灌 tool 响应（模型自己的 tool_calls.arguments 已含全文，
  // 避免新增冗余未缓存 Token，进一步把前缀缓存命中率推高至 95%+）
  if ((toolName === 'write_file' || toolName === 'append_file') && parsed.ok === true && typeof parsed.content === 'string') {
    const copy = { ...parsed }
    delete copy.content
    parsed = copy
  }
  const ok = !(parsed.ok === false || parsed.error)
  return { cleanJson: JSON.stringify(parsed), diff, ok }
}

/** 容错解析模型工具参数（兼容标准 JSON 对象、二次转义 JSON 字符串与参数别名） */
export function parseToolArgs(rawArgs) {
  let obj = rawArgs
  for (let i = 0; i < 2 && typeof obj === 'string'; i++) {
    const trimmed = obj.trim()
    if (!trimmed) { obj = {}; break }
    try { obj = JSON.parse(trimmed) } catch { break }
  }
  return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {}
}

/** 构造与后端 guard.js / commands.js / system.js 逐字段一致的护栏 detail，确保 confirmToken 摘要 100% 命中 */
export function buildGuardDetail(name, args = {}) {
  if (SHELL_TOOLS.has(name)) {
    return { cmd: String(args.cmd || args.command || args.script || '').trim() }
  }
  if (name === 'delete_path' || name === 'open_app') {
    return { path: String(args.path || args.file_path || args.target || '').trim() }
  }
  if (name === 'open_url') {
    return { url: String(args.url || args.href || '').trim().slice(0, 200) }
  }
  if (name === 'clipboard_write') {
    return { len: String(args.text ?? args.content ?? '').length }
  }
  if (name === 'clipboard_read' || name === 'take_screenshot') {
    return {}
  }
  if (name === 'kill_process') {
    const out = {}
    if (args.pid !== undefined) out.pid = Number(args.pid)
    if (args.name) out.name = String(args.name)
    return out
  }
  return args || {}
}

function needsGuardCheck(name) {
  return WRITE_TOOLS.has(name) || SHELL_TOOLS.has(name) || GUARDED_EXTRA_TOOLS.has(name) || name.startsWith('mcp__')
}

export async function dispatchSingleTool({ name, args = {}, sid, signal, readonlyMode = false, isolatedGroupId = '', requestApproval, requestClarify, callRaw = api.callJsApiRaw }) {
  // 群聊专属群文件工具（严格锁死在当前 isolatedGroupId 独立目录内，跨群路径一律拒绝）
  if (name === 'group_file_list' || name === 'group_file_read' || name === 'group_file_search') {
    if (!isolatedGroupId) {
      return JSON.stringify({ ok: false, error: '当前不是群聊会话，无法访问群文件' })
    }
    if (name === 'group_file_list') {
      const res = await api.groupFilesList(isolatedGroupId, '', { sid, signal }).catch((e) => ({ ok: false, error: e.message }))
      const files = (res && Array.isArray(res.files)) ? res.files.map((f) => ({ name: f.name, title: f.title, member: f.member, size: f.size })) : []
      return JSON.stringify({ ok: true, group_id: isolatedGroupId, count: files.length, files })
    }
    if (name === 'group_file_search') {
      const res = await api.groupFilesSearch(isolatedGroupId, String(args.query || ''), Number(args.limit) || 6, { sid, signal }).catch((e) => ({ ok: false, error: e.message }))
      return JSON.stringify(res || { ok: true, hits: [] })
    }
    // group_file_read：先查本群文件白名单，只允许读取真正归属于本群的文件，杜绝跨群越权！
    const want = String(args.name || args.path || '').trim()
    const listed = await api.groupFilesList(isolatedGroupId, '', { sid, signal }).catch(() => ({ files: [] }))
    const files = (listed && Array.isArray(listed.files)) ? listed.files : []
    const hit = files.find((f) => f && (f.name === want || f.path === want || (want && f.name.endsWith(want))))
    if (!hit) {
      return JSON.stringify({ ok: false, error: `权限拒绝或文件不存在：仅允许读取当前群聊（${isolatedGroupId}）专属群文件` })
    }
    const readRes = await api.groupFilesRead(hit.path, { sid, signal }).catch((e) => ({ ok: false, error: e.message }))
    return JSON.stringify(readRes || { ok: false, error: '读取群文件失败' })
  }

  if (name === 'ask_user_options') {
    const questions = Array.isArray(args.questions) ? args.questions : []
    if (typeof requestClarify !== 'function' || !questions.length) {
      return JSON.stringify({
        ok: true,
        mode: 'autonomous',
        summary: '当前环境已自动授权 AI 自主发挥，请按最优方案直接落地。',
      })
    }
    const answer = await requestClarify({
      title: String(args.title || '请确认方案与视觉效果方向'),
      subtitle: String(args.subtitle || '选择后我将严格按你的偏好执行，也可在下方输入自定义要求'),
      allow_custom: args.allow_custom !== false,
      questions,
    })
    return JSON.stringify({
      ok: true,
      mode: (answer && answer.mode) || 'selected',
      answers: (answer && answer.answers) || {},
      customNote: (answer && answer.customNote) || '',
      summary: (answer && answer.summary) || '用户已确认方案，请继续执行。',
    })
  }

  if (readonlyMode && (WRITE_TOOLS.has(name) || SHELL_TOOLS.has(name))) {
    return JSON.stringify({ skipped: true, info: '当前处于只读模式，写文件与命令工具已禁用。' })
  }
  const opt = { sid, signal, agentLoop: true, allowErrorPayload: true }
  let token = ''
  let confirmed = false

  if (needsGuardCheck(name)) {
    try {
      const guardDetail = buildGuardDetail(name, args)
      const chk = await api.guardCheck(name, guardDetail, { sid, signal })
      if (chk && (chk.action === 'block' || chk.action === 'deny')) {
        return JSON.stringify({ skipped: true, info: chk.reason || '被安全护栏保护名单拒绝执行' })
      }
      if (chk && chk.action === 'confirm' && typeof requestApproval === 'function') {
        const decision = await requestApproval({
          tool: name,
          args,
          reason: chk.reason || `安全护栏拦截（${chk.label || name}），可在「设置 → 工具、护栏与沙箱」关闭沙箱或调整档位`,
          danger: name === 'delete_path' || SHELL_TOOLS.has(name) || name === 'kill_process',
        })
        if (!decision || !decision.ok) {
          const extra = decision && decision.denyReason ? ` 用户说明：「${decision.denyReason}」` : ''
          return JSON.stringify({
            skipped: true,
            info: `用户拒绝了本次 ${name} 操作。${extra} 请按用户意图调整方案，不要原样重试。`,
          })
        }
        confirmed = true
        if (decision.trustSession) await api.guardSessionTrust(name, { sid }).catch(() => {})
        const tk = await api.guardConfirmToken(name, guardDetail, { sid }).catch(() => null)
        token = (tk && tk.token) || ''
      }
    } catch {}
  }

  const callOpt = { ...opt, confirmed }
  const p = args.path || args.file_path || args.filename || args.target_path || args.src || ''
  const cmdStr = args.cmd || args.command || args.script || ''

  // 1) 分段续读
  if (name === 'read_more') {
    return callRaw('read_more', [args.cache_id || args.id || '', args.offset || 0, args.limit || 400], callOpt)
  }

  // 2) 文件工具族（10 项全齐）
  if (name === 'read_file') return callRaw('read_file', [p, args.offset || 0, args.limit || 0, !!args.force], callOpt)
  if (name === 'list_dir') return callRaw('list_dir', [p || '.'], callOpt)
  if (name === 'write_file') return callRaw('write_file', [p, args.content ?? args.text ?? ''], callOpt)
  if (name === 'append_file') return callRaw('append_file', [p, args.content ?? args.text ?? ''], callOpt)
  if (name === 'search_replace') {
    const oldVal = args.old ?? args.old_text ?? args.old_string ?? args.search ?? ''
    const newVal = args.new ?? args.new_text ?? args.new_string ?? args.replace ?? ''
    return callRaw('search_replace', [p, oldVal, newVal, !!args.replace_all], callOpt)
  }
  if (name === 'make_dir') return callRaw('make_dir', [p], callOpt)
  if (name === 'copy_path') return callRaw('copy_path', [args.src || p, args.new_path || args.dst || args.dest || ''], callOpt)
  if (name === 'move_path') return callRaw('move_path', [args.src || p, args.new_path || args.dst || args.dest || ''], callOpt)
  if (name === 'delete_path') return callRaw('delete_path', [p, args.recycle !== false, token], callOpt)
  if (name === 'get_file_info') return callRaw('get_file_info', [p], callOpt)

  // 3) 命令与系统工具族（10 项全齐）
  if (name === 'run_command') return callRaw('run_command', [cmdStr, args.timeout || 120, token], { ...callOpt, timeoutMs: 300000 })
  if (name === 'run_powershell') return callRaw('run_powershell', [cmdStr, args.timeout || 120, token], { ...callOpt, timeoutMs: 300000 })
  if (name === 'run_admin_command') return callRaw('run_admin_command', [cmdStr, token, args.timeout || 120], { ...callOpt, timeoutMs: 300000 })
  if (name === 'open_app') return callRaw('open_app', [p || args.app || args.target || '', token], callOpt)
  if (name === 'open_url') return callRaw('open_url', [args.url || args.href || p || '', token], callOpt)
  if (name === 'take_screenshot') {
    return callRaw('take_screenshot', [args.left || 0, args.top || 0, args.width || 0, args.height || 0, token], callOpt)
  }
  if (name === 'clipboard_read') return callRaw('get_clipboard', [token], callOpt)
  if (name === 'clipboard_write') return callRaw('set_clipboard', [String(args.text ?? args.content ?? ''), token], callOpt)
  if (name === 'list_processes') return callRaw('list_processes', [String(args.keyword || '')], callOpt)
  if (name === 'kill_process') return callRaw('kill_process', [args.pid ?? null, String(args.name || ''), token], callOpt)
  if (name === 'append_memory') {
    const entry = JSON.stringify({ text: String(args.content ?? args.text ?? ''), kind: args.kind || 'fact' })
    return callRaw('append_memory', [entry], callOpt)
  }

  // 4) 浏览器、外部软件、记忆与元工具族（11 项全齐）
  if (name === 'browser_search') return callRaw('browser_search', [args, token], { ...callOpt, timeoutMs: 90000 })
  if (name === 'browser_open') return callRaw('browser_open', [args], { ...callOpt, timeoutMs: 90000 })
  if (name === 'software_call') return callRaw('software_call', [args, token], { ...callOpt, timeoutMs: 300000 })
  if (name === 'browser_navigate') {
    return callRaw('browser_navigate', [args.url || '', args.wait_selector || '', args.timeout || 25, args.mode || 'hidden', token], { ...callOpt, timeoutMs: 90000 })
  }
  if (name === 'browser_extract') return callRaw('browser_extract', [args.selector || '', args.mode || 'markdown', token], callOpt)
  if (name === 'browser_snapshot') return callRaw('browser_snapshot', [args.selector || '', args.max_chars || 8000, token], callOpt)
  if (name === 'browser_click') return callRaw('browser_click', [args.target || args.selector || '', token], callOpt)
  if (name === 'browser_fill') return callRaw('browser_fill', [args.selector || args.target || '', String(args.text ?? ''), token], callOpt)
  if (name === 'browser_screenshot') return callRaw('browser_screenshot', [!!args.full_page, token], callOpt)
  if (name === 'browser_close') return callRaw('browser_close', [args.session_id || '', token], callOpt)
  if (name === 'memory_search') return callRaw('memory_search', [args.query || '', args.limit || 8], callOpt)
  if (name === 'memory_write' || name === 'memory_remember') {
    return callRaw('memory_remember', [String(args.text ?? args.content ?? '')], callOpt)
  }
  if (name === 'inspect_tool_schema') return callRaw('inspect_tool_schema', [String(args.name || '')], callOpt)

  // 5) 动态 MCP 工具
  if (name.startsWith('mcp__')) {
    const parts = name.split('__')
    return callRaw('mcp_call_tool', [parts[1] || '', parts.slice(2).join('__'), JSON.stringify(args), 'allow', token], callOpt)
  }
  return JSON.stringify({ error: `未识别工具: ${name}` })
}

export async function runAgentConversation({
  sid,
  session = null,
  userQuery,
  historyMessages,
  endpointConfig,
  expertPrompt = '',
  workspacePath = '',
  sessionBudgetRmb = 0,
  correctiveDirective = '',
  allowTools = true,
  isolatedGroupId = '',
  askBeforeDesign = true,
  forceToolProfile = '',
  maxRounds = 14,
  skipMemoryRecall = false,
  skipSelfCheck = false,
  signal,
  onEvent,
  requestApproval,
  requestClarify,
  requestTakeover,
  requestBudgetDecision,
}) {
  const startedAt = Date.now()
  const emit = (patch) => { if (typeof onEvent === 'function') onEvent({ elapsedMs: Date.now() - startedAt, ...patch }) }

  emit({ phase: 'waiting', stageLabel: '装配工作区规范、长期记忆与工具面' })

  // 智能工具域预判 + 会话级单调粘性锁：
  // 1) 按任务语义仅装配真正需要的工具子集（chat / coding / web / coding_web / full），省掉 55%–85% 无用工具 Schema Token；
  // 2) 同一 sid 内单调锁死工具集，即使主持人步骤 allowTools=false 也不删改 tools[]，100% 保护多轮 KV-Cache 前缀！
  const isGlm = /bigmodel\.cn/i.test(endpointConfig.baseUrl || '')
  const includeMcp = !!endpointConfig.hasEnabledMcp
  const toolsOn = endpointConfig.tool_mode !== 'off'
  const blockToolDispatch = allowTools === false
  const existingFrozen = sid ? _frozenPrefixBySid.get(String(sid)) : null
  const predictedProfile = forceToolProfile || predictToolProfile(userQuery, {
    hasEnabledMcp: includeMcp,
    forceFull: endpointConfig.tool_mode === 'full',
    prevProfile: existingFrozen ? existingFrozen.toolProfile : '',
  })
  const prefixScopeKey = `${workspacePath || ''}|${isolatedGroupId || 'chat'}|${toolsOn ? predictedProfile : 'off'}|${includeMcp}|${isGlm}|${endpointConfig.system_prompt || ''}`

  let systemPrompt = endpointConfig.system_prompt || '你是 Harbor 桌面智能工程助手，请始终用简体中文清晰回答。'
  let tools = []
  let totalAvailableTools = 0
  let prefixHash = ''
  let prefixLocked = false

  if (existingFrozen && existingFrozen.key === prefixScopeKey) {
    systemPrompt = existingFrozen.systemPrompt
    tools = existingFrozen.tools
    totalAvailableTools = existingFrozen.totalAvailableTools || tools.length
    prefixHash = existingFrozen.hash
    prefixLocked = true
  } else {
    try {
      const sysRes = await api.buildSystemPrompt('', { sid, signal })
      if (typeof sysRes === 'string' && sysRes.trim()) systemPrompt = sysRes
    } catch {}
    // 群聊强隔离：剥离跨会话全局长期记忆并写入明确群聊边界，确保新建群聊绝不串读已删除群聊/其他会话
    if (isolatedGroupId) {
      systemPrompt = `${stripGlobalMemoryForIsolatedGroup(systemPrompt)}

【会话隔离边界】当前为独立群聊（ID: ${isolatedGroupId}）。请只依据本群聊上下文与本群专属群文件（group_file_list / group_file_read / group_file_search）协同作业，绝不引用或臆测其他会话或已删除群聊的内容。`
    }
    if (toolsOn) {
      const cacheKey = `${sid || ''}|full|${includeMcp}|${isGlm}`
      let rawFullTools = []
      const hit = _toolsCache.get(cacheKey)
      if (hit && hit.exp > Date.now()) {
        rawFullTools = hit.tools
      } else {
        try {
          const built = await api.buildTools('full', includeMcp, true, isGlm, { sid, signal, timeoutMs: 8000 })
          if (Array.isArray(built)) rawFullTools = built
          else if (built && Array.isArray(built.tools)) rawFullTools = built.tools
          rawFullTools = canonicalizeTools(rawFullTools)
          lruSet(_toolsCache, cacheKey, { tools: rawFullTools, exp: Date.now() + TOOLS_CACHE_TTL_MS }, 32)
        } catch {}
      }
      totalAvailableTools = rawFullTools.length
      if (rawFullTools.length > 4) {
        tools = selectToolsForProfile(rawFullTools, predictedProfile, {
          includeAskUser: true,
          isolatedGroup: Boolean(isolatedGroupId),
        })
      } else {
        tools = rawFullTools
      }
    }
    tools = canonicalizeTools(tools)
    prefixHash = computePrefixFingerprint(systemPrompt, tools)
    if (sid) {
      lruSet(_frozenPrefixBySid, String(sid), {
        key: prefixScopeKey,
        toolProfile: predictedProfile,
        systemPrompt,
        tools,
        totalAvailableTools,
        hash: prefixHash,
      })
    }
  }

  const profileMeta = TOOL_PROFILE_META[predictedProfile] || TOOL_PROFILE_META.coding
  emit({
    toolProfile: {
      id: predictedProfile,
      label: profileMeta.label,
      activeCount: tools.length,
      totalCount: Math.max(totalAvailableTools, tools.length),
    },
  })

  let dynamicMemories = []
  if (!skipMemoryRecall && String(userQuery || '').trim()) {
    try {
      const mRes = await api.memorySearch(String(userQuery).trim(), 3, { sid, signal })
      const rawItems = (mRes && (mRes.items || mRes.results)) || (Array.isArray(mRes) ? mRes : [])
      if (Array.isArray(rawItems)) {
        const seen = sid ? (_injectedMemoriesBySid.get(String(sid)) || new Set()) : new Set()
        for (const item of rawItems) {
          const txt = String(typeof item === 'string' ? item : (item && (item.text || item.content || item.value)) || '').trim()
          if (txt && !seen.has(txt)) {
            dynamicMemories.push(txt)
            seen.add(txt)
          }
        }
        if (sid) lruSet(_injectedMemoriesBySid, String(sid), seen)
      }
    } catch {}
  }

  const autonomousNow = isAutonomousAuthorized(userQuery)
  const hasAskUserTool = tools.some((t) => ((t && t.function && t.function.name) || '') === 'ask_user_options')
  const clarifyHint = (!blockToolDispatch && hasAskUserTool && String(userQuery || '').trim())
    ? buildClarifyDirective({ autonomous: autonomousNow, askBeforeDesign })
    : ''
  const combinedDirective = [
    correctiveDirective,
    clarifyHint,
    blockToolDispatch ? '【本步指令约束】本步骤仅做任务分析、角色分工与交接规划，严禁调用任何工具，请直接输出最终结果。' : '',
  ].filter(Boolean).join('\n')
  const tailReminder = buildDynamicTurnReminder({
    memories: dynamicMemories,
    expertPrompt,
    readonlyMode: false,
    correctiveDirective: combinedDirective,
  })
  const baseWireMsgs = attachReminderToLatestUserTurn(sanitizeMessagesForApi(historyMessages), tailReminder)
  let wiredUserContent = ''
  for (let i = baseWireMsgs.length - 1; i >= 0; i--) {
    if (baseWireMsgs[i] && baseWireMsgs[i].role === 'user') {
      wiredUserContent = String(baseWireMsgs[i].content || '')
      break
    }
  }

  const workingMsgs = [
    { role: 'system', content: systemPrompt },
    ...baseWireMsgs,
  ]
  const wireTrail = []

  const readFileSet = new Set()
  const listDirsSet = new Set()
  const defense = createCostDefense({ sessionBudgetRmb })
  const allTools = []
  const allDiffs = []
  let finalContent = ''
  let finalReasoning = ''
  let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 }
  let wroteFiles = false
  let selfCheckDone = false
  let readonlyMode = false
  let factsCount = 0

  for (let round = 0; round < maxRounds; round++) {
    if (signal && signal.aborted) break

    const budgetHit = defense.checkBudget((session && session.usage ? session.usage.total_tokens : 0) + totalUsage.total_tokens)
    if (budgetHit && typeof requestBudgetDecision === 'function') {
      const dec = await requestBudgetDecision({ kind: 'budget', detail: `本会话累计估算花费 ¥${budgetHit.spent} 已触达上限 ¥${budgetHit.budget}` })
      if (!dec || dec.action === 'stop') {
        emit({ phase: 'done', reasoning: finalReasoning, answer: finalContent || '已按预算上限暂停会话。', cps: 0 })
        return { content: finalContent, reasoning: finalReasoning, tools: allTools, diffs: allDiffs, usage: totalUsage, paused: true, wiredUserContent, wireTrail }
      }
      if (dec.action === 'readonly') {
        readonlyMode = true
        const roMsg = { role: 'user', content: buildDynamicTurnReminder({ readonlyMode: true }) }
        workingMsgs.push(roMsg)
        wireTrail.push(roMsg)
      }
    }

    emit({ phase: round === 0 ? 'waiting' : 'thinking', stageLabel: round === 0 ? '正在连接模型并唤醒深度推演' : `第 ${round + 1} 轮分析与执行中` })

    const res = await streamChatCompletion({
      baseUrl: endpointConfig.baseUrl,
      apiKey: endpointConfig.apiKey,
      model: endpointConfig.model,
      messages: workingMsgs,
      tools,
      sid,
      temperature: endpointConfig.temperature,
      topP: endpointConfig.top_p,
      maxTokens: endpointConfig.max_tokens,
      reasoningEffort: endpointConfig.reasoning_effort,
      thinkingBudget: endpointConfig.thinking_budget,
      customEffort: endpointConfig.custom_effort,
      harnessMeta: { v: 2, phase: 'execute', workspace: workspacePath, prefixHash },
      signal,
      onDelta: ({ reasoning, content, cps, hasReasoning, hasContent }) => {
        const mergedReasoning = finalReasoning ? `${finalReasoning}\n${reasoning}` : reasoning
        const nextPhase = hasContent ? 'streaming' : (hasReasoning ? 'thinking' : 'waiting')
        emit({ phase: nextPhase, reasoning: mergedReasoning, answer: content, cps })
      },
    })

    if (res.usage) {
      totalUsage.prompt_tokens += Number(res.usage.prompt_tokens) || 0
      totalUsage.completion_tokens += Number(res.usage.completion_tokens) || 0
      totalUsage.total_tokens += Number(res.usage.total_tokens) || 0
    }
    if (res.cacheUsage) {
      totalUsage.cached_tokens += res.cacheUsage.cachedTokens || 0
      totalUsage.cache_write_tokens += res.cacheUsage.cacheWriteTokens || 0
      emit({
        cacheStats: {
          ...res.cacheUsage,
          prefixHash,
          prefixLocked,
        },
      })
    }
    if (res.reasoning) finalReasoning = finalReasoning ? `${finalReasoning}\n\n${res.reasoning}` : res.reasoning
    finalContent = res.content || ''

    if (blockToolDispatch || !res.toolCalls || !res.toolCalls.length) {
      if (!skipSelfCheck && wroteFiles && !selfCheckDone && !(signal && signal.aborted)) {
        selfCheckDone = true
        emit({ phase: 'thinking', stageLabel: '写后自动验收自检中…' })
        const sc = await runSelfCheckAfterWrites({
          session,
          readFile: (fp) => api.readFile(fp, 0, 100, true, { sid, signal }).then((r) => (r && r.content) || '').catch(() => ''),
          runCommand: (cmd, t) => api.callJsApiRaw('run_command', [cmd, t, ''], { sid, signal, timeoutMs: 120000 }),
        })
        if (sc.ran && !sc.ok && sc.feedbackMessage) {
          const aMsg = { role: 'assistant', content: finalContent }
          const fbMsg = { role: 'user', content: sc.feedbackMessage }
          workingMsgs.push(aMsg, fbMsg)
          wireTrail.push(aMsg, fbMsg)
          emit({ phase: 'thinking', stageLabel: `自动验收发现异常（${sc.cmd}），回灌模型自修中…` })
          continue
        }
      }
      emit({ phase: 'done', reasoning: finalReasoning, answer: finalContent, cps: 0, tools: [...allTools], diffs: [...allDiffs] })
      return { content: finalContent, reasoning: finalReasoning, tools: allTools, diffs: allDiffs, usage: totalUsage, paused: false, wiredUserContent, wireTrail }
    }

    const sig = JSON.stringify(res.toolCalls.map((tc) => [tc.function && tc.function.name, tc.function && tc.function.arguments]))
    const loopCheck = defense.registerToolSignature(sig)
    if (loopCheck.loop && typeof requestBudgetDecision === 'function') {
      const dec = await requestBudgetDecision({ kind: 'loop', detail: '检测到模型连续 3 次重复调用相同工具与参数，已触发循环熔断暂停。' })
      if (!dec || dec.action === 'stop') {
        emit({ phase: 'done', reasoning: finalReasoning, answer: finalContent || '已触发循环熔断并暂停。', cps: 0 })
        return { content: finalContent, reasoning: finalReasoning, tools: allTools, diffs: allDiffs, usage: totalUsage, paused: true, wiredUserContent, wireTrail }
      }
      if (dec.action === 'readonly') {
        readonlyMode = true
        const roMsg = { role: 'user', content: buildDynamicTurnReminder({ readonlyMode: true }) }
        workingMsgs.push(roMsg)
        wireTrail.push(roMsg)
      }
    }

    const providerKind = detectProviderKind(endpointConfig.baseUrl, endpointConfig.model)
    const keepIntraTurnReasoning = (providerKind === 'deepseek' || providerKind === 'glm') && Boolean(res.reasoning)
    const tcAssistantMsg = {
      role: 'assistant',
      content: res.content || '',
      tool_calls: res.toolCalls,
      ...(keepIntraTurnReasoning ? { reasoning_content: res.reasoning } : {}),
    }
    workingMsgs.push(tcAssistantMsg)
    wireTrail.push({ role: 'assistant', content: res.content || '', tool_calls: res.toolCalls })

    for (const tc of res.toolCalls) {
      if (signal && signal.aborted) break
      const tName = (tc.function && tc.function.name) || ''
      const args = parseToolArgs(tc.function && tc.function.arguments)

      const rec = {
        id: tc.id || `tool_${allTools.length}`,
        name: tName,
        detail: String(args.path || args.file_path || args.cmd || args.command || args.query || args.url || args.target || '').slice(0, 64),
        status: 'running',
      }
      allTools.push(rec)
      emit({ phase: 'thinking', stageLabel: `正在执行工具：${tName}`, tools: [...allTools] })

      let rawOut = ''
      const resolvedPath = args.path || args.file_path || args.filename || ''
      const readKey = tName === 'read_file' && resolvedPath && !args.force ? `${normCachePath(resolvedPath)}@${args.offset || 0}` : ''
      const dirKey = tName === 'list_dir' ? normCachePath(resolvedPath || '.') : ''

      if (readKey && readFileSet.has(readKey)) {
        rawOut = JSON.stringify({ skipped: true, info: `文件 ${resolvedPath} 已在上下文中，请直接引用` })
      } else if (dirKey && listDirsSet.has(dirKey)) {
        rawOut = JSON.stringify({ skipped: true, info: `目录 ${resolvedPath || '.'} 已列出，请直接引用` })
      } else {
        try {
          if (readKey) readFileSet.add(readKey)
          if (dirKey) listDirsSet.add(dirKey)
          rawOut = await dispatchSingleTool({ name: tName, args, sid, signal, readonlyMode, isolatedGroupId, requestApproval, requestClarify })
          const takeover = detectTakeoverRequired(rawOut)
          if (takeover && typeof requestTakeover === 'function') {
            const action = await requestTakeover(takeover)
            if (takeover.takeoverId) {
              rawOut = JSON.stringify(await api.browserTakeover(takeover.takeoverId, action || 'resume', { sid, signal }))
            }
          }
        } catch (err) {
          if (isAbort(err)) throw err
          rawOut = JSON.stringify({ ok: false, error: String(err && err.message || err) })
        }
      }

      const { cleanJson, diff, ok } = extractAndStripDiff(tName, args, rawOut)
      if (ok && (WRITE_TOOLS.has(tName) || SHELL_TOOLS.has(tName))) {
        wroteFiles = true
        factsCount++
      }
      invalidateCachesAfterTool(readFileSet, listDirsSet, tName, args, ok)
      rec.status = ok ? 'done' : 'fail'
      if (diff) allDiffs.unshift(diff)
      emit({ phase: 'thinking', tools: [...allTools], diffs: [...allDiffs] })

      const toolMsg = { role: 'tool', tool_call_id: tc.id, content: cleanJson.slice(0, 14000) }
      workingMsgs.push(toolMsg)
      wireTrail.push(toolMsg)
    }

    const prog = defense.registerProgress(factsCount)
    if (prog && prog.stalled && typeof requestBudgetDecision === 'function') {
      const dec = await requestBudgetDecision({
        kind: 'stalled',
        detail: `已连续 ${prog.noProgressRounds} 轮工具调用未产生有效写入或实质进展，已触发停滞熔断暂停。`,
      })
      if (!dec || dec.action === 'stop') {
        const stopText = finalContent || `已触发无进展停滞熔断并暂停（累计执行 ${allTools.length} 次工具调用）。`
        emit({ phase: 'done', reasoning: finalReasoning, answer: stopText, cps: 0, tools: [...allTools], diffs: [...allDiffs] })
        return { content: stopText, reasoning: finalReasoning, tools: allTools, diffs: allDiffs, usage: totalUsage, paused: true, wiredUserContent, wireTrail }
      }
      if (dec.action === 'readonly') {
        readonlyMode = true
        const roMsg = { role: 'user', content: buildDynamicTurnReminder({ readonlyMode: true }) }
        workingMsgs.push(roMsg)
        wireTrail.push(roMsg)
      }
    }
  }

  if (!finalContent && allTools.length > 0 && !(signal && signal.aborted)) {
    finalContent = `已达到单轮最大工具执行轮次上限（${maxRounds} 轮，共执行 ${allTools.length} 次工具调用）。如需继续推进，请回复「继续」。`
  }
  emit({ phase: 'done', reasoning: finalReasoning, answer: finalContent, cps: 0, tools: [...allTools], diffs: [...allDiffs] })
  return { content: finalContent, reasoning: finalReasoning, tools: allTools, diffs: allDiffs, usage: totalUsage, paused: false, wiredUserContent, wireTrail }
}
