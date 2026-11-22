@echo off
rem ============================================================================
rem build-m2-shaders.bat -- M2 T01 HLSL chain (fxc, absolute path, no env injection)
rem
rem LIVES IN native/ ON PURPOSE: a .bat under any "build/" directory is swallowed by
rem .gitignore (line 40 is a bare "build/"), so the driver itself would never be
rem committed. Only artifacts belong in build/.
rem
rem HOUSE RULES for every .bat in this directory: see build-m2-native.bat. In short:
rem ASCII only, no angle brackets in rem lines, never a closing parenthesis inside an
rem echo within an if-block, goto instead of parenthesised blocks.
rem
rem T04 OWNS THE SHADER TIERS. This script only guarantees the four original entry
rem points still compile, as a regression sentinel: if an edit breaks the whole-file
rem structure, it breaks here first. Add new entries at the bottom of the ENTRY LIST
rem and do not remove the existing four -- T02/T03/T04 acceptance commands reference
rem these stems.
rem
rem fxc needs no INCLUDE/LIB/PATH. It is called by absolute quoted path because the SDK
rem path contains spaces, and it is not on PATH. Like cl, it cannot be driven straight
rem from Git Bash: MSYS rewrites the slash arguments.
rem
rem Every target emits BOTH .cso and .asm. The .asm is not a nicety -- it is the only
rem hard evidence of instruction count, dcl_temps, sample_* and ld_structured. "It
rem compiled" cannot distinguish a real kernel from an empty one: both return 0
rem (R100 M15b measured 25 instructions for a real kernel vs 2 for an empty one).
rem
rem Do not count the bare word "sample" in an .asm: the header comments contain
rem "sampler" and "dcl_sampler" and inflate it (measured 5 vs 3). Count
rem sample_indexable plus sample_l_indexable, or count opcode lines after the header.
rem
rem usage: cmd //c native\build-m2-shaders.bat
rem outputs: native\spike-glass\build\Release\shaders\STEM.cso and STEM.asm
rem ============================================================================
setlocal EnableExtensions

for %%I in ("%~dp0.") do set "NATIVE=%%~fI"
set "SG=%NATIVE%\spike-glass"

set "SHADERS=%SG%\shaders"
set "OUT=%SG%\build\Release\shaders"
set "FXC=C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\fxc.exe"

if not exist "%FXC%" goto :err_no_fxc
if not exist "%OUT%" mkdir "%OUT%"

echo BUILD_SHADERS_SRC=%SHADERS%
echo BUILD_SHADERS_OUT=%OUT%
echo FXC_PATH=%FXC%
echo.

rem ---------------------------------------------------------------------------
rem ENTRY LIST -- stem, profile, entry point, source file, extra /D defines
rem Add rows at the end. The first four are the frozen regression sentinels.
rem ---------------------------------------------------------------------------

rem ps_5_0: squircle coverage, two entry points. These two are the sentinels the M1
rem evidence baseline was taken on, so they stay even though T04 now drives the tier
rem matrix through the GLASS_TIER_HIGH macro instead.
call :fx squircle_ps_exact ps_5_0 main squircle_ps.hlsl
if errorlevel 1 goto :fail
call :fx squircle_ps_poly ps_5_0 poly squircle_ps.hlsl
if errorlevel 1 goto :fail

rem cs_5_0: dual kawase down and up sampling. cs_5_0 is the design baseline (R101 T04).
rem ddx and ddy are ILLEGAL in a compute shader -- fxc reports X4532 -- so the up pass
rem uses explicit SampleLevel only. Do not "optimise" that back to derivatives.
call :fx kawase_cs_down cs_5_0 main_down kawase_cs.hlsl
if errorlevel 1 goto :fail
call :fx kawase_cs_up cs_5_0 main_up kawase_cs.hlsl
if errorlevel 1 goto :fail

rem cs_5_1: the same kernels on the newer profile. Measured working on this machine,
rem so it is recorded as a capability datapoint rather than left unverified. Kept
rem distinct from the cs_5_0 stems so a future tier change cannot silently overwrite
rem the baseline evidence.
call :fx kawase_cs_down_sm51 cs_5_1 main_down kawase_cs.hlsl
if errorlevel 1 goto :fail
call :fx kawase_cs_up_sm51 cs_5_1 main_up kawase_cs.hlsl
if errorlevel 1 goto :fail

echo.
echo ---- artifacts, bytes ----
for %%F in ("%OUT%\*.cso") do echo CSO %%~nxF %%~zF
for %%F in ("%OUT%\*.asm") do echo ASM %%~nxF %%~zF

rem Assert every stem this script owns really produced both files. fxc returning 0
rem without writing output is possible with a bad path, and a stale .cso from a
rem previous run would otherwise mask a target that silently stopped building.
call :check_owned squircle_ps_exact
if errorlevel 1 goto :fail
call :check_owned squircle_ps_poly
if errorlevel 1 goto :fail
call :check_owned kawase_cs_down
if errorlevel 1 goto :fail
call :check_owned kawase_cs_up
if errorlevel 1 goto :fail
call :check_owned kawase_cs_down_sm51
if errorlevel 1 goto :fail
call :check_owned kawase_cs_up_sm51
if errorlevel 1 goto :fail

echo.
echo FXC_EXIT=0
echo BUILD_SHADERS=OK
endlocal & exit /b 0

:fail
echo.
echo FXC_EXIT=1
echo BUILD_SHADERS=FAIL
endlocal & exit /b 1

:err_no_fxc
echo [ERROR] fxc.exe not found at "%FXC%"
echo [HINT] the Windows SDK version changed. Do NOT downgrade this to a static review of
echo [HINT] the HLSL: the compiled listing is the evidence the design depends on.
echo FXC_EXIT=1
echo BUILD_SHADERS=FAIL stage=probe_fxc
endlocal & exit /b 1

rem ============================================================================
rem :fx STEM PROFILE ENTRY SOURCEFILE
rem A non-zero fxc exit stops the whole build immediately. No "compile the rest and
rem hope" behaviour: that is how a broken shader slips through on a green run.
rem ============================================================================
:fx
set "STEM=%~1"
set "PROFILE=%~2"
set "ENTRY=%~3"
set "SOURCE=%SHADERS%\%~4"
echo ==== fxc %STEM% profile=%PROFILE% entry=%ENTRY% ====
if not exist "%SOURCE%" goto :fx_no_source
"%FXC%" /nologo /T %PROFILE% /E %ENTRY% /Fo "%OUT%\%STEM%.cso" /Fc "%OUT%\%STEM%.asm" "%SOURCE%"
set "RC=%ERRORLEVEL%"
echo FXC_EXIT_%STEM%=%RC%
if not "%RC%"=="0" exit /b 1
if not exist "%OUT%\%STEM%.cso" goto :fx_no_cso
if not exist "%OUT%\%STEM%.asm" goto :fx_no_asm
exit /b 0

:fx_no_source
echo [ERROR] shader source missing: "%SOURCE%"
exit /b 1

:fx_no_cso
echo [ERROR] fxc reported success but "%STEM%.cso" is missing
exit /b 1

:fx_no_asm
echo [ERROR] fxc reported success but "%STEM%.asm" is missing
exit /b 1

rem ============================================================================
rem :check_owned STEM -- post-run assertion for one stem this script wrote
rem ============================================================================
:check_owned
if not exist "%OUT%\%~1.cso" goto :owned_cso_missing
if not exist "%OUT%\%~1.asm" goto :owned_asm_missing
echo VERIFIED=%~1
exit /b 0

:owned_cso_missing
echo [ERROR] expected artifact missing: "%OUT%\%~1.cso"
exit /b 1

:owned_asm_missing
echo [ERROR] expected artifact missing: "%OUT%\%~1.asm"
exit /b 1