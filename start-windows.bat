@echo off
setlocal EnableExtensions
chcp 65001 >nul
title free-llm-router 本地版
cd /d "%~dp0"

echo.
echo   ==========================================
echo     free-llm-router  -  本地版
echo   ==========================================
echo.

REM ---------------------------------------------------------------
REM  1. 检查 Node.js 是否安装，并精确校验版本 >= 22.13.0
REM     使用双引号包裹路径与 node -e 精确判定，兼容含空格/括号/中文目录
REM ---------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 goto nonode

set "NODE_VER="
for /f "delims=" %%v in ('node -v 2^>nul') do set "NODE_VER=%%v"
if "%NODE_VER%"=="" goto nonode

node -e "const v=process.env.FLR_TEST_NODE_VERSION||process.versions.node;const [M,m]=String(v).replace(/^v/i,'').split('.').map(Number);process.exit(M>22||(M===22&&m>=13)?0:1)" >nul 2>nul
if errorlevel 1 goto oldnode

echo   正在检查环境并启动服务，请稍候...
echo.
node --no-warnings "%~dp0start-local.mjs" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  if not "%EXIT_CODE%"=="130" (
    echo.
    echo   ------------------------------------------------
    echo   [启动遇到问题] 程序异常退出（代码：%EXIT_CODE%），原因见上方提示。
    echo   如果看不懂，可把上方提示截图发给提供本程序的人协助排查。
    echo   ------------------------------------------------
    echo.
    if not defined FLR_NO_PAUSE pause
    exit /b %EXIT_CODE%
  )
)
exit /b 0

:nonode
echo   [错误] 这台电脑上还没有安装 Node.js
echo.
echo   Node.js 是本程序的运行引擎（需要 v22.13.0 或更高版本）。
echo.
echo   安装步骤：
echo     1^) 打开浏览器访问：https://nodejs.org/zh-cn
echo     2^) 点击下载 LTS（长期支持版，.msi 安装包）
echo     3^) 双击安装，一路点「下一步」
echo        请保持勾选默认的 "Add to PATH" 选项
echo     4^) 安装完成后重新打开窗口，再次双击本文件即可
echo.
if not defined FLR_NO_PAUSE pause
exit /b 1

:oldnode
echo   [错误] Node.js 版本过低（需要 v22.13.0 或更高版本）
echo.
echo   当前检测到的版本：%NODE_VER%
echo   原因：v22.0 ~ v22.12 尚未内置稳定版 node:sqlite 数据库模块。
echo.
echo   请打开 https://nodejs.org/zh-cn 下载最新 LTS 版本覆盖安装，
echo   安装完成后重新双击本文件即可（不会影响已有账号数据）。
echo.
if not defined FLR_NO_PAUSE pause
exit /b 1
