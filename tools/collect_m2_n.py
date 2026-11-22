#!/usr/bin/env python3
"""R101 M2-b：A/B × 60Hz/165Hz × 3 轮 的噪声基线 N 采集驱动。

为什么需要这个脚本（而不是手工跑 12 次）：
  P0-13 要求「同参数、同采集器版本、同采集节拍」的重复轮次，且 A/B 两通路的
  采集入口完全不同（A 是 dcomp_demo.exe，B 是 electron osr_demo.js）。手工跑
  极易在 env 上漂移一格（比如忘了 OSR_HZ，或 A 侧漏了 DCOMP_JSONL），而漂移
  不会报错——只会静默产出一份「看起来正常」的不可比数据。R401 的教训是：
  参数漂移是假 tie 的主要来源，所以驱动必须自己把参数钉住并落盘。

用法：
  python tools/collect_m2_n.py --pathway A --tier 165 --rounds 3 --out qa/r101/out/dev
  python tools/collect_m2_n.py --pathway B --tier 60  --rounds 3 --out qa/r101/out/dev

设计约束（每条都有血债）：
  1. 每轮必须换 runId 与输出文件名 —— 覆盖会让「3 轮」退化成 1 轮而计数仍是 3。
  2. B 侧必须 scrub ELECTRON_RUN_AS_NODE / NODE_OPTIONS —— 否则 electron 退化成
     纯 Node 秒退 0，而退出码 0 会被当成「跑完了」。
  3. 每轮结束立刻回读该轮的统计行，缺失即 fail —— 不靠事后统一解析。
  4. N 逐档算，禁止跨档复用（PRD P0-13）。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
A_EXE = ROOT / "native" / "build" / "m2probe" / "t02out" / "dcomp_demo.exe"
B_ELECTRON = ROOT / "node_modules" / "electron" / "dist" / "electron.exe"
B_DEMO = ROOT / "native" / "spike-glass" / "src" / "osr_demo.js"

# 采集窗口：PRD M2-b 规定 60s × 3 轮。A 侧 frames 由实测节拍换算，
# 不写死帧数 —— 写死会让不同档位拿到不同时长，噪声不可比。
COLLECT_SECONDS = 60


def pct(vals: list[float], p: float) -> float:
    if not vals:
        return float("nan")
    s = sorted(vals)
    k = p * (len(s) - 1)
    lo = int(k)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] * (1 - (k - lo)) + s[hi] * (k - lo)


def parse_kv(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if "=" in line and not line.startswith("{"):
            k, _, v = line.partition("=")
            k = k.strip()
            if k and all(c.isalnum() or c == "_" for c in k):
                out[k] = v.strip()
    return out


def run_a(tier: int, outdir: Path, run_id: str) -> dict:
    frames = int(COLLECT_SECONDS * (165 if tier == 165 else 60) * 1.02)
    jsonl = outdir / f"timing-A-{tier}-{run_id}.jsonl"
    env = dict(os.environ)
    env["DCOMP_JSONL"] = str(jsonl)
    cp = subprocess.run(
        [str(A_EXE), f"--frames={frames}"],
        capture_output=True, text=True, env=env, timeout=COLLECT_SECONDS * 3,
    )
    kv = parse_kv(cp.stdout)
    kv["_exit"] = str(cp.returncode)
    kv["_jsonl"] = str(jsonl)
    kv["_frames_requested"] = str(frames)
    return kv


def run_b(tier: int, outdir: Path, run_id: str) -> dict:
    env = dict(os.environ)
    # 血债：这两个变量会把 electron 变成纯 Node 进程，秒退 0
    env.pop("ELECTRON_RUN_AS_NODE", None)
    env.pop("NODE_OPTIONS", None)
    env["OSR_HZ"] = str(tier)
    env["OSR_COLLECT_MS"] = str(COLLECT_SECONDS * 1000)
    # B 侧结果落 native/build/t03/osr-demo-<hz>hz-<label>.json（rawLog 含全部判据行）。
    # 路径基准是 osr_demo.js 的 `path.join(__dirname,'..','..','build','t03')`，
    # 而 __dirname 是 native/spike-glass/src ⇒ 上两级是 native/ ⇒ native/build/t03。
    # （不是 spike-glass/build/t03 —— 我第一版就写错了，导致三轮全部读不到。）
    result_file = ROOT / "native" / "build" / "t03" / \
        f"osr-demo-{tier}hz-{run_id}.json"
    if result_file.exists():
        result_file.unlink()

    env["OSR_LABEL"] = run_id
    cp = subprocess.run(
        [str(B_ELECTRON), str(B_DEMO)],
        capture_output=True, text=True, env=env, timeout=COLLECT_SECONDS * 3,
    )

    kv: dict = {"_exit": str(cp.returncode), "_resultFile": str(result_file)}
    if not result_file.exists():
        kv["_error"] = "result json not written"
        kv["_stdout"] = cp.stdout[-2000:]
        return kv

    data = json.loads(result_file.read_text(encoding="utf-8"))
    # 直接取结构化字段（比解析 stdout 稳：rawLog 里的数字曾用 toFixed 截断）
    kv["_resultFile"] = str(result_file)
    for key in ("rafFps", "textureRatio", "vsyncBaseMs", "maxGapMs",
                "maxGapCycles", "ratioVsTarget", "withTexture", "rafFrames",
                "released", "tierHz", "collectMs", "allPass",
                "hostIntervalP50Ms", "hostIntervalP95Ms", "hostIntervalP99Ms",
                "hostIntervalSamples", "hostDrops", "hostDropRate"):
        if key in data:
            kv[key] = data[key]
    crit = data.get("criteria") or {}
    for k, v in crit.items():
        kv[f"c_{k}"] = v
    return kv


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pathway", required=True, choices=["A", "B"])
    ap.add_argument("--tier", required=True, type=int, choices=[60, 165])
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args(argv)

    outdir = args.out
    outdir.mkdir(parents=True, exist_ok=True)

    rounds: list[dict] = []
    for r in range(1, args.rounds + 1):
        run_id = f"r{r:02d}"
        print(f"===== {args.pathway} tier={args.tier} round={r}/{args.rounds} =====",
              flush=True)
        kv = run_a(args.tier, outdir, run_id) if args.pathway == "A" \
            else run_b(args.tier, outdir, run_id)
        rounds.append(kv)
        keep = {k: v for k, v in kv.items() if k != "_stdout"}
        print(json.dumps(keep, ensure_ascii=False)[:600], flush=True)

    # ---- 汇总：N = 三轮极差（不是 σ） ----
    summary: dict = {
        "pathway": args.pathway,
        "tier": args.tier,
        "rounds": args.rounds,
        "collectSeconds": COLLECT_SECONDS,
        "perRound": [{k: v for k, v in d.items() if k != "_stdout"} for d in rounds],
    }

    if args.pathway == "A":
        # 注意命名：dcomp_demo 的 CPU_FRAME_MS_* 实际是「清屏+Present+Wait」整圈墙钟
        # （源码 L148-150 有注释），不是 CPU 纯开销。忠实按它的物理含义命名，
        # 避免又把两个量混成一个名字（元规则第五条）。
        metrics = {
            "presentP50": "LOOP_PERIOD_MS_P50",
            "presentP95": "LOOP_PERIOD_MS_P95",
            "presentP99": "LOOP_PERIOD_MS_P99",
            "dropRate": "DROP_RATE",
            "frameSpanP50": "CPU_FRAME_MS_P50",
        }
    else:
        # B 侧主统计量与 A 侧对齐（同物理量、同字段语义），否则 Δ/N 无从比较。
        metrics = {
            "presentP50": "hostIntervalP50Ms",
            "presentP95": "hostIntervalP95Ms",
            "presentP99": "hostIntervalP99Ms",
            "dropRate": "hostDropRate",
            "textureRatio": "textureRatio",
        }

    noise: dict[str, dict] = {}
    for name, key in metrics.items():
        vals = []
        for d in rounds:
            raw = d.get(key)
            if raw is None:
                continue
            try:
                vals.append(float(raw))
            except ValueError:
                continue
        if len(vals) < 2:
            noise[name] = {"values": vals, "range": None,
                           "error": "fewer than 2 rounds parsed"}
            continue
        noise[name] = {
            "values": vals,
            "min": min(vals),
            "max": max(vals),
            "range": max(vals) - min(vals),          # N = 极差
            "relRange": (max(vals) - min(vals)) / (sum(vals) / len(vals))
            if sum(vals) else None,
        }
    summary["noise"] = noise

    sp = outdir / f"noise-{args.pathway}-{args.tier}.json"
    sp.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nNOISE_FILE={sp}")
    for name, d in noise.items():
        if d.get("range") is None:
            print(f"N[{name}] = UNRESOLVED ({d.get('error')})")
        else:
            print(f"N[{name}] = {d['range']:.6g}  "
                  f"(values={['%.4f' % v for v in d['values']]})")
    return 0


if __name__ == "__main__":
    sys.exit(main())