/**
 * React 19 全量 Agent 运行引擎（R6 90%+ KV-Cache + 群聊真工具统一引擎）：
 * - Append-Only Wire Prefix：会话级冻结静态前缀 + 动态记忆去重后置 + 返回 wiredUserContent / wireTrail 供下轮逐字节复现；
 * - 护栏细节严格对齐后端 commands.js / guard.js（{ cmd } / { path }），并同时拦截 block 与 deny；
 * - 写后 readFileSet（反斜杠归一）+ listDirsSet 失效 + parsed.diff 消费即剥离；
 * - 成本三维熔断 + CAPTCHA_REQUIRED 人工接管 + 写后三级自检闭环；
 * - 主对话与群聊成员共用同一套工具执行闭环（群聊真正能写文件、跑命令、建网页）。
 */
import * as api from './bridge.js'
import { streamChatCompletion } from './modelTransport.js'
import { sanitizeMessagesForApi } from './dag.js'
import { isAbort } from './errors.js'
import { createCostDefense, detectTakeoverRequired } from './budgetAndResume.js'
import { runSelfCheckAfterWrites } from './selfCheck.js'
import {
  canonicalizeTools,
  computePrefixFingerprint,
  buildDynamicTurnReminder,
  attachReminderToLatestUserTurn,
} from './promptCache.js'

export const WRITE_TOOLS = new Set([
  'write_file', 'append_file', 'search_replace', 'delete_path', 'move_path', 'copy_path', 'make_dir',
])
export const SHELL_TOOLS = new Set(['run_command', 'run_powershell'])
const _toolsCache = new Map()
const _frozenPrefixBySid = new Map() // sid -> { key, systemPrompt, tools, hash }
const _injectedMemoriesBySid = new Map() // sid -> Set<string>（防止每轮重复注入相同记忆破坏缓存）
const TOOLS_CACHE_TTL_MS = 30000

/** 显式失效会话冻结前缀（仅在切换工作区或手动 /compact 时调用） */
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
  const targets = [args.path, args.src, args.dst, args.new_path].filter(Boolean).map(normCachePath)
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
      path: String(parsed.path || args.path || args.src || args.new_path || ''),
      before: String(parsed.diff.before ?? ''),
      after: String(parsed.diff.after ?? ''),
      at: Date.now(),
    }
    const copy = { ...parsed }
    delete copy.diff
    parsed = copy
  }
  const ok = !(parsed.ok === false || parsed.error)
  return { cleanJson: JSON.stringify(parsed), diff, ok }
}

/** 构造与后端 guard.js / commands.js / files.js 逐字段一致的护栏 detail，确保 confirmToken 摘要 100% 命中 */
export function buildGuardDetail(name, args = {}) {
  if (SHELL_TOOLS.has(name) || name === 'run_admin_command') {
    return { cmd: String(args.cmd || args.command || '').trim() }
  }
  if (name === 'delete_path') {
    return { path: String(args.path || args.file_path || '').trim() }
  }
  return args || {}
}

async function dispatchSingleTool({ name, args, sid, signal, readonlyMode, requestApproval }) {
  if (readonlyMode && (WRITE_TOOLS.has(name) || SHELL_TOOLS.has(name))) {
    return JSON.stringify({ skipped: true, info: '当前处于只读模式，写文件与命令工具已禁用。' })
  }
  const opt = { sid, signal, agentLoop: true, allowErrorPayload: true }
  let token = ''
  let confirmed = false

  if (WRITE_TOOLS.has(name) || SHELL_TOOLS.has(name) || name.startsWith('browser_') || name.startsWith('mcp__') || name === 'software_call') {
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
          reason: chk.reason || `安全护栏拦截（${chk.label || name}），请在「设置 → 工具、护栏与沙箱」调整审批档位或点此放行`,
          danger: name === 'delete_path' || SHELL_TOOLS.has(name),
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
  const p = args.path || args.file_path || args.filename || args.src || ''
  if (name === 'read_file') return api.callJsApiRaw('read_file', [p, args.offset || 0, args.limit || 0, !!args.force], callOpt)
  if (name === 'list_dir') return api.callJsApiRaw('list_dir', [p || '.'], callOpt)
  if (name === 'write_file') return api.callJsApiRaw('write_file', [p, args.content ?? ''], callOpt)
  if (name === 'append_file') return api.callJsApiRaw('append_file', [p, args.content ?? ''], callOpt)
  if (name === 'search_replace') return api.callJsApiRaw('search_replace', [p, args.old ?? args.old_text ?? '', args.new ?? args.new_text ?? '', !!args.replace_all], callOpt)
  if (name === 'make_dir') return api.callJsApiRaw('make_dir', [p], callOpt)
  if (name === 'copy_path') return api.callJsApiRaw('copy_path', [args.src || p, args.new_path || args.dst || ''], callOpt)
  if (name === 'move_path') return api.callJsApiRaw('move_path', [args.src || p, args.new_path || args.dst || ''], callOpt)
  if (name === 'delete_path') return api.callJsApiRaw('delete_path', [p, args.recycle !== false, token], callOpt)
  if (name === 'run_command') return api.callJsApiRaw('run_command', [args.cmd || args.command || '', args.timeout || 120, token], { ...callOpt, timeoutMs: 300000 })
  if (name === 'run_powershell') return api.callJsApiRaw('run_powershell', [args.cmd || args.command || '', args.timeout || 120, token], { ...callOpt, timeoutMs: 300000 })
  if (name === 'memory_search') return api.callJsApiRaw('memory_search', [args.query || '', args.limit || 8], callOpt)
  if (name === 'memory_write' || name === 'memory_remember') return api.callJsApiRaw('memory_remember', [args.text || ''], callOpt)
  if (name === 'browser_search') return api.callJsApiRaw('browser_search', [args, token], { ...callOpt, timeoutMs: 90000 })
  if (name === 'browser_navigate') return api.callJsApiRaw('browser_navigate', [args.url || '', args.wait_selector || '', args.timeout || 25, args.mode || 'headless', token], callOpt)
  if (name === 'browser_extract') return api.callJsApiRaw('browser_extract', [args.selector || '', args.mode || 'text', token], callOpt)
  if (name === 'software_call') return api.callJsApiRaw('software_call', [args, token], { ...callOpt, timeoutMs: 300000 })
  if (name === 'inspect_tool_schema') return api.callJsApiRaw('inspect_tool_schema', [args.name || ''], callOpt)
  if (name.startsWith('mcp__')) {
    const parts = name.split('__')
    return api.callJsApiRaw('mcp_call_tool', [parts[1] || '', parts.slice(2).join('__'), JSON.stringify(args), 'allow', token], callOpt)
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
  maxRounds = 14,
  skipMemoryRecall = false,
  skipSelfCheck = false,
  signal,
  onEvent,
  requestApproval,
  requestTakeover,
  requestBudgetDecision,
}) {
  const startedAt = Date.now()
  const emit = (patch) => { if (typeof onEvent === 'function') onEvent({ elapsedMs: Date.now() - startedAt, ...patch }) }

  emit({ phase: 'waiting', stageLabel: '装配工作区规范、长期记忆与工具面' })

  // 前沿 KV-Cache 策略 1：会话级冻结静态前缀（传空 query 调 buildSystemPrompt('')，杜绝动态记忆污染 messages[0]）
  const isGlm = /bigmodel\.cn/i.test(endpointConfig.baseUrl || '')
  const includeMcp = !!endpointConfig.hasEnabledMcp
  const toolsOn = allowTools !== false && endpointConfig.tool_mode !== 'off'
  const prefixScopeKey = `${workspacePath || ''}|${toolsOn ? 'on' : 'off'}|${includeMcp}|${isGlm}|${endpointConfig.system_prompt || ''}`
  const existingFrozen = sid ? _frozenPrefixBySid.get(String(sid)) : null

  let systemPrompt = endpointConfig.system_prompt || '你是 Harbor 桌面智能工程助手，请始终用简体中文清晰回答。'
  let tools = []
  let prefixHash = ''
  let prefixLocked = false

  if (existingFrozen && existingFrozen.key === prefixScopeKey) {
    systemPrompt = existingFrozen.systemPrompt
    tools = existingFrozen.tools
    prefixHash = existingFrozen.hash
    prefixLocked = true
  } else {
    try {
      const sysRes = await api.buildSystemPrompt('', { sid, signal })
      if (typeof sysRes === 'string' && sysRes.trim()) systemPrompt = sysRes
    } catch {}
    if (toolsOn) {
      const cacheKey = `${sid || ''}|${endpointConfig.tool_mode || 'auto'}|${includeMcp}|${isGlm}`
      const hit = _toolsCache.get(cacheKey)
      if (hit && hit.exp > Date.now()) {
        tools = hit.tools
      } else {
        try {
          const built = await api.buildTools('full', includeMcp, true, isGlm, { sid, signal, timeoutMs: 8000 })
          if (Array.isArray(built)) tools = built
          else if (built && Array.isArray(built.tools)) tools = built.tools
          tools = canonicalizeTools(tools)
          _toolsCache.set(cacheKey, { tools, exp: Date.now() + TOOLS_CACHE_TTL_MS })
        } catch {}
      }
    }
    tools = canonicalizeTools(tools)
    prefixHash = computePrefixFingerprint(systemPrompt, tools)
    if (sid) {
      _frozenPrefixBySid.set(String(sid), { key: prefixScopeKey, systemPrompt, tools, hash: prefixHash })
    }
  }

  // 前沿 KV-Cache 策略 2：动态记忆去重后置（同会话已注入过的记忆绝不重复注入）
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
        if (sid) _injectedMemoriesBySid.set(String(sid), seen)
      }
    } catch {}
  }

  const tailReminder = buildDynamicTurnReminder({
    memories: dynamicMemories,
    expertPrompt,
    readonlyMode: false,
    correctiveDirective,
  })
  const baseWireMsgs = attachReminderToLatestUserTurn(sanitizeMessagesForApi(historyMessages), tailReminder)
  // 记录本轮发给模型的精确末条用户内容（供下轮原样回放，保住 90%+ 历史前缀缓存！）
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
  const wireTrail = [] // 严格记录本轮产生的 assistant(tool_calls) + tool 消息，供下轮 append-only 复现

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
      // 严守前缀冻结铁律：即使进入 readonlyMode 也保持 tools 数组 100% 逐字节不变
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

    if (!res.toolCalls || !res.toolCalls.length) {
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

    const tcAssistantMsg = { role: 'assistant', content: res.content || '', tool_calls: res.toolCalls }
    workingMsgs.push(tcAssistantMsg)
    wireTrail.push(tcAssistantMsg)

    for (const tc of res.toolCalls) {
      if (signal && signal.aborted) break
      const tName = (tc.function && tc.function.name) || ''
      let args = {}
      try { args = JSON.parse((tc.function && tc.function.arguments) || '{}') || {} } catch {}

      const rec = {
        id: tc.id || `tool_${allTools.length}`,
        name: tName,
        detail: String(args.path || args.cmd || args.command || args.query || args.url || '').slice(0, 64),
        status: 'running',
      }
      allTools.push(rec)
      emit({ phase: 'thinking', stageLabel: `正在执行工具：${tName}`, tools: [...allTools] })

      let rawOut = ''
      const readKey = tName === 'read_file' && args.path && !args.force ? `${normCachePath(args.path)}@${args.offset || 0}` : ''
      const dirKey = tName === 'list_dir' ? normCachePath(args.path || '.') : ''

      if (readKey && readFileSet.has(readKey)) {
        rawOut = JSON.stringify({ skipped: true, info: `文件 ${args.path} 已在上下文中，请直接引用` })
      } else if (dirKey && listDirsSet.has(dirKey)) {
        rawOut = JSON.stringify({ skipped: true, info: `目录 ${args.path || '.'} 已列出，请直接引用` })
      } else {
        try {
          if (readKey) readFileSet.add(readKey)
          if (dirKey) listDirsSet.add(dirKey)
          rawOut = await dispatchSingleTool({ name: tName, args, sid, signal, readonlyMode, requestApproval })
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

      const toolMsg = { role: 'tool', tool_call_id: tc.id, content: cleanJson.slice(0, 24000) }
      workingMsgs.push(toolMsg)
      wireTrail.push(toolMsg)
    }

    defense.registerProgress(factsCount)
  }

  emit({ phase: 'done', reasoning: finalReasoning, answer: finalContent, cps: 0, tools: [...allTools], diffs: [...allDiffs] })
  return { content: finalContent, reasoning: finalReasoning, tools: allTools, diffs: allDiffs, usage: totalUsage, paused: false, wiredUserContent, wireTrail }
}
