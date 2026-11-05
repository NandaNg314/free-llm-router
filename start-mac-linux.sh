#!/bin/bash
# free-llm-router 本地版启动器（macOS / Linux）
set -euo pipefail
cd "$(dirname "$0")"

echo ""
echo "  正在启动 free-llm-router 本地版..."
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "  [错误] 没有找到 Node.js"
  echo ""
  echo "  请先安装 Node.js 22 或更高版本：https://nodejs.org/"
  echo "  （macOS 也可以用：brew install node）"
  echo ""
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "  [错误] Node.js 版本太低（当前 $(node -v)，需要 22+）"
  echo ""
  exit 1
fi

exec node start-local.mjs "$@"
