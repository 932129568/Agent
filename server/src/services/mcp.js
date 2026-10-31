/** MCP 原生客户端：Claude 兼容配置、stdio/Streamable HTTP、工具护栏与资源。 */
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CONFIG_DIR, atomicWriteJson, readJsonIfExists } from '../paths.js'
import { consumeToken } from './guard.js'

const FILE = () => path.join(CONFIG_DIR, 'mcp_servers.json')
const json = value => JSON.stringify(value)
const runtime = new Map()
const VALID_TIERS = new Set(['always', 'session', 'off'])
const parse = value => { if (value && typeof value === 'object') return value; try { return JSON.parse(value || '{}') } catch { return null } }
function data() { const value = readJsonIfExists(FILE(), { mcpServers: {} }); return value && value.mcpServers ? value : { mcpServers: {} } }
function save(value) { atomicWriteJson(FILE(), value) }
function serverConfig(name) { return data().mcpServers[name] || null }
function plainMapping(mapping = {}) {
  const out = {}; const failed = []
  for (const [key, value] of Object.entries(mapping || {})) {
    if (value && typeof value === 'object' && value.__enc__) { failed.push(key); out[key] = '' }
    else out[key] = String(value ?? '')
  }
  return { values: out, failed }
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
    const headers = plainMapping(cfg.headers).values
    transport = new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers, redirect: 'error' }, redirectPolicy: 'same-origin' })
  } else {
    const env = { ...process.env, ...plainMapping(cfg.env).values }
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
    return { name, transport: cfg.url ? 'http' : 'stdio', enabled: !!cfg.enabled,
      status: !cfg.enabled ? 'disabled' : entry?.status || 'stale', tool_count: entry?.tools?.length || 0,
      last_error: entry?.last_error || '', callTimeout: cfg.callTimeout ?? null, health: entry?.last_error ? 'error' : 'ok', schema_review: false }
  }).sort((a, b) => a.name.localeCompare(b.name))
  return json({ ok: true, servers })
}
export async function mcpSaveServer(name, configJson) {
  const { record, error } = normalized(name, configJson)
  if (error) return json({ error })
  const previous = serverConfig(name)
  if (previous && parse(configJson)?.tierOverrides == null) record.tierOverrides = previous.tierOverrides || {}
  if (record.enabled) {
    try { const tested = await connect(name, { ...record, enabled: true }); await tested.client.close(); await tested.transport.close() }
    catch (error) { return json({ error: `连接测试失败，未启用: ${error.message}` }) }
  }
  await closeRuntime(name); const all = data(); all.mcpServers[name] = record; save(all)
  return json({ ok: true, name, enabled: record.enabled })
}
export async function mcpDeleteServer(name) {
  const all = data(); if (!all.mcpServers[name]) return json({ error: `服务器不存在: ${name}` })
  delete all.mcpServers[name]; save(all); await closeRuntime(name); return json({ ok: true })
}
export async function mcpTestServer(name) {
  try { await closeRuntime(name); const entry = await connect(name, { ...serverConfig(name), enabled: true })
    runtime.set(name, entry); return json({ ok: true, name, tools: entry.tools, tool_count: entry.tools.length, server_info: entry.server_info, instructions: entry.instructions }) }
  catch (error) { return json({ error: error.message }) }
}
export async function mcpGetServerDetail(name) {
  const cfg = serverConfig(name); if (!cfg) return json({ error: `服务器不存在: ${name}` })
  const entry = runtime.get(name); const env = plainMapping(cfg.env); const headers = plainMapping(cfg.headers)
  return json({ ok: true, name, transport: cfg.url ? 'http' : 'stdio', status: !cfg.enabled ? 'disabled' : entry?.status || 'stale',
    last_error: entry?.last_error || '', config: { ...cfg, env: env.values, headers: headers.values, decrypt_failed: [...env.failed, ...headers.failed] },
    tierOverrides: cfg.tierOverrides || {}, tools: (entry?.tools || []).map(tool => ({ ...tool, tier: cfg.tierOverrides?.[tool.name] || 'always' })),
    instructions: entry?.instructions || '', server_info: entry?.server_info || {}, decrypt_failed: [...env.failed, ...headers.failed] })
}
export async function mcpSetToolTier(server, tool, tier) {
  if (!VALID_TIERS.has(tier)) return json({ error: '档位仅支持 always/session/off' })
  const all = data(); const cfg = all.mcpServers[server]; if (!cfg) return json({ error: `服务器不存在: ${server}` })
  cfg.tierOverrides ||= {}; cfg.tierOverrides[tool] = tier; save(all); return json({ ok: true })
}
function argsOf(value) { const parsed = parse(value || '{}'); return parsed && !Array.isArray(parsed) ? parsed : {} }
export async function mcpCheckTool(server, tool, argumentsJson = '{}') {
  const cfg = serverConfig(server)
  if (!cfg) return json({ action: 'block', reason: `MCP 服务器 ${server} 不存在。` })
  if (!cfg.enabled) return json({ action: 'block', reason: `MCP 服务器 ${server} 未启用，请先在设置中测试连接。` })
  const tier = cfg.tierOverrides?.[tool] || 'always'
  if (tier === 'off') return json({ action: 'allow', tier, tier_source: 'override' })
  return json({ action: 'confirm', tier, tier_source: cfg.tierOverrides?.[tool] ? 'override' : 'default', reason: `该工具需要确认（档位 ${tier}）。` })
}
export async function mcpCallTool(server, tool, argumentsJson = '{}', decision = 'deny', token = null) {
  if (decision === 'deny') return json({ info: `用户拒绝了本次 MCP 工具调用（${server} · ${tool}）。请调整方案或询问用户意图，不要原样重试。`, skipped: true })
  const verdict = JSON.parse(await mcpCheckTool(server, tool, argumentsJson))
  if (verdict.action === 'block') return json({ error: verdict.reason })
  const args = argsOf(argumentsJson); const detail = { server, tool, arguments: args }
  if (verdict.tier !== 'off') {
    if (!['allow', 'session-trust'].includes(decision)) return json({ error: `该工具需要确认（档位 ${verdict.tier}）。请通过界面确认后重试。` })
    if (!token || !(await consumeToken('mcp_call', detail, token))) return json({ error: 'MCP 工具缺少有效的一次性确认 token（参数可能已变化），请重新确认。' })
  }
  try {
    const entry = await connect(server); const cfg = serverConfig(server)
    const result = await entry.client.callTool({ name: tool, arguments: args }, undefined, { timeout: (cfg.callTimeout || 60) * 1000 })
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
  const all = data(); let imported = 0; const skipped = []; const entries = Object.entries(input.mcpServers)
  for (const [name, cfg] of entries) {
    if (all.mcpServers[name]) { skipped.push({ name, reason: '同名服务器已存在' }); continue }
    if (cfg?.type === 'sse') { skipped.push({ name, reason: '旧 SSE 传输不受支持，请使用 Streamable HTTP' }); continue }
    const { record, error } = normalized(name, { ...cfg, enabled: false })
    if (error) { skipped.push({ name, reason: error }); continue }
    all.mcpServers[name] = record; imported++
  }
  save(all); return json({ ok: true, imported, skipped, total: entries.length })
}
export async function mcpListResources(server) {
  try { const entry = await connect(server); const result = await entry.client.listResources(undefined, { timeout: 60000 })
    entry.resources = result.resources || []; return json({ ok: true, resources: entry.resources, supported: true }) }
  catch (error) { if (error.code === -32601 || /Method not found/i.test(error.message)) return json({ ok: true, resources: [], supported: false })
    return json({ error: `MCP 资源列表获取失败: ${error.message}` }) }
}
export async function mcpReadResource(server, uri) {
  if (!uri) return json({ error: '缺少资源 uri' })
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
