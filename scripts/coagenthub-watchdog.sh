#!/bin/bash
# coagenthub-watchdog.sh — CoAgentHub 健康看门狗 (ticket 29)
#
# 检查 server 健康端点;失败则写告警日志 /tmp/coagenthub-watchdog.log(带时间戳),
# 用 coagenthub-prod.sh restart(幂等)尝试恢复,再查一次;仍失败则日志记 FAIL。
#
# 用法:
#   scripts/coagenthub-watchdog.sh            # 默认循环,每 5 分钟查一次
#   scripts/coagenthub-watchdog.sh --once     # 单次检查(供 cron 每 5 分钟调用)
#
# 可覆盖(环境变量):
#   COAGENTHUB_HEALTH_URL         默认 http://localhost:3001/api/system/health
#   COAGENTHUB_WATCHDOG_LOG       默认 /tmp/coagenthub-watchdog.log
#   COAGENTHUB_WATCHDOG_INTERVAL  循环模式间隔秒数,默认 300
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HEALTH_URL="${COAGENTHUB_HEALTH_URL:-http://localhost:3001/api/system/health}"
WEB_URL="${COAGENTHUB_WEB_URL:-http://localhost:3000}"
WATCHDOG_LOG="${COAGENTHUB_WATCHDOG_LOG:-/tmp/coagenthub-watchdog.log}"
INTERVAL="${COAGENTHUB_WATCHDOG_INTERVAL:-300}"
PROD_SCRIPT="$SCRIPT_DIR/coagenthub-prod.sh"

# cron 环境 PATH 很精简,这里兜底补全(node/pnpm 由 prod 脚本内部再补)
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:$PATH"

health_ok() {
  curl -sf -m 5 "$HEALTH_URL" >/dev/null 2>&1
}
web_ok() {
  curl -sf -m 5 "$WEB_URL" >/dev/null 2>&1
}

# 单次检查:健康 → 0;不健康 → 告警 → restart → 再查,仍失败记 FAIL 并返回 1
run_once() {
  # server(:3001 health)与 web(:3000)任一不健康都触发 restart(web 挂了
  # 但 server 健康时,旧逻辑不会拉起前端,用户实际访问入口仍是断的)
  local failed=""
  health_ok || failed="$HEALTH_URL"
  web_ok || failed="${failed:+$failed, }$WEB_URL"
  if [ -z "$failed" ]; then
    return 0
  fi
  echo "$(date '+%F %T') WARN 不健康 ($failed),尝试 prod restart" >> "$WATCHDOG_LOG"
  "$PROD_SCRIPT" restart >/dev/null 2>&1
  sleep 3
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
