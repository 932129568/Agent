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
    // Round 12 修复（2026-11-04）：原预设三个模型名（glm-5.3-flash / glm-5.3-flashx
    // / glm-4.7-flash）在 bigmodel.cn 均不存在→选任一项都报 1211/异常，这正是
    // 「换台机器一装就废」的根因之一。改为平台在售的免费/付费实义模型名。
    models: [
      { id: 'glm-4.5-flash', text: 'glm-4.5-flash（免费 · 日常够用）' },
      { id: 'glm-4-flash', text: 'glm-4-flash（免费 · 更省）' },
      { id: 'glm-4.5', text: 'glm-4.5（需余额/额度 · 更强推理）' }
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
    // Round 12 修复（2026-11-04）：与 PRESETS.glm 同步——原表里 glm-5.3-flash /
    // glm-5.3-flashx / glm-4.7-flash 在 bigmodel.cn 不存在（1211），实时清单失败
    // 时用它们兜底等于把「装完即失败」写死。
    { id: 'glm-4.5-flash', text: 'glm-4.5-flash（免费 · 日常够用）' },
    { id: 'glm-4-flash', text: 'glm-4-flash（免费 · 更省）' },
    { id: 'glm-4.5', text: 'glm-4.5（需余额/额度 · 更强推理）' },
    { id: 'glm-4.6', text: 'glm-4.6（新一代）' },
    { id: 'glm-4.5-air', text: 'glm-4.5-air（轻量）' }
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
