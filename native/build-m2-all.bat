@echo off
rem ============================================================================
rem build-m2-all.bat -- M2 T01 umbrella build: native, then shaders, then addon
rem
rem LIVES IN native/ ON PURPOSE: a .bat under any "build/" directory is swallowed by
rem .gitignore (line 40 is a bare "build/"), so the driver itself would never be
rem committed. Only artifacts belong in build/.
rem
rem HOUSE RULES for every .bat in this directory: see build-m2-native.bat. In short:
rem ASCII only, no angle brackets in rem lines, never a closing parenthesis inside an
rem echo within an if-block, goto instead of parenthesised blocks.
rem
rem Any stage returning non-zero stops the run immediately and returns non-zero.
rem Three mutually incompatible toolchains live behind this wrapper -- MSVC cl, fxc and
rem node-gyp -- and a "continue anyway" would let one broken chain hide behind two
rem green ones. Each stage prints its own BUILD_*=FAIL line naming the toolchain that
rem broke, so a red run points at the culprit instead of at this wrapper.
rem
rem usage: cmd //c native\build-m2-all.bat [all^|d3d_probe^|dcomp_host^|layout_probe^|osr_bridge]
rem        the optional argument is forwarded to build-m2-native.bat
rem ============================================================================
setlocal EnableExtensions

for %%I in ("%~dp0.") do set "NATIVE=%%~fI"

set "NATIVE_ARG=%~1"
if "%NATIVE_ARG%"=="" set "NATIVE_ARG=all"

echo ############################################################
echo # [1/4] native C++ via cl
echo ############################################################
call "%NATIVE%\build-m2-native.bat" %NATIVE_ARG%
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto :fail_native

echo.
echo ############################################################
echo # [2/4] HLSL shaders via fxc
echo ############################################################
call "%NATIVE%\build-m2-shaders.bat"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto :fail_shaders

echo.
echo ############################################################
echo # [3/4] N-API addon via node-gyp
echo ############################################################
call "%NATIVE%\build-m2-addon.bat"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto :fail_addon

echo.
echo ############################################################
echo # [4/4] addon load self-check inside Electron
echo ############################################################
rem This stage is the whole point of C-1. A .node produced by a hand-rolled "cl /LD"
rem builds fine and then kills Electron silently on require(), so "the build went green"
rem cannot distinguish a loadable addon from a fatal one. Only loading it does.
rem
rem The env scrub is mandatory, not cosmetic: the ambient shell carries
rem ELECTRON_RUN_AS_NODE=1, which degrades electron.exe into plain node and makes `app`
rem undefined. That produces a false red indistinguishable from a real crash.
rem
rem Selfcheck runs OUTSIDE Electron's main process API surface? No -- it needs app, so it
rem must run under electron.exe with the scrub applied. `env` is not a cmd builtin, so the
rem scrub is done with SET-local variables here instead of shelling out to env.
set "ELECTRON_EXE=%NATIVE%\..\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON_EXE%" goto :fail_selfcheck_missing

set "ERAN=%ELECTRON_RUN_AS_NODE%"
set "NOPTS=%NODE_OPTIONS%"
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="
"%ELECTRON_EXE%" "%NATIVE%\spike-glass\addon\selfcheck.js"
set "RC=%ERRORLEVEL%"
set "ELECTRON_RUN_AS_NODE=%ERAN%"
set "NODE_OPTIONS=%NOPTS%"
if not "%RC%"=="0" goto :fail_selfcheck

echo.
echo ############################################################
echo # BUILD_ALL=OK native + shaders + addon + addon-loaded
echo ############################################################
endlocal & exit /b 0

:fail_native
echo.
echo BUILD_ALL=FAIL stage=native rc=%RC%
endlocal & exit /b %RC%

:fail_shaders
echo.
echo BUILD_ALL=FAIL stage=shaders rc=%RC%
endlocal & exit /b %RC%

:fail_addon
echo.
echo BUILD_ALL=FAIL stage=addon rc=%RC%
endlocal & exit /b %RC%

:fail_selfcheck
echo.
echo BUILD_ALL=FAIL stage=addon_selfcheck rc=%RC%
endlocal & exit /b %RC%

:fail_selfcheck_missing
echo.
echo [ERROR] electron.exe not found at "%ELECTRON_EXE%"
echo [HINT] the load self-check cannot run, so C-1 is unproven
echo BUILD_ALL=FAIL stage=addon_selfcheck reason=electron_missing
endlocal & exit /b 1