import {
  EMPTY_CACHE_TOTALS,
  initKernel,
  getState,
  subscribe,
  patchSlice as kernelPatchSlice,
  useSlice,
  useStoreSelector,
  activeViewSid,
  syncRuntimeTelemetryForSid as kernelSyncTelemetry,
} from './kernel.js'
import { downloadTextFile } from '../platform/dom.js'
import { formatSessionAsMarkdown, formatGroupAsMarkdown, safeExportFilename } from '../services/sessionExport.js'
import { readVisualPrefs, applyVisualPrefs } from '../platform/theme.js'
import { readStorage, writeStorage } from '../platform/storage.js'
import { GROUP_ROSTER_PRESETS, normalizeGroupMember, routeGroupMembers, buildModeratorPrompt, parseModeratorPlan } from '../services/capabilityRouter.js'
import { isAutonomousAuthorized } from '../services/toolRouter.js'
import {
  normalizeSessionKind,
  shortFolderLabel,
  applyProjectWorkspace,
  clearProjectWorkspace,
} from '../services/sessionMode.js'
import {
  createIsolatedGroup,
  hydrateGroupCollection,
  removeGroupFromCollection,
} from '../services/groupStore.js'
import * as api from '../services/bridge.js'
import {
  ensureTree,
  appendMessageToSession,
  forkFromMessage,
  switchSibling,
  rewindWithSnapshot,
  undoRewind,
} from '../services/dag.js'
import { runAgentConversation, dispatchSingleTool, invalidateSessionPrefixCache } from '../services/agentEngine.js'
import {
  collectPluginTools,
  runPluginBeforePromptHooks,
  dispatchPluginTool,
  collectPluginSlashCommands,
} from '../services/pluginRegistry.js'
import { loadInitialSavedModels } from './settingsSlice.js'
import {
  createInitialPluginsSlice,
  setWorkflowViewTab,
  selectWorkflow,
  togglePluginEnabled,
  installCustomPlugin,
  uninstallCustomPlugin,
  createBlankCustomWorkflow,
  saveCustomWorkflowDef,
  deleteCustomWorkflowDef,
  compileActiveGroupToWorkflow,
  cloneWorkflowDef,
  importWorkflowJson,
  createWorkflowFromPrompt,
  undoWorkflowEdit,
  redoWorkflowEdit,
  stopWorkflowExecution,
  resetWorkflowRunState,
  runWorkflowWithHandlers,
  triggerWorkflowShowcaseRun,
} from './workflowSlice.js'
import { streamChatCompletion } from '../services/modelTransport.js'
import { compactSessionHistory } from '../services/compaction.js'
import { spawnIsolatedSubagent, cancelAllSubagents, purgeSubagents } from '../services/subagent.js'
import { isResumableError } from '../services/budgetAndResume.js'
import { COLLABORATION_DEFAULTS } from '../services/collaboration.js'
import { formatWorkflowRunMarkdown } from '../services/workflowEngine.js'
import { resolveEndpointWithSavedModel, normalizeSavedModel } from '../services/modelVault.js'
import { generateImageMedia, generateVideoMedia } from '../services/mediaGen.js'
import { isAbort } from '../services/errors.js'
import {
  fireShellImpact,
  setActivePanel,
  toggleSidebar,
  toggleZenMode,
  openModal,
  setMarketView,
  closeModal,
  toggleDock,
  setDockTab,
  setDockPreview,
  openArtifactCanvas,
  toggleSearchDock,
  setComposerDraft,
  appendComposerDraft,
  addComposerToken,
  removeComposerToken,
  pushToast,
  dismissToast,
  openOnboardingModal,
  closeOnboardingModal,
  setWebSearchMode,
} from './uiSlice.js'
import {
  resolveEndpointConfig,
  refreshWorkspace,
  toggleWorkspaceEnabled,
  previewWorkspaceFile,
  addWorkspaceGuardRule,
  removeWorkspaceGuardRule,
  refreshPlanning,
  createTaskPlan,
  rollbackTaskCheckpoint,
  refreshAuditLogs,
  saveAtomicMemory,
  toggleCuratedPackEnabled,
  refreshMarket,
  refreshSettingsAux,
  checkAppUpdate,
  startExpertTeamRun,
  stopExpertTeamRun,
  updateCollaborationConfig,
  startCollaborationRun,
  stopCollaborationRun,
  runWebSearch,
  extractSearchUrl,
  recordWebActivity,
  clearWebActivities,
  refreshBrowserSessions,
  closeBrowserSession,
  openSourceInForeground,
} from './domainSlice.js'

const initialVisual = readVisualPrefs()
const GROUP_MEMBERS_KEY = 'harbor.v3.group.members'
const GROUPS_STORAGE_KEY = 'harbor.v4.groups'
const DISABLED_CURATED_KEY = 'harbor.v3.disabled_curated'
const ASK_BEFORE_DESIGN_KEY = 'harbor.v3.ask_before_design'

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

const initialGroupHydrated = hydrateGroupCollection(readStorage(GROUPS_STORAGE_KEY, ''), loadSavedGroupMembers())
const initialActiveGroup = initialGroupHydrated.items.find((g) => g.id === initialGroupHydrated.activeGroupId) || initialGroupHydrated.items[0]

function persistGroups(items, activeGroupId) {
  try {
    const compact = (Array.isArray(items) ? items : []).map((g) => ({
      id: g.id,
      title: g.title,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
      routingMode: g.routingMode,
      members: g.members,
      messages: (g.messages || []).slice(-60),
      relayWireHistory: (g.relayWireHistory || []).slice(-80),
      lastArchivedName: g.lastArchivedName || '',
    }))
    writeStorage(GROUPS_STORAGE_KEY, JSON.stringify({ activeGroupId, items: compact }))
  } catch {}
}

function makeSession(title = '新对话', kind = 'chat', workspaceDir = '') {
  const now = Date.now()
  const cleanDir = String(workspaceDir || '').trim()
  const resolvedKind = cleanDir || kind === 'project' ? 'project' : 'chat'
  return ensureTree({
    id: 's_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    title: String(title || '').trim() || (resolvedKind === 'project' ? (shortFolderLabel(cleanDir) || '项目会话') : '新对话'),
    kind: resolvedKind,
    workspaceDir: cleanDir,
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
    onboardingOpen: readStorage('harbor.v5.onboarding.seen', '') !== '1',
    marketTab: 'industry',
    marketTeamId: 'software-company',
    modalOriginRect: null,     // 触发按钮坐标（用于 FLIP 平滑展开）
    zenMode: false,
    dockOpen: false,
    dockTab: 'overview',
    dockPreview: '',
    activeArtifact: null,      // { id, kind, lang, title, filename, code }
    searchDockOpen: false,
    webSearchMode: ['auto', 'visible', 'off'].includes(readStorage('harbor.v5.web_search_mode', 'auto'))
      ? readStorage('harbor.v5.web_search_mode', 'auto')
      : 'auto',
    composerDraft: '',
    composerTokens: [],
    askBeforeDesign: readStorage(ASK_BEFORE_DESIGN_KEY, '1') !== '0',
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
    pendingClarify: null,
    pendingGroupDelete: null,  // { groupId, title, fileCount }
    pendingProjectModal: null, // { id, mode: 'create'|'bind', sid, initialDir, initialTitle }
    pendingTakeover: null,     // { sid, takeoverId, url, message }
    pendingBudgetPause: null,  // { sid, kind, detail }
    activeToolProfile: null,   // { id, label, activeCount, totalCount }
    toolProfileBySid: {},
    cacheTotalsBySid: {},
    hybridSplit: { localTokens: 0, cloudTokens: 0 },
    cacheTotals: {
      promptTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, hitRate: 0,
      turnPromptTokens: 0, turnCachedTokens: 0,
      latestHitRate: 0, latestPromptTokens: 0, latestCachedTokens: 0,
      prefixHash: '', prefixLocked: false,
    },
    auditLogs: [],
    updateInfo: null,          // { latest, url, sha256, notes }
    updateProgress: null,
  },
  settings: {
    ...initialVisual,
    savedModels: loadInitialSavedModels(),
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
    items: initialGroupHydrated.items,
    activeGroupId: initialActiveGroup.id,
    title: initialActiveGroup.title,
    routingMode: initialActiveGroup.routingMode,
    members: initialActiveGroup.members,
    messages: initialActiveGroup.messages,
    relayWireHistory: initialActiveGroup.relayWireHistory,
    files: [],
    filesDir: '',
    lastArchivedName: initialActiveGroup.lastArchivedName, 
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
  plugins: createInitialPluginsSlice(),
  search: {
    activities: [],
    activeSessions: [],
    query: '',
    results: [],
    loading: false,
    extracted: null,
  },
})

let state = initKernel(initialState)
const abortBySid = new Map()
let approvalResolver = null
let clarifyResolver = null
let takeoverResolver = null
let budgetResolver = null
let groupAbortCtrl = null
let groupAbortReason = ''
const relayDemoTimers = []
let saveSessionsTimer = 0

export { getState, subscribe, useSlice, useStoreSelector }

function patchSlice(name, updater) {
  state = kernelPatchSlice(name, updater)
}

function syncRuntimeTelemetryForSid(targetSid) {
  state = kernelSyncTelemetry(targetSid)
}

/* ---- 通用 UI & 图层调度（已解耦至 state/uiSlice.js，此处统一门面再导出） ---- */
export {
  fireShellImpact,
  setActivePanel,
  toggleSidebar,
  toggleZenMode,
  openModal,
  setMarketView,
  closeModal,
  toggleDock,
  setDockTab,
  setDockPreview,
  openArtifactCanvas,
  toggleSearchDock,
  setComposerDraft,
  appendComposerDraft,
  addComposerToken,
  removeComposerToken,
  pushToast,
  dismissToast,
  openOnboardingModal,
  closeOnboardingModal,
  setWebSearchMode,
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
    patchSlice('settings', (s) => {
      const mergedModels = [...(s.savedModels || [])]
      if (Array.isArray(raw.saved_models)) {
        for (const rm of raw.saved_models) {
          const norm = normalizeSavedModel(rm)
          if (norm.model && !mergedModels.some((x) => x.id === norm.id)) mergedModels.push(norm)
        }
      }
      return {
        ...s,
        savedModels: mergedModels,
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
      }
    })
  }
  if (sessRes.status === 'fulfilled' && Array.isArray(sessRes.value) && sessRes.value.length > 0) {
    const hydrated = sessRes.value.map((x) => {
      const t = ensureTree(x)
      const dir = String(t.workspaceDir || '').trim()
      return { ...t, kind: normalizeSessionKind(t), workspaceDir: dir }
    })
    hydrated.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    patchSlice('sessions', { items: hydrated, currentId: hydrated[0].id, hydrated: true })
    if (hydrated[0].kind === 'project' && hydrated[0].workspaceDir) {
      api.setSessionWs(hydrated[0].id, hydrated[0].workspaceDir, true).catch(() => {})
    }
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
  const s = makeSession(title, 'chat', '')
  patchSlice('sessions', (st) => ({ ...st, items: [s, ...st.items], currentId: s.id }))
  patchSlice('ui', (u) => ({ ...u, activePanel: 'chat' }))
  syncRuntimeTelemetryForSid(s.id)
  api.setCurrentSid(s.id).catch(() => {})
  queuePersistSessions()
  return s
}

export async function createProjectSession({ title = '', workspaceDir = '' } = {}) {
  const cleanDir = String(workspaceDir || '').trim()
  if (!cleanDir) {
    pushToast('请先选择或输入项目工作文件夹', 'warn')
    return null
  }
  const s = makeSession(title || shortFolderLabel(cleanDir) || '项目会话', 'project', cleanDir)
  patchSlice('sessions', (st) => ({ ...st, items: [s, ...st.items], currentId: s.id }))
  patchSlice('ui', (u) => ({ ...u, activePanel: 'chat' }))
  patchSlice('workspace', (w) => ({ ...w, enabled: true, rootPath: cleanDir }))
  syncRuntimeTelemetryForSid(s.id)
  queuePersistSessions()
  try {
    await api.setCurrentSid(s.id)
    await api.setSessionWs(s.id, cleanDir, true)
    await api.setWsEnabled(s.id, true)
    await refreshWorkspace()
  } catch {}
  pushToast(`已创建项目会话「${s.title}」并绑定工作目录`, 'ok')
  return s
}

export async function bindSessionToProject(sid, workspaceDir, customTitle = '') {
  const targetId = sid || state.sessions.currentId
  const cleanDir = String(workspaceDir || '').trim()
  if (!targetId || !cleanDir) return
  invalidateSessionPrefixCache(targetId)
  updateSessionById(targetId, (s) => applyProjectWorkspace(s, cleanDir, customTitle))
  if (targetId === state.sessions.currentId) {
    patchSlice('workspace', (w) => ({ ...w, enabled: true, rootPath: cleanDir }))
  }
  try {
    await api.setSessionWs(targetId, cleanDir, true)
    await api.setWsEnabled(targetId, true)
    if (targetId === state.sessions.currentId) await refreshWorkspace()
  } catch {}
  pushToast(`已绑定项目工作目录：${shortFolderLabel(cleanDir)}`, 'ok')
}

export async function convertSessionToNormal(sid) {
  const targetId = sid || state.sessions.currentId
  if (!targetId) return
  invalidateSessionPrefixCache(targetId)
  updateSessionById(targetId, (s) => clearProjectWorkspace(s))
  try {
    await api.setSessionWs(targetId, '', false)
    if (targetId === state.sessions.currentId) await refreshWorkspace()
  } catch {}
  pushToast('已转为普通会话（解除专属项目目录绑定）', 'info')
}

export function openProjectSessionModal(mode = 'create', sid = '') {
  const target = mode === 'bind'
    ? state.sessions.items.find((x) => x.id === (sid || state.sessions.currentId))
    : null
  patchSlice('runtime', {
    pendingProjectModal: {
      id: 'pm_' + Date.now(),
      mode: mode === 'bind' ? 'bind' : 'create',
      sid: target ? target.id : '',
      initialDir: (target && target.workspaceDir) || '',
      initialTitle: target && target.title !== '新对话' ? target.title : '',
    },
  })
}

export function closeProjectSessionModal() {
  patchSlice('runtime', { pendingProjectModal: null })
}

export async function confirmProjectSessionModal({ mode = 'create', sid = '', workspaceDir = '', title = '' } = {}) {
  patchSlice('runtime', { pendingProjectModal: null })
  if (mode === 'bind' && sid) {
    return bindSessionToProject(sid, workspaceDir, title)
  }
  return createProjectSession({ title, workspaceDir })
}

export async function browseProjectFolder() {
  try {
    const res = await api.pickFolder(state.sessions.currentId || '')
    return (res && (res.path || res.dir || res.ws)) || ''
  } catch (e) {
    pushToast(`浏览文件夹失败：${e.message}`, 'err')
    return ''
  }
}

export function selectSession(sid) {
  const target = state.sessions.items.find((x) => x.id === sid)
  if (!target) return
  patchSlice('sessions', (st) => ({ ...st, currentId: sid }))
  patchSlice('ui', (u) => ({ ...u, activePanel: 'chat' }))
  syncRuntimeTelemetryForSid(sid)
  api.setCurrentSid(sid).catch(() => {})
  if (normalizeSessionKind(target) === 'project' && target.workspaceDir) {
    patchSlice('workspace', (w) => ({ ...w, enabled: true, rootPath: target.workspaceDir }))
    api.setSessionWs(sid, target.workspaceDir, true).then(() => refreshWorkspace()).catch(() => {})
  } else {
    refreshWorkspace().catch(() => {})
  }
}

export function deleteSession(sid) {
  stopSessionRun(sid)
  purgeSubagents(sid)
  invalidateSessionPrefixCache(sid)
  let nextCurrentId = ''
  patchSlice('sessions', (st) => {
    const rest = st.items.filter((x) => x.id !== sid)
    const items = rest.length ? rest : [makeSession('新对话')]
    nextCurrentId = st.currentId === sid ? items[0].id : st.currentId
    return { ...st, items, currentId: nextCurrentId }
  })
  patchSlice('runtime', (r) => {
    const runsBySid = { ...r.runsBySid }; delete runsBySid[sid]
    const queuesBySid = { ...r.queuesBySid }; delete queuesBySid[sid]
    const subagentsBySid = { ...r.subagentsBySid }; delete subagentsBySid[sid]
    const cacheTotalsBySid = { ...(r.cacheTotalsBySid || {}) }; delete cacheTotalsBySid[sid]
    const toolProfileBySid = { ...(r.toolProfileBySid || {}) }; delete toolProfileBySid[sid]
    return {
      ...r,
      runsBySid,
      queuesBySid,
      subagentsBySid,
      cacheTotalsBySid,
      toolProfileBySid,
      cacheTotals: cacheTotalsBySid[nextCurrentId] || { ...EMPTY_CACHE_TOTALS },
      activeToolProfile: toolProfileBySid[nextCurrentId] || null,
    }
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

export function setSessionModelOverride(sid, modelProfileId = '') {
  const targetId = sid || state.sessions.currentId
  if (!targetId) return
  const cleanId = String(modelProfileId || '').trim()
  invalidateSessionPrefixCache(targetId)
  updateSessionById(targetId, (s) => ({ ...s, modelProfileId: cleanId, updatedAt: Date.now() }))
  if (cleanId) {
    const hit = (state.settings.savedModels || []).find((m) => m.id === cleanId || m.model === cleanId)
    pushToast(`本会话已切换模型为「${hit ? hit.label : cleanId}」`, 'ok')
  } else {
    pushToast('本会话已恢复跟随全局默认模型', 'info')
  }
}

export function renameSession(sid, nextTitle) {
  const clean = String(nextTitle || '').trim()
  if (!sid || !clean) return
  updateSessionById(sid, (s) => ({ ...s, title: clean.slice(0, 48), updatedAt: Date.now() }))
  pushToast(`已重命名会话为「${clean.slice(0, 24)}」`, 'ok')
}

export function renameGroup(groupId, nextTitle) {
  const clean = String(nextTitle || '').trim()
  if (!groupId || !clean) return
  const trimmed = clean.slice(0, 48)
  let savedItems = state.group.items
  patchSlice('group', (g) => {
    const items = (g.items || []).map((item) => (
      item.id === groupId ? { ...item, title: trimmed, updatedAt: Date.now() } : item
    ))
    savedItems = items
    return {
      ...g,
      items,
      ...(g.activeGroupId === groupId ? { title: trimmed } : {}),
    }
  })
  persistGroups(savedItems, state.group.activeGroupId)
  pushToast(`已重命名群聊为「${trimmed.slice(0, 24)}」`, 'ok')
}

export function exportCurrentSessionMarkdown(sid) {
  const target = state.sessions.items.find((x) => x.id === (sid || state.sessions.currentId))
  if (!target || !(target.messages || []).length) {
    pushToast('当前会话尚无消息可导出', 'info')
    return false
  }
  const md = formatSessionAsMarkdown(target)
  const fname = safeExportFilename(target.title, '.md')
  const ok = downloadTextFile(fname, md, 'text/markdown;charset=utf-8')
  if (ok) pushToast(`已导出会话纪要：${fname}`, 'ok')
  return ok
}

export function exportCurrentGroupMarkdown() {
  if (!(state.group.messages || []).length) {
    pushToast('当前群聊尚无记录可导出', 'info')
    return false
  }
  const md = formatGroupAsMarkdown(state.group)
  const fname = safeExportFilename(`群聊-${state.group.title}`, '.md')
  const ok = downloadTextFile(fname, md, 'text/markdown;charset=utf-8')
  if (ok) pushToast(`已导出群聊纪要：${fname}`, 'ok')
  return ok
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
    saved_models: state.settings.savedModels || rawMerged.saved_models || [],
  }
  const prevCfg = state.settings.backendConfig || {}
  if (prevCfg.system_prompt !== merged.system_prompt || prevCfg.tool_mode !== merged.tool_mode) {
    invalidateSessionPrefixCache()
  }
  patchSlice('settings', (s) => ({ ...s, backendConfig: merged }))
  await api.saveConfig(merged)
  pushToast('配置已保存到本机 config.json', 'ok')
}

export { resolveEndpointConfig }

/* ---- 并行 Run、审批、验证码接管与熔断协调（R23 性能：高频流式 Delta 按 rAF 合并提交至 60fps） ---- */
const _pendingRunPatches = new Map()
let _runFlushRaf = 0

function flushPendingRunPatches(targetSid = '') {
  if (targetSid) {
    const p = _pendingRunPatches.get(targetSid)
    if (!p) return
    _pendingRunPatches.delete(targetSid)
    patchSlice('runtime', (r) => {
      const prev = r.runsBySid[targetSid] || { phase: 'idle', stageLabel: '', reasoning: '', answer: '', cps: 0, elapsedMs: 0, tools: [], diffs: [] }
      return { ...r, runsBySid: { ...r.runsBySid, [targetSid]: { ...prev, ...p } } }
    })
    return
  }
  _runFlushRaf = 0
  if (_pendingRunPatches.size === 0) return
  const batch = Array.from(_pendingRunPatches.entries())
  _pendingRunPatches.clear()
  patchSlice('runtime', (r) => {
    const nextMap = { ...r.runsBySid }
    for (const [sId, patchObj] of batch) {
      const prev = nextMap[sId] || { phase: 'idle', stageLabel: '', reasoning: '', answer: '', cps: 0, elapsedMs: 0, tools: [], diffs: [] }
      nextMap[sId] = { ...prev, ...patchObj }
    }
    return { ...r, runsBySid: nextMap }
  })
}

function patchRun(sid, updater) {
  if (typeof updater !== 'function' && updater && (updater.phase === 'streaming' || updater.phase === 'thinking') && !updater.tools && !updater.diffs && !updater.error && typeof requestAnimationFrame === 'function') {
    const prevQueued = _pendingRunPatches.get(sid) || {}
    _pendingRunPatches.set(sid, { ...prevQueued, ...updater })
    if (!_runFlushRaf) _runFlushRaf = requestAnimationFrame(() => flushPendingRunPatches())
    return
  }
  flushPendingRunPatches(sid)
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
  if (state.runtime.pendingClarify && state.runtime.pendingClarify.sid === sid && clarifyResolver) {
    const r = clarifyResolver; clarifyResolver = null; patchSlice('runtime', { pendingClarify: null }); r({ mode: 'cancelled', answers: {}, customNote: '', summary: '用户已中止当前任务' })
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

export function setAskBeforeDesign(enabled) {
  const next = !!enabled
  try { writeStorage(ASK_BEFORE_DESIGN_KEY, next ? '1' : '0') } catch {}
  patchSlice('ui', { askBeforeDesign: next })
}

export function resolvePendingApproval(decision) {
  if (!approvalResolver) return
  const r = approvalResolver; approvalResolver = null
  patchSlice('runtime', { pendingApproval: null })
  r(decision)
}

export function resolvePendingClarify(answer) {
  if (!clarifyResolver) return
  const r = clarifyResolver; clarifyResolver = null
  patchSlice('runtime', { pendingClarify: null })
  r(answer)
}

function openClarifyPrompt(req) {
  return new Promise((resolve) => {
    clarifyResolver = resolve
    patchSlice('runtime', { pendingClarify: { id: 'cl_' + Date.now(), ...req } })
  })
}

function _syncActiveGroupIntoItems(patchFields = {}) {
  let savedItems = state.group.items
  let savedActiveId = state.group.activeGroupId
  patchSlice('group', (g) => {
    const merged = { ...g, ...patchFields }
    const now = Date.now()
    const items = (g.items || []).map((item) => (
      item.id === merged.activeGroupId
        ? {
          ...item,
          title: merged.title || item.title,
          routingMode: merged.routingMode,
          members: merged.members,
          messages: merged.messages,
          relayWireHistory: merged.relayWireHistory,
          lastArchivedName: merged.lastArchivedName || '',
          updatedAt: now,
        }
        : item
    ))
    savedItems = items
    savedActiveId = merged.activeGroupId
    return { ...merged, items }
  })
  persistGroups(savedItems, savedActiveId)
}

export function createNewGroup(title = '') {
  if (state.group.running) abortGroupRelay()
  const count = (state.group.items || []).length + 1
  const fresh = createIsolatedGroup({
    title: String(title || '').trim() || `新群聊 ${count}`,
    members: state.group.members,
    routingMode: state.group.routingMode,
  })
  const nextItems = [fresh, ...(state.group.items || [])]
  patchSlice('group', {
    items: nextItems,
    activeGroupId: fresh.id,
    title: fresh.title,
    routingMode: fresh.routingMode,
    members: fresh.members,
    messages: [],
    relayWireHistory: [],
    files: [],
    filesDir: '',
    lastArchivedName: '',
    status: 'idle',
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
    checkpoint: null,
  })
  persistGroups(nextItems, fresh.id)
  syncRuntimeTelemetryForSid(fresh.id)
  refreshGroupFiles(fresh.id).catch(() => {})
  pushToast(`已创建全新隔离群聊「${fresh.title}」（专属空白群文件空间）`, 'ok')
  return fresh
}

export function selectGroup(groupId) {
  const target = (state.group.items || []).find((x) => x.id === groupId)
  if (!target || target.id === state.group.activeGroupId) return
  if (state.group.running) abortGroupRelay()
  _syncActiveGroupIntoItems()
  patchSlice('group', {
    activeGroupId: target.id,
    title: target.title,
    routingMode: target.routingMode,
    members: target.members,
    messages: target.messages || [],
    relayWireHistory: target.relayWireHistory || [],
    files: [],
    filesDir: '',
    lastArchivedName: target.lastArchivedName || '',
    status: 'idle',
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
    checkpoint: null,
  })
  persistGroups(state.group.items, target.id)
  syncRuntimeTelemetryForSid(target.id)
  refreshGroupFiles(target.id).catch(() => {})
}

export async function requestDeleteGroup(groupId = '') {
  const gid = groupId || state.group.activeGroupId
  const target = (state.group.items || []).find((x) => x.id === gid)
  if (!target) return
  let fileCount = gid === state.group.activeGroupId ? (state.group.files || []).length : 0
  try {
    const res = await api.groupFilesList(gid, target.title)
    if (res && Array.isArray(res.files)) fileCount = res.files.length
  } catch {}
  patchSlice('runtime', {
    pendingGroupDelete: { groupId: gid, title: target.title, fileCount },
  })
}

export function cancelDeleteGroup() {
  patchSlice('runtime', { pendingGroupDelete: null })
}

export async function confirmDeleteGroup({ groupId, deleteFiles = true } = {}) {
  const gid = groupId || (state.runtime.pendingGroupDelete && state.runtime.pendingGroupDelete.groupId) || state.group.activeGroupId
  patchSlice('runtime', { pendingGroupDelete: null })
  if (!gid) return

  if (state.group.activeGroupId === gid && state.group.running) abortGroupRelay()
  invalidateSessionPrefixCache(gid)

  if (deleteFiles) {
    try {
      await api.groupFilesDelete(gid, '__PURGE_ALL__')
    } catch {}
  }
  api.sessionPurge(gid, []).catch(() => {})

  const nextCol = removeGroupFromCollection(state.group.items, state.group.activeGroupId, gid, state.group.members)
  const nextActive = nextCol.items.find((x) => x.id === nextCol.activeGroupId) || nextCol.items[0]

  patchSlice('group', {
    items: nextCol.items,
    activeGroupId: nextActive.id,
    title: nextActive.title,
    routingMode: nextActive.routingMode,
    members: nextActive.members,
    messages: nextActive.messages || [],
    relayWireHistory: nextActive.relayWireHistory || [],
    files: [],
    filesDir: '',
    lastArchivedName: nextActive.lastArchivedName || '',
    status: 'idle',
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
    checkpoint: null,
  })
  patchSlice('runtime', (r) => {
    const cacheTotalsBySid = { ...(r.cacheTotalsBySid || {}) }; delete cacheTotalsBySid[gid]
    const toolProfileBySid = { ...(r.toolProfileBySid || {}) }; delete toolProfileBySid[gid]
    return {
      ...r,
      cacheTotalsBySid,
      toolProfileBySid,
      cacheTotals: cacheTotalsBySid[nextActive.id] || { ...EMPTY_CACHE_TOTALS },
      activeToolProfile: toolProfileBySid[nextActive.id] || null,
    }
  })
  persistGroups(nextCol.items, nextActive.id)
  await refreshGroupFiles(nextActive.id)
  pushToast(
    deleteFiles
      ? '已彻底删除该群聊及其专属群文件，并切换至全新隔离群聊'
      : '已删除该群聊（本地群文件已留存原归档目录，新群聊完全隔离）',
    'ok'
  )
}

export function clearGroupSession() {
  return createNewGroup()
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

  // 内置斜杠命令路由（/compact /sub /demo /clear /plan /zen /export /project）
  if (clean === '/compact') { compactSessionNow(sid, true); return }
  if (clean === '/clear') { createNewSession('新对话'); return }
  if (clean === '/demo') { triggerFourActShowcase(sid); return }
  if (clean === '/zen') { toggleZenMode(); return }
  if (clean === '/export') { exportCurrentSessionMarkdown(sid); return }
  if (clean === '/project') { openProjectSessionModal('bind', sid); return }
  if (clean === '/wf') { setWorkflowViewTab('studio'); setActivePanel('workflow'); return }
  if (clean === '/plugins') { setWorkflowViewTab('plugins'); setActivePanel('workflow'); return }
  const plugCmd = collectPluginSlashCommands(state.plugins.plugins).find((c) => clean === c.label || clean.startsWith(c.label + ' '))
  if (plugCmd) {
    if (plugCmd.action === 'open_plugins') { setWorkflowViewTab('plugins'); setActivePanel('workflow'); return }
    if (plugCmd.action === 'open_workflow') { setWorkflowViewTab('studio'); setActivePanel('workflow'); return }
    if (plugCmd.workflowId) {
      const restInput = clean.slice(plugCmd.label.length).trim()
      setWorkflowViewTab('studio')
      setActivePanel('workflow')
      selectWorkflow(plugCmd.workflowId)
      if (restInput) runActiveWorkflow({ workflowId: plugCmd.workflowId, input: restInput })
      return
    }
  }
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

  const ep = resolveEndpointWithSavedModel(
    targetSession.modelProfileId,
    resolveEndpointConfig(),
    state.settings.savedModels
  )
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
    _beginCacheTurn(sid)
    const result = await runAgentConversation({
      sid,
      session: targetSession,
      userQuery: userText,
      historyMessages: targetSession.messages,
      endpointConfig: ep,
      expertPrompt,
      workspacePath: (targetSession && targetSession.workspaceDir) || state.workspace.rootPath,
      sessionBudgetRmb: Number(state.settings.backendConfig.session_budget) || 0,
      correctiveDirective: opts.correctiveDirective || '',
      pluginTools: collectPluginTools(state.plugins.plugins),
      pluginDirectives: runPluginBeforePromptHooks(state.plugins.plugins),
      pluginToolDispatcher: (toolName, args) => dispatchPluginTool(toolName, args, {
        plugins: state.plugins.plugins,
        workflows: state.plugins.workflows,
      }),
      mediaToolDispatcher: (toolName, args, ctx) => dispatchMediaTool(toolName, args, ctx),
      webSearchMode: state.ui.webSearchMode || 'auto',
      askBeforeDesign: state.ui.askBeforeDesign,
      signal: ctrl.signal,
      onEvent: (ev) => {
        patchRun(sid, ev)
        if (ev && ev.webActivity) recordWebActivity(ev.webActivity)
        if (ev && ev.toolProfile) {
          patchSlice('runtime', (r) => ({
            ...r,
            toolProfileBySid: { ...(r.toolProfileBySid || {}), [sid]: ev.toolProfile },
            ...(activeViewSid() === sid ? { activeToolProfile: ev.toolProfile } : {}),
          }))
        }
        if (ev && ev.cacheStats) _recordCacheStats(ev.cacheStats, sid)
      },
      requestApproval: (req) => new Promise((resolve) => {
        approvalResolver = resolve
        patchSlice('runtime', { pendingApproval: { id: 'ap_' + Date.now(), sid, ...req } })
      }),
      requestClarify: (req) => openClarifyPrompt({ sid, ...req }),
      requestTakeover: (tk) => new Promise((resolve) => {
        takeoverResolver = resolve
        patchSlice('runtime', { pendingTakeover: { sid, ...tk } })
      }),
      requestBudgetDecision: (bp) => new Promise((resolve) => {
        budgetResolver = resolve
        patchSlice('runtime', { pendingBudgetPause: { sid, ...bp } })
      }),
    })

    if (!ctrl.signal.aborted && result && (result.content || result.reasoning)) {
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
          ...(Array.isArray(result.webSources) && result.webSources.length ? { webSources: result.webSources } : {}),
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

/* ---- 业务域统一出口（已解耦至 state/domainSlice.js） ---- */
export {
  startExpertTeamRun,
  stopExpertTeamRun,
  updateCollaborationConfig,
  startCollaborationRun,
  stopCollaborationRun,
  refreshWorkspace,
  toggleWorkspaceEnabled,
  previewWorkspaceFile,
  addWorkspaceGuardRule,
  removeWorkspaceGuardRule,
  refreshPlanning,
  createTaskPlan,
  rollbackTaskCheckpoint,
  refreshAuditLogs,
  saveAtomicMemory,
  toggleCuratedPackEnabled,
  refreshMarket,
  refreshSettingsAux,
  checkAppUpdate,
  runWebSearch,
  extractSearchUrl,
  recordWebActivity,
  clearWebActivities,
  refreshBrowserSessions,
  closeBrowserSession,
  openSourceInForeground,
}

export async function setWorkspacePath(dirPath) {
  const cleanDir = String(dirPath || '').trim()
  if (!cleanDir) return
  const sid = state.sessions.currentId
  invalidateSessionPrefixCache(sid)
  updateSessionById(sid, (s) => applyProjectWorkspace(s, cleanDir))
  await api.setSessionWs(sid, cleanDir, true)
  await refreshWorkspace()
  pushToast(`工作区已切换至 ${cleanDir}（已绑定为当前项目会话）`, 'ok')
}

export async function pickWorkspaceFolder() {
  const picked = await browseProjectFolder()
  if (picked) await setWorkspacePath(picked)
  return picked
}

export function setGroupRoutingMode(mode) {
  _syncActiveGroupIntoItems({ routingMode: mode === 'all' ? 'all' : 'smart' })
}

export function addGroupMember(memberInput) {
  const next = normalizeGroupMember(memberInput, state.group.members.length)
  const list = [...state.group.members, next]
  saveGroupMembers(list)
  _syncActiveGroupIntoItems({ members: list })
  pushToast(`已添加角色「${next.name}」`, 'ok')
}

export function updateGroupMember(id, patch) {
  const list = state.group.members.map((m, idx) => (m.id === id ? normalizeGroupMember({ ...m, ...patch, id }, idx) : m))
  saveGroupMembers(list)
  _syncActiveGroupIntoItems({ members: list })
}

export function removeGroupMember(id) {
  if (state.group.members.length <= 1) {
    pushToast('至少需要保留 1 名群聊角色', 'warn')
    return
  }
  const list = state.group.members.filter((m) => m.id !== id)
  saveGroupMembers(list)
  _syncActiveGroupIntoItems({ members: list })
}

export function applyGroupPreset(presetKey) {
  const preset = GROUP_ROSTER_PRESETS[presetKey]
  if (!preset) return
  const list = preset.members.map((m, i) => normalizeGroupMember(m, i))
  saveGroupMembers(list)
  _syncActiveGroupIntoItems({ members: list, routingWarning: '' })
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
  if (state.runtime.pendingApproval && state.runtime.pendingApproval.sid === 'group' && approvalResolver) {
    const r = approvalResolver; approvalResolver = null; patchSlice('runtime', { pendingApproval: null }); r({ ok: false, denyReason: '群聊接力已中止' })
  }
  if (state.runtime.pendingClarify && state.runtime.pendingClarify.sid === 'group' && clarifyResolver) {
    const r = clarifyResolver; clarifyResolver = null; patchSlice('runtime', { pendingClarify: null }); r({ mode: 'cancelled', answers: {}, customNote: '', summary: '群聊接力已中止' })
  }
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
    autonomous: !!ck.autonomous,
  })
}

function _formatPct1(hit, total) {
  if (!total || total <= 0) return 0
  const raw = (hit / total) * 100
  if (hit < total) return Math.min(99.9, Math.floor(raw * 10) / 10)
  return 100
}

function _beginCacheTurn(scopeSid = '') {
  const key = String(scopeSid || state.sessions.currentId || 'default')
  patchSlice('runtime', (r) => {
    const prev = (r.cacheTotalsBySid && r.cacheTotalsBySid[key]) || { ...EMPTY_CACHE_TOTALS }
    const next = { ...prev, turnPromptTokens: 0, turnCachedTokens: 0 }
    return {
      ...r,
      cacheTotalsBySid: { ...(r.cacheTotalsBySid || {}), [key]: next },
      ...(activeViewSid() === key ? { cacheTotals: next } : {}),
    }
  })
}

function _recordCacheStats(cs, scopeSid = '') {
  if (!cs) return
  const key = String(scopeSid || state.sessions.currentId || 'default')
  patchSlice('runtime', (r) => {
    const prev = (r.cacheTotalsBySid && r.cacheTotalsBySid[key]) || { ...EMPTY_CACHE_TOTALS }
    const addPt = Number(cs.promptTokens) || 0
    const addCt = Number(cs.cachedTokens) || 0
    const addWt = Number(cs.cacheWriteTokens) || 0
    const pt = prev.promptTokens + addPt
    const ct = prev.cachedTokens + addCt
    const wt = prev.cacheWriteTokens + addWt
    const tPt = (prev.turnPromptTokens || 0) + addPt
    const tCt = (prev.turnCachedTokens || 0) + addCt
    const turnHit = tPt > 0 ? _formatPct1(tCt, tPt) : prev.latestHitRate
    const next = {
      promptTokens: pt,
      cachedTokens: ct,
      cacheWriteTokens: wt,
      hitRate: pt > 0 ? _formatPct1(ct, pt) : prev.hitRate,
      turnPromptTokens: tPt,
      turnCachedTokens: tCt,
      latestHitRate: turnHit,
      latestPromptTokens: addPt || prev.latestPromptTokens,
      latestCachedTokens: addCt,
      prefixHash: cs.prefixHash || prev.prefixHash,
      prefixLocked: !!cs.prefixLocked,
    }
    return {
      ...r,
      cacheTotalsBySid: { ...(r.cacheTotalsBySid || {}), [key]: next },
      ...(activeViewSid() === key ? { cacheTotals: next } : {}),
    }
  })
}

export async function runGroupRelay(topic) {
  const clean = String(topic || '').trim()
  if (!clean || state.group.running) return
  while (relayDemoTimers.length) clearTimeout(relayDemoTimers.pop())

  const groupSid = state.group.activeGroupId
  _beginCacheTurn(groupSid)

  const recentGroupText = (state.group.messages || [])
    .slice(-4)
    .map((m) => String(m && m.content || '').slice(0, 240))
    .join('\n')

  const isSmart = state.group.routingMode !== 'all'
  const autonomous = isAutonomousAuthorized(clean) || !state.ui.askBeforeDesign
  const fallbackRouted = routeGroupMembers(clean, state.group.members, state.group.routingMode, recentGroupText)
  const autoTitle = (!state.group.messages.length && /^新群聊/.test(state.group.title || ''))
    ? clean.slice(0, 20)
    : state.group.title

  _syncActiveGroupIntoItems({
    title: autoTitle,
    lastIntent: fallbackRouted.intent,
    routingWarning: isSmart ? '' : fallbackRouted.missingCapabilityWarning,
    messages: [...state.group.messages, { id: 'gm_' + Date.now(), author: '我（发起人）', role: 'user', content: clean }],
  })

  let plannedMembers = fallbackRouted.selected.map((m) => ({ ...m, taskBrief: m.persona }))
  let intentLabel = fallbackRouted.intent.label
  const relayContext = Array.isArray(state.group.relayWireHistory)
    ? state.group.relayWireHistory.map((x) => ({ ...x }))
    : []

  if (isSmart && state.group.members.length > 0) {
    const baseEp = resolveEndpointConfig()
    groupAbortReason = ''
    groupAbortCtrl = new AbortController()

    patchSlice('group', {
      running: true,
      status: 'planning',
      activeMembers: state.group.members,
      activeIndex: -1,
      handoffFrom: '',
      handoffTo: '',
      liveContent: '',
      liveReasoning: '',
      liveTools: [],
      cps: 0,
      checkpoint: null,
    })

    try {
      const modPrompt = buildModeratorPrompt(clean, state.group.members, recentGroupText, { allowClarify: !autonomous })
      const modHistory = [...relayContext, { role: 'user', content: modPrompt }]
      const modRes = await runAgentConversation({
        sid: groupSid,
        isolatedGroupId: groupSid,
        userQuery: clean,
        historyMessages: modHistory,
        endpointConfig: { ...baseEp, max_tokens: Math.min(1200, Number(baseEp.max_tokens) || 1200) },
        workspacePath: state.workspace.rootPath,
        allowTools: false,
        askBeforeDesign: false,
        maxRounds: 1,
        skipMemoryRecall: true,
        skipSelfCheck: true,
        signal: groupAbortCtrl.signal,
        onEvent: (ev) => {
          if (ev && ev.toolProfile) {
            patchSlice('runtime', (r) => ({
              ...r,
              toolProfileBySid: { ...(r.toolProfileBySid || {}), [groupSid]: ev.toolProfile },
              activeToolProfile: ev.toolProfile,
            }))
          }
          if (ev && ev.cacheStats) _recordCacheStats(ev.cacheStats, groupSid)
          if (ev && typeof ev.cps === 'number') patchSlice('group', { cps: ev.cps })
        },
      })

      if (groupAbortCtrl.signal.aborted) {
        patchSlice('group', { running: false, status: 'idle', cps: 0 })
        return
      }

      const modRawReply = String((modRes && modRes.content) || '').trim()
      const planObj = parseModeratorPlan(modRawReply, state.group.members, fallbackRouted)
      plannedMembers = planObj.selected
      intentLabel = planObj.intentLabel

      // 保持与主持人请求 100% 前缀连续性，第 1 棒直接命中主持人刚预热的 KV-Cache！
      relayContext.push({ role: 'user', content: (modRes && modRes.wiredUserContent) || modPrompt })
      if (modRawReply) relayContext.push({ role: 'assistant', content: modRawReply })

      let userClarifySummary = ''
      if (!autonomous && planObj.clarify && Array.isArray(planObj.clarify.questions) && planObj.clarify.questions.length) {
        const chosen = await openClarifyPrompt({
          sid: 'group',
          title: planObj.clarify.title || '请先确认效果方向，再由专家团精准落地',
          subtitle: planObj.clarify.subtitle || planObj.analysis,
          allow_custom: true,
          questions: planObj.clarify.questions,
        })
        userClarifySummary = (chosen && chosen.summary) || ''
        if (userClarifySummary) {
          relayContext.push({
            role: 'user',
            content: `【用户已拍板效果方向（全员必须严格遵守）】\n${userClarifySummary}`,
          })
        }
      }

      const dispatchCardMd = [
        `**调度策略**：${planObj.analysis}`,
        '',
        `**动态接力路线**：\`${planObj.routeChain}\``,
        ...(userClarifySummary ? ['', '**已确认效果偏好**：', userClarifySummary] : []),
        '',
        ...plannedMembers.map((m, idx) =>
          `${idx + 1}. **${m.name}**${m.model ? ` \`${m.model}\`` : ''}：${m.taskBrief || m.persona}`
        ),
      ].join('\n')

      patchSlice('group', (g) => ({
        ...g,
        lastIntent: { ...fallbackRouted.intent, label: intentLabel },
        relayWireHistory: [...relayContext],
        messages: [
          ...g.messages,
          {
            id: 'gm_mod_' + Date.now(),
            author: '🎙 主持人（智能调度）',
            model: baseEp.model,
            role: 'assistant',
            isModerator: true,
            content: dispatchCardMd,
            tools: [],
          },
        ],
      }))
    } catch (e) {
      if (isAbort(e)) {
        patchSlice('group', { running: false, status: 'idle', cps: 0 })
        return
      }
      relayContext.push({ role: 'user', content: clean })
      const fbPlan = parseModeratorPlan('', state.group.members, fallbackRouted)
      plannedMembers = fbPlan.selected
      intentLabel = fbPlan.intentLabel
    }
  } else {
    relayContext.push({ role: 'user', content: clean })
  }

  return _executeGroupRelayLoop({
    topic: clean,
    plannedMembers,
    startIndex: 0,
    relayContext,
    intentLabel,
    autonomous,
  })
}

async function _executeGroupRelayLoop({ topic, plannedMembers, startIndex, relayContext, intentLabel, autonomous = false }) {
  const baseEp = resolveEndpointConfig()
  const latestMembers = plannedMembers.map((pm) => {
    const fresh = state.group.members.find((m) => m.id === pm.id)
    return fresh ? { ...fresh, taskBrief: pm.taskBrief || fresh.persona } : pm
  })
  const groupSid = state.group.activeGroupId

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
      const nextMember = latestMembers[i + 1] || null
      if (groupAbortCtrl.signal.aborted) break

      if (i > startIndex) {
        const prevName = latestMembers[i - 1].name
        patchSlice('group', { activeIndex: i, handoffFrom: prevName, handoffTo: m.name, liveContent: '', liveReasoning: '', liveTools: [], cps: 0 })
        await new Promise((r) => setTimeout(r, 460))
        if (groupAbortCtrl.signal.aborted) break
      }

      patchSlice('group', { activeIndex: i, handoffFrom: '', handoffTo: '', liveContent: '', liveReasoning: '', liveTools: [], cps: 0 })

      const resolvedMemberEp = resolveEndpointWithSavedModel(m.model, baseEp, state.settings.savedModels)
      const memberEp = {
        ...resolvedMemberEp,
        baseUrl: m.baseUrl || resolvedMemberEp.baseUrl,
        max_tokens: m.maxTokens > 0 ? m.maxTokens : resolvedMemberEp.max_tokens,
        reasoning_effort: (m.reasoningTier && m.reasoningTier !== 'auto') ? m.reasoningTier : resolvedMemberEp.reasoning_effort,
        thinking_budget: m.customThinkingBudget > 0 ? m.customThinkingBudget : resolvedMemberEp.thinking_budget,
      }

      const canUseTools = m.allowTools !== false && memberEp.tool_mode !== 'off'
      const handoffDirective = nextMember
        ? `完成你的部分后，明确列出交接给下一棒「${nextMember.name}」（其重点：${nextMember.taskBrief || nextMember.persona}）的关键成果与文件路径。`
        : '你是本轮最后一棒，请做好最终整合与收口总结。'

      const roleBatonMsg = {
        role: 'user',
        content:
          `【主持人点将 · 第 ${i + 1}/${latestMembers.length} 棒 · 当前角色：${m.name}】\n` +
          `• 主持人分配本棒任务：${m.taskBrief || m.persona}\n` +
          `• 角色专长：${m.persona}（能力：${(m.capabilities || ['text']).join(' / ')}）\n` +
          `• 交接要求：${handoffDirective}\n` +
          (canUseTools
            ? '• 工具要求：需要创建/修改代码或文件（如网页、脚本、配置）或执行验证命令时，请直接调用工作区工具实际落地，回答里只给出清晰简明的交付摘要与路径。'
            : '• 输出要求：输出简洁高密度的结构化交付。'),
      }

      const turnHistory = [...relayContext, roleBatonMsg]
      const res = await runAgentConversation({
        sid: groupSid,
        isolatedGroupId: groupSid,
        userQuery: i === 0 ? topic : '',
        historyMessages: turnHistory,
        endpointConfig: memberEp,
        workspacePath: state.workspace.rootPath,
        allowTools: canUseTools,
        pluginTools: collectPluginTools(state.plugins.plugins),
        pluginToolDispatcher: (toolName, args) => dispatchPluginTool(toolName, args, {
          plugins: state.plugins.plugins,
          workflows: state.plugins.workflows,
        }),
        mediaToolDispatcher: (toolName, args, ctx) => dispatchMediaTool(toolName, args, ctx),
        webSearchMode: state.ui.webSearchMode || 'auto',
        askBeforeDesign: !autonomous && i <= 1,
        maxRounds: canUseTools ? 8 : 1,
        skipMemoryRecall: true,
        skipSelfCheck: true,
        signal: groupAbortCtrl.signal,
        onEvent: (ev) => {
          if (ev && ev.toolProfile) {
            patchSlice('runtime', (r) => ({
              ...r,
              toolProfileBySid: { ...(r.toolProfileBySid || {}), [groupSid]: ev.toolProfile },
              activeToolProfile: ev.toolProfile,
            }))
          }
          if (ev && ev.cacheStats) _recordCacheStats(ev.cacheStats, groupSid)
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
        requestClarify: (req) => openClarifyPrompt({ sid: 'group', ...req }),
      })

      const reply = String((res && res.content) || '').trim()
      const usedTools = (res && Array.isArray(res.tools)) ? res.tools : []
      relayContext.push({
        role: 'user',
        content: (res && res.wiredUserContent) || roleBatonMsg.content,
      })
      if (res && Array.isArray(res.wireTrail) && res.wireTrail.length) {
        for (const step of res.wireTrail) relayContext.push(step)
      }
      relayContext.push({ role: 'assistant', content: reply })

      patchSlice('group', (g) => ({
        ...g,
        liveContent: '',
        liveReasoning: '',
        liveTools: [],
        cps: 0,
        relayWireHistory: [...relayContext],
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
        .slice(-(latestMembers.length + 1))
        .filter((x) => x && x.role === 'assistant' && x.content)
        .map((x) => `【${x.author}${x.model ? ` (${x.model})` : ''}】\n${x.content}`)
      const handoff = `【交接文档】\n议题：${topic}\n\n` + assistantSections.join('\n\n---\n\n')
      let archivedName = ''
      try {
        const w = await api.groupFilesWrite(groupSid, state.group.title || '群聊', '主持人', topic.slice(0, 32), handoff)
        archivedName = (w && (w.name || (w.file && w.file.name))) || ''
      } catch {}
      await refreshGroupFiles(groupSid)
      _syncActiveGroupIntoItems({
        running: false,
        status: 'done',
        activeIndex: latestMembers.length,
        handoffFrom: '',
        handoffTo: '',
        liveTools: [],
        cps: 0,
        checkpoint: null,
        lastArchivedName: archivedName,
        relayWireHistory: [...relayContext],
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
          checkpoint: { topic, plannedMembers: latestMembers, nextIndex: currentIdx, relayContext, intentLabel, autonomous },
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
        checkpoint: { topic, plannedMembers: latestMembers, nextIndex: currentIdx, relayContext, intentLabel, autonomous },
      })
      pushToast(`接力异常（可点继续重试当前棒）：${e.message}`, 'err')
    }
  } finally {
    groupAbortCtrl = null
  }
}

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

export async function refreshGroupFiles(explicitGroupId = '') {
  const gid = explicitGroupId || state.group.activeGroupId
  try {
    const res = await api.groupFilesList(gid, state.group.title || '群聊')
    if (gid !== state.group.activeGroupId) return
    const files = (res && (res.files || res.items)) || (Array.isArray(res) ? res : [])
    const filesDir = (res && (res.dir || res.root)) || ''
    patchSlice('group', { files, filesDir })
  } catch {}
}

export async function openGroupFileInDock(fileObj) {
  if (!fileObj || !fileObj.path) return
  try {
    const res = await api.groupFilesRead(fileObj.path)
    const content = (res && typeof res.text === 'string') ? res.text : ((res && typeof res.content === 'string') ? res.content : (typeof res === 'string' ? res : JSON.stringify(res, null, 2)))
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

/* ---- R16 插件化工作流统一动作出口（委托 workflowSlice.js） ---- */
export { setWorkflowViewTab, selectWorkflow }

export function togglePlugin(pluginId, enabled) {
  const res = togglePluginEnabled(pluginId, enabled)
  if (res.ok) {
    invalidateSessionPrefixCache()
    pushToast(`${res.enabled ? '已启用' : '已停用'}插件「${res.name}」（热重载生效）`, 'ok')
  } else if (res.message) {
    pushToast(res.message, 'warn')
  }
  return res
}

export function installPluginJson(rawJson) {
  const res = installCustomPlugin(rawJson)
  if (res.ok) {
    invalidateSessionPrefixCache()
    pushToast(`已热插拔安装插件「${res.plugin.name}」`, 'ok')
  } else {
    pushToast(res.error || '插件安装失败', 'err')
  }
  return res
}

export function uninstallPlugin(pluginId) {
  uninstallCustomPlugin(pluginId)
  invalidateSessionPrefixCache()
  pushToast('已卸载自定义插件', 'info')
}

export function createNewWorkflow(name = '') {
  const wf = createBlankCustomWorkflow(name)
  setActivePanel('workflow')
  setWorkflowViewTab('studio')
  pushToast(`已创建新工作流「${wf.name}」`, 'ok')
  return wf
}

export function saveWorkflowDef(rawWorkflow) {
  const res = saveCustomWorkflowDef(rawWorkflow)
  if (res.ok) pushToast(`已保存工作流「${res.workflow.name}」`, 'ok')
  else pushToast(res.error || '保存工作流失败', 'err')
  return res
}

export function deleteWorkflowDef(workflowId) {
  deleteCustomWorkflowDef(workflowId)
  pushToast('已删除自定义工作流', 'info')
}

export function convertGroupToWorkflow() {
  const wf = compileActiveGroupToWorkflow()
  setWorkflowViewTab('studio')
  setActivePanel('workflow')
  pushToast(`已将群聊班底编译为可视化 DAG 工作流「${wf.name}」`, 'ok')
  return wf
}

export function cloneCurrentWorkflow(workflowId) {
  const wf = cloneWorkflowDef(workflowId)
  if (wf) pushToast(`已克隆可编辑副本「${wf.name}」`, 'ok')
  return wf
}

export function importWorkflowFromJson(rawJson) {
  const res = importWorkflowJson(rawJson)
  if (res.ok) pushToast(`已导入工作流「${res.workflow.name}」`, 'ok')
  else pushToast(res.error || '导入工作流失败', 'err')
  return res
}

export function synthesizeWorkflowNow(goalText) {
  const wf = createWorkflowFromPrompt(goalText)
  setWorkflowViewTab('studio')
  setActivePanel('workflow')
  pushToast(`已根据需求自动编排 ${wf.nodes.length} 节点并发工作流「${wf.name}」`, 'ok')
  return wf
}

export function exportWorkflowRunReport() {
  const p = getState().plugins
  const wf = (p.workflows || []).find((w) => w.id === p.activeWorkflowId)
  if (!wf) return false
  const md = formatWorkflowRunMarkdown(wf, p.run)
  const fname = safeExportFilename(`工作流报告-${wf.name}`, '.md')
  const ok = downloadTextFile(fname, md, 'text/markdown;charset=utf-8')
  if (ok) pushToast(`已导出工作流执行报告：${fname}`, 'ok')
  return ok
}

export function undoWorkflowChange() {
  if (undoWorkflowEdit()) pushToast('已撤销上一步工作流编排', 'info')
}

export function redoWorkflowChange() {
  if (redoWorkflowEdit()) pushToast('已重做工作流编排', 'info')
}

async function dispatchMediaTool(toolName, args = {}, { signal } = {}) {
  const ep = resolveEndpointConfig()
  if (toolName === 'generate_image') {
    const r = await generateImageMedia({
      prompt: args.prompt || '',
      model: args.model || ep.imageModel || '',
      size: args.size || '',
      aspectRatio: args.aspect_ratio || args.aspectRatio || '1:1',
      style: args.style || '',
      quality: args.quality || 'standard',
      n: Number(args.n) || 1,
      endpointConfig: ep,
      signal,
    })
    if (r && r.artifact) openArtifactCanvas(r.artifact)
    return JSON.stringify({
      ok: true,
      simulated: !!r.simulated,
      provider: r.provider,
      model: r.model,
      aspectRatio: r.aspectRatio,
      images: (r.items || []).map((x) => ({ url: x.url, revisedPrompt: x.revisedPrompt || '' })),
      note: '成图已在右侧实时画布打开，你可在回答中用 Markdown 图片语法引用。',
    })
  }
  if (toolName === 'generate_video') {
    const r = await generateVideoMedia({
      prompt: args.prompt || '',
      model: args.model || ep.videoModel || '',
      imageUrl: args.image_url || args.imageUrl || '',
      duration: Number(args.duration) || 5,
      aspectRatio: args.aspect_ratio || args.aspectRatio || '16:9',
      resolution: args.resolution || '1080p',
      withAudio: !!args.with_audio,
      endpointConfig: ep,
      signal,
    })
    if (r && r.artifact) openArtifactCanvas(r.artifact)
    return JSON.stringify({
      ok: true,
      simulated: !!r.simulated,
      provider: r.provider,
      model: r.model,
      duration: r.duration,
      videos: r.items || [],
      note: '视频已在右侧实时画布放映厅打开。',
    })
  }
  return JSON.stringify({ ok: false, error: `未知媒体工具: ${toolName}` })
}

export function stopWorkflowRun() {
  stopWorkflowExecution()
  pushToast('已中止当前 DAG 工作流运行', 'info')
}

export function resetWorkflowRun() {
  resetWorkflowRunState()
}

export function triggerWorkflowShowcase() {
  triggerWorkflowShowcaseRun((art) => openArtifactCanvas(art))
}

export async function runActiveWorkflow({ workflowId = '', input = '', vars = {}, resume = false, runFromNodeId = '' } = {}) {
  const baseEp = resolveEndpointConfig()
  const wfSid = `wf_${workflowId || state.plugins.activeWorkflowId || 'default'}`
  const res = await runWorkflowWithHandlers({
    workflowId,
    input,
    vars,
    resume,
    runFromNodeId,
    runLlmNode: async ({ node, prompt, signal, onDelta }) => {
      const resolvedNodeEp = resolveEndpointWithSavedModel(node.model, baseEp, state.settings.savedModels)
      const nodeEp = {
        ...resolvedNodeEp,
        reasoning_effort: (node.reasoningTier && node.reasoningTier !== 'auto') ? node.reasoningTier : resolvedNodeEp.reasoning_effort,
      }
      return runAgentConversation({
        sid: `${wfSid}_${node.id}`,
        userQuery: prompt,
        historyMessages: [{ role: 'user', content: prompt }],
        endpointConfig: nodeEp,
        workspacePath: getState().workspace.rootPath,
        allowTools: node.allowTools === true,
        askBeforeDesign: false,
        maxRounds: node.allowTools ? 6 : 1,
        skipMemoryRecall: true,
        skipSelfCheck: true,
        signal,
        onEvent: (ev) => {
          if (ev && ev.cacheStats) _recordCacheStats(ev.cacheStats, wfSid)
          if (ev && typeof onDelta === 'function' && (ev.answer || ev.reasoning)) {
            onDelta(ev.answer || ev.reasoning, ev.cps || 0)
          }
        },
        requestApproval: (req) => new Promise((resolve) => {
          approvalResolver = resolve
          patchSlice('runtime', { pendingApproval: { id: 'ap_' + Date.now(), sid: wfSid, ...req } })
        }),
        requestClarify: (req) => openClarifyPrompt({ sid: wfSid, ...req }),
      })
    },
    runToolNode: async ({ toolName, args, signal }) => dispatchSingleTool({
      name: toolName,
      args,
      sid: wfSid,
      signal,
      pluginToolDispatcher: (tn, a) => dispatchPluginTool(tn, a, {
        plugins: state.plugins.plugins,
        workflows: state.plugins.workflows,
      }),
      requestApproval: (req) => new Promise((resolve) => {
        approvalResolver = resolve
        patchSlice('runtime', { pendingApproval: { id: 'ap_' + Date.now(), sid: wfSid, ...req } })
      }),
      requestClarify: (req) => openClarifyPrompt({ sid: wfSid, ...req }),
    }),
    runImageNode: async (params) => {
      const resolved = resolveEndpointWithSavedModel(params.model, baseEp, state.settings.savedModels)
      return generateImageMedia({
        ...params,
        model: resolved.model,
        endpointConfig: { ...baseEp, imageBaseUrl: resolved.baseUrl || baseEp.imageBaseUrl, imageApiKey: resolved.apiKey || baseEp.imageApiKey, imageModel: resolved.model },
      })
    },
    runVideoNode: async (params) => {
      const resolved = resolveEndpointWithSavedModel(params.model, baseEp, state.settings.savedModels)
      return generateVideoMedia({
        ...params,
        model: resolved.model,
        endpointConfig: { ...baseEp, videoBaseUrl: resolved.baseUrl || baseEp.videoBaseUrl, videoApiKey: resolved.apiKey || baseEp.videoApiKey, videoModel: resolved.model },
      })
    },
    requestHumanGate: (req) => openClarifyPrompt({ sid: wfSid, ...req }),
    onArtifact: (art) => openArtifactCanvas(art),
  })
  if (res && res.status === 'done') {
    pushToast('DAG 工作流执行完成', 'ok')
  } else if (res && res.status === 'error' && res.error) {
    pushToast(`工作流执行异常：${res.error}`, 'err')
  }
  return res
}


/* ---- R18 设置与专家市场领域切片统一门面再导出（LAW-14：零 feature 直连 bridge.js） ---- */
export {
  saveModelProfile,
  deleteModelProfile,
  activateSavedModelGlobal,
  testModelEndpoint,
  probeLocalEndpoints,
  saveHybridSettings,
  saveGuardTiersConfig,
  saveSandboxSettings,
  probeExternalSoftware,
  runWebdavSyncAction,
  downloadAppUpdate,
  applyAppUpdate,
  saveMcpServerConfig,
  testMcpServerConfig,
  deleteMcpServerConfig,
  addLongTermMemory,
  deleteLongTermMemory,
} from './settingsSlice.js'

export {
  activateLocalExpertPackage,
  previewLocalExpertSkills,
  importLocalExpertDirectory,
  toggleLocalExpertEnabled,
} from './marketSlice.js'
