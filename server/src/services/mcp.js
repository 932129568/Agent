/** MCP 原生客户端：Claude 兼容配置、stdio/Streamable HTTP、工具护栏与资源。 */
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CONFIG_DIR, atomicWriteJson, readJsonIfExists } from '../paths.js'
import { consumeToken } from './guard.js'
import { ENC_PREFIX, encryptField, decryptMapping } from './dpapi.js'

const FILE = () => path.join(CONFIG_DIR, 'mcp_servers.json')
const json = value => JSON.stringify(value)
const runtime = new Map()
const VALID_TIERS = new Set(['always', 'session', 'off'])
const parse = value => { if (value && typeof value === 'object') return value; try { return JSON.parse(value || '{}') } catch { return null } }
function data() { const value = readJsonIfExists(FILE(), { mcpServers: {} }); return value && value.mcpServers ? value : { mcpServers: {} } }
function save(value) { atomicWriteJson(FILE(), value) }
function serverConfig(name) { return data().mcpServers[name] || null }
async function plainMapping(mapping = {}) {
  // P0-2 T03：DPAPI 解密（mcp_dpapi.decrypt_mapping 同构）——失败键保持内层
  // 标记串（W21 编辑器回显契约），并记入 decrypt_failed 面板告警
  return decryptMapping(mapping)
}
function normalized(name, input) {
  const cfg = parse(input)
  if (!name || /[\\/]/.test(name) || name === '.' || name === '..') return { error: '服务器名称不能为空且不能包含路径分隔符' }
  if (!cfg || Array.isArray(cfg)) return { error: '配置必须是 JSON 对象' }
  const out = { enabled: !!cfg.enabled, tierOverrides: {} }
  if (cfg.url) {
    let url; try { url = new URL(String(cfg.url)) } catch { return { error: 'HTTP 服务器需要有效 url' } }
    if (!['http:', 'https:'].includes(url.protocol)) return { error: 'HTTP 服务器需要 http:// 或 https:// 开头的 url' }
    out.url = url.toString(); out.headers = cfg.headers || {}
  } else if (cfg.command) {
    out.command = String(cfg.command).trim().replace(/^"|"$/g, '')
    out.args = Array.isArray(cfg.args) ? cfg.args.map(String) : String(cfg.args || '').match(/(?:[^\s"]+|"[^"]*")+/g)?.map(x => x.replace(/^"|"$/g, '')) || []
    out.env = cfg.env || {}
  } else return { error: 'stdio 服务器需要 command，HTTP 服务器需要 url' }
  for (const [tool, tier] of Object.entries(cfg.tierOverrides || {})) {
    if (!VALID_TIERS.has(tier)) return { error: `档位 ${tier} 非法（仅支持 always/session/off）` }
    out.tierOverrides[tool] = tier
  }
  if (cfg.callTimeout != null && cfg.callTimeout !== '') {
    const timeout = Number(cfg.callTimeout)
    if (!Number.isInteger(timeout) || timeout < 10 || timeout > 300) return { error: 'callTimeout 必须是 10-300 的整数（秒）' }
    out.callTimeout = timeout
  }
  if (Array.isArray(cfg.resourceSubs)) out.resourceSubs = cfg.resourceSubs.filter(x => typeof x === 'string').map(x => x.slice(0, 500)).slice(0, 100)
  return { record: out }
}
async function closeRuntime(name) {
  const entry = runtime.get(name); if (!entry) return 0
  runtime.delete(name)
  try { await entry.client.close() } catch {}
  try { await entry.transport.close() } catch {}
  return 1
}
async function connect(name, configOverride) {
  const cfg = configOverride || serverConfig(name)
  if (!cfg) throw new Error(`服务器不存在: ${name}`)
  if (!configOverride && !cfg.enabled) throw new Error(`MCP 服务器 ${name} 未启用`)
  const existing = runtime.get(name); if (existing && !configOverride) return existing
  const client = new Client({ name: 'harbor-node', version: '1.0.0' }, { capabilities: {} })
  let transport
  if (cfg.url) {
    const { values: headers } = await plainMapping(cfg.headers)
    // 安全边界（_spawn_client 同款）：解密失败的密文串永不下发 HTTP 头
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string' && value.startsWith(ENC_PREFIX)) headers[key] = ''
    }
    transport = new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers, redirect: 'error' }, redirectPolicy: 'same-origin' })
  } else {
    const { values: plainEnv } = await plainMapping(cfg.env)
    for (const [key, value] of Object.entries(plainEnv)) {
      if (typeof value === 'string' && value.startsWith(ENC_PREFIX)) plainEnv[key] = ''
    }
    const env = { ...process.env, ...plainEnv }
    transport = new StdioClientTransport({ command: cfg.command, args: cfg.args || [], env, cwd: cfg.cwd || process.cwd(), stderr: 'pipe' })
  }
  try {
    await client.connect(transport, { timeout: 30000 })
    const listed = await client.listTools(undefined, { timeout: Math.max(10000, (cfg.callTimeout || 60) * 1000) })
    const entry = { client, transport, tools: listed.tools || [], resources: [], status: 'ok', last_error: '', server_info: client.getServerVersion() || {}, instructions: client.getInstructions() || '' }
    if (!configOverride) runtime.set(name, entry)
    return entry
  } catch (error) {
    await client.close().catch(() => {}); await transport.close().catch(() => {})
    throw error
  }
}
export async function mcpListServers() {
  const servers = Object.entries(data().mcpServers).map(([name, cfg]) => {
    const entry = runtime.get(name)
    // P0-1c MC2（mcp_service.list_servers:205-237）：补 warm/spawn_ms 两键
    // （温启状态与冷启耗时——Node 未做温启登记，恒 false/null 如实陈述）
    return { name, transport: cfg.url ? 'http' : 'stdio', enabled: !!cfg.enabled,
      status: !cfg.enabled ? 'disabled' : entry?.status || 'stale', tool_count: entry?.tools?.length || 0,
      last_error: entry?.last_error || '', callTimeout: cfg.callTimeout ?? null,
      warm: runtime.has(name), spawn_ms: null,
      health: entry?.last_error ? 'error' : 'ok', schema_review: false }
  }).sort((a, b) => a.name.localeCompare(b.name))
  return json({ ok: true, servers })
}
export async function mcpSaveServer(name, configJson) {
  // P0-1c MC1（api.py:1441-1481 包装口径）：停用保存 → {ok, name}（无 enabled
  // 回显）；启用保存 → 测试连接，失败回弹停用 + flat error。
  // enabled 未携带时保留既有开关（config_service.save_server:282-283 同款）。
  let cfg
  try { cfg = JSON.parse(String(configJson ?? '{}')) } catch (error) {
    return json({ error: `配置解析失败: ${error.message}` })
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return json({ error: '配置必须是 JSON 对象' })
  const cleanName = String(name || '').trim()
  if (!cleanName) return json({ error: '服务器名称不能为空' })
  const { record, error } = normalized(cleanName, cfg)
  if (error) return json({ error })
  const previous = serverConfig(cleanName)
  if (!Object.hasOwn(cfg, 'enabled')) record.enabled = !!(previous && previous.enabled)
  if (previous && parse(configJson)?.tierOverrides == null) record.tierOverrides = previous.tierOverrides || {}
  // P0-2 T03：env/headers 字段级加密（_encrypt_field 同构——已是标记的原样透传、
  // 不可解按内层串重加；明文兜底键入 encrypt_plain（W21 面板提示）。
  // import_claude 路径不加密（Python 同款——由启动迁移补齐）
  let plainKeys = []
  if (record.env) {
    const encrypted = await encryptField(record.env)
    record.env = encrypted.values
    plainKeys = [...plainKeys, ...encrypted.plainKeys]
  }
  if (record.headers) {
    const encrypted = await encryptField(record.headers)
    record.headers = encrypted.values
    plainKeys = [...plainKeys, ...encrypted.plainKeys]
  }
  const wantEnable = !!record.enabled
  if (wantEnable) {
    try {
      const tested = await connect(cleanName, { ...record, enabled: true })
      await tested.client.close().catch(() => {}); await tested.transport.close().catch(() => {})
    } catch (testError) {
      // 测试连接失败 → 回弹 enabled=false（配置已保存，保持停用）
      await closeRuntime(cleanName)
      const all = data(); all.mcpServers[cleanName] = { ...record, enabled: false }; save(all)
      return json({ error: testError.message })
    }
  }
  await closeRuntime(cleanName); const all = data(); all.mcpServers[cleanName] = record; save(all)
  return json({ ok: true, name: cleanName })
}
export async function mcpDeleteServer(name) {
  const all = data(); if (!all.mcpServers[name]) return json({ error: `服务器不存在: ${name}` })
  delete all.mcpServers[name]; save(all); await closeRuntime(name); return json({ ok: true })
}
export async function mcpTestServer(name) {
  // P0-1c MC9：不存在服务器显式错误（原 undefined 解引用泄漏内部 TypeError 文案
  // ——性质同 P0-1b 的 500 泄漏，防御缺失修复）
  const stored = serverConfig(name)
  if (!stored) return json({ error: `服务器不存在: ${name}` })
  try { await closeRuntime(name); const entry = await connect(name, { ...stored, enabled: true })
    runtime.set(name, entry); return json({ ok: true, name, tools: entry.tools, tool_count: entry.tools.length, server_info: entry.server_info, instructions: entry.instructions }) }
  catch (error) { return json({ error: error.message }) }
}
export async function mcpGetServerDetail(name) {
  const cfg = serverConfig(name); if (!cfg) return json({ error: `服务器不存在: ${name}` })
  const entry = runtime.get(name); const env = await plainMapping(cfg.env); const headers = await plainMapping(cfg.headers)
  // P0-1c MC3（mcp_config_service.get_server:139-158 + mcp_service.get_server_detail:328-353）：
  // config 视图 = 存储副本 + name + env/headers 解密视图 + decrypt_failed；
  // headers 仅在存储携带时透出（stdio 服务器无 headers 键——Python 同款）
  const view = { ...cfg }
  view.name = name
  view.env = env.values
  if (cfg.headers) view.headers = headers.values
  view.decrypt_failed = [...env.failed, ...headers.failed]
  return json({ ok: true, name, transport: cfg.url ? 'http' : 'stdio', status: !cfg.enabled ? 'disabled' : entry?.status || 'stale',
    last_error: entry?.last_error || '', config: view,
    tierOverrides: cfg.tierOverrides || {}, tools: (entry?.tools || []).map(tool => ({ ...tool, tier: cfg.tierOverrides?.[tool.name] || 'always' })),
    instructions: entry?.instructions || '', server_info: entry?.server_info || {}, decrypt_failed: [...env.failed, ...headers.failed] })
}
export async function mcpSetToolTier(server, tool, tier) {
  // P0-1c MC4：'档位必须是 always/session/off'（config_service.set_tool_tier:372 逐字）
  if (!VALID_TIERS.has(tier)) return json({ error: '档位必须是 always/session/off' })
  const all = data(); const cfg = all.mcpServers[server]; if (!cfg) return json({ error: `服务器不存在: ${server}` })
  cfg.tierOverrides ||= {}; cfg.tierOverrides[tool] = tier; save(all); return json({ ok: true })
}
function argsOf(value) { const parsed = parse(value || '{}'); return parsed && !Array.isArray(parsed) ? parsed : {} }
export async function mcpCheckTool(server, tool, argumentsJson = '{}') {
  const cfg = serverConfig(server)
  if (!cfg) return json({ action: 'block', reason: `MCP 服务器 ${server} 不存在。` })
  // P0-1c MC5（mcp_service.check_tool:589-592 逐字）：'（可能已禁用或崩溃）'从句
  if (!cfg.enabled) return json({ action: 'block', reason: `MCP 服务器 ${server} 未启用（可能已禁用或崩溃），请先在设置中测试连接。` })
  const tier = cfg.tierOverrides?.[tool] || 'always'
  if (tier === 'off') return json({ action: 'allow', tier, tier_source: 'override' })
  return json({ action: 'confirm', tier, tier_source: cfg.tierOverrides?.[tool] ? 'override' : 'default', reason: `该工具需要确认（档位 ${tier}）。` })
}
export async function mcpCallTool(server, tool, argumentsJson = '{}', decision = 'deny', token = null) {
  // P0-1c MC6（mcp_service.call_tool:603-640 校验顺序）：服务器存在 → 启用 →
  // 档位 → decision 方言——「以用户拒绝话术掩盖服务器未启用」的误导性回执
  // 在 Python 不存在，Node 对齐同序
  const cfg = serverConfig(server)
  if (!cfg) return json({ error: `MCP 服务器 ${server} 不存在。` })
  if (!cfg.enabled) return json({ error: `MCP 服务器 ${server} 未启用（可能已禁用或崩溃），请先在设置中测试连接。` })
  if (decision === 'deny') return json({ info: `用户拒绝了本次 MCP 工具调用（${server} · ${tool}）。请调整方案或询问用户意图，不要原样重试。`, skipped: true })
  const verdict = JSON.parse(await mcpCheckTool(server, tool, argumentsJson))
  if (verdict.action === 'block') return json({ error: verdict.reason })
  const args = argsOf(argumentsJson); const detail = { server, tool, arguments: args }
  if (verdict.tier !== 'off') {
    if (!['allow', 'session-trust'].includes(decision)) return json({ error: `该工具需要确认（档位 ${verdict.tier}）。请通过界面确认后重试，不要绕过确认流程。` })
    if (!token || !(await consumeToken('mcp_call', detail, token))) return json({ error: 'MCP 工具缺少有效的一次性确认 token（参数可能已变化），请重新确认。' })
  }
  try {
    const entry = await connect(server); const cfgNow = serverConfig(server)
    const result = await entry.client.callTool({ name: tool, arguments: args }, undefined, { timeout: (cfgNow.callTimeout || 60) * 1000 })
    const output = (result.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n') || JSON.stringify(result.structuredContent ?? result)
    return json({ ok: true, output, content: result.content || [], structuredContent: result.structuredContent, isError: !!result.isError })
  } catch (error) {
    const entry = runtime.get(server); if (entry) { entry.last_error = error.message; entry.status = 'error' }
    return json({ error: `MCP 工具调用失败: ${error.message}` })
  }
}
export async function mcpImportClaude(configJson) {
  const input = parse(configJson)
  if (!input || !input.mcpServers || typeof input.mcpServers !== 'object') return json({ error: '未找到 mcpServers 段——请粘贴 claude_desktop_config.json 全文' })
  // P0-1c MC8（config_service.import_claude:394-437）：imported 为名字数组
  const all = data(); const imported = []; const skipped = []; const entries = Object.entries(input.mcpServers)
  for (const [name, cfg] of entries) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) { skipped.push({ name, reason: '条目不是对象，已跳过' }); continue }
    if (String(cfg.type || '').toLowerCase() === 'sse') { skipped.push({ name, reason: 'SSE 传输不受支持（v1.3 仅支持 stdio 与 Streamable HTTP）' }); continue }
    if (all.mcpServers[name]) { skipped.push({ name, reason: '同名服务器已存在，已跳过（可编辑后覆盖保存）' }); continue }
    const { record, error } = normalized(name, { ...cfg, enabled: false })
    if (error) { skipped.push({ name, reason: error }); continue }
    all.mcpServers[name] = record; imported.push(name)
  }
  save(all); return json({ ok: true, imported, skipped, total: entries.length })
}
export async function mcpListResources(server) {
  // P0-1c MC7（mcp_service.list_resources:725-754）：服务器存在/启用检查先于
  // 连接（未启用 → flat 'MCP 服务器 X 未启用。'，无前缀包裹）；前缀文案仅用于
  // 客户端调用异常路径
  const cfg = serverConfig(server)
  if (!cfg) return json({ error: `MCP 服务器 ${server} 不存在。` })
  if (!cfg.enabled) return json({ error: `MCP 服务器 ${server} 未启用。` })
  try { const entry = await connect(server); const result = await entry.client.listResources(undefined, { timeout: 60000 })
    entry.resources = result.resources || []; return json({ ok: true, resources: entry.resources, supported: true }) }
  catch (error) { if (error.code === -32601 || /Method not found/i.test(error.message)) return json({ ok: true, resources: [], supported: false })
    return json({ error: `MCP 资源列表获取失败: ${error.message}` }) }
}
export async function mcpReadResource(server, uri) {
  // P0-1c MC7（mcp_service.read_resource:756-789）：uri 空检 → 存在 → 启用 →
  // 连接（顺序即语义，与 Python 同序）
  if (!uri) return json({ error: '缺少资源 uri' })
  const cfg = serverConfig(server)
  if (!cfg) return json({ error: `MCP 服务器 ${server} 不存在。` })
  if (!cfg.enabled) return json({ error: `MCP 服务器 ${server} 未启用。` })
  try { const entry = await connect(server); const result = await entry.client.readResource({ uri }, { timeout: 60000 })
    const contents = result.contents || []; const text = contents.filter(x => x.text).map(x => x.text).join('\n')
    return json({ ok: true, text, contents, blobs: contents.filter(x => x.blob).map(x => x.blob) }) }
  catch (error) { return json({ error: `MCP 资源读取失败: ${error.message}` }) }
}
export async function mcpSaveSubscriptions(server, urisJson = '[]') {
  const uris = parse(urisJson || '[]'); if (!Array.isArray(uris)) return json({ error: 'uris 需要是 JSON 数组' })
  const all = data(); const cfg = all.mcpServers[server]; if (!cfg) return json({ error: `服务器不存在: ${server}` })
  const clean = uris.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim().slice(0, 500)).slice(0, 100)
  cfg.resourceSubs = clean; save(all); return json({ ok: true, subscribed: clean })
}
export async function mcpToolSchemas() {
  const tools = []
  for (const [name, cfg] of Object.entries(data().mcpServers)) {
    if (!cfg.enabled) continue
    try {
      const entry = await connect(name)
      for (const tool of entry.tools) {
        const safeServer = name.replace(/[^a-zA-Z0-9_-]/g, '_')
        const safeTool = String(tool.name).replace(/[^a-zA-Z0-9_-]/g, '_')
        tools.push({ type: 'function', function: { name: `mcp__${safeServer}__${safeTool}`,
          description: String(tool.description || `MCP ${name}/${tool.name}`).slice(0, 1024),
          parameters: tool.inputSchema || { type: 'object', properties: {} } } })
      }
    } catch { /* 单个服务器不可用不应让内置工具面整体失效 */ }
  }
  return tools
}
export async function mcpShutdown() {
  let closed = 0; for (const name of [...runtime.keys()]) closed += await closeRuntime(name)
  return json({ ok: true, closed })
}
