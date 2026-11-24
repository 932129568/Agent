/**
 * 设置中心领域切片（R18 彻底收口）：
 * 承接 SettingsModal 的全部后端持久化、探测、护栏、沙箱、MCP、WebDAV、记忆与更新动作，
 * 让 features/settings/SettingsModal.jsx 零直接依赖 services/bridge.js（遵守 LAW-14）。
 */
import * as api from '../services/bridge.js'
import { getState } from './kernel.js'
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
