@echo off
cd /d "%~dp0"
python -c "from portal_server import connection; connection().close(); print('Banco criado: portal.db')"
pause
