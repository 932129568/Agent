@echo off
setlocal
rem plain ascii probe line, padding padding padding
echo MARK_A
call :sub hello
echo MARK_SUB_RC=%ERRORLEVEL%
echo MARK_B
exit /b 0
:sub
echo SUB=%~1
exit /b 0
