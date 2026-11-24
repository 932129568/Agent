/**
 * 会话与群聊纪要一键导出格式化器（R15 实用功能 · 纯函数，可直接 L1 单测）。
 */

function fmtTime(ts) {
  try { return new Date(ts || Date.now()).toLocaleString('zh-CN', { hour12: false }) } catch { return '' }
}

export function safeExportFilename(title, suffix = '.md') {
  const base = String(title || 'harbor-session')
    .trim()
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 42) || 'harbor-session'
  return `${base}${suffix}`
}

export function formatSessionAsMarkdown(session) {
  if (!session) return ''
  const isProj = session.kind === 'project' && session.workspaceDir
  const lines = [
    `# ${session.title || 'Harbor 会话记录'}`,
    '',
    `- **会话类型**：${isProj ? '项目会话' : '普通会话'}`,
    ...(isProj ? [`- **绑定工作目录**：\`${session.workspaceDir}\``] : []),
    `- **导出时间**：${fmtTime(Date.now())}`,
    `- **消息总数**：${(session.messages || []).length} 条`,
    '',
    '---',
    '',
  ]
  for (const m of (session.messages || [])) {
    if (!m) continue
    const roleLabel = m.role === 'user' ? '👤 我' : '✦ Harbor 助手'
    lines.push(`## ${roleLabel}`, '')
    if (m.reasoning) {
      lines.push('<details><summary>深度思考过程</summary>', '', '```text', String(m.reasoning).trim(), '```', '', '</details>', '')
    }
    lines.push(String(m.content || '').trim(), '', '---', '')
  }
  return lines.join('\n')
}

export function formatGroupAsMarkdown(group) {
  if (!group) return ''
  const members = Array.isArray(group.members) ? group.members.map((m) => m.name).join('、') : ''
  const lines = [
    `# 群聊纪要：${group.title || '多角色群聊'}`,
    '',
    `- **群聊 ID**：\`${group.activeGroupId || group.id || ''}\``,
    `- **参与名册**：${members || '默认班底'}`,
    `- **导出时间**：${fmtTime(Date.now())}`,
    '',
    '---',
    '',
  ]
  for (const m of (group.messages || [])) {
    if (!m) continue
    const title = m.role === 'user' ? '👤 我（发起人）' : `✦ ${m.author || '角色'}${m.model ? ` (\`${m.model}\`)` : ''}`
    lines.push(`## ${title}`, '', String(m.content || '').trim(), '', '---', '')
  }
  return lines.join('\n')
}
