#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""expert_portable.py — WorkBuddy 专家/专家团模式便携运行时（参考实现）

用途：
  把 WorkBuddy 的专家包（纯 Markdown 提示词 + JSON 元数据的开放格式）
  加载到你自己的 agent 运行时中。

  支持两类专家：
    - agent 型：agents/<id>.md 全文即 system prompt，直接复用
    - team  型：主理人 md 作为编排者提示词，成员 md 作为子代理提示词，
                通过本模块注册的 Agent / SendMessage 两个同构工具驱动协作

依赖：仅 Python 3.8+ 标准库。接入真实 LLM 时自行实现 llm_call。

CLI：
  python expert_portable.py list    <专家包目录> [更多目录...]
  python expert_portable.py show    <专家包目录> <agent-id>
  python expert_portable.py validate <专家包目录> [更多目录...]
  python expert_portable.py sop     <专家包目录>
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

# llm_call 签名：llm_call(agent_id, system, user, tools) -> str
LlmCall = Callable[[str, str, str, Optional[list]], str]


# ---------------------------------------------------------------- 基础结构

@dataclass
class AgentDef:
    agent_id: str
    frontmatter: Dict[str, str]
    body: str
    path: Path

    @property
    def display(self) -> str:
        zh = ""
        fm = self.frontmatter
        # frontmatter 可能是嵌套 dict（displayName: {en, zh}）
        dn = fm.get("displayName")
        if isinstance(dn, dict):
            zh = dn.get("zh", "")
        return zh or self.agent_id


@dataclass
class SkillDef:
    name: str
    frontmatter: Dict[str, str]
    body: str
    path: Path


@dataclass
class ExpertPackage:
    root: Path
    meta: Dict
    agents: Dict[str, AgentDef] = field(default_factory=dict)
    skills: Dict[str, SkillDef] = field(default_factory=dict)

    @property
    def expert_type(self) -> str:
        return self.meta.get("expertType", "agent")

    @property
    def name(self) -> str:
        return self.meta.get("name", self.root.name)

    @property
    def lead_id(self) -> Optional[str]:
        if self.expert_type == "team":
            return self.meta.get("teamInfo", {}).get("leadAgent") or self.meta.get("agentName")
        return self.meta.get("agentName")

    @property
    def member_ids(self) -> List[str]:
        return list(self.meta.get("teamInfo", {}).get("memberAgents", []))

    @property
    def display_name(self) -> str:
        dn = self.meta.get("displayName", {})
        return dn.get("zh") or dn.get("en") or self.name if isinstance(dn, dict) else self.name


# ---------------------------------------------------------------- 解析器

def _parse_frontmatter(text: str) -> Tuple[Dict, str]:
    """极简 YAML frontmatter 解析：支持 key: value 与一层嵌套 dict，不依赖 pyyaml。"""
    if not text.startswith("---"):
        return {}, text
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text
    fm_raw, body = parts[1], parts[2]
    fm: Dict = {}
    current_key = None
    for line in fm_raw.splitlines():
        if not line.strip() or line.strip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        stripped = line.strip()
        if indent > 0 and current_key:
            if ":" in stripped:
                k, _, v = stripped.partition(":")
                if not isinstance(fm.get(current_key), dict):
                    fm[current_key] = {}
                fm[current_key][k.strip()] = v.strip().strip('"').strip("'")
        elif ":" in stripped:
            k, _, v = stripped.partition(":")
            current_key = k.strip()
            v = v.strip()
            fm[current_key] = v.strip('"').strip("'") if v else {}
    return fm, body.strip()


def _find_plugin_json(root: Path) -> Path:
    for rel in (".codebuddy-plugin/plugin.json", ".workbuddy-plugin/plugin.json", "plugin.json"):
        p = root / rel
        if p.is_file():
            return p
    raise FileNotFoundError(f"未找到 plugin.json（已尝试 .codebuddy-plugin/、.workbuddy-plugin/、根目录）：{root}")


def load_package(root: Path) -> ExpertPackage:
    """加载专家包。agents 字段兼容三种写法：目录字符串、文件数组、缺省（扫 agents/*.md）。"""
    root = Path(root)
    meta = json.loads(_find_plugin_json(root).read_text(encoding="utf-8"))
    pkg = ExpertPackage(root=root, meta=meta)

    agent_paths: List[Path] = []
    agents_field = meta.get("agents")
    if isinstance(agents_field, str):
        d = root / agents_field
        agent_paths = sorted(d.glob("*.md")) if d.is_dir() else []
    elif isinstance(agents_field, list):
        for item in agents_field:
            p = root / item
            if p.is_file():
                agent_paths.append(p)
            elif p.is_dir():
                agent_paths.extend(sorted(p.glob("*.md")))
    else:
        d = root / "agents"
        if d.is_dir():
            agent_paths = sorted(d.glob("*.md"))

    for p in agent_paths:
        fm, body = _parse_frontmatter(p.read_text(encoding="utf-8"))
        pkg.agents[p.stem] = AgentDef(agent_id=p.stem, frontmatter=fm, body=body, path=p)

    skills_field = meta.get("skills", [])
    if isinstance(skills_field, str):
        skills_field = [skills_field]
    for item in skills_field:
        d = root / item
        sk_md = d / "SKILL.md"
        if sk_md.is_file():
            fm, body = _parse_frontmatter(sk_md.read_text(encoding="utf-8"))
            pkg.skills[d.name] = SkillDef(name=d.name, frontmatter=fm, body=body, path=sk_md)
    return pkg


# ---------------------------------------------------------------- 运行时

class TeamRuntime:
    """Team 型运行时：向主理人暴露与 WorkBuddy 同构的 Agent / SendMessage 工具。

    关键约定（与主理人 md 中的指令对齐，缺一不可）：
      1. Agent 工具参数为 (name, prompt, subagent_type)，两者取同一 Agent ID
      2. SendMessage(to, content) 为成员回传通道
      3. 成员子代理拥有独立 system prompt 与独立上下文
    """

    def __init__(self, package: ExpertPackage, llm_call: LlmCall):
        self.pkg = package
        self.llm = llm_call
        self.mailbox: Dict[str, List[str]] = {}
        self.trace: List[str] = []

    # ---- 工具 1：派生成员子代理 ----
    def tool_agent(self, name: str, prompt: str, subagent_type: Optional[str] = None) -> str:
        agent_id = subagent_type or name
        agent = self.pkg.agents.get(agent_id)
        if agent is None:
            raise KeyError(
                f"未知 Agent ID: {agent_id!r}；可用: {sorted(self.pkg.agents)}"
            )
        self.trace.append(f"Agent(name={name!r}, subagent_type={agent_id!r})")
        # 成员同样可获得 SendMessage 工具（用于回传），实现时可自行裁剪
        return self.llm(agent_id, agent.body, prompt, [self.tool_send_message])

    # ---- 工具 2：消息回传 ----
    def tool_send_message(self, to: str, content: str) -> str:
        self.mailbox.setdefault(to, []).append(content)
        self.trace.append(f"SendMessage(to={to!r}, {len(content)} chars)")
        return "ok"

    # ---- 编排入口 ----
    def run(self, user_query: str) -> str:
        lead_id = self.pkg.lead_id
        if not lead_id or lead_id not in self.pkg.agents:
            raise ValueError(f"主理人缺失: {lead_id!r} 不在 agents/ 中")
        lead = self.pkg.agents[lead_id]
        return self.llm(lead_id, lead.body, user_query, [self.tool_agent, self.tool_send_message])


# ---------------------------------------------------------------- 校验与 SOP 解析

def validate_package(pkg: ExpertPackage) -> List[str]:
    """静态契约校验：在不调用 LLM 的前提下尽可能发现移植隐患。"""
    problems: List[str] = []
    if not pkg.agents:
        problems.append("agents/ 为空：没有任何角色提示词")
        return problems

    if pkg.expert_type == "team":
        lead_id = pkg.lead_id
        if not lead_id:
            problems.append("teamInfo.leadAgent / agentName 缺失")
        elif lead_id not in pkg.agents:
            problems.append(f"主理人 {lead_id!r} 的 MD 不存在于 agents/")
        for mid in pkg.member_ids:
            if mid not in pkg.agents:
                problems.append(f"成员 {mid!r} 的 MD 不存在于 agents/")
        # 主理人 md 中引用的 Agent ID 必须全部有对应 MD
        if lead_id in pkg.agents:
            lead_body = pkg.agents[lead_id].body
            for ref in set(re.findall(r"`([a-z0-9]+(?:-[a-z0-9]+)+)`", lead_body)):
                if ref not in pkg.agents and not ref.startswith(("design-", "product-")) or ref in pkg.agents:
                    if ref not in pkg.agents and "-" in ref and len(ref) > 6:
                        problems.append(f"主理人 md 引用了不存在的 Agent ID: {ref!r}")
    else:
        if pkg.meta.get("agentName") and pkg.meta["agentName"] not in pkg.agents:
            problems.append(f"agentName {pkg.meta['agentName']!r} 的 MD 不存在")

    # 工具契约提示（信息级，不算错误）
    tools_referenced = set()
    for a in pkg.agents.values():
        for t in ("Agent", "SendMessage", "TeamCreate"):
            if re.search(rf"\b{t}\b", a.body):
                tools_referenced.add(t)
    pkg_meta_note = f"[info] 提示词引用的工具: {sorted(tools_referenced) or '无'} —— 移植时需在运行时注册同名工具或全局替换"
    return problems + [pkg_meta_note]


def parse_sop(lead_body: str) -> List[Tuple[str, List[str]]]:
    """从主理人 md 的代码块中解析 SOP 阶段图，返回 [(阶段描述, [成员ID...])]。

    兼容两种官方写法：
      Phase 1 需求发现 ── discovery-analyst（许明需）
      discovery-analyst → 基本面+财务
    """
    phases: List[Tuple[str, List[str]]] = []
    for block in re.findall(r"```(?:\w*)\n(.*?)```", lead_body, re.S):
        for line in block.splitlines():
            if "Phase" not in line and "──" not in line and "→" not in line:
                continue
            ids = re.findall(r"`?([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`?", line)
            ids = [i for i in ids if not i.startswith(("design-engine-", "product-"))]
            desc = re.sub(r"[`─→↓|]", " ", line)
            desc = re.sub(r"\s+", " ", desc).strip()
            if ids or "Phase" in line:
                phases.append((desc, ids))
    # 去重（同一阶段可能被 ── 和 → 两种线型重复捕获）
    seen, unique = set(), []
    for desc, ids in phases:
        key = (desc, tuple(ids))
        if key not in seen:
            seen.add(key)
            unique.append((desc, ids))
    return unique


# ---------------------------------------------------------------- DryRun（无 LLM 的编排演练）

class DryRunLLM:
    """不调用真实模型的 llm_call：记录调度意图，用于验证工具契约与 SOP 可解析性。"""

    def __init__(self, pkg: ExpertPackage):
        self.pkg = pkg
        self.log: List[str] = []

    def __call__(self, agent_id: str, system: str, user: str, tools: Optional[list]) -> str:
        role = "主理人" if agent_id == self.pkg.lead_id else "成员"
        self.log.append(
            f"[dry-run] {role} {agent_id!r} 收到任务（system {len(system)} 字符，"
            f"tools={[getattr(t, '__name__', str(t)) for t in (tools or [])]}）"
        )
        return f"<dry-run output of {agent_id}>"


def dry_run_team(pkg: ExpertPackage, query: str) -> List[str]:
    """模拟一次团队任务：验证 lead 可定位、成员可派生、SOP 可解析。"""
    rt = TeamRuntime(pkg, DryRunLLM(pkg))
    rt.run(query)
    log = list(rt.llm.log)  # type: ignore[attr-defined]
    phases = parse_sop(pkg.agents[pkg.lead_id].body) if pkg.lead_id in pkg.agents else []
    if phases:
        log.append("[dry-run] SOP 静态解析结果：")
        for desc, ids in phases:
            log.append(f"    {desc}  ->  派生 {ids or '（主理人汇编）'}")
    return log


# ---------------------------------------------------------------- CLI

def _cmd_list(dirs: List[str]) -> int:
    for d in dirs:
        try:
            pkg = load_package(d)
        except Exception as e:
            print(f"[跳过] {d}: {e}")
            continue
        kind = "专家团" if pkg.expert_type == "team" else "专家"
        print(f"\n■ {pkg.display_name}  [{kind}]  ({pkg.root})")
        print(f"  expertType={pkg.expert_type}  agentName={pkg.meta.get('agentName')}")
        if pkg.expert_type == "team":
            print(f"  主理人: {pkg.lead_id}")
            print(f"  成员:   {', '.join(pkg.member_ids)}")
        print(f"  角色 MD: {', '.join(sorted(pkg.agents))}")
        print(f"  技能:   {', '.join(sorted(pkg.skills)) or '无'}")
    print()
    return 0


def _cmd_show(d: str, agent_id: str) -> int:
    pkg = load_package(d)
    agent = pkg.agents.get(agent_id)
    if not agent:
        print(f"未找到 {agent_id!r}；可用: {sorted(pkg.agents)}")
        return 1
    print(f"===== {agent_id} ({agent.path}) =====")
    print(f"--- frontmatter ---\n{json.dumps(agent.frontmatter, ensure_ascii=False, indent=2)}")
    print(f"--- body ({len(agent.body)} chars) ---")
    print(agent.body[:2000])
    if len(agent.body) > 2000:
        print(f"... [省略 {len(agent.body) - 2000} 字符]")
    return 0


def _cmd_validate(dirs: List[str]) -> int:
    exit_code = 0
    for d in dirs:
        try:
            pkg = load_package(d)
        except Exception as e:
            print(f"[错误] {d}: {e}")
            exit_code = 1
            continue
        problems = validate_package(pkg)
        hard = [p for p in problems if not p.startswith("[info]")]
        status = "FAIL" if hard else "PASS"
        print(f"[{status}] {pkg.display_name} ({pkg.root})")
        for p in problems:
            print(f"    - {p}")
        if hard:
            exit_code = 1
    return exit_code


def _cmd_sop(d: str) -> int:
    pkg = load_package(d)
    lead_id = pkg.lead_id
    if not lead_id or lead_id not in pkg.agents:
        print("非 team 型或主理人缺失，无 SOP 可解析")
        return 1
    phases = parse_sop(pkg.agents[lead_id].body)
    print(f"SOP of {pkg.display_name}（{len(phases)} 个阶段）：\n")
    for i, (desc, ids) in enumerate(phases, 1):
        print(f"  {i:>2}. {desc}")
        print(f"      派生成员: {', '.join(ids) if ids else '（主理人汇编）'}")
    return 0


def _cmd_dryrun(d: str, query: str) -> int:
    pkg = load_package(d)
    if pkg.expert_type != "team":
        agent = pkg.agents.get(pkg.lead_id or "")
        print(f"[dry-run] agent 型专家 {pkg.display_name}")
        print(f"    接入方式: system = agents/{pkg.lead_id}.md 全文（{len(agent.body) if agent else 0} 字符）")
        print(f"    工具依赖: 无（单代理直调）")
        return 0
    for line in dry_run_team(pkg, query):
        print(line)
    return 0


def main(argv: List[str]) -> int:
    if len(argv) < 3:
        print(__doc__)
        return 2
    cmd, rest = argv[1], argv[2:]
    if cmd == "list":
        return _cmd_list(rest)
    if cmd == "show":
        if len(rest) < 2:
            print("用法: show <专家包目录> <agent-id>")
            return 2
        return _cmd_show(rest[0], rest[1])
    if cmd == "validate":
        return _cmd_validate(rest)
    if cmd == "sop":
        return _cmd_sop(rest[0])
    if cmd == "dryrun":
        if len(rest) < 2:
            print("用法: dryrun <专家包目录> \"<任务描述>\"")
            return 2
        return _cmd_dryrun(rest[0], rest[1])
    print(f"未知命令: {cmd}")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
