@echo off
setlocal EnableExtensions
title Portal Financeiro - preparar este computador
set "URL=https://192.168.1.11:5443/"
set "BASE=http://192.168.1.11:5500"
set "ZIPNAME=P4X_Exportador_Rateios_Chromium_v1.3.1.zip"
set "DEST=%LOCALAPPDATA%\PortalRedeSaude\Extensoes\P4X"
set "ZIP=%TEMP%\p4x-rateios.zip"
set "CA=%TEMP%\portal-ca.cer"
set "SHORTCUT=%USERPROFILE%\Desktop\Portal Financeiro.lnk"

echo.
echo   Portal do Setor - Financeiro
echo   ------------------------------------------
echo   Este preparo e feito UMA VEZ por computador.
echo   Depois, a equipe so abre o atalho "Portal Financeiro".
echo   Nao precisa de senha de administrador.
echo.

echo   Baixando o componente do portal...
set "LOCALZIP=%~dp0extensions\p4x\%ZIPNAME%"
if exist "%LOCALZIP%" (
  copy /y "%LOCALZIP%" "%ZIP%" >nul
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 40 -Uri '%BASE%/extensions/p4x/%ZIPNAME%' -OutFile '%ZIP%'; exit 0 } catch { exit 1 }"
  if errorlevel 1 goto semrede
)

echo   Instalando componente...
if exist "%DEST%" rmdir /s /q "%DEST%" >nul 2>&1
mkdir "%DEST%" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Expand-Archive -LiteralPath '%ZIP%' -DestinationPath '%DEST%' -Force; exit 0 } catch { exit 1 }"
if errorlevel 1 goto falhou
if not exist "%DEST%\manifest.json" goto falhou
del "%ZIP%" >nul 2>&1
echo   [OK] Componente instalado em:
echo        %DEST%

echo   Verificando o certificado de seguranca...
certutil -store -user Root 2>nul | findstr /C:"Portal do Setor - Rede Saude" >nul
if not errorlevel 1 goto certeok
if exist "%~dp0portal-ca.cer" (
  copy /y "%~dp0portal-ca.cer" "%CA%" >nul
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 40 -Uri '%BASE%/portal-ca.cer' -OutFile '%CA%'; exit 0 } catch { exit 1 }"
  if errorlevel 1 goto semrede
)
certutil -addstore -user Root "%CA%" >nul 2>&1
if errorlevel 1 (
  echo   [AVISO] Nao consegui instalar o certificado.
  echo           O portal pode abrir com aviso de "Nao seguro".
) else (
  echo   [OK] Certificado instalado.
)
del "%CA%" >nul 2>&1
:certeok

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" goto semnavegador

echo   Criando o atalho "Portal Financeiro"...
set "PS1=%TEMP%\portal-financeiro-atalho.ps1"
> "%PS1%" echo $ws = New-Object -ComObject WScript.Shell
>> "%PS1%" echo $s = $ws.CreateShortcut("%SHORTCUT%")
>> "%PS1%" echo $s.TargetPath = "%EDGE%"
>> "%PS1%" echo $s.Arguments = '"%URL%"'
>> "%PS1%" echo $s.WorkingDirectory = "%LOCALAPPDATA%"
>> "%PS1%" echo $s.IconLocation = "%SystemRoot%\System32\SHELL32.dll,220"
>> "%PS1%" echo $s.Description = "Portal do Setor - Financeiro"
>> "%PS1%" echo $s.Save()
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" >nul 2>&1
del "%PS1%" >nul 2>&1
if not exist "%SHORTCUT%" goto falhou
echo   [OK] Atalho criado na Area de Trabalho.

echo %DEST%| clip
echo.
echo   ULTIMO PASSO - 1 minuto, so neste computador:
echo   ------------------------------------------
echo   1. O Edge vai abrir na tela de Extensoes.
echo   2. Ligue a chave "Modo de desenvolvedor".
echo   3. Se "P4X - Exportar Rateios" JA estiver na lista, clique
echo      em "Recarregar" nela e va para o passo 5.
echo   4. Se ainda nao estiver, clique em "Carregar sem compactacao"
echo      e, na janela que abrir, aperte Ctrl+V e depois Enter.
echo      O caminho da extensao ja esta copiado.
echo   5. Confira se apareceu "P4X - Exportar Rateios 1.3.1".
echo      Se houver uma versao antiga do P4X em outra pasta, remova-a.
echo.
echo   Depois de instalar a extensao, pressione qualquer tecla
echo   para abrir o portal.
echo.
start "" "%EDGE%" "edge://extensions/"
pause >nul

echo.
echo   PRONTO. Use sempre o atalho "Portal Financeiro".
echo   A equipe nao instala nada: so usa o atalho e o botao
echo   "Importar do P4X" dentro da tela Financeiro.
echo.
start "" "%SHORTCUT%"
echo   Se o navegador pedir para restaurar paginas, escolha "Nao".
echo.
pause
exit /b 0

:semrede
echo.
echo   [X] Nao consegui baixar os arquivos do portal.
echo       Confira se o servidor do portal esta ligado e se este
echo       computador esta na rede do setor. Depois rode de novo.
echo       Se o problema continuar, chame o responsavel tecnico.
echo.
pause
exit /b 1

:semnavegador
echo.
echo   [X] Nao encontrei o Microsoft Edge neste computador.
echo       Chame o responsavel tecnico do portal.
echo.
pause
exit /b 1

:falhou
echo.
echo   [X] Nao foi possivel instalar o componente.
echo       Se o Edge estiver aberto, feche TODAS as janelas dele
echo       e rode este arquivo de novo.
echo       Se continuar, chame o responsavel tecnico.
echo.
pause
exit /b 1
