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
#     - R4 在途保护:存在 running/queued 任务时跳过本轮,记日志,等下一轮
#     - R3 失败退避:重建失败计数持久化到文件(--once 是单次调用,内存态不跨调用),
#       连续失败达阈值(默认 3 次)后停止自动重建只记日志;一次成功归零
#
# 用法:
#   scripts/coagenthub-watchdog.sh            # 默认循环,每 5 分钟查一次
#   scripts/coagenthub-watchdog.sh --once     # 单次检查(供 cron 每 5 分钟调用)
#
# 可覆盖(环境变量):
#   COAGENTHUB_HEALTH_URL         默认 http://localhost:3001/api/system/health
#   COAGENTHUB_RUNTIME_HEALTH_URL 默认 http://localhost:3001/api/health
#   COAGENTHUB_TASKS_API_URL      默认 http://localhost:3001/api(群/任务列表,判断在途)
#   COAGENTHUB_WATCHDOG_LOG       默认 /tmp/coagenthub-watchdog.log
#   COAGENTHUB_WATCHDOG_INTERVAL  循环模式间隔秒数,默认 300
#   COAGENTHUB_STALE_FAILURE_FILE 默认 /tmp/coagenthub-watchdog-stale-failures
#   COAGENTHUB_STALE_MAX_FAILURES 默认 3
#   COAGENTHUB_PROD_SCRIPT        默认 $SCRIPT_DIR/coagenthub-prod.sh(测试可覆盖)
#   COAGENTHUB_RESTART_SLEEP      重启后复查等待秒数,默认 3(测试可设 0)
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

# cron 环境 PATH 很精简,这里兜底补全(node/pnpm 由 prod 脚本内部再补)
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:$PATH"

# JSON 解析用 node(PATH 兜底后一般可用);没有 node 时降级为「读不到 stale/在途」。
HAVE_NODE=0
command -v node >/dev/null 2>&1 && HAVE_NODE=1

health_ok() {
  curl -sf -m 5 "$HEALTH_URL" >/dev/null 2>&1
}
web_ok() {
  curl -sf -m 5 "$WEB_URL" >/dev/null 2>&1
}

# 读 /api/health 的 staleReason;失败或不可用输出空串(调用方按「无陈旧」处理)
stale_reason() {
  [ "$HAVE_NODE" = 1 ] || return 0
  curl -sf -m 5 "$RUNTIME_HEALTH_URL" 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      try { const j = JSON.parse(s); console.log(j.staleReason || ""); }
      catch { /* 解析失败按无陈旧 */ }
    });
  ' 2>/dev/null || true
}

# 任一 active 群存在 running/queued 任务 → 0(有在途);否则 1。读不到则按 1 处理。
tasks_in_flight() {
  [ "$HAVE_NODE" = 1 ] || return 1
  local groups ids id tasks
  groups="$(curl -sf -m 5 "$TASKS_API_URL/groups" 2>/dev/null)" || return 1
  ids="$(printf '%s' "$groups" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      try { const j = JSON.parse(s); for (const g of j.items || []) console.log(g.id); }
      catch { /* 解析失败 → 无 id */ }
    });
  ' 2>/dev/null)"
  for id in $ids; do
    tasks="$(curl -sf -m 5 "$TASKS_API_URL/groups/$id/tasks?limit=100" 2>/dev/null)" || continue
    if printf '%s' "$tasks" | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d));
      process.stdin.on("end", () => {
        try {
          const a = JSON.parse(s);
          if (a.some((t) => t.status === "running" || t.status === "queued")) process.exit(0);
        } catch { /* 解析失败 → 视为无在途 */ }
        process.exit(1);
      });
    ' 2>/dev/null; then
      return 0
    fi
  done
  return 1
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

  # R1:健康时读构建陈旧状态
  local reason=""
  if [ -z "$failed" ]; then
    reason="$(stale_reason)"
  fi

  # R2:陈旧路径(build/both)→ restart --build,与「不健康」路径分离
  if [ -z "$failed" ] && { [ "$reason" = "build" ] || [ "$reason" = "both" ]; }; then
    # R4:在途任务保护,有 running/queued 则跳过本轮
    if tasks_in_flight; then
      echo "$(date '+%F %T') SKIP staleReason=$reason 但有 running/queued 任务,本轮跳过重建" >> "$WATCHDOG_LOG"
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
      stale_fail_reset
      echo "$(date '+%F %T') OK   重建成功,失败计数已归零" >> "$WATCHDOG_LOG"
      return 0
    fi
    stale_fail_inc
    echo "$(date '+%F %T') FAIL 重建失败(连续 $(( $(stale_fail_count) )) 次)" >> "$WATCHDOG_LOG"
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
