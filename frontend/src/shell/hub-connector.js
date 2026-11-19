/* ================= R35 · 连接器真实接入（不虚假承诺） =================
 * 背景：R33 的「启用连接器」只是把名字放进加号菜单，hubCatalogPrompt() 对
 * connector 返回空串，hubPick() 只跳设置页 —— 用户问「这些连接器真的可以用吗」，
 * 诚实的回答是「那时不能」。本模块把链路补成真的：
 *
 *   市场点「启用并接入」 → mcp_import_claude 把目录里的真实 mcp.json 配置
 *   写进 ~/.glm-chat/mcp_servers.json → mcp_save_server(enabled=true) 实测连接
 *   → run-controller 的 build_tools(role=full, include_mcp=true) 把
 *   mcp__<server>__<tool> 下发给模型 → 模型调用 → mcpExecTool → mcp_call_tool
 *   → 真实外部服务。会话内选中连接器时 hubCatalogPrompt() 注入能力说明。
 *
 * 不新增 js_api（全部复用既有隐身方法）、不碰 config.json（独立 MCP 配置文件）、
 * 不联网拉取目录（离线内置）。
 *
 * 如实分级（hubCatalogLink）：
 *   ready     有公网 MCP 配置且无需密钥 → 可真的连
 *   auth      需 API Key / OAuth / 企业账号 → 注册配置，但 Harbor 没有 WorkBuddy
 *             的 OAuth 授权体系，密钥须用户在「设置 → MCP 服务器」里填，不能自动完成
 *   local     stdio 型，需本机已安装对应 CLI / 运行时
 *   sse       仅旧 SSE 传输，后端明确不支持
 *   catalog   无 MCP 配置（WorkBuddy 自有运行时 / 纯 CLI 技能），无法直接调用
 */
const HUB_CONN_KEY = 'harbor_hub_connector_state';
const HUB_CONN_BUSY = {};
const HUB_CONN_LEVEL_ZH = {
  ready: '可直连', auth: '需授权', local: '需本机依赖',
  sse: '传输待适配', catalog: '仅目录',
};

/** 读取接入状态集：{ <id>: {ok, level, message, tools, servers, at} }。 */
function hubConnLoad() {
  try {
    const raw = localStorage.getItem(HUB_CONN_KEY);
    const d = raw ? JSON.parse(raw) : {};
    return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
  } catch (e) { return {}; }
}
function hubConnSave(all) {
  try { localStorage.setItem(HUB_CONN_KEY, JSON.stringify(all || {})); } catch (e) {}
}
function hubConnState(id) {
  return hubConnLoad()[String(id)] || null;
}
function hubConnSet(id, patch) {
  const all = hubConnLoad();
  all[String(id)] = Object.assign({ at: Date.now() }, all[String(id)] || {}, patch || {});
  hubConnSave(all);
  return all[String(id)];
}
function hubConnClear(id) {
  const all = hubConnLoad();
  delete all[String(id)];
  hubConnSave(all);
}

/** 卡片上如实展示的等级文案（未接入时显示能力边界，不写「可用」）。 */
function hubConnLevelLabel(item) {
  const link = (item && item.link) || (typeof hubCatalogLink === 'function'
    ? hubCatalogLink(item && item.id) : '') || 'catalog';
  return HUB_CONN_LEVEL_ZH[link] || '仅目录';
}

/** 卡片状态：未接入 / 已接入（含工具数）/ 失败原因 / 进行中。 */
function hubConnCardMeta(item) {
  const id = item && item.id;
  const st = hubConnState(id);
  if (HUB_CONN_BUSY[id]) return { cls: 'busy', text: '接入中…', canTest: false };
  if (st && st.ok) {
    return { cls: 'ok', text: '已接入 · ' + (Number(st.tools) || 0) + ' 个工具', canTest: true };
  }
  if (st && st.level === 'auth') {
    return { cls: 'auth', text: '需授权 · 配置已写入', canTest: true };
  }
  if (st && st.ok === false) {
    return { cls: 'error', text: '接入失败' + (st.message ? '：' + st.message : ''), canTest: true };
  }
  const level = (item && item.link) || 'catalog';
  if (level === 'ready') return { cls: 'ready', text: '可直连 · 启用即接入', canTest: true };
  if (level === 'auth') return { cls: 'auth', text: '需授权 · 需填密钥', canTest: true };
  if (level === 'local') return { cls: 'local', text: '需本机 CLI', canTest: true };
  if (level === 'sse') return { cls: 'off', text: 'SSE 传输暂不支持', canTest: false };
  return { cls: 'off', text: '仅目录 · 无法直连', canTest: false };
}

/** 把目录里的精简 MCP 配置还原成后端可注册的结构（去掉 *Keys 提示字段）。 */
function hubConnConfig(raw) {
  const out = {};
  Object.keys(raw || {}).forEach(name => {
    const src = raw[name] || {};
    const one = {};
    ['type', 'url', 'command', 'args'].forEach(k => {
      if (src[k] !== undefined && src[k] !== null) one[k] = src[k];
    });
    if (one.url || one.command) out[name] = one;
  });
  return out;
}

/** 解析 callApi 返回（可能是 JSON 字符串、对象，或 {ok,data} 包装）。 */
function hubConnParse(v) {
  if (!v) return {};
  if (typeof v === 'string') {
    try { return JSON.parse(v) || {}; } catch (e) { return {}; }
  }
  return (typeof v === 'object') ? v : {};
}

/** 真正接入：注册配置 → 启用并实测连接 → 记录真实结果。
 *  返回 {ok, level, message, tools, servers}；任何一步失败都不谎报成功。 */
async function hubConnectorInstall(id) {
  const item = (typeof hubCatalogById === 'function')
    ? hubCatalogById('connectors', String(id)) : null;
  if (!item) return { ok: false, level: 'catalog', message: '目录中找不到该连接器' };
  const level = item.link || 'catalog';
  const name = item.name || id;
  // 无配置 / SSE：明确说明无法接入，只保留「目录启用」
  if (level === 'catalog' || level === 'sse' || !item.mcp) {
    const why = level === 'sse'
      ? '该服务只提供 SSE 传输，Harbor 后端目前支持 stdio 与 Streamable HTTP'
      : 'WorkBuddy 未公开该服务的 MCP 配置，Harbor 无法直接连接（仅可作为目录参考）';
    const st = hubConnSet(id, { ok: false, level: level, message: why, tools: 0, servers: [] });
    if (typeof toast === 'function') toast('「' + name + '」' + why, 'warn');
    return st;
  }
  HUB_CONN_BUSY[id] = true;
  if (typeof hubRenderMarket === 'function') hubRenderMarket();
  const cfg = hubConnConfig(item.mcp);
  const servers = Object.keys(cfg);
  try {
    if (typeof callApi !== 'function') throw new Error('当前环境没有后端桥接，无法注册 MCP 服务器');
    // ① 落盘配置（纯本地写 mcp_servers.json，不触发网络连接）
    let existing = [];
    try {
      const listed = hubConnParse(await callApi('mcp_list_servers', []));
      existing = (listed.servers || listed.data && listed.data.servers || [])
        .map(s => String(s && (s.name || s.id) || ''));
    } catch (e) { /* 列表失败不阻断，交给 import/save 自己判重 */ }
    const fresh = {};
    servers.forEach(n => { if (existing.indexOf(n) < 0) fresh[n] = cfg[n]; });
    if (Object.keys(fresh).length) {
      const imp = hubConnParse(await callApi('mcp_import_claude',
        [JSON.stringify({ mcpServers: fresh })]));
      if (imp.error) throw new Error(String(imp.error));
    }
    // ② 逐个启用 + 实测连接；失败由后端回弹 enabled=false，返回人话原因
    let tools = 0;
    let firstError = '';
    for (const n of servers) {
      const payload = Object.assign({}, cfg[n], { enabled: true });
      const r = hubConnParse(await callApi('mcp_save_server',
        [n, JSON.stringify(payload)], 90000));
      if (r.error) {
        if (!firstError) firstError = String(r.error);
      } else {
        tools += Array.isArray(r.tools) ? r.tools.length : 0;
      }
    }
    if (firstError && !tools) {
      const auth = level === 'auth' || /auth|token|key|401|403|unauthor|credential|登录|授权|密钥/i.test(firstError);
      const msg = auth
        ? '配置已写入，需到「设置 → MCP 服务器」填密钥/完成授权后启用（' + firstError + '）'
        : firstError;
      const st = hubConnSet(id, { ok: false, level: auth ? 'auth' : level,
        message: msg, tools: 0, servers: servers });
      if (typeof toast === 'function') toast('「' + name + '」' + msg, 'warn');
      return st;
    }
    const okMsg = tools ? ('已接入，可用 ' + tools + ' 个工具')
      : (firstError ? ('部分接入；' + firstError) : '配置已写入，可在设置中查看');
    const st = hubConnSet(id, { ok: true, level: level, message: okMsg,
      tools: tools, servers: servers });
    if (typeof toast === 'function') toast('「' + name + '」' + okMsg, 'ok');
    return st;
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : String(e);
    const st = hubConnSet(id, { ok: false, level: level, message: msg,
      tools: 0, servers: servers });
    if (typeof toast === 'function') toast('「' + name + '」接入失败：' + msg, 'err');
    return st;
  } finally {
    delete HUB_CONN_BUSY[id];
    if (typeof hubRenderMarket === 'function') hubRenderMarket();
  }
}

/** 停用：清接入状态（不删用户在设置里手填过的 MCP 配置，避免破坏数据）。 */
function hubConnectorForget(id) {
  hubConnClear(id);
}
