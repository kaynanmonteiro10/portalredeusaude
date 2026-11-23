@echo off
setlocal EnableExtensions
title Desativar PowerShell no login

net session >nul 2>&1
if errorlevel 1 (
  echo Solicitando permissao de administrador...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '%1' -Verb RunAs"
  exit /b
)

cd /d "%~dp0"

if /I "%~1"=="/REATIVAR" goto reativar

echo.
echo  Desativando a tarefa "cua-driver-serve"...
schtasks /Change /TN "\cua-driver-serve" /DISABLE >nul 2>&1
if errorlevel 1 (
  echo  [ERRO] Nao foi possivel desativar a tarefa.
  echo         Abra o Agendador de Tarefas e desative "cua-driver-serve".
) else (
  echo  [OK] Pronto. O PowerShell nao abre mais ao ligar o notebook.
  echo       O portal e o navegador nao sao afetados.
)
echo.
echo  Para voltar atras, execute este arquivo com o parametro /REATIVAR
echo  ou reative a tarefa no Agendador de Tarefas do Windows.
echo.
pause
exit /b

:reativar
echo.
echo  Reativando a tarefa "cua-driver-serve"...
schtasks /Change /TN "\cua-driver-serve" /ENABLE >nul 2>&1
if errorlevel 1 (
  echo  [ERRO] Nao foi possivel reativar a tarefa.
) else (
  echo  [OK] Tarefa reativada.
)
echo.
pause
exit /b
