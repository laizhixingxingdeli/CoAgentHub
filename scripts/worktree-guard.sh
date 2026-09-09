#!/bin/sh
# 工作树看门狗 —— 无人值守连续派发时守住「在途工作仍在途」。
# Spec: specs/worktree-guard-for-unattended-dispatch.md
#
# 用法:
#   sh scripts/worktree-guard.sh [轮数] [间隔秒]
#   默认 90 轮 × 20s = 30 分钟,适合挂在一次派发旁边。
#
# 不变量:
#   启动那一刻处于「未提交(空格M)/ 未跟踪(??)」的每一条路径,
#   在整个守护期内必须保持该状态。
#   —— 只看「消失」,不看「新增」:守护期内执行器本来就会产生新改动,
#      那是正常工作;基线路径从这两个状态里消失才是异常。
#
# 另一条判据:HEAD 的提交信息以 "coagenthub checkpoint " 开头。
#   该模式是 commit-tree 的机器产物,永远不该出现在 HEAD 上,命中即损坏。
#
# ⚠️ 只告警,不自动修复(spec R3):守护期内执行器的提交可能是有效工作,
#    盲目 reset 会毁掉它。本脚本给出可直接执行的还原命令,但不执行。
#
# 退出码:0 = 全程无告警;1 = 出现过告警(可被调用方消费)。
set -u

ROUNDS="${1:-90}"
SLEEP="${2:-20}"

cd "$(git rev-parse --show-toplevel)" || exit 1

# 基线:启动时的「在途」路径集合。
# porcelain 的 " M path" 与 "?? path" —— 只取这两类,取路径部分。
snapshot_inflight() {
  git status --porcelain 2>/dev/null | awk '
    /^ M / { print "M\t" substr($0, 4); next }
    /^\?\? / { print "U\t" substr($0, 4); next }
  '
}

BASE="$(snapshot_inflight)"
BASE_N=$(printf '%s' "$BASE" | grep -c . || true)

echo "== [$(date +%H:%M:%S)] 看门狗启动:守护 $BASE_N 条在途路径,${ROUNDS} 轮 × ${SLEEP}s"
if [ "$BASE_N" -gt 0 ]; then
  printf '%s\n' "$BASE" | while IFS="$(printf '\t')" read -r kind path; do
    [ -n "${path:-}" ] && echo "   [$kind] $path"
  done
fi

alerted=0
i=0
while [ "$i" -lt "$ROUNDS" ]; do
  # 判据一:HEAD 不得是 checkpoint 提交
  subj=$(git log -1 --format=%s 2>/dev/null || true)
  case "$subj" in
    "coagenthub checkpoint "*)
      echo "!!! [$(date +%H:%M:%S)] HEAD 被 checkpoint 提交占据:$(git rev-parse --short HEAD)"
      echo "!!!   $subj"
      echo "!!!   还原(不自动执行): git reset --mixed $(git rev-parse --short HEAD^)"
      alerted=1
      ;;
  esac

  # 判据二:基线路径必须仍在同一状态
  if [ "$BASE_N" -gt 0 ]; then
    now="$(snapshot_inflight)"
    printf '%s\n' "$BASE" | while IFS="$(printf '\t')" read -r kind path; do
      [ -z "${path:-}" ] && continue
      if ! printf '%s\n' "$now" | grep -qxF "$kind	$path"; then
        echo "!!! [$(date +%H:%M:%S)] 在途工作状态变了:[$kind] $path"
        echo "!!!   现在: $(git status --porcelain -- "$path" 2>/dev/null | head -1)"
        echo "!!!   最近提交: $(git log -1 --oneline)"
        echo "!!!   若被误提交,查看: git show --stat HEAD -- \"$path\""
        # 子 shell 里无法回写 alerted,用标记文件传出
        : > "${TMPDIR:-/tmp}/.worktree-guard-alert.$$"
      fi
    done
    [ -e "${TMPDIR:-/tmp}/.worktree-guard-alert.$$" ] && alerted=1
  fi

  i=$((i + 1))
  [ "$i" -lt "$ROUNDS" ] && sleep "$SLEEP"
done

rm -f "${TMPDIR:-/tmp}/.worktree-guard-alert.$$"

if [ "$alerted" -eq 0 ]; then
  echo "== [$(date +%H:%M:%S)] 本轮无异常 HEAD=$(git rev-parse --short HEAD)"
  git status --porcelain
  exit 0
fi

echo "== [$(date +%H:%M:%S)] 本轮有告警,见上"
git status --porcelain
exit 1
