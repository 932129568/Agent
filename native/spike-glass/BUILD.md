# M2 T01 build chain (`native/build-m2-*.bat`)

Three mutually incompatible toolchains are frozen here, because every other M2 task runs
its acceptance command through one of them:

| Toolchain | Driver | Used by |
|---|---|---|
| MSVC `cl` (hand-injected env) | `build-m2-native.bat` | T02 host exe, layout/d3d probes |
| `fxc` (absolute path) | `build-m2-shaders.bat` | T04 HLSL kernels, T03 composite PS |
| `node-gyp` (Electron headers) | `build-m2-addon.bat` | T01 self-check addon, T03 OSR addon |
| all three in order | `build-m2-all.bat` | CI-style single entry |

Run from the repo root as `cmd //c native\build-m2-<stage>.bat`. Do not invoke these from
Git Bash directly: MSYS rewrites `/nologo`, `/Fe:` and friends into bogus paths, so
`cmd //c` is the only safe wrapper.

## Why the drivers live in `native/` and not in a `build/` directory

`.gitignore` line 40 is a bare `build/`, which matches **any** directory named `build` at
any depth. A driver script placed under `native/spike-glass/build/` would therefore never
be committed:

```
$ git check-ignore -v native/spike-glass/build/build-native.bat
.gitignore:40:build/    native/spike-glass/build/build-native.bat
```

The scripts were originally written there and that is exactly what happened: 600 lines of
build tooling that existed on one machine only, so a fresh clone could not reproduce the
spike at all. They now sit in `native/`, which matches no ignore rule and the R101
architecture document already names as the canonical location.

Build **artifacts** still go to `native/spike-glass/build/Release/` and are ignored on
purpose. That split is the rule: drivers and configs must be committed, artifacts must not.

---

## build-m2-native.bat

```
cmd //c native\build-m2-native.bat            REM build everything
cmd //c native\build-m2-native.bat d3d_probe  REM build one target
```

Targets: `all` (default), `d3d_probe`, `dcomp_host`, `layout_probe`, `osr_bridge`.
Units without a `main` are compiled to `.obj` only; units with one are compiled and linked
to `.exe`. An unknown target exits `2` rather than silently building nothing.

**Needs:** MSVC at
`C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.51.36231`
and Windows Kits `10.0.26100.0`. Note the toolchain sits under the **x86** Program Files
tree, not the 64-bit one.

`vcvars64.bat` is deliberately not used -- its internal `reg.exe` call is blocked by
security policy, so `INCLUDE` / `LIB` / `PATH` are injected by hand.

Two defines are mandatory and neither is cosmetic:

- **`/utf-8`** -- without it MSVC reads the sources as GBK, the trailing `0x5C` byte of a
  CJK character eats the following line, and the failure surfaces two lines later as a
  bogus `C2065`.
- **`/DUNICODE /D_UNICODE`** -- the M2 host code is wide-char throughout
  (`CreateWindowExW` / `RegisterClassExW`), but `IDC_ARROW` expands to the ANSI variant
  without `UNICODE`, so `LoadCursorW` receives an `LPSTR` and fails with `C2664`. Defining
  the pair matches what node-gyp's default gypi does, so both chains agree on width.

| Symptom | Cause / fix |
|---|---|
| `[ERROR] cl.exe not found` | MSVC version directory changed -- update the `MSVC=` line |
| `LINK_FAIL=... reason=exe_missing` | `cl` returned 0 but produced no `.exe`, usually a stray `/c` in `CFLAGS` |
| `C2065: <identifier>` on a line you did not touch | `/utf-8` was dropped |
| `C2664: LoadCursorW ... LPSTR to LPCWSTR` | `UNICODE` / `_UNICODE` were dropped |

---

## build-m2-shaders.bat

```
cmd //c native\build-m2-shaders.bat
```

| Stem | Profile | Entry | Source |
|---|---|---|---|
| `squircle_ps_exact` | `ps_5_0` | `main` | `squircle_ps.hlsl` |
| `squircle_ps_poly` | `ps_5_0` | `poly` | `squircle_ps.hlsl` |
| `kawase_cs_down` | `cs_5_0` | `main_down` | `kawase_cs.hlsl` |
| `kawase_cs_up` | `cs_5_0` | `main_up` | `kawase_cs.hlsl` |
| `kawase_cs_down_sm51` | `cs_5_1` | `main_down` | `kawase_cs.hlsl` |
| `kawase_cs_up_sm51` | `cs_5_1` | `main_up` | `kawase_cs.hlsl` |

Outputs: `native/spike-glass/build/Release/shaders/STEM.cso` plus `STEM.asm`.

### `squircle_ps_exact` and `squircle_ps_poly` are byte-identical ON PURPOSE

`cmp` on the two `.cso` files returns 0 and `diff` on the two `.asm` files is empty. Both
are 1,984 B and both are 34 instructions. **This is by design, not a regression** -- and a
reviewer who assumes otherwise will break the M1 baseline trying to "fix" it.

The reason is in T04's source (`squircle_ps.hlsl`):

```hlsl
// Legacy alias for the M1 regression baseline (native/build-shaders.bat uses
// /E poly). Pinned to the LOW path so the baseline stays comparable.
float4 poly(PSIn i) : SV_Target
{
    return ShadeLow(i);
}
```

`poly` is deliberately pinned to `ShadeLow`, so `/E poly` and `/E main` (without
`-DGLASS_TIER_HIGH`) compile the same body. The alias exists only so the historical M1
acceptance command `/E poly` keeps working.

**The real two-tier comparison lives in T04's stems, not here:** `squircle_low` versus
`squircle_high` differ by 44 instructions, and `verify_tiers.py` covers that
(**29/29 PASS** — verified by running it; an earlier draft of this file said `30/30`,
which was a stale count that did not match the script's own `RESULT: PASS (all 29
checks passed)` line).
Do not widen the gap between `exact` and `poly` -- doing so would move the M1 baseline and
invalidate the M1 evidence these two stems exist to preserve.

**T04 owns the shader tier matrix.** This script only guarantees the six stems above still
compile, as a regression sentinel: if an edit breaks the whole-file structure, it breaks
here first. Add new rows at the end of the entry list; do not remove the existing six,
because T02/T03/T04 acceptance commands reference these stems.

T04's tier artifacts land in the `shaders/tiers/` subdirectory, physically separate from
the M1 baseline artifacts written here, so the two entry-naming schemes never collide.
This script writes its six stems into `shaders/` itself and never touches `shaders/tiers/`.

### There are THREE kinds of "two of the same" — do not conflate them

This directory ships three different pairs. They look similar in a file listing and have
**completely different semantics**. Conflating them is the single easiest way to draw a
wrong conclusion here, so each one gets its own assertion:

| Pair | Means | Expected relation | The assertion that guards it |
|---|---|---|---|
| `squircle_ps_exact` vs `squircle_ps_poly` | **Two entry names onto the SAME body.** `poly` is a frozen M1 alias. | **MUST be byte-identical** | `POLY_IS_LOW=1` (`verify_tiers.py --inject-poly-high` turns it to 0) |
| `squircle_ps_low` vs `squircle_ps_high` | **Two compile tiers of the same entry.** `-DGLASS_TIER_HIGH=1` selects the expensive path. | **MUST differ** (measured: 34 vs 78 instructions) | `TIER_DIFFERS=1` (`--inject-identical` turns it to 0) |
| `kawase_cs_down_sm51` vs `kawase_cs_down` | **Same source, two shader-model profiles** (`cs_5_1` vs `cs_5_0`). | **MUST differ or at least be separately reproducible** | separate stem names, never overwritten |

Read this table before "fixing" anything:

* If you see `exact == poly` and think "a tier is missing" → **you are wrong**, that's the
  picked design. Fixing it breaks M1.
* If you see `low != high` and think "the tiers diverged by accident" → **also wrong**,
  that's the whole point of the two-tier work.
* If you see `sm51` and wonder why it's duplicated → it's a **profile** axis, not a tier
  axis. It answers "does this kernel survive an SM 5.1 compile", nothing about glass tiers.

The three pairs are asserted independently, so a failure names which axis broke. A single
combined "artifacts differ" check would be useless: it goes green when `exact != poly`
(which is bad) as happily as when `low != high` (which is good).

`cs_5_0` is the design baseline. The `cs_5_1` pair is a capability datapoint -- measured
working on this machine, kept distinct from the `cs_5_0` stems so a future tier change
cannot silently overwrite the baseline evidence.

**`/Fc` is not a nicety.** It is the only hard evidence of instruction count,
`dcl_temps`, `sample_*` and `ld_structured`. `fxc` returns 0 for an empty kernel just as
happily as for a real one -- the measured contrast is 25 instructions versus 2, both with
exit code 0. Never judge a kernel by "it compiled".

**Never count the bare word `sample` in an `.asm`.** Header comments contain `sampler` and
`dcl_sampler` and inflate the count (measured 5 vs 3). Count `sample_indexable` plus
`sample_l_indexable`, or count opcode lines after the code header.

### Instruction counting rule (state it, or two people will report two numbers)

An `.asm` body contains one line that looks exactly like an instruction but is not:

```
cs_5_0                              <-- profile declaration, NOT an instruction
dcl_globalFlags refactoringAllowed  <-- declaration
dcl_temps 7                         <-- declaration
mov r0.xw, cb0[0].xxxy              <-- first real instruction
```

Any counter that matches "line starts with a lowercase word" includes the profile line and
is off by exactly one. That is not hypothetical: an earlier version of the T01 table
reported 35 for a kernel whose true count is 34, and the discrepancy cost a review round
against T04's `verify_tiers.py`.

The correct rule, used for every number quoted here:

1. drop blank lines and `//` comments
2. drop every `dcl_*` line
3. drop the standalone profile line matching `^(ps|cs|vs|gs|hs|ds)_[0-9]_[0-9]$`
4. count what remains

Declarations (`dcl_temps`, `dcl_thread_group`, `dcl_input`) are therefore excluded on both
sides, and `ret` / `nop` are counted because they are real issued instructions.

Current readings under that rule: `squircle_ps_exact` 34, `squircle_ps_poly` 34,
`kawase_cs_down` 44, `kawase_cs_up` 36 -- matching `verify_tiers.py` exactly.

`ddx` / `ddy` are illegal in a compute shader -- `fxc` reports `X4532`. The Kawase up pass
therefore uses explicit `SampleLevel` only. Do not "optimise" it back to derivatives. Note
that fxc's dead-code elimination removes an *unused* derivative before the legality check
runs, so a `X4532` negative control must use the value (`uv.x += ddx(uv.x);`) or it will
compile clean and prove nothing.

| Symptom | Cause / fix |
|---|---|
| `[ERROR] fxc.exe not found` | Windows SDK version changed -- update the `FXC=` line |
| `error X4532: cannot map expression to cs_5_0` | `ddx`/`ddy` used inside a compute shader |
| `error X3000` / `X3004` + `no code produced` | genuine HLSL syntax error; the script exits 1 |
| `[ERROR] expected artifact missing` | a stem silently stopped building, or the output path is wrong |

---

## build-m2-addon.bat

```
cmd //c native\build-m2-addon.bat
```

Builds **both** addon projects through the same toolchain and the same assertions.

| Target | Project dir | Source | Owner |
|---|---|---|---|
| `harbor_spike` | `spike-glass/addon/` | `spike_addon.cpp` | T01 export self-check |
| `harbor_osr` | `spike-glass/src/addon/` | `addon.cpp` + `../osr_bridge.cpp` + `../osr_host.cpp` | T03 OSR single-chain demo |

**These are not duplicates.** Different target names, different sources, different
consumers. T03 originally built `harbor_osr` with an ad-hoc node-gyp invocation whose
evidence log landed in the git-ignored `native/build/t03/`, which meant there was no
committed driver for it -- a fresh clone could not rebuild T03's addon at all. This script
now covers both, precisely so the addon toolchain is proven in one committed place.

Both get identical treatment (`:build_one` is shared), because T03's path must not pass a
weaker check than T01's.

Outputs `<project>/build/Release/<target>.node` (node-gyp's real output) and copies each to
`native/spike-glass/build/Release/<target>.node` so every artifact sits in one directory.

Measured sizes: `harbor_spike` 143,360 B, `harbor_osr` 212,992 B.

### Why node-gyp and never a hand-rolled `cl /LD`

A manual `cl /LD` build produces a `.node` that makes Electron **die silently** on
`require()` -- no error, no stack trace, the process just vanishes, not even a later
`process.exit` runs. This was measured on the smallest possible addon.

The root cause is the missing `win_delay_load_hook.cc` translation unit, which node-gyp
injects automatically and a manual command line does not. Byte size is the cheap tell:
**node-gyp ~143 KB vs manual `cl` ~15 KB**.

`binding.gyp` **must** keep `/utf-8`, for the same GBK reason as the native chain. The
measured false error there is a bogus `C2065: srv undeclared` caused by two
`ID3D11ShaderResourceView*` declarations being swallowed.

### Two assertions, each with a real negative control

- **`CHECK_HOOK=1`** -- `win_delay_load_hook.obj` really was compiled.
  *Negative control (measured):* a stub that emits a plausibly-sized `.node` but no hook
  object gives `CHECK_HOOK=0`, `exit 1`. This is the manual-`cl` failure shape.
- **`CHECK_BYTES=1`** -- the `.node` is at least 100,000 bytes, guarding the D1 rule
  "never fake a `.node`".
  *Threshold source: MEASURED.* The reference node-gyp addon
  (`native/build/m2probe/harbor_probe.node`) is 141,312 B, `harbor_spike` is 143,360 B and
  `harbor_osr` is 212,992 B, while a manual-`cl` build of the same source is about 15 KB.
  100,000 B sits well above the manual-`cl` fingerprint and below every real artifact.
  *Negative control (measured):* a stub emitting a 100-byte file gives
  `NODE_BYTES=100`, `CHECK_BYTES=0`, `exit 1`.

Neither assertion is decorative. "It compiled" cannot distinguish a loadable addon from
one that kills Electron on contact.

### Loading is asserted separately, and it must be

Building is only half the proof. `selfcheck.js` loads the module inside Electron, calls
the exports, verifies the results, and then checks the process is still alive. Run it with
the environment scrubbed -- the ambient shell carries `ELECTRON_RUN_AS_NODE=1`, which
degrades `electron.exe` into plain node and makes `app` undefined:

```
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
  ./node_modules/electron/dist/electron.exe native/spike-glass/addon/selfcheck.js
```

Expected last line, and the verdict is `LOADED_AND_CALLED`, never merely `LOADED`:

```
VERDICT_ADDON=LOADED_AND_CALLED hostVersion=<...> probeSelf={<...>} selftestCalc=<...>
```

The calls are checked against values computed **in the JS harness**, so a stubbed addon
cannot pass:

- `hostVersion()` must name the Electron version actually running
- `probeSelf()` must carry `d3dHr === 0` and a positive `featureLevel` -- i.e. a real
  D3D11 device query, not a hardcoded string
- `selftestCalc(seed)` must equal a mixer recomputed in JS for four different seeds, so a
  constant return value fails for every seed but one
- `SURVIVED_REQUIRE=1` is printed right after `require()`, because a missing hook would
  have killed the process before that line

### node-gyp is not a declared dependency, on purpose

`node-gyp` reaches this repo **transitively**:
`electron-builder -> app-builder-lib -> @electron/rebuild -> node-gyp` (12.4.0).

It is deliberately **not** added to `devDependencies`, because
`tests/test_generative_registry.py` asserts that dictionary **for equality**, and the
current three-entry list is a deliberate guard keeping the dependency surface narrow.
Declaring node-gyp there would turn that gate red to buy something that already works.

**The accepted consequence:** if `electron-builder` is ever removed, this script goes
**red** instead of quietly degrading to an addon-less build. An addon-less "success" would
make T03's OSR path look tested while testing nothing. That failure mode is the feature.

The probe has **no fallback** -- no `npx --no-install`, no silent skip. When
`node_modules/node-gyp/bin/node-gyp.js` is absent it prints `NODE_GYP_MISSING=1` plus an
explicit restore instruction and exits `1`.

### Fixed flags

```
--runtime=electron --target=45.2.1 --dist-url=https://electronjs.org/headers --arch=x64
```

`--devdir` is intentionally omitted: with `--runtime=electron` node-gyp defaults to
`%LOCALAPPDATA%\node-gyp\Cache`, where the `45.2.1` headers are already cached, so the
build runs fully offline. Passing a different `--devdir` would force a network fetch.

The script always wipes `addon/build` first (`CLEAN_BUILD=1`). An incremental build hides
both C-1 (missing hook TU) and C-2 (missing `/utf-8`).

| Symptom | Cause / fix |
|---|---|
| `NODE_GYP_MISSING=1` | run `npm ci`; if `electron-builder` was dropped, the toolchain is genuinely gone |
| `gyp ERR! find VS` | Build Tools moved -- see `find-visualstudio.js`; `VCINSTALLDIR` is not set here by design |
| `CHECK_HOOK=0` | node-gyp linked without the hook -- fix `binding.gyp`, do not fall back to `cl /LD` |
| `CHECK_BYTES=0` | manual-`cl` or fake-artifact fingerprint; the addon would crash Electron silently |
| `C2065` inside `spike_addon.cpp` | `/utf-8` missing from `binding.gyp` |
| `selfcheck` prints `whenReady rejected` | `ELECTRON_RUN_AS_NODE` leaked into the environment -- scrub it |

---

## build-m2-all.bat

Runs four stages: native, shaders, addon build, then addon **load** self-check.

```
cmd //c native\build-m2-all.bat
cmd //c native\build-m2-all.bat d3d_probe   REM arg forwarded to build-m2-native
```

Any stage returning non-zero stops the run immediately and returns that non-zero code.
Each stage prints its own `BUILD_*=FAIL` line naming the toolchain that broke, so a red
run points at the culprit instead of at this wrapper.

### Stage 4 exists because compiling is not the same as loading

Stage 4 runs `selfcheck.js` inside Electron and requires `VERDICT_ADDON=LOADED_AND_CALLED`.
Without it a green `build-m2-all.bat` would only prove that three compilers exited 0 --
and a hand-rolled `cl /LD` addon does exactly that before killing Electron silently on
`require()`. So the umbrella build would be green while C-1 was in fact broken. That is
precisely the fake-green this stage removes.

**The environment scrub is inside the script, not left to the caller.** The ambient shell
carries `ELECTRON_RUN_AS_NODE=1`, which degrades `electron.exe` into plain node and makes
`app` undefined. `build-m2-all.bat` clears `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS` around
stage 4 and restores them afterwards, so `selfcheck` cannot be sabotaged by the calling
shell. `env` is not a cmd builtin, hence the temporary variables instead of `env -u`.

*Negative control (measured):* commenting out the two scrub lines makes stage 4 exit 1
with `TypeError: Cannot read properties of undefined (reading 'whenReady')`, zero
`VERDICT_ADDON` lines and zero `SURVIVED_REQUIRE` lines. The same scrub failure is
therefore both caught and distinguishable from a real crash.

Success line: `BUILD_ALL=OK native + shaders + addon + addon-loaded`.

---

## House rules for every `.bat` in this directory

Each of these was learned by an actual failure, not by preference:

1. **ASCII only.** A non-ASCII byte combined with LF line endings desyncs cmd's parser:
   it cuts a `rem` line mid-byte, executes the leftovers as commands, and **still returns
   0**. Silent by construction, so CJK text is banned here forever; all rationale lives in
   English comments.
2. **No angle brackets in `rem` lines.** cmd still honours redirection there and quietly
   eats the remainder of the line -- including a `call :label` that follows it. This
   produced a `cannot find the batch label` error while the preceding `call`s had already
   succeeded.
3. **Never put a closing parenthesis in an `echo` message inside an `if` block.** It
   closes the block early and the leftovers run as commands. This exact mistake once made
   `build-m2-addon.bat` fail *after* a successful node-gyp run, with a nonsense
   "not expected at this time" message and exit code 255.
4. **Use `goto`, not parenthesised blocks.** Error texts then stay free to contain any
   punctuation.
5. **Keep CRLF.** With LF-only endings cmd can lose byte-offset tracking and
   `call :label` fails with "cannot find the batch label" on longer files. Small test
   files pass, which is what makes this one nasty to diagnose.