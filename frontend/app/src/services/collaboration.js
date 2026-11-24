/**
 * 双模型协同引擎（Cloud Planner + Local Worker + Cloud Reviewer）：
 * - 隐私分级脱敏（task_summary_only / selected_results_only / local_only）；
 * - 云端 Token 与费用预算硬护栏；
 * - 支持多轮评审与暂停恢复检查点。
 */
import { streamChatCompletion } from './modelTransport.js'
import { estTokens } from './compaction.js'

export const COLLABORATION_DEFAULTS = Object.freeze({
  enabled: true,
  local_first: true,
  cloud_token_budget: 24000,
  total_token_budget: 96000,
  cloud_cost_budget: 2.0,
  max_review_rounds: 2,
  upload_scope: 'task_summary_only', // 'task_summary_only' | 'selected_results_only' | 'local_only'
})

const SECRET_RE = /(?:sk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S+)/gi

export function redactForCloud(text, scope = 'task_summary_only') {
  const clean = String(text || '').replace(SECRET_RE, '[REDACTED_SECRET]')
  if (scope === 'local_only') return ''
  if (scope === 'task_summary_only') return clean.slice(0, 1200)
  return clean.slice(0, 4000)
}

export function normalizeCollaborationConfig(input = {}) {
  const merged = { ...COLLABORATION_DEFAULTS, ...(input || {}) }
  merged.cloud_token_budget = Math.min(30000, Math.max(6000, Number(merged.cloud_token_budget) || 24000))
  merged.total_token_budget = Math.max(merged.cloud_token_budget, Math.min(120000, Number(merged.total_token_budget) || 96000))
  merged.max_review_rounds = Math.min(2, Math.max(0, Number(merged.max_review_rounds) || 1))
  if (!['task_summary_only', 'selected_results_only', 'local_only'].includes(merged.upload_scope)) {
    merged.upload_scope = 'task_summary_only'
  }
  return merged
}

export async function runDualModelCollaboration({
  goal,
  config,
  cloudEndpoint,
  localEndpoint,
  signal = null,
  onEvent = null,
}) {
  const cfg = normalizeCollaborationConfig(config)
  const events = []
  let cloudTokens = 0
  let localTokens = 0
  const CLOUD_PRICE_PER_1K = 0.002
  const addUsageTokens = (resp, fallbackText) => {
    const real = Number(resp && resp.usage && resp.usage.total_tokens) || 0
    return real > 0 ? real : estTokens(fallbackText)
  }
  const budgetExhausted = () => (
    cloudTokens >= cfg.cloud_token_budget
    || (cloudTokens + localTokens) >= cfg.total_token_budget
    || ((cloudTokens / 1000) * CLOUD_PRICE_PER_1K) >= Number(cfg.cloud_cost_budget || 2.0)
  )

  const emit = (phase, actor, content) => {
    const ev = { id: `ce_${events.length}`, phase, actor, content, cloudTokens, localTokens, at: Date.now() }
    events.push(ev)
    if (typeof onEvent === 'function') onEvent({ events: [...events], cloudTokens, localTokens, phase })
  }

  if (cfg.upload_scope === 'local_only') {
    emit('worker', '本地执行模型', '隐私策略为 local_only，跳过云端规划，全部由本地模型独立完成。')
    const r = await streamChatCompletion({
      ...localEndpoint,
      signal,
      messages: [
        { role: 'system', content: '你是本地独立执行助手，请在纯离线前提下完整回答用户需求。' },
        { role: 'user', content: goal },
      ],
    })
    localTokens += estTokens(goal) + estTokens(r.content)
    emit('done', '本地执行模型', r.content)
    return { status: 'completed', events, finalAnswer: r.content, cloudTokens, localTokens }
  }

  // 阶段 1：Cloud Planner 出架构方案
  const safeGoal = redactForCloud(goal, cfg.upload_scope)
  emit('planning', '云端规划模型 (Planner)', '正在制定执行步骤与验收标准…')
  const planRes = await streamChatCompletion({
    ...cloudEndpoint,
    signal,
    messages: [
      { role: 'system', content: '你是云端高级架构师 Planner。请用简洁清晰的步骤清单拆解任务，供本地执行模型落地。' },
      { role: 'user', content: safeGoal },
    ],
  })
  cloudTokens += addUsageTokens(planRes, safeGoal + '\n' + (planRes.content || ''))
  emit('plan_ready', '云端规划模型 (Planner)', planRes.content)

  // 阶段 2：Local Worker 按方案落地
  let currentDraft = ''
  for (let round = 0; round <= cfg.max_review_rounds; round++) {
    if (signal && signal.aborted) return { status: 'paused', events, finalAnswer: currentDraft, cloudTokens, localTokens }

    const workerPrompt = round === 0
      ? `【任务】\n${goal}\n\n【云端规划方案】\n${planRes.content}\n\n请按方案完整输出实现内容。`
      : `请根据云端 Reviewer 的评审意见修订下方草稿：\n\n【上轮草稿】\n${currentDraft}\n\n【评审意见】\n${events[events.length - 1].content}`

    emit('working', `本地执行模型 (Worker · 第 ${round + 1} 轮)`, '正在本地生成实现…')
    const workRes = await streamChatCompletion({
      ...localEndpoint,
      signal,
      messages: [
        { role: 'system', content: '你是本地执行工程师 Worker，请严格依据规划与评审意见产出高质量实现。' },
        { role: 'user', content: workerPrompt },
      ],
    })
    currentDraft = workRes.content
    localTokens += addUsageTokens(workRes, workerPrompt + '\n' + currentDraft)
    emit('draft_ready', `本地执行模型 (Worker · 第 ${round + 1} 轮)`, currentDraft)

    if (round >= cfg.max_review_rounds || budgetExhausted()) break

    // 阶段 3：Cloud Reviewer 评审（仅上传脱敏摘要）
    const reviewInput = redactForCloud(`目标：${safeGoal}\n\n待审草稿：\n${currentDraft}`, cfg.upload_scope)
    emit('reviewing', `云端评审模型 (Reviewer · 第 ${round + 1} 轮)`, '正在审查边界缺陷与遗漏…')
    const revRes = await streamChatCompletion({
      ...cloudEndpoint,
      signal,
      messages: [
        { role: 'system', content: '你是严苛的云端代码与方案评审员。若已完全达标请在首行写「APPROVED」；否则列出 1–3 条精确缺陷供本地模型修订。' },
        { role: 'user', content: reviewInput },
      ],
    })
    cloudTokens += addUsageTokens(revRes, reviewInput + '\n' + (revRes.content || ''))
    emit('review_done', `云端评审模型 (Reviewer · 第 ${round + 1} 轮)`, revRes.content)
    if (/^\s*APPROVED\b/i.test(revRes.content)) break
  }

  emit('done', '双模型协同', '协同闭环完成')
  return { status: 'completed', events, finalAnswer: currentDraft, cloudTokens, localTokens }
}
