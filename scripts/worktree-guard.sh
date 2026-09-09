#!/bin/sh
# 工作树看门狗 —— 无人值守连续派发时守住「在途工作仍在途」。
# Spec: specs/worktree-guard-for-unattended-dispatch.md
#
# 用法:
#   sh scripts/worktree-guard.sh [--protect <路径>]... [轮数] [间隔秒]
#   默认 90 轮 × 20s = 30 分钟,适合挂在一次派发旁边。
#
# 不变量:被守护的每一条路径,在整个守护期内必须保持
#   「未提交(空格M)/ 未跟踪(??)」状态。
#   —— 只看「消失」,不看「新增」:守护期内执行器本来就会产生新改动,
#      那是正常工作;被守护路径从这两个状态里消失才是异常。
#
# ⚠️ 守护范围怎么选(2026-09-09 实战踩出来的):
#   **有 --protect 就只守它们**;没有才回落到「启动那一刻在途的一切」。
#   回落模式会把**你自己有意提交自己的工作**也判成告警 —— 当天检视者
#   提交 3 个测试文件就触发了一次误报。一个对正常操作狂叫的看门狗
#   会被养成无视的习惯,而那正是真告警被漏掉的方式。
#   所以:**知道该守谁的时候就点名**,回落模式只用于完全无人值守。
#
# 另一条判据:HEAD 的提交信息以 "coagenthub checkpoint " 开头。
#   该模式是 commit-tree 的机器产物,永远不该出现在 HEAD 上,命中即损坏。
#
# ⚠️ 只告警,不自动修复(spec R3):守护期内执行器的提交可能是有效工作,
#    盲目 reset 会毁掉它。本脚本给出可直接执行的还原命令,但不执行。
#
# 退出码:0 = 全程无告警;1 = 出现过告警(可被调用方消费)。
set -u

PROTECT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --protect)
      [ $# -ge 2 ] || { echo "--protect 需要一个路径" >&2; exit 2; }
      PROTECT="${PROTECT}${2}
"
      shift 2
      ;;
    *) break ;;
  esac
done

ROUNDS="${1:-90}"
SLEEP="${2:-20}"

cd "$(git rev-parse --show-toplevel)" || exit 1

# 当前「在途」集合。porcelain 的 " M path" 与 "?? path",取路径部分。
snapshot_inflight() {
  git status --porcelain 2>/dev/null | awk '
    /^ M / { print "M\t" substr($0, 4); next }
    /^\?\? / { print "U\t" substr($0, 4); next }
  '
}

if [ -n "$PROTECT" ]; then
  # 点名模式:只守这些路径,取它们此刻的状态当基线。
  NOW0="$(snapshot_inflight)"
  BASE="$(printf '%s' "$PROTECT" | while IFS= read -r p; do
    [ -z "$p" ] && continue
    printf '%s\n' "$NOW0" | grep -F "	$p" || {
      echo "!!! --protect 指定的路径当前不在途,无法守护:$p" >&2
    }
  done)"
else
  BASE="$(snapshot_inflight)"
fi
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
