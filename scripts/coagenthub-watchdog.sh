#!/bin/bash
# coagenthub-watchdog.sh — CoAgentHub 健康看门狗 (ticket 29, spec: rebuild-when-runtime-goes-stale)
#
# 单次检查做两件事:
#  1. 健康巡检(原有):server(:3001 health)与 web(:3000)任一不健康 → 告警 →
#     coagenthub-prod.sh restart(幂等,不带 --build)尝试恢复,再查一次;仍失败记 FAIL。
#  2. 构建陈旧巡检(R1):健康时读 /api/health 的 staleReason——
#     - build / both → 需要重建,调 coagenthub-prod.sh restart --build(R2)
#     - process  → 不触发重建,只记日志(重启即可,不需要重新构建)
#   陈旧重建受两道保护:
#     - R4 在途保护(fail-closed):存在 running/queued 任务 → 跳过本轮;
#       枚举在途任务时若「缺 node / 群或任务 curl 失败 / JSON 解析失败 / 分页无法确认完整」
#       任何一项无法确认「无在途」,一律本轮跳过重建并记录明确日志(宁可不动,不可误杀在途任务)。
#     - R3 失败退避:重建失败计数持久化到文件(--once 是单次调用,内存态不跨调用),
#       连续失败达阈值(默认 3 次)后停止自动重建只记日志;一次成功归零。
#     - R2 重建后复核:restart --build 返回 0 后必须重新读取 /api/health,
#       仅当 stale===false(且 staleReason 不再是 build/both)才算成功并清零失败计数;
#       仍陈旧或健康响应不可验证 → 计为失败并进入持久化退避。
#
# 用法:
#   scripts/coagenthub-watchdog.sh            # 默认循环,每 5 分钟查一次
#   scripts/coagenthub-watchdog.sh --once     # 单次检查(供 cron 每 5 分钟调用)
#
# 可覆盖(环境变量):
#   COAGENTHUB_HEALTH_URL         默认 http://localhost:3001/api/system/health
#   COAGENTHUB_RUNTIME_HEALTH_URL 默认 http://localhost:3001/api/health
#   COAGENTHUB_TASKS_API_URL      默认 http://localhost:3001/api(群/任务列表,判断在途)
#   COAGENTHUB_WEB_URL            默认 http://localhost:3000
#   COAGENTHUB_WATCHDOG_LOG       默认 /tmp/coagenthub-watchdog.log
#   COAGENTHUB_WATCHDOG_INTERVAL  循环模式间隔秒数,默认 300
#   COAGENTHUB_STALE_FAILURE_FILE 默认 /tmp/coagenthub-watchdog-stale-failures
#   COAGENTHUB_STALE_MAX_FAILURES 默认 3
#   COAGENTHUB_PROD_SCRIPT        默认 $SCRIPT_DIR/coagenthub-prod.sh(测试可覆盖)
#   COAGENTHUB_RESTART_SLEEP      重启后复查等待秒数,默认 3(测试可设 0)
#   COAGENTHUB_PAGE_LIMIT         在途枚举分页大小,默认 100
#   COAGENTHUB_HAVE_NODE          强制 node 可用性(测试用):0=缺 node,1=有 node,缺省自动探测
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HEALTH_URL="${COAGENTHUB_HEALTH_URL:-http://localhost:3001/api/system/health}"
RUNTIME_HEALTH_URL="${COAGENTHUB_RUNTIME_HEALTH_URL:-http://localhost:3001/api/health}"
TASKS_API_URL="${COAGENTHUB_TASKS_API_URL:-http://localhost:3001/api}"
WEB_URL="${COAGENTHUB_WEB_URL:-http://localhost:3000}"
WATCHDOG_LOG="${COAGENTHUB_WATCHDOG_LOG:-/tmp/coagenthub-watchdog.log}"
INTERVAL="${COAGENTHUB_WATCHDOG_INTERVAL:-300}"
STALE_FAILURE_FILE="${COAGENTHUB_STALE_FAILURE_FILE:-/tmp/coagenthub-watchdog-stale-failures}"
STALE_MAX_FAILURES="${COAGENTHUB_STALE_MAX_FAILURES:-3}"
PROD_SCRIPT="${COAGENTHUB_PROD_SCRIPT:-$SCRIPT_DIR/coagenthub-prod.sh}"
RESTART_SLEEP="${COAGENTHUB_RESTART_SLEEP:-3}"
PAGE_LIMIT="${COAGENTHUB_PAGE_LIMIT:-100}"

# cron 环境 PATH 很精简,这里兜底补全(node/pnpm 由 prod 脚本内部再补)
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:$PATH"

# JSON 解析用 node(PATH 兜底后一般可用);没有 node 时降级为「读不到 stale/在途」。
# COAGENTHUB_HAVE_NODE 仅供测试强制可用性,正常情况缺省由 command -v 自动探测。
if [ "${COAGENTHUB_HAVE_NODE:-}" = "0" ]; then
  HAVE_NODE=0
elif [ "${COAGENTHUB_HAVE_NODE:-}" = "1" ]; then
  HAVE_NODE=1
else
  HAVE_NODE=0
  command -v node >/dev/null 2>&1 && HAVE_NODE=1
fi

health_ok() {
  curl -sf -m 5 "$HEALTH_URL" >/dev/null 2>&1
}
web_ok() {
  curl -sf -m 5 "$WEB_URL" >/dev/null 2>&1
}

# 读 /api/health,输出单 token(供 R1 检测与 R2 复核统一使用):
#   fresh   stale===false(可重建成功判定)
#   build / both / process / stale   stale===true 且 staleReason 取值
#   unknown  读不到 / 解析失败 / stale 字段非布尔(不可验证 → 视为不可重建)
# 缺 node 时直接输出空(调用方按「不可验证」处理,不触发重建)。
read_runtime() {
  [ "$HAVE_NODE" = 1 ] || { printf ''; return; }
  curl -sf -m 5 "$RUNTIME_HEALTH_URL" 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(s);
        if (j.stale === false) { console.log("fresh"); return; }
        if (j.stale === true) { console.log(j.staleReason || "stale"); return; }
        console.log("unknown");
      } catch { console.log("unknown"); }
    });
  ' 2>/dev/null || true
}

# 在途任务检查(R4, fail-closed)。结果写入全局变量 TASK_CHECK:
#   clear    完整枚举所有群+任务,确认无 running/queued
#   inflight 发现 running/queued → 跳过重建(调用方处理)
#   unknown  任何一环无法确认「无在途」(缺 node / curl 失败 / 解析失败 / 分页无法确认完整)
#            → fail-closed 跳过重建(调用方处理)
#
# 分页协议(对齐真实 API):
#   GET /api/groups?limit=&offset=  → { items, total };total 已知则按 total 判定完整性,
#                                      total 缺失且本页未满 limit 视为单页完整,满页则继续翻页。
#   GET /api/groups/:id/tasks?limit=&offset= → 纯数组(无 total);
#                                      本页长度 < limit 视为完整,满页则继续翻页。
#   翻页途中任何一次 curl 失败 / JSON 解析失败 → unknown(本轮跳过)。
TASK_CHECK=unknown
check_in_flight() {
  TASK_CHECK=unknown
  [ "$HAVE_NODE" = 1 ] || {
    echo "$(date '+%F %T') SKIP 重建跳过(FAIL-CLOSED): 缺 node,无法枚举在途任务,本轮不重建" >> "$WATCHDOG_LOG"
    return
  }

  local LIMIT="$PAGE_LIMIT"
  local all_ids="" groffset=0 raw rc gtotal page_ids collected pagecount gid toffset tcount statuses

  # ---------- 枚举所有群(带 offset 分页) ----------
  groffset=0
  while :; do
    raw="$(curl -sf -m 5 "$TASKS_API_URL/groups?limit=$LIMIT&offset=$groffset" 2>/dev/null | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d));
      process.stdin.on("end", () => {
        try {
          const j = JSON.parse(s);
          const items = Array.isArray(j.items) ? j.items : (Array.isArray(j) ? j : []);
          const total = (typeof j.total === "number") ? j.total : items.length;
          console.log(total);
          for (const g of items) console.log(g.id || "");
        } catch { process.exit(2); }
      });
    ' 2>/dev/null)"; rc=$?
    if [ "$rc" != 0 ]; then
      echo "$(date '+%F %T') SKIP 重建跳过(FAIL-CLOSED): 读取群列表失败(curl/JSON 解析),无法确认无在途任务" >> "$WATCHDOG_LOG"
      return
    fi
    gtotal="$(printf '%s' "$raw" | head -1)"
    page_ids="$(printf '%s' "$raw" | tail -n +2)"
    all_ids="$all_ids"$'\n'"$page_ids"
    collected="$(printf '%s' "$all_ids" | grep -c .)"
    pagecount="$(printf '%s' "$page_ids" | grep -c .)"
    # 完整性判定:total 已知且已收满 → 完成;total 缺失且本页未满 limit → 单页完成
    if [ -n "$gtotal" ] && [ "$collected" -ge "$gtotal" ]; then break; fi
    if [ -z "$gtotal" ] && [ "$pagecount" -lt "$LIMIT" ]; then break; fi
    # 还需翻页:本页满且(无 total 或 尚未收满 total)
    groffset=$((groffset + LIMIT))
    if [ "$groffset" -ge 100000 ]; then
      echo "$(date '+%F %T') SKIP 重建跳过(FAIL-CLOSED): 群列表分页过多无法确认完整,本轮不重建" >> "$WATCHDOG_LOG"
      return
    fi
  done

  # ---------- 逐群枚举任务(带 offset 分页) ----------
  for gid in $all_ids; do
    [ -z "$gid" ] && continue
    toffset=0
    while :; do
      raw="$(curl -sf -m 5 "$TASKS_API_URL/groups/$gid/tasks?limit=$LIMIT&offset=$toffset" 2>/dev/null | node -e '
        let s = "";
        process.stdin.on("data", (d) => (s += d));
        process.stdin.on("end", () => {
          try {
            const a = JSON.parse(s);
            if (!Array.isArray(a)) process.exit(2);
            console.log(a.length);
            for (const t of a) console.log(t.status || "");
          } catch { process.exit(2); }
        });
      ' 2>/dev/null)"; rc=$?
      if [ "$rc" != 0 ]; then
        echo "$(date '+%F %T') SKIP 重建跳过(FAIL-CLOSED): 读取群 $gid 任务失败(curl/JSON 解析),无法确认无在途任务" >> "$WATCHDOG_LOG"
        return
      fi
      tcount="$(printf '%s' "$raw" | head -1)"
      statuses="$(printf '%s' "$raw" | tail -n +2)"
      if printf '%s' "$statuses" | grep -qx "running" || printf '%s' "$statuses" | grep -qx "queued"; then
        echo "$(date '+%F %T') SKIP 重建跳过: 群 $gid 存在 running/queued 任务,本轮跳过重建" >> "$WATCHDOG_LOG"
        TASK_CHECK=inflight
        return
      fi
      # 完整性判定:本页长度 < limit → 完整;否则继续翻页
      if [ "$tcount" -lt "$LIMIT" ]; then break; fi
      toffset=$((toffset + LIMIT))
      if [ "$toffset" -ge 100000 ]; then
        echo "$(date '+%F %T') SKIP 重建跳过(FAIL-CLOSED): 群 $gid 任务分页过多无法确认完整,本轮不重建" >> "$WATCHDOG_LOG"
        return
      fi
    done
  done

  TASK_CHECK=clear
}

stale_fail_count() {
  cat "$STALE_FAILURE_FILE" 2>/dev/null || echo 0
}
stale_fail_inc() {
  echo "$(( $(stale_fail_count) + 1 ))" > "$STALE_FAILURE_FILE"
}
stale_fail_reset() {
  rm -f "$STALE_FAILURE_FILE"
}

# 单次检查:健康 → 0;不健康 → 告警 → restart → 再查,仍失败记 FAIL 并返回 1
run_once() {
  local failed=""
  health_ok || failed="$HEALTH_URL"
  web_ok || failed="${failed:+$failed, }$WEB_URL"

  # 缺 node:连陈旧状态都读不到, fail-closed 跳过构建陈旧检测与在途检查
  if [ "$HAVE_NODE" = 0 ]; then
    echo "$(date '+%F %T') SKIP 构建陈旧巡检跳过(FAIL-CLOSED): 缺 node,无法读取 /api/health 与枚举在途任务,本轮不重建" >> "$WATCHDOG_LOG"
  fi

  # R1:健康时读构建陈旧状态
  local reason=""
  if [ -z "$failed" ]; then
    reason="$(read_runtime)"
  fi

  # R2:陈旧路径(build/both)→ restart --build,与「不健康」路径分离
  if [ -z "$failed" ] && { [ "$reason" = "build" ] || [ "$reason" = "both" ]; }; then
    # R4:在途任务保护(fail-closed)。完整枚举所有群及其任务确认无 running/queued;
    # 任一环节无法确认「无在途」→ 本轮跳过重建。
    check_in_flight
    if [ "$TASK_CHECK" != "clear" ]; then
      # inflight / unknown 已各自记过日志,直接跳过本轮
      return 0
    fi
    # R3:失败退避,连续失败达阈值后停止自动重建
    local n
    n="$(stale_fail_count)"
    if [ "$n" -ge "$STALE_MAX_FAILURES" ]; then
      echo "$(date '+%F %T') SKIP 构建已连续失败 $n 次(≥$STALE_MAX_FAILURES),停止自动重建,等待人工介入" >> "$WATCHDOG_LOG"
      return 0
    fi
    echo "$(date '+%F %T') WARN 构建陈旧 (staleReason=$reason),尝试 prod restart --build" >> "$WATCHDOG_LOG"
    if "$PROD_SCRIPT" restart --build >/dev/null 2>&1; then
      # R2:重建返回成功,必须重新读取 /api/health 复核,确认 stale===false 才算成功
      sleep "$RESTART_SLEEP"
      local post
      post="$(read_runtime)"
      if [ "$post" = "fresh" ]; then
        stale_fail_reset
        echo "$(date '+%F %T') OK   重建成功,复核 /api/health stale=false,失败计数已归零" >> "$WATCHDOG_LOG"
        return 0
      fi
      stale_fail_inc
      echo "$(date '+%F %T') FAIL 重建返回成功但复核 /api/health 仍陈旧或不可验证(stale状态=$post),计为失败进入退避(连续 $(stale_fail_count) 次)" >> "$WATCHDOG_LOG"
      return 1
    fi
    stale_fail_inc
    echo "$(date '+%F %T') FAIL 重建失败(连续 $(stale_fail_count) 次)" >> "$WATCHDOG_LOG"
    return 1
  fi

  # R1:process 陈旧不触发重建(entry 比进程启动新,重启即可)
  if [ -z "$failed" ] && [ "$reason" = "process" ]; then
    echo "$(date '+%F %T') INFO staleReason=process,不触发重建(重启即可解决)" >> "$WATCHDOG_LOG"
    return 0
  fi

  # 原有不健康路径:不带 --build,保持现状(进程挂掉时重新构建只会拖慢恢复)
  if [ -z "$failed" ]; then
    return 0
  fi
  echo "$(date '+%F %T') WARN 不健康 ($failed),尝试 prod restart" >> "$WATCHDOG_LOG"
  "$PROD_SCRIPT" restart >/dev/null 2>&1
  sleep "$RESTART_SLEEP"
  if health_ok && web_ok; then
    echo "$(date '+%F %T') OK   重启后恢复" >> "$WATCHDOG_LOG"
    return 0
  fi
  echo "$(date '+%F %T') FAIL 重启后仍不健康 ($failed)" >> "$WATCHDOG_LOG"
  return 1
}

ONCE=0
for a in "$@"; do [ "$a" = "--once" ] && ONCE=1; done

if [ "$ONCE" = 1 ]; then
  run_once
  exit $?
fi

echo "watchdog 循环模式:每 ${INTERVAL}s 检查 $HEALTH_URL (Ctrl-C 退出)"
while true; do
  run_once
  sleep "$INTERVAL"
done
