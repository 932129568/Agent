/* ================= 连接与模型 · 完全单端点状态机（v4 合并块） =================
 * 设计出处：deliverables/design/v4/connect-merge-design.md（D1 完全单端点 / D2 防抖识别 /
 * D3 条件显隐 / D4 价格字段 / D5 存储单源化）。
 *
 * 一个区块、一条纵向流：预设 → Base URL → Key → 模型 → 测试连接（+「高级」折叠）。
 * - 预设下拉是唯一的「端点开关」：GLM 官方 = name='glm' 的预设，不是独立模式；
 * - 存储单一事实源 = provider_*（provider_name/base_url/key/model/prices）；
 *   本地专属项（ctx 覆盖 / 工具调用）继续写 local_*（与 provider 并列，不互斥）；
 * - 识别模型 = 防抖自动（800ms）+ 手动按钮兜底；数据源 = 实时 GET {base}/models
 *   （经后端 local_models，带 Key）→ 失败/为空回落内置热门表 PROVIDER_HOT_MODELS；
 *   永不影响保存与发送（失败只切手动输入态）；
 * - 竞态：last-wins（每次触发递增 connectIdentifySeq，旧请求返回后自动失效）。
 *
 * 契约红线：apiKey / modelSelect / reasoningEffort 三个钉住 id 全部保留在本模块使用的
 * DOM 上；provider_* / local_* id 不在钉住清单内（可重组）；local_models 仍属 _V12_EXTRA。
 */

/* 预设表：kind 由 glm_capable / local / key_required 派生，不另设 kind 字段。
 * models 为预设推荐（进下拉第一屏）；badge 为 ctx 徽标文本（仅本地系展示）。
 * prices 仅云端第三方预设（D4：GLM 走内置价格表，本地零费）。 */
const PRESETS = {
  glm: {
    name: '智谱 GLM', base_url: 'https://open.bigmodel.cn/api/paas/v4',
    key_required: true, glm_capable: true, local: false, prices: null,
    models: [
      { id: 'glm-5.3-flash', text: 'glm-5.3-flash（通用 · 更省钱）' },
      { id: 'glm-5.3-flashx', text: 'glm-5.3-flashx（极速）' },
      { id: 'glm-4.7-flash', text: 'glm-4.7-flash（免费/普惠）' }
    ]
  },
  deepseek: {
    name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1',
    key_required: true, glm_capable: false, local: false,
    // R20 校准（2026-10-21 api-docs.deepseek.com 实测）：价格单位 $/1M tok
    // 高峰口径；flash 非高峰半价（cache hit 0.003/miss 0.15/out 0.6），
    // v4-pro（hit 0.006/miss 0.3/out 1.2）。ctx 1M / max out 384K。
    // 旧名 deepseek-v4.1-*/v4-flash 已退役（由 V4.1-Flash-1017 服务）。
    prices: { in: 0.15, out: 0.6, cache: 0.003 },
    models: [
      { id: 'deepseek-flash', text: 'deepseek-flash（1M 上下文·低价）' },
      { id: 'deepseek-v4-pro', text: 'deepseek-v4-pro（旗舰推理）' }
    ]
  },
  moonshot: {
    name: 'Moonshot', base_url: 'https://api.moonshot.cn/v1',
    key_required: true, glm_capable: false, local: false,
    prices: { in: 12, out: 12, cache: 0 },
    models: [
      { id: 'moonshot-v1-128k', text: 'moonshot-v1-128k（128k 上下文）' },
      { id: 'moonshot-v1-32k', text: 'moonshot-v1-32k（32k 上下文）' }
    ]
  },
  qwen: {
    name: '通义千问', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    key_required: true, glm_capable: false, local: false,
    prices: { in: 4, out: 12, cache: 0 },
    models: [
      { id: 'qwen3-max', text: 'qwen3-max（旗舰）' },
      { id: 'qwen-plus', text: 'qwen-plus（均衡）' },
      { id: 'qwen-turbo', text: 'qwen-turbo（轻量）' }
    ]
  },
  // Nemotron 3 Ultra 550B（LG Ai / legui.xyz 中转）。模型 ID 必须逐字保留
  // 「显卡一哥」前缀；OpenAI Chat Completions 兼容，支持流式、tools 与
  // reasoning_content。Key 只由用户输入保存本机，绝不写入源码。中转价格
  // 未提供，三价默认 0 仅清空旧值，用户需按账单自行修改。
  nemotron: {
    name: 'Nemotron 3 Ultra 550B', base_url: 'https://legui.xyz/v1',
    key_required: true, glm_capable: false, local: false,
    key_hint: 'legui.xyz API Key（仅保存在本机）',
    prices: { in: 0, out: 0, cache: 0 },
    models: [
      { id: '显卡一哥nemotron-3-ultra-550b',
        text: 'Nemotron 3 Ultra 550B（262k · tools · reasoning）',
        badge: '262k', ctx_window: 262144, tool_capable: true }
    ]
  },
  // 实现 v1.6 T1：GitHub Models 免费层接入。端点外部核实（2026-10，方案 §9）：
  // https://models.github.ai/inference（OpenAI 兼容 chat/completions；旧 Azure
  // 推理端点已弃用，不得回流）。模型 ID 为 provider/model 格式（裸名校验
  // 失败）；鉴权走 provider 既有键位（apiKey，不新增 config 键）；价格表置零。
  'github-models': {
    name: 'GitHub Models', base_url: 'https://models.github.ai/inference',
    key_required: true, glm_capable: false, local: false, free_tier: true,
    catalog: true,          // 实现 v1.6 T2：目录探测型端点（models.github.ai/catalog/models）
    key_hint: 'GitHub PAT（需 models:read scope）',
    prices: { in: 0, out: 0, cache: 0 },
    models: [
      { id: 'openai/gpt-4o', text: 'openai/gpt-4o' },
      { id: 'openai/gpt-4o-mini', text: 'openai/gpt-4o-mini' },
      { id: 'deepseek-ai/DeepSeek-R1', text: 'deepseek-ai/DeepSeek-R1' }
    ]
  },
  ollama: {
    name: 'Ollama', base_url: 'http://localhost:11434/v1',
    key_required: false, glm_capable: false, local: true, prices: { in: 0, out: 0, cache: 0 },
    models: [
      { id: 'gpt-oss-20b', text: 'gpt-oss-20b', badge: '32k' },
      { id: 'qwen3.8-27b', text: 'qwen3.8-27b', badge: '128k' },
      { id: 'deepseek-r1-8b', text: 'deepseek-r1-8b', badge: '64k' }
    ]
  },
  lmstudio: {
    name: 'LM Studio', base_url: 'http://localhost:1234/v1',
    key_required: false, glm_capable: false, local: true, prices: { in: 0, out: 0, cache: 0 },
    models: [
      { id: 'qwen3.8-27b', text: 'qwen3.8-27b', badge: '128k' },
      { id: 'gpt-oss-20b', text: 'gpt-oss-20b', badge: '32k' }
    ]
  },
  vllm: {
    name: 'vLLM', base_url: 'http://localhost:8000/v1',
    key_required: false, glm_capable: false, local: true, prices: { in: 0, out: 0, cache: 0 },
    models: [
      { id: 'qwen3.8-27b', text: 'qwen3.8-27b', badge: '128k' },
      { id: 'glm-4.6', text: 'glm-4.6', badge: '64k' }
    ]
  },
  llamacpp: {
    name: 'llama.cpp', base_url: 'http://localhost:8080/v1',
    key_required: false, glm_capable: false, local: true, prices: { in: 0, out: 0, cache: 0 },
    models: [
      { id: 'qwen3.8-27b', text: 'qwen3.8-27b', badge: '128k' },
      { id: 'llama-3.3-70b', text: 'llama-3.3-70b', badge: '128k' }
    ]
  },
  localai: {
    name: 'LocalAI', base_url: 'http://localhost:8080/v1',
    key_required: false, glm_capable: false, local: true, prices: { in: 0, out: 0, cache: 0 },
    models: [
      { id: 'gpt-oss-20b', text: 'gpt-oss-20b', badge: '32k' },
      { id: 'qwen3.8-27b', text: 'qwen3.8-27b', badge: '128k' }
    ]
  },
  // 实现 FreeToken preset：本地模型管理器 FreeToken Desktop（GGUF/llama.cpp 系），
  // API 代理完全 OpenAI 兼容（127.0.0.1:1919/v1，免 Key）；**单模型语义**——一次
  // 只暴露当前启动的引擎，故静态 models 为空，靠「探测模型」动态获取（切换模型
  // 需在 FreeToken Desktop 里操作）。2026-10-20 真机取证：/v1/models +
  // /v1/chat/completions 实测通，usage 计费字段完整。
  freetoken: {
    name: 'FreeToken Desktop', base_url: 'http://127.0.0.1:1919/v1',
    key_required: false, glm_capable: false, local: true, prices: { in: 0, out: 0, cache: 0 },
    key_hint: '免 Key（本地代理）。在 FreeToken Desktop 启动模型后点「探测模型」获取当前模型名；一次只运行一个模型',
    models: []
  },
  custom: {
    name: '自定义', base_url: '',
    key_required: true, glm_capable: false, local: false,
    prices: { in: 2, out: 8, cache: 0.4 },
    models: []
  }
};

/* 内置热门模型表（设计书 §4.2）：实时清单失败/为空时按 Base URL host 匹配兜底。
 * 未命中 → 不猜，直接进手动输入态。 */
const PROVIDER_HOT_MODELS = [
  { host: 'bigmodel.cn', models: [
    { id: 'glm-5.3-flash', text: 'glm-5.3-flash（通用 · 更省钱）' },
    { id: 'glm-5.3-flashx', text: 'glm-5.3-flashx（极速）' },
    { id: 'glm-4.6', text: 'glm-4.6（新一代）' },
    { id: 'glm-4.5-air', text: 'glm-4.5-air（轻量）' },
    { id: 'glm-4.7-flash', text: 'glm-4.7-flash（免费/普惠）' }
  ] },
  { host: 'deepseek.com', models: [
    { id: 'deepseek-flash', text: 'deepseek-flash（1M 上下文·低价）' },
    { id: 'deepseek-v4-pro', text: 'deepseek-v4-pro（旗舰推理）' }
  ] },
  { host: 'moonshot.cn', models: [
    { id: 'kimi-k2', text: 'kimi-k2' },
    { id: 'moonshot-v1-128k', text: 'moonshot-v1-128k（128k 上下文）' }
  ] },
  { host: 'dashscope.aliyuncs.com', models: [
    { id: 'qwen-max', text: 'qwen-max（旗舰）' },
    { id: 'qwen-plus', text: 'qwen-plus（均衡）' },
    { id: 'qwen-turbo', text: 'qwen-turbo（轻量）' }
  ] },
  { host: 'legui.xyz', models: [
    { id: '显卡一哥nemotron-3-ultra-550b',
      text: 'Nemotron 3 Ultra 550B（262k · tools · reasoning）',
      badge: '262k', ctx_window: 262144, tool_capable: true }
  ] },
  // 实现 v1.6 T1：GitHub Models 目录兜底表（实时清单失败时按 host 命中）
  { host: 'models.github.ai', models: [
    { id: 'openai/gpt-4o', text: 'openai/gpt-4o' },
    { id: 'openai/gpt-4o-mini', text: 'openai/gpt-4o-mini' },
    { id: 'deepseek-ai/DeepSeek-R1', text: 'deepseek-ai/DeepSeek-R1' }
  ] },
  { host: 'localhost', models: [
    { id: 'gpt-oss-20b', text: 'gpt-oss-20b', badge: '32k' },
    { id: 'qwen3.8-27b', text: 'qwen3.8-27b', badge: '128k' },
    { id: 'llama3.1:8b', text: 'llama3.1:8b', badge: '8k' }
  ] },
  { host: '127.0.0.1', models: [
    { id: 'gpt-oss-20b', text: 'gpt-oss-20b', badge: '32k' },
    { id: 'qwen3.8-27b', text: 'qwen3.8-27b', badge: '128k' },
    { id: 'llama3.1:8b', text: 'llama3.1:8b', badge: '8k' }
  ] }
];

const CONNECT_PRESET_ORDER = ['glm', 'deepseek', 'moonshot', 'qwen', 'nemotron',
  'github-models', 'ollama', 'lmstudio', 'vllm', 'llamacpp', 'localai', 'freetoken', 'custom'];
const CONNECT_LOCAL_IDS = ['ollama', 'lmstudio', 'vllm', 'llamacpp', 'localai', 'freetoken'];
const CONNECT_DEBOUNCE_MS = 800;      // D2：Base URL / Key 变化后的自动识别防抖
const CONNECT_AUTO_IDENTIFY = true;   // 风险对冲（设计书 §10）：自动识别开关位，默认开
const CONNECT_MANUAL_VALUE = '__manual__';
const CONNECT_GROUP_VALUE = '__group__';

let connectPreset = 'glm';        // 当前预设 id（= provider_name）
let connectIdentifySeq = 0;       // last-wins 竞态序号（每次触发递增，旧请求失效）
let connectIdentifyTimer = null;  // 防抖定时器
// 修复 53（三轮）：删除死变量 connectManualPrefill（原声明后从未被赋值，
// 仅 connectEnterManual 读一次常量 ''，等价于直接取 prefill）
/* 预设 id → 用户最后一次手改并「切走」时确认的 Base URL。
 * 用途（QA 修正 2）：切走再切回同一预设不丢手填值（custom 默认 '' 时尤其重要，
 * 否则「自定义」来回切一次 URL 就被清空 = 用户数据丢失）。
 * 只记与预设默认值不同的值，避免把默认值也塞进记忆。会话级（不落盘）。 */
const PRESET_BASE_MEMO = {};

/* ================= 预设元信息 ================= */

/** 取预设元信息（未知 id → custom，永不返回 undefined）。 */
function connectPresetMeta(id) {
  return PRESETS[id] || PRESETS.custom;
}

/** 当前预设 id（未初始化时回落 glm）。 */
function connectCurrentPreset() {
  return PRESETS[connectPreset] ? connectPreset : 'glm';
}

/** 预设 id 列表（下拉顺序 = 设计书 §3 的 10 项）。 */
function connectPresetIds() {
  return CONNECT_PRESET_ORDER.slice();
}

/** 是否本地系预设（免 Key / 零费 / 探测本机）。 */
function connectIsLocalPreset(id) {
  const key = id || connectCurrentPreset();
  return !!connectPresetMeta(key).local;
}

/** 是否具备 GLM 专属能力（智能档 / 推理力度 / 思考 / 联网 / 内置价格表）。 */
function connectGlmCapable(id) {
  const key = id || connectCurrentPreset();
  return !!connectPresetMeta(key).glm_capable;
}

/** 预设默认模型清单（浅拷贝，防调用方改动表）。 */
function connectPresetModels(id) {
  const list = connectPresetMeta(id).models || [];
  return list.map(m => ({ id: m.id, text: m.text || m.id, badge: m.badge || '' }));
}

/* ================= URL / host 工具 ================= */

/** 取 URL 的 host（无协议头时整段视为 host；空 URL → ''）。 */
function connectHostOf(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^\/?#]+)/i.exec(s);
  return (m ? m[1] : s).toLowerCase();
}

/** 反向匹配预设：URL host 与预设默认地址 host 相同 → 该预设 id；否则 ''。 */
function connectPresetByUrl(url) {
  const host = connectHostOf(url);
  if (!host) return '';
  const ids = CONNECT_PRESET_ORDER;
  for (let i = 0; i < ids.length; i++) {
    const p = PRESETS[ids[i]];
    if (!p || !p.base_url) continue;
    if (connectHostOf(p.base_url) === host) return ids[i];
  }
  return '';
}

/** 反向匹配本地系预设：优先 local 家族的已知端口（11434/1234/8000/8080）。 */
function connectPresetByLocalUrl(url) {
  const host = connectHostOf(url);
  if (!host) return '';
  const portMatch = /:(\d{2,5})/.exec(String(url || ''));
  const port = portMatch ? portMatch[1] : '';
  const order = CONNECT_LOCAL_IDS;
  for (let i = 0; i < order.length; i++) {
    const p = PRESETS[order[i]];
    if (port && p.base_url.indexOf(':' + port) !== -1) return order[i];
  }
  return connectPresetByUrl(url);
}

/** 内置热门模型（host 关键词匹配，设计书 §4.2）；未命中 → []。 */
function connectHotModels(url) {
  const host = connectHostOf(url);
  if (!host) return [];
  for (let i = 0; i < PROVIDER_HOT_MODELS.length; i++) {
    const row = PROVIDER_HOT_MODELS[i];
    if (host.indexOf(row.host) !== -1) {
      return row.models.map(m => ({ id: m.id, text: m.text || m.id, badge: m.badge || '' }));
    }
  }
  return [];
}

/** ctx 徽标文本（'32k' / '200k'）；无窗口信息 → ''。 */
function connectCtxBadge(meta) {
  const ctx = parseInt((meta || {}).ctx_window, 10) || 0;
  if (ctx <= 0) return '';
  // 修复 ㊾（三轮）：改走统一 formatCtx()（80-utils 定义；typeof 守卫保 vm 单模块
  // 沙箱只加载本文件时可测，兜底与 formatCtx 同口径）
  return (typeof formatCtx === 'function') ? formatCtx(ctx)
    : (ctx >= 1024 ? Math.round(ctx / 1024) + 'k' : String(ctx));
}

/* ================= DOM 取值 ================= */

/** Base URL 输入值（去空白）。 */
function connectBaseUrl() {
  const el = document.getElementById('providerBase');
  return el ? String(el.value || '').trim() : '';
}

/** Key 输入值（合并后唯一的 Key 字段，id/apiKey 为钉住契约）。 */
function connectApiKeyInput() {
  const el = document.getElementById('apiKey');
  return el ? String(el.value || '').trim() : '';
}

/** 当前生效模型名（手动态取文本框；占位/分组项 → ''）。 */
function connectModelValue() {
  const pick = document.getElementById('cmPick');
  const manual = !!(pick && pick.classList && pick.classList.contains('manual'));
  if (manual) {
    const inp = document.getElementById('cmManualInput');
    return inp ? String(inp.value || '').trim() : '';
  }
  const sel = document.getElementById('modelSelect');
  const v = sel ? String(sel.value || '').trim() : '';
  if (!v || v === CONNECT_MANUAL_VALUE || v === CONNECT_GROUP_VALUE) return '';
  return v;
}

/** 计费三价（输入/输出/缓存，¥/M tokens）。 */
function connectPrices() {
  const num = id => {
    const el = document.getElementById(id);
    return el ? (parseFloat(el.value) || 0) : 0;
  };
  return { in: num('providerPriceIn'), out: num('providerPriceOut'), cache: num('providerPriceCache') };
}

/** 工具调用偏好（local_* 语义：auto/on/off）。 */
function connectToolCapable() {
  const el = document.getElementById('localToolCapable');
  return (el && el.value) || 'auto';
}

/** 上下文窗口覆盖（0 = 按模型元数据自动）。 */
function connectCtxWindow() {
  const el = document.getElementById('localCtxWindow');
  return el ? (parseInt(el.value, 10) || 0) : 0;
}

/* ================= 运行态派生（单一事实源 → providerState / localState）================= */

/** 把 UI 的预设 + 字段派生为全 App 运行态。
 *  60-agent-loop 的本地分支依赖 localState.model，故本地系预设必须同步派生
 *  localState.mode/base_url/model（local_* 键仍只写 ctx/tool）。 */
function connectSyncState() {
  const meta = connectPresetMeta(connectCurrentPreset());
  const base = connectBaseUrl();
  const model = connectModelValue();
  providerState = {
    enabled: !meta.glm_capable,          // 兼容 v1.2 语义：非 GLM 端点即「自定义端点」
    name: connectCurrentPreset(),
    base_url: base || meta.base_url || '',
    model: model,
    key: connectApiKeyInput(),
    prices: connectPrices()
  };
  localState = {
    mode: !!meta.local && !!base,
    base_url: meta.local ? base : '',
    model: meta.local ? model : '',
    ctx_window: connectCtxWindow(),
    tool_capable: connectToolCapable()
  };
  if (typeof applyLocalMetaBadge === 'function') applyLocalMetaBadge();
}

/* ================= 模型下拉（下拉 ⇄ 手动输入 双态）================= */

/** 按钮 loading 态（spinner + 文案，dataset 暂存原文案）。
 * 修复（round4 遗留·对抗复审）：识别按钮（#cmIdentifyBtn）的文案随预设而变
 * （connectIdentifyLabel：获取模型/探测本机/探测目录/识别模型）——加载期间用户
 * 切预设时 connectApplyPresetNow 已把 innerHTML 改成新预设文案，但 dataset.html
 * 快照仍是旧预设的；原 off 分支盲目还原 dataset.html → 按钮显示陈旧预设文案
 * （如 ollama 预设下显示「↻ 获取模型」）。改为按当前预设重刷（其余按钮文案
 * 静态，dataset.html 还原仍正确）。 */
function connectSetButtonLoading(btn, on, text) {
  if (!btn) return;
  if (on) {
    if (!btn.dataset.html) btn.dataset.html = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="tool-spinner"></span><span>' + (text || '处理中') + '</span>';
  } else {
    if (btn.id === 'cmIdentifyBtn' && typeof connectIdentifyLabel === 'function') {
      btn.innerHTML = connectIdentifyLabel(connectCurrentPreset());
    } else {
      btn.innerHTML = btn.dataset.html || btn.innerHTML;
    }
    delete btn.dataset.html;
    btn.disabled = false;
  }
}

/** 刷新模型下拉：可选「智能档」首项 + 分组标题 + 模型项（可带 ctx 徽标）+
 *  末项固定「✎ 手动输入模型名…」。
 *  opts: {auto:boolean, group:string, keep:string} */
function connectFillModels(list, opts) {
  opts = opts || {};
  const sel = document.getElementById('modelSelect');
  if (!sel) return;
  const rawKeep = String(opts.keep || '').trim();
  /* 'auto'（智能档）只在本预设提供智能档首项时才可作为回填值 */
  const keep = (rawKeep === 'auto' && !opts.auto) ? '' : rawKeep;
  const items = (list || []).map(m => ({ id: String(m.id), text: m.text || String(m.id),
                                         badge: m.badge || '' }));
  sel.innerHTML = '';
  if (opts.auto) {
    const a = document.createElement('option');
    a.value = 'auto';
    a.textContent = '智能档（按任务自动调节，最省）';
    sel.appendChild(a);
  }
  const ids = items.map(m => m.id);
  if (keep && keep !== 'auto' && ids.indexOf(keep) === -1) {
    items.push({ id: keep, text: keep, badge: '' });      // 配置里的模型名不在预设表 → 补一项保住回填
    ids.push(keep);
  }
  if (items.length) {
    if (opts.group) {
      const g = document.createElement('option');
      g.value = CONNECT_GROUP_VALUE;
      g.disabled = true;
      g.dataset.group = opts.group;
      g.textContent = opts.group;
      sel.appendChild(g);
    }
    items.forEach(it => {
      const o = document.createElement('option');
      o.value = it.id;
      o.textContent = it.text;
      if (it.badge) o.dataset.badge = it.badge;
      sel.appendChild(o);
    });
  } else if (!opts.auto) {
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '尚未识别 — 填写 Base URL 与 Key 后自动识别';
    sel.appendChild(ph);
  }
  const mm = document.createElement('option');
  mm.value = CONNECT_MANUAL_VALUE;
  mm.textContent = '✎ 手动输入模型名…';
  sel.appendChild(mm);
  if (keep && (ids.indexOf(keep) !== -1 || keep === 'auto')) sel.value = keep;
  else if (opts.auto) sel.value = 'auto';
  else if (ids.length) sel.value = ids[0];
  else sel.value = '';
  connectSetPickManual(sel.value === CONNECT_MANUAL_VALUE);
  connectSyncAfterModelFill(sel);
}

/** 下拉内容重构后同步：自定义下拉组件刷新 + 品牌位 + 运行态。 */
function connectSyncAfterModelFill(sel) {
  try {
    if (typeof CS !== 'undefined' && CS && typeof CS.sync === 'function' && sel) CS.sync(sel);
  } catch (e) { /* 下拉组件不可用时直接用原生 select */ }
  if (typeof updateBrandModel === 'function') updateBrandModel();
  connectSyncState();
}

/** 手动态切换（.cm-pick.manual 显隐由 CSS 决定）。 */
function connectSetPickManual(on) {
  const pick = document.getElementById('cmPick');
  if (!pick || !pick.classList) return;
  pick.classList.toggle('manual', !!on);
}

/** 进入手动输入态（识别失败兜底 / 用户选「✎ 手动输入模型名…」）。 */
function connectEnterManual(prefill) {
  const sel = document.getElementById('modelSelect');
  if (sel) sel.value = CONNECT_MANUAL_VALUE;
  connectSetPickManual(true);
  const inp = document.getElementById('cmManualInput');
  const val = String(prefill || '').trim();   // 修复 53（三轮）：随死变量 connectManualPrefill 一并简化
  if (inp) {
    if (val) inp.value = val;
    try { inp.focus(); } catch (e) { /* 无焦点能力的环境忽略 */ }
  }
  connectSyncAfterModelFill(sel);
}

/** 退出手动输入态：下拉复位到首个实义项。 */
function connectExitManual() {
  const sel = document.getElementById('modelSelect');
  if (sel) {
    const opts = sel.children || [];
    let picked = '';
    for (let i = 0; i < opts.length; i++) {
      const v = String(opts[i].value || '');
      if (v && v !== CONNECT_MANUAL_VALUE && v !== CONNECT_GROUP_VALUE) { picked = v; break; }
    }
    sel.value = picked;
  }
  connectSetPickManual(false);
  connectSyncAfterModelFill(sel);
}

/** 下拉 change：选手动项 → 进手动态；选实义项 → 退手动态。 */
function connectOnModelChange() {
  const sel = document.getElementById('modelSelect');
  const v = sel ? String(sel.value || '') : '';
  connectSetPickManual(v === CONNECT_MANUAL_VALUE);
  if (typeof updateBrandModel === 'function') updateBrandModel();
  connectSyncState();
}

/* ================= 预设切换 ================= */

/** 高级折叠三条条件显隐（设计书 §5 矩阵）。 */
function connectUpdateAdvanced() {
  const meta = connectPresetMeta(connectCurrentPreset());
  // 修复 W34（三轮）：GLM 判据双轨制——发送层 isGlmEndpoint() 认「name==='glm'
  // 或 base_url 含 bigmodel.cn」，UI 显隐原只认 meta.glm_capable（仅 glm 预设）。
  // 用户填官方域名的自定义预设：发送层走 GLM 语义（thinking/智能档/内置价表），
  // UI 却按非 GLM 显隐 → 用户填的三价实际不生效。显隐加同口径判据
  // （isGlmBaseUrl 在 71-provider 定义，同脚本作用域；typeof 守卫保模块沙箱可测）
  const _pid = connectCurrentPreset();
  const _glmUi = !!meta.glm_capable
    || (_pid === 'custom' && typeof isGlmBaseUrl === 'function' && isGlmBaseUrl(connectBaseUrl()));
  const showReasoning = _glmUi;
  const showBilling = !_glmUi && !meta.local;
  const showLocal = !!meta.local;
  const show = (id, on) => {
    const el = document.getElementById(id);
    if (el && el.style) el.style.display = on ? '' : 'none';
  };
  show('advReasoning', showReasoning);
  show('advReasoningOff', !showReasoning);
  show('advBilling', showBilling);
  show('advBillingOff', !showBilling);
  show('advLocal', showLocal);
  show('advLocalOff', !showLocal);
}

/** 识别 / 探测按钮文案（本地系 = 探测本机；GLM = 获取模型；目录型 = 探测目录）。 */
function connectIdentifyLabel(id) {
  const meta = connectPresetMeta(id || connectCurrentPreset());
  if (meta.local) return '↻ 探测本机';
  if (meta.glm_capable) return '↻ 获取模型';
  if (meta.catalog) return '↻ 探测目录';   // 实现 v1.6 T2：GitHub Models 目录探测
  return '↻ 识别模型';
}

/** 同步应用预设（唯一的「端点开关」入口；无动画路径，配置回填可直接调用）。
 *  opts: {base, key, models, keepModel, prices, quiet} */
function connectApplyPresetNow(key, opts) {
  opts = opts || {};
  const presetId = PRESETS[key] ? key : 'custom';
  const meta = PRESETS[presetId];
  const prevId = connectCurrentPreset();          // 切出前的预设（切出即记忆手改值）
  const baseEl = document.getElementById('providerBase');
  const prevBase = baseEl ? String(baseEl.value || '').trim() : '';
  if (prevId && prevId !== presetId && prevBase &&
      prevBase !== String((PRESETS[prevId] || {}).base_url || '')) {
    PRESET_BASE_MEMO[prevId] = prevBase;
  }
  connectPreset = presetId;          // 预设状态机唯一入口：同步写入当前预设
  const psel = document.getElementById('providerPreset');
  if (psel) psel.value = presetId;
  try {
    if (typeof CS !== 'undefined' && CS && typeof CS.sync === 'function' && psel) CS.sync(psel);
  } catch (e) { /* 原生 select 兜底 */ }
  if (baseEl) {
    /* 取值优先级：配置回填显式值 > 本预设记忆的手改值 > 预设默认值
       （custom 默认 ''；记忆命中即恢复用户上次填的 URL，不再被清空） */
    if (opts.base !== undefined) baseEl.value = opts.base;
    else if (PRESET_BASE_MEMO[presetId]) baseEl.value = PRESET_BASE_MEMO[presetId];
    else baseEl.value = meta.base_url || '';
    baseEl.placeholder = meta.base_url || 'https://api.example.com/v1';
  }
  const keyEl = document.getElementById('apiKey');
  if (keyEl) {
    if (opts.key !== undefined) keyEl.value = opts.key;
    // 实现 v1.6 T1：GitHub Models 的 Key 文案明示 PAT 与 scope（预设 key_hint 优先）
    keyEl.placeholder = meta.key_hint
      || (meta.glm_capable ? '粘贴你的智谱 API Key'
      : meta.local ? '本地服务器通常无需 Key'
      : '该服务商的 API Key（仅保存在本机）');
  }
  // 实现 v1.6 T1：Key 标签文案 / PAT 获取指引 / 免费层常驻声明按预设显隐
  // （新 id 全部唯一，UI 契约只增不改）
  const keyLabel = document.getElementById('cmKeyLabel');
  if (keyLabel) keyLabel.textContent = meta.key_hint || 'API Key（仅保存在本机）';
  const keyHelp = document.getElementById('cmKeyHelp');
  if (keyHelp && keyHelp.style) keyHelp.style.display = meta.free_tier ? '' : 'none';
  const freeTier = document.getElementById('cmFreeTier');
  if (freeTier && freeTier.style) freeTier.style.display = meta.free_tier ? '' : 'none';
  const keyRow = document.getElementById('cmKeyRow');
  if (keyRow && keyRow.style) keyRow.style.display = meta.key_required ? '' : 'none';
  const noKey = document.getElementById('cmNoKey');
  if (noKey && noKey.style) noKey.style.display = meta.key_required ? 'none' : '';
  const idBtn = document.getElementById('cmIdentifyBtn');
  if (idBtn) idBtn.innerHTML = connectIdentifyLabel(presetId);
  const prices = opts.prices || meta.prices;
  if (prices) {
    const setNum = (fid, v) => { const el = document.getElementById(fid); if (el) el.value = v; };
    setNum('providerPriceIn', Number(prices.in) || 0);
    setNum('providerPriceOut', Number(prices.out) || 0);
    setNum('providerPriceCache', Number(prices.cache) || 0);
  }
  const list = opts.models || connectPresetModels(presetId);
  connectFillModels(list, { auto: !!meta.glm_capable,
                            group: list.length ? '预设推荐' : '',
                            keep: opts.keepModel || '' });
  const box = document.getElementById('localProbeResult');
  if (box) { box.innerHTML = ''; }
  const st = document.getElementById('providerTestStatus');
  if (st) { st.textContent = ''; st.className = 'cm-status'; st.style.color = ''; }
  connectUpdateAdvanced();
  connectSyncState();
  if (typeof updateBrandModel === 'function') updateBrandModel();
  if (!opts.quiet && typeof queueSaveConfig === 'function') queueSaveConfig();
}

/** 应用预设（带内容区 200ms 交叉淡入的异步包装；模板/用户切换走这里）。
 *  opts: {animate, base, key, models, keepModel, prices, quiet} */
async function connectApplyPreset(id, opts) {
  opts = opts || {};
  const presetId = PRESETS[id] ? id : 'custom';
  clearTimeout(connectIdentifyTimer);
  if (typeof connectIdentifySeq === 'number') connectIdentifySeq++;   // 修复 S9（三轮）：切预设使在途识别请求失效（旧端点清单不污染新预设下拉）
  if (opts.animate && typeof MOTION !== 'undefined' && !MOTION.instant()) {
    const flow = document.getElementById('cmFlow');
    if (flow && flow.classList) flow.classList.add('swapping');
    await MOTION.sleep(MOTION.compOut());
    connectApplyPresetNow(presetId, opts);
    if (flow && flow.classList) flow.classList.remove('swapping');
  } else {
    connectApplyPresetNow(presetId, opts);
  }
}

/** 旧签名兼容（模板 onchange / 旧调用点）：切预设并保存。 */
function onProviderPresetChange(v) {
  connectApplyPreset(v, { animate: true });
}

/* ================= 识别模型（防抖 800ms 自动 + 手动按钮兜底）================= */

/** 字段变化后的防抖自动识别（云端需 URL + Key；本地系只需 URL；GLM 不自动枚举）。 */
function connectScheduleIdentify() {
  if (!CONNECT_AUTO_IDENTIFY) return;
  clearTimeout(connectIdentifyTimer);
  connectIdentifyTimer = setTimeout(() => {
    const meta = connectPresetMeta(connectCurrentPreset());
    if (meta.glm_capable) return;                 // GLM：手动「获取模型」才拉清单
    const base = connectBaseUrl();
    if (!base) return;
    if (!meta.local && !connectApiKeyInput()) return;
    connectIdentifyNow(false);
  }, CONNECT_DEBOUNCE_MS);
}

/** 识别 / 探测入口（按钮手动点击 fromClick=true）。
 *  last-wins：每次调用递增 connectIdentifySeq，旧请求返回后自行失效；
 *  失败 → 人话 toast + 切手动输入态，永不阻塞保存与发送。 */
async function connectIdentifyNow(fromClick) {
  const meta = connectPresetMeta(connectCurrentPreset());
  const base = connectBaseUrl();
  if (!base) {
    if (fromClick) {
      toast('请先填写 Base URL，再识别模型', 'err');
      connectEnterManual();
    }
    return;
  }
  const seq = ++connectIdentifySeq;
  if (meta.local) {
    /* 本地系：复用 v1.5 并行端口探测（local_probe），命中后自动带出清单 */
    if (typeof localProbeNow === 'function') {
      await localProbeNow();
    } else if (fromClick) {
      toast('本地探测不可用（模块未加载）', 'err');
    }
    return;
  }
  const key = connectApiKeyInput();
  // 修复（四轮）：前置门统一按 key_required 判据——原只认 glm_capable，DeepSeek/
  // Moonshot/Qwen/GitHub Models/自定义端点空 Key 会直发真实请求 401 才报错
  if (!key && meta.key_required && fromClick) {
    toast('请先填写 API Key，再获取模型清单', 'warn');
    connectEnterManual();
    return;
  }
  const btn = document.getElementById('cmIdentifyBtn');
  connectSetButtonLoading(btn, true, meta.glm_capable ? '获取中' : '识别中');
  let models = [];
  let reason = '';
  try {
    const raw = await callApi('local_models', [base, key]);
    if (seq !== connectIdentifySeq) { return; }   // last-wins：旧请求失效（按钮归最新请求，禁提前复位）
    const r = JSON.parse(raw || '{}');
    if (r && r.ok && Array.isArray(r.models) && r.models.length) {
      // 实现 v1.6 T2：目录模型带 modalities 时进选项文案（GitHub catalog 富元数据；
      // 其他端点无该字段 → 文案不变，零行为差异）
      models = r.models.map(m => ({
        id: String(m.id || ''),
        text: String(m.id || '') + (Array.isArray(m.modalities) && m.modalities.length
          ? '（' + m.modalities.join('/') + '）' : ''),
        badge: connectCtxBadge(m)
      })).filter(m => m.id);
    } else {
      reason = (r && r.error) || '端点未返回模型清单';
    }
  } catch (e) {
    reason = (e && e.message) ? e.message : String(e);
  }
  // 复核修正：复位前先判 last-wins——原旧返回把在途新请求的「识别中」
  // 禁用态提前解锁，放行并发第三轮请求
  if (seq !== connectIdentifySeq) return;
  connectSetButtonLoading(btn, false);
  let hot = false;
  if (!models.length) {
    models = connectHotModels(base);                // 内置热门表兜底（设计书 §4.2）
    hot = models.length > 0;
  }
  if (models.length) {
    connectFillModels(models, { auto: !!meta.glm_capable,
                                group: hot ? '内置热门模型' : '识别结果' });
    if (hot && reason) {
      // 实现 v1.6 T2：识别失败但热门表兜底 → 失败原因人话透传（不阻塞面板），
      // 兜底加载提示照旧（旧行为只 toast「已加载 N 个模型」，401 等原因被吞）
      const failMsg = (meta.glm_capable ? '获取模型失败：' : '识别失败：') + reason;
      toast(failMsg + '（已用内置热门模型兜底，可手动输入模型名）', 'warn',
            { detail: 'GET ' + base + '/models\n' + (reason || '空响应') });
    }
    toast((hot ? '已加载 ' : '已识别 ') + models.length + ' 个模型', 'ok');
    return;
  }
  const msg = (meta.glm_capable ? '获取模型失败：' : '识别失败：') + (reason || '端点未返回模型清单');
  if (fromClick) {
    /* 手动点击失败 → 直接落到手动输入态（兜底路径，永不阻塞保存与发送） */
    toast(msg + '，已切换为手动输入', 'err', { detail: 'GET ' + base + '/models\n' + (reason || '空响应') });
    connectEnterManual();
  } else {
    /* 自动识别失败 → 只提示不打断（用户可能还在补 Key，不抢走已选模型） */
    toast(msg + '（可点「识别模型」或手动输入模型名）', 'warn');
  }
}

/** 取消进行中的识别（切预设 / 弃用时调用）：序号递增使旧请求全部失效。 */
function connectCancelIdentify() {
  clearTimeout(connectIdentifyTimer);
  connectIdentifySeq++;
}

/* ================= 测试连接（云端 Key / 本地免 Key 统一入口）================= */

async function connectTestNow() {
  const btn = document.getElementById('providerTestBtn');
  const st = document.getElementById('providerTestStatus');
  if (btn && btn.disabled) return;
  const meta = connectPresetMeta(connectCurrentPreset());
  const base = connectBaseUrl();
  const key = connectApiKeyInput();
  const model = connectModelValue();
  const done = (ok, msg) => {
    if (st) {
      st.textContent = (ok ? '✓ ' : '✗ ') + msg;
      st.className = 'cm-status ' + (ok ? 'ok' : 'err');
      st.style.color = ok ? 'var(--ok)' : 'var(--err)';
    }
    toast((ok ? '连接成功：' : '连接失败：') + msg, ok ? 'ok' : 'err', { stay: !ok });
  };
  connectSetButtonLoading(btn, true, '测试中');
  if (st) { st.textContent = '正在测试连接…'; st.className = 'cm-status'; st.style.color = ''; }
  try {
    if (!base) { done(false, '请先填写 Base URL'); return; }
    if (!/^https?:\/\//i.test(base)) { done(false, 'Base URL 需以 http:// 或 https:// 开头'); return; }
    if (meta.key_required && !key) { done(false, '请先填写 API Key'); return; }   // 修复（四轮）：统一 key_required 判据
    if (!model) { done(false, '请先选择或手动输入模型名'); return; }
    const local = !!meta.local;
    const raw = await callApi('test_provider_endpoint',
      [base, local ? '' : key, model, local ? 30 : 15, local], local ? 90000 : 20000);
    const r = JSON.parse(raw || '{}');
    if (r && r.ok && r.state === 'loading') done(true, r.message || '模型加载中');
    else if (r && r.ok) done(true, (r.reply ? '回复：' + r.reply : '端点可达' + (local ? ' · 本地 · 0 费用' : '')));
    else {
      // 修复（2026-10-21 P0）：1211 等模型不可用时后端顺带拉了可用清单
      // （available_models）——展示出来，用户点一次就知道能换什么
      let msg = (r && r.error) || '端点不可达';
      if (r && Array.isArray(r.available_models) && r.available_models.length) {
        msg += '\n可用模型（' + r.available_models.length + '）：'
          + r.available_models.slice(0, 8).join('、')
          + (r.available_models.length > 8 ? ' 等' : '');
      }
      done(false, msg);
      if (r && Array.isArray(r.available_models) && r.available_models.length) {
        // 一键填入第一个可用模型（用户可改）——降低「知道能换什么但懒得找」的摩擦
        const inp = document.getElementById('cmManualInput');
        if (inp && !inp.value) inp.value = r.available_models[0];
      }
    }
  } catch (e) {
    done(false, (e && e.message) || '请求失败');
  } finally {
    connectSetButtonLoading(btn, false);
  }
}

/** 旧签名兼容（v1.2 服务商测试通道）：统一走合并块的测试连接。 */
async function testProviderNow() {
  return connectTestNow();
}

/* ================= 配置读写（单一事实源 provider_*）================= */

/** 采集 provider_* 键组（provider_name = 预设 id）。 */
function connectCollectConfig() {
  return {
    provider_name: connectCurrentPreset(),
    provider_base_url: connectBaseUrl(),
    provider_key: connectApiKeyInput(),
    provider_model: connectModelValue(),
    provider_prices: connectPrices()
  };
}

/** 从 config.json 回填合并块（含 v1.5 本地 config 与 v1.2 仅有 api_key 的旧配置迁移）。
 *  seed 一次性且严格幂等：迁移落盘后 config 自带「本地系预设 + provider_base_url」，
 *  再次 boot 时 alreadyLocal=true → 不再进入迁移分支、不再落盘（QA 修正 1）。 */
function connectLoadFromConfig(cfg) {
  cfg = cfg || {};
  const legacyKey = String(cfg.api_key || '').trim();
  const legacyModel = String(cfg.model || '').trim();
  const legacyLocalBase = String(cfg.local_base_url || '').trim();
  let presetId = String(cfg.provider_name || '').trim().toLowerCase();
  let base = String(cfg.provider_base_url || '').trim();
  let key = String(cfg.provider_key || '').trim();
  let model = String(cfg.provider_model || '').trim();
  let needSeed = false;
  /* 已迁移的本地配置：provider_name 已是本地系预设且 provider_base_url 非空
     （collectLocalConfig 会持续写 local_mode/local_base_url，不能据此重判迁移） */
  const alreadyLocal = !!(PRESETS[presetId] && PRESETS[presetId].local) && !!base;
  if (cfg.local_mode && legacyLocalBase && !alreadyLocal) {
    /* v1.5 老配置：本地模式生效（旧运行期本地优先于服务商）→ 一次性迁移为本地系预设 */
    const localId = String(cfg.local_preset || '').trim().toLowerCase();
    presetId = (PRESETS[localId] && PRESETS[localId].local) ? localId
      : (connectPresetByLocalUrl(legacyLocalBase) || 'custom');
    base = legacyLocalBase;
    /* 本地系迁移：模型名以 local_model 优先——双开老配置（provider_model 是云端名）迁到
       本地预设后若保留云端名，请求会打到 localhost 却带云端模型名（等同 404 model not found）。
       无 local_model 时才回落到原 provider_model/model。 */
    model = String(cfg.local_model || '').trim() || model;
    needSeed = true;
  } else if (!base && !presetId && (legacyKey || legacyModel)) {
    /* v1.2/更早：只有 api_key（完全没有端点信息）→ 一次性 seed 为 GLM 预设。
       修复 W37（三轮）：原条件 `(legacyKey || legacyModel || !presetId)` 把
       「provider_name 有效但 base 为空」的配置也强并为 GLM 并落盘——用户选过
       预设的配置被静默改写。现只有无预设名才 seed GLM；有预设名走下方预设默认 base。 */
    presetId = 'glm';
    base = PRESETS.glm.base_url;
    key = key || legacyKey;
    model = model || legacyModel;
    needSeed = !!legacyKey;
  }
  if (!PRESETS[presetId]) presetId = connectPresetByUrl(base) || 'custom';
  if (!base) base = PRESETS[presetId].base_url;
  if (!key) key = legacyKey;
  if (!model) model = legacyModel;
  const cfgPrices = cfg.provider_prices || null;
  const prices = (cfgPrices && (cfgPrices.in != null || cfgPrices.out != null || cfgPrices.cache != null))
    ? { in: Number(cfgPrices.in) || 0, out: Number(cfgPrices.out) || 0, cache: Number(cfgPrices.cache) || 0 }
    : null;
  /* 非同步应用（boot 阶段无动画；connectApplyPresetNow 为纯同步 DOM 更新，
     内部同步写入 connectPreset，故此处直接传 presetId） */
  clearTimeout(connectIdentifyTimer);
  connectApplyPresetNow(presetId, {
    base: base, key: key, keepModel: model,
    prices: prices || undefined, quiet: !needSeed
  });
  const ctxEl = document.getElementById('localCtxWindow');
  if (ctxEl) ctxEl.value = parseInt(cfg.local_ctx_window, 10) || 0;
  const toolEl = document.getElementById('localToolCapable');
  if (toolEl) toolEl.value = cfg.local_tool_capable || 'auto';
  connectUpdateAdvanced();
  connectSyncState();
  if (typeof applyLocalMetaBadge === 'function') applyLocalMetaBadge();
  /* 迁移落盘由 connectApplyPresetNow 的 !quiet 分支统一触发（一次），此处不再重复排队 */
}

/** 旧签名兼容（boot 调用点）：回填合并块。 */
function loadProviderUI(cfg) {
  connectLoadFromConfig(cfg);
}

/** 旧签名兼容：合并后无「启用端点」勾选，字段常显（保留函数供旧调用点调用）。 */
function syncProviderUiState() {
  const wrap = document.getElementById('providerFields');
  if (wrap && wrap.style) wrap.style.display = '';
}

/** 旧签名兼容：保存后刷新运行态。 */
function applyProviderConfig() {
  connectSyncState();
  if (typeof updateBrandModel === 'function') updateBrandModel();
}

/** 旧签名兼容：采集 provider_* 键组。 */
function collectProviderConfig() {
  return connectCollectConfig();
}

/* ================= 初始化（boot 调用）================= */

function connectInit() {
  const on = (id, ev, fn) => {
    const el = document.getElementById(id);
    if (el && el.addEventListener) el.addEventListener(ev, fn);
  };
  on('providerBase', 'input', () => { connectScheduleIdentify(); });
  on('providerBase', 'change', () => { connectScheduleIdentify(); connectSyncState(); if (typeof queueSaveConfig === 'function') queueSaveConfig(); });
  on('apiKey', 'input', () => { connectScheduleIdentify(); });
  /* 修复 53（三轮）：删除此处 modelSelect change 重复绑定——110-boot.js:25 已绑
   * 同一处理器（connectOnModelChange + queueSaveConfig + updateBrandModel），
   * 双绑定导致一次下拉切换触发两轮识别/同步 */
  on('cmManualInput', 'input', () => { connectSyncState(); if (typeof updateBrandModel === 'function') updateBrandModel(); });
  on('cmManualInput', 'change', () => { if (typeof queueSaveConfig === 'function') queueSaveConfig(); });
  on('cmManualBack', 'click', () => { connectExitManual(); if (typeof queueSaveConfig === 'function') queueSaveConfig(); });
  /* 识别 / 测试按钮走模板 onclick（模板已绑定 connectIdentifyNow / connectTestNow），
     此处不重复绑定，避免一次点击触发两次识别 */
  ['reasoningEffort', 'providerPriceIn', 'providerPriceOut', 'providerPriceCache',
   'localToolCapable', 'localCtxWindow'].forEach(id => {
    on(id, 'change', () => { connectSyncState(); if (typeof queueSaveConfig === 'function') queueSaveConfig(); });
  });
  connectUpdateAdvanced();
  /* v1.8.0：预设卡网格已撤（输入区模型 chip 为主选择器；卡网格与其功能重复） */
}


/* ---------- v1.8.0 预设可视化卡网格（2026-10-21 用户实测：设置区以预设为主） ----------
 * select#providerPreset 契约保留（CSS 隐藏），卡网格驱动其 value +
 * onProviderPresetChange；卡从 options 动态生成（防 DOM 漂移）。 */
function connectPresetGridInit() {
  const slot = document.querySelector('.cm-preset-slot');
  const sel = document.getElementById('providerPreset');
  if (!slot || !sel || document.getElementById('cmPresetGrid')) return;
  const grid = document.createElement('div');
  grid.id = 'cmPresetGrid';
  grid.className = 'cm-preset-grid';
  const esc = (t) => (typeof escapeHtml === 'function' ? escapeHtml(String(t)) : String(t));
  grid.innerHTML = [...sel.options].map(o =>
    '<button type="button" class="cm-preset-card' + (o.value === sel.value ? ' on' : '') +
      '" data-val="' + esc(o.value) + '">' +
    '<span class="cpc-ic">' + esc((o.textContent || '?').trim().charAt(0)) + '</span>' +
    '<span class="cpc-name">' + esc(o.textContent) + '</span>' +
    (o.value === sel.value ? '<span class="cpc-check">✓</span>' : '') +
    '</button>').join('');
  slot.appendChild(grid);
  const sync = () => {
    grid.querySelectorAll('.cm-preset-card').forEach(c => {
      const on = c.getAttribute('data-val') === sel.value;
      c.classList.toggle('on', on);
      const chk = c.querySelector('.cpc-check');
      if (on && !chk) { const s2 = document.createElement('span'); s2.className = 'cpc-check'; s2.textContent = '✓'; c.appendChild(s2); }
      else if (!on && chk) chk.remove();
    });
  };
  grid.querySelectorAll('.cm-preset-card').forEach(card => {
    card.addEventListener('click', () => {
      const v = card.getAttribute('data-val');
      if (v === sel.value) return;
      sel.value = v;
      if (typeof onProviderPresetChange === 'function') onProviderPresetChange(v);
      sync();
    });
  });
  // select 被其他路径修改（恢复默认/载入配置）时同步卡态
  sel.addEventListener('change', sync);
}


/* v1.8.0：保存并测试——保存（queueSaveConfig 写 config.json）+ 跑测试连接，
 * 成功 toast 明示「对话正在使用」。保存与测试解耦：保存必达，测试结果异步回报。 */
async function connectSaveAndTest() {
  const btn = document.getElementById('cmSaveBtn');
  try {
    if (typeof connectSyncState === 'function') connectSyncState();
    if (typeof queueSaveConfig === 'function') queueSaveConfig();
    if (typeof toast === 'function') toast('已保存，对话正在使用该端点', 'ok');
  } catch (e) {
    if (typeof toast === 'function') toast('保存失败：' + (e.message || e), 'err');
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = '保存成功，测试中…'; }
  try {
    if (typeof connectTestNow === 'function') await connectTestNow();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '保存并测试连接'; }
  }
}
