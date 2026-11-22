"""line-ending x non-ASCII probe for .bat parsing under cmd.exe.

Why this exists
---------------
BUILD.md house rule 1 says a non-ASCII byte plus LF endings desyncs cmd's
parser. That claim is load-bearing -- it is why every .bat here is ASCII-only
with CRLF -- but until it was measured it was folklore, and the two earlier
samples (`native/blk2_crlf.bat` / `native/blk2_lf.bat`) proved nothing: both
guarded on a nonexistent path `C://nope_xyz` and exited at the same `rc=2`
before reaching `call :sub`.

What was actually measured (2026-11-22)
---------------------------------------
Sweeping the byte length of one CJK `rem` line from 10 to 301, under both
endings:

    CRLF  0/292 failed
    LF    149/292 failed, and all 149 still exited 0

So the trigger is not "non-ASCII" as a boolean. It is byte misalignment: cmd
loses line-boundary tracking on LF-only input when a multibyte character
straddles the chunk boundary, then executes the leftovers as commands. Which
lengths fail is incidental; the safe rule is the conservative one -- ASCII
only, CRLF only.

Judging rule
------------
PASS means the stdout line set is EXACTLY the expected set. Exit code alone is
never sufficient: every failing LF case still returned 0, so a judge that only
checks `rc == 0` would report a false PASS on exactly the cell that matters.

Usage
-----
    python native/eol-probe/run_probe.py            # human readable
    python native/eol-probe/run_probe.py --json     # machine readable
    python native/eol-probe/run_probe.py --check    # exit 1 if the finding moved
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# (file, eol, charset, expected verdict)
CASES = [
    ("crlf_ascii.bat",    "CRLF", "ascii",     "PASS"),
    ("lf_ascii.bat",      "LF",   "ascii",     "PASS"),
    ("crlf_nonascii.bat", "CRLF", "non-ascii", "PASS"),
    ("lf_nonascii.bat",   "LF",   "non-ascii", "FAIL"),
]

EXPECTED_LINES = ["MARK_A", "SUB=hello", "MARK_SUB_RC=0", "MARK_B"]


def run_case(name: str) -> dict:
    proc = subprocess.run(
        ["cmd", "/c", name],
        cwd=str(HERE),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
    )
    out_lines = [ln.strip() for ln in (proc.stdout or "").splitlines() if ln.strip()]
    err_lines = [ln.strip() for ln in (proc.stderr or "").splitlines() if ln.strip()]
    extra = [ln for ln in out_lines if ln not in EXPECTED_LINES]

    return {
        "file": name,
        "stdout_lines": out_lines,
        "stderr_lines": err_lines,
        "extra_lines": extra,
        "exit_code": proc.returncode,
        "exact_match": out_lines == EXPECTED_LINES,
    }


def main() -> int:
    want_json = "--json" in sys.argv
    want_check = "--check" in sys.argv

    missing = [n for n, _, _, _ in CASES if not (HERE / n).is_file()]
    if missing:
        print(f"MISSING_SAMPLES={missing}", file=sys.stderr)
        return 2

    results = []
    for name, eol, charset, expect in CASES:
        r = run_case(name)
        r.update(eol=eol, charset=charset, expected=expect)
        r["verdict"] = "PASS" if r["exact_match"] else "FAIL"
        r["as_expected"] = r["verdict"] == expect
        results.append(r)

    if want_json:
        print(json.dumps({"expected": EXPECTED_LINES, "cases": results}, indent=2))
    else:
        print(f"{'file':<20} {'eol':<5} {'charset':<10} {'rc':<3} {'lines':<6} "
              f"{'verdict':<8} {'as-documented'}")
        for r in results:
            print(f"{r['file']:<20} {r['eol']:<5} {r['charset']:<10} "
                  f"{r['exit_code']:<3} {len(r['stdout_lines']):<6} "
                  f"{r['verdict']:<8} {'YES' if r['as_expected'] else 'NO'}")
        print()
        for r in results:
            if r["extra_lines"]:
                shown = " | ".join(repr(x)[:40] for x in r["extra_lines"][:3])
                rest = len(r["extra_lines"]) - 3
                tail = f" (+{rest} more)" if rest > 0 else ""
                print(f"  {r['file']}: misparsed bytes executed as commands -> {shown}{tail}")
        print()

    by = {(r["eol"], r["charset"]): r for r in results}

    a = by[("CRLF", "ascii")]["verdict"] == "PASS"
    b = by[("LF", "ascii")]["verdict"] == "PASS"
    c = by[("CRLF", "non-ascii")]["verdict"] == "PASS"
    d = by[("LF", "non-ascii")]["verdict"] == "FAIL"
    rc0 = by[("LF", "non-ascii")]["exit_code"] == 0

    findings = {
        "ASSERT_CRLF_ASCII_OK": a,
        "ASSERT_LF_ASCII_OK": b,
        "ASSERT_CRLF_NONASCII_OK": c,
        "ASSERT_LF_NONASCII_BAD": d,
        "NOTE_LF_NONASCII_STILL_EXIT_0": rc0,
    }
    rule1 = a and b and c and d

    if not want_json:
        print("BUILD.md house rule 1, restated as an isolatable cause:")
        print("  non-ASCII bytes + LF endings desync cmd's parser, and it still exits 0")
        print("  (the other three cells must stay clean, else the cause is not isolated)")
        for k, v in findings.items():
            print(f"  {k:<32} {'YES' if v else 'NO'}")
        print()

    if want_check:
        ok = rule1 and rc0
        print(f"RESULT: {'PASS' if ok else 'FAIL'} "
              f"(cause isolated={rule1}, silent rc=0 confirmed={rc0})")
        return 0 if ok else 1

    return 0


if __name__ == "__main__":
    if os.name != "nt":
        print("SKIP: probe shells out to cmd.exe and requires Windows", file=sys.stderr)
        sys.exit(0)
    sys.exit(main())