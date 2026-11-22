@echo off
rem ============================================================================
rem build-m2-addon.bat -- M2 T01 N-API addon chain (node-gyp, Electron 45.2.1)
rem
rem LIVES IN native/ ON PURPOSE: a .bat under any "build/" directory is swallowed by
rem .gitignore (line 40 is a bare "build/"), so the driver itself would never be
rem committed. Only artifacts belong in build/.
rem
rem HOUSE RULES for every .bat in this directory: see build-m2-native.bat. In short:
rem ASCII only, no angle brackets in rem lines, never a closing parenthesis inside an
rem echo within an if-block, goto instead of parenthesised blocks. Rule 3 is not
rem theoretical here: an early version of this script echoed a parenthesised hint
rem inside an if-block and blew up AFTER a successful node-gyp run with a nonsense
rem "not expected at this time" message and exit code 255.
rem
rem WHY node-gyp AND NOT a hand-rolled "cl /LD": a manual cl build produces a .node
rem that makes Electron die SILENTLY on require() -- no error, no stack, the process
rem just vanishes and not even a later process.exit runs. The root cause is the
rem missing win_delay_load_hook.cc translation unit, which node-gyp injects
rem automatically and a manual command line does not. This was measured on the
rem smallest possible addon, so it is not an exotic edge case.
rem
rem Also: binding.gyp MUST keep /utf-8, otherwise MSVC parses CJK comments as GBK and
rem the 0x5C trailing byte of a character eats the following line. The measured
rem signature was a bogus "C2065: srv undeclared" caused by two declarations being
rem swallowed.
rem
rem node-gyp is NOT a declared devDependency. It arrives transitively through
rem electron-builder, then app-builder-lib, then @electron/rebuild, then node-gyp
rem (12.4.0). tests/test_generative_registry.py asserts the devDependencies dict for
rem EQUALITY, and that three-entry list is a deliberate guard keeping the dependency
rem surface narrow, so declaring node-gyp there would turn that gate red to buy
rem something that already works. ACCEPTED CONSEQUENCE, on purpose: if electron-builder
rem is ever removed, THIS SCRIPT GOES RED instead of quietly degrading to an
rem addon-less build. An addon-less "success" would make T03's OSR path look tested
rem while testing nothing, and that failure mode is the feature.
rem
rem usage: cmd //c native\build-m2-addon.bat
rem outputs: native\spike-glass\addon\build\Release\harbor_spike.node  node-gyp's output
rem          native\spike-glass\build\Release\harbor_spike.node    copies, so every
rem          native\spike-glass\build\Release\harbor_osr.node      artifact of this
rem                                                                 build sits in one
rem                                                                 directory
rem ============================================================================
setlocal EnableExtensions

for %%I in ("%~dp0.") do set "NATIVE=%%~fI"
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
set "SG=%NATIVE%\spike-glass"

set "ADDON=%SG%\addon"
set "OUT=%SG%\build\Release"
set "GYP=%ROOT%\node_modules\node-gyp\bin\node-gyp.js"

echo BUILD_ADDON_DIR=%ADDON%
echo BUILD_ADDON_OUT=%OUT%
echo.

rem ---- 1. probe node-gyp ----------------------------------------------------------
rem No fallback to "npx --no-install" and no silent skip. An addon-less green build
rem would make T03's OSR path look tested while testing nothing.
if not exist "%GYP%" goto :err_no_gyp
echo NODE_GYP_PATH=%GYP%

if not exist "%OUT%" mkdir "%OUT%"

rem ---- 2. two addon projects, same toolchain, same assertions ----------------------
rem THERE ARE TWO, and they are NOT duplicates: different target names, different
rem sources, different consumers. Building only one would leave a path unbuildable
rem from a fresh clone.
rem
rem   T01 harbor_spike  spike-glass\addon\     export self-check (this card's deliverable)
rem   T03 harbor_osr    spike-glass\src\addon\ OSR single-chain demo (T03's deliverable)
rem
rem T03 built harbor_osr with an ad-hoc node-gyp invocation whose evidence log lives in
rem native\build\t03\ (git-ignored), so there was no committed driver for it. This script
rem now builds both, which is why it is the single place the addon toolchain is proven.
call :build_one "%SG%\addon" harbor_spike spike_addon.cpp
if errorlevel 1 goto :fail
call :build_one "%SG%\src\addon" harbor_osr addon.cpp
if errorlevel 1 goto :fail

echo.
echo BUILD_ADDON=OK both projects
echo [NOTE] building is only half the proof. Loading is asserted separately by:
echo [NOTE]   env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS node_modules/electron/dist/electron.exe native/spike-glass/addon/selfcheck.js
echo [NOTE] expected last line: VERDICT_ADDON=LOADED_AND_CALLED
endlocal & exit /b 0

:fail
echo.
echo BUILD_ADDON=FAIL
endlocal & exit /b 1

rem ============================================================================
rem error paths -- each prints a single greppable code plus a human hint
rem ============================================================================
:err_no_gyp
echo NODE_GYP_MISSING=1
echo node-gyp MISSING at node_modules/node-gyp/bin/node-gyp.js - run "npm ci" to restore devDependencies
echo [HINT] node-gyp reaches this repo through electron-builder. If that dependency was
echo [HINT] dropped there is no addon toolchain and the OSR path cannot be built at all.
echo BUILD_ADDON=FAIL stage=probe_node_gyp
endlocal & exit /b 1

:err_no_gyp_file
echo [ERROR] missing "%ADDON%\binding.gyp"
echo BUILD_ADDON=FAIL stage=probe_binding_gyp
endlocal & exit /b 1

:err_no_src
echo [ERROR] missing "%ADDON%\spike_addon.cpp"
echo BUILD_ADDON=FAIL stage=probe_source
endlocal & exit /b 1

rem ============================================================================
rem :build_one DIR TARGET SRC -- full clean-build + assertions for one addon project
rem
rem Used for both projects so the assertions cannot drift apart: the whole point is
rem that "the addon toolchain works" must be proven the same way for harbor_spike and
rem harbor_osr, otherwise T03's path could pass a weaker check than T01's.
rem ============================================================================
:build_one
set "ONE_DIR=%~1"
set "ONE_TARGET=%~2"
set "ONE_SRC=%~3"
set "ONE_NODE=%ONE_DIR%\build\Release\%ONE_TARGET%.node"
set "ONE_HOOK=%ONE_DIR%\build\Release\obj\%ONE_TARGET%\win_delay_load_hook.obj"

echo.
echo ==== addon %ONE_TARGET% ====
echo ADDON_DIR=%ONE_DIR%

if not exist "%ONE_DIR%\binding.gyp" goto :one_no_gyp_file
if not exist "%ONE_DIR%\%ONE_SRC%" goto :one_no_src

rem A clean build every time. An incremental build hides both C-1 (missing hook
rem translation unit) and C-2 (missing /utf-8).
if exist "%ONE_DIR%\build" rmdir /s /q "%ONE_DIR%\build"
if exist "%ONE_DIR%\build" goto :one_rmdir
echo CLEAN_BUILD=1

rem --devdir is deliberately NOT passed. With --runtime=electron node-gyp defaults to
rem %LOCALAPPDATA%\node-gyp\Cache, where the 45.2.1 headers are already cached, so
rem this runs fully offline. Overriding --devdir would force a network fetch.
pushd "%ROOT%"
node -e "console.log('NODE_GYP_VER=' + require('./node_modules/node-gyp/package.json').version)"
if errorlevel 1 goto :one_gyp_ver

echo ---- node-gyp rebuild %ONE_TARGET% ----
node "%GYP%" rebuild --directory="%ONE_DIR%" --runtime=electron --target=45.2.1 --dist-url=https://electronjs.org/headers --arch=x64
set "RC=%ERRORLEVEL%"
popd

echo GYP_EXIT_%ONE_TARGET%=%RC%
if not "%RC%"=="0" goto :one_gyp_build

rem CHECK_HOOK guards C-1. Without the delay-load hook translation unit the .node loads
rem and then kills Electron silently, so assert the TU was really compiled instead of
rem trusting the link result.
rem   Negative control (measured): a stub that emits a plausibly-sized .node but no hook
rem   object gives CHECK_HOOK=0 and exit 1. Size alone does not catch this.
if not exist "%ONE_HOOK%" goto :one_no_hook
echo CHECK_HOOK=1

if not exist "%ONE_NODE%" goto :one_no_node

rem CHECK_BYTES guards the D1 rule "never fake a .node". Threshold source: MEASURED.
rem The reference node-gyp addon (native/build/m2probe harbor_probe.node) is 141,312 B,
rem harbour_spike is 143,360 B and harbor_osr is 209,920 B, while a manual-cl build of
rem the same source is about 15 KB. 100,000 B sits well above the manual-cl fingerprint
rem and below every real artifact, so a truncated, empty or renamed-other-binary file
rem fails here.
rem   Negative control (measured): a stub emitting a 100-byte file gives NODE_BYTES=100,
rem   CHECK_BYTES=0 and exit 1.
for %%F in ("%ONE_NODE%") do set "NODE_BYTES=%%~zF"
echo NODE_BYTES_%ONE_TARGET%=%NODE_BYTES%
if %NODE_BYTES% LSS 100000 goto :one_too_small
echo CHECK_BYTES=1

copy /y "%ONE_NODE%" "%OUT%\%ONE_TARGET%.node" >nul
if errorlevel 1 goto :one_copy
echo ADDON_COPIED=%OUT%\%ONE_TARGET%.node
exit /b 0

:one_no_gyp_file
echo [ERROR] missing "%ONE_DIR%\binding.gyp"
echo BUILD_ADDON=FAIL stage=probe_binding_gyp target=%ONE_TARGET%
exit /b 1

:one_no_src
echo [ERROR] missing "%ONE_DIR%\%ONE_SRC%"
echo BUILD_ADDON=FAIL stage=probe_source target=%ONE_TARGET%
exit /b 1

:one_rmdir
echo [ERROR] could not remove "%ONE_DIR%\build"
echo [HINT] close any process still holding %ONE_TARGET%.node and retry
echo BUILD_ADDON=FAIL stage=clean target=%ONE_TARGET%
exit /b 1

:one_gyp_ver
popd
echo [ERROR] cannot read the node-gyp version - the node_modules layout is broken
echo BUILD_ADDON=FAIL stage=node_gyp_version
exit /b 1

:one_gyp_build
echo BUILD_ADDON=FAIL stage=node_gyp target=%ONE_TARGET%
exit /b 1

:one_no_hook
echo CHECK_HOOK=0
echo [ERROR] win_delay_load_hook.obj is absent for %ONE_TARGET% - it would crash Electron silently
echo [HINT] do NOT fall back to a manual "cl /LD"; fix binding.gyp instead
echo BUILD_ADDON=FAIL stage=hook_check target=%ONE_TARGET%
exit /b 1

:one_no_node
echo [ERROR] missing "%ONE_NODE%"
echo BUILD_ADDON=FAIL stage=artifact_check target=%ONE_TARGET%
exit /b 1

:one_too_small
echo CHECK_BYTES=0
echo [ERROR] %ONE_TARGET%.node is only %NODE_BYTES% bytes, far below the 100000 floor
echo [HINT] this is the manual-cl or fake-artifact fingerprint, not a real node-gyp build
echo BUILD_ADDON=FAIL stage=bytes_check target=%ONE_TARGET%
exit /b 1

:one_copy
echo [ERROR] cannot copy %ONE_TARGET% into "%OUT%"
echo BUILD_ADDON=FAIL stage=copy target=%ONE_TARGET%
exit /b 1
endlocal & exit /b 1