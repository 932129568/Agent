"""
LIGHTWELL V4 - MOD-01: Context Assembler & Anchored Incremental Compaction Engine
职责：
1. 严格执行 6 分区动态 Token 预算分配（PART-01 ~ PART-06），消除上下文腐烂（Context Rot）。
2. 实现外部大对象落盘存储（ExternalBlobStore），防止超大 Tool 输出撑爆注意力窗口。
3. 实现锚定增量压缩引擎（AnchoredCompactionEngine），保护不可变状态、关键 ID 与确认决策不失真。
4. 实施双端锚定布局（Dual-Anchor Layout）对抗 Lost in the Middle 效应。
"""

from __future__ import annotations

import hashlib
import json
import math
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Literal, Protocol


RoleType = Literal["system", "user", "assistant", "tool"]


class TokenEstimator(Protocol):
    """Token 估算协议，可无缝注入 tiktoken 或模型原生 tokenizer。"""

    def count_tokens(self, text: str) -> int:
        ...


class HeuristicTokenEstimator:
    """
    零外部依赖的高精度中英混合 Token 估算器。
    规则：ASCII 字符按 ~3.6 chars/token 计算，非 ASCII（CJK）按 ~1.6 chars/token 计算，并加结构开销。
    """

    def count_tokens(self, text: str) -> int:
        if not text:
            return 0
        ascii_chars = sum(1 for ch in text if ord(ch) < 128)
        non_ascii_chars = len(text) - ascii_chars
        estimated = math.ceil(ascii_chars / 3.6 + non_ascii_chars / 1.6)
        return max(1, estimated)


@dataclass(frozen=True)
class TokenBudget:
    """V4 六分区刚性 Token 预算配额配置。"""

    total_window: int = 16000
    reserve_output: int = 4096
    l1_charter_max: int = 1200
    l2_phase_max: int = 950
    anchored_handoff_max: int = 1800
    tool_catalog_max: int = 1400
    l3_skill_max: int = 1800

    @property
    def available_input(self) -> int:
        return max(2048, self.total_window - self.reserve_output)

    @property
    def working_memory_max(self) -> int:
        fixed_sum = (
            self.l1_charter_max
            + self.l2_phase_max
            + self.anchored_handoff_max
            + self.tool_catalog_max
            + self.l3_skill_max
        )
        return max(1024, self.available_input - fixed_sum)


@dataclass
class MessageTurn:
    """标准化会话消息单元，支持工具调用与结果关联追踪。"""

    role: RoleType
    content: str
    turn_id: str
    timestamp: float = field(default_factory=time.time)
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    tool_call_id: str | None = None
    tool_name: str | None = None
    importance_score: float = 1.0
    metadata: dict[str, Any] = field(default_factory=dict)

    def serialize_for_counting(self) -> str:
        payload = {
            "role": self.role,
            "content": self.content,
            "tool_calls": self.tool_calls,
            "tool_call_id": self.tool_call_id,
            "tool_name": self.tool_name,
        }
        return json.dumps(payload, ensure_ascii=False)

    def to_llm_dict(self) -> dict[str, Any]:
        msg: dict[str, Any] = {"role": self.role, "content": self.content}
        if self.tool_calls:
            msg["tool_calls"] = self.tool_calls
        if self.tool_call_id:
            msg["tool_call_id"] = self.tool_call_id
        if self.tool_name and self.role == "tool":
            msg["name"] = self.tool_name
        return msg


@dataclass
class AnchoredHandoffState:
    """
    四段式不可变结构化交接单（Anchored Structured Handoff）。
    每次增量压缩仅追加或更新字段，绝不重写整个历史叙事。
    """

    mutated_state: dict[str, dict[str, Any]] = field(default_factory=dict)
    tool_execution_index: list[dict[str, Any]] = field(default_factory=list)
    confirmed_decisions: list[str] = field(default_factory=list)
    active_constraints: dict[str, Any] = field(default_factory=dict)
    compaction_generation: int = 0

    def apply_delta(self, delta: dict[str, Any]) -> None:
        """合并增量压缩器产出的结构化补丁。"""
        for entity_id, fields in delta.get("mutated_state", {}).items():
            if not isinstance(fields, dict):
                continue
            self.mutated_state.setdefault(entity_id, {}).update(fields)

        existing_call_ids = {
            item.get("call_id") for item in self.tool_execution_index if item.get("call_id")
        }
        for record in delta.get("tool_execution_index", []):
            call_id = record.get("call_id")
            if call_id and call_id in existing_call_ids:
                continue
            self.tool_execution_index.append(record)
            if call_id:
                existing_call_ids.add(call_id)

        for decision in delta.get("confirmed_decisions", []):
            if decision and decision not in self.confirmed_decisions:
                self.confirmed_decisions.append(decision)

        for k, v in delta.get("active_constraints", {}).items():
            if v is None:
                self.active_constraints.pop(k, None)
            else:
                self.active_constraints[k] = v

        self.compaction_generation += 1

    def render_markdown(self, max_tokens: int, estimator: TokenEstimator) -> str:
        """渲染为高信噪比 Markdown 锚点块，超限时仅归档最旧的工具索引条目。"""
        if (
            not self.mutated_state
            and not self.tool_execution_index
            and not self.confirmed_decisions
            and not self.active_constraints
        ):
            return ""

        trimmed_index = list(self.tool_execution_index)
        while True:
            blocks = [
                f"### [ANCHORED HANDOFF STATE | GEN-{self.compaction_generation}]",
                "#### 1. Mutated Entity State",
                json.dumps(self.mutated_state, ensure_ascii=False, indent=2)
                if self.mutated_state
                else "- (none)",
                "#### 2. Tool Execution Index",
                json.dumps(trimmed_index, ensure_ascii=False, indent=2)
                if trimmed_index
                else "- (none)",
                "#### 3. Confirmed Decisions & Exclusions",
                "\n".join(f"- {d}" for d in self.confirmed_decisions)
                if self.confirmed_decisions
                else "- (none)",
                "#### 4. Active Session Constraints",
                json.dumps(self.active_constraints, ensure_ascii=False, indent=2)
                if self.active_constraints
                else "- (none)",
            ]
            rendered = "\n".join(blocks)
            if estimator.count_tokens(rendered) <= max_tokens or len(trimmed_index) <= 3:
                return rendered
            trimmed_index.pop(0)


class ExternalBlobStore:
    """
    外部大对象落盘存储器。
    当工具输出超过 inline_char_limit 时，完整数据写入持久化存储，仅向模型上下文返回摘要与检索键。
    """

    def __init__(self, storage_dir: str | Path = ".lightwell_blobs", inline_char_limit: int = 1800) -> None:
        self.storage_dir = Path(storage_dir)
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.inline_char_limit = inline_char_limit

    def offload_if_oversized(self, tool_name: str, raw_output: str) -> str:
        if len(raw_output) <= self.inline_char_limit:
            return raw_output

        digest = hashlib.sha256(raw_output.encode("utf-8")).hexdigest()[:16]
        blob_key = f"{tool_name}_{digest}"
        blob_path = self.storage_dir / f"{blob_key}.txt"
        blob_path.write_text(raw_output, encoding="utf-8")

        head_preview = raw_output[:600].replace("\n", " ")
        tail_preview = raw_output[-300:].replace("\n", " ")
        return (
            f"[EXTERNAL_BLOB_OFFLOADED]\n"
            f"blob_uri: blob://{blob_key}\n"
            f"original_chars: {len(raw_output)}\n"
            f"head_preview: {head_preview} ...\n"
            f"tail_preview: ... {tail_preview}\n"
            f"hint: 如需检索完整内容中的特定字段，请使用检索原语工具按关键字查询该 blob_uri。"
        )

    def read_blob(self, blob_uri: str, keyword: str | None = None, max_chars: int = 2000) -> str:
        blob_key = blob_uri.removeprefix("blob://")
        blob_path = self.storage_dir / f"{blob_key}.txt"
        if not blob_path.exists():
            return f"[BLOB_NOT_FOUND] {blob_uri}"
        full_text = blob_path.read_text(encoding="utf-8")
        if not keyword:
            return full_text[:max_chars]
        matched_lines = [line for line in full_text.splitlines() if keyword.lower() in line.lower()]
        joined = "\n".join(matched_lines)
        return joined[:max_chars] if joined else f"[NO_MATCH_FOR_KEYWORD] keyword={keyword}"


CompactorCallback = Callable[[AnchoredHandoffState, list[MessageTurn]], dict[str, Any]]


class AnchoredCompactionEngine:
    """
    锚定增量压缩引擎。
    支持注入 LLM 增量压缩回调（PROMPT-04），并内置确定性规则兜底提取器，保证任何情况下零崩溃。
    """

    def __init__(self, llm_compactor: CompactorCallback | None = None) -> None:
        self.llm_compactor = llm_compactor

    def select_eviction_slice(
        self,
        turns: list[MessageTurn],
        estimator: TokenEstimator,
        target_free_tokens: int,
    ) -> tuple[list[MessageTurn], list[MessageTurn]]:
        """
        安全切分最旧的待淘汰消息窗口，严格保持 assistant(tool_calls) 与后续 tool 消息的原子完整性。
        """
        if len(turns) <= 2:
            return [], turns

        freed = 0
        split_idx = 0
        total = len(turns)

        while split_idx < total - 2 and freed < target_free_tokens:
            current = turns[split_idx]
            freed += estimator.count_tokens(current.serialize_for_counting())
            split_idx += 1

            # 若当前为带 tool_calls 的 assistant 消息，必须把紧随其后的所有 tool 响应一并纳入淘汰切片
            if current.role == "assistant" and current.tool_calls:
                while split_idx < total - 1 and turns[split_idx].role == "tool":
                    freed += estimator.count_tokens(turns[split_idx].serialize_for_counting())
                    split_idx += 1

        return turns[:split_idx], turns[split_idx:]

    def compact_slice(
        self,
        handoff: AnchoredHandoffState,
        evicted_turns: list[MessageTurn],
    ) -> None:
        if not evicted_turns:
            return

        if self.llm_compactor is not None:
            delta = self.llm_compactor(handoff, evicted_turns)
            handoff.apply_delta(delta)
            return

        # 确定性无模型兜底提取：精确保留工具调用索引与用户输入摘要
        delta_index: list[dict[str, Any]] = []
        delta_decisions: list[str] = []
        for turn in evicted_turns:
            if turn.role == "tool":
                delta_index.append(
                    {
                        "call_id": turn.tool_call_id or turn.turn_id,
                        "tool": turn.tool_name or "unknown_tool",
                        "summary": turn.content[:240].replace("\n", " "),
                    }
                )
            elif turn.role == "user" and turn.importance_score >= 1.2:
                delta_decisions.append(f"User constraint/request: {turn.content[:180]}")

        handoff.apply_delta(
            {
                "tool_execution_index": delta_index,
                "confirmed_decisions": delta_decisions,
            }
        )


class ContextAssembler:
    """
    V4 统一上下文装配引擎。
    将 L1 宪章、L2 阶段契约、L3 技能包、渐进式工具目录、增量交接单与工作记忆装配为最优推理负载。
    """

    def __init__(
        self,
        budget: TokenBudget | None = None,
        estimator: TokenEstimator | None = None,
        compaction_engine: AnchoredCompactionEngine | None = None,
    ) -> None:
        self.budget = budget or TokenBudget()
        self.estimator = estimator or HeuristicTokenEstimator()
        self.compaction_engine = compaction_engine or AnchoredCompactionEngine()

    def _enforce_ceiling(self, text: str, max_tokens: int, section_name: str, strict_error: bool = False) -> str:
        if not text:
            return ""
        tokens = self.estimator.count_tokens(text)
        if tokens <= max_tokens:
            return text
        if strict_error:
            raise ValueError(
                f"[ContextAssembler] {section_name} 超出刚性预算: {tokens} > {max_tokens} Tokens"
            )
        # 按字符比例安全截断并标注截断提示
        ratio = max_tokens / max(tokens, 1)
        safe_chars = max(64, int(len(text) * ratio * 0.92))
        return text[:safe_chars] + f"\n...[TRUNCATED_TO_BUDGET:{section_name}]"

    def assemble(
        self,
        *,
        l1_charter: str,
        l2_phase_prompt: str,
        l3_active_skills: str,
        tool_catalog_summary: str,
        handoff_state: AnchoredHandoffState,
        working_turns: list[MessageTurn],
    ) -> tuple[list[dict[str, Any]], list[MessageTurn]]:
        """
        构建符合双端锚定布局的最终 LLM messages 列表，并返回更新后的 working_turns。
        """
        # 1. 各独立分区刚性预算校验
        l1_clean = self._enforce_ceiling(
            l1_charter, self.budget.l1_charter_max, "PART-01:L1_CHARTER", strict_error=True
        )
        l2_clean = self._enforce_ceiling(
            l2_phase_prompt, self.budget.l2_phase_max, "PART-02:L2_PHASE", strict_error=False
        )
        tools_clean = self._enforce_ceiling(
            tool_catalog_summary, self.budget.tool_catalog_max, "PART-04:TOOL_CATALOG", strict_error=False
        )
        skills_clean = self._enforce_ceiling(
            l3_active_skills, self.budget.l3_skill_max, "PART-05:L3_SKILLS", strict_error=False
        )

        # 2. 检查工作记忆是否超限，若超限则执行锚定增量压缩
        current_turns = list(working_turns)
        working_tokens = sum(
            self.estimator.count_tokens(t.serialize_for_counting()) for t in current_turns
        )
        if working_tokens > self.budget.working_memory_max:
            overflow = working_tokens - int(self.budget.working_memory_max * 0.75)
            evict_slice, remaining_turns = self.compaction_engine.select_eviction_slice(
                current_turns, self.estimator, target_free_tokens=overflow
            )
            if evict_slice:
                self.compaction_engine.compact_slice(handoff_state, evict_slice)
                current_turns = remaining_turns

        handoff_clean = handoff_state.render_markdown(
            max_tokens=self.budget.anchored_handoff_max, estimator=self.estimator
        )

        # 3. 头部锚点装配（System Prompt）：L1 -> L2 -> Tool Index -> Anchored Handoff
        system_sections = [l1_clean]
        if l2_clean:
            system_sections.append(f"## [CURRENT PHASE CONTRACT]\n{l2_clean}")
        if tools_clean:
            system_sections.append(f"## [PROGRESSIVE TOOL CATALOG]\n{tools_clean}")
        if handoff_clean:
            system_sections.append(handoff_clean)

        assembled_messages: list[dict[str, Any]] = [
            {"role": "system", "content": "\n\n".join(system_sections)}
        ]

        # 4. 中部工作记忆装配
        for turn in current_turns:
            assembled_messages.append(turn.to_llm_dict())

        # 5. 尾部锚点装配（Suffix Anchor）：将当前活跃 L3 技能包紧贴最新执行上下文注入
        if skills_clean:
            skill_injection = (
                "## [ACTIVE ON-DEMAND SKILL SOP]\n"
                "请严格遵循以下针对当前任务动态挂载的技能执行规程：\n\n"
                f"{skills_clean}"
            )
            if assembled_messages[-1]["role"] == "user":
                assembled_messages[-1]["content"] = (
                    f"{skill_injection}\n\n---\n### [CURRENT USER REQUEST]\n{assembled_messages[-1]['content']}"
                )
            else:
                assembled_messages.append({"role": "system", "content": skill_injection})

        return assembled_messages, current_turns
