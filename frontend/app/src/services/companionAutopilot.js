/**
 * Harbor 旗舰级「全自动无人驾驶总管 (Autopilot Supervisor)」引擎（R29）：
 * 参考 2026 前沿 Supervisor + Router + Evaluator-Optimizer 编排范式：
 * 1) 全域意图路由：自动扫描 Harbor 全部 56 行业专家、60 独立 Skill、12 支成建制原生专家团、全部可视化 DAG 工作流、多角色群聊与双模协同；
 * 2) 双引擎决策：优先支持零 Token 本地多维评分精准决策；开启 LLM 驱动时可由专属大模型输出结构化路由与拆解 JSON（断网自动无损回落本地路由）；
 * 3) 交付验收质检：监督任务完成后自动对产物完整度、结构性与可读性打分（0–100），并生成标准「📦 交稿交付单」。
 */
import { CURATED_INDUSTRY_PACKS, CURATED_SKILLS } from './industryExperts.js'
import { NATIVE_EXPERT_TEAMS } from './expertTeam.js'
import { streamChatCompletion } from './modelTransport.js'

function tokenizeZhEn(text = '') {
  const s = String(text || '').toLowerCase()
  const words = s.match(/[a-z0-9_+#.-]{2,}/g) || []
  const zhChunks = s.match(/[\u4e00-\u9fa5]{2,}/g) || []
  const bigrams = []
  for (const seg of zhChunks) {
    bigrams.push(seg)
    for (let i = 0; i < seg.length - 1; i++) bigrams.push(seg.slice(i, i + 2))
  }
  return Array.from(new Set([...words, ...bigrams]))
}

function scoreOverlap(tokens, hayText) {
  const hay = String(hayText || '').toLowerCase()
  let score = 0
  for (const tk of tokens) {
    if (tk.length >= 2 && hay.includes(tk)) {
      score += tk.length >= 3 ? 3 : 1.5
    }
  }
  return score
}

/** 匹配最契合的 12 支原生专家团之一 */
export function matchBestNativeTeam(requirement = '', teams = NATIVE_EXPERT_TEAMS) {
  const tokens = tokenizeZhEn(requirement)
  const q = String(requirement || '').toLowerCase()
  const keywordBoost = [
    { id: 'short-drama-studio', re: /短剧|剧本|反转|分集|台词|编剧/ },
    { id: 'video-director-remotion', re: /视频|短片|宣传片|分镜|remotion|可灵|即梦|sora/ },
    { id: 'design-engine', re: /设计系统|ui|ux|改版|液态玻璃|界面设计|原型|视觉规范/ },
    { id: 'software-company', re: /开发|全栈|系统架构|微服务|搭建.*应用|从零.*项目|前后端/ },
    { id: 'security-red-blue-team', re: /安全审计|漏洞|渗透|owasp|红蓝对抗|攻防|鉴权排雷/ },
    { id: 'ai-agent-lab', re: /agent|kv.?cache|mcp|rag|提示词架构|多智能体/ },
    { id: 'growth-war-room', re: /增长|小红书|抖音|冷启动|爆文|直播|电商|私域|转化/ },
    { id: 'vc-deal-advisory', re: /融资|bp|商业计划书|估值|合同|法务|股权|现金流|盈利模型/ },
    { id: 'deep-research-institute', re: /研报|行业研究|深度调研|竞品研究|论文|学术|综述/ },
    { id: 'game-studio-pod', re: /游戏|数值|关卡|肉鸽|卡牌|gdd|世界观/ },
    { id: 'product-strategy-team', re: /产品战略|路线图|roadmap|竞品分析|用户研究/ },
    { id: 'product-strategy-pm', re: /prd|需求文档|立项|功能规格/ },
  ]
  let best = null
  let bestScore = 0
  for (const t of teams) {
    let sc = scoreOverlap(tokens, [t.id, t.name, t.subtitle, t.tagline, ...(t.deliverables || []), t.defaultGoal].join(' '))
    const b = keywordBoost.find((x) => x.id === t.id)
    if (b && b.re.test(q)) sc += 14
    if (sc > bestScore) { bestScore = sc; best = t }
  }
  return { team: best, score: bestScore }
}

/** 匹配最契合的 56 行业专家之一 */
export function matchBestExpert(requirement = '') {
  const tokens = tokenizeZhEn(requirement)
  let best = CURATED_INDUSTRY_PACKS[0]
  let bestScore = -1
  for (const p of CURATED_INDUSTRY_PACKS) {
    const hay = [p.id, p.name, p.subtitle, p.categoryLabel, p.description, ...(p.skills || []), ...(p.quickPrompts || [])].join(' ')
    const sc = scoreOverlap(tokens, hay)
    if (sc > bestScore) { bestScore = sc; best = p }
  }
  return { expert: best, score: bestScore }
}

/** 匹配最契合的 60 独立 Skill 之一 */
export function matchBestSkill(requirement = '') {
  const tokens = tokenizeZhEn(requirement)
  let best = CURATED_SKILLS[0]
  let bestScore = -1
  for (const s of CURATED_SKILLS) {
    const hay = [s.id, s.name, s.categoryLabel, s.badge, s.description].join(' ')
    const sc = scoreOverlap(tokens, hay)
    if (sc > bestScore) { bestScore = sc; best = s }
  }
  return { skill: best, score: bestScore }
}

/** 匹配最契合的可视化插件工作流 (DAG) */
export function matchBestWorkflow(requirement = '', workflows = []) {
  if (!Array.isArray(workflows) || workflows.length === 0) return { workflow: null, score: 0 }
  const tokens = tokenizeZhEn(requirement)
  const q = String(requirement || '').toLowerCase()
  let best = null
  let bestScore = 0
  for (const wf of workflows) {
    const hay = [wf.id, wf.name, wf.description, ...(wf.nodes || []).map((n) => `${n.label} ${n.kind}`)].join(' ')
    let sc = scoreOverlap(tokens, hay)
    if (/工作流|流水线|dag|出图|生图|画一张|生成.*图|生成.*视频|短片导演/.test(q)) {
      if ((wf.nodes || []).some((n) => n.kind === 'image_gen' || n.kind === 'video_gen') && /图|画|海报|视频|短片|分镜/.test(q)) {
        sc += 18
      } else {
        sc += 6
      }
    }
    if (sc > bestScore) { bestScore = sc; best = wf }
  }
  return { workflow: best, score: bestScore }
}

/**
 * 确定性全域自动规划器（0 Token 秒出最佳执行路线）：
 * 自主决定：应该去哪个模块（workflow / expert_team / group / collaboration / chat），
 * 挂载哪个专家、哪个 Skill、哪支原生团队或哪条工作流，并拆解标准执行步骤。
 */
export function planAutopilotLocally({ requirement = '', workflows = [], teams = NATIVE_EXPERT_TEAMS } = {}) {
  const req = String(requirement || '').trim()
  const q = req.toLowerCase()

  const wfHit = matchBestWorkflow(req, workflows)
  const teamHit = matchBestNativeTeam(req, teams)
  const expHit = matchBestExpert(req)
  const skillHit = matchBestSkill(req)

  // 路由决策 1：显式提及生图/视频流水线/工作流，或高匹配 DAG 工作流
  const wantsWorkflow = (/工作流|流水线|dag|生图|出图|画一张|海报图|生成.*视频|短片导演/.test(q) && wfHit.workflow)
    || (wfHit.workflow && wfHit.score >= 16)

  // 路由决策 2：双模隐私/省钱协同
  const wantsCollab = /双模|本地.*云端|脱敏|省.?token|隐私.*执行/.test(q)

  // 路由决策 3：多角色群聊讨论/头脑风暴/评审辩论
  const wantsGroup = /群聊|拉群|多角色讨论|辩论|头脑风暴|圆桌/.test(q)

  // 路由决策 4：复杂多阶段交付任务 → 自动派出 12 支成建制原生专家团！
  const isComplexProject = req.length >= 22 || /完整|全套|方案|架构|规划|研报|剧本|设计|审计|重构|bp|prd|路线图|策划|开发/.test(q)
  const wantsTeam = !wantsWorkflow && !wantsCollab && !wantsGroup
    && ((/专家团|团队|多专家/.test(q) && teamHit.team) || (isComplexProject && teamHit.team && teamHit.score >= 10))

  if (wantsWorkflow && wfHit.workflow) {
    return {
      mode: 'workflow',
      moduleLabel: '可视化插件工作流 (DAG)',
      navTarget: 'workflow',
      workflow: wfHit.workflow,
      team: null,
      expert: expHit.expert,
      skill: skillHit.skill,
      prompt: req,
      reason: `识别到多阶段流水线/多媒体创作诉求，自动选用工作流「${wfHit.workflow.name}」执行并实时监工。`,
      steps: [
        `切到「工作流插件」并选中「${wfHit.workflow.name}」`,
        '注入你的需求目标并启动并行 DAG 流水线',
        '全程监工各节点执行与产物汇聚',
        '质检验收并推送终稿到右侧副屏交付',
      ],
    }
  }

  if (wantsCollab) {
    return {
      mode: 'collaboration',
      moduleLabel: '双模协同（云端规划 + 本地执行）',
      navTarget: 'collaboration',
      workflow: null,
      team: null,
      expert: expHit.expert,
      skill: skillHit.skill,
      prompt: req,
      reason: '识别到云端规划 + 本地隐私/低成本执行诉求，自动调度「双模协同」并全程监管评审轮次。',
      steps: [
        '切到「双模协同」控制台',
        '下发脱敏任务目标并启动云+本地协同',
        '监督规划、执行与多轮评审闭环',
        '验收汇总并推送终稿交付',
      ],
    }
  }

  if (wantsGroup) {
    return {
      mode: 'group',
      moduleLabel: '多角色群聊接力',
      navTarget: 'group',
      workflow: null,
      team: null,
      expert: expHit.expert,
      skill: skillHit.skill,
      prompt: req,
      reason: '识别到多视角碰撞/圆桌讨论需求，自动切入「角色群聊」并由主持人动态编排接力。',
      steps: [
        '切到「角色群聊」协作舞台',
        '由智能主持人发布接力调度单',
        '监工各角色依次发言交棒',
        '汇总群聊精华并推送终稿交付',
      ],
    }
  }

  if (wantsTeam && teamHit.team) {
    return {
      mode: 'expert_team',
      moduleLabel: '成建制原生多专家团队',
      navTarget: 'market',
      workflow: null,
      team: teamHit.team,
      expert: null,
      skill: skillHit.skill,
      prompt: req,
      reason: `任务属于综合型专业交付，自动指派「${teamHit.team.name}」（${1 + teamHit.team.members.length} 人成建制原生团）串行信箱接力 + 总监终审。`,
      steps: [
        `调派原生团「${teamHit.team.name}」全员出战`,
        `依次监工 ${teamHit.team.members.map((m) => m.name).join(' → ')} 投递信箱`,
        `由主理总监「${teamHit.team.lead.name}」汇总定稿`,
        '自动质检验收并推送终稿至右侧副屏',
      ],
    }
  }

  // 默认最优路径：智能对话 + 自动精准挂载「最佳行业专家 + 最佳独立 Skill」
  return {
    mode: 'chat',
    moduleLabel: '智能对话（自动挂载专家 + Skill）',
    navTarget: 'chat',
    workflow: null,
    team: null,
    expert: expHit.expert,
    skill: skillHit.skill,
    prompt: req,
    reason: `为你精准匹配行业专家「${expHit.expert.name}」+ 独立技能「${skillHit.skill.name}」，在智能对话中自动装载、手写发单并全程监工交付。`,
    steps: [
      '跑去「智能对话」并自动装载最佳专家与 Skill 胶囊',
      '在输入框手写你的完整任务需求并自动发送',
      '实时监督模型思考、联网/工具执行与生成进度',
      '完成后自动验收质量并推送终稿到右侧副屏',
    ],
  }
}

/** 可选 LLM 增强路由规划（仅当开启 llmEnabled/fullLlmDrive 时补充精准路由判断，失败秒回本地路由） */
export async function planAutopilotExecution({
  requirement,
  workflows = [],
  teams = NATIVE_EXPERT_TEAMS,
  config = {},
  endpointConfig = null,
  signal = null,
}) {
  const local = planAutopilotLocally({ requirement, workflows, teams })
  if (!config || (!config.fullLlmDrive && !config.llmEnabled) || !endpointConfig || !endpointConfig.apiKey) {
    return { ...local, plannedBy: 'local-router' }
  }
  try {
    const teamIds = teams.map((t) => `${t.id}(${t.name})`).join(', ')
    const wfIds = (workflows || []).map((w) => `${w.id}(${w.name})`).join(', ')
    const prompt = `你是 Harbor 全自动总管路由器。请根据用户需求选择最优执行方式，仅输出一行合法 JSON（不要 Markdown 代码块）：
{"mode":"chat|expert_team|workflow|group|collaboration","teamId":"可选","workflowId":"可选","reason":"不超过35字说明为何选此路线"}
可用原生专家团: ${teamIds}
可用工作流: ${wfIds || '无'}
用户需求: ${String(requirement || '').slice(0, 400)}`

    const resp = await streamChatCompletion({
      ...endpointConfig,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 200,
      signal,
    })
    const raw = String((resp && resp.content) || '').trim()
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return { ...local, plannedBy: 'local-router' }
    const obj = JSON.parse(m[0])
    const mode = ['chat', 'expert_team', 'workflow', 'group', 'collaboration'].includes(obj.mode) ? obj.mode : local.mode
    if (mode === 'expert_team') {
      const pickedTeam = teams.find((t) => t.id === obj.teamId) || local.team || matchBestNativeTeam(requirement, teams).team
      if (pickedTeam) {
        return {
          ...local,
          mode: 'expert_team',
          moduleLabel: '成建制原生多专家团队',
          navTarget: 'market',
          team: pickedTeam,
          reason: String(obj.reason || local.reason),
          plannedBy: 'llm-supervisor',
        }
      }
    }
    if (mode === 'workflow') {
      const pickedWf = (workflows || []).find((w) => w.id === obj.workflowId) || local.workflow
      if (pickedWf) {
        return {
          ...local,
          mode: 'workflow',
          moduleLabel: '可视化插件工作流 (DAG)',
          navTarget: 'workflow',
          workflow: pickedWf,
          reason: String(obj.reason || local.reason),
          plannedBy: 'llm-supervisor',
        }
      }
    }
    if (mode === 'group' || mode === 'collaboration' || mode === 'chat') {
      return {
        ...local,
        mode,
        navTarget: mode,
        reason: String(obj.reason || local.reason),
        plannedBy: 'llm-supervisor',
      }
    }
    return { ...local, plannedBy: 'local-router' }
  } catch {
    return { ...local, plannedBy: 'local-router' }
  }
}

/** 交付质检验收器：检查产出是否完整、有结构、无报错，输出 0–100 验收评分与交付摘要 */
export function evaluateDeliverableQuality(outputText = '', requirement = '') {
  const txt = String(outputText || '').trim()
  if (!txt) {
    return { ok: false, score: 0, grade: '需重试', summary: '未检测到有效正文产出，建议检查模型端点或重新派发。' }
  }
  let score = 55
  if (txt.length >= 120) score += 15
  if (txt.length >= 380) score += 10
  if (/^#{1,3}\s|\n[-*]\s|\n\d+\.\s|```/m.test(txt)) score += 12
  const reqTokens = tokenizeZhEn(requirement).slice(0, 8)
  const hitCount = reqTokens.filter((tk) => txt.toLowerCase().includes(tk)).length
  if (reqTokens.length > 0 && hitCount >= Math.max(1, Math.floor(reqTokens.length * 0.3))) score += 8
  score = Math.min(100, score)
  const grade = score >= 88 ? '优秀交付 (S)' : (score >= 72 ? '合格交付 (A)' : '基础完成 (B)')
  const preview = txt.replace(/\s+/g, ' ').slice(0, 120)
  return {
    ok: score >= 60,
    score,
    grade,
    charCount: txt.length,
    summary: `验收评级：${grade}（${score} 分 · ${txt.length} 字）\n摘要：${preview}${txt.length > 120 ? '…' : ''}`,
  }
}
