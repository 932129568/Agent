/**
 * LIGHTWELL V4-H · 渐进式工具注册表（Node.js 生产级 ESM 终版）
 * 闭环修复：
 *   - D-01: 动态注册实际传入工具集，不写死 36 工具假设
 *   - D-02 / D-15: 宽口径 Schema 归一化（仅补 additionalProperties: false，无损保留 properties/required/enum）
 *   - D-04 / D-13: activateTools() 返回 { activated, missing }，杜绝幽灵工具名静默吞没
 *   - D-09: 导出唯一事实源 MCP_FOLD_THRESHOLD = 25，供 provider.js 与 providerBridge.mjs 共享
 *   - D-11: 内置 toFlatSpec() 与 registerMany()，无缝兼容 OpenAI function-calling 嵌套结构
 */

export const MCP_FOLD_THRESHOLD = 25;
export const META_INSPECT_SCHEMA_NAME = 'inspect_tool_schema';
export const META_MCP_SEARCH_NAME = 'mcp_search';

export const ToolRiskLevel = Object.freeze({
  READ_ONLY: 'read_only',
  IDEMPOTENT_WRITE: 'idempotent_write',
  DESTRUCTIVE: 'destructive',
  // R89 终局（残留 #2）：未分类的外部工具（未知名 / mcp__*）独立成档，
  // 前置门控默认要求人工确认 —— 否则「归入 IDEMPOTENT_WRITE 但只有 DESTRUCTIVE
  // 需要确认」会把 fail-closed 做成一句空话。
  UNCLASSIFIED_EXTERNAL: 'unclassified_external',
});

/**
 * 宽口径参数 Schema 归一化（只增不改，保留原有 properties / required / enum）
 * @param {object} rawParams
 * @returns {object}
 */
export function normalizeToolParameters(rawParams) {
  const base =
    rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
      ? { ...rawParams }
      : { type: 'object', properties: {} };

  if (!base.type) {
    base.type = 'object';
  }
  if (!base.properties || typeof base.properties !== 'object' || Array.isArray(base.properties)) {
    base.properties = {};
  }
  if (base.additionalProperties !== false) {
    base.additionalProperties = false;
  }
  return base;
}

/**
 * 将 provider.js 的 OpenAI 嵌套工具对象转换为注册表扁平规格
 * @param {object} openaiTool
 * @param {string} [riskLevel]
 */
export function toFlatSpec(openaiTool, riskLevel = ToolRiskLevel.READ_ONLY) {
  const fn = openaiTool && openaiTool.function ? openaiTool.function : openaiTool;
  if (!fn || typeof fn.name !== 'string' || !fn.name.trim()) {
    throw new Error('INVALID_TOOL_SPEC: missing function.name');
  }
  return {
    name: fn.name.trim(),
    description: String(fn.description || ''),
    parameters: normalizeToolParameters(fn.parameters),
    riskLevel,
  };
}

export class ProgressiveToolRegistry {
  /**
   * @param {object} [options]
   * @param {number} [options.maxActiveSchemas=12]
   * @param {number} [options.defaultTtl=3]
   */
  constructor({ maxActiveSchemas = 12, defaultTtl = 3 } = {}) {
    this.maxActiveSchemas = maxActiveSchemas;
    this.defaultTtl = defaultTtl;
    /** @type {Map<string, {name: string, description: string, parameters: object, riskLevel: string}>} */
    this._tools = new Map();
    /** @type {Map<string, number>} 利用 Map 插入序实现等 TTL 下的严格确定性 LRU */
    this._activeTtl = new Map();
  }

  /**
   * 注册单个工具（同时支持嵌套 OpenAI 格式与扁平格式）
   */
  register(rawSpec, riskLevel = ToolRiskLevel.READ_ONLY) {
    const spec =
      rawSpec && rawSpec.function
        ? toFlatSpec(rawSpec, riskLevel)
        : {
            name: String(rawSpec?.name || '').trim(),
            description: String(rawSpec?.description || ''),
            parameters: normalizeToolParameters(rawSpec?.parameters),
            riskLevel: rawSpec?.riskLevel || riskLevel,
          };

    if (!spec.name) {
      throw new Error('INVALID_TOOL_SPEC: empty tool name');
    }
    this._tools.set(spec.name, spec);
    return spec;
  }

  /**
   * 批量注册工具列表
   */
  registerMany(toolList, riskResolver = () => ToolRiskLevel.READ_ONLY) {
    for (const item of toolList || []) {
      const fnName = item?.function?.name || item?.name || '';
      this.register(item, riskResolver(fnName));
    }
    return this._tools.size;
  }

  has(name) {
    return this._tools.has(name);
  }

  get size() {
    return this._tools.size;
  }

  getActiveNames() {
    return Array.from(this._activeTtl.keys());
  }

  /**
   * 激活指定工具列表，显式返回已激活与未命中的幽灵工具名
   * @param {string[]} names
   * @returns {{ activated: string[], missing: string[] }}
   */
  activateTools(names = []) {
    const activated = [];
    const missing = [];

    for (const name of names) {
      if (!this._tools.has(name)) {
        missing.push(name);
        continue;
      }
      if (this._activeTtl.has(name)) {
        this._activeTtl.delete(name);
      }
      this._activeTtl.set(name, this.defaultTtl);
      activated.push(name);
    }

    this._evictIfOverflow();
    return { activated, missing };
  }

  /**
   * 真 LRU 溢出淘汰：优先淘汰 TTL 最低者；TTL 相同时淘汰 Map 中最先插入（最久未使用）者
   */
  _evictIfOverflow() {
    while (this._activeTtl.size > this.maxActiveSchemas) {
      let victim = null;
      let minTtl = Infinity;
      for (const [name, ttl] of this._activeTtl.entries()) {
        if (ttl < minTtl) {
          minTtl = ttl;
          victim = name;
        }
      }
      if (victim !== null) {
        this._activeTtl.delete(victim);
      } else {
        break;
      }
    }
  }

  /**
   * 轮次衰减：刷新本轮被调用工具的 TTL 与 LRU 顺位，其余活跃工具 TTL 减 1
   */
  tickTurnDecay(calledName = null) {
    if (calledName && this._activeTtl.has(calledName)) {
      this._activeTtl.delete(calledName);
      this._activeTtl.set(calledName, this.defaultTtl);
    }

    for (const [name, ttl] of Array.from(this._activeTtl.entries())) {
      if (name === calledName) continue;
      if (ttl <= 1) {
        this._activeTtl.delete(name);
      } else {
        this._activeTtl.set(name, ttl - 1);
      }
    }
  }

  /**
   * 纯只读无副作用 Schema 查询（残留 #3 修复）：不调用 activateTools，
   * 不改变 LRU/TTL 状态。执行护栏每请求回查 Schema 必须走这里，否则
   * 「查一次 Schema」会把工具激活窗口推进一格，产生与用户操作无关的副作用。
   */
  getSchemaOnly(name) {
    const spec = this._tools.get(name);
    if (!spec) {
      return {
        ok: false,
        error: { code: 'TOOL_NOT_FOUND', message: `未注册工具: ${name}` },
      };
    }
    return {
      ok: true,
      schema: {
        type: 'function',
        function: {
          name: spec.name,
          description: spec.description,
          parameters: spec.parameters,
        },
      },
      riskLevel: spec.riskLevel,
    };
  }

  /**
   * 模型主动调用 inspect_tool_schema 时使用：返回 Schema **并**激活其生命周期
   * （按需展开语义：模型查过就代表即将调用，理应进入活跃窗口）。
   */
  inspectSchema(name) {
    const res = this.getSchemaOnly(name);
    if (res.ok) {
      this.activateTools([name]);
    }
    return res;
  }

  /**
   * 渲染未激活工具的极简轻量目录（注入 System Prompt 供模型按需检索）
   */
  renderLightweightCatalog() {
    const lines = [];
    for (const spec of this._tools.values()) {
      if (this._activeTtl.has(spec.name)) continue;
      const summary = spec.description.split('|')[0].trim();
      lines.push(`- ${spec.name} [${spec.riskLevel}]: ${summary}`);
    }
    return lines.join('\n');
  }

  /**
   * 导出当前活跃工具的 OpenAI function-calling 载荷
   */
  buildActiveOpenAITools({ includeMetaInspect = true } = {}) {
    const payload = [];

    if (includeMetaInspect) {
      payload.push({
        type: 'function',
        function: {
          name: META_INSPECT_SCHEMA_NAME,
          description:
            '按名称按需加载未激活工具的完整参数 Schema|在调用目录中列出但尚未展开的工具前使用|已直接列出的工具无需重复检查',
          parameters: {
            type: 'object',
            properties: {
              tool_name: { type: 'string', description: '目标工具名称' },
            },
            required: ['tool_name'],
            additionalProperties: false,
          },
        },
      });
    }

    for (const name of this._activeTtl.keys()) {
      const spec = this._tools.get(name);
      if (!spec) continue;
      payload.push({
        type: 'function',
        function: {
          name: spec.name,
          description: spec.description,
          parameters: spec.parameters,
        },
      });
    }

    return payload;
  }
}
