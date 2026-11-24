/**
 * 设置中心领域切片（R18 彻底收口）：
 * 承接 SettingsModal 的全部后端持久化、探测、护栏、沙箱、MCP、WebDAV、记忆与更新动作，
 * 让 features/settings/SettingsModal.jsx 零直接依赖 services/bridge.js（遵守 LAW-14）。
 */
import { readStorage, writeStorage } from '../platform/storage.js'
import * as api from '../services/bridge.js'
import { assertLatin1Value } from '../services/headers.js'
import { invalidateSessionPrefixCache } from '../services/agentEngine.js'
import { normalizeSavedModel, upsertSavedModel, removeSavedModel, findSavedModel } from '../services/modelVault.js'
import { getState, patchSlice } from './kernel.js'

const SAVED_MODELS_KEY = 'harbor.v5.saved_models'

export function loadInitialSavedModels() {
  try {
    const raw = readStorage(SAVED_MODELS_KEY, '')
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(normalizeSavedModel).filter((m) => m.model) : []
  } catch {
    return []
  }
}

async function syncSavedModelsToBackend(nextModels) {
  try { writeStorage(SAVED_MODELS_KEY, JSON.stringify(nextModels)) } catch {}
  const prevCfg = (getState().settings && getState().settings.backendConfig) || {}
  const mergedCfg = { ...prevCfg, saved_models: nextModels }
  patchSlice('settings', (s) => ({ ...s, savedModels: nextModels, backendConfig: mergedCfg }))
  try { await api.saveConfig(mergedCfg) } catch {}
}

export async function saveModelProfile(rawProfile = {}) {
  try {
    if (rawProfile.baseUrl) assertLatin1Value('模型 Base URL', String(rawProfile.baseUrl).trim())
    if (rawProfile.apiKey) assertLatin1Value('模型 API Key', String(rawProfile.apiKey).trim())
  } catch (e) {
    pushToast(e.message, 'err')
    return { ok: false, error: e.message }
  }
  const cur = (getState().settings && getState().settings.savedModels) || []
  const res = upsertSavedModel(cur, rawProfile)
  if (!res.ok) {
    pushToast(res.error || '保存模型失败', 'err')
    return res
  }
  await syncSavedModelsToBackend(res.items)
  pushToast(`已保存模型「${res.item.label}」到模型保存中心`, 'ok')
  return res
}

export async function deleteModelProfile(profileId) {
  const cur = (getState().settings && getState().settings.savedModels) || []
  const target = findSavedModel(cur, profileId)
  const next = removeSavedModel(cur, profileId)
  await syncSavedModelsToBackend(next)
  pushToast(`已移除保存的模型${target ? `「${target.label}」` : ''}`, 'info')
  return { ok: true, items: next }
}

export async function activateSavedModelGlobal(profileId) {
  const st = getState().settings
  const hit = findSavedModel(st.savedModels || [], profileId)
  if (!hit) return { ok: false, error: '未找到目标保存模型' }
  const prev = st.backendConfig || {}
  let patch = {}
  if (hit.kind === 'image') {
    patch = {
      image_model: hit.model,
      ...(hit.baseUrl ? { image_base_url: hit.baseUrl } : {}),
      ...(hit.apiKey ? { image_api_key: hit.apiKey } : {}),
    }
  } else if (hit.kind === 'video') {
    patch = {
      video_model: hit.model,
      ...(hit.baseUrl ? { video_base_url: hit.baseUrl } : {}),
      ...(hit.apiKey ? { video_api_key: hit.apiKey } : {}),
    }
  } else {
    const base = hit.baseUrl || prev.provider_base_url || prev.provider_base || 'https://open.bigmodel.cn/api/paas/v4'
    const key = hit.apiKey || prev.provider_key || prev.api_key || ''
    patch = {
      active_saved_model_id: hit.id,
      model: hit.model,
      provider_model: hit.model,
      provider_base_url: base,
      provider_base: base,
      api_key: key,
      provider_key: key,
      local_mode: !!hit.isLocal,
      ...(hit.isLocal && hit.baseUrl ? { local_base_url: hit.baseUrl, local_model: hit.model } : {}),
      context_window: hit.contextWindow || prev.context_window || 128000,
      max_tokens: hit.maxTokens || prev.max_tokens || 4096,
      ...(hit.reasoningTier && hit.reasoningTier !== 'auto' ? { reasoning_effort: hit.reasoningTier } : {}),
    }
  }
  const merged = { ...prev, ...patch, saved_models: st.savedModels || [] }
  invalidateSessionPrefixCache()
  patchSlice('settings', (s) => ({ ...s, backendConfig: merged }))
  try { await api.saveConfig(merged) } catch {}
  pushToast(`已全局切换默认${hit.kind === 'image' ? '生图' : (hit.kind === 'video' ? '视频' : '')}模型为「${hit.label}」`, 'ok')
  return { ok: true, model: hit }
}
import { pushToast } from './uiSlice.js'
import { refreshSettingsAux } from './domainSlice.js'

export async function testModelEndpoint({ baseUrl, apiKey, model, localMode = false }) {
  const res = await api.testProviderEndpoint(baseUrl, apiKey, model, 15, !!localMode)
  if (res && res.ok) pushToast('端点连接测试成功', 'ok')
  else pushToast(`连接测试失败：${(res && (res.error || res.message)) || '请检查地址与 Key'}`, 'err')
  return res
}

export async function probeLocalEndpoints() {
  try {
    const r = await api.localProbe([])
    const hits = (r && Array.isArray(r.reachable)) ? r.reachable : []
    return hits.length
      ? hits.map((x) => `${x.kind}(${x.base_url}) 模型: ${(x.models || []).join(',')}`).join(' | ')
      : '未探测到本机运行的 Ollama / LMStudio / vLLM 端点'
  } catch (e) {
    return `探测失败：${e.message}`
  }
}

export async function saveHybridSettings(hybridDraft) {
  try {
    await api.hybridSaveConfig(hybridDraft)
    await refreshSettingsAux()
    pushToast('云+本地混合路由策略已保存', 'ok')
    return true
  } catch (e) {
    pushToast(e.message, 'err')
    return false
  }
}

export async function saveGuardTiersConfig(nextTiers) {
  try {
    const settings = getState().settings
    const baseCfg = (settings.guardConfig && typeof settings.guardConfig === 'object') ? settings.guardConfig : {}
    await api.guardSaveConfig({ ...baseCfg, tiers: { ...(baseCfg.tiers || {}), ...nextTiers } })
    await refreshSettingsAux()
    pushToast('安全护栏审批档位已保存（即时生效）', 'ok')
    return { ok: true, tiers: nextTiers }
  } catch (e) {
    pushToast(e.message, 'err')
    return { ok: false }
  }
}

export async function saveSandboxSettings(sandboxDraft) {
  try {
    await api.sandboxSaveConfig(sandboxDraft)
    let offTiers = null
    if (sandboxDraft.enabled === false) {
      const settings = getState().settings
      const baseCfg = (settings.guardConfig && typeof settings.guardConfig === 'object') ? settings.guardConfig : {}
      offTiers = {
        ...(baseCfg.tiers || {}),
        run_command: 'off',
        run_powershell: 'off',
        delete_path: 'off',
        browser_click: 'off',
        browser_fill: 'off',
        software_call: 'off',
      }
      await api.guardSaveConfig({ ...baseCfg, tiers: offTiers })
    }
    await refreshSettingsAux()
    pushToast(
      sandboxDraft.enabled === false
        ? '沙箱与目录限制已关闭：现可自由读写桌面/任意用户路径并自动放行命令'
        : '命令沙箱与路径隔离已启用',
      'ok'
    )
    return { ok: true, offTiers }
  } catch (e) {
    pushToast(e.message, 'err')
    return { ok: false, offTiers: null }
  }
}

export async function probeExternalSoftware() {
  try {
    await api.softwareProbe('')
    await refreshSettingsAux()
    pushToast('外部软件探测完成', 'ok')
    return true
  } catch (e) {
    pushToast(e.message, 'err')
    return false
  }
}

export async function runWebdavSyncAction(act, webdavDraft) {
  try {
    await api.webdavSaveConfig(webdavDraft)
    if (act === 'test') {
      const r = await api.webdavTest(webdavDraft)
      pushToast(r && r.ok ? 'WebDAV 连接测试通过' : `测试失败：${(r && r.error) || ''}`, r && r.ok ? 'ok' : 'err')
      return r
    }
    if (act === 'export') {
      const r = await api.webdavExport()
      pushToast(r && r.ok ? '已加密同步导出至 WebDAV' : `导出失败：${(r && r.error) || ''}`, r && r.ok ? 'ok' : 'err')
      return r
    }
    if (act === 'restore') {
      const r = await api.webdavRestore({ conflict_policy: webdavDraft.conflict_policy || 'ask' })
      pushToast(r && r.ok ? '已从 WebDAV 恢复数据' : `恢复结果：${(r && (r.error || r.status)) || ''}`, r && r.ok ? 'ok' : 'info')
      return r
    }
    return { ok: true }
  } catch (e) {
    pushToast(e.message, 'err')
    return { ok: false, error: e.message }
  }
}

export async function downloadAppUpdate() {
  const u = getState().runtime && getState().runtime.updateInfo
  if (!u || !u.url) return false
  try {
    await api.startUpdateDownload(u.url, u.sha256 || '', u.latest || '')
    pushToast('已启动后台更新下载（SHA256 校验）', 'ok')
    return true
  } catch (e) {
    pushToast(e.message, 'err')
    return false
  }
}

export async function applyAppUpdate() {
  try {
    await api.applyUpdate()
    pushToast('正在应用更新…', 'info')
    return true
  } catch (e) {
    pushToast(e.message, 'err')
    return false
  }
}

export async function saveMcpServerConfig(name, cmdLine) {
  const cleanName = String(name || '').trim()
  const cleanCmd = String(cmdLine || '').trim()
  if (!cleanName || !cleanCmd) return false
  try {
    const parts = cleanCmd.split(/\s+/)
    await api.mcpSaveServer(cleanName, { command: parts[0], args: parts.slice(1), enabled: true })
    await refreshSettingsAux()
    pushToast('MCP 已保存', 'ok')
    return true
  } catch (e) {
    pushToast(e.message, 'err')
    return false
  }
}

export async function testMcpServerConfig(name) {
  try {
    const r = await api.mcpTestServer(name)
    pushToast(r && r.ok ? `${name} 测试通过` : '测试失败', r && r.ok ? 'ok' : 'err')
    return r
  } catch (e) {
    pushToast(e.message, 'err')
    return { ok: false }
  }
}

export async function deleteMcpServerConfig(name) {
  try {
    await api.mcpDeleteServer(name)
    await refreshSettingsAux()
    return true
  } catch (e) {
    pushToast(e.message, 'err')
    return false
  }
}

export async function addLongTermMemory(text) {
  const clean = String(text || '').trim()
  if (!clean) return false
  try {
    await api.appendMemory({ text: clean, distill: true })
    await refreshSettingsAux()
    pushToast('已写入长期记忆', 'ok')
    return true
  } catch (e) {
    pushToast(e.message, 'err')
    return false
  }
}

export async function deleteLongTermMemory(idx) {
  try {
    await api.memoryDelete(idx)
    await refreshSettingsAux()
    return true
  } catch (e) {
    pushToast(e.message, 'err')
    return false
  }
}
