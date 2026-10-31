/**
 * js_api 方法注册表（显式白名单）。
 *
 * 与 legacy `backend/api.py` 的分发口径对齐，但**不允许按名字反射调用任意函数**：
 * 只有此处显式注册的方法才可被 HTTP 触发，未迁移方法返回结构化错误，
 * 与 legacy「旧 exe 缺方法」时前端的容错路径（try/catch 后降级）自然衔接。
 */
import { getSessions, saveSessions } from './services/sessions.js'
import { getConfig, saveConfig } from './services/config.js'
import { getCwd, setWorkspace, getWorklog, appendWorklog } from './services/worklog.js'
import {
  listDir, readFile, readMore, writeFile, appendFile, searchReplace, makeDir, getFileInfo,
} from './services/files.js'
import { setCurrentSid } from './runtime.js'
import { readConfigText, readConfigJson, mergeConfig } from './services/jsonstore.js'
import * as workspace from './services/workspace.js'
import * as memory from './services/memory.js'
import * as plans from './services/plans.js'
import * as misc from './services/misc.js'
import * as system from './services/system.js'
import * as provider from './services/provider.js'
import * as guard from './services/guard.js'
import * as commands from './services/commands.js'
import * as update from './services/update.js'
import * as webdav from './services/webdav.js'
import * as experts from './services/experts.js'
import * as mcp from './services/mcp.js'
import * as browser from './services/browser.js'

const asDetail = value => {
  if (!value) return {}
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch (error) { return { raw: value } }
  }
  return value
}
/** 契约版本：与 legacy 冻结的 API_VERSION 一致，不随实现替换而漂移 */
export const API_VERSION = 'v1.0.0'
// get_api_info 是冻结的公开自省面；后续 _V12_EXTRA 方法虽可直接调用，但必须隐身。
// 此清单与 legacy Api 公共方法减 _V12_EXTRA 后的 51 项一致，不能用 listMethods() 替代。
const PUBLIC_API_METHODS = [
  'append_file', 'append_memory', 'append_worklog', 'build_system_prompt', 'build_tools',
  'cache_tool_output', 'clear_caches', 'copy_into_ws', 'copy_path', 'delete_path',
  'delete_session_ws', 'get_api_info', 'get_clipboard', 'get_config', 'get_cwd',
  'get_effective_ws', 'get_file_info', 'get_memory', 'get_session_ws', 'get_sessions',
  'get_worklog', 'get_ws_enabled', 'get_ws_state', 'kill_process', 'list_dir',
  'list_processes', 'list_recent_ws', 'make_dir', 'move_path', 'open_app', 'open_billing',
  'open_url', 'pick_folder', 'read_file', 'read_more', 'rpc', 'run_admin_command',
  'run_command', 'run_powershell', 'save_config', 'save_sessions', 'save_workspace_file',
  'search_replace', 'set_clipboard', 'set_current_sid', 'set_session_ws', 'set_workspace',
  'set_ws_dir', 'set_ws_enabled', 'take_screenshot', 'write_file',
]

const handlers = new Map()
const explicitSignatures = new Map()

export function register(name, handler, signature = null) {
  if (handlers.has(name)) throw new Error(`js_api 方法重复注册: ${name}`)
  handlers.set(name, handler)
  if (signature) explicitSignatures.set(name, signature)
}

export function listMethods() {
  return [...handlers.keys()].sort()
}
export function handlerSignature(handler) {
  const source = handler.toString().replace(/^async\s+/, '')
  const arrow = source.indexOf('=>')
  let signature = (arrow >= 0 ? source.slice(0, arrow) : source).trim()
  signature = signature.replace(/^\(/, '').replace(/\)\s*$/, '').trim()
  return signature ? signature.split(',').map(x => x.trim().split('=')[0].trim()).filter(x => /^[A-Za-z_$][\w$]*$/.test(x)) : []
}
export function listSignatures() {
  return Object.fromEntries([...handlers].map(([name, handler]) => [name, explicitSignatures.get(name) || handlerSignature(handler)]))
}

export class JsApiError extends Error {
  constructor(code, message, hint) {
    super(message)
    this.code = code
    this.hint = hint
  }
}

export async function invoke(name, args = []) {
  const handler = handlers.get(name)
  if (!handler) {
    throw new JsApiError('NOT_MIGRATED',
      `js_api 方法尚未迁移到 Node 后端: ${name}`,
      '该方法仍在 Python 后端；前端应按既有降级路径处理')
  }
  return handler(...args)
}

/* ---------------- 已迁移方法 ---------------- */

register('get_api_info', async () => JSON.stringify({
  version: API_VERSION,
  exe: 'node(server/src/index.js)',
  methods: PUBLIC_API_METHODS,
}))

register('get_sessions', async () => getSessions())
register('save_sessions', async data => saveSessions(data))

/* 配置与工作目录（低危本地读写，无命令执行面） */
register('get_config', async () => getConfig())
register('save_config', async config_json => saveConfig(config_json))
register('get_cwd', async () => getCwd())
register('set_workspace', async path => setWorkspace(path))

/* 会话身份与工作日志 */
register('set_current_sid', async sid => String(setCurrentSid(sid) || ''))
register('get_worklog', async () => getWorklog())
register('append_worklog', async text => appendWorklog(text))

/* 文件工具族（全部经路径监狱，无命令执行面） */
register('list_dir', async path => listDir(path))
register('read_file', async (path, offset, limit, force) => readFile(path, offset, limit, force))
register('read_more', async (cache_id, offset, limit) => readMore(cache_id, offset, limit))
register('write_file', async (path, content) => writeFile(path, content))
register('append_file', async (path, content) => appendFile(path, content))
register('search_replace', async (path, old, new_value, replace_all) =>
  searchReplace(path, old, new_value, replace_all), ['path', 'old', 'new', 'replace_all'])
register('make_dir', async path => makeDir(path))
register('get_file_info', async path => getFileInfo(path))

/* 会话工作区族 */
register('get_effective_ws', async () => workspace.getEffectiveWs())
register('get_session_ws', async sid => workspace.getSessionWs(sid))
register('set_session_ws', async (sid, path, enabled) => workspace.setSessionWs(sid, path, enabled))
register('delete_session_ws', async sid => workspace.deleteSessionWs(sid))
register('get_ws_enabled', async sid => workspace.getWsEnabled(sid))
register('set_ws_enabled', async (sid, enabled) => workspace.setWsEnabled(sid, enabled))
register('get_ws_state', async sid => workspace.getWsState(sid))
register('set_ws_dir', async path => workspace.setWsDir(path))
register('list_recent_ws', async () => workspace.listRecentWs())
register('save_workspace_file', async (name, text) => workspace.saveWorkspaceFile(name, text))
register('copy_into_ws', async (src, name) => workspace.copyIntoWs(src, name))
register('copy_path', async (path, new_path) => workspace.copyPath(path, new_path))
register('move_path', async (path, new_path) => workspace.movePath(path, new_path))
register('delete_path', async (path, recycle, token) => workspace.deletePath(path, recycle, token))

/* 记忆 */
register('get_memory', async () => memory.getMemory())
register('append_memory', async entry_json => memory.appendMemory(entry_json))
register('memory_delete', async index => memory.memoryDelete(index))
register('memory_retrieve', async (query, limit) => memory.memoryRetrieve(query, limit))

/* 计划与检查点（目录快照语义，不调用 git） */
register('plan_create', async (title, steps, task_id) => plans.planCreate(title, steps, task_id))
register('plan_get', async task_id => plans.planGet(task_id))
register('plan_list', async limit => plans.planList(limit))
register('plan_update', async (task_id, status, step_index, step_status) =>
  plans.planUpdate(task_id, status, step_index, step_status))
register('begin_task', async () => commands.beginTask())
register('checkpoint_create', async (task_id, files, ws_dir) => plans.checkpointCreate(task_id, files, ws_dir))
register('checkpoint_list', async task_id => plans.checkpointList(task_id))
register('checkpoint_rollback', async (task_id, ws_dir, confirm) => plans.checkpointRollback(task_id, ws_dir, confirm))

/* 独立 JSON 配置族（config.json 零污染，各自独立文件）。
 * guard 走归一化配置面（P0-1b G9/G12：读归一全量、写校验+整写）——不能套用
 * 下面的裸文本模板（形状与 legacy guard_get_config 对齐）。 */
for (const [name, file] of [
  ['sandbox', 'sandbox.json'], ['hybrid', 'hybrid.json'],
  ['webdav', 'webdav.json'],
]) {
  register(`${name}_get_config`, async () => readConfigText(file))
  register(`${name}_save_config`, async cfg_json => mergeConfig(file, cfg_json))
}
register('guard_get_config', async () => guard.guardGetConfig())
register('guard_save_config', async cfg_json => guard.guardSaveConfig(cfg_json))
// 注意：model_prefs 与 reader 在 legacy 中就是 get/save 而非 get_config/save_config，
// 不能套用上面的命名模板（否则与 43 个契约方法名不一致）。
register('model_prefs_get', async () => readConfigText('model_prefs.json'))
register('model_prefs_save', async prefs_json => mergeConfig('model_prefs.json', prefs_json))
register('reader_config_get', async () => readConfigText('reader.json'))
register('reader_config_save', async config_json => mergeConfig('reader.json', config_json))
register('sandbox_status', async () => JSON.stringify(readConfigJson('sandbox.json', {})))

/* 审计 / 搜索 / 历史目录 */
register('get_audit_log', async (limit, offset, verify_all) => misc.getAuditLog(limit, offset, verify_all))
register('guard_audit', async (op, detail_json, decision) => misc.guardAudit(op, detail_json, 'decision', decision))
register('search_cache_stats', async () => misc.searchCacheStats())
register('search_reader_stats', async () => misc.searchReaderStats())
register('search_status', async task_id => misc.searchStatus(task_id))
register('history_dir_get', async () => misc.historyDirGet())
register('history_dir_set', async (dir_path, migrate) => misc.historyDirSet(dir_path, migrate))

/* OS 原生（kill_process 属危险操作，护栏未迁移前保持 NOT_MIGRATED） */
register('get_platform_info', async () => system.getPlatformInfo())
register('list_processes', async keyword => system.listProcesses(keyword))
register('open_app', async (path, token) => system.openApp(path, token))
register('open_url', async url => system.openUrl(url))
register('open_billing', async () => system.openBilling())
register('get_clipboard', async token => system.getClipboard(token))
register('set_clipboard', async (text, token) => system.setClipboard(text, token))
register('pick_folder', async sid => system.pickFolder(sid))
register('pick_save_path', async default_name => system.pickSavePath(default_name))
register('take_screenshot', async (left, top, width, height, token) => system.takeScreenshot(left, top, width, height, token))

/* 本地模型端点 / 工具清单 / 提示词 / 杂项 */
register('get_local_proxy', async () => provider.getLocalProxy())
register('local_models', async (base_url, api_key) => provider.localModels(base_url, api_key))
register('local_probe', async ports => provider.localProbe(ports))
register('local_readiness', async (base_url, model, api_key) => provider.localReadiness(base_url, model, api_key))
register('test_provider_endpoint', async (base_url, api_key, model, timeout, local) =>
  provider.testProviderEndpoint(base_url, api_key, model, timeout, local))
register('build_tools', async (role, include_mcp, include_agent, is_glm_endpoint) =>
  provider.buildTools(role, include_mcp, include_agent, is_glm_endpoint))
register('build_system_prompt', async query => provider.buildSystemPrompt(query))
register('prompt_get', async prompt_id => provider.promptGet(prompt_id))
register('cache_tool_output', async content => provider.cacheToolOutput(content))
register('clear_caches', async () => provider.clearCaches())
register('trace_new', async () => provider.traceNew())
register('ui_nudge', async visibility => provider.uiNudge(visibility))
register('clarify_collect', async (questions, answers) => provider.clarifyCollect(questions, answers))
register('save_export_file', async (path, content) => provider.saveExportFile(path, content))
register('session_purge', async (sid, task_ids_json) => provider.sessionPurge(sid, task_ids_json))

/* 通用 RPC 透传（legacy payload 是 kwargs 对象，不是把对象当第一个位置参数）。 */
register('rpc', async (name, payload_json = '{}') => {
  const method = String(name || '')
  const handler = handlers.get(method)
  if (!handler || method === 'rpc' || method.startsWith('_')) return JSON.stringify({ error: `未知方法: ${method}` })
  let payload
  try { payload = JSON.parse(String(payload_json || '{}')) } catch { payload = {} }
  if (Array.isArray(payload)) return handler(...payload)
  if (!payload || typeof payload !== 'object') payload = {}
  // 注册处理器保留了 legacy 的参数名；从函数形参还原 kwargs → argv 的稳定映射。
  const names = explicitSignatures.get(method) || handlerSignature(handler)
  return handler(...names.map(key => payload[key]))
})

/* 护栏判定链（P0-1b T01：guard_get/save_config 走归一化配置面；guard_check 落 action 审计） */
register('guard_check', async (op, detail_json) => guard.guardCheckApi(op, detail_json))
register('guard_confirm_token', async (op, detail_json) => guard.guardConfirmToken(op, asDetail(detail_json)))
register('guard_session_trust', async op => guard.guardSessionTrust(op))
register('guard_rule_add', async (op_pattern, detail_pattern, note) => guard.guardRuleAdd(op_pattern, detail_pattern, note))
register('guard_rule_list', async () => guard.guardRuleList())
register('guard_rule_remove', async rule_id => guard.guardRuleRemove(rule_id))
register('guard_task_grant', async (scope, ttl_seconds) => guard.guardTaskGrant(scope, ttl_seconds))
register('guard_task_revoke', async grant_id => guard.guardTaskRevoke(grant_id))
register('guard_task_status', async () => guard.guardTaskStatus())
register('guard_approval_budget', async limit => guard.guardApprovalBudget(limit))

/* 危险操作（护栏强制：token 或会话信任） */
register('kill_process', async (pid, name, token) => system.killProcess(pid, name, token))

/* 命令执行（护栏 + 沙箱黑名单/超时/截断/工作目录限定） */
register('run_command', async (cmd, timeout, token) => commands.runCommand(cmd, timeout, token))
register('run_powershell', async (cmd, timeout, token) => commands.runPowershell(cmd, timeout, token))
register('run_admin_command', async (cmd, token, timeout) => commands.runAdminCommand(cmd, token, timeout))
register('software_call', async (params, token) => commands.softwareCall(params, token))
register('software_list', async status => commands.softwareList(status))
register('software_probe', async name => commands.softwareProbe(name))

/* 自动更新（HTTPS、禁重定向、大小限制、SHA256 完整性校验） */
register('check_update', async manifest_url => update.checkUpdate(manifest_url))
register('start_update_download', async (url, sha256, version) => update.startUpdateDownload(url, sha256, version))
register('get_update_progress', async () => update.getUpdateProgress())
register('apply_update', async () => update.applyUpdate())

/* WebDAV 数据主权（HTTPS、本机开发例外、禁重定向、SHA256 与冲突策略） */
register('webdav_test', async cfg_json => webdav.webdavTest(cfg_json))
register('webdav_export', async () => webdav.webdavExport())
register('webdav_restore', async payload_json => webdav.webdavRestore(payload_json))

/* 专家包（内容寻址快照、只读资源、链接/硬链接/路径穿越防护） */
register('expert_list', async query => experts.expertList(query))
register('expert_get', async (package_id, snapshot_id) => experts.expertGet(package_id, snapshot_id))
register('expert_import_directory', async path => experts.expertImportDirectory(path))
register('expert_read_resource', async (snapshot_id, path) => experts.expertReadResource(snapshot_id, path))
register('expert_save_preferences', async prefs_json => experts.expertSavePreferences(prefs_json))
register('expert_set_enabled', async (package_id, enabled, snapshot_id) => experts.expertSetEnabled(package_id, enabled, snapshot_id))
register('expert_delete_package', async package_id => experts.expertDeletePackage(package_id))

/* MCP（官方 SDK：stdio + Streamable HTTP；工具参数绑定 token；资源与订阅） */
register('mcp_list_servers', async () => mcp.mcpListServers())
register('mcp_save_server', async (name, config_json) => mcp.mcpSaveServer(name, config_json))
register('mcp_delete_server', async name => mcp.mcpDeleteServer(name))
register('mcp_test_server', async name => mcp.mcpTestServer(name))
register('mcp_get_server_detail', async name => mcp.mcpGetServerDetail(name))
register('mcp_set_tool_tier', async (server, tool, tier) => mcp.mcpSetToolTier(server, tool, tier))
register('mcp_check_tool', async (server, tool, arguments_json) => mcp.mcpCheckTool(server, tool, arguments_json))
register('mcp_call_tool', async (server, tool, arguments_json, decision, token) => mcp.mcpCallTool(server, tool, arguments_json, decision, token))
register('mcp_import_claude', async config_json => mcp.mcpImportClaude(config_json))
register('mcp_list_resources', async server => mcp.mcpListResources(server))
register('mcp_read_resource', async (server, uri) => mcp.mcpReadResource(server, uri))
register('mcp_save_subscriptions', async (server, uris_json) => mcp.mcpSaveSubscriptions(server, uris_json))
register('mcp_shutdown', async () => mcp.mcpShutdown())

/* 浏览器驱动（Playwright + 本机 Edge/Chrome；默认后台；实时搜索与 CAPTCHA 接管） */
register('browser_navigate', async (url, wait_selector, timeout, mode, token) => browser.browserNavigate(url, wait_selector, timeout, mode, token))
register('browser_extract', async (selector, mode, token) => browser.browserExtract(selector, mode, token))
register('browser_click', async (target, token) => browser.browserClick(target, token))
register('browser_fill', async (selector, text, token) => browser.browserFill(selector, text, token))
register('browser_screenshot', async (full_page, token) => browser.browserScreenshot(full_page, token))
register('browser_close', async (session_id, token) => browser.browserClose(session_id, token))
register('browser_sessions', async () => browser.browserSessions())
register('browser_set_mode', async (mode, session_id) => browser.browserSetMode(mode, session_id))
register('browser_search', async (params, token) => browser.browserSearch(params, token))
register('browser_open', async params => browser.browserOpen(params))
register('browser_takeover', async (takeover_id, action) => browser.browserTakeover(takeover_id, action))
