@echo off
rem Saves the panel diagnostics to diag.json and copies them to the clipboard.
setlocal
set NODE=node
where node >nul 2>nul || set NODE="%LOCALAPPDATA%\hermes\node\node.exe"
%NODE% "%~dp0notion-effort-desktop.js" --diag
pause
