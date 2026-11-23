@echo off
setlocal EnableExtensions
title Portal do Setor - preparar este computador
set "URL=https://192.168.1.11:5443/"
set "CERT=%TEMP%\portal-cert-rede-saude.cer"
echo.
echo   Portal do Setor - Rede Saude
echo   ------------------------------------------
echo   Preparando o acesso seguro neste computador.
echo   Isso leva alguns segundos e so precisa ser feito uma vez.
echo.
> "%CERT%" (
echo -----BEGIN CERTIFICATE-----
echo MIIDfzCCAmegAwIBAgIUT1NxK3gw26RAkj/rjTGurmMKN4owDQYJKoZIhvcNAQEL
echo BQAwVjElMCMGA1UEAwwcUG9ydGFsIGRvIFNldG9yIC0gUmVkZSBTYXVkZTETMBEG
echo A1UECgwKUmVkZSBTYXVkZTEYMBYGA1UECwwPUG9ydGFsIGRvIFNldG9yMB4XDTI2
echo MTAyOTE1MDA0MFoXDTM2MTAyNzE1MDA0MFowVjElMCMGA1UEAwwcUG9ydGFsIGRv
echo IFNldG9yIC0gUmVkZSBTYXVkZTETMBEGA1UECgwKUmVkZSBTYXVkZTEYMBYGA1UE
echo CwwPUG9ydGFsIGRvIFNldG9yMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC
echo AQEArllD7HoBDmcv+GqSfzxZkbWs6eKsKMFlqaprNh+iF3jYQOWh0DnibXMk3n8c
echo BfzOtb94N33Q3rFTrajQf0jCdM0IaIWI2cMAN4rIDvVgVngWjGm9YT0lacJKlOGG
echo rlUWS2QmSQkgBKJzTCoShikXAWJ5NeDnGSN08dnLXXvAhMfuGIVzTdmIdzQeHouD
echo O7ptYI/ZH4jd0sVPgU4hz/qQKsb0SJnh0BXLw4Rp1/eEfgCg7TsCGI2GZ+yInRpM
echo 8ijZLKhBjsCFNGRbfejBnY+wrkHxDXQWo/AJ8nti98QbxAbalylnzD245F7iZZFX
echo rvuP4qiemlzc1fv/KB0/HaunJQIDAQABo0UwQzASBgNVHRMBAf8ECDAGAQH/AgEA
echo MA4GA1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQU9YEPNfOIczmT9fx3wo4pcAUlQtIw
echo DQYJKoZIhvcNAQELBQADggEBACZi+8Rwcj0d4Csc/BZR9cDpYmHHJeBpSaHSqrkv
echo 2MWsQ7vLFjsGYW4lxTNtw2AI61gUcf36DMiI+kVb1Z2exVxRrfqZCXrZEj+l7hzP
echo fMMMbPYuh3Jzva9APQTBJIvFTVZBd1X7ILS3bmyla1ipPURnR9xO7kAVs6VuObvM
echo 2vHSWlwvFralNlPkhI1Ti+xXnSUqNViAEJJBrjv7LRhlB/8VWPr7IALHjMnWeV+p
echo obTdhpNGPTcffuSVxa7AG2/dSJU9B0U5grRzbq4HbXZRyVloU/43pS80DPyEoCHA
echo +D/gSw64afHgYckeGYbp6rLpwN4jyt13FaOlTUDzPW+eFgY=
echo -----END CERTIFICATE-----
)
certutil -addstore -user Root "%CERT%" >nul 2>&1
if errorlevel 1 goto falhou
net session >nul 2>&1
if not errorlevel 1 certutil -addstore Root "%CERT%" >nul 2>&1
del "%CERT%" >nul 2>&1
rem --- Firefox usa a propria lista de certificados: ensina ele a ler a do Windows ---
set "FFJS=%TEMP%\portal-firefox-pref.js"
> "%FFJS%" echo user_pref("security.enterprise_roots.enabled", true);
set "FFOK=0"
for /d %%P in ("%APPDATA%\Mozilla\Firefox\Profiles\*") do (
  if exist "%%~fP\prefs.js" (
    set "FFOK=1"
    findstr /C:"security.enterprise_roots.enabled" "%%~fP\user.js" >nul 2>&1
    if errorlevel 1 type "%FFJS%" >> "%%~fP\user.js"
  )
)
del "%FFJS%" >nul 2>&1
set "ATALHO=%USERPROFILE%\Desktop\Portal do Setor"
if not exist "%ATALHO%.lnk" (
  > "%ATALHO%.url" (
  echo [InternetShortcut]
  echo URL=%URL%
  echo IconFile=%SystemRoot%\System32\SHELL32.dll
  echo IconIndex=220
  )
)
echo   [OK] Certificado instalado.
if exist "%ATALHO%.lnk" (
  echo   [OK] Atalho "Portal do Setor" ja esta na Area de Trabalho.
) else (
  if exist "%ATALHO%.url" (
    echo   [OK] Atalho "Portal do Setor" criado na Area de Trabalho.
  ) else (
    echo   [AVISO] Nao consegui criar o atalho. Abra o portal pelo endereco %URL%
  )
)
if "%FFOK%"=="1" (
  echo   [OK] Firefox ajustado. Se ele estiver aberto, feche e abra de novo.
) else (
  echo   [i] Firefox nao encontrado neste computador.
)
echo.
echo   Abrindo o portal...
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" "%URL%"
) else (
  start "" "%URL%"
)
ping -n 5 127.0.0.1 >nul
echo.
echo   PRONTO. Use o atalho "Portal do Setor" na Area de Trabalho.
echo   Se o navegador ainda mostrar "Nao seguro", feche todas as
echo   janelas do navegador e abra de novo pelo atalho.
echo.
pause
exit /b 0

:falhou
del "%CERT%" >nul 2>&1
echo.
echo   [X] Nao foi possivel instalar o certificado.
echo       Chame o responsavel tecnico do portal.
echo.
pause
exit /b 1
