#!/bin/bash
# coagenthub-clean.sh — 清理 CoAgentHub 的缓存和构建产物
#
# 用法:
#   scripts/clean.sh          # 清理构建产物 + 缓存(保留 node_modules)
#   scripts/clean.sh --deep   # 深度清理(同时删除 node_modules,需重新 pnpm install)
#   scripts/clean.sh --dry    # 预览将清理的内容,不实际删除
#
# 清理目标:
#   1. turbo 缓存          (.turbo/)
#   2. 各包构建产物         (packages/**/dist/)
#   3. 测试产物            (test-results/, playwright-report/)
#   4. agent 运行时缓存     (.reasonix/)
#   5. [仅 --deep] node_modules (需重新 pnpm install)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DEEP=0
DRY=0
for arg in "$@"; do
  case "$arg" in
    --deep) DEEP=1 ;;
    --dry)  DRY=1 ;;
    *) echo "未知参数: $arg"; echo "用法: $0 [--deep] [--dry]"; exit 1 ;;
  esac
done

# 需要清理的路径(相对于 REPO_ROOT)
# --- 构建产物 ---
DIST_DIRS=(
  "packages/backend/server/dist"
  "packages/backend/database/dist"
  "packages/common/error/dist"
  "packages/frontend/web/dist"
)

# --- 缓存 ---
CACHE_DIRS=(
  ".turbo"
  ".reasonix"
)

# --- 测试产物 ---
TEST_DIRS=(
  "test-results"
  "playwright-report"
)

# --- 深度清理专用 ---
DEEP_DIRS=(
  "node_modules"
)

ACTION="清理"
RM_CMD="rm -rf"
if [ "$DRY" = 1 ]; then
  ACTION="预览(不删除)"
  RM_CMD="echo [dry-run] rm -rf"
fi

total_freed=0

clean_dir() {
  local rel_path="$1"
  local abs_path="$REPO_ROOT/$rel_path"
  if [ -e "$abs_path" ]; then
    local size
    size="$(du -sh "$abs_path" 2>/dev/null | cut -f1)"
    echo "  $ACTION $rel_path ($size)"
    $RM_CMD "$abs_path"
  fi
}

echo "=== CoAgentHub 清理脚本 ==="
echo "模式: ${DRY:+预览}${DRY:-实际删除} ${DEEP:+(深度)}${DEEP:-(保留 node_modules)}"
echo "仓库: $REPO_ROOT"
echo

echo "--- 构建产物 (dist/) ---"
for dir in "${DIST_DIRS[@]}"; do
  clean_dir "$dir"
done

echo
echo "--- 缓存 ---"
for dir in "${CACHE_DIRS[@]}"; do
  clean_dir "$dir"
done

echo
echo "--- 测试产物 ---"
for dir in "${TEST_DIRS[@]}"; do
  clean_dir "$dir"
done

if [ "$DEEP" = 1 ]; then
  echo
  echo "--- 深度清理: node_modules ---"
  for dir in "${DEEP_DIRS[@]}"; do
    clean_dir "$dir"
  done
  # 各子包的 node_modules(pnpm workspace 会在子包创建符号链接)
  find "$REPO_ROOT/packages" -maxdepth 4 -name "node_modules" -type d \
    -not -path "*/node_modules/*/node_modules/*" 2>/dev/null | while read -r nm; do
    rel="${nm#$REPO_ROOT/}"
    clean_dir "$rel"
  done
  echo
  echo "⚠️  node_modules 已删除,请运行: cd $REPO_ROOT && pnpm install"
fi

echo
echo "=== 清理完成 ==="
if [ "$DEEP" = 0 ]; then
  echo "提示: 如需同时清理 node_modules,使用: $0 --deep"
fi
if [ "$DRY" = 1 ]; then
  echo "提示: 这是预览模式,实际清理请去掉 --dry 参数"
fi
