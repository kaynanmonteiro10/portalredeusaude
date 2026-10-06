@echo off
setlocal
title Liberar Portal na rede local
echo ==========================================
echo  Liberando a porta 5500 no firewall...
echo ==========================================
echo.

netsh advfirewall firewall delete rule name="Portal Plantao Demandas 5500"
netsh advfirewall firewall add rule name="Portal Plantao Demandas 5500" dir=in action=allow protocol=TCP localip=any remoteip=any localport=5500 profile=any edge=yes
if errorlevel 1 (
	echo.
	echo ERRO: nao foi possivel criar a regra do Firewall.
	echo Execute este arquivo como administrador.
	pause
	exit /b 1
)

echo.
echo ==========================================
echo  PRONTO! A porta TCP 5500 foi liberada em todos os perfis.
echo  Os outros notebooks ja podem acessar.
echo ==========================================
echo.
netsh advfirewall firewall show rule name="Portal Plantao Demandas 5500"
pause
