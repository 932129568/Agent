# .bat line-ending probe

Reproduction and negative control for **BUILD.md house rule 1**:

> A non-ASCII byte combined with LF line endings desyncs cmd's parser: it cuts
> a `rem` line mid-byte, executes the leftovers as commands, and **still
> returns 0**.

Until 2026-11-22 that rule was folklore carried from an old failure. This
directory turns it into a measurable 2x2 matrix.

## Run

```
python native/eol-probe/run_probe.py            # table + findings
python native/eol-probe/run_probe.py --json     # machine readable
python native/eol-probe/run_probe.py --check    # exit 1 if the finding moved
```

Windows only (shells out to `cmd.exe`). Exits 0 with `SKIP` elsewhere.

## The four samples

| file | endings | `rem` line | expected |
|---|---|---|---|
| `crlf_ascii.bat` | CRLF | ASCII | PASS |
| `lf_ascii.bat` | LF | ASCII | PASS |
| `crlf_nonascii.bat` | CRLF | CJK | PASS |
| `lf_nonascii.bat` | LF | CJK | **FAIL** |

Only ONE cell is supposed to fail. If any of the other three ever fails, the
cause is not isolated and the rule needs restating.

## Result (2026-11-22, Windows 11, cmd.exe)

```
file                 eol   charset    rc  lines  verdict
crlf_ascii.bat       CRLF  ascii      0   4      PASS
lf_ascii.bat         LF    ascii      0   4      PASS
crlf_nonascii.bat    CRLF  non-ascii  0   4      PASS
lf_nonascii.bat      LF    non-ascii  0   3      FAIL
```

`lf_nonascii.bat` prints `'local' is not recognized as an internal or external
command` before `MARK_A` — cmd sliced the `setlocal` line at a byte boundary
inside the multibyte comment above it. **`rc` is still 0.**

## Why `rc` is not a sufficient judge

This is the whole point, and it is why the probe compares the stdout line set
instead of the exit code:

```
file                 rc-only  exact-lines
crlf_nonascii.bat    PASS     PASS
lf_nonascii.bat      PASS     FAIL      <-- rc-only judge reports a false PASS
```

A gate that only checks `returncode == 0` reports PASS on exactly the cell that
is broken. Any future check of this rule must assert the line set.

## Trigger width (measured, not assumed)

Sweeping the byte length of one CJK `rem` line from 10 to 301 under both
endings:

| endings | failed |
|---|---|
| CRLF | **0 / 292** |
| LF | **149 / 292**, and all 149 still exited 0 |

So "non-ASCII implies broken" is the wrong mental model — 143 of 292 LF cases
were fine. The failure depends on where the multibyte character lands relative
to cmd's read boundary. Because which lengths fail is incidental and shifts
with the surrounding byte count, the safe rule is the conservative one, and it
is the rule already in BUILD.md: **ASCII only, CRLF only, no exceptions.**

## Relation to the discarded `blk2_*.bat` pair

Two earlier files, `native/blk2_crlf.bat` and `native/blk2_lf.bat`, were
intended as this same comparison and are **not** included in this directory:

1. Both opened with `if not exist "C://nope_xyz" (...) endlocal & exit /b 2`.
   That path never exists, so **both exited at `rc=2` before reaching
   `call :sub`** — they compared nothing.
2. `blk2_lf.bat` cannot survive `git`: with `core.autocrlf=true` and no
   `.gitattributes`, the LF sample's blob is byte-identical to the CRLF
   sample's blob (both `9b3fb76e…`). Pushing it would preserve the name "LF"
   while shipping CRLF content — a false label rather than a lost sample.

`run_probe.py` regenerates all four samples in memory-equivalent form; the
`.bat` files in this directory are committed as-is and are `-text` in
`.gitattributes` so their byte layout survives clone.