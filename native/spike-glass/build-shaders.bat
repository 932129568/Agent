@echo off
REM ===========================================================================
REM native/spike-glass/build-shaders.bat
REM Harbor glass HLSL dual-tier build driver (fxc, absolute path).
REM
REM ONE source file per shader, TWO compile passes selected by -D:
REM   LOW    : no define
REM   HIGH   : /DGLASS_TIER_HIGH=1
REM
REM OUTPUTS -- two chains that must never share a directory:
REM   squircle tier matrix : native/spike-glass/shaders/tiers/
REM                          8 files: squircle_ps_low/high/exact/poly x cso+asm
REM   kawase tier matrix   : native/spike-glass/build/Release/shaders/tiers/
REM
REM The M1 baseline stems (squircle_ps_exact, squircle_ps_poly, kawase_cs_down,
REM kawase_cs_up, *_sm51) are owned by native/build-m2-shaders.bat and land in
REM native/spike-glass/build/Release/shaders/. THIS script must never write
REM there: a 05:41 run of that script overwrote the HIGH tier binaries with
REM baseline copies, leaving every .cso on the LOW path with no visible error.
REM
REM HARD RULES:
REM   1. Pure ASCII only. cmd.exe parses .bat byte-wise in the OEM codepage; a
REM      non-ASCII byte on an LF boundary desyncs the parser, the leftover bytes
REM      run as a command, and EXIT still reads 0. Silent, so never put CJK here.
REM   2. CRLF line endings. A pure-ASCII .bat saved with bare LF breaks
REM      "call :label" with "the system cannot find the batch label". That
REM      failure is loud here, but inside an if-block it becomes a false green.
REM      Never rewrite this file with a tool that normalises to LF.
REM   3. No angle brackets in REM lines, no closing paren inside an echo within
REM      an if-block (see the build-m2-native.bat house rules).
REM   4. Any failed target exits non-zero immediately.
REM   5. Do not touch native/build/m2probe/ or native/spike-glass/build-native.bat.
REM
REM usage (from repo root): cmd //c native\spike-glass\build-shaders.bat
REM ===========================================================================
setlocal EnableExtensions

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "SRC=%ROOT%\shaders"
set "OUT=%SRC%\tiers"
set "KOUT=%ROOT%\build\Release\shaders\tiers"
set "FXC=C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\fxc.exe"

if not exist "%FXC%" goto :err_no_fxc
if not exist "%SRC%\squircle_ps.hlsl" goto :err_no_src
if not exist "%SRC%\kawase_cs.hlsl" goto :err_no_src
if not exist "%OUT%" mkdir "%OUT%"
if not exist "%KOUT%" mkdir "%KOUT%"

echo BUILD_SHADERS_TIER_OUT=%OUT%
echo BUILD_SHADERS_KAWASE_OUT=%KOUT%
echo FXC_PATH=%FXC%
echo.

rem --------------------------------------------------------------------------
rem squircle tier matrix: 4 stems into shaders\tiers\
rem   ps_low   = main, no define            (the real LOW tier)
rem   ps_high  = main, -DGLASS_TIER_HIGH=1  (the real HIGH tier)
rem   ps_exact = main, no define            (M1 sentinel name, pinned to LOW)
rem   ps_poly  = poly, no define            (M1 sentinel name, pinned to LOW)
rem exact and poly are byte-identical to low BY DESIGN -- see verify_tiers.py G2.
rem --------------------------------------------------------------------------

echo ===== squircle_ps.hlsl : ps_low (no define) =====
call :compile "%OUT%" ps_5_0 main "" squircle_ps_low squircle_ps.hlsl
if errorlevel 1 goto :fail

echo ===== squircle_ps.hlsl : ps_high (-DGLASS_TIER_HIGH=1) =====
call :compile "%OUT%" ps_5_0 main "GLASS_TIER_HIGH=1" squircle_ps_high squircle_ps.hlsl
if errorlevel 1 goto :fail

echo ===== squircle_ps.hlsl : ps_exact (main, M1 sentinel, pinned LOW) =====
call :compile "%OUT%" ps_5_0 main "" squircle_ps_exact squircle_ps.hlsl
if errorlevel 1 goto :fail

echo ===== squircle_ps.hlsl : ps_poly (poly, M1 sentinel, pinned LOW) =====
call :compile "%OUT%" ps_5_0 poly "" squircle_ps_poly squircle_ps.hlsl
if errorlevel 1 goto :fail

rem --------------------------------------------------------------------------
rem kawase tier matrix: cs_5_0 down/up, LOW and HIGH. Supplementary evidence.
rem ddx/ddy are ILLEGAL in a compute shader (fxc X4532), so the up pass uses
rem explicit SampleLevel only. Do not "optimise" that back to derivatives.
rem --------------------------------------------------------------------------

echo ===== kawase_cs.hlsl : down LOW (cs_5_0) =====
call :compile "%KOUT%" cs_5_0 main_down "" kawase_down_low kawase_cs.hlsl
if errorlevel 1 goto :fail

echo ===== kawase_cs.hlsl : down HIGH (cs_5_0) =====
call :compile "%KOUT%" cs_5_0 main_down "GLASS_TIER_HIGH=1" kawase_down_high kawase_cs.hlsl
if errorlevel 1 goto :fail

echo ===== kawase_cs.hlsl : up LOW (cs_5_0) =====
call :compile "%KOUT%" cs_5_0 main_up "" kawase_up_low kawase_cs.hlsl
if errorlevel 1 goto :fail

echo ===== kawase_cs.hlsl : up HIGH (cs_5_0) =====
call :compile "%KOUT%" cs_5_0 main_up "GLASS_TIER_HIGH=1" kawase_up_high kawase_cs.hlsl
if errorlevel 1 goto :fail

echo.
echo ---- squircle tier artifacts, bytes ----
for %%F in ("%OUT%\squircle_ps_*.cso") do echo CSO %%~nxF %%~zF
for %%F in ("%OUT%\squircle_ps_*.asm") do echo ASM %%~nxF %%~zF

rem Post-run assertion: fxc returning 0 without writing output is possible with a
rem bad path, and a stale file from a previous run would mask a target that
rem silently stopped building.
call :check_owned "%OUT%" squircle_ps_low
if errorlevel 1 goto :fail
call :check_owned "%OUT%" squircle_ps_high
if errorlevel 1 goto :fail
call :check_owned "%OUT%" squircle_ps_exact
if errorlevel 1 goto :fail
call :check_owned "%OUT%" squircle_ps_poly
if errorlevel 1 goto :fail
call :check_owned "%KOUT%" kawase_down_low
if errorlevel 1 goto :fail
call :check_owned "%KOUT%" kawase_down_high
if errorlevel 1 goto :fail
call :check_owned "%KOUT%" kawase_up_low
if errorlevel 1 goto :fail
call :check_owned "%KOUT%" kawase_up_high
if errorlevel 1 goto :fail

echo.
echo ALL_SHADERS_OK
endlocal & exit /b 0

:fail
echo.
echo BUILD_SHADERS_FAILED
endlocal & exit /b 1

:err_no_fxc
echo BUILD_SHADERS_FAILED: fxc not found at "%FXC%"
echo [HINT] the Windows SDK version changed. Do NOT downgrade to a static review:
echo [HINT] the compiled listing is the evidence the design depends on.
endlocal & exit /b 2

:err_no_src
echo BUILD_SHADERS_FAILED: shader source missing under "%SRC%"
endlocal & exit /b 2

REM ---------------------------------------------------------------------------
REM :compile  ARG1=outdir ARG2=target ARG3=entry ARG4=defines-or-empty
REM           ARG5=out-stem ARG6=source-file
REM Emits OUTDIR\STEM.cso and OUTDIR\STEM.asm, prints the exit code, returns it.
REM ---------------------------------------------------------------------------
:compile
set "C_DIR=%~1"
set "C_TARGET=%~2"
set "C_ENTRY=%~3"
set "C_DEFINE=%~4"
set "C_STEM=%~5"
set "C_FILE=%~6"

set "C_DEFARG="
if not "%C_DEFINE%"=="" set "C_DEFARG=/D%C_DEFINE%"

"%FXC%" /nologo /T %C_TARGET% /E %C_ENTRY% %C_DEFARG% /Fo "%C_DIR%\%C_STEM%.cso" /Fc "%C_DIR%\%C_STEM%.asm" "%SRC%\%C_FILE%"
set "C_RC=%ERRORLEVEL%"
echo EXITCODE_%C_STEM%=%C_RC%
if not "%C_RC%"=="0" exit /b %C_RC%
exit /b 0

REM ---------------------------------------------------------------------------
REM :check_owned ARG1=outdir ARG2=stem -- both artefacts must exist
REM ---------------------------------------------------------------------------
:check_owned
if not exist "%~1\%~2.cso" goto :owned_missing
if not exist "%~1\%~2.asm" goto :owned_missing
echo VERIFIED=%~2
exit /b 0

:owned_missing
echo [ERROR] expected artifact missing: "%~1\%~2.cso" or "%~1\%~2.asm"
exit /b 1