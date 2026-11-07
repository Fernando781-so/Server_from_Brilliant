@echo off
cd /d "%~dp0"
echo Iniciando el servidor...
npm start
echo.
echo El servidor se ha detenido. Presiona una tecla para cerrar esta ventana.
pause >nul