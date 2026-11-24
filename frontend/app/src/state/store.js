import { useSyncExternalStore } from 'react'
import { readVisualPrefs, applyVisualPrefs } from '../platform/theme.js'
import { readStorage, writeStorage } from '../platform/storage.js'
import { GROUP_ROSTER_PRESETS, normalizeGroupMember, routeGroupMembers } from '../services/capabilityRouter.js'
import * as api from '../services/bridge.js'
import {
  ensureTree,
  appendMessageToSession,
  forkFromMessage,
  switchSibling,
  rewindWithSnapshot,
  undoRewind,
} from '../services/dag.js'
import { runAgentConversation, invalidateSessionPrefixCache } from '../services/agentEngine.js'
import { streamChatCompletion } from '../services/modelTransport.js'
import { compactSessionHistory } from '../services/compaction.js'
import { spawnIsolatedSubagent, cancelAllSubagents } from '../services/subagent.js'
import { isResumableError } from '../services/budgetAndResume.js'
import { runExpertTeam } from '../services/expertTeam.js'
import { COLLABORATION_DEFAULTS, normalizeCollaborationConfig, runDualModelCollaboration } from '../services/collaboration.js'
import { isAbort } from '../services/errors.js'

const initialVisual = readVisualPrefs()
const GROUP_MEMBERS_KEY = 'harbor.v3.group.members'
const DISABLED_CURATED_KEY = 'harbor.v3.disabled_curated'

function loadDisabledCurated() {
  try {
    const raw = readStorage(DISABLED_CURATED_KEY, '')
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

function loadSavedGroupMembers() {
  try {
    const raw = readStorage(GROUP_MEMBERS_KEY, '')
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((m, i) => normalizeGroupMember(m, i))
      }
    }
  } catch {}
  return GROUP_ROSTER_PRESETS.engineering.members.map((m, i) => normalizeGroupMember(m, i))
}

function saveGroupMembers(list) {
  try { writeStorage(GROUP_MEMBERS_KEY, JSON.stringify(list)) } catch {}
}

function makeSession(title = '新对话', kind = 'chat') {
  const now = Date.now()
  return ensureTree({
    id: 's_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    title,
    kind,
    runStatus: 'completed',
    createdAt: now,
    updatedAt: now,
    messages: [],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  })
}

const firstSession = makeSession('新对话')

const initialState = Object.freeze({
  ui: {
    activePanel: 'chat',       // 'chat' | 'sessions' | 'workspace' | 'planning' | 'group' | 'collaboration' | 'analytics'
    sidebarOpen: true,
    activeModal: null,         // 'settings' | 'market' | 'command' | null（强互斥）
    modalOriginRect: null,     // 触发按钮坐标（用于 FLIP 平滑展开）
    dockOpen: false,
    dockTab: 'overview',
    dockPreview: '',
    searchDockOpen: false,
    composerDraft: '',
    composerTokens: [],
    impactSignal: null,        // { seq, edge, strength } 驱动 AppShell <main> 校准后的物理撞击
    toasts: [],
  },
  sessions: {
    items: [firstSession],
    currentId: firstSession.id,
    hydrated: false,
  },
  runtime: {
    serverHealth: null,
    runsBySid: {},
    queuesBySid: {},
    subagentsBySid: {},        // sid -> [{ id, task, status, summary }]
    pendingApproval: null,
    pendingTakeover: null,     // { sid, takeoverId, url, message }
    pendingBudgetPause: null,  // { sid, kind, detail }
    hybridSplit: { localTokens: 0, cloudTokens: 0 },
    cacheTotals: { promptTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, hitRate: 0, latestHitRate: 0, latestPromptTokens: 0, latestCachedTokens: 0, prefixHash: '', prefixLocked: false },
    updateInfo: null,          // { latest, url, sha256, notes }
    updateProgress: null,
  },
  settings: {
    ...initialVisual,
    backendConfig: {
      api_key: '',
      provider_base_url: 'https://open.bigmodel.cn/api/paas/v4',
      provider_base: 'https://open.bigmodel.cn/api/paas/v4',
      provider_key: '',
      provider_model: '',
      model: 'glm-4.5-flash',
      temperature: 0.7,
      top_p: 0.9,
      context_window: 128000,
      max_tokens: 4096,
      reasoning_effort: 'auto',
      thinking_budget: 8192,
      custom_effort: '',
      system_prompt: '',
      enable_search: true,
      tool_mode: 'auto',
      saver_level: 'std',
      session_budget: 0,
      update_manifest_url: '',
      local_mode: false,
      local_base_url: 'http://127.0.0.1:11434/v1',
      local_model: '',
    },
    mcpServers: [],
    memories: [],
    guardConfig: null,
    hybridConfig: { strategy: 'auto', local_first: true, cloud_budget_rmb: 0 },
    readerConfig: { base_url: '', model: '' },
    sandboxConfig: { enabled: true, command_profiles: { run_command: 'standard', run_powershell: 'standard', run_admin_command: 'off' } },
    sandboxStatus: null,
    webdavConfig: { url: '', username: '', password: '', remote_path: '/harbor-backup', conflict_policy: 'ask' },
    softwareList: [],
  },
  workspace: {
    enabled: true,
    rootPath: '',
    recent: [],
    entries: [],
    previewFile: null,
    guardRules: [],
  },
  planning: {
    plans: [],
    checkpoints: [],
  },
  market: {
    experts: [],
    disabledCurated: loadDisabledCurated(),
    loading: false,
  },
  expertTeam: {
    running: false,
    runId: '',
    timeline: [],
    mailbox: [],
    checkpoint: null,
    finalReport: '',
  },
  collaboration: {
    config: { ...COLLABORATION_DEFAULTS },
    running: false,
    events: [],
    cloudTokens: 0,
    localTokens: 0,
    finalAnswer: '',
  },
  group: {
    activeGroupId: 'grp_default',
    routingMode: 'smart',      // 'smart'（按能力路由） | 'all'（全员按序接力）
    members: loadSavedGroupMembers(),
    messages: [],
    files: [],
    filesDir: '',
    lastArchivedName: '',
    status: 'idle',            // 'idle' | 'running' | 'paused' | 'done'
    running: false,
    activeIndex: -1,
    activeMembers: [],
    handoffFrom: '',
    handoffTo: '',
    liveContent: '',
    liveReasoning: '',
    liveTools: [],
    cps: 0,
    lastIntent: null,
    routingWarning: '',
    checkpoint: null,          // { topic, plannedMembers, nextIndex, relayContext, intentLabel }
  },
  search: {
    query: '',
    results: [],
    loading: false,
    extracted: null,
  },
})

let state = initialState
const listeners = new Set()
const abortBySid = new Map()
let approvalResolver = null
let takeoverResolver = null
let budgetResolver = null
let teamAbortCtrl = null
let collabAbortCtrl = null
let groupAbortCtrl = null
let groupAbortReason = ''
let impactSeq = 0
const relayDemoTimers = []
let saveSessionsTimer = 0

function emit() { for (const fn of listeners) fn() }
export function getState() { return state }
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }

function shallowEqualObj(a, b) {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i]
    if (!Object.prototype.hasOwnProperty.call(b, k) || !Object.is(a[k], b[k])) return false
  }
  return true
}

function patchSlice(name, updater) {
  const prev = state[name]
  const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater }
  if (shallowEqualObj(prev, next)) return
  state = Object.freeze({ ...state, [name]: Object.freeze(next) })
  emit()
}

export function useSlice(name) {
  return useSyncExternalStore(subscribe, () => state[name], () => state[name])
}

export function useStoreSelector(selector) {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state))
}

/* ---- 通用 UI & 图层调度（LAW-05：Modal 与 Dock 强互斥） ---- */
export function fireShellImpact(edge = 'left', strength = 'medium', vec = null) {
  patchSlice('ui', (u) => ({
    ...u,
    impactSignal: {
      seq: ++impactSeq,
      edge,
      strength,
      dx: vec && Number.isFinite(vec.dx) ? vec.dx : 0,
      dy: vec && Number.isFinite(vec.dy) ? vec.dy : 0,
    },
  }))
}
export function setActivePanel(panel) {
  const prev = state.ui.activePanel
  patchSlice('ui', (u) => ({ ...u, activePanel: panel }))
  if (prev !== panel) fireShellImpact('left', 'panel')
}
export function toggleSidebar() { patchSlice('ui', (u) => ({ ...u, sidebarOpen: !u.sidebarOpen })) }
export function openModal(modalId, originRect = null) {
  patchSlice('ui', (u) => ({ ...u, activeModal: modalId, modalOriginRect: originRect || null, dockOpen: false }))
}
export function closeModal(impactEdge = 'left', skipImpact = false) {
  const hadModal = !!state.ui.activeModal
  patchSlice('ui', (u) => ({ ...u, activeModal: null, modalOriginRect: null }))
  if (hadModal && !skipImpact) fireShellImpact(impactEdge, 'strong')
}
export function toggleDock(tab) {
  const wasOpen = state.ui.dockOpen
  patchSlice('ui', (u) => {
    const willOpen = tab ? true : !u.dockOpen
    return { ...u, dockOpen: willOpen, dockTab: tab || u.dockTab, activeModal: willOpen ? null : u.activeModal }
  })
  if (wasOpen && !tab) fireShellImpact('right', 'strong')
}
export function setDockTab(tab) { patchSlice('ui', (u) => ({ ...u, dockTab: tab })) }
export function setDockPreview(text) {
  patchSlice('ui', (u) => ({ ...u, dockPreview: String(text || ''), dockOpen: true, dockTab: 'preview', activeModal: null }))
}
export function toggleSearchDock(force) {
  patchSlice('ui', (u) => ({ ...u, searchDockOpen: typeof force === 'boolean' ? force : !u.searchDockOpen }))
}
export function setComposerDraft(text) { patchSlice('ui', (u) => ({ ...u, composerDraft: String(text == null ? '' : text) })) }
export function appendComposerDraft(snippet) {
  patchSlice('ui', (u) => ({ ...u, composerDraft: u.composerDraft ? `${u.composerDraft}\n${snippet}` : String(snippet || '') }))
}
export function addComposerToken(token) {
  patchSlice('ui', (u) => {
    if (!token || !token.id || u.composerTokens.some((t) => t.id === token.id)) return u
    return { ...u, composerTokens: [...u.composerTokens, token] }
  })
}
export function removeComposerToken(id) {
  patchSlice('ui', (u) => ({ ...u, composerTokens: u.composerTokens.filter((t) => t.id !== id) }))
}

export function pushToast(message, kind = 'info') {
  const id = 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5)
  patchSlice('ui', (u) => ({ ...u, toasts: [...u.toasts.slice(-3), { id, message: String(message || ''), kind }] }))
  setTimeout(() => dismissToast(id), 3800)
}
export function dismissToast(id) {
  patchSlice('ui', (u) => ({ ...u, toasts: u.toasts.filter((t) => t.id !== id) }))
}

/* ---- 启动水合 ---- */
export async function hydrateApp() {
  const health = await api.checkServerHealth()
  patchSlice('runtime', { serverHealth: health })
  if (!health || !health.ok) return

  const [cfgRes, sessRes, wsRes, expRes] = await Promise.allSettled([
    api.getConfig(),
    api.getSessions(),
    api.getWsState(''),
    api.expertList(''),
  ])

  if (cfgRes.status === 'fulfilled' && cfgRes.value && typeof cfgRes.value === 'object') {
    const raw = cfgRes.value
    const unifiedBase = raw.provider_base_url || raw.provider_base || raw.base_url || 'https://open.bigmodel.cn/api/paas/v4'
    const unifiedKey = raw.provider_key || raw.api_key || ''
    const unifiedModel = raw.provider_model || raw.model || 'glm-4.5-flash'
    patchSlice('settings', (s) => ({
      ...s,
      backendConfig: {
        ...s.backendConfig,
        ...raw,
        provider_base_url: unifiedBase,
        provider_base: unifiedBase,
        provider_key: unifiedKey,
        api_key: unifiedKey,
        provider_model: unifiedModel,
        model: unifiedModel,
      },
    }))
  }
  if (sessRes.status === 'fulfilled' && Array.isArray(sessRes.value) && sessRes.value.length > 0) {
    const hydrated = sessRes.value.map((x) => ensureTree(x))
    hydrated.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    patchSlice('sessions', { items: hydrated, currentId: hydrated[0].id, hydrated: true })
    api.setCurrentSid(hydrated[0].id).catch(() => {})
  } else {
    patchSlice('sessions', (s) => ({ ...s, hydrated: true }))
  }
  if (wsRes.status === 'fulfilled' && wsRes.value && typeof wsRes.value === 'object') {
    patchSlice('workspace', (w) => ({
      ...w,
      enabled: wsRes.value.enabled !== false,
      rootPath: wsRes.value.effective || wsRes.value.dir || wsRes.value.path || '',
    }))
  }
  if (expRes.status === 'fulfilled' && expRes.value) {
    const list = Array.isArray(expRes.value) ? expRes.value : ((expRes.value.packages || expRes.value.items || expRes.value.experts) || [])
    patchSlice('market', { experts: list })
  }
  // 后台静默检查更新（不阻塞启动）
  checkAppUpdate(false).catch(() => {})
}

/* ---- 会话管理与持久化 ---- */
let sessionsDirty = false

export function flushPersistSessions() {
  if (!sessionsDirty) return
  sessionsDirty = false
  clearTimeout(saveSessionsTimer)
  api.saveSessions(state.sessions.items).catch(() => {})
}

export function queuePersistSessions() {
  sessionsDirty = true
  clearTimeout(saveSessionsTimer)
  saveSessionsTimer = setTimeout(flushPersistSessions, 350)
}

if (typeof globalThis !== 'undefined' && typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('beforeunload', () => { flushPersistSessions() })
}

export function createNewSession(title = '新对话') {
  const s = makeSession(title)
  patchSlice('sessions', (st) => ({ ...st, items: [s, ...st.items], currentId: s.id }))
  patchSlice('ui', (u) => ({ ...u, activePanel: 'chat' }))
  api.setCurrentSid(s.id).catch(() => {})
  queuePersistSessions()
  return s
}

export function selectSession(sid) {
  if (!state.sessions.items.some((x) => x.id === sid)) return
  patchSlice('sessions', (st) => ({ ...st, currentId: sid }))
  patchSlice('ui', (u) => ({ ...u, activePanel: 'chat' }))
  api.setCurrentSid(sid).catch(() => {})
}

export function deleteSession(sid) {
  stopSessionRun(sid)
  patchSlice('sessions', (st) => {
    const rest = st.items.filter((x) => x.id !== sid)
    const items = rest.length ? rest : [makeSession('新对话')]
    const currentId = st.currentId === sid ? items[0].id : st.currentId
    return { ...st, items, currentId }
  })
  api.sessionPurge(sid, []).catch(() => {})
  queuePersistSessions()
}

function updateSessionById(sid, updater) {
  patchSlice('sessions', (st) => ({
    ...st,
    items: st.items.map((x) => (x.id === sid ? updater(x) : x)),
  }))
  queuePersistSessions()
}

export function switchSessionBranch(sid, nodeId, delta) {
  updateSessionById(sid, (s) => switchSibling(s, nodeId, delta))
}

export function rewindSessionAt(sid, keepCount) {
  updateSessionById(sid, (s) => rewindWithSnapshot(s, keepCount))
  pushToast('已非破坏式回退，可随时撤销', 'ok')
}

export function undoSessionRewind(sid) {
  updateSessionById(sid, (s) => undoRewind(s))
  pushToast('已恢复回退前的全部消息', 'ok')
}

/* ---- /compact 历史压缩 & /sub 并发隔离子代理 ---- */
export function compactSessionNow(sid, force = true) {
  const target = state.sessions.items.find((x) => x.id === sid)
  if (!target) return false
  const c = state.settings.backendConfig || {}
  const res = compactSessionHistory(target, {
    force,
    level: c.saver_level || 'std',
    localMode: !!c.local_mode || Number(c.context_window) > 0,
    localCtxWindow: Number(c.context_window) || 128000,
    cacheHitRate: Number((state.runtime.cacheTotals && (state.runtime.cacheTotals.latestHitRate || state.runtime.cacheTotals.hitRate)) || 0),
  })
  if (!res.compacted) {
    if (force) pushToast('当前消息条数较少，无需压缩', 'info')
    return false
  }
  invalidateSessionPrefixCache(sid)
  updateSessionById(sid, () => ensureTree(res.session))
  pushToast(`已压缩 ${res.removedCount} 条历史为锚点摘要（${res.beforeTokens} → ${res.afterTokens} tok）`, 'ok')
  return true
}

export function spawnSubagentForSession(sid, task) {
  const cleanTask = String(task || '').trim()
  if (!cleanTask) return
  try {
    const handle = spawnIsolatedSubagent({
      parentSid: sid,
      task: cleanTask,
      onChange: (list) => patchSlice('runtime', (r) => ({ ...r, subagentsBySid: { ...r.subagentsBySid, [sid]: list } })),
      runner: async (isoSess, signal) => {
        const ep = resolveEndpointConfig()
        const out = await runAgentConversation({
          sid: isoSess.id,
          session: isoSess,
          userQuery: cleanTask,
          historyMessages: isoSess.messages,
          endpointConfig: { ...ep, max_tokens: 1600 },
          workspacePath: state.workspace.rootPath,
          signal,
        })
        return out.content || ''
      },
    })
    pushToast(`已派生隔离子代理探索「${cleanTask.slice(0, 20)}」`, 'ok')
    handle.promise.then((res) => {
      if (res && res.summary) {
        updateSessionById(sid, (s) => appendMessageToSession(s, {
          role: 'assistant',
          content: `**【子代理精炼结论】**（任务：${cleanTask}）\n\n${res.summary}`,
        }))
      }
    })
  } catch (e) {
    pushToast(e.message, 'err')
  }
}

export function abortAllSubagentsForSession(sid) {
  const res = cancelAllSubagents(sid, (list) => patchSlice('runtime', (r) => ({ ...r, subagentsBySid: { ...r.subagentsBySid, [sid]: list } })))
  pushToast(`已级联中止 ${res.count} 个子代理（${res.ms}ms）`, 'info')
}

export async function captureScreenshotToComposer() {
  try {
    const r = await api.takeScreenshot(0, 0, 0, 0, '')
    if (r && (r.path || r.ok)) {
      appendComposerDraft(`[已附带屏幕截图：${r.path || 'clipboard'}]`)
      pushToast('截屏已捕获并附入输入框', 'ok')
    } else {
      pushToast((r && (r.error || r.message)) || '截屏未能获取', 'err')
    }
  } catch (e) {
    pushToast(`截屏失败：${e.message}`, 'err')
  }
}

/* ---- 端点与视觉设置 ---- */
export async function updateVisualSettings(partial) {
  patchSlice('settings', (s) => ({ ...s, ...partial }))
  await applyVisualPrefs(partial)
}

export async function saveBackendConfig(patch) {
  const rawMerged = { ...state.settings.backendConfig, ...patch }
  const unifiedBase = rawMerged.provider_base_url || rawMerged.provider_base || 'https://open.bigmodel.cn/api/paas/v4'
  const unifiedKey = rawMerged.api_key !== undefined ? rawMerged.api_key : (rawMerged.provider_key || '')
  const unifiedModel = rawMerged.model || rawMerged.provider_model || 'glm-4.5-flash'
  const merged = {
    ...rawMerged,
    provider_base_url: unifiedBase,
    provider_base: unifiedBase,
    provider_key: unifiedKey,
    api_key: unifiedKey,
    provider_model: unifiedModel,
    model: unifiedModel,
  }
  patchSlice('settings', (s) => ({ ...s, backendConfig: merged }))
  await api.saveConfig(merged)
  pushToast('配置已保存到本机 config.json', 'ok')
}

export function resolveEndpointConfig(preferLocal = false) {
  const c = state.settings.backendConfig || {}
  const hasEnabledMcp = (state.settings.mcpServers || []).some((s) => s && s.enabled !== false)
  const useLocal = preferLocal || (c.local_mode && c.local_base_url)
  if (useLocal && c.local_base_url) {
    return {
      isLocal: true,
      hasEnabledMcp,
      baseUrl: c.local_base_url,
      apiKey: c.provider_key || c.api_key || '',
      model: c.local_model || c.model || 'qwen2.5:7b',
      temperature: c.temperature,
      top_p: c.top_p,
      context_window: Number(c.context_window) || 32768,
      max_tokens: Number(c.max_tokens) || 4096,
      reasoning_effort: c.reasoning_effort || 'auto',
      thinking_budget: Number(c.thinking_budget) || 8192,
      custom_effort: String(c.custom_effort || ''),
      system_prompt: c.system_prompt,
      tool_mode: c.tool_mode,
    }
  }
  const pickedModel = c.provider_model || c.model || 'glm-4.5-flash'
  return {
    isLocal: false,
    hasEnabledMcp,
    baseUrl: c.provider_base_url || c.provider_base || c.base_url || 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: c.provider_key || c.api_key || '',
    model: pickedModel === 'auto' ? 'glm-4.5-flash' : pickedModel,
    temperature: c.temperature,
    top_p: c.top_p,
    context_window: Number(c.context_window) || 128000,
    max_tokens: Number(c.max_tokens) || 4096,
    reasoning_effort: c.reasoning_effort || 'auto',
    thinking_budget: Number(c.thinking_budget) || 8192,
    custom_effort: String(c.custom_effort || ''),
    system_prompt: c.system_prompt,
    tool_mode: c.tool_mode,
  }
}

/* ---- 并行 Run、审批、验证码接管与熔断协调 ---- */
function patchRun(sid, updater) {
  patchSlice('runtime', (r) => {
    const prev = r.runsBySid[sid] || { phase: 'idle', stageLabel: '', reasoning: '', answer: '', cps: 0, elapsedMs: 0, tools: [], diffs: [] }
    const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater }
    return { ...r, runsBySid: { ...r.runsBySid, [sid]: next } }
  })
}

export function clearSessionRunStage(sid) {
  patchRun(sid, { phase: 'idle', stageLabel: '', reasoning: '', answer: '', cps: 0, elapsedMs: 0, error: '' })
}

export function stopSessionRun(sid) {
  const ctrl = abortBySid.get(sid)
  if (ctrl) { ctrl.abort(); abortBySid.delete(sid) }
  cancelAllSubagents(sid, (list) => patchSlice('runtime', (r) => ({ ...r, subagentsBySid: { ...r.subagentsBySid, [sid]: list } })))
  if (state.runtime.pendingApproval && state.runtime.pendingApproval.sid === sid && approvalResolver) {
    const r = approvalResolver; approvalResolver = null; patchSlice('runtime', { pendingApproval: null }); r({ ok: false, denyReason: '用户中止了当前任务' })
  }
  if (state.runtime.pendingTakeover && state.runtime.pendingTakeover.sid === sid && takeoverResolver) {
    const r = takeoverResolver; takeoverResolver = null; patchSlice('runtime', { pendingTakeover: null }); r('cancel')
  }
  if (state.runtime.pendingBudgetPause && state.runtime.pendingBudgetPause.sid === sid && budgetResolver) {
    const r = budgetResolver; budgetResolver = null; patchSlice('runtime', { pendingBudgetPause: null }); r({ action: 'stop' })
  }
  const cur = state.runtime.runsBySid[sid]
  if (cur && cur.answer) {
    updateSessionById(sid, (s) => ({ ...appendMessageToSession(s, { role: 'assistant', content: cur.answer, reasoning: cur.reasoning || '' }), runStatus: 'paused' }))
  } else {
    updateSessionById(sid, (s) => ({ ...s, runStatus: 'paused' }))
  }
  patchRun(sid, (x) => ({ ...x, phase: x.answer ? 'done' : 'idle', cps: 0 }))
}

export function resolvePendingApproval(decision) {
  if (!approvalResolver) return
  const r = approvalResolver; approvalResolver = null
  patchSlice('runtime', { pendingApproval: null })
  r(decision)
}

export function resolvePendingTakeover(action) {
  if (!takeoverResolver) return
  const r = takeoverResolver; takeoverResolver = null
  patchSlice('runtime', { pendingTakeover: null })
  r(action)
}

export function resolveBudgetPause(decision) {
  if (!budgetResolver) return
  const r = budgetResolver; budgetResolver = null
  patchSlice('runtime', { pendingBudgetPause: null })
  r(decision)
}

export function dismissResumeBanner(sid) {
  updateSessionById(sid, (s) => ({ ...s, runStatus: 'completed' }))
}

export function resumePausedSession(sid, directive = '') {
  const s = state.sessions.items.find((x) => x.id === sid)
  if (!s) return
  const lastUser = [...(s.messages || [])].reverse().find((m) => m.role === 'user')
  return runChatTurn(sid, (lastUser && lastUser.content) || '请继续未完成的任务', { resumeMode: true, correctiveDirective: directive })
}

export function enqueueOrSendChat(text, opts = {}) {
  const clean = String(text || '').trim()
  if (!clean) return
  const sid = opts.sid || state.sessions.currentId

  // 内置斜杠命令路由（/compact /sub /demo /clear /plan）
  if (clean === '/compact') { compactSessionNow(sid, true); return }
  if (clean === '/clear') { createNewSession('新对话'); return }
  if (clean === '/demo') { triggerFourActShowcase(sid); return }
  if (clean.startsWith('/sub ')) { spawnSubagentForSession(sid, clean.slice(5).trim()); return }
  if (clean.startsWith('/plan ')) {
    const goal = clean.slice(6).trim()
    api.planCreate(goal, ['分析需求与边界', '落地代码实现', '验证与收口']).then(() => refreshPlanning()).catch(() => {})
    return runChatTurn(sid, `请为以下目标先制定清晰的分步实施计划再执行：\n${goal}`, opts)
  }

  const curRun = state.runtime.runsBySid[sid]
  const busy = curRun && ['waiting', 'thinking', 'streaming'].includes(curRun.phase)
  if (busy && !opts.forkIdx) {
    const item = { id: 'q_' + Date.now(), text: clean }
    patchSlice('runtime', (r) => ({ ...r, queuesBySid: { ...r.queuesBySid, [sid]: [...(r.queuesBySid[sid] || []), item] } }))
    pushToast('当前正在生成，已加入本会话发送队列', 'info')
    return
  }
  return runChatTurn(sid, clean, opts)
}

export function cancelQueuedMessage(sid, qid) {
  patchSlice('runtime', (r) => ({
    ...r,
    queuesBySid: { ...r.queuesBySid, [sid]: (r.queuesBySid[sid] || []).filter((x) => x.id !== qid) },
  }))
}

export async function runChatTurn(sid, userText, opts = {}) {
  const tokens = state.ui.composerTokens || []
  const tokenMeta = tokens.map((t) => ({ id: t.id, name: t.name, kind: t.kind }))
  const expertPrompt = tokens.map((t) => t.prompt || `请以「${t.name}」专家身份协同解决本任务。`).join('\n')

  if (!opts.resumeMode) {
    const userMsg = { role: 'user', content: userText, meta: tokenMeta.length ? { tokens: tokenMeta } : undefined }
    if (Number.isInteger(opts.forkIdx)) {
      updateSessionById(sid, (s) => ({ ...forkFromMessage(s, opts.forkIdx, userMsg), runStatus: 'running' }))
    } else {
      updateSessionById(sid, (s) => {
        const nextTitle = (!s.messages.length && s.title === '新对话') ? userText.slice(0, 26) : s.title
        return { ...appendMessageToSession({ ...s, title: nextTitle }, userMsg), runStatus: 'running' }
      })
    }
  } else {
    updateSessionById(sid, (s) => ({ ...s, runStatus: 'running' }))
  }

  // 发送前静默检查缓存感知自动压缩
  compactSessionNow(sid, false)
  const targetSession = state.sessions.items.find((x) => x.id === sid)
  if (!targetSession) return

  const ep = resolveEndpointConfig()
  const ctrl = new AbortController()
  abortBySid.set(sid, ctrl)
  patchRun(sid, {
    phase: 'waiting',
    stageLabel: opts.resumeMode ? '正在从中断点恢复并续跑任务' : '建立安全连接',
    reasoning: '',
    answer: '',
    cps: 0,
    elapsedMs: 0,
    tools: [],
    diffs: (state.runtime.runsBySid[sid] && state.runtime.runsBySid[sid].diffs) || [],
    error: '',
    isDemo: false,
  })

  try {
    const result = await runAgentConversation({
      sid,
      session: targetSession,
      userQuery: userText,
      historyMessages: targetSession.messages,
      endpointConfig: ep,
      expertPrompt,
      workspacePath: state.workspace.rootPath,
      sessionBudgetRmb: Number(state.settings.backendConfig.session_budget) || 0,
      correctiveDirective: opts.correctiveDirective || '',
      signal: ctrl.signal,
      onEvent: (ev) => {
        patchRun(sid, ev)
        if (ev && ev.cacheStats) _recordCacheStats(ev.cacheStats)
      },
      requestApproval: (req) => new Promise((resolve) => {
        approvalResolver = resolve
        patchSlice('runtime', { pendingApproval: { id: 'ap_' + Date.now(), sid, ...req } })
      }),
      requestTakeover: (tk) => new Promise((resolve) => {
        takeoverResolver = resolve
        patchSlice('runtime', { pendingTakeover: { sid, ...tk } })
      }),
      requestBudgetDecision: (bp) => new Promise((resolve) => {
        budgetResolver = resolve
        patchSlice('runtime', { pendingBudgetPause: { sid, ...bp } })
      }),
    })

    if (result && (result.content || result.reasoning)) {
      const addTok = (result.usage && result.usage.total_tokens) || 0
      if (addTok > 0) {
        patchSlice('runtime', (r) => ({
          ...r,
          hybridSplit: {
            localTokens: r.hybridSplit.localTokens + (ep.isLocal ? addTok : 0),
            cloudTokens: r.hybridSplit.cloudTokens + (ep.isLocal ? 0 : addTok),
          },
        }))
      }
      updateSessionById(sid, (s) => {
        // 严格 Append-Only KV-Cache 落盘：在末条 user 消息记下本轮实际发送的 _wireContent，
        // 在 assistant 消息记下本轮工具调用轨 _wireTrail；UI 仍展示干净的 m.content，
        // 下一轮发给模型时 sanitizeMessagesForApi 100% 逐字节复现，命中率直冲 90%+！
        const patchedMsgs = Array.isArray(s.messages) ? s.messages.map((m) => ({ ...m })) : []
        if (result.wiredUserContent) {
          for (let i = patchedMsgs.length - 1; i >= 0; i--) {
            if (patchedMsgs[i] && patchedMsgs[i].role === 'user') {
              patchedMsgs[i]._wireContent = result.wiredUserContent
              break
            }
          }
        }
        const baseSess = { ...s, messages: patchedMsgs }
        const next = appendMessageToSession(baseSess, {
          role: 'assistant',
          content: result.content || '',
          reasoning: result.reasoning || '',
          tools: result.tools || [],
          ...(Array.isArray(result.wireTrail) && result.wireTrail.length ? { _wireTrail: result.wireTrail } : {}),
        })
        next.runStatus = result.paused ? 'paused' : 'completed'
        const u = s.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        const add = result.usage || {}
        next.usage = {
          prompt_tokens: u.prompt_tokens + (add.prompt_tokens || 0),
          completion_tokens: u.completion_tokens + (add.completion_tokens || 0),
          total_tokens: u.total_tokens + (add.total_tokens || 0),
        }
        return next
      })
    } else {
      updateSessionById(sid, (s) => ({ ...s, runStatus: result && result.paused ? 'paused' : 'completed' }))
    }
  } catch (err) {
    if (!isAbort(err)) {
      const msg = String(err && err.message || err)
      const resumable = isResumableError(msg)
      updateSessionById(sid, (s) => ({ ...s, runStatus: resumable ? 'paused' : 'failed' }))
      patchRun(sid, { phase: 'idle', cps: 0, error: msg })
      pushToast(msg, 'err')
    }
  } finally {
    abortBySid.delete(sid)
    const q = state.runtime.queuesBySid[sid] || []
    if (q.length > 0) {
      const [first, ...rest] = q
      patchSlice('runtime', (r) => ({ ...r, queuesBySid: { ...r.queuesBySid, [sid]: rest } }))
      setTimeout(() => runChatTurn(sid, first.text), 120)
    }
  }
}

/* ---- 四幕大尺度动效演示（含真实生成式 UI Spec 卡片预览） ---- */
const demoTimers = []
export function triggerFourActShowcase(sid) {
  while (demoTimers.length) clearTimeout(demoTimers.pop())
  const t0 = Date.now()
  const at = (ms, fn) => demoTimers.push(setTimeout(fn, ms))
  patchRun(sid, { phase: 'waiting', stageLabel: '建立安全连接与原生窗外透色合成', reasoning: '', answer: '', cps: 0, elapsedMs: 120, tools: [], error: '', isDemo: true })
  at(650, () => patchRun(sid, { stageLabel: '装配 AGENTS.md、5× 静态前缀缓存与生成式 UI 协议', elapsedMs: Date.now() - t0 }))
  at(1350, () => patchRun(sid, {
    phase: 'thinking',
    stageLabel: '深度推演沉浸中',
    cps: 36,
    elapsedMs: Date.now() - t0,
    reasoning: '1. 验证真窗外硬件透色（Win11 Acrylic / macOS Vibrancy）与零假壁纸链路。\n',
  }))
  at(2100, () => patchRun(sid, (r) => ({
    ...r,
    cps: 52,
    elapsedMs: Date.now() - t0,
    reasoning: r.reasoning + '2. 校验全量迁入模块：/compact 锚点压缩、/sub 并发子代理、专家团队编排器、生成式 UI 与双模型协同。\n',
    tools: [{ id: 'demo_1', name: 'read_file', detail: 'frontend/app/src/services/agentEngine.js', status: 'running' }],
  })))
  at(2850, () => patchRun(sid, (r) => ({
    ...r,
    cps: 60,
    elapsedMs: Date.now() - t0,
    reasoning: r.reasoning + '3. 组装结构化 UiSpec v1 生成式视图，准备向回答卡片交棒动量。\n',
    tools: [
      { id: 'demo_1', name: 'read_file', detail: 'frontend/app/src/services/agentEngine.js', status: 'done' },
      { id: 'demo_2', name: 'search_replace', detail: 'frontend/app/src/ui/GenerativeView.jsx', status: 'running' },
    ],
  })))
  const demoAnswer = [
    '### Harbor React 19 全量迁移完成（含生成式 UI 实景演示）',
    '',
    '以下卡片由 React 19 `GenerativeView` 实时校验并渲染（遵循 UiSpec v1 规范）：',
    '',
    '```ui-spec',
    JSON.stringify({
      schemaVersion: 1,
      specId: 'harbor_v2_summary',
      title: 'Harbor React 19 全域迁入健康仪表盘',
      layout: 'card-grid',
      blocks: [
        { blockId: 's1', component: 'StatTile', props: { label: '铁律门禁违例', value: '0', delta: '12 / 12 PASS' } },
        { blockId: 's2', component: 'StatTile', props: { label: 'CSS !important', value: '0', delta: '原 91 处已清零' } },
        { blockId: 's3', component: 'Progress', props: { label: '17 个旧业务域全量迁入率', value: 100 } },
        { blockId: 's4', component: 'Chips', props: { items: ['Acrylic 真窗外透色', '四幕空间编排', '/compact + /sub', '专家团队编排器', '双模型协同', '生成式 UI'] } },
      ],
    }),
    '```',
  ].join('\n')

  at(3650, () => patchRun(sid, (r) => ({
    ...r,
    phase: 'streaming',
    cps: 66,
    elapsedMs: Date.now() - t0,
    tools: r.tools.map((t) => ({ ...t, status: 'done' })),
    answer: demoAnswer,
  })))
  at(4600, () => patchRun(sid, (r) => ({ ...r, phase: 'done', cps: 0, elapsedMs: Date.now() - t0 })))
}

/* ---- 专家团队编排 & 双模型协同 ---- */
export async function startExpertTeamRun({ goal, lead, members, useRecovery = false }) {
  if (teamAbortCtrl) teamAbortCtrl.abort()
  teamAbortCtrl = new AbortController()
  patchSlice('expertTeam', (t) => ({
    ...t,
    running: true,
    timeline: useRecovery ? t.timeline : [],
    finalReport: '',
  }))
  try {
    const res = await runExpertTeam({
      goal,
      lead,
      members,
      endpointConfig: resolveEndpointConfig(),
      recovery: useRecovery ? state.expertTeam.checkpoint : null,
      signal: teamAbortCtrl.signal,
      onUpdate: (upd) => patchSlice('expertTeam', (t) => ({ ...t, ...upd })),
    })
    patchSlice('expertTeam', (t) => ({
      ...t,
      running: false,
      timeline: res.timeline,
      mailbox: res.mailbox,
      checkpoint: res.checkpoint,
      finalReport: res.finalReport,
    }))
    if (res.status === 'completed') pushToast('专家团队编排已完成交付', 'ok')
  } catch (e) {
    patchSlice('expertTeam', { running: false })
    if (!isAbort(e)) pushToast(`团队编排失败：${e.message}`, 'err')
  } finally {
    teamAbortCtrl = null
  }
}

export function stopExpertTeamRun() {
  if (teamAbortCtrl) teamAbortCtrl.abort()
}

export function updateCollaborationConfig(partial) {
  patchSlice('collaboration', (c) => ({ ...c, config: normalizeCollaborationConfig({ ...c.config, ...partial }) }))
}

export async function startCollaborationRun(goal) {
  if (collabAbortCtrl) collabAbortCtrl.abort()
  collabAbortCtrl = new AbortController()
  patchSlice('collaboration', (c) => ({ ...c, running: true, events: [], finalAnswer: '' }))
  try {
    const cloudEp = resolveEndpointConfig(false)
    const localEp = resolveEndpointConfig(true)
    const res = await runDualModelCollaboration({
      goal,
      config: state.collaboration.config,
      cloudEndpoint: cloudEp,
      localEndpoint: localEp,
      signal: collabAbortCtrl.signal,
      onEvent: (ev) => patchSlice('collaboration', (c) => ({ ...c, ...ev })),
    })
    patchSlice('collaboration', (c) => ({
      ...c,
      running: false,
      events: res.events,
      cloudTokens: res.cloudTokens,
      localTokens: res.localTokens,
      finalAnswer: res.finalAnswer,
    }))
    pushToast('双模型协同完成', 'ok')
  } catch (e) {
    patchSlice('collaboration', { running: false })
    if (!isAbort(e)) pushToast(`双模型协同失败：${e.message}`, 'err')
  } finally {
    collabAbortCtrl = null
  }
}

export function stopCollaborationRun() {
  if (collabAbortCtrl) collabAbortCtrl.abort()
}

/* ---- 域刷新：工作区 / 计划 / 市场 / 设置全量扩展（Hybrid/Sandbox/WebDAV/Software/Update） ---- */
export async function refreshWorkspace() {
  try {
    const sid = state.sessions.currentId
    const [ws, recent, dir, rules] = await Promise.allSettled([
      api.getWsState(sid), api.listRecentWs(), api.listDir('.'), api.guardRuleList(),
    ])
    patchSlice('workspace', (w) => ({
      ...w,
      enabled: ws.status === 'fulfilled' && ws.value ? ws.value.enabled !== false : w.enabled,
      rootPath: ws.status === 'fulfilled' && ws.value ? (ws.value.effective || ws.value.dir || w.rootPath) : w.rootPath,
      recent: recent.status === 'fulfilled' && Array.isArray(recent.value && recent.value.recent) ? recent.value.recent : w.recent,
      entries: dir.status === 'fulfilled' && dir.value && Array.isArray(dir.value.entries) ? dir.value.entries : [],
      guardRules: rules.status === 'fulfilled' && rules.value && Array.isArray(rules.value.rules) ? rules.value.rules : [],
    }))
  } catch (e) {
    pushToast(`读取工作区失败：${e.message}`, 'err')
  }
}

export async function setWorkspacePath(dirPath) {
  invalidateSessionPrefixCache(state.sessions.currentId)
  await api.setSessionWs(state.sessions.currentId, dirPath, true)
  await refreshWorkspace()
  pushToast(`工作区已切换至 ${dirPath}`, 'ok')
}

export async function toggleWorkspaceEnabled(enabled) {
  invalidateSessionPrefixCache(state.sessions.currentId)
  await api.setWsEnabled(state.sessions.currentId, enabled)
  await refreshWorkspace()
}

export async function previewWorkspaceFile(filePath) {
  const res = await api.readFile(filePath, 0, 200, true)
  patchSlice('workspace', { previewFile: { path: filePath, content: String((res && res.content) || '') } })
}

export async function refreshPlanning() {
  const [pl, ck] = await Promise.allSettled([api.planList(25), api.checkpointList('')])
  patchSlice('planning', {
    plans: pl.status === 'fulfilled' && pl.value && Array.isArray(pl.value.plans) ? pl.value.plans : [],
    checkpoints: ck.status === 'fulfilled' && ck.value && Array.isArray(ck.value.checkpoints) ? ck.value.checkpoints : [],
  })
}

export function toggleCuratedPackEnabled(packId) {
  patchSlice('market', (m) => {
    const cur = Array.isArray(m.disabledCurated) ? m.disabledCurated : []
    const next = cur.includes(packId) ? cur.filter((x) => x !== packId) : [...cur, packId]
    try { writeStorage(DISABLED_CURATED_KEY, JSON.stringify(next)) } catch {}
    return { ...m, disabledCurated: next }
  })
}

export async function refreshMarket(query = '') {
  patchSlice('market', { loading: true })
  try {
    const res = await api.expertList(query)
    const list = Array.isArray(res) ? res : ((res && (res.packages || res.items || res.experts)) || [])
    patchSlice('market', { experts: list, loading: false })
  } catch {
    patchSlice('market', { loading: false })
  }
}

export async function refreshSettingsAux() {
  const [mcp, mem, gd, hy, rd, sb, sbSt, wd, sw] = await Promise.allSettled([
    api.mcpListServers(),
    api.getMemory(),
    api.guardGetConfig(),
    api.hybridGetConfig(),
    api.readerConfigGet(),
    api.sandboxGetConfig(),
    api.sandboxStatus(),
    api.webdavGetConfig(),
    api.softwareList(''),
  ])
  patchSlice('settings', (s) => ({
    ...s,
    mcpServers: mcp.status === 'fulfilled' && mcp.value ? (Array.isArray(mcp.value) ? mcp.value : (mcp.value.servers || [])) : s.mcpServers,
    memories: mem.status === 'fulfilled' && Array.isArray(mem.value) ? mem.value : s.memories,
    guardConfig: gd.status === 'fulfilled' ? gd.value : s.guardConfig,
    hybridConfig: hy.status === 'fulfilled' && hy.value && typeof hy.value === 'object' ? { ...s.hybridConfig, ...hy.value } : s.hybridConfig,
    readerConfig: rd.status === 'fulfilled' && rd.value && typeof rd.value === 'object' ? { ...s.readerConfig, ...rd.value } : s.readerConfig,
    sandboxConfig: sb.status === 'fulfilled' && sb.value && typeof sb.value === 'object' ? { ...s.sandboxConfig, ...sb.value } : s.sandboxConfig,
    sandboxStatus: sbSt.status === 'fulfilled' ? sbSt.value : s.sandboxStatus,
    webdavConfig: wd.status === 'fulfilled' && wd.value && typeof wd.value === 'object' ? { ...s.webdavConfig, ...wd.value, password: '' } : s.webdavConfig,
    softwareList: sw.status === 'fulfilled' && sw.value ? (Array.isArray(sw.value) ? sw.value : (sw.value.items || sw.value.software || [])) : s.softwareList,
  }))
}

export async function checkAppUpdate(manual = true) {
  try {
    const url = state.settings.backendConfig.update_manifest_url || null
    const r = await api.checkUpdate(url)
    if (r && r.update_available) {
      patchSlice('runtime', { updateInfo: r })
      if (manual) pushToast(`发现新版本 v${r.latest}`, 'ok')
    } else {
      patchSlice('runtime', { updateInfo: null })
      if (manual) pushToast('当前已是最新版本', 'info')
    }
  } catch (e) {
    if (manual) pushToast(`检查更新失败：${e.message}`, 'err')
  }
}

export function setGroupRoutingMode(mode) {
  patchSlice('group', { routingMode: mode === 'all' ? 'all' : 'smart' })
}

export function addGroupMember(memberInput) {
  const next = normalizeGroupMember(memberInput, state.group.members.length)
  const list = [...state.group.members, next]
  saveGroupMembers(list)
  patchSlice('group', { members: list })
  pushToast(`已添加角色「${next.name}」`, 'ok')
}

export function updateGroupMember(id, patch) {
  const list = state.group.members.map((m, idx) => (m.id === id ? normalizeGroupMember({ ...m, ...patch, id }, idx) : m))
  saveGroupMembers(list)
  patchSlice('group', { members: list })
}

export function removeGroupMember(id) {
  if (state.group.members.length <= 1) {
    pushToast('至少需要保留 1 名群聊角色', 'warn')
    return
  }
  const list = state.group.members.filter((m) => m.id !== id)
  saveGroupMembers(list)
  patchSlice('group', { members: list })
}

export function applyGroupPreset(presetKey) {
  const preset = GROUP_ROSTER_PRESETS[presetKey]
  if (!preset) return
  const list = preset.members.map((m, i) => normalizeGroupMember(m, i))
  saveGroupMembers(list)
  patchSlice('group', { members: list, routingWarning: '' })
  pushToast(`已切换名册模板：${preset.name}`, 'ok')
}

export function pauseGroupRelay() {
  if (!state.group.running) return
  groupAbortReason = 'pause'
  if (groupAbortCtrl) groupAbortCtrl.abort()
}

export function abortGroupRelay() {
  while (relayDemoTimers.length) clearTimeout(relayDemoTimers.pop())
  groupAbortReason = 'abort'
  if (groupAbortCtrl) groupAbortCtrl.abort()
  patchSlice('group', {
    running: false,
    status: 'idle',
    activeIndex: -1,
    handoffFrom: '',
    handoffTo: '',
    liveContent: '',
    liveReasoning: '',
    cps: 0,
    checkpoint: null,
  })
  pushToast('已彻底中止本轮群聊接力', 'info')
}

export async function resumeGroupRelay(extraNote = '') {
  const ck = state.group.checkpoint
  if (!ck || state.group.running) return
  return _executeGroupRelayLoop({
    topic: ck.topic,
    plannedMembers: ck.plannedMembers,
    startIndex: ck.nextIndex,
    relayContext: extraNote.trim()
      ? [...ck.relayContext, { role: 'user', content: `【主持人中途补充指令】${extraNote.trim()}` }]
      : [...ck.relayContext],
    intentLabel: ck.intentLabel,
  })
}

export async function runGroupRelay(topic) {
  const clean = String(topic || '').trim()
  if (!clean || state.group.running) return
  while (relayDemoTimers.length) clearTimeout(relayDemoTimers.pop())

  const routed = routeGroupMembers(clean, state.group.members, state.group.routingMode)
  patchSlice('group', (g) => ({
    ...g,
    lastIntent: routed.intent,
    routingWarning: routed.missingCapabilityWarning,
    messages: [...g.messages, { id: 'gm_' + Date.now(), author: '我（主持人）', role: 'user', content: clean }],
  }))
  if (routed.missingCapabilityWarning) pushToast(routed.missingCapabilityWarning, 'info')

  return _executeGroupRelayLoop({
    topic: clean,
    plannedMembers: routed.selected,
    startIndex: 0,
    relayContext: [{ role: 'user', content: clean }],
    intentLabel: `${routed.intent.label} (${routed.selected.length} 棒)`,
  })
}

function _recordCacheStats(cs) {
  if (!cs) return
  patchSlice('runtime', (r) => {
    const prev = r.cacheTotals || {
      promptTokens: 0, cachedTokens: 0, cacheWriteTokens: 0,
      hitRate: 0, latestHitRate: 0, latestPromptTokens: 0, latestCachedTokens: 0,
      prefixHash: '', prefixLocked: false,
    }
    const addPt = Number(cs.promptTokens) || 0
    const addCt = Number(cs.cachedTokens) || 0
    const addWt = Number(cs.cacheWriteTokens) || 0
    const pt = prev.promptTokens + addPt
    const ct = prev.cachedTokens + addCt
    const wt = prev.cacheWriteTokens + addWt
    const latestHit = addPt > 0 ? Math.min(100, Math.round((addCt / addPt) * 100)) : prev.latestHitRate
    return {
      ...r,
      cacheTotals: {
        promptTokens: pt,
        cachedTokens: ct,
        cacheWriteTokens: wt,
        hitRate: pt > 0 ? Math.min(100, Math.round((ct / pt) * 100)) : prev.hitRate,
        latestHitRate: latestHit,
        latestPromptTokens: addPt || prev.latestPromptTokens,
        latestCachedTokens: addCt,
        prefixHash: cs.prefixHash || prev.prefixHash,
        prefixLocked: !!cs.prefixLocked,
      },
    }
  })
}

async function _executeGroupRelayLoop({ topic, plannedMembers, startIndex, relayContext, intentLabel }) {
  const baseEp = resolveEndpointConfig()
  const latestMembers = plannedMembers.map((pm) => state.group.members.find((m) => m.id === pm.id) || pm)
  // 群聊共享当前工作区会话的 sid，确保所有成员共用同一冻结 [tools + systemPrompt] 前缀（KV-Cache 90%+）
  // 且写文件/执行命令直接落入当前选定的工作区！
  const groupSid = state.sessions.currentId || state.group.activeGroupId

  groupAbortReason = ''
  groupAbortCtrl = new AbortController()

  patchSlice('group', {
    running: true,
    status: 'running',
    activeMembers: latestMembers,
    activeIndex: startIndex,
    handoffFrom: '',
    handoffTo: '',
    liveContent: '',
    liveReasoning: '',
    liveTools: [],
    cps: 0,
    checkpoint: null,
  })

  let currentIdx = startIndex
  let livePartial = ''

  try {
    for (let i = startIndex; i < latestMembers.length; i++) {
      currentIdx = i
      livePartial = ''
      const m = latestMembers[i]
      if (groupAbortCtrl.signal.aborted) break

      if (i > startIndex) {
        const prevName = latestMembers[i - 1].name
        patchSlice('group', { activeIndex: i, handoffFrom: prevName, handoffTo: m.name, liveContent: '', liveReasoning: '', liveTools: [], cps: 0 })
        await new Promise((r) => setTimeout(r, 460))
        if (groupAbortCtrl.signal.aborted) break
      }

      patchSlice('group', { activeIndex: i, handoffFrom: '', handoffTo: '', liveContent: '', liveReasoning: '', liveTools: [], cps: 0 })

      const memberEp = {
        ...baseEp,
        baseUrl: m.baseUrl || baseEp.baseUrl,
        model: m.model || baseEp.model,
        max_tokens: m.maxTokens > 0 ? m.maxTokens : baseEp.max_tokens,
        reasoning_effort: (m.reasoningTier && m.reasoningTier !== 'auto') ? m.reasoningTier : baseEp.reasoning_effort,
        thinking_budget: m.customThinkingBudget > 0 ? m.customThinkingBudget : baseEp.thinking_budget,
      }

      const canUseTools = m.allowTools !== false && memberEp.tool_mode !== 'off'
      const roleBatonMsg = {
        role: 'user',
        content:
          `【群聊接力 · 第 ${i + 1}/${latestMembers.length} 棒 · 当前发言角色：${m.name}】\n` +
          `• 专长能力：${(m.capabilities || ['text']).join(' / ')}\n` +
          `• 本棒职责：${m.persona}\n` +
          (canUseTools
            ? '• 执行要求：若本棒需要创建/修改代码或文件（如网页、脚本、配置）或执行验证命令，请直接调用工作区工具（write_file / search_replace / read_file / run_command）实际落地，回答里只需给出清晰简明的交付摘要与文件路径，避免贴数百行原始代码。'
            : '• 输出要求：承接前序结论，输出简洁高密度的结构化交付。'),
      }

      // 关键优化：使用与主对话统一的 runAgentConversation（支持真工具调用 + 护栏审批 + 共享冻结前缀 KV-Cache）
      const turnHistory = [...relayContext, roleBatonMsg]
      const res = await runAgentConversation({
        sid: groupSid,
        userQuery: i === 0 ? topic : '',
        historyMessages: turnHistory,
        endpointConfig: memberEp,
        workspacePath: state.workspace.rootPath,
        allowTools: canUseTools,
        maxRounds: canUseTools ? 8 : 1,
        skipMemoryRecall: true,
        skipSelfCheck: true,
        signal: groupAbortCtrl.signal,
        onEvent: (ev) => {
          if (ev && ev.cacheStats) _recordCacheStats(ev.cacheStats)
          if (ev && typeof ev.answer === 'string') livePartial = ev.answer
          patchSlice('group', (g) => ({
            ...g,
            liveReasoning: ev && typeof ev.reasoning === 'string' ? ev.reasoning : g.liveReasoning,
            liveContent: ev && typeof ev.answer === 'string' ? ev.answer : g.liveContent,
            liveTools: ev && Array.isArray(ev.tools) ? ev.tools : g.liveTools,
            cps: ev && typeof ev.cps === 'number' ? ev.cps : g.cps,
          }))
        },
        requestApproval: (req) => new Promise((resolve) => {
          approvalResolver = resolve
          patchSlice('runtime', { pendingApproval: { id: 'ap_' + Date.now(), sid: 'group', ...req } })
        }),
      })

      const reply = String((res && res.content) || '').trim()
      const usedTools = (res && Array.isArray(res.tools)) ? res.tools : []
      // 保持 append-only 历史：把角色指令与成员回复追加进 relayContext，下一棒天然吃满前序 KV-Cache！
      relayContext.push({
        role: 'user',
        content: (res && res.wiredUserContent) || roleBatonMsg.content,
      })
      if (res && Array.isArray(res.wireTrail) && res.wireTrail.length) {
        for (const step of res.wireTrail) relayContext.push(step)
      }
      // 严守 Append-Only 前缀缓存铁律：assistant 回复 100% 原样落入 relayContext，绝不前置改写角色头打穿 KV-Cache！
      relayContext.push({ role: 'assistant', content: reply })

      patchSlice('group', (g) => ({
        ...g,
        liveContent: '',
        liveReasoning: '',
        liveTools: [],
        cps: 0,
        messages: [
          ...g.messages,
          {
            id: 'gm_' + Date.now() + '_' + m.id,
            author: m.name,
            model: memberEp.model,
            role: 'assistant',
            content: reply,
            reasoning: (res && res.reasoning) || '',
            tools: usedTools,
          },
        ],
      }))
    }

    if (!groupAbortCtrl.signal.aborted) {
      const assistantSections = (state.group.messages || [])
        .slice(-latestMembers.length)
        .filter((x) => x && x.role === 'assistant' && x.content)
        .map((x) => `【${x.author}${x.model ? ` (${x.model})` : ''}】\n${x.content}`)
      const handoff = `【交接文档】\n议题：${topic}\n\n` + assistantSections.join('\n\n---\n\n')
      let archivedName = ''
      try {
        const w = await api.groupFilesWrite(state.group.activeGroupId, '默认群聊', '主持人', topic.slice(0, 32), handoff)
        archivedName = (w && (w.name || (w.file && w.file.name))) || ''
      } catch {}
      await refreshGroupFiles()
      patchSlice('group', {
        running: false,
        status: 'done',
        activeIndex: latestMembers.length,
        handoffFrom: '',
        handoffTo: '',
        liveTools: [],
        cps: 0,
        checkpoint: null,
        lastArchivedName: archivedName,
      })
      pushToast(archivedName ? `全员接力完成 · 交接文档已存入「群文件」：${archivedName}` : '全员接力完成并已归档至「群文件」', 'ok')
    }
  } catch (e) {
    if (isAbort(e)) {
      if (groupAbortReason === 'pause') {
        if (livePartial.trim()) {
          const curMember = latestMembers[currentIdx]
          patchSlice('group', (g) => ({
            ...g,
            messages: [...g.messages, { id: 'gm_p_' + Date.now(), author: `${curMember.name}（已暂停部分）`, role: 'assistant', content: livePartial.trim(), tools: [] }],
          }))
        }
        patchSlice('group', {
          running: false,
          status: 'paused',
          activeIndex: currentIdx,
          handoffFrom: '',
          handoffTo: '',
          liveTools: [],
          cps: 0,
          checkpoint: { topic, plannedMembers: latestMembers, nextIndex: currentIdx, relayContext, intentLabel },
        })
        pushToast(`接力已暂停在第 ${currentIdx + 1} 棒，可随时继续`, 'info')
      }
    } else {
      patchSlice('group', {
        running: false,
        status: 'paused',
        activeIndex: currentIdx,
        liveTools: [],
        cps: 0,
        checkpoint: { topic, plannedMembers: latestMembers, nextIndex: currentIdx, relayContext, intentLabel },
      })
      pushToast(`接力异常（可点继续重试当前棒）：${e.message}`, 'err')
    }
  } finally {
    groupAbortCtrl = null
  }
}

/** 零 Token 一键演示独立接力轨道 + 光梭交棒动效（避免视觉疲劳的专属科技轨道风格） */
export function triggerRelayShowcase() {
  while (relayDemoTimers.length) clearTimeout(relayDemoTimers.pop())
  const members = state.group.members.length ? state.group.members : GROUP_ROSTER_PRESETS.video.members
  const at = (ms, fn) => relayDemoTimers.push(setTimeout(fn, ms))

  patchSlice('group', {
    running: true,
    status: 'running',
    activeMembers: members,
    activeIndex: 0,
    handoffFrom: '',
    handoffTo: '',
    cps: 44,
    liveTools: [{ id: 'dt_1', name: 'read_file', detail: 'README.md', status: 'done' }],
    lastIntent: { capability: members[0].capabilities[0] || 'text', label: '接力动画演示' },
    liveContent: `【${members[0].name}】正在拆解任务边界与首棒核心产出…`,
    liveReasoning: '',
  })

  if (members.length >= 2) {
    at(1250, () => patchSlice('group', {
      activeIndex: 1,
      handoffFrom: members[0].name,
      handoffTo: members[1].name,
      cps: 58,
      liveTools: [{ id: 'dt_2', name: 'write_file', detail: 'index.html', status: 'running' }],
      liveContent: `正在接收 ${members[0].name} 交接方案，准备进入第二棒执行…`,
    }))
    at(1800, () => patchSlice('group', {
      handoffFrom: '',
      handoffTo: '',
      cps: 66,
      liveTools: [{ id: 'dt_2', name: 'write_file', detail: 'index.html', status: 'done' }],
      liveContent: `【${members[1].name}】已点燃接力站点，正在生成高密度细化方案与执行清单…`,
    }))
  }

  if (members.length >= 3) {
    at(2950, () => patchSlice('group', {
      activeIndex: 2,
      handoffFrom: members[1].name,
      handoffTo: members[2].name,
      cps: 62,
      liveTools: [{ id: 'dt_3', name: 'read_file', detail: 'index.html', status: 'done' }],
      liveContent: `正在接收 ${members[1].name} 交接稿，准备终审收口…`,
    }))
    at(3500, () => patchSlice('group', {
      handoffFrom: '',
      handoffTo: '',
      cps: 50,
      liveContent: `【${members[2].name}】正在做最终一致性核对与交付整理…`,
    }))
  }

  at(4550, () => patchSlice('group', {
    running: false,
    status: 'done',
    activeIndex: members.length,
    handoffFrom: '',
    handoffTo: '',
    liveContent: '',
    liveTools: [],
    cps: 0,
  }))
}

export async function refreshGroupFiles() {
  try {
    const res = await api.groupFilesList(state.group.activeGroupId, '默认群聊')
    const files = (res && (res.files || res.items)) || (Array.isArray(res) ? res : [])
    const filesDir = (res && (res.dir || res.root)) || ''
    patchSlice('group', { files, filesDir })
  } catch {}
}

export async function openGroupFileInDock(fileObj) {
  if (!fileObj || !fileObj.path) return
  try {
    const res = await api.groupFilesRead(fileObj.path)
    const content = (res && typeof res.content === 'string') ? res.content : (typeof res === 'string' ? res : JSON.stringify(res, null, 2))
    setDockPreview(`### 📁 群文件 · ${fileObj.title || fileObj.name}\n\n${content}`)
  } catch (e) {
    pushToast(`读取群文件失败：${e.message}`, 'err')
  }
}

export async function openGroupFilesFolder() {
  try {
    const r = await api.groupFilesOpenDir(state.group.activeGroupId)
    if (r && r.ok === false) pushToast(r.error || '打开目录失败', 'err')
    else pushToast('已打开本地群文件目录', 'ok')
  } catch (e) {
    pushToast(`打开目录失败：${e.message}`, 'err')
  }
}

export async function deleteGroupFile(name) {
  if (!name) return
  try {
    await api.groupFilesDelete(state.group.activeGroupId, name)
    await refreshGroupFiles()
    pushToast(`已删除群文件：${name}`, 'ok')
  } catch (e) {
    pushToast(`删除失败：${e.message}`, 'err')
  }
}

export async function runWebSearch(query) {
  const q = String(query || '').trim()
  if (!q) return
  patchSlice('search', { query: q, loading: true, extracted: null })
  try {
    const res = await api.browserSearch({ query: q, max_results: 8 })
    const items = (res && (res.results || res.items)) || []
    patchSlice('search', { results: Array.isArray(items) ? items : [], loading: false })
  } catch (e) {
    patchSlice('search', { loading: false })
    pushToast(`搜索失败：${e.message}`, 'err')
  }
}

export async function extractSearchUrl(url) {
  patchSlice('search', { loading: true })
  try {
    await api.browserNavigate(url)
    const ex = await api.browserExtract('', 'text')
    patchSlice('search', { extracted: { url, text: String((ex && (ex.content || ex.text)) || '') }, loading: false })
  } catch (e) {
    patchSlice('search', { loading: false })
    pushToast(`正文提取失败：${e.message}`, 'err')
  }
}
