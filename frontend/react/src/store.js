/**
 * 岛层状态（框架无关的最小外部存储）。
 *
 * 用 React 18+ 的 `useSyncExternalStore` 订阅，避免为一个小岛引入 Redux/Zustand。
 * legacy 仍是数据 writer：每次 renderSessionList 推一份投影进来，岛只读渲染。
 */

export const MAX_VISIBLE_SESSIONS = 60

let state = {
  ready: false,
  sessions: [],
  projects: [],
  currentSessionId: null,
  collapsedTaskGroup: false,
  collapsedProjects: [],
}

const listeners = new Set()

export function getState() {
  return state
}

export function subscribe(listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function setState(patch) {
  state = { ...state, ...patch }
  listeners.forEach(listener => { listener() })
}

export function normalizeSessions(raw) {
  const list = Array.isArray(raw) ? raw : []
  const now = Date.now()
  return list.filter(x => x && typeof x === 'object').map((x, index) => {
    const s = {
      id: (x.id != null && String(x.id)) || ('s_island_' + now + '_' + index),
      title: x.title != null ? String(x.title) : '',
      createdAt: Number(x.createdAt) || now,
      updatedAt: Number(x.updatedAt) || now,
      messages: Array.isArray(x.messages) ? x.messages : [],
    }
    if (['working', 'completed', 'paused', 'failed'].includes(x.runStatus)) s.runStatus = x.runStatus
    if (x.projectId != null && String(x.projectId).trim()) s.projectId = String(x.projectId).trim()
    if (x.projectName != null && String(x.projectName).trim()) s.projectName = String(x.projectName).trim()
    if (x.projectWorkspace != null && String(x.projectWorkspace).trim()) {
      s.projectWorkspace = String(x.projectWorkspace).trim()
    }
    return s
  })
}

export function syncSessions(list, projectList, currentId) {
  const sessions = normalizeSessions(list).slice(0, MAX_VISIBLE_SESSIONS)
  let currentSessionId = currentId || state.currentSessionId
  if (!currentSessionId && sessions.length) {
    currentSessionId = sessions.slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0].id
  }
  setState({
    sessions,
    projects: Array.isArray(projectList) ? projectList.slice() : [],
    currentSessionId,
    ready: true,
  })
}

export function toggleTaskGroup() {
  setState({ collapsedTaskGroup: !state.collapsedTaskGroup })
}

export function toggleProjectGroup(projectId) {
  const collapsed = state.collapsedProjects.slice()
  const index = collapsed.indexOf(projectId)
  if (index >= 0) collapsed.splice(index, 1)
  else collapsed.push(projectId)
  setState({ collapsedProjects: collapsed })
}

export function sortedSessions(sessions) {
  return sessions.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}
