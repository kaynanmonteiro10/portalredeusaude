@echo off
setlocal EnableExtensions
cd /d "%~dp0"
netstat -ano | findstr ":5500" | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (
  start "Portal do Setor" /min "%~dp0iniciar_portal.bat"
  ping -n 5 127.0.0.1 >nul
)
set "URL=https://192.168.1.11:5443/"
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" "%URL%"
) else (
  start "" "%URL%"
)
