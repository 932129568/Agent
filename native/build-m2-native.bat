@echo off
rem ============================================================================
rem build-m2-native.bat -- M2 T01 native C++ chain (MSVC, hand-injected environment)
rem
rem LIVES IN native/ ON PURPOSE. A .bat under any "build/" directory is swallowed by
rem .gitignore (line 40 is a bare "build/"), so the script itself would never be
rem committed and the spike would not be reproducible from a fresh clone. Only build
rem ARTIFACTS belong under a build/ directory; drivers and configs must not.
rem
rem HOUSE RULES for every .bat in this directory (each was learned the hard way):
rem
rem 1. ASCII ONLY. A non-ASCII byte plus LF line endings desyncs cmd: it cuts a rem
rem    line mid-byte, runs the leftovers as commands, and STILL returns 0 (R100 2x2).
rem 2. No angle brackets in rem lines. cmd still honours redirection there and the
rem    remainder of the line is eaten -- including any "call :label" that follows it.
rem 3. Never put a closing parenthesis in an echo message inside an if-block. It closes
rem    the block early and the leftovers are executed as commands.
rem 4. vcvars64.bat is unusable: its internal reg.exe call is blocked by security
rem    policy. INCLUDE/LIB/PATH are set by hand instead.
rem 5. cl must be driven from a .bat, never straight from Git Bash: MSYS rewrites
rem    /nologo, /Fe: and friends into bogus paths.
rem 6. /utf-8 is mandatory, otherwise MSVC reads these sources as GBK and the trailing
rem    0x5C byte of a CJK character swallows the next line.
rem
rem usage: cmd //c native\build-m2-native.bat [all^|d3d_probe^|dcomp_host^|layout_probe^|osr_bridge]
rem        no argument means all
rem
rem outputs, under native\spike-glass\build\Release:
rem          TARGET.exe for translation units that own a main function
rem          obj\TARGET.obj for every unit
rem ============================================================================
setlocal EnableExtensions

for %%I in ("%~dp0.") do set "NATIVE=%%~fI"
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
set "SG=%NATIVE%\spike-glass"

set "SRC=%SG%\src"
set "INC=%NATIVE%\harbor-glass\include"
set "OUT=%SG%\build\Release"
set "OBJ=%OUT%\obj"

set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=all"

rem target validation: fail fast on a typo instead of silently building nothing
if /I "%TARGET%"=="all" goto :target_ok
if /I "%TARGET%"=="d3d_probe" goto :target_ok
if /I "%TARGET%"=="dcomp_host" goto :target_ok
if /I "%TARGET%"=="layout_probe" goto :target_ok
if /I "%TARGET%"=="osr_bridge" goto :target_ok
echo [ERROR] unknown target: %TARGET%
echo usage: build-m2-native.bat all OR d3d_probe OR dcomp_host OR layout_probe OR osr_bridge
echo BUILD_NATIVE=FAIL stage=target_validation
endlocal & exit /b 2
:target_ok

rem toolchain -----------------------------------------------------------------------
set "MSVC=C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.51.36231"
set "KITS=C:\Program Files (x86)\Windows Kits\10"
set "KV=10.0.26100.0"

if not exist "%MSVC%\bin\Hostx64\x64\cl.exe" goto :err_no_cl

set "PATH=%MSVC%\bin\Hostx64\x64;%PATH%"
set "INCLUDE=%MSVC%\include;%KITS%\Include\%KV%\ucrt;%KITS%\Include\%KV%\um;%KITS%\Include\%KV%\shared;%KITS%\Include\%KV%\winrt"
set "LIB=%MSVC%\lib\x64;%KITS%\Lib\%KV%\ucrt\x64;%KITS%\Lib\%KV%\um\x64"

rem /c is deliberately NOT in CFLAGS. A stray /c silently turns "compile and link" into
rem "compile only": cl reports success and the .exe simply never appears, which is
rem exactly how a broken exe target would hide.
rem
rem UNICODE/_UNICODE are defined on purpose. The M2 host code is wide-char throughout
rem (CreateWindowExW / RegisterClassExW), but the IDC_ARROW class macro expands to the
rem ANSI variant without UNICODE, so LoadCursorW receives an LPSTR and fails with
rem C2664. Defining the pair fixes every such call site at once instead of scattering
rem casts through the sources, and it matches the /D convention the addon chain gets
rem from node-gyp's gypi, so both chains agree on character width.
set "CFLAGS=/nologo /utf-8 /EHsc /W4 /std:c++20 /MD /O2 /DUNICODE /D_UNICODE /D_CRT_SECURE_NO_WARNINGS /D_CRT_NONSTDC_NO_DEPRECATE"

if not exist "%OUT%" mkdir "%OUT%"
if not exist "%OBJ%" mkdir "%OBJ%"

echo BUILD_NATIVE_TARGET=%TARGET%
echo BUILD_NATIVE_SRC=%SRC%
echo BUILD_NATIVE_OUT=%OUT%
echo.

rem Compile order is dependency order and library-side units come first, so a missing
rem main is discovered before anything links rather than after.
call :build_obj dcomp_host
if errorlevel 1 goto :fail
call :build_obj osr_bridge
if errorlevel 1 goto :fail
call :build_exe layout_probe
if errorlevel 1 goto :fail
call :build_exe2 d3d_probe d3d11.lib dxgi.lib dcomp.lib dwmapi.lib user32.lib gdi32.lib
if errorlevel 1 goto :fail

echo.
echo ---- artifacts ----
dir /b "%OUT%\*.exe" 2>nul
dir /b "%OBJ%\*.obj" 2>nul
echo.
echo BUILD_NATIVE=OK target=%TARGET%
endlocal & exit /b 0

:fail
echo.
echo BUILD_NATIVE=FAIL target=%TARGET%
endlocal & exit /b 1

:err_no_cl
echo [ERROR] cl.exe not found at "%MSVC%\bin\Hostx64\x64\cl.exe"
echo [HINT] the MSVC toolchain moved, or the C++ build tools were removed
echo BUILD_NATIVE=FAIL stage=toolchain
endlocal & exit /b 1

rem ============================================================================
rem :want NAME -- return 0 when NAME should be built under the current TARGET
rem ============================================================================
:want
if /I "%TARGET%"=="all" exit /b 0
if /I "%TARGET%"=="%~1" exit /b 0
exit /b 1

rem ============================================================================
rem :build_obj NAME -- compile-only unit that owns no main
rem ============================================================================
:build_obj
call :want %~1
if errorlevel 1 exit /b 0
set "N=%~1"
echo ==== [obj] %N%.cpp ====
cl %CFLAGS% /c /I "%INC%" "%SRC%\%N%.cpp" /Fo"%OBJ%\%N%.obj"
if errorlevel 1 goto :obj_fail
echo COMPILE_OK=%N%
exit /b 0

:obj_fail
echo COMPILE_FAIL=%N%
exit /b 1

rem ============================================================================
rem :build_exe NAME -- compile and link a unit that owns a main, no extra libraries
rem ============================================================================
:build_exe
call :want %~1
if errorlevel 1 exit /b 0
set "N=%~1"
echo ==== [exe] %N%.cpp ====
cl %CFLAGS% /I "%INC%" "%SRC%\%N%.cpp" /Fo"%OBJ%\%N%.obj" /Fe"%OUT%\%N%.exe"
if errorlevel 1 goto :exe_fail
goto :exe_check

:exe_fail
echo LINK_FAIL=%N%
exit /b 1

:exe_check
rem cl can return 0 without producing the binary; assert existence rather than trust
rem the exit code alone, otherwise a /c slip-through looks like a successful build.
if not exist "%OUT%\%N%.exe" goto :exe_missing
echo LINK_OK=%N%
exit /b 0

:exe_missing
echo LINK_FAIL=%N% reason=exe_missing
exit /b 1

rem ============================================================================
rem :build_exe2 NAME LIB [LIB ...] -- build_exe plus an explicit link list
rem The libraries are spelled out one per argument on purpose: %* is not reliably
rem scoped to the call frame inside a labelled subroutine, a shift loop is.
rem ============================================================================
:build_exe2
call :want %~1
if errorlevel 1 exit /b 0
set "N=%~1"
echo ==== [exe] %N%.cpp ====
set "LINKARGS="
shift
:exe2_collect
if "%~1"=="" goto :exe2_link
set "LINKARGS=%LINKARGS% %1"
shift
goto :exe2_collect
:exe2_link
cl %CFLAGS% /I "%INC%" "%SRC%\%N%.cpp" /Fo"%OBJ%\%N%.obj" /Fe"%OUT%\%N%.exe" /link%LINKARGS%
if errorlevel 1 goto :exe2_fail
if not exist "%OUT%\%N%.exe" goto :exe2_missing
echo LINK_OK=%N%
exit /b 0

:exe2_fail
echo LINK_FAIL=%N%
exit /b 1

:exe2_missing
echo LINK_FAIL=%N% reason=exe_missing
exit /b 1