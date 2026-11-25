#!/bin/bash
# free-llm-router 本地版一键无损升级脚本（macOS / Linux）
set -euo pipefail
cd "$(dirname "$0")"

echo ""
echo "  free-llm-router · 本地版一键无损升级"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "  [错误] 未检测到 Node.js"
  echo "  请先安装 Node.js v22.13.0 或更高版本：https://nodejs.org/zh-cn"
  echo ""
  exit 1
fi

if ! node -e 'const v=process.env.FLR_TEST_NODE_VERSION||process.versions.node;const [M,m]=String(v).replace(/^v/i,"").split(".").map(Number);process.exit(M>22||(M===22&&m>=13)?0:1)' >/dev/null 2>&1; then
  CUR_VER="$(node -v 2>/dev/null || echo '未知')"
  echo "  [错误] Node.js 版本过低（当前 ${CUR_VER}，需要 v22.13.0 或更高版本）"
  echo ""
  exit 1
fi

exec node --no-warnings "./update-local.mjs" "$@"
