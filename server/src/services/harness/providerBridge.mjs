/**
 * LIGHTWELL V4-H · provider.js 渐进式工具面桥接层（Node.js 生产级 ESM 终版）
 * 闭环修复：
 *   - D-04 / D-13: 锁定 5 个真实常驻只读工具 + 1 个元工具 = 6
 *   - D-09 / D-10: 显式导入 MCP_FOLD_THRESHOLD，消除未定义引用与双套常量
 *   - D-11: 通过 registerMany() 无损适配 provider.js 嵌套工具列表
 *   - A-11: 新增模块级注册表缓存 getCachedToolRegistry()，供 jsapi 每请求的
 *           Schema 回查复用（此前每请求重建 34 个工具，与 P95<=150ms 准出线冲突）
 *
 * 【注意】A-11 的实现必须保留 R88「缺陷 A」的可选常驻工具容错：
 *   文档 §1.2 给的整文件替换版把 missing 一律抛 V4H_GHOST_ALWAYS_ACTIVE_TOOLS，
 *   实测 buildProgressiveToolSurface([read_more],[]) 直接抛错（因为 read_file /
 *   list_dir / memory_search / browser_snapshot 受 wsOn / includeAgent 条件挂载），
 *   等于把 R88 已修的崩溃点原样退回去。此处保留容错版本，只额外增加缓存函数。
 */

import {
  ProgressiveToolRegistry,
  MCP_FOLD_THRESHOLD,
  META_MCP_SEARCH_NAME,
} from './progressiveToolRegistry.mjs';
import { classifyToolRisk } from './executionGuardrails.mjs';
import {
  AnchoredHandoffState,
  MessageTurn,
  getSharedContextAssembler,
} from './contextAssembler.mjs';

/**
 * 5 个真实存在的常驻只读核心工具（与 inspect_tool_schema 元工具共同构成 6 个初始活跃工具）
 */
export const ALWAYS_ACTIVE_READONLY_NAMES = Object.freeze([
  'read_more',
  'memory_search',
  'browser_snapshot',
  'read_file',
  'list_dir',
]);

/**
 * 「已知可选」常驻工具族（R88 缺陷 A 修正）：
 * 这 4 个都由 provider.js 条件挂载，缺失是「合法缺席」而非幽灵名：
 *   - memory_search / browser_snapshot 属 AGENT_TOOLS，取决于 includeAgent；
 *   - read_file / list_dir 属 FILE_TOOLS，取决于 workspace 开关。
 * 缺失时跳过而非抛错，否则灰度一开 + includeAgent=false（或工作区关闭）即崩。
 * 注：read_more 不在此名单——provider.js `const tools = [READ_MORE]` 无条件执行，
 * 缺它一定是真 bug，必须硬失败。
 */
export const OPTIONAL_ALWAYS_ACTIVE_NAMES = Object.freeze([
  'read_file',
  'list_dir',
  'memory_search',
  'browser_snapshot',
]);
export const OPTIONAL_ALWAYS_ACTIVE = new Set(OPTIONAL_ALWAYS_ACTIVE_NAMES);

// 可选缺失是常态，每轮都打会把日志刷满——模块级只告警一次，默认静默。
let _optionalWarned = false;

/**
 * 构建并校验 provider 渐进式工具注册表
 * @param {Array<object>} baseOpenAITools - provider.js assembleFullToolList() 产出的基础工具列表
 * @param {Array<object>} [mcpTools=[]] - mcpToolSchemas() 产出的 MCP 工具列表
 */
export function buildProgressiveToolSurface(baseOpenAITools = [], mcpTools = []) {
  const registry = new ProgressiveToolRegistry({
    maxActiveSchemas: 12,
    defaultTtl: 3,
  });

  registry.registerMany(baseOpenAITools, classifyToolRisk);

  const safeMcpList = Array.isArray(mcpTools) ? mcpTools : [];
  const mcpFolded = safeMcpList.length > MCP_FOLD_THRESHOLD;

  if (safeMcpList.length > 0 && !mcpFolded) {
    registry.registerMany(safeMcpList, classifyToolRisk);
  }

  const { activated, missing } = registry.activateTools(ALWAYS_ACTIVE_READONLY_NAMES);

  // 缺陷 A：4 个常驻工具受 includeAgent / wsOn 条件挂载，缺失属「已知可选」而非
  // 幽灵名，跳过而非抛错；其余缺失名仍视为真幽灵名，立即硬失败。
  const skippedOptional = missing.filter((name) => OPTIONAL_ALWAYS_ACTIVE.has(name));
  const ghostNames = missing.filter((name) => !OPTIONAL_ALWAYS_ACTIVE.has(name));
  if (skippedOptional.length > 0 && !_optionalWarned && process.env.LIGHTWELL_HARNESS_V4H_DEBUG === '1') {
    _optionalWarned = true;
    console.warn(`[V4H] skipped optional always-active tools: ${skippedOptional.join(', ')}`);
  }
  if (ghostNames.length > 0) {
    throw new Error(`V4H_GHOST_ALWAYS_ACTIVE_TOOLS: ${ghostNames.join(', ')}`);
  }

  const activeTools = registry.buildActiveOpenAITools({ includeMetaInspect: true });

  return {
    registry,
    activeTools,
    activatedNames: activated,
    skippedOptional,
    catalogMarkdown: registry.renderLightweightCatalog(),
    mcpFolded,
    metaMcpSearchName: META_MCP_SEARCH_NAME,
  };
}

let _cachedRegistryKey = '';
let _cachedRegistry = null;

/**
 * 模块级缓存的工具注册表（A-11）。
 *
 * 用途单一：给 jsapi 前置护栏按模型工具名回查 JSON Schema，避免每请求重建注册表。
 * 残留 #3 已修（progressiveToolRegistry.getSchemaOnly 纯只读、不推进 LRU/TTL），
 * 因此本缓存**只用于 Schema 查询**；下发工具面仍走 buildProgressiveToolSurface，
 * 两者互不干扰。
 *
 * @param {Array<object>} baseOpenAITools
 * @returns {ProgressiveToolRegistry}
 */
export function getCachedToolRegistry(baseOpenAITools = []) {
  const fingerprint = (baseOpenAITools || [])
    .map((t) => t?.function?.name || t?.name || '')
    .join('|');
  if (_cachedRegistry && _cachedRegistryKey === fingerprint) {
    return _cachedRegistry;
  }
  const registry = new ProgressiveToolRegistry({ maxActiveSchemas: 12, defaultTtl: 3 });
  registry.registerMany(baseOpenAITools, classifyToolRisk);
  _cachedRegistry = registry;
  _cachedRegistryKey = fingerprint;
  return registry;
}

/** 仅供测试/诊断：清空缓存（默认无需调用） */
export function __resetToolRegistryCache() {
  _cachedRegistry = null;
  _cachedRegistryKey = '';
}

/* ================= T05 Phase D · Harness V2 接线（默认关闭） =================
 * 为什么要开关而不是直接切换：MOD-01（ContextAssembler）与 MOD-05（Feedback
 * Immune）改变的是**上下文装配方式**，一旦在线上按新口径拼 messages，所有基于
 * 旧载荷的缓存前缀、token 预算、灰度观测口径同时变化。Phase D 的定位是「先可
 * 运行、可对比、可回退」，所以：
 *   - 未设 HARBOR_HARNESS_V2=1 时，本文件**既有导出行为逐字节不变**：
 *     新代码只新增两个导出符号，不改既有函数体、不改既有返回值。
 *   - 设了才走 buildHarnessV2Envelope()，由它组合渐进式工具面 + 六分区装配。
 * 没有任何 js_api 方法被新增或改名（registry.js 未改动，method-surface 仍 51/117/168）。
 */

/**
 * V2 通道开关（默认关闭）。
 * 只认字符串 '1'：'true' / 'yes' 一律不算——环境变量的模糊真值是多起线上事故的
 * 来源，宁可在灰度脚本里显式写 1。
 * @param {Record<string, string|undefined>} [env=process.env] 便于测试注入
 * @returns {boolean}
 */
export function harnessV2Enabled(env = process.env) {
  return Boolean(env) && env.HARBOR_HARNESS_V2 === '1';
}

/**
 * V2 上下文封装入口（开关关闭时返回 null，调用方据此保留旧路径）。
 *
 * 组合关系：
 *   buildProgressiveToolSurface() → 渐进式工具面 + 轻量目录 Markdown
 *   ContextAssembler.assemble()   → 六分区装配（L1/L2/工具目录/交接单/工作记忆/L3 尾锚）
 *
 * @param {object} [input]
 * @param {Array<object>} [input.baseOpenAITools=[]]
 * @param {Array<object>} [input.mcpTools=[]]
 * @param {string} [input.l1Charter='']
 * @param {string} [input.l2PhasePrompt='']
 * @param {string} [input.l3ActiveSkills='']
 * @param {AnchoredHandoffState|null} [input.handoffState=null]
 * @param {MessageTurn[]|Array<object>} [input.workingTurns=[]]
 * @param {Record<string, string|undefined>} [input.env=process.env]
 * @param {object|null} [input.assembler=null] 注入自定义 ContextAssembler（测试用）
 * @returns {null|{enabled: true, surface: object, messages: Array<object>,
 *            systemPrompt: string, workingTurns: MessageTurn[], handoff: AnchoredHandoffState}}
 */
export function buildHarnessV2Envelope({
  baseOpenAITools = [],
  mcpTools = [],
  l1Charter = '',
  l2PhasePrompt = '',
  l3ActiveSkills = '',
  handoffState = null,
  workingTurns = [],
  env = process.env,
  assembler = null,
} = {}) {
  if (!harnessV2Enabled(env)) return null;

  const surface = buildProgressiveToolSurface(baseOpenAITools, mcpTools);
  const engine = assembler || getSharedContextAssembler();
  const handoff = handoffState || new AnchoredHandoffState();

  // 桥接便利：调用方可能直接递上游 session 的裸消息对象（{role, content}）。
  // py 侧没有这条路径（类型注解即契约），但 Node 侧是运行时桥，缺 turnId 会让
  // 压缩兜底提取拿到 undefined 作为 call_id，因此在这里补一个稳定兜底 id——
  // 只补缺失字段，不覆盖调用方已给的任何值。
  const turns = (Array.isArray(workingTurns) ? workingTurns : []).map((t, i) => {
    if (t && typeof t.serializeForCounting === 'function') return t;
    const raw = t && typeof t === 'object' ? t : {};
    return new MessageTurn({
      role: raw.role || 'user',
      content: raw.content === undefined ? '' : raw.content,
      turnId: raw.turnId || `turn_${i}`,
      toolCalls: Array.isArray(raw.toolCalls) ? raw.toolCalls : [],
      toolCallId: raw.toolCallId || null,
      toolName: raw.toolName || null,
      importanceScore: typeof raw.importanceScore === 'number' ? raw.importanceScore : 1.0,
    });
  });

  const [messages, updatedTurns] = engine.assemble({
    l1Charter,
    l2PhasePrompt,
    l3ActiveSkills,
    toolCatalogSummary: surface.catalogMarkdown,
    handoffState: handoff,
    workingTurns: turns,
  });

  return {
    enabled: true,
    surface,
    messages,
    systemPrompt: messages.length > 0 ? messages[0].content : '',
    workingTurns: updatedTurns,
    handoff,
  };
}
