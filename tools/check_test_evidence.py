#!/usr/bin/env python3
"""测试证据自检 —— 在跑 pytest 前确认证据目录是否齐备。

背景（R100，2026-11-19）：
    磁盘清理时把 11 个 pytest 证据目录中的 5 个误判为一次性调试产物删除，
    导致 9 项测试失败。这 5 组已从 Windows 回收站完整恢复（见 KNOWN_ISSUES.md §31）。
    剩余 1 项（已退役构建链的隔离 venv）未能恢复，对应测试为 skipped。

    证据从未入 git（.gitignore 排除 outputs/），删除不可逆、只能靠回收站在位。
    本脚本只做诊断，不改变任何测试的 PASS/FAIL 判定，也不生成证据。
    用途：区分「证据缺失」与「代码回归」——两者在 pytest 汇总行里长得一样。

用法：
    python tools/check_test_evidence.py            # 人读摘要
    python tools/check_test_evidence.py --json     # 机器读
    python tools/check_test_evidence.py --strict   # 任一缺失即退出码 1

退出码：0 = 全部齐备；1 = 有缺失（仅 --strict 时）
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# (相对路径, 依赖测试, 说明)
EVIDENCE = [
    # --- 原 6 组（R100 未受影响）---
    ("outputs/ui-w4a", "test_w4a_visual.py", "视觉证据"),
    ("outputs/ui-w4b", "test_w4b_visual.py", "视觉证据"),
    ("outputs/collaboration-w5e4", "test_collaboration_visual.py", "视觉证据"),
    ("outputs/expert-w5d", "test_expert_visual.py", "视觉证据"),
    ("outputs/generative-g4", "test_generative_visual.py", "视觉证据"),
    ("outputs/pytest-tmp", "conftest.py (basetemp)", "证据归档"),
    # --- R100 误删后已从回收站恢复的 5 组 ---
    ("outputs/chat-log-centering", "test_chat_log_centering.py (5 项)", "已恢复"),
    ("outputs/frontend/w3c1-semantic-equivalence.json", "test_frontend_tree.py", "已恢复"),
    ("outputs/generative-g1/layout-report.json", "test_generative_registry.py", "已恢复"),
    ("outputs/generative-g3", "test_generative_dom.py", "已恢复"),
    ("outputs/perf/w7-w8-gate.json", "test_w7_w8_gate.py", "已恢复"),
]

# 未能恢复、且判定为「应保持 skipped」的项（不计入失败）
KNOWN_SKIPPED = [
    (
        "outputs/release-w9-candidate/venv/Scripts/python.exe",
        "test_windows_packaging_dependencies.py::test_isolated_build_environment_has_complete_pywebview_runtime",
        "已退役 PyInstaller/pywebview 构建链的隔离 venv；未能从回收站取回，见 KNOWN_ISSUES §31.4",
    ),
]


def inspect() -> dict:
    missing, present = [], []
    for rel, consumer, kind in EVIDENCE:
        path = ROOT / rel
        item = {"path": rel, "consumer": consumer, "kind": kind}
        (present if path.exists() else missing).append(item)

    skipped = []
    for rel, consumer, why in KNOWN_SKIPPED:
        skipped.append({
            "path": rel, "consumer": consumer, "reason": why,
            "exists": (ROOT / rel).exists(),
        })

    return {"present": present, "missing": missing, "known_skipped": skipped}


def main(argv: list[str]) -> int:
    report = inspect()
    as_json = "--json" in argv
    strict = "--strict" in argv

    if as_json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 1 if (strict and report["missing"]) else 0

    line = "=" * 72
    print(line)
    print("测试证据自检（只诊断，不改变 PASS/FAIL）")
    print(line)

    print(f"\n[齐备] {len(report['present'])} 项")
    for i in report["present"]:
        print(f"  OK   {i['path']}  ->  {i['consumer']}  [{i['kind']}]")

    if report["missing"]:
        print(f"\n[!! 缺失 -- 这些会让测试报 failed] {len(report['missing'])} 项")
        for i in report["missing"]:
            print(f"  MISS {i['path']}  ->  {i['consumer']}")
        print("  处置：证据未入 git，无历史可回滚；优先查回收站（$I 元数据），")
        print("        用 tools/restore_from_recycle.py 恢复。")
    else:
        print("\n[!! 缺失] 0 项（11 组证据全部就位）")

    print(f"\n[已知 skipped -- 不影响失败判定] {len(report['known_skipped'])} 项")
    for i in report["known_skipped"]:
        flag = "存在" if i["exists"] else "缺失"
        print(f"  SKIP {i['path']}  [{flag}]")
        print(f"       -> {i['consumer']}")
        print(f"       {i['reason']}")

    print("\n" + line)
    print("结论：")
    if report["missing"]:
        print(f"  证据链不完整：有 {len(report['missing'])} 项缺失，"
              "先补齐再跑 pytest，否则失败原因难辨。")
    else:
        print("  证据链完整。pytest 若出现 failed，应视为源码回归信号——")
        print("  R100 的 9 项证据缺失已全部恢复，不再是失败借口。")
        print("  skipped 项属已退役构建链，保持现状即可。")

    return 1 if (strict and report["missing"]) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))