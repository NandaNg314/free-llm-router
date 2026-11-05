@echo off
chcp 65001 >nul
title free-llm-router 本地版
cd /d "%~dp0"

echo.
echo   ==========================================
echo     free-llm-router  -  本地版
echo   ==========================================
echo.

REM ---------------------------------------------------------------
REM  检查 Node.js
REM  ---------------------------------------------------------------
REM  这一步是给「没装 Node」的人看的 —— 直接闪退是最糟的体验。
REM  提示里要给出：去哪下、勾什么、装完做什么。
REM
REM  NOTE: 边框刻意用 ASCII（= - |），不用 U+2554 这类制表符 ——
REM        cmd 在 chcp 65001 下对它们偶发解析错误（实测）。
REM ---------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 goto nonode

for /f "tokens=1 delims=v." %%a in ('node -v') do set NODE_MAJOR=%%a
if %NODE_MAJOR% LSS 22 goto oldnode

echo   正在启动，请稍候...
echo.
node start-local.mjs %*
if errorlevel 1 (
  echo.
  echo   ------------------------------------------------
  echo   [启动失败] 原因见上面的信息。
  echo   如果看不懂，把上面的内容截图发给提供这个程序的人。
  echo   ------------------------------------------------
  echo.
  pause
)
exit /b 0

:nonode
echo   [错误] 这台电脑上还没有安装 Node.js
echo.
echo   Node.js 是本程序的运行引擎，必须先装好才能用。
echo.
echo   安装步骤：
echo     1^) 打开浏览器访问：https://nodejs.org/zh-cn
echo     2^) 点绿色大按钮下载 LTS（长期支持版）
echo     3^) 双击下载的 .msi 文件，一路点「下一步」
echo        中途的 "Add to PATH" 选项必须保持勾选（默认已勾选）
echo     4^) 装完重启电脑
echo     5^) 再双击一次本文件
echo.
echo   不确定装没装成功：按 Win+R，输入 cmd 回车，
echo   在黑窗口里敲 node -v，能看到 v22.x.x 或更高就说明 OK。
echo.
pause
exit /b 1

:oldnode
echo   [错误] Node.js 版本太低（需要 22 或更高）
echo.
for /f %%v in ('node -v') do echo   当前版本：%%v
echo.
echo   请去 https://nodejs.org/zh-cn 下载 LTS 版本覆盖安装，
echo   装完重启电脑，再双击本文件。
echo.
pause
exit /b 1
