@echo off
REM build-shaders.bat -- compile HLSL with fxc (absolute path, no INCLUDE/LIB/PATH injection needed)
REM usage (from repo root): cmd //c native\build-shaders.bat
REM NOTE: keep this file ASCII-only; cmd parses .bat in codepage 936 and UTF-8 comments desync.
setlocal EnableExtensions

set "NATIVE=%~dp0"
if "%NATIVE:~-1%"=="\" set "NATIVE=%NATIVE:~0,-1%"

set "FXC=C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\fxc.exe"
set "SRC=%NATIVE%\spike-glass\shaders"
set "OUT=%NATIVE%\build\shaders"
if not exist "%OUT%" mkdir "%OUT%"

echo ==== [1/4] squircle_ps.hlsl /E main (exact pow) ====
"%FXC%" /nologo /T ps_5_0 /E main /Fo "%OUT%\squircle_ps_exact.cso" /Fc "%OUT%\squircle_ps_exact.asm" "%SRC%\squircle_ps.hlsl"
set "RC=%ERRORLEVEL%"
echo EXITCODE_PS_EXACT=%RC%
if not "%RC%"=="0" exit /b %RC%

echo ==== [2/4] squircle_ps.hlsl /E poly (polynomial) ====
"%FXC%" /nologo /T ps_5_0 /E poly /Fo "%OUT%\squircle_ps_poly.cso" /Fc "%OUT%\squircle_ps_poly.asm" "%SRC%\squircle_ps.hlsl"
set "RC=%ERRORLEVEL%"
echo EXITCODE_PS_POLY=%RC%
if not "%RC%"=="0" exit /b %RC%

echo ==== [3/4] kawase_cs.hlsl /E main_down ====
"%FXC%" /nologo /T cs_5_0 /E main_down /Fo "%OUT%\kawase_cs_down.cso" /Fc "%OUT%\kawase_cs_down.asm" "%SRC%\kawase_cs.hlsl"
set "RC=%ERRORLEVEL%"
echo EXITCODE_CS_DOWN=%RC%
if not "%RC%"=="0" exit /b %RC%

echo ==== [4/4] kawase_cs.hlsl /E main_up ====
"%FXC%" /nologo /T cs_5_0 /E main_up /Fo "%OUT%\kawase_cs_up.cso" /Fc "%OUT%\kawase_cs_up.asm" "%SRC%\kawase_cs.hlsl"
set "RC=%ERRORLEVEL%"
echo EXITCODE_CS_UP=%RC%
if not "%RC%"=="0" exit /b %RC%

echo FXC_EXIT=%RC%
endlocal & exit /b %RC%
