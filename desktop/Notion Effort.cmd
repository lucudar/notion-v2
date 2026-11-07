@echo off
rem Starts Notion with the Notion AI Effort panel. Keep this window open.
setlocal
set NODE=node
where node >nul 2>nul || set NODE="%LOCALAPPDATA%\hermes\node\node.exe"
%NODE% "%~dp0notion-effort-desktop.js" %*
if errorlevel 1 pause
