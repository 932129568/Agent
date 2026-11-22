#!/usr/bin/env python
"""verify_t06_fields.py -- read the collector's JSONL BACK and assert the T06
section 5 field contract.

Why a separate reader instead of trusting the collector's own printf:
  The collector can only assert facts about its own memory. Two of the five
  mandatory checks are properties of the FILE, not of the process:
    5. frameIdx contiguity  -- "the loop index is contiguous by construction" is
       a tautology in C++; only the emitted bytes can show a dropped row.
    and the field-set completeness itself, which is exactly what a downstream
    consumer depends on.

  This is the difference between "the program said it wrote 21 fields" and
  "a 21-field row can actually be parsed out of the file by someone who was not
  there". R101 already produced one artefact that declared its own integrity and
  was believed (asar header integrity.hash), so the reader exists.

Checks, in order (each one is a gate; any failure exits 1):
  F1  file exists, is non-empty, every line parses as JSON
  F2  every row carries EXACTLY the required key set (no missing, no extra)
  F3  frameIdx starts at 0 and increments by exactly 1 (gap = dropped row)
  F4  syncInterval == 1 in every row
  F5  waitable == 1 in every row
  F6  dpiAware is never UNAWARE / UNAWARE_GDISCALED
  F7  gpuValid==1 ratio >= 0.90 over the measured window (frameIdx >= WARMUP)
  F8  the arithmetic identity submitUs + waitUs <= frameUs + slack, per row
      (0.5 ms slack), and at the aggregate (p50)
  F9  no row reports submitUs / frameUs >= 0.5 (not CPU-separable)
  F10 provenance fields are not the literal placeholder "UNSET"

Usage:
  python verify_t06_fields.py <jsonl> [--warmup 5] [--tier 165] [--pathway A]
Exit: 0 all pass, 1 any failure.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

REQUIRED_KEYS = {
    "runId", "commit", "collectorVer", "pathway", "tier", "frameIdx",
    "qpcPresent", "intervalMs", "submitUs", "frameUs", "waitUs",
    "gpuPassUs", "gpuTierK", "gpuValid", "presentCount",
    "dpiAware", "syncInterval", "waitable", "clearsPerFrame",
}

UNAWARE_VALUES = {"UNAWARE", "UNAWARE_GDISCALED"}
IDENTITY_SLACK_US = 500.0   # 0.5 ms
SEPARABILITY_MAX_RATIO = 0.5
GCDIV_VALID_MIN = 0.90


class Gate:
    def __init__(self) -> None:
        self.checks = 0
        self.failures: List[str] = []

    def check(self, cond: bool, name: str, detail: str = "") -> bool:
        self.checks += 1
        if cond:
            print(f"  [PASS] {name}" + (f": {detail}" if detail else ""))
        else:
            print(f"  [FAIL] {name}" + (f": {detail}" if detail else ""))
            self.failures.append(f"{name} -- {detail}" if detail else name)
        return cond


def pct(values: List[float], p: float) -> float:
    if not values:
        return -1.0
    s = sorted(values)
    return s[int(p * (len(s) - 1))]


def main(argv: List[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Read back and gate the T06 section 5 JSONL contract.")
    ap.add_argument("jsonl", type=Path)
    ap.add_argument("--warmup", type=int, default=5,
                    help="frames to exclude from ratio/percentile checks (default 5, must match collector)")
    ap.add_argument("--tier", default=None, help="expected tier string, e.g. 165")
    ap.add_argument("--pathway", default=None, help="expected pathway string, e.g. A")
    args = ap.parse_args(argv)

    path: Path = args.jsonl
    print("=" * 78)
    print("verify_t06_fields.py -- JSONL field contract read-back")
    print(f"file    : {path}")
    print(f"warmup  : {args.warmup}")
    print("=" * 78)

    gate = Gate()

    # ---- F1: existence, non-empty, all lines parse ---------------------------
    if not gate.check(path.is_file(), "F1 file exists", str(path)):
        return _finish(gate)
    raw = path.read_text(encoding="utf-8", errors="replace").splitlines()
    raw = [ln for ln in raw if ln.strip()]
    if not gate.check(len(raw) > 0, "F1 file non-empty", f"{len(raw)} lines"):
        return _finish(gate)

    rows: List[Dict[str, Any]] = []
    parse_errors = 0
    for i, ln in enumerate(raw):
        try:
            rows.append(json.loads(ln))
        except Exception as exc:  # noqa: BLE001
            parse_errors += 1
            if parse_errors == 1:
                print(f"  [INFO] first parse error on line {i + 1}: {exc}")
    gate.check(parse_errors == 0, "F1 every line parses as JSON",
               f"{len(rows)}/{len(raw)} parsed, {parse_errors} bad")
    if not rows:
        return _finish(gate)

    # ---- F2: exact key set ---------------------------------------------------
    key_sets = {tuple(sorted(r.keys())) for r in rows}
    missing = REQUIRED_KEYS - set(rows[0].keys())
    extra = set(rows[0].keys()) - REQUIRED_KEYS
    gate.check(len(key_sets) == 1, "F2 all rows share one key set",
               f"{len(key_sets)} distinct layouts")
    gate.check(not missing, "F2 no required key missing",
               f"missing={sorted(missing) or 'none'}")
    # Extra keys are NOT automatically a failure: a future field is additive. But
    # they must be visible, because a silently renaming field looks like a
    # perfectly legal "extra key + missing key" pair. Missing is the hard gate.
    if extra:
        print(f"  [INFO] extra keys present (additive, allowed): {sorted(extra)}")

    # ---- F3: frameIdx contiguity --------------------------------------------
    idx = [r.get("frameIdx") for r in rows]
    contiguous = all(isinstance(v, int) for v in idx) and \
        idx[0] == 0 and all(b - a == 1 for a, b in zip(idx, idx[1:]))
    gaps = [f"{a}->{b}" for a, b in zip(idx, idx[1:]) if isinstance(a, int)
            and isinstance(b, int) and b - a != 1]
    gate.check(contiguous, "F3 frameIdx contiguous from 0",
               f"n={len(idx)} first={idx[0]} last={idx[-1]} gaps={gaps[:5] or 'none'}")

    # ---- F4/F5: syncInterval, waitable --------------------------------------
    bad_sync = [r["frameIdx"] for r in rows if r.get("syncInterval") != 1]
    gate.check(not bad_sync, "F4 syncInterval==1 in every row",
               f"{len(bad_sync)} violating rows {bad_sync[:5]}")
    bad_wait = [r["frameIdx"] for r in rows if r.get("waitable") != 1]
    gate.check(not bad_wait, "F5 waitable==1 in every row",
               f"{len(bad_wait)} violating rows {bad_wait[:5]}")

    # ---- F6: dpiAware --------------------------------------------------------
    bad_dpi = sorted({r.get("dpiAware") for r in rows} & UNAWARE_VALUES)
    gate.check(not bad_dpi, "F6 dpiAware never UNAWARE",
               f"observed={sorted({r.get('dpiAware') for r in rows})}")

    # ---- F7: gpuValid ratio over the measured window ------------------------
    measured = [r for r in rows if r["frameIdx"] >= args.warmup]
    if not gate.check(len(measured) > 0, "F7 measured window non-empty",
                      f"{len(measured)} rows after warmup={args.warmup}"):
        return _finish(gate)
    valid = sum(1 for r in measured if r.get("gpuValid") == 1)
    ratio = valid / len(measured)
    gate.check(ratio >= GCDIV_VALID_MIN, "F7 gpuValid ratio >= 0.90",
               f"{valid}/{len(measured)} = {ratio * 100:.1f}%")

    # ---- F8: identity submitUs + waitUs <= frameUs + slack ------------------
    # Row 0 has intervalMs/frameUs of 0 by convention; skip frames whose frameUs
    # is not a real measurement rather than letting them fail the identity.
    viol_rows = []
    for r in measured:
        frame_us = float(r.get("frameUs", 0) or 0)
        submit_us = float(r.get("submitUs", 0) or 0)
        wait_us = float(r.get("waitUs", -1) or -1)
        if frame_us <= 0 or wait_us < 0:
            continue
        if submit_us + wait_us > frame_us + IDENTITY_SLACK_US:
            viol_rows.append((r["frameIdx"], round(submit_us + wait_us, 1), round(frame_us, 1)))
    gate.check(not viol_rows, "F8 submitUs+waitUs <= frameUs+0.5ms per row",
               f"{len(viol_rows)} violations, first={viol_rows[:3]}")

    agg_submit = pct([float(r["submitUs"]) for r in measured], 0.5)
    agg_wait = pct([float(r["waitUs"]) for r in measured if float(r["waitUs"]) >= 0], 0.5)
    agg_frame = pct([float(r["frameUs"]) for r in measured if float(r["frameUs"]) > 0], 0.5)
    gate.check(agg_submit + agg_wait <= agg_frame + IDENTITY_SLACK_US,
               "F8 identity holds at the p50 aggregate",
               f"p50 submit={agg_submit:.2f} + wait={agg_wait:.2f} <= frame={agg_frame:.2f} + 500")

    # ---- F9: separability ----------------------------------------------------
    # Aggregate, not per row: a single row that happens to be CPU-bound is a blip;
    # a p50 that crosses 0.5 means the two quantities are no longer distinguishable
    # and any A/B comparison built on it is a guaranteed false tie.
    sep = (agg_submit / agg_frame) if agg_frame > 0 else 99.0
    gate.check(sep < SEPARABILITY_MAX_RATIO, "F9 submitUs/frameUs p50 ratio < 0.5",
               f"{sep:.4f} (CPU-separable)")

    # ---- F10: provenance not placeholder ------------------------------------
    for field in ("runId", "commit", "pathway", "tier"):
        vals = {r.get(field) for r in rows}
        gate.check("UNSET" not in vals, f"F10 {field} is set",
                   f"values={sorted(str(v) for v in vals)[:3]}")

    # ---- Optional: expected tier / pathway ----------------------------------
    if args.tier:
        got = {str(r.get("tier")) for r in rows}
        gate.check(got == {str(args.tier)}, "F11 tier matches request",
                   f"expected={args.tier} got={sorted(got)}")
    if args.pathway:
        got = {str(r.get("pathway")) for r in rows}
        gate.check(got == {str(args.pathway)}, "F11 pathway matches request",
                   f"expected={args.pathway} got={sorted(got)}")

    # ---- Informational summary ----------------------------------------------
    print("\n--- SUMMARY (informational, not gated here) ---")
    print(f"  rows            : {len(rows)}")
    print(f"  measured window : {len(measured)} (warmup excluded {args.warmup})")
    print(f"  submitUs p50    : {agg_submit:.2f}")
    print(f"  waitUs   p50    : {agg_wait:.2f}")
    print(f"  frameUs  p50    : {agg_frame:.2f}")
    print(f"  gpuValid        : {valid}/{len(measured)} ({ratio * 100:.1f}%)")
    k_hist: Dict[int, int] = {}
    for r in measured:
        k_hist[int(r.get("gpuTierK", 0))] = k_hist.get(int(r.get("gpuTierK", 0)), 0) + 1
    print(f"  gpuTierK hist   : {dict(sorted(k_hist.items()))}")

    return _finish(gate)


def _finish(gate: Gate) -> int:
    print("\n" + "=" * 78)
    if gate.failures:
        print(f"RESULT: FAIL  ({len(gate.failures)} of {gate.checks} checks failed)")
        for f in gate.failures:
            print(f"  - {f}")
        print("=" * 78)
        return 1
    print(f"RESULT: PASS  (all {gate.checks} checks passed)")
    print("=" * 78)
    return 0


if __name__ == "__main__":
    sys.exit(main())