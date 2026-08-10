@echo off
cd /d "%~dp0"

if not exist "logs" mkdir "logs"

chcp 65001 >nul

"C:\nvm4w\nodejs\node.exe" src\run.js >> logs\bot.log 2>&1