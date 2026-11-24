/**
 * 后端唯一通信出口（LAW-03）：与 server/src/registry.js 168 个 /jsapi/:method 逐方法对齐。
 * 所有后端返回值自动安全 JSON.parse，错误统一归一化为 HarborError。
 */
import { apiBaseUrl } from '../platform/libs.js'
import { HarborError, normalizeError } from './errors.js'
import { assertLatin1Headers } from './headers.js'

function tryParseJson(raw) {
  if (typeof raw !== 'string') return raw
  const t = raw.trim()
  if (!t) return ''
  try { return JSON.parse(t) } catch { return raw }
}

export async function callJsApiRaw(method, args = [], options = {}) {
  const base = apiBaseUrl()
  if (!base) {
    throw new HarborError('BRIDGE_OFFLINE', '本地 Fastify 服务未连接（请通过 Electron 桌面端启动）', { retryable: true })
  }
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 60000
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (options.signal) {
    if (options.signal.aborted) ctrl.abort()
    else options.signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const headers = assertLatin1Headers({
      'Content-Type': 'application/json',
      ...(options.sid ? { 'x-harbor-sid': String(options.sid) } : {}),
      ...(options.agentLoop ? { 'x-harbor-agent-loop': '1' } : {}),
      ...(options.confirmed ? { 'x-harbor-confirmed': '1' } : {}),
    })
    const resp = await fetch(`${base}/jsapi/${encodeURIComponent(method)}`, {
      method: 'POST',
      headers,
      signal: ctrl.signal,
      body: JSON.stringify({ args: Array.isArray(args) ? args : [] }),
    })
    const text = await resp.text()
    if (!resp.ok) {
      throw normalizeError(tryParseJson(text), `HTTP_${resp.status}`)
    }
    return text
  } finally {
    clearTimeout(timer)
    if (options.signal) options.signal.removeEventListener('abort', onAbort)
  }
}

export async function callJsApi(method, args = [], options = {}) {
  const raw = await callJsApiRaw(method, args, options)
  const parsed = tryParseJson(raw)
  if (parsed && typeof parsed === 'object' && parsed.ok === false && parsed.error && !options.allowErrorPayload) {
    throw normalizeError(parsed, 'API_ERROR')
  }
  return parsed
}

export async function checkServerHealth() {
  const base = apiBaseUrl()
  if (!base) return { ok: false, offline: true }
  try {
    const resp = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) })
    if (!resp.ok) return { ok: false, status: resp.status }
    return await resp.json()
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) }
  }
}

/* ---- 配置 & 会话 ---- */
export const getConfig = (opt) => callJsApi('get_config', [], opt)
export const saveConfig = (cfg, opt) => callJsApi('save_config', [JSON.stringify(cfg)], opt)
export const getSessions = (opt) => callJsApi('get_sessions', [], opt)
export const saveSessions = (list, opt) => callJsApi('save_sessions', [JSON.stringify(list)], opt)
export const setCurrentSid = (sid, opt) => callJsApi('set_current_sid', [String(sid || '')], opt)
export const sessionPurge = (sid, taskIds = [], opt) => callJsApi('session_purge', [sid, JSON.stringify(taskIds)], opt)

/* ---- 模型代理 / 提示词 / 工具面 ---- */
export const getLocalProxy = (opt) => callJsApi('get_local_proxy', [], opt)
export const localProbe = (ports = [], opt) => callJsApi('local_probe', [ports], opt)
export const localModels = (baseUrl, apiKey = '', opt) => callJsApi('local_models', [baseUrl, apiKey], opt)
export const testProviderEndpoint = (baseUrl, apiKey, model, timeout = 15, local = false, opt) =>
  callJsApi('test_provider_endpoint', [baseUrl, apiKey, model, timeout, local], { ...opt, allowErrorPayload: true })
export const buildTools = (role = 'full', includeMcp = true, includeAgent = true, isGlm = false, opt) =>
  callJsApi('build_tools', [role, includeMcp, includeAgent, isGlm], opt)
export const buildSystemPrompt = (query = '', opt) => callJsApi('build_system_prompt', [String(query || '')], opt)
export const inspectToolSchema = (name, opt) => callJsApi('inspect_tool_schema', [String(name || '')], opt)

/* ---- 工作区 & 文件 ---- */
export const getWsState = (sid, opt) => callJsApi('get_ws_state', [sid || ''], opt)
export const setSessionWs = (sid, dirPath, enabled = true, opt) => callJsApi('set_session_ws', [sid || '', dirPath || '', enabled], opt)
export const setWsEnabled = (sid, enabled, opt) => callJsApi('set_ws_enabled', [sid || '', !!enabled], opt)
export const setWsDir = (dirPath, opt) => callJsApi('set_ws_dir', [dirPath || ''], opt)
export const listRecentWs = (opt) => callJsApi('list_recent_ws', [], opt)
export const pickFolder = (sid = '', opt) => callJsApi('pick_folder', [sid], { ...opt, timeoutMs: 120000 })
export const listDir = (dirPath = '.', opt) => callJsApi('list_dir', [dirPath], opt)
export const readFile = (filePath, offset = 0, limit = 0, force = false, opt) => callJsApi('read_file', [filePath, offset, limit, force], opt)
export const writeFile = (filePath, content, opt) => callJsApi('write_file', [filePath, content], opt)
export const appendFile = (filePath, content, opt) => callJsApi('append_file', [filePath, content], opt)
export const searchReplace = (filePath, oldText, newText, replaceAll = false, opt) =>
  callJsApi('search_replace', [filePath, oldText, newText, !!replaceAll], opt)
export const makeDir = (dirPath, opt) => callJsApi('make_dir', [dirPath], opt)
export const copyPath = (src, dst, opt) => callJsApi('copy_path', [src, dst], opt)
export const movePath = (src, dst, opt) => callJsApi('move_path', [src, dst], opt)
export const deletePath = (targetPath, recycle = true, token = '', opt) => callJsApi('delete_path', [targetPath, !!recycle, token], opt)
export const runCommand = (cmd, timeout = 120, token = '', opt) => callJsApi('run_command', [cmd, timeout, token], { ...opt, timeoutMs: 300000 })
export const runPowershell = (cmd, timeout = 120, token = '', opt) => callJsApi('run_powershell', [cmd, timeout, token], { ...opt, timeoutMs: 300000 })

/* ---- 安全护栏 & 审计 ---- */
export const guardCheck = (op, detail = {}, opt) => callJsApi('guard_check', [op, JSON.stringify(detail)], { ...opt, allowErrorPayload: true })
export const guardConfirmToken = (op, detail = {}, opt) => callJsApi('guard_confirm_token', [op, JSON.stringify(detail)], opt)
export const guardSessionTrust = (op, opt) => callJsApi('guard_session_trust', [op], opt)
export const guardGetConfig = (opt) => callJsApi('guard_get_config', [], opt)
export const guardSaveConfig = (cfg, opt) => callJsApi('guard_save_config', [JSON.stringify(cfg)], opt)
export const guardRuleList = (opt) => callJsApi('guard_rule_list', [], opt)
export const guardRuleAdd = (opPat, detailPat, note = '', opt) => callJsApi('guard_rule_add', [opPat, detailPat, note], opt)
export const guardRuleRemove = (ruleId, opt) => callJsApi('guard_rule_remove', [ruleId], opt)
export const guardTaskStatus = (opt) => callJsApi('guard_task_status', [], opt)
export const getAuditLog = (limit = 50, offset = 0, opt) => callJsApi('get_audit_log', [limit, offset, false], opt)

/* ---- 记忆 / 计划 / 检查点 ---- */
export const getMemory = (opt) => callJsApi('get_memory', [], opt)
export const appendMemory = (entry, opt) => callJsApi('append_memory', [JSON.stringify(entry)], opt)
export const memoryDelete = (index, opt) => callJsApi('memory_delete', [index], opt)
export const memorySearch = (query, limit = 8, opt) => callJsApi('memory_search', [query, limit], opt)
export const planList = (limit = 20, opt) => callJsApi('plan_list', [limit], opt)
export const planCreate = (title, steps = [], taskId = '', opt) => callJsApi('plan_create', [title, steps, taskId], opt)
export const planUpdate = (taskId, status, stepIndex = -1, stepStatus = '', opt) =>
  callJsApi('plan_update', [taskId, status, stepIndex, stepStatus], opt)
export const checkpointCreate = (taskId, files = [], wsDir = '', opt) => callJsApi('checkpoint_create', [taskId, files, wsDir], opt)
export const checkpointList = (taskId = '', opt) => callJsApi('checkpoint_list', [taskId], opt)
export const checkpointRollback = (taskId, wsDir = '', confirm = true, opt) =>
  callJsApi('checkpoint_rollback', [taskId, wsDir, !!confirm], { ...opt, allowErrorPayload: true })

/* ---- MCP / 专家 / 浏览器 / 群聊 / 系统 ---- */
export const mcpListServers = (opt) => callJsApi('mcp_list_servers', [], opt)
export const mcpSaveServer = (name, cfg, opt) => callJsApi('mcp_save_server', [name, JSON.stringify(cfg)], opt)
export const mcpDeleteServer = (name, opt) => callJsApi('mcp_delete_server', [name], opt)
export const mcpTestServer = (name, opt) => callJsApi('mcp_test_server', [name], { ...opt, allowErrorPayload: true })
export const mcpCallTool = (server, tool, argsObj = {}, decision = 'allow', token = '', opt) =>
  callJsApi('mcp_call_tool', [server, tool, JSON.stringify(argsObj), decision, token], { ...opt, allowErrorPayload: true })

export const expertList = (query = '', opt) => callJsApi('expert_list', [query], opt)
export const expertGet = (pkgId, snapId = '', opt) => callJsApi('expert_get', [pkgId, snapId], opt)
export const expertReadResource = (snapId, relPath, opt) => callJsApi('expert_read_resource', [snapId, relPath], opt)
export const expertSetEnabled = (pkgId, enabled, snapId = '', opt) => callJsApi('expert_set_enabled', [pkgId, !!enabled, snapId], opt)
export const expertImportDirectory = (dirPath, opt) => callJsApi('expert_import_directory', [dirPath], { ...opt, allowErrorPayload: true })

export const browserSearch = (params, token = '', opt) => callJsApi('browser_search', [params, token], { ...opt, allowErrorPayload: true, timeoutMs: 90000 })
export const browserNavigate = (url, waitSel = '', timeout = 25, mode = 'hidden', token = '', opt) =>
  callJsApi('browser_navigate', [url, waitSel, timeout, mode, token], { ...opt, allowErrorPayload: true })
export const browserExtract = (selector = '', mode = 'text', token = '', opt) =>
  callJsApi('browser_extract', [selector, mode, token], { ...opt, allowErrorPayload: true })

export const groupFilesList = (groupId, groupName = '', opt) => callJsApi('group_files_list', [groupId, groupName], opt)
export const groupFilesWrite = (groupId, groupName, member, title, content, meta = {}, opt) =>
  callJsApi('group_files_write', [groupId, groupName, member, title, content, JSON.stringify(meta)], opt)
export const groupFilesRead = (filePath, opt) => callJsApi('group_files_read', [filePath], opt)
export const groupFilesSearch = (groupId, query, limit = 8, opt) => callJsApi('group_files_search', [groupId, query, limit], opt)
export const groupFilesDelete = (groupId, name, opt) => callJsApi('group_files_delete', [groupId, name], opt)
export const groupFilesOpenDir = (groupId, opt) => callJsApi('group_files_open_dir', [groupId], opt)

export const sandboxGetConfig = (opt) => callJsApi('sandbox_get_config', [], opt)
export const sandboxSaveConfig = (cfg, opt) => callJsApi('sandbox_save_config', [JSON.stringify(cfg)], opt)
export const webdavGetConfig = (opt) => callJsApi('webdav_get_config', [], opt)
export const webdavSaveConfig = (cfg, opt) => callJsApi('webdav_save_config', [JSON.stringify(cfg)], opt)
export const webdavTest = (cfg, opt) => callJsApi('webdav_test', [JSON.stringify(cfg)], { ...opt, allowErrorPayload: true })
export const openUrl = (url, token = '', opt) => callJsApi('open_url', [url, token], opt)
export const getPlatformInfo = (opt) => callJsApi('get_platform_info', [], opt)


/* ---- Pack 2 全量补齐：截屏 / 接管 / 混合路由 / 沙箱状态 / WebDAV / 更新 / 外部软件 ---- */
export const takeScreenshot = (left = 0, top = 0, width = 0, height = 0, token = '', opt) =>
  callJsApi('take_screenshot', [left, top, width, height, token], { ...opt, allowErrorPayload: true })
export const browserTakeover = (takeoverId, action = 'continue', opt) => {
  const norm = action === 'resume' ? 'continue' : (action === 'cancel' ? 'abort' : action)
  return callJsApi('browser_takeover', [takeoverId, norm], { ...opt, allowErrorPayload: true })
}
export const browserClose = (sessionId = '', token = '', opt) =>
  callJsApi('browser_close', [sessionId, token], { ...opt, allowErrorPayload: true })
export const browserSessions = (opt) => callJsApi('browser_sessions', [], opt)

export const hybridGetConfig = (opt) => callJsApi('hybrid_get_config', [], opt)
export const hybridSaveConfig = (cfg, opt) => callJsApi('hybrid_save_config', [JSON.stringify(cfg)], opt)
export const modelPrefsGet = (opt) => callJsApi('model_prefs_get', [], opt)
export const modelPrefsSave = (prefs, opt) => callJsApi('model_prefs_save', [JSON.stringify(prefs)], opt)
export const readerConfigGet = (opt) => callJsApi('reader_config_get', [], opt)
export const readerConfigSave = (cfg, opt) => callJsApi('reader_config_save', [JSON.stringify(cfg)], opt)
export const searchReaderStats = (opt) => callJsApi('search_reader_stats', [], { ...opt, allowErrorPayload: true })

export const sandboxStatus = (opt) => callJsApi('sandbox_status', [], { ...opt, allowErrorPayload: true })

export const webdavExport = (opt) => callJsApi('webdav_export', [], { ...opt, allowErrorPayload: true, timeoutMs: 120000 })
export const webdavRestore = (payload = {}, opt) =>
  callJsApi('webdav_restore', [JSON.stringify(payload)], { ...opt, allowErrorPayload: true, timeoutMs: 120000 })

export const checkUpdate = (manifestUrl = null, opt) =>
  callJsApi('check_update', [manifestUrl || null], { ...opt, allowErrorPayload: true })
export const startUpdateDownload = (url, sha256, version, opt) =>
  callJsApi('start_update_download', [url, sha256, version], { ...opt, allowErrorPayload: true })
export const getUpdateProgress = (opt) => callJsApi('get_update_progress', [], { ...opt, allowErrorPayload: true })
export const applyUpdate = (opt) => callJsApi('apply_update', [], { ...opt, allowErrorPayload: true })

export const softwareList = (status = '', opt) => callJsApi('software_list', [status], { ...opt, allowErrorPayload: true })
export const softwareProbe = (name = '', opt) =>
  callJsApi('software_probe', [name], { ...opt, allowErrorPayload: true, timeoutMs: 120000 })
export const softwareCall = (params, token = '', opt) =>
  callJsApi('software_call', [params, token], { ...opt, allowErrorPayload: true, timeoutMs: 300000 })
