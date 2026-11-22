@echo off
setlocal
rem 中文注释测试：非 ASCII 字节与行尾
echo MARK_A
call :sub hello
echo MARK_SUB_RC=%ERRORLEVEL%
echo MARK_B
exit /b 0
:sub
echo SUB=%~1
exit /b 0
