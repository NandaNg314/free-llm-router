#!/usr/bin/env bash
# 单测运行脚本。
#
# 为什么不用 `node --test --experimental-strip-types`：
# Node 的类型剥离**不做路径重写**，而本项目源码按 ESM 规范写 `.js` 后缀
# （`import './headers.js'` 指向 `headers.ts`）—— 这是 TypeScript 的标准做法，
# 但 Node 不认，会报 ERR_MODULE_NOT_FOUND。
#
# 故先用 esbuild 打包成真正的 .mjs 再跑测试。esbuild 来自 wrangler 的依赖，
# 无需额外安装。
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=".build/tests"
rm -rf "$OUT"
mkdir -p "$OUT"

# --loader:.wasm=binary 与 --target=node22 都与 `npm run build:node` 一致：qoder 的 WASM 在 Node 下拿到的是
# 字节，测试也必须走这条路径（曾用 `file` loader，结果 Node 部署时 WASM 实例化
# 必炸的缺陷在单测里完全测不到）。
for f in tests/*.test.ts; do
  name=$(basename "$f" .test.ts)
  # --alias:cloudflare:workers 让 Node.js 环境下测试能够无缝加载并实例化 DurableObject 状态机
  ./node_modules/.bin/esbuild "$f" \
    --bundle --format=esm --platform=node --target=node22 \
    --alias:cloudflare:workers=./src/server/cf-shim.ts \
    --loader:.html=text --loader:.css.txt=text --loader:.js.txt=text \
    --loader:.wasm=binary \
    --outfile="$OUT/$name.test.mjs" --log-level=warning
done

# ⚠️ 分两批跑：node-runtime 会真起 HTTP 服务并写到 stdout，
# 与 `node --test` 的 IPC 通道抢同一根管道，偶发
# `Unable to deserialize cloned data` —— 那是**测试运行器**的损坏，不是用例失败
#（单独跑它能 10/10 通过）。把它隔离出来单跑，避免污染全量结果。
RUNTIME="$OUT/node-runtime.test.mjs"
if [ -f "$RUNTIME" ]; then
  echo "── node-runtime（会起 HTTP 服务，单独跑）──"
  node --test "$RUNTIME" || exit 1
  echo "── 其余用例 ──"
  node --test $(ls "$OUT"/*.test.mjs | grep -v 'node-runtime')
else
  node --test "$OUT"/*.test.mjs
fi