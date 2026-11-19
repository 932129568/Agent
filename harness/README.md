# harness/ · LIGHTWELL V4 三层 Harness 引擎

> 《报告-补充.md》§4 六个模块的**逐字节落地**（1,557 行，与报告原文 `diff = 0`）。
> 来源文档：`deliverables/design/v4-harness/V4-执行记录.md`（落地实证）、`V4-虚构核查清单.md`（10 条偏差）。

## 环境

- Python **3.11+**（本机实测 3.13.14）
- **零第三方依赖**：仅 `hashlib / json / math / re / time / asyncio / dataclasses / enum / pathlib / typing`
- 不需要 pip install，不需要 pydantic，不需要 yaml（frontmatter 由 `parse_simple_yaml_frontmatter()` 手写解析）

## 跑测试

```bash
node -e ""  # 无关
python -m pytest tests/harness -q
```

## 六模块职责

| 模块 | 层 | 职责 | 关键类 |
|---|---|---|---|
| `context_assembler.py` | Information | 6 分区 Token 预算、双端锚定装配、锚定增量压缩、大对象落盘 | `ContextAssembler` / `TokenBudget` / `AnchoredHandoffState` / `ExternalBlobStore` / `AnchoredCompactionEngine` |
| `instruction_loader.py` | Information | L1 宪章校验、L2 阶段渲染、L3 `SKILL.md` 按需路由与 TTL 卸载 | `InstructionHierarchyLoader` / `SkillMetadata` / `PhaseTemplate` |
| `tool_registry.py` | Information | 渐进式工具披露：L0 轻量目录 → L1 元工具检索 → L2 动态挂载 + LRU 回收 | `ProgressiveToolRegistry` / `ToolSpec` / `ToolRiskLevel` |
| `execution_guardrails.py` | Execution | 飞行前确定性拦截（Schema/权限/前置依赖/幂等）、状态机、检查点持久化 | `ExecutionGuardrailEngine` / `PreFlightHookChain` / `WorkflowStateMachine` / `CheckpointStore` |
| `feedback_immune.py` | Feedback | 输出强校验、错误→自愈提示翻译、上下文污染过滤、审计留痕 | `OutputVerificationGate` / `ErrorToHintTranslator` / `ContextPoisoningFilter` |
| `subagent_orchestrator.py` | Orchestration | 隔离上下文子代理调度与结构化汇总 | `SubAgentOrchestrator` |

## ⚠️ 接入前必读（两条，否则会造第二套真相）

### 1. 与 `server/src/services/provider.js` 的关系

本包的 `ProgressiveToolRegistry` 是**完整版参考实现**。但生产链（Node）**已经有**：

- `MCP_FOLD_THRESHOLD = 25` + `mcp_search` 元工具（`provider.js:341-356`）
- `browser_snapshot` 的 `@eN` 稳定引用索引（省 token）
- `memory_search` 检索式只读工具

接入前必须**先与这些既有机制合并**，否则会出现两套渐进披露、两个真相。

### 2. 本包目前没有调用方

项目 R70 起 Python 契约层已退役（`main.py` 是明确 stub），运行时是 Electron + Node。本包当前状态是**可运行、可测试、但不可达**——没有生产代码 import 它。

要真正生效，需先决定：
- **A** 留作架构参考实现（零风险）
- **B** 移植为 JS，接管 `provider.js:271-373` 的 `buildTools()`（动生产链，需单独一轮）
- **C** 只移植 `MOD-03`（工具注册表）+ `MOD-04`（前置拦截）两个真正对应可改点的模块
