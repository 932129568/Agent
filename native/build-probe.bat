@echo off
REM build-probe.bat -- inject MSVC env by hand (vcvars64.bat calls reg.exe, blocked by security policy)
REM usage (from repo root): cmd //c native\build-probe.bat [nover]
REM   nover = compile/link only, skip running the probe exes (for locked-down sandboxes)
REM NOTE: keep this file ASCII-only; cmd parses .bat in codepage 936 and UTF-8 comments desync.
setlocal EnableExtensions
if /I "%~1"=="nover" set "NORUN=1"

set "NATIVE=%~dp0"
if "%NATIVE:~-1%"=="\" set "NATIVE=%NATIVE:~0,-1%"

set "MSVC=C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.51.36231"
set "KITS=C:\Program Files (x86)\Windows Kits\10"
set "KV=10.0.26100.0"

set "PATH=%MSVC%\bin\Hostx64\x64;%PATH%"
set "INCLUDE=%MSVC%\include;%KITS%\Include\%KV%\ucrt;%KITS%\Include\%KV%\um;%KITS%\Include\%KV%\shared"
set "LIB=%MSVC%\lib\x64;%KITS%\Lib\%KV%\ucrt\x64;%KITS%\Lib\%KV%\um\x64"

set "OUT=%NATIVE%\build"
if not exist "%OUT%" mkdir "%OUT%"

set "INC=%NATIVE%\harbor-glass\include"
set "SRC=%NATIVE%\spike-glass\src"
set "CFLAGS=/nologo /c /utf-8 /W4 /EHsc /std:c++17"

echo ==== [1/4] osr_bridge.cpp ====
cl %CFLAGS% /I "%INC%" "%SRC%\osr_bridge.cpp" /Fo"%OUT%\osr_bridge.obj"
set "RC=%ERRORLEVEL%"
echo EXITCODE_OSR_BRIDGE=%RC%
if not "%RC%"=="0" exit /b %RC%

echo ==== [2/4] dcomp_host.cpp ====
cl %CFLAGS% /I "%INC%" "%SRC%\dcomp_host.cpp" /Fo"%OUT%\dcomp_host.obj"
set "RC=%ERRORLEVEL%"
echo EXITCODE_DCOMP_HOST=%RC%
if not "%RC%"=="0" exit /b %RC%

echo ==== [3/4] layout_probe.cpp (link + run) ====
cl /nologo /utf-8 /W4 /EHsc /std:c++17 /I "%INC%" "%SRC%\layout_probe.cpp" /Fo"%OUT%\layout_probe.obj" /Fe"%OUT%\layout_probe.exe"
set "RC=%ERRORLEVEL%"
echo EXITCODE_LAYOUT_PROBE=%RC%
if not "%RC%"=="0" exit /b %RC%

echo ---- layout_probe output ----
if defined NORUN goto :skip_layout_run
"%OUT%\layout_probe.exe"
set "RC=%ERRORLEVEL%"
echo EXITCODE_LAYOUT_RUN=%RC%
:skip_layout_run

echo ==== [4/4] d3d_probe.cpp (link + run) ====
cl /nologo /utf-8 /W4 /EHsc /std:c++17 /I "%INC%" "%SRC%\d3d_probe.cpp" /Fo"%OUT%\d3d_probe.obj" /Fe"%OUT%\d3d_probe.exe" /link d3d11.lib dcomp.lib dxgi.lib
set "RC=%ERRORLEVEL%"
echo EXITCODE_D3D_PROBE=%RC%
if not "%RC%"=="0" exit /b %RC%

echo ---- d3d_probe output ----
if defined NORUN goto :skip_d3d_run
"%OUT%\d3d_probe.exe"
set "RC=%ERRORLEVEL%"
echo EXITCODE_D3D_RUN=%RC%
:skip_d3d_run

echo CL_EXIT=%RC%
endlocal & exit /b %RC%
