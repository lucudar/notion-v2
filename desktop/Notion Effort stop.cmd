@echo off
rem Stops the panel. Notion itself keeps running.
setlocal
set NODE=node
where node >nul 2>nul || set NODE="%LOCALAPPDATA%\hermes\node\node.exe"
%NODE% "%~dp0notion-effort-desktop.js" --stop
pause
