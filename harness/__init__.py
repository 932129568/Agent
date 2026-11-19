"""LIGHTWELL V4 · 三层 Harness 引擎（MOD-01 ~ MOD-06）。

本包为《报告-补充.md》§4 六个模块的逐字节落地（1,557 行，与报告原文 diff = 0）。

分层对应：
    Information Layer  → context_assembler / instruction_loader / tool_registry
    Execution   Layer  → execution_guardrails
    Feedback    Layer  → feedback_immune
    Orchestration      → subagent_orchestrator

零第三方依赖（仅标准库）。导入即用：

    from harness import ContextAssembler, TokenBudget, ProgressiveToolRegistry

⚠️ 接入前置约束（见 qa/r87/V4-FABRICATION.md FAB-02 / FAB-08）：
    server/src/services/provider.js 已有 MCP 工具折叠（MCP_FOLD_THRESHOLD = 25 +
    mcp_search 元工具）与 browser_snapshot 的 @eN 稳定引用索引。本包是完整版参考实现，
    接入生产链前必须先与既有机制合并，避免出现两套渐进披露真相。
"""

from .context_assembler import (
    AnchoredCompactionEngine,
    AnchoredHandoffState,
    ContextAssembler,
    ExternalBlobStore,
    HeuristicTokenEstimator,
    MessageTurn,
    TokenBudget,
    TokenEstimator,
)
from .execution_guardrails import (
    CheckpointRecord,
    CheckpointStore,
    ExecutionGuardrailEngine,
    IdempotencyGuardHook,
    PermissionAndConfirmationHook,
    PreFlightContext,
    PreFlightDecision,
    PreFlightHook,
    SchemaValidationHook,
    StatePreconditionHook,
    WorkflowStateMachine,
)
from .feedback_immune import (
    AuditTraceRecorder,
    ContextPoisoningFilter,
    ErrorToHintTranslator,
    OutputVerificationGate,
    TurnTraceMetric,
    VerificationResult,
)
from .instruction_loader import (
    InstructionHierarchyLoader,
    PhaseTemplate,
    SkillMetadata,
    SkillPackage,
    parse_simple_yaml_frontmatter,
)
from .subagent_orchestrator import SubAgentOrchestrator, SubAgentResult, SubAgentTask
from .tool_registry import ProgressiveToolRegistry, ToolRiskLevel, ToolSpec

__all__ = [
    # MOD-01 Context Assembler
    "TokenEstimator",
    "HeuristicTokenEstimator",
    "TokenBudget",
    "MessageTurn",
    "AnchoredHandoffState",
    "ExternalBlobStore",
    "AnchoredCompactionEngine",
    "ContextAssembler",
    # MOD-02 Instruction Loader
    "SkillMetadata",
    "SkillPackage",
    "PhaseTemplate",
    "parse_simple_yaml_frontmatter",
    "InstructionHierarchyLoader",
    # MOD-03 Tool Registry
    "ToolRiskLevel",
    "ToolSpec",
    "ProgressiveToolRegistry",
    # MOD-04 Execution Guardrails
    "PreFlightContext",
    "PreFlightDecision",
    "PreFlightHook",
    "SchemaValidationHook",
    "PermissionAndConfirmationHook",
    "StatePreconditionHook",
    "IdempotencyGuardHook",
    "CheckpointRecord",
    "CheckpointStore",
    "WorkflowStateMachine",
    "ExecutionGuardrailEngine",
    # MOD-05 Feedback Immune
    "VerificationResult",
    "OutputVerificationGate",
    "ErrorToHintTranslator",
    "ContextPoisoningFilter",
    "TurnTraceMetric",
    "AuditTraceRecorder",
    # MOD-06 Sub-agent Orchestrator
    "SubAgentTask",
    "SubAgentResult",
    "SubAgentOrchestrator",
]
