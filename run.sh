#!/bin/bash
# free-llm-router —— 生产启动 / 重启脚本（AMD VPS 1）
#
# ⚠️ 与 docker-compose.yml **必须保持一致**。两份配置各写一份就会分叉：
#    线上真实发生过「compose 写 0.0.0.0:11451 对公网、本脚本写 127.0.0.1:11452」，
#    误用 compose 会把面板直接暴露出去。
#
# 用法：
#   bash run.sh                    # 重启（数据与挂载都保留）
#   bash run.sh --rebuild-image    # 连镜像一起重建（改了 Dockerfile 时用）
#
# 更新流程（完整）：
#   本地   npm run build:node
#   上传   scp dist/server.mjs ubuntu@129.153.72.82:/home/ubuntu/free-llm-router/dist/
#   服务器 在 dist/ 里先备份旧产物，再 bash ../run.sh
set -euo pipefail

cd "$(dirname "$0")"

# ⚠️ 重启前**必须**确认产物存在，否则容器会起不来（挂载的是宿主机文件）
if [ ! -f dist/server.mjs ]; then
  echo "❌ dist/server.mjs 不存在 —— 先在本地跑 npm run build:node 并上传" >&2
  exit 1
fi

if [ "${1:-}" = "--rebuild-image" ]; then
  echo "🔨 重建镜像..."
  sudo docker build -t free-llm-router:latest .
fi

# ⚠️ 重启前留一份旧产物，出问题能立刻回滚：
#    cd dist && cp server.mjs.bak-YYYYmmdd-HHMMSS server.mjs && bash ../run.sh
echo "🛑 停止旧容器..."
sudo docker stop free-llm-router 2>/dev/null || true
sudo docker rm free-llm-router 2>/dev/null || true

echo "🚀 启动..."
sudo docker run -d \
  --name free-llm-router \
  --restart unless-stopped \
  -p 127.0.0.1:11452:11451 \
  --env-file "$PWD/.env" \
  -v "$PWD/data:/app/data" \
  -v "$PWD/dist/server.mjs:/app/dist/server.mjs" \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  free-llm-router:latest

sleep 5
sudo docker ps --filter name=free-llm-router --format '✅ {{.Names}}  {{.Status}}  {{.Ports}}'
echo
echo "查看日志：sudo docker logs -f free-llm-router"
