/**
 * 多专家团队串行编排器（R24 加固：防 {en, zh} 对象直渲染崩溃 + 6 套一键梦之队预设 + 完整专家方法论注入）：
 * - ExpertMailbox 记录成员间信件投递与消费状态；
 * - 支持中止生成 checkpoint（completedMembers + unconsumedMailbox），续跑时绝不重放已完成成员；
 * - 实时输出 timeline 事件流供 React UI 渲染。
 */
import { streamChatCompletion } from './modelTransport.js'
import { isAbort } from './errors.js'

/** 安全提取专家名称/简介（兼容 string 与 { zh, en } 多语言对象，彻底杜绝 React Error #31） */
export function safeExpertText(val, fallback = '') {
  if (val == null) return String(fallback || '')
  if (typeof val === 'string') return val.trim() || String(fallback || '')
  if (typeof val === 'number' || typeof val === 'boolean') return String(val)
  if (typeof val === 'object') {
    const picked = val.zh || val['zh-CN'] || val.en || val.label || val.name || ''
    if (typeof picked === 'string' && picked.trim()) return picked.trim()
  }
  return String(fallback || '')
}

export const DREAM_TEAM_PRESETS = Object.freeze([
  {
    id: 'team_fullstack_ship',
    name: '🚀 全栈上线攻坚队',
    badge: '研发推荐',
    memberIds: ['superpowers-tdd-architect', 'frontend-ui-craft', 'security-code-auditor', 'browser-workflow-operator'],
    defaultGoal: '对当前项目进行全栈架构评审、关键代码安全排雷、UI 体验优化与 E2E 验收测试方案设计',
  },
  {
    id: 'team_video_drama',
    name: '🎬 爆款短剧与视频工坊',
    badge: '创意爆款',
    memberIds: ['short-drama-screenwriter', 'video-director-remotion', 'brand-poster-visual-director'],
    defaultGoal: '创作一部 60 秒高反转科技主题短片：包含冲突剧本、逐秒分镜脚本与主视觉海报提示词',
  },
  {
    id: 'team_growth_commerce',
    name: '📈 增长操盘与电商爆单组',
    badge: '商业变现',
    memberIds: ['product-strategy-pm', 'ecommerce-live-growth', 'xiaohongshu-douyin-viral'],
    defaultGoal: '为一款新产品制定完整冷启动增长方案：含核心卖点定位、小红书爆文矩阵与直播间成交话术',
  },
  {
    id: 'team_ai_infra',
    name: '🧠 AI Agent 与高可用架构团',
    badge: '2026 前沿',
    memberIds: ['ai-agent-prompt-architect', 'cloud-devops-sre', 'database-dba-tuner'],
    defaultGoal: '设计一套生产级企业 AI Agent 系统：含 RAG 检索架构、高并发数据库索引与低成本容器部署方案',
  },
  {
    id: 'team_biz_legal',
    name: '💼 融资 BP 与商业法务护航团',
    badge: '老板必备',
    memberIds: ['startup-bp-strategy-ceo', 'finance-contract-advisor', 'legal-ip-compliance-cn'],
    defaultGoal: '打造一份投资人级商业计划书核心叙事，附 12 个月现金流盈亏平衡模型与软件合规发布清单',
  },
  {
    id: 'team_research_paper',
    name: '📚 顶会科研与深度研报组',
    badge: '深度分析',
    memberIds: ['deep-research-analyst', 'academic-paper-mentor', 'data-sql-bi-scientist'],
    defaultGoal: '围绕指定前沿主题输出 MECE 结构化深度行业研报，附数据可视化指标体系与学术级严谨表述',
  },
])

export class ExpertMailbox {
  constructor(initialEvents = []) {
    this.events = Array.isArray(initialEvents) ? initialEvents.map((e) => ({ ...e })) : []
  }
  deliver({ runId, from, to, subject, body }) {
    const ev = {
      id: 'mb_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5),
      runId,
      from: safeExpertText(from, '专家'),
      to: safeExpertText(to, '主理专家'),
      subject: safeExpertText(subject, '交接结论'),
      body: String(body || ''),
      consumed: false,
      at: Date.now(),
    }
    this.events.push(ev)
    return ev
  }
  consumeFor(memberName) {
    const key = safeExpertText(memberName)
    const hits = this.events.filter((e) => !e.consumed && (e.to === key || e.to === '*'))
    hits.forEach((e) => { e.consumed = true })
    return hits
  }
  unconsumed() {
    return this.events.filter((e) => !e.consumed).map((e) => ({ ...e }))
  }
}

export async function runExpertTeam({
  goal,
  lead,
  members = [],
  endpointConfig,
  recovery = null,
  signal = null,
  onUpdate = null,
}) {
  const safeLead = {
    id: (lead && lead.id) || 'lead',
    name: safeExpertText(lead && lead.name, '主理专家'),
    description: safeExpertText(lead && lead.description, ''),
    prompt: safeExpertText(lead && lead.prompt, ''),
  }
  const safeMembers = (Array.isArray(members) ? members : []).map((m, idx) => ({
    id: (m && m.id) || `m_${idx}`,
    name: safeExpertText(m && m.name, `专家 #${idx + 1}`),
    description: safeExpertText(m && m.description, ''),
    prompt: safeExpertText(m && m.prompt, ''),
  }))

  const runId = 'team_' + Date.now().toString(36)
  const mailbox = new ExpertMailbox(
    recovery && Array.isArray(recovery.unconsumedMailbox)
      ? recovery.unconsumedMailbox.map((ev) => ({ ...ev, runId }))
      : []
  )
  const completedMap = new Map()
  if (recovery && Array.isArray(recovery.completedMembers)) {
    for (const item of recovery.completedMembers) {
      completedMap.set(safeExpertText(item.name), item.result)
    }
  }

  const timeline = []
  const emit = (type, label, detail = '') => {
    timeline.push({ id: `tl_${timeline.length}`, type, label: safeExpertText(label), detail: safeExpertText(detail), at: Date.now() })
    if (typeof onUpdate === 'function') {
      onUpdate({
        runId,
        timeline: [...timeline],
        mailbox: [...mailbox.events],
        completedMembers: [...completedMap.entries()].map(([name, result]) => ({ name, result })),
      })
    }
  }

  emit('team_created', `团队启动：${safeLead.name} 领衔（${safeMembers.length} 名协同成员）`, recovery ? '从检查点断点恢复' : '全新串行信箱编排')

  const buildPauseResult = () => {
    const checkpoint = {
      runId,
      goal,
      completedMembers: [...completedMap.entries()].map(([name, result]) => ({ name, result })),
      unconsumedMailbox: mailbox.unconsumed(),
    }
    emit('team_paused', '团队编排已暂停（已保存断点恢复检查点）')
    return { status: 'paused', runId, timeline, mailbox: mailbox.events, checkpoint, finalReport: '' }
  }

  for (const member of safeMembers) {
    if (signal && signal.aborted) return buildPauseResult()

    if (completedMap.has(member.name)) {
      emit('member_skipped', `跳过已完成成员：${member.name}`, '断点恢复防重放')
      continue
    }

    const inbox = mailbox.consumeFor(member.name)
    emit('member_started', `成员「${member.name}」开始执行`, member.description || '')

    const inboxText = inbox.length
      ? '\n\n【收到前序成员信箱交接】\n' + inbox.map((m) => `来自 ${m.from}（${m.subject}）：\n${m.body}`).join('\n---\n')
      : ''

    const sysPersona = member.prompt
      ? `${member.prompt}\n\n当前你在多专家团队中担任成员「${member.name}」，请输出结构化高密度专业产出，便于主理专家汇总。`
      : `你是专家团队成员「${member.name}」。职责：${member.description || '提供专业分析与可执行产出'}。请给出结构化高密度结论。`

    let resp
    try {
      resp = await streamChatCompletion({
        ...endpointConfig,
        signal,
        messages: [
          { role: 'system', content: sysPersona },
          { role: 'user', content: `【团队目标】\n${goal}${inboxText}` },
        ],
      })
    } catch (err) {
      if (isAbort(err) || (signal && signal.aborted)) return buildPauseResult()
      throw err
    }
    const output = String(resp.content || '').trim()
    completedMap.set(member.name, output)
    mailbox.deliver({ runId, from: member.name, to: safeLead.name, subject: `${member.name} 产出`, body: output })
    emit('member_completed', `成员「${member.name}」完成并投递信箱`, output.slice(0, 140))
  }

  if (signal && signal.aborted) return buildPauseResult()

  const allInbox = mailbox.consumeFor(safeLead.name)
  const summaryBody = [
    ...completedMap.entries().map(([name, res]) => `### 成员：${name}\n${res}`),
    ...allInbox.filter((e) => !completedMap.has(e.from)).map((e) => `### 信箱：${e.from}\n${e.body}`),
  ].join('\n\n')

  emit('lead_synthesizing', `主理专家「${safeLead.name}」正在综合信箱并撰写交付报告`)
  const leadSys = safeLead.prompt
    ? `${safeLead.prompt}\n\n你是本次团队主理专家「${safeLead.name}」。请综合各专家成员的信箱产出，去重对齐矛盾点，输出最终统一决策与分步执行清单。`
    : `你是团队主理专家「${safeLead.name}」。请综合各专家成员的信箱产出，输出最终统一决策与执行清单。`

  let leadResp
  try {
    leadResp = await streamChatCompletion({
      ...endpointConfig,
      signal,
      messages: [
        { role: 'system', content: leadSys },
        { role: 'user', content: `【总目标】\n${goal}\n\n【各成员产出】\n${summaryBody}` },
      ],
    })
  } catch (err) {
    if (isAbort(err) || (signal && signal.aborted)) return buildPauseResult()
    throw err
  }
  const finalReport = String(leadResp.content || '').trim()
  emit('team_finished', `团队编排完成（共 ${completedMap.size} 位成员交付）`)

  return {
    status: 'completed',
    runId,
    timeline,
    mailbox: mailbox.events,
    checkpoint: null,
    finalReport,
  }
}
