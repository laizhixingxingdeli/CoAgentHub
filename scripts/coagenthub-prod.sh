#!/bin/bash
# coagenthub-prod.sh — CoAgentHub 一键生产启动/停止/状态 (ticket 27)
#
# 用法:
#   scripts/coagenthub-prod.sh start [--build]   # 一键启动(幂等:已占用端口跳过;--build 才构建)
#   scripts/coagenthub-prod.sh stop              # 停止本脚本启动的三服务
#   scripts/coagenthub-prod.sh restart [--build] # stop + start(健康看门狗用)
#   scripts/coagenthub-prod.sh status            # 检查三端口监听 + PID(自愈:launchd com.coagenthub.watchdog 每 5 分钟)
#   scripts/coagenthub-prod.sh plist-install     # 复制 LaunchAgent 模板到 ~/Library/LaunchAgents(不 load)
#   scripts/coagenthub-prod.sh plist-uninstall   # launchctl unload + 删文件
#   scripts/coagenthub-prod.sh cron-install      # 安装每日 02:30 备份 + 每 5 分钟 watchdog(幂等)
#   scripts/coagenthub-prod.sh cron-uninstall    # 移除本脚本安装的 cron 条目(幂等)
#
# 端口(可用环境变量覆盖,便于隔离验证):
#   COAGENTHUB_SERVER_PORT 默认 3001  node dist/server.mjs          (生产后端, PORT env)
#   COAGENTHUB_WEB_PORT     默认 3000  node serve.mjs [端口] [后端]  (前端 dist + /api 反代 + WS upgrade)
#
# 日志: /tmp/coagenthub-prod-{server,web}-<YYYYMMDD>.log,按天轮转;
#       启动时自动清理超过 14 天的旧日志(端口覆盖时带端口后缀)
# 启动要点: 子进程 nohup + 子 shell `(cd dir && cmd &)` 完全脱离当前 shell,
#           PPID 归 1(launchd);PID 记录 /tmp/coagenthub-prod-<port>.pid, stop 按 PID 文件杀。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$REPO_ROOT/packages/backend/server"
DATABASE_DIR="$REPO_ROOT/packages/backend/database"

SERVER_PORT="${COAGENTHUB_SERVER_PORT:-3001}"
WEB_PORT="${COAGENTHUB_WEB_PORT:-3000}"

# launchd 环境 PATH 很精简,这里兜底补全 node/pnpm 所在路径
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:$PATH"

# 常驻服务用 TCC 白名单内的 node 二进制启动(macOS 26,仓库在 ~/Desktop 受 TCC 保护):
# 用普通 node 启动的服务在被 launchd/cron 拉起且脱离父进程后,Desktop 读权限取决于其
# 自身二进制路径(默认不在白名单),会出现 "Operation not permitted"。
# ~/.hermes/node/bin/node 已被授予 Desktop 访问(见 系统设置→隐私与安全性),随行
# ~/.local/bin/node 只是它的软链;这里显式选中它,保证服务无论从哪拉起都有读权限。
NODE_BIN="${COAGENTHUB_NODE_BIN:-}"
if [ -z "$NODE_BIN" ] && [ -x /Users/apple/.hermes/node/bin/node ]; then
  NODE_BIN=/Users/apple/.hermes/node/bin/node
fi
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
[ -z "$NODE_BIN" ] && NODE_BIN=node

log_suffix() { # 端口被覆盖时日志/PID 加后缀,避免隔离测试污染正式文件
  if [ "${COAGENTHUB_SERVER_PORT:-}" ] || [ "${COAGENTHUB_WEB_PORT:-}" ]; then
    echo "-$1"
  fi
}
# 日志按天轮转:每天一个新文件 <YYYYMMDD>(端口覆盖时再带端口后缀,隔离测试)。
SLOG="/tmp/coagenthub-prod-server-$(date +%Y%m%d)$(log_suffix "$SERVER_PORT").log"
WLOG="/tmp/coagenthub-prod-web-$(date +%Y%m%d)$(log_suffix "$WEB_PORT").log"
PIDFILE="/tmp/coagenthub-prod-$SERVER_PORT.pid"

# ---------- 工具 ----------

port_pid() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; }
is_up() { [ -n "$(port_pid "$1")" ]; }

# 等端口就绪,最多 15s
wait_up() {
  for _ in $(seq 1 30); do
    is_up "$1" && return 0
    sleep 0.5
  done
  return 1
}

# 启动时清理超过 14 天的按天日志(零依赖:find -mtime +14 -delete)
cleanup_old_logs() {
  local n
  n="$(find /tmp -maxdepth 1 \( -name 'coagenthub-prod-server-*.log' -o -name 'coagenthub-prod-web-*.log' \) -mtime +14 2>/dev/null | wc -l | tr -d ' ')"
  find /tmp -maxdepth 1 \( -name 'coagenthub-prod-server-*.log' -o -name 'coagenthub-prod-web-*.log' \) -mtime +14 -delete 2>/dev/null
  [ "${n:-0}" -gt 0 ] && echo "清理 $n 个超过 14 天的旧日志"
}

lan_ips() {
  node -e 'const os=require("os");for(const [n,a] of Object.entries(os.networkInterfaces()))for(const x of a||[])if(x.family==="IPv4"&&!x.internal)console.log(x.address)'
}

# ---------- 各服务启动(幂等) ----------

start_server() {
  if is_up "$SERVER_PORT"; then
    echo "SKIP  server  :$SERVER_PORT 已被占用 (pid $(port_pid "$SERVER_PORT")),跳过"
    return 0
  fi
  if [ ! -f "$SERVER_DIR/dist/server.mjs" ]; then
    echo "FAIL  server  : dist 缺失,先跑 --build 或 pnpm build" >&2
    return 1
  fi
  echo "START server  :$SERVER_PORT (node dist/server.mjs)"
  (
    cd "$SERVER_DIR" || exit 1
    nohup "$NODE_BIN" dist/server.mjs </dev/null >>"$SLOG" 2>&1 &
    echo $! > "$PIDFILE"
  )
  wait_up "$SERVER_PORT" && echo "OK    server  :$SERVER_PORT 就绪 (pid $(port_pid "$SERVER_PORT"))" \
    || { echo "FAIL  server  : 启动超时,见 $SLOG" >&2; return 1; }
}

start_web() {
  if is_up "$WEB_PORT"; then
    echo "SKIP  web     :$WEB_PORT 已被占用 (pid $(port_pid "$WEB_PORT")),跳过"
    return 0
  fi
  if [ ! -f "$REPO_ROOT/packages/frontend/web/dist/index.html" ]; then
    echo "FAIL  web     : 前端 dist 缺失,先跑 --build 或 pnpm build:frontend" >&2
    return 1
  fi
  echo "START web     :$WEB_PORT (node serve.mjs $WEB_PORT http://localhost:$SERVER_PORT)"
  (
    cd "$REPO_ROOT" || exit 1
    nohup "$NODE_BIN" serve.mjs "$WEB_PORT" "http://localhost:$SERVER_PORT" </dev/null >>"$WLOG" 2>&1 &
    echo $! > "/tmp/coagenthub-prod-web-$WEB_PORT.pid"
  )
  wait_up "$WEB_PORT" && echo "OK    web     :$WEB_PORT 就绪 (pid $(port_pid "$WEB_PORT"))" \
    || { echo "FAIL  web     : 启动超时,见 $WLOG" >&2; return 1; }
}

# ---------- 主命令 ----------

cmd_start() {
  local BUILD=0
  for a in "$@"; do [ "$a" = "--build" ] && BUILD=1; done

  cleanup_old_logs

  if [ "$BUILD" = 1 ]; then
    echo "== 构建 (--build) =="
    (cd "$REPO_ROOT" && pnpm build:frontend) || { echo "FAIL 前端构建" >&2; exit 1; }
    (cd "$SERVER_DIR" && pnpm build) || { echo "FAIL 后端构建" >&2; exit 1; }
  fi

  echo "== 数据库迁移 =="
  (
    cd "$DATABASE_DIR" || exit 1
    # migrate.ts 依赖 dotenv 从 cwd 读 .env,这里显式带上 server/.env 的 DATABASE_URL
    if [ -f "$SERVER_DIR/.env" ]; then
      export DATABASE_URL="$(grep -E '^DATABASE_URL=' "$SERVER_DIR/.env" | head -1 | cut -d= -f2-)"
    fi
    pnpm migrate
  ) || { echo "FAIL 迁移,中止启动(可用 coagenthub-backup.sh 恢复数据后重试)" >&2; exit 1; }

  echo "== 启动三服务 =="
  start_server || exit 1
  start_web || exit 1

  echo
  echo "== 状态 =="
  cmd_status
  local ip
  ip="$(lan_ips 2>/dev/null | head -1)"
  [ -n "$ip" ] && echo "局域网访问: http://$ip:$WEB_PORT"
}

cmd_stop() {
  # 按 PID 文件杀本脚本启动的进程;杀完等端口释放
  local killed=0
  for p in "$PIDFILE" "/tmp/coagenthub-prod-web-$WEB_PORT.pid"; do
    if [ -f "$p" ]; then
      local pid
      pid="$(cat "$p" 2>/dev/null)"
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null && echo "STOP  pid $pid ($p)" && killed=1
        for _ in $(seq 1 20); do
          kill -0 "$pid" 2>/dev/null || break
          sleep 0.3
        done
        kill -9 "$pid" 2>/dev/null
      fi
      rm -f "$p"
    fi
  done
  [ "$killed" = 0 ] && echo "没有由本脚本启动的进程(PID 文件不存在)。"
  echo "== 剩余监听 =="
  cmd_status
}

cmd_restart() {
  cmd_stop
  cmd_start "$@"
}

cmd_status() {
  local port pid
  for port in "$SERVER_PORT" "$WEB_PORT"; do
    pid="$(port_pid "$port")"
    if [ -n "$pid" ]; then
      printf '%-8s :%-5s RUNNING pid=%-7s %s\n' "$(port_name "$port")" "$port" "$pid" "$(ps -p "$pid" -o command= 2>/dev/null | cut -c1-60)"
    else
      printf '%-8s :%-5s DOWN\n' "$(port_name "$port")" "$port"
    fi
  done
}

port_name() {
  case "$1" in
    "$SERVER_PORT") echo "server" ;;
    "$WEB_PORT")    echo "web" ;;
  esac
}

PLIST_SRC="$SCRIPT_DIR/deploy/com.coagenthub.prod.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.coagenthub.prod.plist"

cmd_plist_install() {
  if [ ! -f "$PLIST_SRC" ]; then echo "FAIL 缺少模板 $PLIST_SRC" >&2; exit 1; fi
  mkdir -p "$HOME/Library/LaunchAgents"
  cp "$PLIST_SRC" "$PLIST_DST"
  echo "已复制模板 → $PLIST_DST"
  echo "启用(手动执行,不代做):"
  echo "  launchctl load $PLIST_DST"
  echo "  launchctl start com.coagenthub.prod   # 立即触发一次"
}

cmd_plist_uninstall() {
  launchctl unload "$PLIST_DST" 2>/dev/null
  rm -f "$PLIST_DST"
  echo "已卸载 $PLIST_DST"
}

# ---------- cron 定时任务(每日备份 + 每 5 分钟 watchdog) ----------
# 幂等实现:每条目带 CRON_MARKER 注释,安装先剔除旧条目再追加,卸载按标记剔除。

CRON_MARKER="coagenthub-cron"

current_crontab() {
  crontab -l 2>/dev/null || true
}

cmd_cron_install() {
  local backup_cmd watchdog_cmd
  backup_cmd="30 2 * * * $SCRIPT_DIR/coagenthub-backup.sh >> \"\$HOME/coagenthub-backups/backup-cron.log\" 2>&1  # $CRON_MARKER"
  watchdog_cmd="*/5 * * * * $SCRIPT_DIR/coagenthub-watchdog.sh --once >/dev/null 2>&1  # $CRON_MARKER"
  if [ ! -x "$SCRIPT_DIR/coagenthub-backup.sh" ]; then
    echo "FAIL 缺少 $SCRIPT_DIR/coagenthub-backup.sh" >&2; exit 1
  fi
  if [ ! -x "$SCRIPT_DIR/coagenthub-watchdog.sh" ]; then
    echo "FAIL 缺少 $SCRIPT_DIR/coagenthub-watchdog.sh" >&2; exit 1
  fi
  { current_crontab | grep -v "$CRON_MARKER"; echo "$backup_cmd"; echo "$watchdog_cmd"; } | crontab -
  echo "已安装 cron:每日 02:30 备份(pg_dump,保留 7 份)+ 每 5 分钟 watchdog 健康检查"
  echo "已安装条目:"
  crontab -l 2>/dev/null | grep "$CRON_MARKER" || true
}

cmd_cron_uninstall() {
  local n
  n="$(current_crontab | grep -c "$CRON_MARKER" || true)"
  if [ "${n:-0}" -gt 0 ]; then
    current_crontab | grep -v "$CRON_MARKER" | crontab -
    echo "已移除 $n 条 coagenthub 定时任务(cron-install 安装的条目)"
  else
    echo "没有 coagenthub 定时任务(无需卸载)"
  fi
}

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  stop) cmd_stop ;;
  restart) shift; cmd_restart "$@" ;;
  status) cmd_status ;;
  plist-install) cmd_plist_install ;;
  plist-uninstall) cmd_plist_uninstall ;;
  cron-install) cmd_cron_install ;;
  cron-uninstall) cmd_cron_uninstall ;;
  *) echo "用法: $0 {start [--build]|stop|restart|status|plist-install|plist-uninstall|cron-install|cron-uninstall}"; exit 1 ;;
esac
