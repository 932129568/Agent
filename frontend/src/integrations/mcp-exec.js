/* ================= MCP 工具执行分发（v1.3 R3/R4） =================
 * 插在 60-agent-loop 后、65 前：Agent 循环里 mcp__<server>__<tool> 的护栏确认与执行分发。
 * - mcpParseName：/^mcp__(.+?)__(.+)$/ 解析（净化规则保证 server 段无 __ 歧义）。
 * - mcpGuardCheck：mcp_check_tool 定档 + uiConfirm 确认框（复用 26-guard 模式，
 *   含「本会话内不再提示」勾选 → mcpTrusted 会话信任态）；block 直接作为工具结果。
 *   修复 S4①：确认通过后调 guard_confirm_token('mcp_call', {server, tool}) 换一次性 token，
 *   随 mcp_call_tool 携带——武装后后端强制校验 token/会话信任，前端确认不再是唯一防线。
 * - mcpExecTool：mcp_call_tool（decision/token 透传；timeoutMs 动态 = (callTimeout+30)×1000，
 *   修复 F2 v1.4：后端 60s→每服务器 10-300s 可配，前端桥接同步放大不提前断）。
 * - 异常 fail-closed（外部代码执行不设 fail-open）；R4 熔断由 60-agent-loop 的
 *   registerToolSig 天然覆盖（签名含 mcp__ 全名），本模块【不得】自行计数。
 * - 修复 W26：mcpTrusted 会话信任态切会话清空（newSession/switchSession），与文案
 *   「本会话内不再提示」对齐；且只对 session 档生效（always 档每次都须 token）。
 */

const MCP_CALL_TIMEOUT_MS = 90000;   // 默认桥接超时：后端默认 60s + 拉起 + 余量（F2 前口径保留）
const MCP_CALL_TIMEOUT_MAX_MS = 330000;   // 修复 F2（v1.4）：callTimeout=300 时的总上限（300+30）
const MCP_LOCAL_CAUTION = '本地模型生成的工具参数未经云端模型校验，请仔细核对';   // 修复 B5（v1.5）：与后端 MCP_LOCAL_CAUTION 同文案

/** 修复 F2（v1.4）：按服务器配置的 callTimeout 动态算前端桥接超时（ms）。
 *  配置来自 loadMcpServers 缓存运行的 mcpServers 列表（mcp_list_servers 运行视图）；
 *  取不到时回落默认 60s 口径。 */
function mcpCallTimeoutMs(server) {
  try {
    const list = (typeof mcpServers !== 'undefined') ? mcpServers : null;
    const hit = list && list.find(s => s.name === server);
    const ct = hit && hit.callTimeout != null ? parseInt(hit.callTimeout, 10) : 60;
    if (isNaN(ct) || ct < 10 || ct > 300) return MCP_CALL_TIMEOUT_MS;
    return Math.min((ct + 30) * 1000, MCP_CALL_TIMEOUT_MAX_MS);
  } catch (e) {
    return MCP_CALL_TIMEOUT_MS;
  }
}

/** mcp__server__tool → {server, tool}；非 MCP 名返回 null。 */
function mcpParseName(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(name || ''));
  if (!m) return null;
  return { server: m[1], tool: m[2] };
}

/**
 * 护栏检查（executeToolRaw 头部挂点）。
 * 返回 {blocked, decision, token}：
 * - blocked 非空 → 直接作为工具结果返回给 AI（不执行）；
 * - 否则 decision ∈ allow/session-trust + token（修复 S4①）传给 mcpExecTool。
 * 异常 → fail-closed（blocked 错误结果）。
 */
async function mcpGuardCheck(name, args) {
  const p = mcpParseName(name);
  if (!p) return { blocked: null, decision: 'allow', token: null };
  args = args || {};
  const trustKey = p.server + '__' + p.tool;
  // 修复 B5（v1.5）：local 模式会话信任降级为仅本任务有效——跨任务重新确认
  // （本地模型工具参数幻觉风险高，保守策略）
  const _localMode = (typeof localState !== 'undefined' && localState.mode);
  if (!_localMode && mcpTrusted.has(trustKey)) return { blocked: null, decision: 'session-trust', token: null };

  let verdict = { action: 'confirm' };
  try {
    const raw = await callApi('mcp_check_tool', [p.server, p.tool, JSON.stringify(args)]);
    verdict = JSON.parse(raw) || {};
  } catch (e) {
    // 后端不可用（旧 exe）：fail-closed，不放行外部代码执行
    return { blocked: JSON.stringify({ error: 'MCP 护栏不可用（后端可能为旧版，请重新打包）：' + (e.message || e) }), decision: 'deny', token: null };
  }
  if (verdict.action === 'block') {
    const reason = verdict.reason || ('MCP 服务器 ' + p.server + ' 不可用（未启用或不存在）。');
    toast(reason, 'warn');
    return { blocked: JSON.stringify({ info: reason, skipped: true }), decision: 'deny', token: null };
  }
  if (verdict.action === 'allow') return { blocked: null, decision: 'allow', token: null };

  // action=confirm：弹确认框（服务器/工具/参数全文/档位来源 + 本会话不再提示）
  const tierName = { always: '每次确认', session: '会话内首次确认', off: '不确认' };
  const srcName = { override: '用户覆盖', annotation: '按服务器注解推导', default: '保守默认' };
  const body = 'AI 请求调用 MCP 工具：\n服务器：' + p.server + '\n工具：' + p.tool +
    '\n档位：' + (tierName[verdict.tier] || verdict.tier || '?') +
    '（' + (srcName[verdict.tier_source] || verdict.tier_source || '?') + '）' +
    '\n参数：\n' + JSON.stringify(args, null, 2).slice(0, 2000) +
    '\n\nMCP 服务器是可执行任意本地代码的外部组件，请确认你信任该来源。' +
    // 修复 B5（v1.5）：local 模式追加保守提示（本地模型参数幻觉风险）
    (_localMode ? '\n\n⚠ ' + MCP_LOCAL_CAUTION : '');
  const r = await uiConfirm({
    title: '确认调用 MCP 工具', body, danger: verdict.tier === 'always',
    okText: '允许调用',
    checkboxLabel: '本会话内不再提示「' + p.server + ' · ' + p.tool + '」' + (_localMode ? '（本地模式：仅本任务有效）' : '')
  });
  if (!r.ok) {
    // 用户拒绝：落审计（decision=deny）+ Agent 可见人话（⊘ 渲染）
    const msg = '用户拒绝了本次 MCP 工具调用（' + p.server + ' · ' + p.tool +
      '）。请调整方案或询问用户意图，不要原样重试。';
    try { await mcpExecTool(name, args, 'deny'); } catch (e) {}
    toast('已拒绝 AI 的 MCP 工具调用', 'ok');
    return { blocked: JSON.stringify({ info: msg, skipped: true }), decision: 'deny', token: null };
  }
  // 修复 S4①：同意后换一次性 confirm token（op='mcp_call'，绑定 server+tool+arguments
  // 摘要——W4：实参也进摘要，防确认后篡改参数；与后端 mcp_service.call_tool 的
  // consume_token detail 同口径）
  let token = null;
  try {
    const t = JSON.parse(await callApi('guard_confirm_token', ['mcp_call', JSON.stringify({ server: p.server, tool: p.tool, arguments: args || {} })]));
    if (t && t.token) token = t.token;
  } catch (e) { /* 旧 exe 无此方法：留空按 legacy 直调（新后端会强制拦截并返回人话错误） */ }
  // 修复 S11（三轮）：写侧与读侧对称——local 模式勾选"不再提示"不写入 session 信任
  // （原无条件写入：读侧排除 local 但持久化后切云端预设会读到，免确认跨端点泄漏）
  if (r.checked && !_localMode) mcpTrusted.add(trustKey);
  return { blocked: null, decision: r.checked ? 'session-trust' : 'allow', token };
}

/** 执行 MCP 工具（后端二次 enforce + 审计 + 按需拉起 + 结果渲染）。修复 S4①：token 尾参透传。 */
async function mcpExecTool(name, args, decision, token) {
  const p = mcpParseName(name);
  if (!p) return JSON.stringify({ error: '非法 MCP 工具名: ' + name });
  // 修复 ⑰（三轮）：mcpCallTimeoutMs 依赖 mcpServers 缓存——未开过设置面板时
  // 缓存为空，per-server callTimeout 静默失效（回落默认 90s）。执行前确保列表已加载
  try {
    if ((typeof mcpServers === 'undefined' || !mcpServers.length) && typeof loadMcpServers === 'function') {
      await loadMcpServers();
    }
  } catch (e) {}
  try {
    // 修复 S4①：token 作为第 5 个位置参数（仅非空时追加——旧 exe 没有该形参）
    const callArgs = [p.server, p.tool, JSON.stringify(args || {}), decision || 'deny'];
    if (token) callArgs.push(token);
    return await callApi('mcp_call_tool', callArgs, mcpCallTimeoutMs(p.server));   // 修复 F2（v1.4）：动态超时
  } catch (e) {
    return JSON.stringify({ error: 'MCP 工具调用失败: ' + (e.message || e) });
  }
}
