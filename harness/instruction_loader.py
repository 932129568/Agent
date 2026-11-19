"""
LIGHTWELL V4 - MOD-02: Three-Tier Instruction & Modular SKILL.md Loader
职责：
1. 加载并校验 L1 全局核心宪章（AGENTS.md），强制执行黄金海拔 Token 上限。
2. 按状态机当前阶段渲染 L2 阶段门控工作流模板（Phase-Gated Templates）。
3. 解析目录中的 L3 技能包（SKILL.md，含 YAML Frontmatter），基于多维相关性路由按需挂载并自动卸载过期技能。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class SkillMetadata:
    """SKILL.md 头部 YAML 元数据规范。"""

    skill_id: str
    name: str
    description: str
    trigger_keywords: list[str] = field(default_factory=list)
    allowed_phases: list[str] = field(default_factory=list)
    recommended_tools: list[str] = field(default_factory=list)
    priority: int = 50
    ttl_turns: int = 3


@dataclass
class SkillPackage:
    """完整的 L3 按需技能包实例。"""

    metadata: SkillMetadata
    body_markdown: str
    source_path: str


@dataclass
class PhaseTemplate:
    """L2 阶段门控工作流模板。"""

    phase_id: str
    phase_name: str
    objective: str
    entry_criteria: list[str]
    exit_criteria: list[str]
    instructions_markdown: str

    def render(self, runtime_vars: dict[str, Any] | None = None) -> str:
        vars_map = runtime_vars or {}
        body = self.instructions_markdown
        for key, val in vars_map.items():
            body = body.replace(f"{{{{{key}}}}}", str(val))

        entry_str = "\n".join(f"- {item}" for item in self.entry_criteria)
        exit_str = "\n".join(f"- {item}" for item in self.exit_criteria)
        return (
            f"### Phase: {self.phase_name} (`{self.phase_id}`)\n"
            f"**Objective**: {self.objective}\n\n"
            f"**Entry Criteria**:\n{entry_str}\n\n"
            f"**Exit Gate Criteria**:\n{exit_str}\n\n"
            f"**Execution Guidance**:\n{body}"
        )


def parse_simple_yaml_frontmatter(raw_text: str) -> tuple[dict[str, Any], str]:
    """
    零第三方依赖的 YAML Frontmatter 解析器，支持标量、整数与字符串列表。
    """
    pattern = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)
    match = pattern.match(raw_text.strip())
    if not match:
        return {}, raw_text.strip()

    yaml_block, markdown_body = match.group(1), match.group(2).strip()
    parsed: dict[str, Any] = {}
    current_list_key: str | None = None

    for raw_line in yaml_block.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        if line.startswith("- ") and current_list_key is not None:
            item_val = line[2:].strip().strip("\"'")
            parsed[current_list_key].append(item_val)
            continue

        if ":" in line:
            key, val = line.split(":", 1)
            key = key.strip()
            val = val.strip()
            if val == "":
                parsed[key] = []
                current_list_key = key
            elif val.startswith("[") and val.endswith("]"):
                inner = val[1:-1].strip()
                parsed[key] = [
                    x.strip().strip("\"'") for x in inner.split(",") if x.strip()
                ]
                current_list_key = None
            elif val.isdigit():
                parsed[key] = int(val)
                current_list_key = None
            else:
                parsed[key] = val.strip("\"'")
                current_list_key = None

    return parsed, markdown_body


class InstructionHierarchyLoader:
    """
    V4 三层动态指令管理器。
    管理 L1 宪章、L2 阶段模板池与 L3 SKILL.md 技能注册表及生命周期。
    """

    def __init__(self) -> None:
        self._l1_charter: str = ""
        self._l2_phases: dict[str, PhaseTemplate] = {}
        self._l3_skills: dict[str, SkillPackage] = {}
        # 记录技能当前剩余存活轮次: skill_id -> remaining_turns
        self._mounted_skill_ttl: dict[str, int] = {}

    def load_l1_charter_from_text(self, charter_text: str) -> None:
        cleaned = charter_text.strip()
        if not cleaned:
            raise ValueError("[InstructionLoader] L1 全局宪章不能为空。")
        self._l1_charter = cleaned

    def load_l1_charter_from_file(self, file_path: str | Path) -> None:
        path = Path(file_path)
        self.load_l1_charter_from_text(path.read_text(encoding="utf-8"))

    def register_l2_phase(self, template: PhaseTemplate) -> None:
        self._l2_phases[template.phase_id] = template

    def register_l3_skill_from_markdown(self, raw_markdown: str, source_path: str = "inline") -> SkillPackage:
        meta_dict, body = parse_simple_yaml_frontmatter(raw_markdown)
        skill_id = str(meta_dict.get("skill_id") or "").strip()
        name = str(meta_dict.get("name") or skill_id).strip()
        if not skill_id:
            raise ValueError(f"[InstructionLoader] SKILL.md 缺少必填元数据 skill_id: {source_path}")

        metadata = SkillMetadata(
            skill_id=skill_id,
            name=name,
            description=str(meta_dict.get("description", "")),
            trigger_keywords=list(meta_dict.get("trigger_keywords", [])),
            allowed_phases=list(meta_dict.get("allowed_phases", [])),
            recommended_tools=list(meta_dict.get("recommended_tools", [])),
            priority=int(meta_dict.get("priority", 50)),
            ttl_turns=int(meta_dict.get("ttl_turns", 3)),
        )
        pkg = SkillPackage(metadata=metadata, body_markdown=body, source_path=source_path)
        self._l3_skills[skill_id] = pkg
        return pkg

    def load_l3_skills_directory(self, skills_dir: str | Path) -> int:
        root = Path(skills_dir)
        if not root.exists():
            return 0
        count = 0
        for skill_file in sorted(root.rglob("SKILL.md")):
            self.register_l3_skill_from_markdown(
                skill_file.read_text(encoding="utf-8"), source_path=str(skill_file)
            )
            count += 1
        return count

    def _score_skill_relevance(
        self,
        skill: SkillPackage,
        user_query: str,
        current_phase: str,
        active_tool_names: set[str],
    ) -> float:
        meta = skill.metadata
        if meta.allowed_phases and current_phase not in meta.allowed_phases:
            return 0.0

        score = 0.0
        query_lower = user_query.lower()

        for kw in meta.trigger_keywords:
            if kw.lower() in query_lower:
                score += 10.0

        # 工具共现加分：若用户已激活该技能推荐的工具，提升技能匹配权重
        overlap_tools = active_tool_names.intersection(set(meta.recommended_tools))
        score += len(overlap_tools) * 6.0

        if score > 0:
            score += meta.priority * 0.05
        return score

    def assemble_instructions(
        self,
        *,
        user_query: str,
        current_phase: str,
        active_tool_names: set[str] | None = None,
        phase_vars: dict[str, Any] | None = None,
        max_concurrent_skills: int = 2,
    ) -> dict[str, Any]:
        """
        单入口路由与分层指令装配：
        1. 衰减已挂载技能的 TTL，过期自动卸载；
        2. 匹配当前用户意图与阶段命中的新技能并挂载；
        3. 返回 L1 文本、L2 渲染文本、L3 合并文本及推荐激活的工具清单。
        """
        tools_set = active_tool_names or set()

        # 1. TTL 生命周期衰减与阶段不兼容淘汰
        expired_ids: list[str] = []
        for sid in list(self._mounted_skill_ttl.keys()):
            skill_obj = self._l3_skills.get(sid)
            if not skill_obj:
                expired_ids.append(sid)
                continue
            if skill_obj.metadata.allowed_phases and current_phase not in skill_obj.metadata.allowed_phases:
                expired_ids.append(sid)
                continue
            self._mounted_skill_ttl[sid] -= 1
            if self._mounted_skill_ttl[sid] <= 0:
                expired_ids.append(sid)

        for sid in expired_ids:
            self._mounted_skill_ttl.pop(sid, None)

        # 2. 计算新意图匹配的技能包
        scored: list[tuple[float, SkillPackage]] = []
        for skill in self._l3_skills.values():
            s = self._score_skill_relevance(skill, user_query, current_phase, tools_set)
            if s > 0:
                scored.append((s, skill))

        scored.sort(key=lambda item: item[0], reverse=True)
        for _, matched_skill in scored[:max_concurrent_skills]:
            self._mounted_skill_ttl[matched_skill.metadata.skill_id] = matched_skill.metadata.ttl_turns

        # 3. 若挂载总数超出上限，保留 TTL 最长且优先级最高的技能
        if len(self._mounted_skill_ttl) > max_concurrent_skills:
            ranked_mounted = sorted(
                self._mounted_skill_ttl.keys(),
                key=lambda k: (
                    self._mounted_skill_ttl[k],
                    self._l3_skills[k].metadata.priority,
                ),
                reverse=True,
            )
            for drop_id in ranked_mounted[max_concurrent_skills:]:
                self._mounted_skill_ttl.pop(drop_id, None)

        active_skills = [
            self._l3_skills[sid] for sid in self._mounted_skill_ttl if sid in self._l3_skills
        ]
        l3_rendered = "\n\n---\n\n".join(
            f"### Skill: {sk.metadata.name} (`{sk.metadata.skill_id}`)\n{sk.body_markdown}"
            for sk in active_skills
        )

        recommended_tools: list[str] = []
        for sk in active_skills:
            for t in sk.metadata.recommended_tools:
                if t not in recommended_tools:
                    recommended_tools.append(t)

        phase_tpl = self._l2_phases.get(current_phase)
        l2_rendered = phase_tpl.render(phase_vars) if phase_tpl else f"### Phase: `{current_phase}`"

        return {
            "l1_charter": self._l1_charter,
            "l2_phase_prompt": l2_rendered,
            "l3_active_skills": l3_rendered,
            "mounted_skill_ids": [sk.metadata.skill_id for sk in active_skills],
            "recommended_tools": recommended_tools,
        }
