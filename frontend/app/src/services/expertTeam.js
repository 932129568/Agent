/**
 * 多专家团队串行编排器（继承原 expert/orchestrator.js + mailbox.js + recovery.js 核心语义）：
 * - ExpertMailbox 记录成员间信件投递与消费状态；
 * - 支持中止生成 checkpoint（completedMembers + unconsumedMailbox），续跑时绝不重放已完成成员；
 * - 实时输出 timeline 事件流供 React UI 渲染。
 */
import { streamChatCompletion } from './modelTransport.js'
import { isAbort } from './errors.js'

export class ExpertMailbox {
  constructor(initialEvents = []) {
    this.events = Array.isArray(initialEvents) ? initialEvents.map((e) => ({ ...e })) : []
  }
  deliver({ runId, from, to, subject, body }) {
    const ev = {
      id: 'mb_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5),
      runId,
      from,
      to,
      subject: String(subject || '交接结论'),
      body: String(body || ''),
      consumed: false,
      at: Date.now(),
    }
    this.events.push(ev)
    return ev
  }
  consumeFor(memberName) {
    const hits = this.events.filter((e) => !e.consumed && (e.to === memberName || e.to === '*'))
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
  const runId = 'team_' + Date.now().toString(36)
  const mailbox = new ExpertMailbox(
    recovery && Array.isArray(recovery.unconsumedMailbox)
      ? recovery.unconsumedMailbox.map((ev) => ({ ...ev, runId }))
      : []
  )
  const completedMap = new Map()
  if (recovery && Array.isArray(recovery.completedMembers)) {
    for (const item of recovery.completedMembers) completedMap.set(item.name, item.result)
  }

  const timeline = []
  const emit = (type, label, detail = '') => {
    timeline.push({ id: `tl_${timeline.length}`, type, label, detail, at: Date.now() })
    if (typeof onUpdate === 'function') {
      onUpdate({
        runId,
        timeline: [...timeline],
        mailbox: [...mailbox.events],
        completedMembers: [...completedMap.entries()].map(([name, result]) => ({ name, result })),
      })
    }
  }

  emit('team_created', `团队启动：${lead.name} 领衔（${members.length} 名成员）`, recovery ? '从检查点断点恢复' : '全新编排')

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

  for (const member of members) {
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

    let resp
    try {
      resp = await streamChatCompletion({
        ...endpointConfig,
        signal,
        messages: [
          { role: 'system', content: `你是专家团队成员「${member.name}」。职责：${member.description || '提供专业分析与可执行产出'}。请给出结构化高密度结论。` },
          { role: 'user', content: `【团队目标】\n${goal}${inboxText}` },
        ],
      })
    } catch (err) {
      if (isAbort(err) || (signal && signal.aborted)) return buildPauseResult()
      throw err
    }
    const output = String(resp.content || '').trim()
    completedMap.set(member.name, output)
    mailbox.deliver({ runId, from: member.name, to: lead.name, subject: `${member.name} 产出`, body: output })
    emit('member_completed', `成员「${member.name}」完成并投递信箱`, output.slice(0, 120))
  }

  if (signal && signal.aborted) return buildPauseResult()

  // Lead 汇总全部信箱产出
  const allInbox = mailbox.consumeFor(lead.name)
  const summaryBody = [
    ...completedMap.entries().map(([name, res]) => `### 成员：${name}\n${res}`),
    ...allInbox.filter((e) => !completedMap.has(e.from)).map((e) => `### 信箱：${e.from}\n${e.body}`),
  ].join('\n\n')

  emit('lead_synthesizing', `主理专家「${lead.name}」正在汇总交付报告`)
  let leadResp
  try {
    leadResp = await streamChatCompletion({
      ...endpointConfig,
      signal,
      messages: [
        { role: 'system', content: `你是团队主理专家「${lead.name}」。请综合各专家成员的信箱产出，输出最终统一决策与执行清单。` },
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
