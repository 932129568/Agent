"""
LIGHTWELL V4 - MOD-06: Isolated Sub-Agent Sandbox Orchestrator
职责：
1. 解决旧版伪多 Agent 串联空转痛点（DEPR-04）：主 Agent 仅在需要独立检索、并行核验或重型分析时派生 Sub-agent。
2. 严格上下文隔离：Sub-agent 拥有独立的微型 Token 预算与最小权限工具白名单，不继承主会话冗长聊天历史。
3. 强制结构化收敛：Sub-agent 结束时仅向主 Agent 返回紧凑的结构化交接摘要，不污染主上下文。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from .context_assembler import TokenBudget


@dataclass
class SubAgentTask:
    """隔离上下文子代理任务契约。"""

    task_id: str
    role_directive: str
    objective: str
    input_context: dict[str, Any]
    allowed_tool_names: list[str] = field(default_factory=list)
    max_turns: int = 4
    token_ceiling: int = 6000


@dataclass
class SubAgentResult:
    """子代理返回主控 Agent 的高信噪比结构化结果。"""

    task_id: str
    success: bool
    summary: str
    structured_findings: dict[str, Any] = field(default_factory=dict)
    evidence_tool_calls: list[str] = field(default_factory=list)
    error_message: str = ""


SubAgentRunnerFn = Callable[[SubAgentTask, TokenBudget], Awaitable[SubAgentResult]]


class SubAgentOrchestrator:
    """
    受控子代理沙盒调度器。
    内置最大递归深度熔断（max_depth=2）与并发上限控制。
    """

    def __init__(
        self,
        runner_fn: SubAgentRunnerFn,
        max_concurrency: int = 3,
        max_depth: int = 2,
    ) -> None:
        self.runner_fn = runner_fn
        self.max_concurrency = max_concurrency
        self.max_depth = max_depth

    async def run_isolated_batch(
        self,
        tasks: list[SubAgentTask],
        current_depth: int = 0,
    ) -> list[SubAgentResult]:
        if current_depth >= self.max_depth:
            return [
                SubAgentResult(
                    task_id=t.task_id,
                    success=False,
                    summary="",
                    error_message=f"熔断拦截：Sub-agent 嵌套深度达到上限 ({self.max_depth})，禁止继续派生。",
                )
                for t in tasks
            ]

        semaphore = asyncio.Semaphore(self.max_concurrency)

        async def _run_single(task: SubAgentTask) -> SubAgentResult:
            async with semaphore:
                sub_budget = TokenBudget(
                    total_window=task.token_ceiling,
                    reserve_output=1500,
                    l1_charter_max=600,
                    l2_phase_max=400,
                    anchored_handoff_max=500,
                    tool_catalog_max=600,
                    l3_skill_max=600,
                )
                try:
                    return await self.runner_fn(task, sub_budget)
                except Exception as exc:
                    return SubAgentResult(
                        task_id=task.task_id,
                        success=False,
                        summary="",
                        error_message=f"Sub-agent 执行异常: {type(exc).__name__}: {exc}",
                    )

        return await asyncio.gather(*(_run_single(t) for t in tasks))
