#!/usr/bin/env python
"""verify_tiers.py -- prove the HLSL glass dual tier is REAL, and cannot be faked.

WHY THIS FILE EXISTS
M1 shipped a "dual tier" whose two variants differed by 1 instruction (24 vs 23).
That is indistinguishable from a macro that silently did nothing, so "it
compiled" is not evidence of anything. This verifier asserts three independent
relationships and prints a machine-greppable marker for each.

  G1  TIER_DIFFERS=1
      squircle_ps_high.cso != squircle_ps_low.cso  at the BYTE level,
      and the .asm listings differ by >= MIN_DELTA instructions.
      A dead /D define produces byte-identical binaries, so the byte gate still
      catches it after the asm side has been tampered with or gone stale.

  G2  POLY_IS_LOW=1
      squircle_ps_exact.cso == squircle_ps_poly.cso at the BYTE level.
      squircle_ps.hlsl deliberately pins the legacy "poly" entry point to the
      LOW path so the M1 evidence baseline stays comparable. Equality here is
      the DESIGN, not a regression.
      Asserting it explicitly converts "we happen not to check this pair" into a
      real guard, in both directions:
        - if someone un-pins "poly" so it routes to HIGH, G2 goes red
        - if someone accidentally moves "exact" off the LOW path, G2 goes red
      An unasserted pair is not a defence: a naive reader sees "exact and poly
      differ by 0 instructions", concludes the tiers regressed, and "fixes" poly
      -- which is exactly how the M1 baseline gets destroyed.

  G3  instruction-count cross-check
      The instruction counter is compared against fxc's own
      "// Approximately N instruction slots used" figure for every listing.
      If this script miscounts instruction lines, that surfaces here instead of
      silently producing plausible wrong numbers.

Counting rule: non-empty, non-comment lines between the profile line
(ps_5_0 / cs_5_0 / cs_5_1) and the trailing "// Approximately ..." comment,
excluding dcl_* declarations (I/O plumbing, not work).

ARTIFACT LAYOUT -- the chains must never share a directory
  native/spike-glass/shaders/tiers/                 <- T04 squircle tier matrix (read here)
  native/spike-glass/build/Release/shaders/         <- T01 M1 baseline
  native/spike-glass/build/Release/shaders/tiers/   <- T04 kawase tier evidence
native/build-m2-shaders.bat (T01) writes squircle_ps_exact/poly and kawase_cs_*
into the second path. While both chains wrote one directory, whichever ran last
silently rewrote the other's evidence: a 05:41 run of T01's script replaced the
HIGH tier binaries with baseline copies, leaving every .cso on the LOW path with
no error reported anywhere.

NEGATIVE CONTROLS -- each must be able to go red, or it is not a gate
  --inject-deficit     require delta >= 9999   -> G1 delta fails
  --inject-identical   high.cso := low.cso     -> TIER_DIFFERS=0
  --inject-poly-high   poly.cso := high.cso    -> POLY_IS_LOW=0

Every injection runs inside a throwaway sandbox copy of the artefact directory.
The real files are never written, so an interrupted or killed run cannot leave a
poisoned baseline behind -- a hazard that in-place mutate-then-restore still
permits, because a finally block does not execute after SIGKILL.
The sandbox path is printed and RESTORED_ARTIFACTS=VERIFIED re-hashes the real
directory afterwards to prove it byte-unchanged.

Exit codes: 0 = every gate passed, 1 = a gate failed, 3 = safe-abort.

usage:
    python verify_tiers.py
    python verify_tiers.py --build-dir <dir> --kawase-dir <dir>
    python verify_tiers.py --inject-identical
    python verify_tiers.py --inject-poly-high
    python verify_tiers.py --inject-deficit
"""

from __future__ import annotations

import argparse
import hashlib
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# Minimum instruction delta that counts as a real tier separation.
MIN_DELTA = 8
# Threshold used by --inject-deficit to prove the delta assertion can fail.
DEFICIT_THRESHOLD = 9999

PROFILE_RE = re.compile(r"^(?:ps|cs)_\d+_\d+$")
APPROX_RE = re.compile(r"^//\s*Approximately\s+(\d+)\s+instruction slots used")

SHADERS_DIR = Path(__file__).resolve().parent
SG_ROOT = SHADERS_DIR.parent

DEFAULT_BUILD_DIR = SHADERS_DIR / "tiers"
DEFAULT_KAWASE_DIR = SG_ROOT / "build" / "Release" / "shaders" / "tiers"

# The four squircle stems the tier matrix owns.
STEM_LOW = "squircle_ps_low"
STEM_HIGH = "squircle_ps_high"
STEM_EXACT = "squircle_ps_exact"
STEM_POLY = "squircle_ps_poly"
SQUIRCLE_STEMS: Tuple[str, ...] = (STEM_LOW, STEM_HIGH, STEM_EXACT, STEM_POLY)

# Supplementary compute-shader tier pairs, verified when their artefacts exist.
KAWASE_PAIRS: List[Tuple[str, str, str]] = [
    ("kawase_down_low", "kawase_down_high", "kawase_down (cs_5_0)"),
    ("kawase_up_low", "kawase_up_high", "kawase_up (cs_5_0)"),
]


def sha256_of(path: Path) -> str:
    """Return the hex sha256 of a file, or '<missing>' when it is absent."""
    if not path.is_file():
        return "<missing>"
    return hashlib.sha256(path.read_bytes()).hexdigest()


class TierAsm:
    """Parsed fxc disassembly listing for one compiled stem."""

    def __init__(self, path: Path) -> None:
        self.path: Path = path
        self.profile: str = ""
        self.body: List[str] = []
        self.approx_slots: Optional[int] = None
        self.exists: bool = path.is_file()
        if self.exists:
            self._parse()

    def _parse(self) -> None:
        """Split the listing into header / instruction body / trailer."""
        text = self.path.read_text(encoding="utf-8", errors="replace")
        in_body = False
        for raw in text.splitlines():
            line = raw.strip()
            if not in_body:
                if PROFILE_RE.match(line):
                    self.profile = line
                    in_body = True
                continue
            match = APPROX_RE.match(line)
            if match:
                self.approx_slots = int(match.group(1))
                break
            if not line or line.startswith("//"):
                continue
            if line.startswith("dcl_"):
                continue
            # Strip trailing disassembly comments, keep the opcode line.
            opcode = line.split("//", 1)[0].strip()
            if opcode:
                self.body.append(opcode)

    @property
    def count(self) -> int:
        return len(self.body)

    def opcode_histogram(self) -> Dict[str, int]:
        hist: Dict[str, int] = {}
        for line in self.body:
            op = line.split(None, 1)[0]
            hist[op] = hist.get(op, 0) + 1
        return hist


def cso_size(directory: Path, stem: str) -> int:
    """Return the byte size of <stem>.cso, or -1 when the file is absent."""
    path = directory / f"{stem}.cso"
    return path.stat().st_size if path.is_file() else -1


class Gate:
    """Accumulates assertions so one run reports every failure at once."""

    def __init__(self) -> None:
        self.failures: List[str] = []
        self.checks: int = 0

    def check(self, ok: bool, label: str, detail: str) -> bool:
        self.checks += 1
        status = "PASS" if ok else "FAIL"
        print(f"  [{status}] {label}: {detail}")
        if not ok:
            self.failures.append(f"{label}: {detail}")
        return ok


def check_artifacts_present(
    gate: Gate, tiers: Path, stems: Tuple[str, ...]
) -> bool:
    """Every stem must have a non-zero .cso and a readable .asm."""
    ok_all = True
    for stem in stems:
        cso = tiers / f"{stem}.cso"
        asm = tiers / f"{stem}.asm"
        size = cso.stat().st_size if cso.is_file() else -1
        ok_all &= gate.check(size > 0, f"cso({stem}) bytes > 0", f"{stem}.cso = {size} B")
        ok_all &= gate.check(asm.is_file(), f"asm({stem}) exists", str(asm))
    return ok_all


def check_counter_matches_fxc(gate: Gate, label: str, asm: TierAsm) -> None:
    """Cross-check our instruction count against fxc's own slot figure.

    G3. Guards "I miscounted the instruction lines" -- a low-level error that
    would otherwise produce plausible wrong numbers with no visible symptom.
    """
    gate.check(
        asm.approx_slots == asm.count,
        f"counter matches fxc slot summary ({label})",
        f"fxc approximately={asm.approx_slots} counted={asm.count}",
    )


def check_tier_differs(gate: Gate, tiers: Path) -> int:
    """G1 (byte side): HIGH must not be the same binary as LOW. Emits TIER_DIFFERS."""
    print("\n--- G1 TIER_DIFFERS (HIGH must differ from LOW, byte level) ---")
    low_hash = sha256_of(tiers / f"{STEM_LOW}.cso")
    high_hash = sha256_of(tiers / f"{STEM_HIGH}.cso")
    missing = "<missing>" in (low_hash, high_hash)
    differs = 1 if (not missing and low_hash != high_hash) else 0

    print(f"  [INFO] {STEM_LOW}.cso  sha256={low_hash}")
    print(f"  [INFO] {STEM_HIGH}.cso sha256={high_hash}")
    reason = (
        "byte-identical: the /DGLASS_TIER_HIGH define never reached the compiler"
        if differs == 0 else
        f"sha256 {low_hash[:16]}... vs {high_hash[:16]}..."
    )
    gate.check(differs == 1, "HIGH binary differs from LOW binary",
               f"TIER_DIFFERS={differs} ({reason})")
    print(f"TIER_DIFFERS={differs}")
    return differs


def check_tier_delta(gate: Gate, tiers: Path, min_delta: int) -> None:
    """G1 (asm side): the HIGH listing must cost >= min_delta more instructions."""
    print("\n--- G1 TIER_DELTA (HIGH listing must cost more than LOW) ---")
    low = TierAsm(tiers / f"{STEM_LOW}.asm")
    high = TierAsm(tiers / f"{STEM_HIGH}.asm")
    if not (low.exists and high.exists):
        gate.check(False, "asm listings present",
                   f"LOW={low.exists} HIGH={high.exists}")
        return

    gate.check(low.profile == high.profile and bool(low.profile),
               "same shader profile",
               f"LOW={low.profile or '<none>'} HIGH={high.profile or '<none>'}")
    check_counter_matches_fxc(gate, "LOW", low)
    check_counter_matches_fxc(gate, "HIGH", high)

    n_low, n_high = low.count, high.count
    delta = n_high - n_low
    print(f"  [INFO] instr(LOW)={n_low}  instr(HIGH)={n_high}  "
          f"delta={delta}  required>={min_delta}")

    gate.check(n_high != n_low, "tiers are not instruction-identical",
               f"LOW={n_low} HIGH={n_high} (equal counts mean the macro never engaged)")
    gate.check(low.body != high.body, "tiers differ instruction-by-instruction",
               f"identical={low.body == high.body}")
    gate.check(delta >= min_delta, f"instr delta >= {min_delta}",
               f"actual delta={delta} (LOW={n_low}, HIGH={n_high})")

    only_high = {
        op: cnt for op, cnt in high.opcode_histogram().items()
        if cnt > low.opcode_histogram().get(op, 0)
    }
    print(f"  [INFO] opcodes HIGH has extra: {only_high or '<none>'}")


def check_poly_is_low(gate: Gate, tiers: Path) -> int:
    """G2: exact and poly are both pinned to LOW, so they must be byte-identical.

    Emits POLY_IS_LOW=<0|1>.
    """
    print("\n--- G2 POLY_IS_LOW (legacy alias must equal the LOW path) ---")
    print("    squircle_ps.hlsl pins the legacy 'poly' entry to the LOW path, so")
    print("    equality is the DESIGN. A difference means 'poly' was un-pinned")
    print("    (now routing HIGH) or 'exact' left LOW -- the M1 baseline moved.")
    exact_hash = sha256_of(tiers / f"{STEM_EXACT}.cso")
    poly_hash = sha256_of(tiers / f"{STEM_POLY}.cso")
    missing = "<missing>" in (exact_hash, poly_hash)
    is_low = 1 if (not missing and exact_hash == poly_hash) else 0

    print(f"  [INFO] {STEM_EXACT}.cso sha256={exact_hash}")
    print(f"  [INFO] {STEM_POLY}.cso  sha256={poly_hash}")
    reason = ("identical, pinned to LOW by design" if is_low == 1 else
              "differing means 'poly' was un-pinned from LOW, or 'exact' moved")
    gate.check(is_low == 1, "legacy poly binary equals the LOW path binary",
               f"POLY_IS_LOW={is_low} ({reason})")

    # The asm side must agree with the byte side, not merely be present.
    exact = TierAsm(tiers / f"{STEM_EXACT}.asm")
    poly = TierAsm(tiers / f"{STEM_POLY}.asm")
    if gate.check(exact.exists and poly.exists, "legacy asm listings present",
                  f"exact={exact.exists} poly={poly.exists}"):
        print(f"  [INFO] instr(exact)={exact.count}  instr(poly)={poly.count}")
        gate.check(exact.count == poly.count, "legacy instruction counts equal",
                   f"{exact.count} vs {poly.count}")
        gate.check(exact.body == poly.body, "legacy instruction bodies identical",
                   f"identical={exact.body == poly.body}")

    print(f"POLY_IS_LOW={is_low}")
    return is_low


def check_kawase(gate: Gate, kawase_dir: Path, min_delta: int) -> None:
    """Supplementary: the compute-shader tier pairs, when their artefacts exist."""
    print("\n--- SUPPLEMENTARY kawase tier pairs ---")
    if not kawase_dir.is_dir():
        print(f"  [INFO] KAWASE_TIERS=SKIP (no directory at {kawase_dir})")
        return
    for low_stem, high_stem, label in KAWASE_PAIRS:
        low = TierAsm(kawase_dir / f"{low_stem}.asm")
        high = TierAsm(kawase_dir / f"{high_stem}.asm")
        if not (low.exists and high.exists):
            print(f"  [INFO] KAWASE_TIERS=SKIP {label} (artefacts absent)")
            continue
        n_low, n_high = low.count, high.count
        delta = n_high - n_low
        print(f"  [INFO] {label}: instr(LOW)={n_low} instr(HIGH)={n_high} delta={delta}")
        gate.check(low.profile == high.profile and bool(low.profile),
                   f"{label} same profile",
                   f"LOW={low.profile} HIGH={high.profile}")
        gate.check(n_high != n_low, f"{label} tiers not identical",
                   f"LOW={n_low} HIGH={n_high}")
        gate.check(delta >= min_delta, f"{label} instr delta >= {min_delta}",
                   f"actual delta={delta} (LOW={n_low}, HIGH={n_high})")
        check_counter_matches_fxc(gate, f"{label} LOW", low)
        check_counter_matches_fxc(gate, f"{label} HIGH", high)


class Sandbox:
    """A disposable copy of the artefact directory, safe to corrupt.

    Injections never write the real files, so a crash, Ctrl-C or SIGKILL cannot
    leave a poisoned baseline for the next run. In-place mutate-then-restore in a
    finally block still fails under SIGKILL; a sandbox does not.
    """

    def __init__(self, source: Path) -> None:
        self.source: Path = source
        self.dir: Path = Path(tempfile.mkdtemp(prefix="verify_tiers_nc_"))
        if source.is_dir():
            for item in sorted(source.iterdir()):
                if item.is_file():
                    shutil.copy2(item, self.dir / item.name)

    def overwrite(self, target_stem: str, donor_stem: str, suffix: str) -> None:
        """Copy donor+SUFFIX over target+SUFFIX inside the sandbox."""
        donor = self.dir / f"{donor_stem}{suffix}"
        victim = self.dir / f"{target_stem}{suffix}"
        if not donor.is_file():
            raise FileNotFoundError(f"injection donor missing: {donor}")
        shutil.copy2(donor, victim)
        print(f"  [INJECT] {victim.name} <- {donor.name} "
              f"({victim.stat().st_size} B, sandbox only)")

    def close(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)


def snapshot(directory: Path) -> Dict[str, str]:
    """Hash every file in a directory, for before/after comparison."""
    if not directory.is_dir():
        return {}
    return {p.name: sha256_of(p) for p in sorted(directory.glob("*")) if p.is_file()}


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Assert the HLSL glass dual tier is real, and its legacy alias pinned."
    )
    parser.add_argument("--build-dir", type=Path, default=DEFAULT_BUILD_DIR,
                        help=f"tier-matrix artefact directory (default: {DEFAULT_BUILD_DIR})")
    parser.add_argument("--kawase-dir", type=Path, default=DEFAULT_KAWASE_DIR,
                        help=f"compute tier artefact directory (default: {DEFAULT_KAWASE_DIR})")
    parser.add_argument("--inject-deficit", action="store_true",
                        help=f"negative control: require delta >= {DEFICIT_THRESHOLD} "
                             "so the G1 delta gate fails")
    parser.add_argument("--inject-identical", action="store_true",
                        help="negative control: overwrite high.cso with low.cso so "
                             "TIER_DIFFERS=0 and the G1 gate fails")
    parser.add_argument("--inject-poly-high", action="store_true",
                        help="negative control: overwrite poly.cso with high.cso so "
                             "POLY_IS_LOW=0 and the G2 gate fails")
    args = parser.parse_args(argv)

    tiers: Path = args.build_dir.resolve()
    kawase_dir: Path = args.kawase_dir.resolve()
    min_delta = DEFICIT_THRESHOLD if args.inject_deficit else MIN_DELTA
    injections = [name for name, on in
                  (("identical", args.inject_identical),
                   ("poly-high", args.inject_poly_high)) if on]

    print("=" * 78)
    print("verify_tiers.py -- HLSL dual-tier relationship assertions")
    print(f"tier dir       : {tiers}")
    print(f"kawase dir     : {kawase_dir}")
    print(f"required delta : >= {min_delta}"
          + ("   <-- INJECTED DEFICIT (negative control)" if args.inject_deficit else ""))
    if injections:
        print(f"injected       : {', '.join(injections)} (sandboxed; real files untouched)")
    print("-" * 78)
    print(f"  G1 TIER_DIFFERS=1 : {STEM_HIGH}.cso != {STEM_LOW}.cso ; asm delta >= {min_delta}")
    print(f"  G2 POLY_IS_LOW=1  : {STEM_EXACT}.cso == {STEM_POLY}.cso (pinned to LOW)")
    print("  G3 counter        : instruction count == fxc's own slot figure, per listing")
    print("=" * 78)

    if not tiers.is_dir():
        print(f"FATAL: tier dir does not exist: {tiers}")
        print("       run native/spike-glass/build-shaders.bat first")
        return 1

    pre = snapshot(tiers)
    sandbox: Optional[Sandbox] = None
    gate = Gate()

    try:
        target = tiers
        if injections:
            sandbox = Sandbox(tiers)
            target = sandbox.dir
            print(f"\n  [INFO] sandbox = {sandbox.dir}")
            if args.inject_identical:
                sandbox.overwrite(STEM_HIGH, STEM_LOW, ".cso")
            if args.inject_poly_high:
                sandbox.overwrite(STEM_POLY, STEM_HIGH, ".cso")

        print("\n--- artefact presence ---")
        if not check_artifacts_present(gate, target, SQUIRCLE_STEMS):
            print("\n  [INFO] missing artefacts; relationship gates skipped")
        else:
            check_tier_differs(gate, target)
            check_tier_delta(gate, target, min_delta)
            check_poly_is_low(gate, target)
        # Kawase artefacts are never injected against, so always read the real dir.
        check_kawase(gate, kawase_dir, MIN_DELTA)
    finally:
        if sandbox is not None:
            sandbox.close()

    print("\n" + "=" * 78)
    restored = snapshot(tiers) == pre
    print(f"RESTORED_ARTIFACTS={'VERIFIED' if restored else 'MISMATCH'}")
    if not restored:
        print("RESULT: SAFE-ABORT  (real artefacts changed during a negative control)")
        print("=" * 78)
        return 3

    if gate.failures:
        print(f"RESULT: FAIL  ({len(gate.failures)} of {gate.checks} checks failed)")
        for item in gate.failures:
            print(f"  - {item}")
        print("=" * 78)
        return 1
    print(f"RESULT: PASS  (all {gate.checks} checks passed)")
    print("=" * 78)
    return 0


if __name__ == "__main__":
    sys.exit(main())