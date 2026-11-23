@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "PY=%~dp0runtime\python.exe"
if not exist "%PY%" set "PY=C:\Python314\python.exe"
if not exist "%PY%" set "PY=python"
:loop
"%PY%" "%~dp0portal_server.py" >> "%~dp0portal_server.log" 2>&1
ping -n 6 127.0.0.1 >nul 2>&1
goto loop
