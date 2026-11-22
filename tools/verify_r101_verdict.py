#!/usr/bin/env python3
"""R101 M2-c：裁决报告校验器（blocked 三锁的落地判据）

PRD §3.2 定义了三把锁，各自防一种造假路径：

  数据锁 — blocked 维度不得带任何数值字段。防「给 blocked 编一个数」。
  计分锁 — 覆盖率 = Σ(已测 A 类权重)/100，由 `dims[].status` + PRD 权重表**派生**。
           防「拿理论上限当当前值」，也防「把 blocked 权重摊给 A 类，造出看起来
           100% 覆盖的假象」。上限 80/100 单列在 `coverageCeiling`，不与当前值共用字段。
  声明锁 — 两句声明必须逐字命中。防「把不可测说成没测」。缺字即无效裁决。

为什么必须有一个独立的校验器（而不是靠写报告的人自觉）：
  这三条都是「缺席断言」—— 它们验证的是「某个值没有出现 / 某句话必须在」。
  缺席断言最容易失效：报告里少一个字段，人眼看不出来；把 80 改成 100，
  也没人会发现。所以必须由代码读字节来判断。

用法：
  python tools/verify_r101_verdict.py deliverables/dev-plan/r101-evidence/verdict.json
  python tools/verify_r101_verdict.py <file> --expect-fail   # 负控用：期望 rc!=0

退出码：0 = 全部通过；1 = 有违规；2 = 文件不可读/不可解析
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# 声明锁：这两句必须逐字出现（PRD §3.2 锁 3）
DECL_MAIN = (
    "在 B 类 blocked 维度（DisplayLatency / 异 DPI 双屏连续拖拽 / 真实中文 IME 候选框定位）上，"
    "本机无法区分两条通路，因此本裁决仅基于 A 类维度。"
)
DECL_IME = "IME 维度两通路均 blocked，裁决不依据该维度"

# ── 覆盖率：派生，不硬编码 ────────────────────────────────────────────
# PRD §4.0 权威权重表。这是「常量」，不是「测量结果」，因此写在代码里是对的；
# 但覆盖率 = Σ(参与裁决的 A 类权重) / 100 是「派生量」，绝不能写成字面量。
#
# 为什么改（R101 实测教训）：原实现 `COVERAGE_EXPECTED = "80/100"`，只能校验
# 「报告里是否写了 80」，无法校验「80 是不是算出来的」。后果是双向失效：
#   · 一份正确的 30/100 会被判红；
#   · 一份把 D1/D3 都算成已覆盖、只要仍写 "80/100" 的会被判绿。
# 这与 E16c 的 `nonBlack > 0` 同类失效，且发生在计分锁本身 —— 锁失效了。
PRD_WEIGHTS = {
    "D1": 30,   # 层间对齐偏差
    "D2": 30,   # 单帧开销与节拍
    "D3": 20,   # 长稳
    "B2": 10,   # 异 DPI 双屏连续拖拽
    "B3": 10,   # 真实中文 IME 候选框定位
}
A_CLASS = ("D1", "D2", "D3")
COVERAGE_CEILING = sum(PRD_WEIGHTS[k] for k in A_CLASS)   # = 80，派生自权重表

# 状态枚举：参与计分 / 未参与计分。
# 第三个集合必须存在 —— 未知状态不许「静默按未参与处理」，否则写错一个
# 状态名就会悄悄把覆盖率算小，且看不出来。
STATUS_MEASURED = {"pass", "tie", "measured"}
STATUS_NOT_MEASURED = {"blocked"}
STATUS_ALL = STATUS_MEASURED | STATUS_NOT_MEASURED

# 数据锁：blocked 维度允许出现的键（除此之外出现数值即违规）
BLOCKED_ALLOWED_KEYS = {"id", "name", "weight", "reason"}

# 必须出现的维度 id（缺一个就说明报告漏了维度）
REQUIRED_BLOCKED = {"B2", "B3"}


def derive_coverage(dims: list[dict]) -> tuple[int, list[str]]:
    """Σ(参与裁决的 A 类权重)，并回传参与计分的 dim id 列表。"""
    total = 0
    counted: list[str] = []
    for d in dims:
        did = str(d.get("id"))
        if did not in A_CLASS:
            continue
        if d.get("status") in STATUS_MEASURED:
            total += PRD_WEIGHTS[did]
            counted.append(did)
    return total, counted


def parse_ratio(s) -> tuple[int, int] | None:
    """把 "60/100" 解析成 (60, 100)；无法解析返回 None。"""
    if not isinstance(s, str) or s.count("/") != 1:
        return None
    a, b = s.split("/")
    try:
        return int(a), int(b)
    except ValueError:
        return None


class Gate:
    def __init__(self) -> None:
        self.failures: list[str] = []
        self.checks = 0

    def ok(self, cond: bool, label: str, detail: str = "") -> bool:
        self.checks += 1
        if cond:
            print(f"  [PASS] {label}" + (f"  {detail}" if detail else ""))
            return True
        print(f"  [FAIL] {label}" + (f"  {detail}" if detail else ""))
        self.failures.append(label)
        return False


def is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("verdict", type=Path)
    ap.add_argument("--expect-fail", action="store_true",
                    help="negative control: assert this file MUST be rejected")
    args = ap.parse_args(argv)

    try:
        doc = json.loads(args.verdict.read_text(encoding="utf-8"))
    except Exception as err:
        print(f"FATAL: cannot read/parse {args.verdict}: {err}")
        return 2

    g = Gate()
    print("=" * 74)
    print("R101 M2-c 裁决报告校验（blocked 三锁）")
    print("=" * 74)

    # ---------- 锁 1：数据锁 ----------
    print("\n--- 数据锁：blocked 维度不得携带任何数值 ---")
    blocked = doc.get("blockedDimensions")
    g.ok(isinstance(blocked, list), "blockedDimensions is a list",
         f"got {type(blocked).__name__}")

    if isinstance(blocked, list):
        seen_ids = set()
        for i, dim in enumerate(blocked):
            if not isinstance(dim, dict):
                g.ok(False, f"blocked[{i}] is an object")
                continue
            did = dim.get("id", f"#{i}")
            seen_ids.add(str(did))

            extra = set(dim.keys()) - BLOCKED_ALLOWED_KEYS
            # 允许的键里只有 weight 是数值；其余（id/name/reason/weight）都合规。
            # 任何其它键，尤其是 score/p50/p95/delta 这类，都是「给 blocked 编了数」。
            numeric_extra = [k for k in extra if is_number(dim.get(k))]
            g.ok(not extra,
                 f"blocked[{did}] has no extra fields",
                 f"extra={sorted(extra)}" if extra else "")
            g.ok(not numeric_extra,
                 f"blocked[{did}] carries no numeric score",
                 f"numeric={numeric_extra}" if numeric_extra else "")

            # weight 只允许出现在计分维度里，且不能是「参与裁决」的证据
            g.ok("reason" in dim, f"blocked[{did}] has a reason")

        g.ok(REQUIRED_BLOCKED.issubset(seen_ids),
             "all required blocked dimensions present",
             f"missing={sorted(REQUIRED_BLOCKED - seen_ids)}"
             if not REQUIRED_BLOCKED.issubset(seen_ids) else "")

    # ---------- 锁 2：计分锁（派生式）----------
    print("\n--- 计分锁：覆盖率 = Σ(已测 A 类权重)/100，禁用字面量 ---")
    cov = doc.get("coverage") or {}
    dims_raw = doc.get("dims")

    # 2a. dims 数组必须存在 —— 没有它，覆盖率无从派生。
    has_dims = isinstance(dims_raw, list) and len(dims_raw) > 0
    g.ok(has_dims, "dims array present and non-empty (覆盖率必须可派生)",
         "" if has_dims else f"got {type(dims_raw).__name__}={dims_raw!r}")
    if not has_dims:
        print("  [SKIP] 后续覆盖率派生校验因缺 dims 全部跳过 —— 这不是通过")
        g.ok(False, "coverage derivation not skipped",
             "缺 dims 使派生无法进行，按失败处理（SKIP 在汇总里等于假绿）")

    dims = dims_raw if has_dims else []

    # 2b. 每个 dim 的 id 必须在 PRD 权重表里，status 必须在已知枚举里
    for i, d in enumerate(dims):
        if not isinstance(d, dict):
            g.ok(False, f"dims[{i}] is an object")
            continue
        did = str(d.get("id", f"#{i}"))
        g.ok(did in PRD_WEIGHTS, f"dims[{did}] id is a PRD dimension",
             "" if did in PRD_WEIGHTS else f"unknown id {did!r} (PRD keys={sorted(PRD_WEIGHTS)})")
        st = d.get("status")
        g.ok(st in STATUS_ALL, f"dims[{did}] status is a known enum",
             "" if st in STATUS_ALL else f"got {st!r}, allowed={sorted(STATUS_ALL)}")
        # weight 是 PRD 常量，不因 status 改写
        g.ok(d.get("weight") == PRD_WEIGHTS.get(did),
             f"dims[{did}] weight == PRD constant {PRD_WEIGHTS.get(did)}",
             f"got {d.get('weight')!r}")

    # 2c. 派生值与声明值必须一致 —— 这是本条锁的核心
    derived, counted = derive_coverage(dims)
    got = parse_ratio(cov.get("coverage"))
    g.ok(got is not None, "coverage is a parseable 'N/100' ratio",
         f"got {cov.get('coverage')!r}")
    if got is not None:
        g.ok(got[1] == 100, "coverage denominator is 100 (未归一化)",
             f"got {got[1]}")
        g.ok(got[0] == derived,
             f"coverage numerator == derived Σ(weights) == {derived}",
             f"declared {got[0]}, derived {derived}, counted={counted}")

    # 2d. 理论上限单列，不得与 coverage 同名字段混用
    ceiling = parse_ratio(cov.get("coverageCeiling"))
    g.ok(ceiling is not None, "coverageCeiling present (理论上限必须单列)",
         f"got {cov.get('coverageCeiling')!r}")
    if ceiling is not None:
        g.ok(ceiling[0] == COVERAGE_CEILING,
             f"coverageCeiling == {COVERAGE_CEILING} (派生自权重表)",
             f"got {ceiling[0]}")

    # 2e. 反例：覆盖率不得超过理论上限，也不得被归一化到 100
    raw = str(cov.get("coverage", ""))
    g.ok(not raw.startswith("100"), "coverage is not normalized to 100", raw)
    if got is not None:
        g.ok(got[0] <= COVERAGE_CEILING,
             f"coverage <= ceiling {COVERAGE_CEILING}",
             f"got {got[0]}")

    g.ok(cov.get("notNormalized") is True,
         "notNormalized flag is true")

    # 2f. 已测维度必须有数据锚点（结构与证据的衔接）。
    # 不设这条会留一个真实漏洞：把 D1 的 status 从 blocked 改成 pass、覆盖率
    # 同步改成 60/100，本校验器会全绿（内部完全自洽）—— 但 D1 根本没有数据。
    # 所以清单中的每个已测维度，必须能指向一个证据文件，**且该文件真实存在**。
    #
    # 「存在性」是这里的分水岭：只校验字段非空，挡不住"填一个不存在的路径"——
    # 我实测过，一套全套伪造（D1 虚报 pass + 覆盖 60/100 + 两个虚构锚点）
    # 在只判字段的版本下以 rc=0 全绿通过。所以必须 stat 到盘上。
    #
    # 仍不能证明数据是真的（只能靠人复核证据内容），但把造假成本从
    # 「改一个词」抬到「伪造一整套真实文件」。
    # 锚点的相对路径基准 = 工程根，不是 verdict 文件所在目录。
    #
    # 踩过的坑：最初写成「从 verdict 所在目录向上找 tools/」，当 verdict 放在
    # TEMP 里跑负控时，向上一直走到 C:\ 才停 -> repo_root = C:\ ->
    # 真实存在的 deliverables/... 被判成不存在，正样本假红。
    # 基准必须与「被测文件放在哪」解耦，所以顺序是：
    #   ① 显式 env 覆盖  ② cwd（正常用法就是在工程根跑）  ③ 从 cwd 向上找
    env_root = os.environ.get("R101_REPO_ROOT")
    if env_root:
        repo_root = Path(env_root).resolve()
    else:
        cand = Path.cwd().resolve()
        probe = cand
        while probe != probe.parent and not (probe / "tools").is_dir():
            probe = probe.parent
        repo_root = probe if (probe / "tools").is_dir() else cand

    declared_measured = [d for d in dims
                         if isinstance(d, dict) and d.get("status") in STATUS_MEASURED]
    for d in declared_measured:
        did = str(d.get("id"))
        refs = [d.get(k) for k in ("evidence", "evidenceFile")]
        refs = [r for r in refs if isinstance(r, str) and r.strip()]
        has_metrics = isinstance(d.get("metrics"), list) and bool(d.get("metrics"))
        ok_anchor, why = False, ""
        if has_metrics:
            ok_anchor = True
        elif not refs:
            why = "无 metrics / evidence / evidenceFile —— 声称已测却无数据锚点"
        else:
            # 每个引用都必须能在盘上找到（目录或文件均可）
            missing = []
            for r in refs:
                p = Path(r)
                cand = p if p.is_absolute() else (repo_root / p)
                if not cand.exists():
                    missing.append(str(cand))
            ok_anchor = not missing
            if missing:
                why = f"锚点在磁盘上不存在: {missing}"
        g.ok(ok_anchor,
             f"dims[{did}] declared status={d.get('status')!r} must carry a RESOLVABLE evidence anchor",
             why)

    # ---------- 锁 3：声明锁 ----------
    print("\n--- 声明锁：两句逐字命中 ---")
    blob = json.dumps(doc, ensure_ascii=False)
    g.ok(DECL_MAIN in blob, "mandatory declaration present verbatim")
    g.ok(DECL_IME in blob, "per-dimension IME declaration present verbatim")

    # ---------- 附加：裁决级别与必备字段 ----------
    print("\n--- 裁决级别与必备字段 ---")
    lvl = doc.get("verdict")
    g.ok(lvl in {"decided", "conditional", "void"},
         "verdict level is one of decided/conditional/void", f"got {lvl!r}")
    if lvl == "conditional":
        g.ok(bool(blocked), "conditional verdict must list blocked dimensions")
    g.ok(bool(doc.get("scopeLimits")), "scopeLimits present (口径边界必须写明)")
    g.ok(bool(doc.get("evidenceFiles")), "evidenceFiles present (证据索引)")

    # ---------- 汇总 ----------
    print("\n" + "=" * 74)
    if args.expect_fail:
        if g.failures:
            print(f"NEG-CONTROL: correctly REJECTED ({len(g.failures)} violations)  rc=0")
            return 0
        print("NEG-CONTROL FAILED: file was accepted but should have been rejected")
        return 1

    if g.failures:
        print(f"RESULT: FAIL  ({len(g.failures)} of {g.checks} checks failed)  rc=1")
        for f in g.failures:
            print(f"  - {f}")
        return 1
    print(f"RESULT: PASS  (all {g.checks} checks passed)  rc=0")
    return 0


if __name__ == "__main__":
    sys.exit(main())