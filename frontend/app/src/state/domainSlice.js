/**
 * 业务域统一状态切片（R17 激进解耦）：
 * 收口工作区、护栏规则、计划/检查点、市场、设置辅域、审计日志、记忆、网页搜索、专家团队与双模型协同。
 * 彻底消除 WorkspacePanel / PlanningPanel / AnalyticsPanel / ChatPanel 绕过 state 层直调 bridge.js！
 */
import { writeStorage } from '../platform/storage.js'
import * as api from '../services/bridge.js'
import { invalidateSessionPrefixCache } from '../services/agentEngine.js'
import { runExpertTeam } from '../services/expertTeam.js'
import { normalizeCollaborationConfig, runDualModelCollaboration } from '../services/collaboration.js'
import { isAbort } from '../services/errors.js'
import { getState, patchSlice } from './kernel.js'
import { pushToast } from './uiSlice.js'

const DISABLED_CURATED_KEY = 'harbor.v3.disabled_curated'
let teamAbortCtrl = null
let collabAbortCtrl = null

export function resolveEndpointConfig(preferLocal = false) {
  const st = getState()
  const c = (st.settings && st.settings.backendConfig) || {}
  const hasEnabledMcp = ((st.settings && st.settings.mcpServers) || []).some((s) => s && s.enabled !== false)
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
      imageBaseUrl: c.image_base_url || c.local_base_url,
      imageApiKey: c.image_api_key || c.provider_key || c.api_key || '',
      imageModel: c.image_model || '',
      videoBaseUrl: c.video_base_url || c.local_base_url,
      videoApiKey: c.video_api_key || c.provider_key || c.api_key || '',
      videoModel: c.video_model || '',
    }
  }
  const pickedModel = c.provider_model || c.model || 'glm-4.5-flash'
  const mainBase = c.provider_base_url || c.provider_base || c.base_url || 'https://open.bigmodel.cn/api/paas/v4'
  const mainKey = c.provider_key || c.api_key || ''
  return {
    isLocal: false,
    hasEnabledMcp,
    baseUrl: mainBase,
    apiKey: mainKey,
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
    imageBaseUrl: c.image_base_url || mainBase,
    imageApiKey: c.image_api_key || mainKey,
    imageModel: c.image_model || '',
    videoBaseUrl: c.video_base_url || mainBase,
    videoApiKey: c.video_api_key || mainKey,
    videoModel: c.video_model || '',
  }
}

export async function refreshWorkspace() {
  try {
    const sid = getState().sessions.currentId
    const [ws, recent, dir, rules] = await Promise.allSettled([
      api.getWsState(sid), api.listRecentWs(), api.listDir('.'), api.guardRuleList(),
    ])
    patchSlice('workspace', (w) => ({
      ...w,
      enabled: ws.status === 'fulfilled' && ws.value ? ws.value.enabled !== false : w.enabled,
      rootPath: ws.status === 'fulfilled' && ws.value ? (ws.value.ws || ws.value.effective || ws.value.dir || w.rootPath) : w.rootPath,
      recent: recent.status === 'fulfilled' && Array.isArray(recent.value)
        ? recent.value
        : (recent.status === 'fulfilled' && Array.isArray(recent.value && recent.value.recent) ? recent.value.recent : w.recent),
      entries: dir.status === 'fulfilled' && dir.value && Array.isArray(dir.value.entries) ? dir.value.entries : [],
      guardRules: rules.status === 'fulfilled' && rules.value && Array.isArray(rules.value.rules) ? rules.value.rules : [],
    }))
  } catch (e) {
    pushToast(`读取工作区失败：${e.message}`, 'err')
  }
}

export async function toggleWorkspaceEnabled(enabled) {
  const sid = getState().sessions.currentId
  invalidateSessionPrefixCache(sid)
  await api.setWsEnabled(sid, enabled)
  await refreshWorkspace()
}

export async function previewWorkspaceFile(filePath) {
  const res = await api.readFile(filePath, 0, 200, true)
  patchSlice('workspace', { previewFile: { path: filePath, content: String((res && res.content) || '') } })
}

export async function addWorkspaceGuardRule(opPat, detailPat, note = 'React 控制台添加') {
  const pat = String(detailPat || '').trim()
  if (!pat) return false
  try {
    await api.guardRuleAdd(opPat, pat, note)
    await refreshWorkspace()
    pushToast('护栏规则已添加', 'ok')
    return true
  } catch (e) {
    pushToast(e.message, 'err')
    return false
  }
}

export async function removeWorkspaceGuardRule(ruleId) {
  try {
    await api.guardRuleRemove(ruleId)
    await refreshWorkspace()
    pushToast('护栏规则已移除', 'info')
  } catch (e) {
    pushToast(e.message, 'err')
  }
}

export async function refreshPlanning() {
  const [pl, ck] = await Promise.allSettled([api.planList(25), api.checkpointList('')])
  patchSlice('planning', {
    plans: pl.status === 'fulfilled' && pl.value && Array.isArray(pl.value.plans) ? pl.value.plans : [],
    checkpoints: ck.status === 'fulfilled' && ck.value && Array.isArray(ck.value.checkpoints) ? ck.value.checkpoints : [],
  })
}

export async function createTaskPlan(title, steps = []) {
  const cleanTitle = String(title || '').trim()
  if (!cleanTitle) return false
  try {
    await api.planCreate(cleanTitle, steps.length ? steps : ['分析现状', '执行修改', '验证收口'])
    await refreshPlanning()
    pushToast('任务计划已创建', 'ok')
    return true
  } catch (e) {
    pushToast(e.message, 'err')
    return false
  }
}

export async function rollbackTaskCheckpoint(taskId) {
  try {
    const r = await api.checkpointRollback(taskId, '', true)
    if (r && r.ok) pushToast(`已回滚至检查点 ${taskId}`, 'ok')
    else pushToast(`回滚失败：${(r && (r.error || r.message)) || '无可用检查点'}`, 'err')
    return r
  } catch (e) {
    pushToast(e.message, 'err')
    return { ok: false, error: e.message }
  }
}

export async function refreshAuditLogs(limit = 20) {
  try {
    const r = await api.getAuditLog(limit, 0)
    const items = (r && (r.entries || r.logs || r.items)) || (Array.isArray(r) ? r : [])
    patchSlice('runtime', { auditLogs: items })
    return items
  } catch {
    return []
  }
}

export async function saveAtomicMemory(rawText) {
  const concise = String(rawText || '').replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
  if (!concise) return false
  try {
    await api.appendMemory({ text: concise, distill: true })
    pushToast('已提炼为原子事实存入长期记忆', 'ok')
    return true
  } catch (err) {
    pushToast(`存入记忆失败：${err.message}`, 'err')
    return false
  }
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
    const url = getState().settings.backendConfig.update_manifest_url || null
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
      recovery: useRecovery ? getState().expertTeam.checkpoint : null,
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
      config: getState().collaboration.config,
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
