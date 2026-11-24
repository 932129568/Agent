/**
 * 多群聊严格隔离状态模型（纯函数，可直接 L1 单元测试）：
 * - 每个群聊拥有全局唯一不可复用的 id（grp_<ts>_<rand>），对应磁盘上独立的群文件目录；
 * - 绝不共用 'grp_default' 硬编码单槽，确保新建群聊 0 历史、0 群文件、0 跨群串味；
 * - 删除群聊时彻底移出列表，若无剩余群聊自动生成全新唯一 id 的空白群聊。
 */
import { GROUP_ROSTER_PRESETS, normalizeGroupMember } from './capabilityRouter.js'

export function genGroupId() {
  return 'grp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7)
}

export function createIsolatedGroup({ title = '新群聊', members = null, routingMode = 'smart' } = {}) {
  const now = Date.now()
  const baseMembers = Array.isArray(members) && members.length > 0
    ? members.map((m, i) => normalizeGroupMember(m, i))
    : GROUP_ROSTER_PRESETS.engineering.members.map((m, i) => normalizeGroupMember(m, i))
  return {
    id: genGroupId(),
    title: String(title || '新群聊').trim() || '新群聊',
    createdAt: now,
    updatedAt: now,
    routingMode: routingMode === 'all' ? 'all' : 'smart',
    members: baseMembers,
    messages: [],
    relayWireHistory: [],
    lastArchivedName: '',
  }
}

export function normalizeGroupRecord(raw, index = 0) {
  const g = raw && typeof raw === 'object' ? raw : {}
  const now = Date.now()
  const members = Array.isArray(g.members) && g.members.length > 0
    ? g.members.map((m, i) => normalizeGroupMember(m, i))
    : GROUP_ROSTER_PRESETS.engineering.members.map((m, i) => normalizeGroupMember(m, i))
  return {
    id: String(g.id || genGroupId()),
    title: String(g.title || `群聊 ${index + 1}`).trim() || `群聊 ${index + 1}`,
    createdAt: Number(g.createdAt) || now,
    updatedAt: Number(g.updatedAt) || now,
    routingMode: g.routingMode === 'all' ? 'all' : 'smart',
    members,
    messages: Array.isArray(g.messages) ? g.messages : [],
    relayWireHistory: Array.isArray(g.relayWireHistory) ? g.relayWireHistory : [],
    lastArchivedName: String(g.lastArchivedName || ''),
  }
}

export function hydrateGroupCollection(rawJson, legacyMembers = null) {
  try {
    if (rawJson) {
      const parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson
      if (parsed && Array.isArray(parsed.items) && parsed.items.length > 0) {
        const items = parsed.items.map((g, i) => normalizeGroupRecord(g, i))
        const activeId = items.some((x) => x.id === parsed.activeGroupId) ? parsed.activeGroupId : items[0].id
        return { activeGroupId: activeId, items }
      }
    }
  } catch {}
  const first = createIsolatedGroup({
    title: '新群聊 1',
    members: Array.isArray(legacyMembers) && legacyMembers.length ? legacyMembers : null,
  })
  return { activeGroupId: first.id, items: [first] }
}

export function removeGroupFromCollection(items, activeGroupId, targetId, fallbackMembers = null) {
  const rest = (Array.isArray(items) ? items : []).filter((g) => g && g.id !== targetId)
  if (rest.length === 0) {
    const fresh = createIsolatedGroup({ title: '新群聊', members: fallbackMembers })
    return { items: [fresh], activeGroupId: fresh.id, createdReplacement: true }
  }
  const nextActive = activeGroupId === targetId ? rest[0].id : activeGroupId
  return { items: rest, activeGroupId: nextActive, createdReplacement: false }
}

/** 剥离系统提示词中的全局长期记忆段，防止已删除会话/其他群聊的记忆泄漏到独立群聊中 */
export function stripGlobalMemoryForIsolatedGroup(systemPrompt = '') {
  const src = String(systemPrompt || '')
  return src
    .replace(/\n*用户长期记忆（仅作偏好与约束参考）：[\s\S]*?(?=\n\n(?:【|可用工具目录|工作区规范)|$)/g, '')
    .replace(/\n*【长期记忆·扩展】[\s\S]*?(?=\n\n(?:可用工具目录|工作区规范)|$)/g, '')
    .trim()
}
