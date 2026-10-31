/* ================= 端点抽象（v4 · 完全单端点） =================
 * 全 App 只有一个「当前端点」概念，由 36-connect.js 的预设状态机决定：
 * 「连接与模型」区块的预设下拉是唯一开关（GLM / DeepSeek / Moonshot / 通义千问 /
 * Ollama / LM Studio / vLLM / llama.cpp / LocalAI / 自定义）。
 *
 * 运行态派生（36-connect.js connectSyncState 写入，本模块只读）：
 * - providerState = {enabled, name(预设 id), base_url, model, key, prices} —— 云端与 GLM 共用；
 * - localState = {mode, base_url, model, ctx_window, tool_capable} —— 本地系预设派生，
 *   60-agent-loop 的本地模型分支继续依赖它（localState.model 优先）。
 *
 * GLM 判据（v4 改判）：provider_name === 'glm' 或 base_url 含 bigmodel.cn ——
 * 决定 thinking / reasoning_effort / web_search 工具 / 智能档 / 内置价格表。
 * 语义与合并前一致：GLM 端点全开，非 GLM（云端第三方 / 本地）全部关闭。
 */

/** Base URL 是否指向智谱官方域名（自定义预设填官方地址也按 GLM 对待）。 */
function isGlmBaseUrl(url) {
  return /bigmodel\.cn/i.test(String(url || ''));
}

/** 本地端点是否生效（本地系预设 + 有 base_url；本地端点无需 API Key）。 */
function localModeActive() {
  return !!(localState && localState.mode && localState.base_url);
}

/** 本地 CORS 代理基址（v1.6 HF-P0）：页面加载时经 js_api get_local_proxy 取一次，
 *  缓存于 window.__localProxyBase；空 = 代理不可用（回落直连，行为不劣化）。
 *  存在原因：EdgeWebView（Chromium）对跨源 fetch 强制 CORS——不输出 CORS 头的
 *  本地模型服务器（FreeToken / 裸 llama.cpp / vLLM 默认配置）直连必被拒。 */
function localProxyBase() {
  return (typeof window !== 'undefined' && window.__localProxyBase)
    ? String(window.__localProxyBase) : '';
}

/** chat/completions 拼接（base 已含则原样）。 */
function chatCompletionsOf(base) {
  const b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  return b.endsWith('/chat/completions') ? b : b + '/chat/completions';
}

/** 端点地址解析：45-request-debounce / 97-compact 的 fetch 目标。
 *  本地系预设 → 本地 CORS 代理（CORS 头由后端补齐；真实目标经
 *    localProxyHeaders() 的 X-Harbor-Target 头传递）；代理不可用 → 回落直连；
 *  **所有云端端点 → 也走代理**（2026-10-21 P0，不止 GLM）：EdgeWebView 的
 *    fetch 读系统代理栈（Clash/IE 代理），用户机器挂代理时直连任何云端 API
 *    （GLM/DeepSeek/Moonshot/Qwen/GitHub/自定义）都会被拦成 Failed to fetch，
 *    而浏览器 fetch 无法禁代理；后端 opener 已禁系统代理直连，前端只 fetch
 *    127.0.0.1 必然绕开，且代理补 CORS 头让 4xx 真因不再被吞。代理不可用
 *    → 回落直连（行为不劣化）；都空 → 官方 API_URL。 */
function resolveApiEndpoint() {
  if (localModeActive()) {
    const proxied = chatCompletionsOf(localProxyBase());
    if (proxied) return proxied;                    // 代理模式（HF-P0 主路径）
    const local = chatCompletionsOf(localState.base_url);
    if (local) return local;                        // 回落：代理不可用时直连（行为不劣化）
  }
  const base = chatCompletionsOf((providerState && providerState.base_url) || '');
  // 云端端点且代理可用 → 经代理转发（绕开 EdgeWebView 系统代理栈；后端域名
  // 白名单兜底安全：内置主流 API 域名 + 用户配置的 base_url 动态放行）
  if (base && localProxyBase()) {
    return chatCompletionsOf(localProxyBase());
  }
  if (base) return base;
  return API_URL;
}

/** 代理模式附加请求头：X-Harbor-Target = 真实目标 base_url（本地或云端；
 * 后端代理据此转发，仅放行回环 + 白名单/用户配置目标）。非代理模式 / 无目标
 * 返回 {}——调用处 Object.assign 合并。 */
function localProxyHeaders() {
  if (!localProxyBase()) return {};
  let target = '';
  if (localModeActive()) {
    target = String((localState && localState.base_url) || '').trim();
  } else {
    // 云端：目标 = 用户配置的 base_url（缺省 API_URL 官方地址）
    target = String((providerState && providerState.base_url) || API_URL || '').trim();
  }
  return target ? { 'X-Harbor-Target': target } : {};
}

/** 当前端点是否智谱 GLM（GLM 专属能力总开关）。
 *  判据（v4 D5）：provider_name === 'glm' 或 base_url 含 bigmodel.cn。 */
function isGlmEndpoint() {
  if (localModeActive()) return false;
  const st = providerState || {};
  const name = String(st.name || '').trim().toLowerCase();
  const base = String(st.base_url || '').trim();
  if (name === 'glm') return true;               // 判据一：预设即智谱官方
  if (name) return isGlmBaseUrl(base);           // 判据二：非 GLM 预设，只有填了官方域名才算
  return base ? isGlmBaseUrl(base) : true;       // 无端点信息 → 沿用 GLM 官方默认
}

/** 当前端点显示名（会话里 addSysTip 用）。 */
function currentEndpointName() {
  if (localModeActive()) return '本地 · ' + (localState.model || '?');
  if (isGlmEndpoint()) return 'GLM';
  const id = String((providerState && providerState.name) || '');
  const meta = (typeof connectPresetMeta === 'function') ? connectPresetMeta(id) : null;
  return (meta && meta.name) || id || 'custom';
}

/** 生效的 API Key：本地系免 Key；其余用合并块唯一的 Key 字段（#apiKey，
 *  旧运行态 providerState.key 作为内存回退）。
 *  所有请求入口（发送/重新生成/压缩/断点续跑）统一走此函数，避免端点切了 Key 没切。 */
function effectiveApiKey() {
  if (localModeActive()) return '';
  const el = document.getElementById('apiKey');
  const typed = el ? String(el.value || '').trim() : '';
  if (typed) return typed;
  return (providerState && providerState.key) ? String(providerState.key).trim() : '';
}

/** 价格表：本地系零费（A4）；非 GLM 云端端点用「高级 · 计费三价」；GLM 用内置 MODEL_PRICE。 */
function providerPriceFor(model) {
  if (localModeActive()) {
    return { in: 0, out: 0, cache: 0 };
  }
  if (!isGlmEndpoint() && providerState && providerState.prices) {
    const p = providerState.prices;
    const has = Number(p.in) > 0 || Number(p.out) > 0 || Number(p.cache) > 0;
    if (has) return { in: Number(p.in) || 0, out: Number(p.out) || 0, cache: Number(p.cache) || 0 };
  }
  return MODEL_PRICE[model] || MODEL_PRICE['glm-5.3-flashx'];
}

/** 品牌位 / 会话头标题：显示当前生效模型名（手动态取文本框）。 */
function updateBrandModel() {
  let txt = '';
  if (typeof connectModelValue === 'function') txt = connectModelValue();
  if (!txt) {
    const sel = document.getElementById('modelSelect');
    const v = sel ? String(sel.value || '') : '';
    txt = (v && v !== '__manual__' && v !== '__group__') ? v : '';
  }
  if (!txt) txt = 'glm-5.3-flash';
  const bm = document.getElementById('brandModel');
  const ht = document.getElementById('headerTitle');
  if (bm) bm.textContent = txt;
  if (ht) ht.textContent = txt;
  /* 修复（四轮）：模型切换后刷新头部状态区与空态引导（41-nav 只渲染一次会永久陈旧；
   * 老「设置」入口配 Key 后空态引导不消失也靠这里兜底） */
  if (typeof navRenderHeaderStatus === 'function') navRenderHeaderStatus();
  if (typeof navUpdateEmptyGuide === 'function') navUpdateEmptyGuide();
}
