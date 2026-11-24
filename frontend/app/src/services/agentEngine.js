/**
 * React 19 全量 Agent 运行引擎（Pack 2 升级版）：
 * - 写后 readFileSet（反斜杠归一）+ listDirsSet 失效 + parsed.diff 消费即剥离（0 Token 膨胀）；
 * - 成本三维熔断（会话预算硬停 / 同工具签名 ×3 循环熔断 / 10 轮无进展暂停）；
 * - CAPTCHA_REQUIRED 自动挂起人工接管（browser_takeover）；
 * - 写文件收尾前三级解析 verifyCmd 自动验收自检闭环（失败回灌 1 次自修）。
 */
import * as api from './bridge.js'
import { streamChatCompletion } from './modelTransport.js'
import { sanitizeMessagesForApi } from './dag.js'
import { isAbort } from './errors.js'
import { createCostDefense, detectTakeoverRequired } from './budgetAndResume.js'
import { runSelfCheckAfterWrites } from './selfCheck.js'

export const WRITE_TOOLS = new Set([
  'write_file', 'append_file', 'search_replace', 'delete_path', 'move_path', 'copy_path', 'make_dir',
])
export const SHELL_TOOLS = new Set(['run_command', 'run_powershell'])

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

async function dispatchSingleTool({ name, args, sid, signal, readonlyMode, requestApproval }) {
  if (readonlyMode && (WRITE_TOOLS.has(name) || SHELL_TOOLS.has(name))) {
    return JSON.stringify({ skipped: true, info: '当前处于只读模式，写文件与命令工具已禁用。' })
  }
  const opt = { sid, signal, agentLoop: true, allowErrorPayload: true }
  let token = ''
  let confirmed = false

  if (WRITE_TOOLS.has(name) || SHELL_TOOLS.has(name) || name.startsWith('browser_') || name.startsWith('mcp__') || name === 'software_call') {
    try {
      const chk = await api.guardCheck(name, args, { sid, signal })
      if (chk && chk.action === 'deny') {
        return JSON.stringify({ skipped: true, info: chk.reason || '被安全护栏规则拒绝执行' })
      }
      if (chk && chk.action === 'confirm' && typeof requestApproval === 'function') {
        const decision = await requestApproval({
          tool: name,
          args,
          reason: chk.reason || `AI 请求执行 ${name}`,
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
        const tk = await api.guardConfirmToken(name, args, { sid }).catch(() => null)
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
  signal,
  onEvent,
  requestApproval,
  requestTakeover,
  requestBudgetDecision,
}) {
  const startedAt = Date.now()
  const emit = (patch) => { if (typeof onEvent === 'function') onEvent({ elapsedMs: Date.now() - startedAt, ...patch }) }

  emit({ phase: 'waiting', stageLabel: '装配工作区规范、长期记忆与工具面' })

  let systemPrompt = endpointConfig.system_prompt || '你是 Harbor 桌面智能工程助手，请始终用简体中文清晰回答。'
  let tools = []
  try {
    const sysRes = await api.buildSystemPrompt(userQuery, { sid, signal })
    if (typeof sysRes === 'string' && sysRes.trim()) systemPrompt = sysRes
  } catch {}
  if (expertPrompt) systemPrompt = `${systemPrompt}\n\n【当前激活专家指令】\n${expertPrompt}`
  if (endpointConfig.tool_mode !== 'off') {
    try {
      const built = await api.buildTools('full', true, true, /bigmodel\.cn/i.test(endpointConfig.baseUrl || ''), { sid, signal })
      if (Array.isArray(built)) tools = built
      else if (built && Array.isArray(built.tools)) tools = built.tools
    } catch {}
  }

  const workingMsgs = [
    { role: 'system', content: systemPrompt },
    ...sanitizeMessagesForApi(historyMessages),
  ]
  if (correctiveDirective) {
    workingMsgs.push({ role: 'system', content: `【用户续跑纠偏指令】${correctiveDirective}` })
  }

  const readFileSet = new Set()
  const listDirsSet = new Set()
  const defense = createCostDefense({ sessionBudgetRmb })
  const allTools = []
  const allDiffs = []
  let finalContent = ''
  let finalReasoning = ''
  let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  let wroteFiles = false
  let selfCheckDone = false
  let readonlyMode = false
  let factsCount = 0

  for (let round = 0; round < 14; round++) {
    if (signal && signal.aborted) break

    // 预算硬停防御
    const budgetHit = defense.checkBudget((session && session.usage ? session.usage.total_tokens : 0) + totalUsage.total_tokens)
    if (budgetHit && typeof requestBudgetDecision === 'function') {
      const dec = await requestBudgetDecision({ kind: 'budget', detail: `本会话累计估算花费 ¥${budgetHit.spent} 已触达上限 ¥${budgetHit.budget}` })
      if (!dec || dec.action === 'stop') {
        emit({ phase: 'done', reasoning: finalReasoning, answer: finalContent || '已按预算上限暂停会话。', cps: 0 })
        return { content: finalContent, reasoning: finalReasoning, tools: allTools, diffs: allDiffs, usage: totalUsage, paused: true }
      }
      if (dec.action === 'readonly') readonlyMode = true
    }

    emit({ phase: round === 0 ? 'waiting' : 'thinking', stageLabel: round === 0 ? '正在连接模型并唤醒深度推演' : `第 ${round + 1} 轮分析与执行中` })

    const res = await streamChatCompletion({
      baseUrl: endpointConfig.baseUrl,
      apiKey: endpointConfig.apiKey,
      model: endpointConfig.model,
      messages: workingMsgs,
      tools: readonlyMode ? tools.filter((t) => !WRITE_TOOLS.has((t.function && t.function.name) || '')) : tools,
      temperature: endpointConfig.temperature,
      topP: endpointConfig.top_p,
      maxTokens: endpointConfig.max_tokens,
      reasoningEffort: endpointConfig.reasoning_effort,
      harnessMeta: { v: 2, phase: 'execute', workspace: workspacePath },
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
    if (res.reasoning) finalReasoning = finalReasoning ? `${finalReasoning}\n\n${res.reasoning}` : res.reasoning
    finalContent = res.content || ''

    if (!res.toolCalls || !res.toolCalls.length) {
      // I05 写后自动验收自检闭环（仅在写过文件且尚未自检时执行一次）
      if (wroteFiles && !selfCheckDone && !(signal && signal.aborted)) {
        selfCheckDone = true
        emit({ phase: 'thinking', stageLabel: '写后自动验收自检中…' })
        const sc = await runSelfCheckAfterWrites({
          session,
          readFile: (fp) => api.readFile(fp, 0, 100, true, { sid, signal }).then((r) => (r && r.content) || '').catch(() => ''),
          runCommand: (cmd, t) => api.callJsApiRaw('run_command', [cmd, t, ''], { sid, signal, timeoutMs: 120000 }),
        })
        if (sc.ran && !sc.ok && sc.feedbackMessage) {
          workingMsgs.push({ role: 'assistant', content: finalContent })
          workingMsgs.push({ role: 'system', content: sc.feedbackMessage })
          emit({ phase: 'thinking', stageLabel: `自动验收发现异常（${sc.cmd}），回灌模型自修中…` })
          continue
        }
      }
      emit({ phase: 'done', reasoning: finalReasoning, answer: finalContent, cps: 0, tools: [...allTools], diffs: [...allDiffs] })
      return { content: finalContent, reasoning: finalReasoning, tools: allTools, diffs: allDiffs, usage: totalUsage, paused: false }
    }

    // 工具签名循环熔断检测
    const sig = JSON.stringify(res.toolCalls.map((tc) => [tc.function && tc.function.name, tc.function && tc.function.arguments]))
    const loopCheck = defense.registerToolSignature(sig)
    if (loopCheck.loop && typeof requestBudgetDecision === 'function') {
      const dec = await requestBudgetDecision({ kind: 'loop', detail: '检测到模型连续 3 次重复调用相同工具与参数，已触发循环熔断暂停。' })
      if (!dec || dec.action === 'stop') {
        emit({ phase: 'done', reasoning: finalReasoning, answer: finalContent || '已触发循环熔断并暂停。', cps: 0 })
        return { content: finalContent, reasoning: finalReasoning, tools: allTools, diffs: allDiffs, usage: totalUsage, paused: true }
      }
      if (dec.action === 'readonly') readonlyMode = true
    }

    workingMsgs.push({ role: 'assistant', content: res.content || '', tool_calls: res.toolCalls })

    for (const tc of res.toolCalls) {
      if (signal && signal.aborted) break
      const tName = (tc.function && tc.function.name) || ''
      let args = {}
      try { args = JSON.parse((tc.function && tc.function.arguments) || '{}') || {} } catch {}

      const rec = {
        id: tc.id || `tool_${allTools.length}`,
        name: tName,
        detail: String(args.path || args.cmd || args.query || args.url || '').slice(0, 64),
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
          // 检测浏览器验证码人工接管挂起
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

      workingMsgs.push({ role: 'tool', tool_call_id: tc.id, content: cleanJson.slice(0, 24000) })
    }

    defense.registerProgress(factsCount)
  }

  emit({ phase: 'done', reasoning: finalReasoning, answer: finalContent, cps: 0, tools: [...allTools], diffs: [...allDiffs] })
  return { content: finalContent, reasoning: finalReasoning, tools: allTools, diffs: allDiffs, usage: totalUsage, paused: false }
}
