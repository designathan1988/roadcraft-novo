@echo off
rem Roadcraft no navegador: sobe o servidor local (COOP/COEP) e abre o Chrome.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo O Roadcraft no navegador precisa do Node.js 20 ou mais novo: https://nodejs.org
  echo Ou use a versao para Windows ^(Roadcraft.exe^), que nao precisa de nada.
  pause
  exit /b 1
)
node tools\serve.mjs --abrir
