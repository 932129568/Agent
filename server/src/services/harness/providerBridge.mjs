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
