@echo off
setlocal EnableExtensions
chcp 65001 >nul
title free-llm-router 本地版无损升级
cd /d "%~dp0"

echo.
echo   ==========================================
echo     free-llm-router  -  本地版一键无损升级
echo   ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode

set "NODE_VER="
for /f "delims=" %%v in ('node -v 2^>nul') do set "NODE_VER=%%v"
if "%NODE_VER%"=="" goto nonode

node -e "const v=process.env.FLR_TEST_NODE_VERSION||process.versions.node;const [M,m]=String(v).replace(/^v/i,'').split('.').map(Number);process.exit(M>22||(M===22&&m>=13)?0:1)" >nul 2>nul
if errorlevel 1 goto oldnode

REM ---------------------------------------------------------------
REM  使用单块括号包裹执行与退出：update-local.mjs 自更新覆盖本 .bat 文件时，
REM  cmd.exe 已将括号块读入内存，不会因文件字节偏移变化而解析错位。
REM ---------------------------------------------------------------
(
  if "%~1"=="" (
    node --no-warnings "%~dp0update-local.mjs"
  ) else (
    node --no-warnings "%~dp0update-local.mjs" "%~1"
  )
  if errorlevel 1 (
    echo   ------------------------------------------------
    echo   [升级未完成] 原因见上方提示信息（原有数据未受任何影响）。
    echo   ------------------------------------------------
    echo.
    if not defined FLR_NO_PAUSE pause
    exit /b 1
  ) else (
    if not defined FLR_NO_PAUSE pause
    exit /b 0
  )
)

:nonode
echo   [错误] 未检测到 Node.js（需要 v22.13.0 或更高版本）
echo   请先访问 https://nodejs.org/zh-cn 下载安装 LTS 版本。
echo.
if not defined FLR_NO_PAUSE pause
exit /b 1

:oldnode
echo   [错误] Node.js 版本过低（当前：%NODE_VER%，需要 v22.13.0 或更高版本）
echo   请访问 https://nodejs.org/zh-cn 覆盖安装最新 LTS 版本后再试。
echo.
if not defined FLR_NO_PAUSE pause
exit /b 1
