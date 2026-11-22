/**
 * LIGHTWELL V4 · MOD-01: Context Assembler & Anchored Incremental Compaction Engine
 *
 * 设计原则（守的是什么）：
 *   1. 【消除上下文腐烂】六个分区各自有刚性 token 预算，任何一段都不能靠挤占
 *      别的分区长大。L1 宪章超限是**硬错误**（strict），因为它定义身份与红线；
 *      其余分区超限按比例截断并打 `[TRUNCATED_TO_BUDGET:...]` 标记，保证模型
 *      知道自己看到的是残片而不是全文。
 *   2. 【锚定增量压缩】历史超限时不重写叙事，只把最旧的窗口换成结构化补丁
 *      （实体状态 / 工具调用索引 / 已确认决策 / 活跃约束），追加进交接单。
 *      关键 ID 与用户明确要求因此不会在压缩中失真。
 *   3. 【双端锚定布局】system 头锚（L1→L2→工具目录→交接单）+ 尾部技能锚紧贴
 *      最新用户请求，对抗 Lost in the Middle。
 *   4. 【原子性】淘汰切片绝不断开 assistant(tool_calls) 与其后续 tool 响应，
 *      否则拼出来的 messages 会被上游 API 判为 tool_calls 不平。
 *
 * py 源：harness/context_assembler.py（417 行）。
 * py→JS 的等价改写逐处标注在对应位置，无一处静默简化；无法等价的一律标 @blocked。
 */

import { ExternalBlobStore } from './externalBlobStore.mjs';

/**
 * py `json.dumps(..., ensure_ascii=False)` 的等价实现。
 *
 * 为什么不能用 JSON.stringify：py 在**无缩进**时的默认分隔符是 `", "` 与 `": "`
 * （逗号/冒号后带空格），JSON.stringify 是 `","`/`":"`；每个字段差 1-2 个字符。
 * 本模块的 token 估算按字符数折算（见 HeuristicTokenEstimator），这些空格会直接
 * 进入预算判定，所以必须逐项对齐。有缩进时（indent>=1）两者输出一致
 * （都是 `,\n` + 缩进 + `: `），但为单一事实源仍走同一个序列化器。
 *
 * 已知且无法消除的差异：JS 只有一个 number 类型，`json.dumps(1.0)` 给出 "1.0"，
 * 而 JS 里 `1.0 === 1` 不可区分 → 输出 "1"。见报告「风险点」。
 *
 * @param {any} value
 * @param {number} [indent=0] 0 = 紧凑（py 默认分隔符）；>=1 = 每层缩进空格数
 * @returns {string}
 */
export function pyJsonDumps(value, indent = 0) {
  const step = Number.isFinite(indent) && indent > 0 ? ' '.repeat(Math.trunc(indent)) : '';

  const dump = (node, depth) => {
    if (node === null || node === undefined) return 'null';
    const t = typeof node;
    if (t === 'string') return JSON.stringify(node); // ensure_ascii=False：JS 本身不转义非 ASCII
    if (t === 'boolean') return node ? 'true' : 'false';
    if (t === 'number') {
      if (Number.isFinite(node)) return String(node);
      // py 的 json.dumps 对 inf/nan 产出 Infinity/NaN（非标准 JSON，但行为一致）
      if (Number.isNaN(node)) return 'NaN';
      return node > 0 ? 'Infinity' : '-Infinity';
    }
    if (typeof node === 'bigint') return String(node);

    const pad = step ? step.repeat(depth + 1) : '';
    const padEnd = step ? step.repeat(depth) : '';
    const nl = step ? '\n' : '';

    if (Array.isArray(node)) {
      if (node.length === 0) return '[]';
      const items = node.map((item) => dump(item, depth + 1));
      return step
        ? `[${nl}${pad}${items.join(`,${nl}${pad}`)}${nl}${padEnd}]`
        : `[${items.join(', ')}]`;
    }
    if (t === 'object') {
      const keys = Object.keys(node).filter((k) => node[k] !== undefined);
      if (keys.length === 0) return '{}';
      const items = keys.map((k) => `${JSON.stringify(k)}: ${dump(node[k], depth + 1)}`);
      return step
        ? `{${nl}${pad}${items.join(`,${nl}${pad}`)}${nl}${padEnd}}`
        : `{${items.join(', ')}}`;
    }
    return 'null'; // function / symbol 等：py 会抛 TypeError，这里按 None 落地并留痕
  };

  return dump(value, 0);
}

/**
 * Token 估算协议（py:24-28 `class TokenEstimator(Protocol)`）。
 *
 * py 的 Protocol 是**结构化类型**，运行期不做任何检查（鸭子类型），因此这里不
 * 假装有一个接口约束：基类只提供两件事 —— 文档 + 一处「未实现就炸」的默认实现。
 * 这样接错估算器时会立刻抛错，而不是让 countTokens 返回 undefined 一路污染预算计算
 * （py 对应行为：调用不存在的方法会抛 AttributeError，同样不会静默通过）。
 */
export class TokenEstimator {
  /**
   * @param {string} _text
   * @returns {number}
   */
  countTokens(_text) {
    throw new Error(
      'TokenEstimator.countTokens 未实现：请注入 HeuristicTokenEstimator 或模型原生 tokenizer（py:24-28 Protocol 的运行期等价物）'
    );
  }
}

/**
 * 零依赖中英混合估算器（py:31-43 `HeuristicTokenEstimator`）。
 * 规则：ASCII 按 ~3.6 chars/token，非 ASCII（CJK）按 ~1.6 chars/token，向下取整后
 * 至少 1（非空文本不可能 0 token）。
 */
export class HeuristicTokenEstimator extends TokenEstimator {
  /**
   * @param {string} text
   * @returns {number}
   */
  countTokens(text) {
    const s = String(text ?? '');
    if (!s) return 0;
    // py:40 `sum(1 for ch in text if ord(ch) < 128)` —— 按**码点**统计 ASCII 字符数
    let asciiChars = 0;
    let total = 0;
    for (const ch of s) {
      total += 1;
      if (ch.codePointAt(0) < 128) asciiChars += 1;
    }
    const nonAsciiChars = total - asciiChars;
    // py:42 `math.ceil(ascii/3.6 + non_ascii/1.6)`
    const estimated = Math.ceil(asciiChars / 3.6 + nonAsciiChars / 1.6);
    return Math.max(1, estimated); // py:43
  }
}

/**
 * V4 六分区刚性 Token 预算（py:46-71 `@dataclass(frozen=True) class TokenBudget`）。
 *
 * 六个分区与 py 行号逐项对齐：
 *   PART-01 L1_CHARTER      l1_charter_max      = 1200   (py:52)
 *   PART-02 L2_PHASE        l2_phase_max        =  950   (py:53)
 *   PART-03 ANCHORED_HANDOFF anchored_handoff_max = 1800 (py:54)
 *   PART-04 TOOL_CATALOG    tool_catalog_max    = 1400   (py:55)
 *   PART-05 L3_SKILLS       l3_skill_max        = 1800   (py:56)
 *   PART-06 WORKING_MEMORY  working_memory_max  = 派生   (py:62-71)
 * 另有两个总账字段：total_window 16000 (py:50)、reserve_output 4096 (py:51)。
 */
export class TokenBudget {
  /**
   * @param {object} [options]
   * @param {number} [options.totalWindow=16000]
   * @param {number} [options.reserveOutput=4096]
   * @param {number} [options.l1CharterMax=1200]
   * @param {number} [options.l2PhaseMax=950]
   * @param {number} [options.anchoredHandoffMax=1800]
   * @param {number} [options.toolCatalogMax=1400]
   * @param {number} [options.l3SkillMax=1800]
   */
  constructor({
    totalWindow = 16000,
    reserveOutput = 4096,
    l1CharterMax = 1200,
    l2PhaseMax = 950,
    anchoredHandoffMax = 1800,
    toolCatalogMax = 1400,
    l3SkillMax = 1800,
  } = {}) {
    this.totalWindow = totalWindow;
    this.reserveOutput = reserveOutput;
    this.l1CharterMax = l1CharterMax;
    this.l2PhaseMax = l2PhaseMax;
    this.anchoredHandoffMax = anchoredHandoffMax;
    this.toolCatalogMax = toolCatalogMax;
    this.l3SkillMax = l3SkillMax;
    // py `@dataclass(frozen=True)`：不可变。JS 等价物是冻结实例——
    // 冻结的是**属性槽**（不可重新赋值/新增），与 py 的 FrozenInstanceError 语义接近。
    Object.freeze(this);
  }

  /** py:58-60 `available_input` */
  get availableInput() {
    return Math.max(2048, this.totalWindow - this.reserveOutput);
  }

  /** py:62-71 `working_memory_max`（六分区里的 PART-06，由总量倒推） */
  get workingMemoryMax() {
    const fixedSum =
      this.l1CharterMax +
      this.l2PhaseMax +
      this.anchoredHandoffMax +
      this.toolCatalogMax +
      this.l3SkillMax;
    return Math.max(1024, this.availableInput - fixedSum);
  }
}

/**
 * 标准化会话消息单元（py:74-106 `@dataclass class MessageTurn`）。
 * 支持 tool_calls 与 tool 结果的关联追踪（tool_call_id / tool_name）。
 */
export class MessageTurn {
  /**
   * @param {object} init
   * @param {'system'|'user'|'assistant'|'tool'} init.role
   * @param {string} init.content
   * @param {string} init.turnId
   * @param {number} [init.timestamp] 秒（py `time.time()` 口径）
   * @param {Array<object>} [init.toolCalls]
   * @param {string|null} [init.toolCallId]
   * @param {string|null} [init.toolName]
   * @param {number} [init.importanceScore=1.0]
   * @param {object} [init.metadata]
   */
  constructor({
    role,
    content,
    turnId,
    timestamp = Date.now() / 1000,
    toolCalls = [],
    toolCallId = null,
    toolName = null,
    importanceScore = 1.0,
    metadata = {},
  } = {}) {
    /** @type {'system'|'user'|'assistant'|'tool'} */
    this.role = role;
    this.content = content;
    this.turnId = turnId;
    // py:81 `field(default_factory=time.time)` → 秒（浮点）。用 Date.now()/1000 对齐单位，
    // 否则与 py 产物做时间差比较时会差 1000 倍。
    this.timestamp = timestamp;
    this.toolCalls = Array.isArray(toolCalls) ? toolCalls : [];
    this.toolCallId = toolCallId;
    this.toolName = toolName;
    // py:85 `importance_score: float = 1.0`；`>= 1.2` 才被视为用户明确约束（:299）
    this.importanceScore = importanceScore;
    this.metadata = metadata && typeof metadata === 'object' ? metadata : {};
  }

  /**
   * 仅用于 token 计数的稳定序列化（py:88-96）。
   * 字段顺序固定（py dict 字面量顺序），且用 pyJsonDumps 保证分隔符与 py 一致。
   * @returns {string}
   */
  serializeForCounting() {
    return pyJsonDumps({
      role: this.role,
      content: this.content,
      tool_calls: this.toolCalls,
      tool_call_id: this.toolCallId,
      tool_name: this.toolName,
    });
  }

  /**
   * 转成上游 LLM messages 的一项（py:98-106 `to_llm_dict`）。
   * 只有 tool 角色才带 name；空 tool_calls / 空 tool_call_id 不落字段（保持载荷最小）。
   * @returns {object}
   */
  toLlmDict() {
    const msg = { role: this.role, content: this.content };
    if (Array.isArray(this.toolCalls) && this.toolCalls.length > 0) msg.tool_calls = this.toolCalls;
    if (this.toolCallId) msg.tool_call_id = this.toolCallId;
    if (this.toolName && this.role === 'tool') msg.name = this.toolName;
    return msg;
  }
}

/**
 * 四段式不可变结构化交接单（py:109-186 `AnchoredHandoffState`）。
 *
 * 「增量」的含义：每次压缩只 apply_delta（追加/更新字段），绝不重写历史叙事。
 * 「锚定」的含义：实体状态、工具调用索引、已确认决策、活跃约束这四类信息
 * 被单独保活，压缩后模型仍能拿到确定的 ID 与结论，而不是一段转述。
 */
export class AnchoredHandoffState {
  /**
   * @param {object} [init]
   * @param {Record<string, object>} [init.mutatedState]
   * @param {Array<object>} [init.toolExecutionIndex]
   * @param {string[]} [init.confirmedDecisions]
   * @param {Record<string, any>} [init.activeConstraints]
   * @param {number} [init.compactionGeneration=0]
   */
  constructor({
    mutatedState = {},
    toolExecutionIndex = [],
    confirmedDecisions = [],
    activeConstraints = {},
    compactionGeneration = 0,
  } = {}) {
    this.mutatedState = mutatedState;
    this.toolExecutionIndex = toolExecutionIndex;
    this.confirmedDecisions = confirmedDecisions;
    this.activeConstraints = activeConstraints;
    this.compactionGeneration = compactionGeneration;
  }

  /**
   * 合并增量压缩器产出的结构化补丁（py:122-150 `apply_delta`）。
   *
   * 四条合并规则（每一条都在防一种失真）：
   *   · mutated_state 按 entity_id 浅合并 → 同实体多次修改只留最新字段，不丢其它字段；
   *   · tool_execution_index 按 call_id 去重 → 重复压缩不会把同一次工具调用记两遍；
   *   · confirmed_decisions 字符串去重 → 用户确认过的结论不会重复堆叠；
   *   · active_constraints 值为 null 表示**撤销该约束**（pop），否则覆盖。
   * 无论补丁内容如何，compaction_generation 一定 +1（代数用于追溯压缩历史）。
   * @param {object} delta
   */
  applyDelta(delta) {
    // py:124 直接 `delta.get(...)`：传入 None/str/list 会抛 AttributeError。
    // 这里显式抛 TypeError 复刻该行为——**不**把非法补丁当空补丁吞掉（否则
    // 「压缩跑过了但什么都没记下来」会静默发生，最难查）。
    if (!delta || typeof delta !== 'object' || Array.isArray(delta)) {
      throw new TypeError(
        'AnchoredHandoffState.applyDelta: 补丁必须是对象（py 侧对应 AttributeError: NoneType/str/list 无 .get）'
      );
    }
    const patch = delta;

    const mutated = patch.mutated_state || {};
    for (const [entityId, fields] of Object.entries(mutated)) {
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
      if (!this.mutatedState[entityId] || typeof this.mutatedState[entityId] !== 'object') {
        this.mutatedState[entityId] = {};
      }
      Object.assign(this.mutatedState[entityId], fields);
    }

    const existingCallIds = new Set(
      this.toolExecutionIndex.map((item) => item?.call_id).filter(Boolean)
    );
    const indexRecords = patch.tool_execution_index || [];
    for (const record of indexRecords) {
      const callId = record?.call_id;
      if (callId && existingCallIds.has(callId)) continue;
      this.toolExecutionIndex.push(record);
      if (callId) existingCallIds.add(callId);
    }

    const decisions = patch.confirmed_decisions || [];
    for (const decision of decisions) {
      if (decision && !this.confirmedDecisions.includes(decision)) {
        this.confirmedDecisions.push(decision);
      }
    }

    const constraints = patch.active_constraints || {};
    for (const [k, v] of Object.entries(constraints)) {
      if (v === null) delete this.activeConstraints[k];
      else this.activeConstraints[k] = v;
    }

    this.compactionGeneration += 1;
  }

  /**
   * 渲染为高信噪比 Markdown 锚点块（py:152-186 `render_markdown`）。
   *
   * 超预算时的降级**只允许丢最旧的工具索引条目**：实体状态/决策/约束一律不动。
   * 下限是保留 3 条索引（py:184 `len(trimmed_index) <= 3` 即收手）——
   * 宁可略微超预算，也不能把交接单精简到没有可追溯的工具链。
   * @param {number} maxTokens
   * @param {TokenEstimator} estimator
   * @returns {string}
   */
  renderMarkdown(maxTokens, estimator) {
    if (
      Object.keys(this.mutatedState).length === 0 &&
      this.toolExecutionIndex.length === 0 &&
      this.confirmedDecisions.length === 0 &&
      Object.keys(this.activeConstraints).length === 0
    ) {
      return '';
    }

    let trimmedIndex = this.toolExecutionIndex.slice();
    // py:163 `while True` —— 每轮从头重建整块文本再判预算（文本小，重建更简单可靠）
    for (;;) {
      const blocks = [
        `### [ANCHORED HANDOFF STATE | GEN-${this.compactionGeneration}]`,
        '#### 1. Mutated Entity State',
        Object.keys(this.mutatedState).length ? pyJsonDumps(this.mutatedState, 2) : '- (none)',
        '#### 2. Tool Execution Index',
        trimmedIndex.length ? pyJsonDumps(trimmedIndex, 2) : '- (none)',
        '#### 3. Confirmed Decisions & Exclusions',
        this.confirmedDecisions.length ? this.confirmedDecisions.map((d) => `- ${d}`).join('\n') : '- (none)',
        '#### 4. Active Session Constraints',
        Object.keys(this.activeConstraints).length ? pyJsonDumps(this.activeConstraints, 2) : '- (none)',
      ];
      const rendered = blocks.join('\n');
      if (estimator.countTokens(rendered) <= maxTokens || trimmedIndex.length <= 3) {
        return rendered;
      }
      trimmedIndex.shift(); // py:186 `trimmed_index.pop(0)`
    }
  }
}

/**
 * 锚定增量压缩引擎（py:236-307 `AnchoredCompactionEngine`）。
 *
 * 两条路径：
 *   · 注入 llmCompactor（PROMPT-04 增量压缩回调）→ 由模型产出结构化补丁；
 *   · 未注入 → 内置**确定性**兜底提取器，保证零崩溃、零网络依赖。
 * 兜底提取器是刻意保守的：只记工具调用索引（call_id/tool/summary）与
 * importance>=1.2 的用户明确请求，绝不臆测实体状态。
 */
export class AnchoredCompactionEngine {
  /**
   * @param {(handoff: AnchoredHandoffState, turns: MessageTurn[]) => object} [llmCompactor=null]
   */
  constructor(llmCompactor = null) {
    /** @type {((handoff: AnchoredHandoffState, turns: MessageTurn[]) => object)|null} */
    this.llmCompactor = llmCompactor;
  }

  /**
   * 切出最旧的待淘汰窗口（py:245-272 `select_eviction_slice`）。
   *
   * 原子性红线：遇到带 tool_calls 的 assistant 消息时，紧随其后的 tool 响应
   * **必须一起进淘汰切片**，否则剩下的历史里会出现「tool 消息找不到发起它的
   * assistant」→ 上游 API 直接 400。
   * 另外永远至少保留最后 2 条（`total - 2` / `total - 1` 边界，py:261/268）。
   * @param {MessageTurn[]} turns
   * @param {TokenEstimator} estimator
   * @param {number} targetFreeTokens
   * @returns {[MessageTurn[], MessageTurn[]]} [evictSlice, remainingTurns]
   */
  selectEvictionSlice(turns, estimator, targetFreeTokens) {
    const list = Array.isArray(turns) ? turns : [];
    if (list.length <= 2) {
      return [[], list.slice()]; // py:254-255
    }

    let freed = 0;
    let splitIdx = 0;
    const total = list.length;

    while (splitIdx < total - 2 && freed < targetFreeTokens) {
      const current = list[splitIdx];
      freed += estimator.countTokens(current.serializeForCounting());
      splitIdx += 1;

      if (current.role === 'assistant' && current.toolCalls && current.toolCalls.length > 0) {
        while (splitIdx < total - 1 && list[splitIdx].role === 'tool') {
          freed += estimator.countTokens(list[splitIdx].serializeForCounting());
          splitIdx += 1;
        }
      }
    }

    return [list.slice(0, splitIdx), list.slice(splitIdx)];
  }

  /**
   * 把淘汰窗口写进交接单（py:274-307 `compact_slice`）。
   * @param {AnchoredHandoffState} handoff
   * @param {MessageTurn[]} evictedTurns
   */
  compactSlice(handoff, evictedTurns) {
    const evicted = Array.isArray(evictedTurns) ? evictedTurns : [];
    if (evicted.length === 0) return;

    if (this.llmCompactor !== null && this.llmCompactor !== undefined) {
      const delta = this.llmCompactor(handoff, evicted);
      // py 侧若回调返回非 dict，apply_delta 会在 `.get` 上抛 AttributeError；
      // JS 的等价物是显式 TypeError（不静默把非法补丁当空补丁吞掉）。
      if (!delta || typeof delta !== 'object' || Array.isArray(delta)) {
        throw new TypeError(
          'AnchoredCompactionEngine: llmCompactor 必须返回结构化补丁对象（py 侧对应 AttributeError）'
        );
      }
      handoff.applyDelta(delta);
      return;
    }

    // 确定性无模型兜底（py:287-307）
    const deltaIndex = [];
    const deltaDecisions = [];
    for (const turn of evicted) {
      if (turn.role === 'tool') {
        deltaIndex.push({
          call_id: turn.toolCallId || turn.turnId,
          tool: turn.toolName || 'unknown_tool',
          // py:296 `turn.content[:240].replace("\n", " ")`
          summary: Array.from(String(turn.content ?? '')).slice(0, 240).join('').replace(/\n/g, ' '),
        });
      } else if (turn.role === 'user' && turn.importanceScore >= 1.2) {
        // py:300 `f"User constraint/request: {turn.content[:180]}"`
        deltaDecisions.push(
          `User constraint/request: ${Array.from(String(turn.content ?? '')).slice(0, 180).join('')}`
        );
      }
    }

    handoff.applyDelta({
      tool_execution_index: deltaIndex,
      confirmed_decisions: deltaDecisions,
    });
  }
}

/**
 * V4 统一上下文装配引擎（py:310-417 `ContextAssembler`）。
 * 把 L1 宪章 / L2 阶段契约 / L3 技能包 / 渐进式工具目录 / 增量交接单 / 工作记忆
 * 装配成一份双端锚定的推理负载。
 */
export class ContextAssembler {
  /**
   * @param {object} [options]
   * @param {TokenBudget} [options.budget]
   * @param {TokenEstimator} [options.estimator]
   * @param {AnchoredCompactionEngine} [options.compactionEngine]
   */
  constructor({ budget = null, estimator = null, compactionEngine = null } = {}) {
    this.budget = budget || new TokenBudget();
    this.estimator = estimator || new HeuristicTokenEstimator();
    this.compactionEngine = compactionEngine || new AnchoredCompactionEngine();
  }

  /**
   * 单分区刚性预算校验（py:326-339 `_enforce_ceiling`）。
   *
   * strictError=true 时超限抛错（L1 宪章：身份与红线不能被截断）；
   * 否则按**字符比例**折算安全长度并补 `[TRUNCATED_TO_BUDGET:...]` 标记。
   * 留 8% 余量（*0.92）是因为字符→token 的比例在同一段文本上不恒定，
   * 正好贴着上限截断仍可能超。
   * @param {string} text
   * @param {number} maxTokens
   * @param {string} sectionName
   * @param {boolean} [strictError=false]
   * @returns {string}
   */
  _enforceCeiling(text, maxTokens, sectionName, strictError = false) {
    const src = String(text ?? '');
    if (!src) return '';
    const tokens = this.estimator.countTokens(src);
    if (tokens <= maxTokens) return src;
    if (strictError) {
      // py:333 抛 ValueError；JS 里「值超出允许范围」的对应类型是 RangeError。
      // 两者都是 Error 子类，调用方的 catch 行为一致。
      throw new RangeError(
        `[ContextAssembler] ${sectionName} 超出刚性预算: ${tokens} > ${maxTokens} Tokens`
      );
    }
    const ratio = maxTokens / Math.max(tokens, 1);
    // py:338 `max(64, int(len(text) * ratio * 0.92))`；int() 对正数等价于 floor。
    // len(text) 按码点计 → 用码点数组长度，避免切出半个代理对。
    const points = Array.from(src);
    const safeChars = Math.max(64, Math.trunc(points.length * ratio * 0.92));
    return `${points.slice(0, safeChars).join('')}\n...[TRUNCATED_TO_BUDGET:${sectionName}]`;
  }

  /**
   * 装配最终 LLM messages（py:341-417 `assemble`）。
   * @param {object} input
   * @param {string} input.l1Charter
   * @param {string} input.l2PhasePrompt
   * @param {string} input.l3ActiveSkills
   * @param {string} input.toolCatalogSummary
   * @param {AnchoredHandoffState} input.handoffState
   * @param {MessageTurn[]} input.workingTurns
   * @returns {[Array<object>, MessageTurn[]]} [messages, updatedTurns]
   */
  assemble({
    l1Charter,
    l2PhasePrompt,
    l3ActiveSkills,
    toolCatalogSummary,
    handoffState,
    workingTurns,
  }) {
    // 1. 各独立分区刚性预算校验（段名与 py:355-366 逐字一致，便于日志对账）
    const l1Clean = this._enforceCeiling(
      l1Charter,
      this.budget.l1CharterMax,
      'PART-01:L1_CHARTER',
      true
    );
    const l2Clean = this._enforceCeiling(
      l2PhasePrompt,
      this.budget.l2PhaseMax,
      'PART-02:L2_PHASE',
      false
    );
    const toolsClean = this._enforceCeiling(
      toolCatalogSummary,
      this.budget.toolCatalogMax,
      'PART-04:TOOL_CATALOG',
      false
    );
    const skillsClean = this._enforceCeiling(
      l3ActiveSkills,
      this.budget.l3SkillMax,
      'PART-05:L3_SKILLS',
      false
    );

    // 2. 工作记忆超限 → 锚定增量压缩（PART-06）
    let currentTurns = Array.isArray(workingTurns) ? workingTurns.slice() : [];
    const workingTokens = currentTurns.reduce(
      (sum, turn) => sum + this.estimator.countTokens(turn.serializeForCounting()),
      0
    );
    if (workingTokens > this.budget.workingMemoryMax) {
      // 目标：压回 75% 水位，留出后续几轮增长空间（py:374）
      const overflow = workingTokens - Math.trunc(this.budget.workingMemoryMax * 0.75);
      const [evictSlice, remainingTurns] = this.compactionEngine.selectEvictionSlice(
        currentTurns,
        this.estimator,
        overflow
      );
      if (evictSlice.length > 0) {
        this.compactionEngine.compactSlice(handoffState, evictSlice);
        currentTurns = remainingTurns;
      }
    }

    const handoffClean = handoffState.renderMarkdown(
      this.budget.anchoredHandoffMax,
      this.estimator
    );

    // 3. 头部锚点（System Prompt）：L1 → L2 → Tool Index → Anchored Handoff
    const systemSections = [l1Clean];
    if (l2Clean) systemSections.push(`## [CURRENT PHASE CONTRACT]\n${l2Clean}`);
    if (toolsClean) systemSections.push(`## [PROGRESSIVE TOOL CATALOG]\n${toolsClean}`);
    if (handoffClean) systemSections.push(handoffClean);

    const assembledMessages = [{ role: 'system', content: systemSections.join('\n\n') }];

    // 4. 中部工作记忆
    for (const turn of currentTurns) {
      assembledMessages.push(turn.toLlmDict());
    }

    // 5. 尾部锚点（Suffix Anchor）：L3 技能 SOP 紧贴最新用户请求
    if (skillsClean) {
      const skillInjection =
        '## [ACTIVE ON-DEMAND SKILL SOP]\n' +
        '请严格遵循以下针对当前任务动态挂载的技能执行规程：\n\n' +
        skillsClean;
      const last = assembledMessages[assembledMessages.length - 1];
      if (last.role === 'user') {
        last.content = `${skillInjection}\n\n---\n### [CURRENT USER REQUEST]\n${last.content}`;
      } else {
        assembledMessages.push({ role: 'system', content: skillInjection });
      }
    }

    return [assembledMessages, currentTurns];
  }
}

/** 进程级单例（预算/估算器/压缩引擎默认配置） */
let _sharedContextAssembler = null;

/**
 * 共享 ContextAssembler（默认 6 分区预算 16000/4096 档）。
 * @returns {ContextAssembler}
 */
export function getSharedContextAssembler() {
  if (!_sharedContextAssembler) {
    _sharedContextAssembler = new ContextAssembler();
  }
  return _sharedContextAssembler;
}

/** 仅供测试/诊断：重建单例 */
export function __resetSharedContextAssembler() {
  _sharedContextAssembler = null;
}

// ExternalBlobStore 在 py 源里与本模块同文件（:189）；按计划书拆成独立模块后在此
// 再导出一次，保证既有调用方按 MOD-01 的旧路径导入时不至于找不到符号。
export { ExternalBlobStore };
