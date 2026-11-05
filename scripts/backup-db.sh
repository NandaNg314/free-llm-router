#!/bin/bash
# free-llm-router 数据库自动备份
#
# ## 为什么必须做
#
# `router.db` 里同时存着：
#   - 9 个账号的**加密凭据**
#   - `system_kv.credential_key`（解密这些凭据的**密钥本身**）
#
# ⇒ **丢了它 = 所有账号全部失效，只能逐个重新登录**。
# 而线上曾经连续 13 天没有备份（10-23 → 11-05），全靠运气。
#
# ## 为什么用 `.backup` 而不是 `cp`
#
# 数据库开着 WAL 模式，容器正在写入。直接 `cp router.db` 会漏掉
# `router.db-wal` 里尚未 checkpoint 的事务 —— 拿到一份**看起来正常但少数据**的副本。
# `sqlite3 .backup` 是官方热备份：会正确合并 WAL，且不阻塞写入。
#
# ## 保留策略
#
# 保留最近 14 份（每天一份 ⇒ 两周）。再多意义不大，磁盘也白占。
# ⚠️ 旧的 `.bak-*` 手工备份**不删**（可能有用户特意留的基线）。
set -euo pipefail

DIR=/home/ubuntu/free-llm-router/data
KEEP=14
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$DIR/router.db.bak-$STAMP"

cd "$DIR"

# ⚠️ 用 python3 的 sqlite3 backup API 而不是 `sqlite3` CLI：
# 线上 alpine 镜像里没有 sqlite3 CLI，但宿主机有 python3，且它能正确处理 WAL。
python3 - "$OUT" <<'PY'
import sqlite3, sys
out = sys.argv[1]
src = sqlite3.connect('file:router.db?mode=ro', uri=True)
dst = sqlite3.connect(out)
src.backup(dst)
dst.execute('PRAGMA wal_checkpoint(TRUNCATE)')
dst.close()
src.close()
PY

# ⚠️ 校验：备份必须能打开且表齐全。没校验的备份等于没有备份。
python3 - "$OUT" <<'PY'
import sqlite3, sys
p = sys.argv[1]
db = sqlite3.connect(f'file:{p}?mode=ro', uri=True)
tables = {r[0] for r in db.execute("select name from sqlite_master where type='table'")}
required = {'accounts', 'credentials', 'system_kv'}
missing = required - tables
if missing:
    raise SystemExit(f'备份校验失败，缺表：{missing}')
n = db.execute('select count(*) from accounts').fetchone()[0]
k = db.execute("select count(*) from system_kv where key='credential_key'").fetchone()[0]
if k == 0:
    raise SystemExit('备份校验失败：缺 credential_key（账号将无法解密）')
print(f'✅ 备份校验通过：{n} 个账号，含 credential_key')
db.close()
PY

chmod 600 "$OUT"
echo "✅ 已备份 → $OUT ($(du -h "$OUT" | cut -f1))"

# 清理：只删本脚本产生的（router.db.bak-YYYYmmdd-HHMMSS），保留手工备份
ls -1t router.db.bak-[0-9]*-[0-9]* 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
  echo "🗑  清理旧备份 $old"
done
