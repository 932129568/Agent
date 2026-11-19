"""
LIGHTWELL V4 - MOD-04: Deterministic Execution Guardrails, State Machine & Checkpoint Store
职责：
1. 彻底替代旧版“Prompt 铁律”（RULE-01 ~ RULE-04），将所有格式、权限、前置依赖与防重校验下沉为确定性代码拦截。
2. 实现有限状态机（WorkflowStateMachine）管理业务阶段流转与准出检查。
3. 实现检查点持久化（CheckpointStore），支持断点恢复与审计回溯。
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Protocol

from .tool_registry import ProgressiveToolRegistry, ToolRiskLevel, ToolSpec


@dataclass
class PreFlightContext:
    """飞行前拦截器上下文快照。"""

    session_id: str
    actor_id: str
    tenant_id: str
    current_phase: str
    tool_spec: ToolSpec
    tool_args: dict[str, Any]
    completed_tools: list[str]
    confirmed_destructive_tokens: set[str]
    executed_idempotency_keys: set[str]


@dataclass
class PreFlightDecision:
    """拦截器判定结果。"""

    allowed: bool
    block_code: str = ""
    reason: str = ""
    recovery_hint: str = ""
    requires_human_confirmation: bool = False


class PreFlightHook(Protocol):
    """飞行前确定性拦截器协议。"""

    name: str

    def evaluate(self, ctx: PreFlightContext) -> PreFlightDecision:
        ...


class SchemaValidationHook:
    """
    替代 RULE-01（格式与字段约束铁律）：
    在工具执行前，依据 ToolSpec.parameters_schema 执行严格的必填项、类型与附加属性校验。
    """

    name = "schema_validation_hook"

    _TYPE_MAP: dict[str, tuple[type, ...]] = {
        "string": (str,),
        "integer": (int,),
        "number": (int, float),
        "boolean": (bool,),
        "array": (list,),
        "object": (dict,),
    }

    def evaluate(self, ctx: PreFlightContext) -> PreFlightDecision:
        schema = ctx.tool_spec.parameters_schema
        args = ctx.tool_args
        if not isinstance(args, dict):
            return PreFlightDecision(
                allowed=False,
                block_code="ERR_SCHEMA_NOT_OBJECT",
                reason="工具调用参数必须是 JSON Object 字典。",
                recovery_hint="请以键值对象形式重新构造工具入参。",
            )

        required_fields = schema.get("required", [])
        properties = schema.get("properties", {})

        for req in required_fields:
            if req not in args or args[req] is None:
                return PreFlightDecision(
                    allowed=False,
                    block_code="ERR_MISSING_REQUIRED_FIELD",
                    reason=f"缺少必填参数 `{req}`。",
                    recovery_hint=f"请补充参数 `{req}`（参考 schema: {json.dumps(properties.get(req, {}), ensure_ascii=False)}）。",
                )

        if schema.get("additionalProperties") is False:
            unknown_keys = [k for k in args if k not in properties]
            if unknown_keys:
                return PreFlightDecision(
                    allowed=False,
                    block_code="ERR_UNKNOWN_PROPERTIES",
                    reason=f"包含未定义的非法参数字段: {unknown_keys}。",
                    recovery_hint=f"仅允许传入以下合法字段: {list(properties.keys())}。",
                )

        for key, val in args.items():
            prop_def = properties.get(key)
            if not prop_def or val is None:
                continue
            expected_type = prop_def.get("type")
            if expected_type in self._TYPE_MAP:
                # Python 中 bool 是 int 子类，需显式排除
                if expected_type in ("integer", "number") and isinstance(val, bool):
                    return PreFlightDecision(
                        allowed=False,
                        block_code="ERR_TYPE_MISMATCH",
                        reason=f"字段 `{key}` 期望数值类型 `{expected_type}`，实际收到 boolean。",
                        recovery_hint=f"请将 `{key}` 修正为合法数值。",
                    )
                if not isinstance(val, self._TYPE_MAP[expected_type]):
                    return PreFlightDecision(
                        allowed=False,
                        block_code="ERR_TYPE_MISMATCH",
                        reason=f"字段 `{key}` 类型不匹配，期望 `{expected_type}`，实际为 `{type(val).__name__}`。",
                        recovery_hint=f"请将 `{key}` 转换为 `{expected_type}` 类型后重试。",
                    )
            enum_vals = prop_def.get("enum")
            if enum_vals is not None and val not in enum_vals:
                return PreFlightDecision(
                    allowed=False,
                    block_code="ERR_ENUM_VIOLATION",
                    reason=f"字段 `{key}` 的值 `{val}` 不在允许枚举集合 {enum_vals} 内。",
                    recovery_hint=f"请从 {enum_vals} 中选择合法枚举值。",
                )

        return PreFlightDecision(allowed=True)


class PermissionAndConfirmationHook:
    """
    替代 RULE-02（安全边界与越权/高危操作拦截铁律）：
    1. 强制校验租户隔离字段（若参数含 tenant_id 必须与当前会话 tenant_id 一致）；
    2. 对 DESTRUCTIVE_WRITE 高危工具要求具备显式人工确认令牌。
    """

    name = "permission_and_confirmation_hook"

    def evaluate(self, ctx: PreFlightContext) -> PreFlightDecision:
        arg_tenant = ctx.tool_args.get("tenant_id")
        if arg_tenant is not None and str(arg_tenant) != str(ctx.tenant_id):
            return PreFlightDecision(
                allowed=False,
                block_code="ERR_TENANT_ISOLATION_VIOLATION",
                reason=f"越权拦截：尝试访问租户 `{arg_tenant}`，当前会话仅授权租户 `{ctx.tenant_id}`。",
                recovery_hint="请勿跨租户访问资源，仅使用当前授权上下文中的资源标识符。",
            )

        if ctx.tool_spec.risk_level == ToolRiskLevel.DESTRUCTIVE_WRITE:
            action_sig = self.compute_action_signature(ctx.tool_spec.name, ctx.tool_args)
            if action_sig not in ctx.confirmed_destructive_tokens:
                return PreFlightDecision(
                    allowed=False,
                    block_code="ERR_HUMAN_CONFIRMATION_REQUIRED",
                    reason=f"高危写操作 `{ctx.tool_spec.name}` 尚未获得用户显式二次确认。",
                    recovery_hint=(
                        "请向用户清晰展示即将执行的变更内容、影响对象与不可逆风险，请求用户确认后再继续。"
                    ),
                    requires_human_confirmation=True,
                )

        return PreFlightDecision(allowed=True)

    @staticmethod
    def compute_action_signature(tool_name: str, tool_args: dict[str, Any]) -> str:
        canonical = json.dumps({"tool": tool_name, "args": tool_args}, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:20]


class StatePreconditionHook:
    """
    替代 RULE-03（步骤顺序与前置查询铁律）：
    代码级检查工具依赖前置条件，阻止跳过前置读取直接执行变更。
    """

    name = "state_precondition_hook"

    def evaluate(self, ctx: PreFlightContext) -> PreFlightDecision:
        missing_prereqs = [
            req_tool
            for req_tool in ctx.tool_spec.preconditions
            if req_tool not in ctx.completed_tools
        ]
        if missing_prereqs:
            return PreFlightDecision(
                allowed=False,
                block_code="ERR_PRECONDITION_NOT_MET",
                reason=f"执行 `{ctx.tool_spec.name}` 前必须先完成前置工具调用: {missing_prereqs}。",
                recovery_hint=f"请先激活并调用前置工具 {missing_prereqs} 获取最新状态后再执行当前操作。",
            )
        return PreFlightDecision(allowed=True)


class IdempotencyGuardHook:
    """防重复副作用拦截器：阻止同一检查点周期内以完全相同参数重复调用写工具。"""

    name = "idempotency_guard_hook"

    def evaluate(self, ctx: PreFlightContext) -> PreFlightDecision:
        if ctx.tool_spec.risk_level == ToolRiskLevel.READ_ONLY:
            return PreFlightDecision(allowed=True)

        idem_key = PermissionAndConfirmationHook.compute_action_signature(
            ctx.tool_spec.name, ctx.tool_args
        )
        if idem_key in ctx.executed_idempotency_keys:
            return PreFlightDecision(
                allowed=False,
                block_code="ERR_DUPLICATE_MUTATION",
                reason=f"幂等拦截：写操作 `{ctx.tool_spec.name}` 已使用相同参数成功执行过。",
                recovery_hint="无需重复调用该写工具，请直接基于已记录的执行结果推进下一步。",
            )
        return PreFlightDecision(allowed=True)


@dataclass
class CheckpointRecord:
    """持久化会话执行检查点。"""

    session_id: str
    current_phase: str
    completed_tools: list[str] = field(default_factory=list)
    confirmed_destructive_tokens: list[str] = field(default_factory=list)
    executed_idempotency_keys: list[str] = field(default_factory=list)
    handoff_snapshot: dict[str, Any] = field(default_factory=dict)
    updated_at: float = field(default_factory=time.time)


class CheckpointStore:
    """基于本地 JSON 原子写入的检查点存储（可无缝替换为 Redis/PostgreSQL）。"""

    def __init__(self, checkpoint_dir: str | Path = ".lightwell_checkpoints") -> None:
        self.checkpoint_dir = Path(checkpoint_dir)
        self.checkpoint_dir.mkdir(parents=True, exist_ok=True)

    def save(self, record: CheckpointRecord) -> None:
        record.updated_at = time.time()
        target = self.checkpoint_dir / f"{record.session_id}.json"
        tmp = self.checkpoint_dir / f"{record.session_id}.json.tmp"
        tmp.write_text(json.dumps(asdict(record), ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(target)

    def load(self, session_id: str, default_phase: str = "INTAKE_DISCOVERY") -> CheckpointRecord:
        target = self.checkpoint_dir / f"{session_id}.json"
        if not target.exists():
            return CheckpointRecord(session_id=session_id, current_phase=default_phase)
        raw = json.loads(target.read_text(encoding="utf-8"))
        return CheckpointRecord(**raw)


class WorkflowStateMachine:
    """确定性业务阶段状态机，控制合法阶段跃迁。"""

    def __init__(self, transition_graph: dict[str, list[str]], initial_phase: str) -> None:
        self.transition_graph = transition_graph
        self.current_phase = initial_phase

    def can_transition(self, target_phase: str) -> bool:
        return target_phase in self.transition_graph.get(self.current_phase, [])

    def transition_to(self, target_phase: str) -> None:
        if target_phase == self.current_phase:
            return
        if not self.can_transition(target_phase):
            raise ValueError(
                f"[StateMachine] 非法状态跃迁: `{self.current_phase}` -> `{target_phase}`，"
                f"允许目标: {self.transition_graph.get(self.current_phase, [])}"
            )
        self.current_phase = target_phase


class ExecutionGuardrailEngine:
    """V4 执行层护栏调度中枢。"""

    def __init__(
        self,
        tool_registry: ProgressiveToolRegistry,
        checkpoint_store: CheckpointStore | None = None,
        hooks: list[PreFlightHook] | None = None,
    ) -> None:
        self.tool_registry = tool_registry
        self.checkpoint_store = checkpoint_store or CheckpointStore()
        self.hooks: list[PreFlightHook] = hooks or [
            SchemaValidationHook(),
            PermissionAndConfirmationHook(),
            StatePreconditionHook(),
            IdempotencyGuardHook(),
        ]

    def execute_tool_with_guardrails(
        self,
        *,
        session_id: str,
        actor_id: str,
        tenant_id: str,
        tool_name: str,
        tool_args: dict[str, Any],
    ) -> dict[str, Any]:
        checkpoint = self.checkpoint_store.load(session_id)
        spec = self.tool_registry.get_tool(tool_name)
        if spec is None:
            return {
                "ok": False,
                "block_code": "ERR_TOOL_NOT_FOUND",
                "reason": f"工具 `{tool_name}` 未注册。",
                "recovery_hint": "请先调用 `discover_tools` 查询合法工具名称。",
            }

        ctx = PreFlightContext(
            session_id=session_id,
            actor_id=actor_id,
            tenant_id=tenant_id,
            current_phase=checkpoint.current_phase,
            tool_spec=spec,
            tool_args=tool_args,
            completed_tools=list(checkpoint.completed_tools),
            confirmed_destructive_tokens=set(checkpoint.confirmed_destructive_tokens),
            executed_idempotency_keys=set(checkpoint.executed_idempotency_keys),
        )

        for hook in self.hooks:
            decision = hook.evaluate(ctx)
            if not decision.allowed:
                return {
                    "ok": False,
                    "blocked_by": hook.name,
                    "block_code": decision.block_code,
                    "reason": decision.reason,
                    "recovery_hint": decision.recovery_hint,
                    "requires_human_confirmation": decision.requires_human_confirmation,
                }

        try:
            raw_result = spec.handler(tool_args)
        except Exception as exc:
            return {
                "ok": False,
                "block_code": "ERR_TOOL_RUNTIME_EXCEPTION",
                "reason": f"{type(exc).__name__}: {exc}",
                "recovery_hint": "请检查传入参数业务有效性，或向用户核实相关输入条件后重试。",
            }

        # 更新检查点执行轨迹与幂等键
        if tool_name not in checkpoint.completed_tools:
            checkpoint.completed_tools.append(tool_name)
        if spec.risk_level != ToolRiskLevel.READ_ONLY:
            idem_key = PermissionAndConfirmationHook.compute_action_signature(tool_name, tool_args)
            if idem_key not in checkpoint.executed_idempotency_keys:
                checkpoint.executed_idempotency_keys.append(idem_key)

        self.checkpoint_store.save(checkpoint)
        self.tool_registry.tick_turn_decay(called_tool_name=tool_name)

        return {"ok": True, "tool": tool_name, "result": raw_result}
