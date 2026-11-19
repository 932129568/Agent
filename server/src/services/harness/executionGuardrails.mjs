/**
 * LIGHTWELL V4-H · R89 确定性执行护栏（最终闭环版）
 *
 * 设计原则：
 *   1. 严格区分【模型工具名域】与【js_api 方法名域】：
 *      - 风险分类、分发：规范化方法名（canonicalMethodName）
 *      - 查模型 JSON Schema：模型工具名（toModelToolName）
 *   2. 剥离传输层字段（token）与 js_api 位置控制参（recycle / timeout），解包 params 容器，
 *      使业务参数与模型层 additionalProperties:false 的 Schema 对齐（A-02 / A-03）。
 *   3. 保留 DESTRUCTIVE_TOOL_NAMES 主导出与 CONFIRM_REQUIRED 错误码，
 *      现有门禁（v4h-harness.mjs:29 命名导入）与前端 card.js 字面量判断零破坏（A-01 / A-05）。
 *   4. 模块级持久化单例 getSharedGuardrailEngine()，使跨请求写幂等窗口真实生效（A-04）。
 *   5. 路径沙盒判定先做分隔符归一化：只匹配反斜杠的实现可被
 *      `C:/Windows/system32/x`、`C://Windows//System32//x`、`\\server\share\x` 绕过（A-13）。
 *   6. 【残留 #1】分离「预检」与「事后登记」：evaluatePreFlight 只读检查，
 *      recordSuccessfulWrite 仅在工具真的执行成功（ok !== false）后写入幂等窗口，
 *      避免首次失败（路径不存在 / 权限拒绝）后 5s 内的合法重试被误判成重复写。
 *   7. 【残留 #2】未知工具与 mcp__* 归入 UNCLASSIFIED_EXTERNAL 档并要求确认，
 *      让 fail-closed 从声明变成行为。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolRiskLevel } from './progressiveToolRegistry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FROZEN_SURFACE_PATH = path.resolve(
  HERE,
  '../../../../deliverables/dev-plan/frozen-python-surface.json'
);

/**
 * 模型工具名 -> js_api 方法名映射（用于风险分类与方法签名查找）
 */
export const TOOL_TO_JSAPI_ALIAS = Object.freeze({
  clipboard_write: 'set_clipboard',
  clipboard_read: 'get_clipboard',
  memory_write: 'memory_remember',
});

/**
 * js_api 方法名 -> 模型工具名反向映射（用于回查 provider.js 注册表中的模型 Schema，A-14）
 */
export const JSAPI_TO_TOOL_ALIAS = Object.freeze({
  set_clipboard: 'clipboard_write',
  get_clipboard: 'clipboard_read',
  memory_remember: 'memory_write',
});

export function canonicalMethodName(rawName) {
  const trimmed = String(rawName || '').trim();
  return TOOL_TO_JSAPI_ALIAS[trimmed] || trimmed;
}

export function toModelToolName(rawName) {
  const trimmed = String(rawName || '').trim();
  return JSAPI_TO_TOOL_ALIAS[trimmed] || trimmed;
}

/**
 * 破坏性 / 高危外部副作用集合（A-01：恢复 DESTRUCTIVE_TOOL_NAMES 主导出名）
 * 末 3 项为历史别名，仓库中当前无同名 js_api 方法，保留属防御性 fail-closed
 * （文档 §1.2 未列这 3 项；未列即会落到 UNCLASSIFIED_EXTERNAL 档，行为同为
 * 「未确认必拦」，此处保留是为了让风险标签仍是 destructive，判据更严不更松）。
 */
export const DESTRUCTIVE_TOOL_NAMES = Object.freeze(
  new Set([
    'delete_path',
    'kill_process',
    'run_admin_command',
    'run_command',
    'run_powershell',
    'browser_click',
    'browser_fill',
    'browser_navigate',
    'delete_file',
    'remove_file',
    'execute_shell',
  ])
);

/** 兼容别名导出，防止双口径引用断裂 */
export const DESTRUCTIVE_METHOD_NAMES = DESTRUCTIVE_TOOL_NAMES;

/**
 * 幂等 / 状态变更写入集合（A-07 / A-12）
 */
export const IDEMPOTENT_WRITE_TOOL_NAMES = Object.freeze(
  new Set([
    'write_file',
    'append_file',
    'search_replace',
    'make_dir',
    'move_path',
    'copy_path',
    'set_clipboard',
    'clipboard_write',
    'append_memory',
    'memory_remember',
    'memory_write',
    'open_app',
    'open_url',
    'browser_open',
    'software_call',
  ])
);

/**
 * 纯只读安全白名单（A-04 / A-12：白名单之外一律 fail-closed 归入 IDEMPOTENT_WRITE）
 */
export const SAFE_READONLY_METHOD_NAMES = Object.freeze(
  new Set([
    'read_more',
    'read_file',
    'list_dir',
    'get_file_info',
    'take_screenshot',
    'get_clipboard',
    'clipboard_read',
    'list_processes',
    'browser_search',
    'browser_extract',
    'browser_snapshot',
    'browser_screenshot',
    'browser_close',
    'memory_search',
    'mcp_search',
    'inspect_tool_schema',
  ])
);

/**
 * 风险等级分类器（真 fail-closed，残留 #2）
 *
 * 四档判定顺序：破坏性 → 幂等写 → 只读白名单 → UNCLASSIFIED_EXTERNAL。
 * 最后这一档是行为上的关键差异：旧实现把「不在任何名单里」的未知工具塞进
 * IDEMPOTENT_WRITE，而非只读模式下只有 DESTRUCTIVE 才要确认，于是未知工具
 * 反而被一路放行 —— 「fail-closed」只是注释里的一句话。现在未知工具与
 * mcp__* 一律落 UNCLASSIFIED_EXTERNAL，前置门控默认要求人工确认。
 * @param {string} rawName
 * @returns {string}
 */
export function classifyToolRisk(rawName) {
  const raw = String(rawName || '').trim();
  const canonical = canonicalMethodName(raw);
  if (DESTRUCTIVE_TOOL_NAMES.has(canonical) || DESTRUCTIVE_TOOL_NAMES.has(raw)) {
    return ToolRiskLevel.DESTRUCTIVE;
  }
  if (IDEMPOTENT_WRITE_TOOL_NAMES.has(canonical) || IDEMPOTENT_WRITE_TOOL_NAMES.has(raw)) {
    return ToolRiskLevel.IDEMPOTENT_WRITE;
  }
  if (SAFE_READONLY_METHOD_NAMES.has(canonical) || SAFE_READONLY_METHOD_NAMES.has(raw)) {
    return ToolRiskLevel.READ_ONLY;
  }
  return ToolRiskLevel.UNCLASSIFIED_EXTERNAL;
}

let _cachedArities = null;
let _aritiesWarned = false;
export function getMethodAritiesMap() {
  if (_cachedArities !== null) return _cachedArities;
  try {
    const raw = JSON.parse(fs.readFileSync(FROZEN_SURFACE_PATH, 'utf8'));
    _cachedArities = raw && typeof raw.method_arities === 'object' ? raw.method_arities : {};
  } catch (err) {
    // 读不到快照时回落 {}：后果是所有位置参都无法映射 → 必填校验全部判红（fail-closed，
    // 不会放行）。但必须留一条痕，否则线上排查会误以为「参数没传」而不是「快照读不到」。
    _cachedArities = {};
    if (!_aritiesWarned && process.env.LIGHTWELL_HARNESS_V4H_DEBUG === '1') {
      _aritiesWarned = true;
      console.warn(`[V4H] frozen surface 读取失败，位置参映射降级为 {}: ${err && err.message}`);
    }
  }
  return _cachedArities;
}

/** 传输层 / js_api 专属控制字段：不参与模型层 Schema 校验 */
const TRANSPORT_AND_JSAPI_ONLY_KEYS = new Set(['token', 'recycle', 'timeout']);

/**
 * 跨层业务参数提取（A-02 / A-03 / A-06）：
 * 把 js_api 位置参数数组还原为与模型层 JSON Schema 对齐的纯业务参数对象。
 *
 * @param {string} methodName
 * @param {Array<any>} args
 * @param {Record<string, string[]>} [aritiesMap]
 * @returns {Record<string, any>}
 */
export function extractBusinessArgsForSchema(
  methodName,
  args = [],
  aritiesMap = getMethodAritiesMap()
) {
  if (!Array.isArray(args) || args.length === 0) {
    return {};
  }

  const canonical = canonicalMethodName(methodName);

  // 特例 1：append_memory([JSON.stringify({ text })]) -> 模型 Schema 为 { content }
  if (canonical === 'append_memory') {
    const rawFirst = args[0];
    if (typeof rawFirst === 'string') {
      try {
        const parsed = JSON.parse(rawFirst);
        if (parsed && typeof parsed === 'object') {
          const contentVal = parsed.content !== undefined ? parsed.content : parsed.text;
          return contentVal !== undefined ? { content: String(contentVal) } : {};
        }
      } catch {
        return rawFirst.trim() ? { content: rawFirst } : {};
      }
      return rawFirst.trim() ? { content: rawFirst } : {};
    }
    if (rawFirst && typeof rawFirst === 'object' && !Array.isArray(rawFirst)) {
      const contentVal = rawFirst.content !== undefined ? rawFirst.content : rawFirst.text;
      return contentVal !== undefined ? { content: String(contentVal) } : { ...rawFirst };
    }
    return {};
  }

  // 特例 2：memory_remember([text, role, force]) -> 模型 memory_write Schema 为 { content }
  if (canonical === 'memory_remember') {
    if (typeof args[0] === 'string') {
      return args[0].trim() ? { content: args[0] } : {};
    }
    if (args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
      const contentVal = args[0].content !== undefined ? args[0].content : args[0].text;
      return contentVal !== undefined ? { content: String(contentVal) } : { ...args[0] };
    }
    return {};
  }

  const paramNames = aritiesMap[canonical] || aritiesMap[methodName];

  // 特例 3：arity 首参为 params（browser_search / browser_open / software_call）
  if (Array.isArray(paramNames) && paramNames[0] === 'params') {
    if (args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
      const unwrapped = { ...args[0] };
      delete unwrapped.token;
      return unwrapped;
    }
    return {};
  }

  // 单个对象实参：直接视为具名参数对象（剥掉传输层字段）。
  // 例外：arity 恰好 1 个参数且该参数名不在对象里 —— 说明传的是「该参数的值本身」
  // （如某方法 arity=['entry']，前端传 [{a:1}]），此时必须走下方位置映射，
  // 否则会把整个值对象当成「具名参数集合」，被 additionalProperties:false 判成
  // UNKNOWN_PROPERTY 全字段非法。
  if (
    args.length === 1 &&
    args[0] !== null &&
    typeof args[0] === 'object' &&
    !Array.isArray(args[0]) &&
    (!Array.isArray(paramNames) || paramNames.length !== 1 || paramNames[0] in args[0])
  ) {
    const clean = { ...args[0] };
    for (const k of TRANSPORT_AND_JSAPI_ONLY_KEYS) delete clean[k];
    return clean;
  }

  if (!Array.isArray(paramNames) || paramNames.length === 0) {
    // 冻结快照缺失该方法的 arity 时，只能把对象实参原样当业务参数（仍剥传输层字段）；
    // 读快照失败已在 getMethodAritiesMap() 里留痕，这里不再重复告警。
    if (args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
      const clean = { ...args[0] };
      for (const k of TRANSPORT_AND_JSAPI_ONLY_KEYS) delete clean[k];
      return clean;
    }
    return {};
  }

  const mapped = {};
  for (let i = 0; i < paramNames.length; i += 1) {
    const key = paramNames[i];
    if (TRANSPORT_AND_JSAPI_ONLY_KEYS.has(key)) continue;
    if (args[i] !== undefined) {
      mapped[key] = args[i];
    }
  }
  return mapped;
}

/** 保持兼容导出旧函数名 */
export const normalizePositionalArgs = extractBusinessArgsForSchema;

/**
 * 敏感系统路径越界判定（A-13：覆盖 path / new_path / src / dst / dir）
 *
 * 【勘误修正】分隔符归一化后再匹配。原实现只认反斜杠（/^[a-zA-Z]:\\Windows/），
 * 实测 `C:/Windows/system32/x` 与 `C://Windows//System32//x` 均 allowed=true。
 * @param {string} targetPath
 * @returns {boolean}
 */
export function isPathOutsideSafeBoundary(targetPath) {
  const raw = String(targetPath ?? '').trim();
  if (!raw) return false;
  const slashed = raw.replace(/\\/g, '/');
  // UNC 路径（\\server\share）在分隔符归一化后形如 //server/share —— 必须在
  // 折叠重复斜杠之前判定，否则会被压成 /server/share 而漏检。
  if (/^\/\//.test(slashed)) return true;
  // 折叠重复斜杠：C://Windows//System32//x 与 C:/Windows/System32/x 必须等价判定
  const normalized = slashed.replace(/\/{2,}/g, '/');
  if (/^[a-z]:\/windows(\/|$)/i.test(normalized)) return true;
  if (/^[a-z]:\/program files(?: \(x86\))?(\/|$)/i.test(normalized)) return true;
  if (/^\/(?:etc|bin|sbin|usr|boot|sys|proc|dev)(?:\/|$)/i.test(normalized)) return true;
  if (/(?:^|\/)\.\.(?:\/|$)/.test(normalized)) return true;
  return false;
}

/**
 * 常见提示词注入攻击特征正则（用于外部页面与文档内容消毒）
 */
const PROMPT_INJECTION_PATTERNS = [
  /<\s*\/?\s*system\s*>/gi,
  /<\s*\/?\s*instructions?\s*>/gi,
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/gi,
  /disregard\s+(all\s+)?(previous|prior|above)\s+rules/gi,
];

/**
 * 幂等去重目标集合（只覆盖「创建 / 覆写 / 记忆」类，不误伤命令与交互）。
 * 提到模块级：预检与事后登记必须共用同一集合，否则会退化成
 * 「预检查 A 集合、登记写 B 集合」的恒 false 判据。
 */
const IDEMPOTENT_DEDUP_TARGETS = new Set([
  'write_file',
  'make_dir',
  'move_path',
  'copy_path',
  'memory_remember',
  'append_memory',
]);

export class NodeExecutionGuardrailEngine {
  /**
   * @param {object} [options]
   * @param {boolean} [options.readOnlyMode=false]
   * @param {number} [options.idempotencyWindowMs=5000]
   */
  constructor({ readOnlyMode = false, idempotencyWindowMs = 5000 } = {}) {
    this.readOnlyMode = Boolean(readOnlyMode);
    this.idempotencyWindowMs = idempotencyWindowMs;
    /** @type {Map<string, number>} 短窗口写幂等去重表 */
    this._recentWrites = new Map();
  }

  _buildWriteSignature(canonical, args, sessionId) {
    return `${sessionId}::${canonical}::${JSON.stringify(args)}`;
  }

  /**
   * 仅在工具**实际执行成功**后调用，登记幂等去重窗口（残留 #1 修复）。
   * 调用点：jsapi.js 在 invoke() 返回且结果 ok !== false 之后。
   */
  recordSuccessfulWrite({ toolName, args = {}, sessionId = 'default' }) {
    if (this.idempotencyWindowMs <= 0) return;
    const canonical = canonicalMethodName(toolName);
    if (!IDEMPOTENT_DEDUP_TARGETS.has(canonical)) return;
    const now = Date.now();
    for (const [k, exp] of this._recentWrites.entries()) {
      if (exp <= now) this._recentWrites.delete(k);
    }
    const sig = this._buildWriteSignature(canonical, args, sessionId);
    this._recentWrites.set(sig, now + this.idempotencyWindowMs);
  }

  /**
   * 前置确定性护栏判定（五维：只读模式 / 参数 Schema / 路径与空命令 / 确认 / 幂等）
   * @param {object} params
   * @param {string} params.toolName
   * @param {object} [params.args={}]
   * @param {boolean} [params.confirmed=false]
   * @param {object|null} [params.parameterSchema=null]
   * @param {string} [params.sessionId='default']
   */
  evaluatePreFlight({
    toolName,
    args = {},
    confirmed = false,
    parameterSchema = null,
    sessionId = 'default',
  } = {}) {
    if (typeof toolName !== 'string' || !toolName.trim()) {
      return {
        allowed: false,
        code: 'INVALID_TOOL_NAME',
        riskLevel: ToolRiskLevel.READ_ONLY,
        message: '工具名称不能为空',
      };
    }

    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return {
        allowed: false,
        code: 'INVALID_ARGUMENTS',
        riskLevel: classifyToolRisk(toolName),
        message: `工具 [${toolName}] 参数必须是合法对象`,
      };
    }

    const canonical = canonicalMethodName(toolName);
    const risk = classifyToolRisk(canonical);

    // 维度 1：只读安全模式拦截
    if (this.readOnlyMode && risk !== ToolRiskLevel.READ_ONLY) {
      return {
        allowed: false,
        code: 'READONLY_MODE_BLOCKED',
        riskLevel: risk,
        message: `当前处于只读安全模式，拒绝执行非只读工具: ${canonical}`,
      };
    }

    // 维度 2：JSON Schema 必填字段与未知属性强校验
    if (parameterSchema && typeof parameterSchema === 'object') {
      const requiredFields = Array.isArray(parameterSchema.required) ? parameterSchema.required : [];
      for (const reqKey of requiredFields) {
        const val = args[reqKey];
        if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) {
          return {
            allowed: false,
            code: 'MISSING_REQUIRED',
            riskLevel: risk,
            message: `工具 [${canonical}] 缺少必填参数: ${reqKey}`,
          };
        }
      }

      if (
        parameterSchema.additionalProperties === false &&
        parameterSchema.properties &&
        typeof parameterSchema.properties === 'object'
      ) {
        const allowedKeys = new Set(Object.keys(parameterSchema.properties));
        for (const actualKey of Object.keys(args)) {
          if (!allowedKeys.has(actualKey)) {
            return {
              allowed: false,
              code: 'UNKNOWN_PROPERTY',
              riskLevel: risk,
              message: `工具 [${canonical}] 包含未声明的非法参数字段: ${actualKey}`,
            };
          }
        }
      }
    }

    // 维度 3：路径越界（A-13 含 new_path）与空命令拦截
    for (const pathField of ['path', 'new_path', 'src', 'dst', 'dir']) {
      if (args[pathField] !== undefined && isPathOutsideSafeBoundary(args[pathField])) {
        return {
          allowed: false,
          code: 'PATH_OUTSIDE_JAIL',
          riskLevel: risk,
          message: `路径参数 [${pathField}=${args[pathField]}] 越过安全沙盒边界（禁止目录穿越或访问系统核心目录）`,
        };
      }
    }
    if (
      (canonical === 'run_command' ||
        canonical === 'run_powershell' ||
        canonical === 'run_admin_command') &&
      args.cmd !== undefined &&
      String(args.cmd).trim() === ''
    ) {
      return {
        allowed: false,
        code: 'MISSING_REQUIRED',
        riskLevel: risk,
        message: `高危命令工具 [${canonical}] 的 cmd 参数不能为空白字符串`,
      };
    }

    // 维度 4：破坏性工具 + 未分类外部工具（UNCLASSIFIED_EXTERNAL）默认 fail-closed 要求确认
    if (
      (risk === ToolRiskLevel.DESTRUCTIVE || risk === ToolRiskLevel.UNCLASSIFIED_EXTERNAL) &&
      !confirmed
    ) {
      return {
        allowed: false,
        requiresConfirmation: true,
        code: 'CONFIRM_REQUIRED',
        riskLevel: risk,
        message: `高危或未分类外部工具 [${canonical}] 必须经人工确认后方可执行`,
      };
    }

    // 维度 5：短窗口写操作幂等去重（**只检查，不登记**）
    // 登记发生在 recordSuccessfulWrite()，即工具真的写成功之后 —— 否则一次失败
    // （路径不存在 / 权限拒绝）会把 5s 内的合法重试全部误拦成重复写。
    if (IDEMPOTENT_DEDUP_TARGETS.has(canonical) && this.idempotencyWindowMs > 0) {
      const now = Date.now();
      const sig = this._buildWriteSignature(canonical, args, sessionId);
      const existingExp = this._recentWrites.get(sig);
      if (existingExp && existingExp > now) {
        return {
          allowed: false,
          code: 'DUPLICATE_IDEMPOTENT_WRITE',
          riskLevel: risk,
          message: `检测到 ${this.idempotencyWindowMs}ms 内的重复已成功写操作 [${canonical}]，已自动幂等去重拦截`,
        };
      }
    }

    return {
      allowed: true,
      riskLevel: risk,
      canonicalName: canonical,
    };
  }

  /**
   * 契约红线 4：外部非受信任数据溯源隔离包裹与提示词注入中和
   * @param {string} sourceLabel
   * @param {string} rawText
   * @returns {string}
   */
  wrapUntrustedProvenance(sourceLabel, rawText) {
    const safeSource = String(sourceLabel || 'external').replace(/[<>"'&]/g, '_');
    let sanitized = String(rawText ?? '');
    for (const pattern of PROMPT_INJECTION_PATTERNS) {
      sanitized = sanitized.replace(pattern, '[REDACTED_INJECTION_DIRECTIVE]');
    }
    return `<untrusted_data source="${safeSource}">\n${sanitized}\n</untrusted_data>`;
  }
}

/**
 * 模块级持久化单例（A-04：使跨请求写幂等窗口在生产环境真实生效）
 */
let _sharedGuardrailEngine = null;
export function getSharedGuardrailEngine() {
  if (!_sharedGuardrailEngine) {
    _sharedGuardrailEngine = new NodeExecutionGuardrailEngine({
      readOnlyMode: false,
      idempotencyWindowMs: 5000,
    });
  }
  return _sharedGuardrailEngine;
}
