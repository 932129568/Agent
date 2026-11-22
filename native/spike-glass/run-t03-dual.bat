@echo off
rem ============================================================================
rem run-t03-dual.bat -- run osr_demo.js at BOTH refresh tiers and roll up the
rem cross-tier verdict into P0_3_STATUS.
rem
rem Why a separate runner and not a flag inside osr_demo.js:
rem A single Electron process can only ever be configured for one display tier.
rem Letting one process claim PASS_BOTH would mean it asserts a result it never
rem measured. So each tier runs in its own process, writes its own JSON, and this
rem script is the only place that can say PASS_BOTH.
rem
rem Roll-up rule (three states, PRD 5.2):
rem   both tiers TIER_PASS          -> P0_3_STATUS=PASS_BOTH
rem   60 TIER_PASS, 165 TIER_FAIL   -> P0_3_STATUS=PASS_BASELINE_ONLY
rem   60 TIER_FAIL                  -> P0_3_STATUS=FAIL   (baseline is the floor)
rem A 165-tier failure NEVER downgrades a 60-tier pass to a plain FAIL: the
rem baseline tier is the shipping requirement, 165 is the stretch finding.
rem
rem ASCII ONLY. A non-ASCII byte plus LF line endings desyncs cmd: it cuts a rem
rem line mid-byte, executes the leftovers, AND still returns 0.
rem
rem usage: cmd //c native\spike-glass\run-t03-dual.bat
rem ============================================================================
setlocal EnableExtensions

for %%I in ("%~dp0.") do set "SG=%%~fI"
for %%I in ("%~dp0..") do set "NATIVE=%%~fI"
for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"

set "ELECTRON=%ROOT%\node_modules\electron\dist\electron.exe"
set "DEMO=%SG%\src\osr_demo.js"
set "OUTDIR=%SG%\build\t03"
set "LOG60=%OUTDIR%\run-60hz.log"
set "LOG165=%OUTDIR%\run-165hz.log"

if not exist "%ELECTRON%" goto :err_no_electron
if not exist "%DEMO%" goto :err_no_demo
if not exist "%OUTDIR%" mkdir "%OUTDIR%"

rem Electron refuses to run the app when ELECTRON_RUN_AS_NODE is inherited from a
rem parent shell that was itself launched by node. Strip both, and clear NODE_OPTIONS
rem which can inject a --require hook into the renderer.
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="

echo ============ TIER 60Hz ============
set "OSR_HZ=60"
rem OSR_REPLAY_60 / OSR_REPLAY_165: skip the live run and re-judge an EXISTING log.
rem This exists solely so the roll-up logic can be negative-controlled. Without
rem it the only way to inject a failing tier was to append a FAIL line to a log
rem file -- which the next live run overwrites, so the injection silently
rem disappeared and the roll-up reported PASS_BOTH anyway. A negative control
rem aimed at a file that gets rewritten is not a control at all.
if defined OSR_REPLAY_60 (
  set "LOG60=%OSR_REPLAY_60%"
  echo TIER60_REPLAY=%LOG60%
) else (
  "%ELECTRON%" "%DEMO%" > "%LOG60%" 2>&1
  set "RC60=%ERRORLEVEL%"
  echo TIER60_EXIT=%RC60%
)
findstr /C:"P0_3_TIER_RESULT=PASS" "%LOG60%" >nul
if errorlevel 1 (set "T60=0") else (set "T60=1")
findstr /C:"P0_3_ALL=FAIL" "%LOG60%" >nul
if not errorlevel 1 set "T60=0"
echo TIER60_VERDICT=%T60%

echo ============ TIER 165Hz ============
set "OSR_HZ=165"
if defined OSR_REPLAY_165 (
  set "LOG165=%OSR_REPLAY_165%"
  echo TIER165_REPLAY=%LOG165%
) else (
  "%ELECTRON%" "%DEMO%" > "%LOG165%" 2>&1
  set "RC165=%ERRORLEVEL%"
  echo TIER165_EXIT=%RC165%
)
findstr /C:"P0_3_TIER_RESULT=PASS" "%LOG165%" >nul
if errorlevel 1 (set "T165=0") else (set "T165=1")
findstr /C:"P0_3_ALL=FAIL" "%LOG165%" >nul
if not errorlevel 1 set "T165=0"
echo TIER165_VERDICT=%T165%

echo ============ ROLL-UP ============
rem Note: both the positive token AND the absence of the FAIL token must hold.
rem A log that contains BOTH (a PASS line from an earlier phase followed by a
rem late FAIL) is treated as FAIL, which is the conservative direction.
set "STATUS=FAIL"
if "%T60%"=="1" set "STATUS=PASS_BASELINE_ONLY"
if "%T60%%T165%"=="11" set "STATUS=PASS_BOTH"
echo P0_3_STATUS=%STATUS%
echo P0_3_STATUS_TIER60=%T60%
echo P0_3_STATUS_TIER165=%T165%

(
  echo STATUS=%STATUS%
  echo TIER60=%T60%  EXIT=%RC60%  LOG=%LOG60%
  echo TIER165=%T165%  EXIT=%RC165%  LOG=%LOG165%
) > "%OUTDIR%\p03-status.txt"

rem Only PASS_BOTH exits 0. PASS_BASELINE_ONLY exits 2 so a CI that treats
rem non-zero as "the stretch goal was met" cannot silently accept it.
if "%STATUS%"=="PASS_BOTH" (echo RUN_T03_DUAL=DONE & endlocal & exit /b 0)
if "%STATUS%"=="PASS_BASELINE_ONLY" (echo RUN_T03_DUAL=BASELINE_ONLY & endlocal & exit /b 2)
echo RUN_T03_DUAL=FAIL
endlocal & exit /b 1

:err_no_electron
echo [ERROR] electron not found: %ELECTRON%
echo [HINT] run npm ci in the repo root
endlocal & exit /b 4

:err_no_demo
echo [ERROR] demo not found: %DEMO%
endlocal & exit /b 5