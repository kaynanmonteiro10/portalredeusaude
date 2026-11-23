@echo off
setlocal EnableExtensions
title Portal do Setor
cd /d "%~dp0"
set "PY=%~dp0runtime\python.exe"
if not exist "%PY%" set "PY=C:\Python314\python.exe"
if not exist "%PY%" set "PY=python"

netstat -ano | findstr ":5500" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo.
  echo  O portal ja esta rodando neste computador.
  echo  Use o atalho "Portal do Setor" na Area de Trabalho.
  echo.
  ping -n 7 127.0.0.1 >nul
  exit /b
)

echo.
echo  Portal do Setor - iniciando...
echo.
echo  Deixe esta janela aberta enquanto o portal estiver em uso.
echo  Para encerrar o portal, feche esta janela.
echo.
"%PY%" "%~dp0portal_server.py"
echo.
echo  O portal foi encerrado. Para ligar de novo, use o atalho
echo  "Portal do Setor" na Area de Trabalho.
echo.
pause
