/**
 * 零双写 DAG 对话分支树 + 非破坏式回退/撤销（纯函数，可直接 L1 单测）。
 * - 活跃路径始终投影在 session.messages（兼容后端 SQLite / sessions.json）；
 * - 活跃节点在 session.tree.nodes 中仅存 msgIdx，非活跃兄弟分支存完整消息对象。
 */
function genNodeId() {
  return 'n_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6)
}

export function sanitizeMessagesForApi(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && !(m.role === 'system' && (m.__resumeDirective || m.__selfCheck)))
    .map((m) => {
      const clean = { role: m.role, content: m.content == null ? '' : m.content }
      if (m.tool_calls) clean.tool_calls = m.tool_calls
      if (m.tool_call_id) clean.tool_call_id = m.tool_call_id
      if (m.name) clean.name = m.name
      return clean
    })
}

export function ensureTree(session) {
  const s = { ...session, messages: Array.isArray(session.messages) ? session.messages.map((m) => ({ ...m })) : [] }
  if (s.tree && s.tree.nodes && s.tree.rootId) {
    s.tree = JSON.parse(JSON.stringify(s.tree))
    return s
  }
  const nodes = { root: { id: 'root', parentId: null, children: [], activeChildId: null } }
  let prev = 'root'
  s.messages.forEach((m, idx) => {
    const id = m._nodeId || genNodeId()
    m._nodeId = id
    nodes[id] = { id, parentId: prev, children: [], activeChildId: null, msgIdx: idx }
    nodes[prev].children.push(id)
    nodes[prev].activeChildId = id
    prev = id
  })
  s.tree = { rootId: 'root', activeLeafId: prev, nodes }
  return s
}

function freezeActive(s) {
  let cur = s.tree.nodes[s.tree.rootId]
  while (cur && cur.activeChildId && s.tree.nodes[cur.activeChildId]) {
    cur = s.tree.nodes[cur.activeChildId]
    if (typeof cur.msgIdx === 'number' && s.messages[cur.msgIdx]) {
      cur.msg = JSON.parse(JSON.stringify(s.messages[cur.msgIdx]))
      delete cur.msgIdx
    }
  }
}

function projectActive(s) {
  const out = []
  let cur = s.tree.nodes[s.tree.rootId]
  while (cur && cur.activeChildId && s.tree.nodes[cur.activeChildId]) {
    cur = s.tree.nodes[cur.activeChildId]
    if (cur.msg) {
      out.push(cur.msg)
      cur.msgIdx = out.length - 1
      delete cur.msg
    }
  }
  s.tree.activeLeafId = cur ? cur.id : s.tree.rootId
  s.messages = out
}

export function appendMessageToSession(session, msg) {
  const s = ensureTree(session)
  const id = msg._nodeId || genNodeId()
  const item = { ...msg, _nodeId: id }
  const parentId = s.tree.activeLeafId || s.tree.rootId
  const parent = s.tree.nodes[parentId] || s.tree.nodes[s.tree.rootId]
  const idx = s.messages.length
  s.messages.push(item)
  s.tree.nodes[id] = { id, parentId: parent.id, children: [], activeChildId: null, msgIdx: idx }
  parent.children.push(id)
  parent.activeChildId = id
  s.tree.activeLeafId = id
  s.updatedAt = Date.now()
  return s
}

export function forkFromMessage(session, targetIdx, newMessage) {
  const s = ensureTree(session)
  const target = s.messages[targetIdx]
  if (!target || !target._nodeId) return s
  const node = s.tree.nodes[target._nodeId]
  if (!node || !node.parentId) return s
  freezeActive(s)
  const parent = s.tree.nodes[node.parentId]
  const id = genNodeId()
  s.tree.nodes[id] = {
    id,
    parentId: parent.id,
    children: [],
    activeChildId: null,
    msg: { ...newMessage, _nodeId: id },
  }
  parent.children.push(id)
  parent.activeChildId = id
  projectActive(s)
  s.updatedAt = Date.now()
  return s
}

export function switchSibling(session, nodeId, delta) {
  const s = ensureTree(session)
  const node = s.tree.nodes[nodeId]
  if (!node || !node.parentId) return s
  const parent = s.tree.nodes[node.parentId]
  const nextIdx = parent.children.indexOf(nodeId) + (delta > 0 ? 1 : -1)
  if (nextIdx < 0 || nextIdx >= parent.children.length) return s
  freezeActive(s)
  parent.activeChildId = parent.children[nextIdx]
  projectActive(s)
  s.updatedAt = Date.now()
  return s
}

export function siblingMeta(session, nodeId) {
  const tree = session && session.tree
  const node = tree && tree.nodes && tree.nodes[nodeId]
  if (!node || !node.parentId) return null
  const parent = tree.nodes[node.parentId]
  if (!parent || !Array.isArray(parent.children) || parent.children.length <= 1) return null
  const idx = parent.children.indexOf(nodeId)
  return idx >= 0 ? { index: idx + 1, total: parent.children.length } : null
}

export function rewindWithSnapshot(session, keepCount) {
  const s = ensureTree(session)
  const cut = Math.max(0, Math.min(s.messages.length, Number(keepCount) || 0))
  const removed = s.messages.slice(cut)
  if (!removed.length) return s
  const snap = { count: removed.length, at: Date.now(), removed: JSON.parse(JSON.stringify(removed)) }
  const trimmed = s.messages.slice(0, cut)
  const next = { ...s, messages: trimmed, tree: null, _rewind: snap, updatedAt: Date.now() }
  return ensureTree(next)
}

export function undoRewind(session) {
  if (!session || !session._rewind || !Array.isArray(session._rewind.removed)) return session
  const merged = [...(session.messages || []), ...session._rewind.removed]
  const next = { ...session, messages: merged, tree: null, _rewind: null, updatedAt: Date.now() }
  return ensureTree(next)
}
