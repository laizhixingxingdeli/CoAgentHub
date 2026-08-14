#!/bin/bash
# coagenthub-backup.sh — CoAgentHub 生产数据备份 (ticket 27)
#
# 备份内容:
#   1. PostgreSQL 全库 pg_dump → coagenthub-backup-<日期>.sql
#   3. (可选 --with-dist)前端 dist 打包 → coagenthub-dist-<日期>.tar.gz
#
# 默认输出目录 $HOME/coagenthub-backups(可用 COAGENTHUB_BACKUP_DIR 覆盖);
# 保留最近 ${COAGENTHUB_BACKUP_KEEP:-7} 份,旧备份自动删除。
#
# 恢复说明(手动执行,本脚本不代做):
#   psql "$DATABASE_URL" -f coagenthub-backup-<日期>.sql        # 恢复到原库
#   # 或恢复到临时库验证: createdb coagenthub_restore_test && \
#   #   psql -d coagenthub_restore_test -f coagenthub-backup-<日期>.sql && dropdb coagenthub_restore_test
#
# 数据库口令不从脚本硬编码:脚本从 packages/backend/server/.env 读取 DATABASE_URL,
# 也可用环境变量 DATABASE_URL 覆盖。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$REPO_ROOT/packages/backend/server"
FRONTEND_DIST="$REPO_ROOT/packages/frontend/web/dist"

BACKUP_DIR="${COAGENTHUB_BACKUP_DIR:-$HOME/coagenthub-backups}"
KEEP="${COAGENTHUB_BACKUP_KEEP:-7}"
STAMP="$(date +%Y%m%d-%H%M%S)"

# 定位 pg_dump: PATH 优先,Homebrew postgresql 兜底(本机不在 PATH)
PG_BIN=""
if command -v pg_dump >/dev/null 2>&1; then
  PG_BIN="$(command -v pg_dump)"
else
  for d in /opt/homebrew/opt/postgresql*/bin /usr/local/opt/postgresql*/bin; do
    [ -x "$d/pg_dump" ] && PG_BIN="$d/pg_dump" && break
  done
fi
[ -z "$PG_BIN" ] && { echo "FAIL: 找不到 pg_dump(PATH 或 Homebrew postgresql* 均无)" >&2; exit 1; }

# 取 DATABASE_URL: 环境变量优先,否则读 server/.env(不硬编码口令)
if [ -z "${DATABASE_URL:-}" ]; then
  if [ -f "$SERVER_DIR/.env" ]; then
    DATABASE_URL="$(grep -E '^DATABASE_URL=' "$SERVER_DIR/.env" | head -1 | cut -d= -f2-)"
  fi
fi
[ -z "${DATABASE_URL:-}" ] && { echo "FAIL: 未设置 DATABASE_URL 且 $SERVER_DIR/.env 不存在" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"

SQL="$BACKUP_DIR/coagenthub-backup-$STAMP.sql"

echo "== 备份到 $BACKUP_DIR (保留最近 $KEEP 份) =="

echo "1/2 pg_dump → $(basename "$SQL")"
"$PG_BIN" "$DATABASE_URL" > "$SQL" 2> "$SQL.err"
if [ $? -ne 0 ] || [ ! -s "$SQL" ]; then
  echo "FAIL: pg_dump 失败,见 $SQL.err" >&2
  cat "$SQL.err" >&2
  rm -f "$SQL"
  exit 1
fi
rm -f "$SQL.err"
echo "    OK  $(wc -l < "$SQL" | tr -d ' ') 行"

if [ "${1:-}" = "--with-dist" ]; then
  DIST_TGZ="$BACKUP_DIR/coagenthub-dist-$STAMP.tar.gz"
  echo "2/2 前端 dist → $(basename "$DIST_TGZ")"
  if [ -d "$FRONTEND_DIST" ]; then
    tar -C "$(dirname "$FRONTEND_DIST")" -czf "$DIST_TGZ" "$(basename "$FRONTEND_DIST")" && echo "    OK"
  else
    echo "    SKIP 无 $FRONTEND_DIST"
  fi
else
  echo "2/2 前端 dist: 跳过(加 --with-dist 打包)"
fi

# 保留最近 KEEP 份,删除更旧的
prune() {
  local pat="$1"
  ls -1t "$BACKUP_DIR"/$pat 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r f; do
    echo "    清理旧备份 $(basename "$f")"
    rm -f "$f"
  done
}
prune "coagenthub-backup-*.sql"
prune "coagenthub-dist-*.tar.gz"

echo
echo "== 完成: $(basename "$SQL") =="
echo "恢复: psql \"\$DATABASE_URL\" -f \"$SQL\""
echo "恢复验证(临时库,不碰生产): createdb coagenthub_restore_test && psql -d coagenthub_restore_test -f \"$SQL\" && dropdb coagenthub_restore_test"
