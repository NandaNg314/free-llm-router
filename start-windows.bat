@echo off
chcp 65001 >nul
title free-llm-router 本地版
cd /d "%~dp0"

echo.
echo   正在启动 free-llm-router 本地版...
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 没有找到 Node.js
  echo.
  echo   请先安装 Node.js 22 或更高版本：https://nodejs.org/
  echo   安装时勾选 "Add to PATH"，装完重新双击本文件。
  echo.
  pause
  exit /b 1
)

node start-local.mjs %*
if errorlevel 1 (
  echo.
  echo   [启动失败] 上面的信息里应该有原因。
  echo.
  pause
)
