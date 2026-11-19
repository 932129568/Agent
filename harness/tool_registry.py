"""
LIGHTWELL V4 - MOD-03: Progressive Tool Registry & Atomic Primitive Manager
职责：
1. 实施渐进式工具披露（Progressive Tool Disclosure）：初始仅暴露极简目录与 2 个元工具，彻底消除 Tool Bloat。
2. 支持运行时按需激活完整 JSON Schema，并通过 LRU 机制自动回收闲置工具 Schema。
3. 支持工具风险分级（READ_ONLY / IDEMPOTENT_WRITE / DESTRUCTIVE_WRITE / EXTERNAL_NETWORK）与原子原语合并追踪。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable


class ToolRiskLevel(str, Enum):
    READ_ONLY = "read_only"
    IDEMPOTENT_WRITE = "idempotent_write"
    DESTRUCTIVE_WRITE = "destructive_write"
    EXTERNAL_NETWORK = "external_network"


ToolHandler = Callable[[dict[str, Any]], Any]


@dataclass
class ToolSpec:
    """标准原子原语工具定义。"""

    name: str
    category: str
    one_line_summary: str
    parameters_schema: dict[str, Any]
    handler: ToolHandler
    risk_level: ToolRiskLevel = ToolRiskLevel.READ_ONLY
    preconditions: list[str] = field(default_factory=list)
    consolidated_from: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)

    def to_openai_tool_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.one_line_summary,
                "parameters": self.parameters_schema,
            },
        }


class ProgressiveToolRegistry:
    """
    渐进式工具注册与动态激活中心。
    """

    META_DISCOVER = "discover_tools"
    META_INSPECT = "inspect_tool_schema"

    def __init__(self, max_active_schemas: int = 5, schema_idle_ttl: int = 3) -> None:
        self._tools: dict[str, ToolSpec] = {}
        # tool_name -> remaining_idle_turns
        self._active_schema_ttl: dict[str, int] = {}
        # tool_name -> monotonic access sequence for true LRU tie-breaking
        self._active_access_seq: dict[str, int] = {}
        self._seq_counter: int = 0
        self.max_active_schemas = max_active_schemas
        self.schema_idle_ttl = schema_idle_ttl
        self._register_builtin_meta_tools()

    def _register_builtin_meta_tools(self) -> None:
        self.register_tool(
            ToolSpec(
                name=self.META_DISCOVER,
                category="meta",
                one_line_summary="按业务意图或分类检索可用原子工具名称及前置条件。",
                parameters_schema={
                    "type": "object",
                    "properties": {
                        "intent_query": {
                            "type": "string",
                            "description": "当前任务意图关键词或目标描述",
                        },
                        "category": {
                            "type": "string",
                            "description": "可选业务领域分类过滤",
                        },
                    },
                    "required": ["intent_query"],
                    "additionalProperties": False,
                },
                handler=self._handle_discover_tools,
                risk_level=ToolRiskLevel.READ_ONLY,
            )
        )
        self.register_tool(
            ToolSpec(
                name=self.META_INSPECT,
                category="meta",
                one_line_summary="加载指定 1~3 个工具的完整参数 JSON Schema 以准备调用。",
                parameters_schema={
                    "type": "object",
                    "properties": {
                        "tool_names": {
                            "type": "array",
                            "items": {"type": "string"},
                            "minItems": 1,
                            "maxItems": 4,
                            "description": "需要激活完整参数定义的工具名称列表",
                        }
                    },
                    "required": ["tool_names"],
                    "additionalProperties": False,
                },
                handler=self._handle_inspect_tool_schema,
                risk_level=ToolRiskLevel.READ_ONLY,
            )
        )

    def register_tool(self, spec: ToolSpec) -> None:
        self._tools[spec.name] = spec

    def get_tool(self, name: str) -> ToolSpec | None:
        return self._tools.get(name)

    def get_active_tool_names(self) -> set[str]:
        return set(self._active_schema_ttl.keys())

    def activate_tools(self, tool_names: list[str]) -> list[str]:
        """激活指定工具的完整 Schema 并刷新其 LRU 存活期。"""
        activated: list[str] = []
        for name in tool_names:
            if name in self._tools and name not in (self.META_DISCOVER, self.META_INSPECT):
                self._seq_counter += 1
                self._active_schema_ttl[name] = self.schema_idle_ttl
                self._active_access_seq[name] = self._seq_counter
                activated.append(name)

        if len(self._active_schema_ttl) > self.max_active_schemas:
            sorted_active = sorted(
                self._active_schema_ttl.items(),
                key=lambda kv: (kv[1], self._active_access_seq.get(kv[0], 0)),
                reverse=True,
            )
            kept = sorted_active[: self.max_active_schemas]
            self._active_schema_ttl = dict(kept)
            self._active_access_seq = {
                k: self._active_access_seq.get(k, 0) for k, _ in kept
            }
        return activated

    def tick_turn_decay(self, called_tool_name: str | None = None) -> None:
        """每轮推理结束更新活跃工具 TTL，被调用工具续期，长期闲置工具自动卸载。"""
        if called_tool_name and called_tool_name in self._active_schema_ttl:
            self._seq_counter += 1
            self._active_schema_ttl[called_tool_name] = self.schema_idle_ttl
            self._active_access_seq[called_tool_name] = self._seq_counter

        to_evict: list[str] = []
        for name in list(self._active_schema_ttl.keys()):
            if name == called_tool_name:
                continue
            self._active_schema_ttl[name] -= 1
            if self._active_schema_ttl[name] <= 0:
                to_evict.append(name)

        for name in to_evict:
            self._active_schema_ttl.pop(name, None)
            self._active_access_seq.pop(name, None)

    def render_lightweight_catalog(self) -> str:
        """生成注入 System Prompt 的极简 Level-0 工具目录（不含重型 JSON Schema）。"""
        lines = [
            "以下为系统可用工具轻量索引。调用业务工具前，若其完整参数未激活，请先调用 `inspect_tool_schema` 加载："
        ]
        for spec in self._tools.values():
            if spec.name in (self.META_DISCOVER, self.META_INSPECT):
                continue
            status_tag = "[ACTIVE_SCHEMA]" if spec.name in self._active_schema_ttl else "[INDEX_ONLY]"
            pre_tag = f" | requires={','.join(spec.preconditions)}" if spec.preconditions else ""
            lines.append(
                f"- `{spec.name}` ({spec.category}, risk={spec.risk_level.value}) {status_tag}: "
                f"{spec.one_line_summary}{pre_tag}"
            )
        return "\n".join(lines)

    def get_llm_native_tools(self) -> list[dict[str, Any]]:
        """返回本轮实际传给 LLM API `tools` 参数的精选工具 Schema 列表。"""
        selected_names = [self.META_DISCOVER, self.META_INSPECT] + list(
            self._active_schema_ttl.keys()
        )
        result: list[dict[str, Any]] = []
        for name in selected_names:
            spec = self._tools.get(name)
            if spec:
                result.append(spec.to_openai_tool_schema())
        return result

    def _handle_discover_tools(self, args: dict[str, Any]) -> dict[str, Any]:
        query = str(args.get("intent_query", "")).lower()
        category = args.get("category")
        matches: list[dict[str, Any]] = []

        for spec in self._tools.values():
            if spec.name in (self.META_DISCOVER, self.META_INSPECT):
                continue
            if category and spec.category.lower() != str(category).lower():
                continue

            haystack = " ".join(
                [spec.name, spec.category, spec.one_line_summary] + spec.tags
            ).lower()
            score = sum(1 for token in query.split() if token and token in haystack)
            if score > 0 or not query:
                matches.append(
                    {
                        "name": spec.name,
                        "category": spec.category,
                        "summary": spec.one_line_summary,
                        "risk_level": spec.risk_level.value,
                        "preconditions": spec.preconditions,
                        "score": score,
                    }
                )

        matches.sort(key=lambda x: x["score"], reverse=True)
        return {
            "matched_count": len(matches),
            "tools": matches[:8],
            "next_step": "请调用 inspect_tool_schema 加载目标工具的完整参数定义。",
        }

    def _handle_inspect_tool_schema(self, args: dict[str, Any]) -> dict[str, Any]:
        requested = args.get("tool_names", [])
        activated = self.activate_tools(requested)
        schemas: dict[str, Any] = {}
        missing: list[str] = []

        for name in requested:
            spec = self._tools.get(name)
            if not spec:
                missing.append(name)
                continue
            schemas[name] = {
                "description": spec.one_line_summary,
                "risk_level": spec.risk_level.value,
                "preconditions": spec.preconditions,
                "parameters_schema": spec.parameters_schema,
            }

        return {
            "activated_tools": activated,
            "missing_tools": missing,
            "schemas": schemas,
        }
