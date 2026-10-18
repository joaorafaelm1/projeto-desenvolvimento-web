@echo off
cd /d "%~dp0"
echo ========================================
echo        ACOLHE MVP 2.0
echo ========================================
echo.
echo Iniciando o servidor...
echo Site:      http://localhost:3000
echo Dashboard: http://localhost:3000/dashboard.html
echo.
echo Login local do dashboard:
echo Email: admin@acolhe.local
echo Senha: Acolhe@2026
echo.
echo Para desligar, pressione CTRL + C.
echo ========================================
node server.js
pause
