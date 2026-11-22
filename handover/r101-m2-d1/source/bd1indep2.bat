@echo off
cd /d C:/v4h/proj/native/build/m2probe
set "INCLUDE=C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.51.36231\include;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\ucrt;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\um;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\shared;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\winrt"
set "LIB=C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.51.36231\lib\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\ucrt\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\um\x64"
set "PATH=C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.51.36231\bin\Hostx64\x64;%PATH%"
cl /nologo /utf-8 /EHsc /W4 /std:c++20 /MD /DUNICODE /D_UNICODE /Fe:d1_indep_probe2.exe /Fo:d1_indep_probe2.obj d1_indep_probe2.cpp /link d3d11.lib dxgi.lib dcomp.lib dwmapi.lib user32.lib gdi32.lib
echo CL_EXIT=%ERRORLEVEL%