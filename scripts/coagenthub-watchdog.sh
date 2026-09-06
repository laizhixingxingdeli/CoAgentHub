#!/bin/bash
# coagenthub-watchdog.sh — CoAgentHub 健康看门狗
# (ticket 29, spec: rebuild-when-runtime-goes-stale;
#  ticket: watchdog-detects-stale-runtime-but-never-recovers,R1-R4 自愈)
#
# 单次检查做两件事:
#  1. 健康巡检(原有):server(:3001 health)与 web(:3000)任一不健康 → 告警 →
#     coagenthub-prod.sh restart(幂等,不带 --build)尝试恢复,再查一次;仍失败记 FAIL。
#  2. 构建陈旧巡检:健康时读 /api/health 的 staleReason——
#     - build / both → 需要重建,调 coagenthub-prod.sh restart --build(R2 复核)
#     - process → 需要重启(不重建),调 coagenthub-prod.sh restart(不带 --build);
#       同样受在途保护与失败退避守卫(2026-09 spec R1:检测到即执行,不再只记日志)。
#   陈旧重建受两道保护:
#     - R4 在途保护(fail-closed):存在 running/queued 任务 → 跳过本轮;
#       枚举在途任务时若「缺 node / 群或任务 curl 失败 / JSON 解析失败 / 分页无法确认完整」
#       任何一项无法确认「无在途」,一律本轮跳过重建并记录明确日志(宁可不动,不可误杀在途任务)。
#     - R3 失败退避(滚动时间窗):重建/重启失败按时间戳记入持久化文件
#       (每行一个 epoch 秒),仅统计 COAGENTHUB_STALE_FAILURE_WINDOW_SECONDS
#       (默认 24h)滚动窗口内的失败,窗口外的旧失败自动淘汰;
#       窗口内失败达阈值(默认 3 次)后停用自动重建;停用后每次巡检重算窗口,
#       窗口过期(在窗失败数降到阈值以下)自动恢复尝试,无需人工删文件。
#     - R2 重建后复核:restart --build 的退出码仅作日志佐证,无论是否为 0,
#       都在等待后重新读取 /api/health;仅当 stale===false(fresh)才算成功并清零失败计数;
#       仍陈旧(build/both/stale)或健康响应不可验证(unknown)→ 计为失败并进入持久化退避。
#       切忌「退出码非零即计失败」:重建实际成功但脚本退出码非零会误累加退避,形成
#       每 5 分钟重试不收敛的高危闭环缺陷(见本票 Goal #1)。
#     - R2 停滞升级:连续 N 轮(COAGENTHUB_STALE_STALL_MAX_ROUNDS,默认 3 轮)因
#       在途任务无法处理陈旧 → 记 WARN 并向任务群发消息(POST /api/groups/:id/messages),
#       之后不再重复发群消息,只在状态文件记轮数(升级事实由 /api/system/health 透出,
#       见 R4)。陈旧被处理后停滞计数清零。
#     - R4 停用可见:停用期间每轮把事实写入 COAGENTHUB_AUTO_REBUILD_STATE 状态文件
#       (单行 JSON:disabled/disabledAt),server 的 /api/system/health 直接透出该文件;
#       处理成功(新鲜)后删除,健康接口随之回到未停用。
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
#                                 (每行一个 epoch 秒;旧格式「单行数字 N」视为 N 条
#                                  「现在」的失败,读后自动迁移为时间戳格式)
#   COAGENTHUB_STALE_MAX_FAILURES 默认 3(滚动窗口内的失败阈值)
#   COAGENTHUB_STALE_FAILURE_WINDOW_SECONDS 默认 86400(24h 滚动窗口)
#   COAGENTHUB_STALE_STALL_MAX_ROUNDS 默认 3(连续 N 轮被在途任务阻塞 → WARN 升级)
#   COAGENTHUB_STALL_STATE_FILE 默认 /tmp/coagenthub-watchdog-stall-state
#   COAGENTHUB_STALL_GROUP_ID   停滞 WARN 群消息的指定群 id(缺省取本机身份所在的
#                               第一个群,保证发送者一定是成员;测试可固定)
#   COAGENTHUB_PARTICIPANT_ID   停滞群消息的发送身份;缺省读
#                               ~/.coagenthub/participant-id(全信模型只声明身份)
#   COAGENTHUB_AUTO_REBUILD_STATE 默认 /tmp/coagenthub-watchdog-auto-rebuild-state
#                                 (server /api/system/health 透出 R4 停用事实)
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
STALE_FAILURE_WINDOW_SECONDS="${COAGENTHUB_STALE_FAILURE_WINDOW_SECONDS:-86400}"
STALE_STALL_MAX_ROUNDS="${COAGENTHUB_STALE_STALL_MAX_ROUNDS:-3}"
STALL_STATE_FILE="${COAGENTHUB_STALL_STATE_FILE:-/tmp/coagenthub-watchdog-stall-state}"
STALL_GROUP_ID="${COAGENTHUB_STALL_GROUP_ID:-}"
AUTO_REBUILD_STATE_FILE="${COAGENTHUB_AUTO_REBUILD_STATE:-/tmp/coagenthub-watchdog-auto-rebuild-state}"
PROD_SCRIPT="${COAGENTHUB_PROD_SCRIPT:-$SCRIPT_DIR/coagenthub-prod.sh}"
RESTART_SLEEP="${COAGENTHUB_RESTART_SLEEP:-3}"
PAGE_LIMIT="${COAGENTHUB_PAGE_LIMIT:-100}"

# cron 环境 PATH 很精简,这里兜底补全(node/pnpm 由 prod 脚本内部再补)
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:$PATH"

# 看门狗的参与者身份(群消息发送方)。全信模型下只声明身份不校验 token,
# 但目标群会做成员资格校验:非成员发送会被拒。默认读本机执行器身份
# (~/.coagenthub/participant-id);发送失败只记日志,不停机 —— 升级事实
# 仍由日志与 /api/system/health 的 staleStall 承载。
WATCHDOG_PARTICIPANT_ID="${COAGENTHUB_PARTICIPANT_ID:-}"
if [ -z "$WATCHDOG_PARTICIPANT_ID" ] && [ -f "$HOME/.coagenthub/participant-id" ]; then
  WATCHDOG_PARTICIPANT_ID="$(tr -d '[:space:]' < "$HOME/.coagenthub/participant-id" 2>/dev/null || true)"
fi

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

# ---------- R3 失败退避(滚动时间窗) ----------
# 文件格式:每行一个 epoch 秒(最近一次失败的墙钟时刻)。仅统计窗口内的失败:
# 窗口外的旧行每次读时自动淘汰(防抖的本意是「短时间内反复失败」,跨天的
# 孤立失败不应永久累积 —— spec 洞 2)。
# 旧格式兼容:单行数字 N(2026-09-05 前的计数文件)→ 迁移为 N 条「现在」的失败。
# 判据指名(ADR-0009):①时间戳行代替裸计数——裸计数拿「总失败次数」代替
# 「近期失败密度」;②当失败间隔超过窗口长度时替代不成立(旧失败对当前自愈
# 决策已无防抖意义),故按窗口淘汰是正确语义而非信息丢失。
stale_fail_count() {
  [ -f "$STALE_FAILURE_FILE" ] || { echo 0; return; }
  local now content line migrated="" n kept=""
  now="$(date +%s)"
  content="$(cat "$STALE_FAILURE_FILE")"
  # 旧格式迁移:单行数字 N(2026-09-05 前「echo N > 文件」的计数,可能带/不带
  # 尾换行)→ N 条「现在」的失败。10 位 epoch 行长度 ≥10,不会被误迁移。
  case "$content" in
    ''|*[!0-9]*) ;;
    *)
      if [ "${#content}" -lt 10 ]; then
        n="$content"
        for _ in $(seq 1 "${n:-0}"); do migrated="${migrated}${now}
"; done
        printf '%s' "$migrated" > "$STALE_FAILURE_FILE"
        content="$migrated"
      fi ;;
  esac
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|*[!0-9]*) continue ;;  # 空行/脏数据丢弃
    esac
    if [ "$line" -ge $((now - STALE_FAILURE_WINDOW_SECONDS)) ]; then
      kept="${kept}${line}
"
    fi
  done <<< "$content"
  if [ -n "$kept" ]; then
    printf '%s' "$kept" > "$STALE_FAILURE_FILE"
    printf '%s' "$kept" | grep -c .
  else
    rm -f "$STALE_FAILURE_FILE"
    echo 0
  fi
}
stale_fail_inc() {
  printf '%s\n' "$(date +%s)" >> "$STALE_FAILURE_FILE"
}
stale_fail_reset() {
  rm -f "$STALE_FAILURE_FILE"
}

# ---------- R2 停滞状态(在途任务阻塞处理陈旧) ----------
# 单行 JSON:{"stalledRounds":N,"lastRoundAt":"ISO","notified":bool}
stall_read() { # 输出 JSON(缺文件输出空)
  cat "$STALL_STATE_FILE" 2>/dev/null || true
}
stall_set_rounds() { # $1=轮数 $2=notified(0/1,落盘为 JSON 布尔)
  local nf
  if [ "$2" = "1" ]; then nf=true; else nf=false; fi
  printf '{"stalledRounds":%s,"lastRoundAt":"%s","notified":%s}\n' \
    "$1" "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$nf" > "$STALL_STATE_FILE"
}
stall_reset() {
  rm -f "$STALL_STATE_FILE"
}
# 取收件群 id:STALL_GROUP_ID 优先;否则枚举本机身份所在的第一个群
# (?participantId= 过滤),保证发送者一定是成员(群消息有成员资格校验)。
# 无身份/无群/读取失败 → 返回空(调用方退化为只记 WARN 日志)。
stall_group_id() {
  [ -n "$STALL_GROUP_ID" ] && { printf '%s' "$STALL_GROUP_ID"; return; }
  [ -n "$WATCHDOG_PARTICIPANT_ID" ] || return 0
  [ "$HAVE_NODE" = 1 ] || return 0
  local pid="$WATCHDOG_PARTICIPANT_ID"
  curl -sf -m 5 "$TASKS_API_URL/groups?limit=1&offset=0&participantId=$pid" 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(s);
        const items = Array.isArray(j.items) ? j.items : (Array.isArray(j) ? j : []);
        const id = items[0] && items[0].id;
        if (id) console.log(id);
      } catch {}
    });
  ' 2>/dev/null || true
}

# 停滞升级:达阈值且未通知过 → 记 WARN + 向群发消息(群消息是 R2 要求的
# 群内可见通道;发失败不阻塞,事实仍留在日志/状态文件/健康接口)
stall_notify() { # $1=陈旧原因 $2=轮数
  local gid
  gid="$(stall_group_id)"
  local msg
  msg="$(printf 'WARN 看门狗:%s 运行时尚未恢复,已连续 %s 轮被在途任务阻塞自动处理(在途保护优先)。请人工确认在途任务后执行 scripts/coagenthub-prod.sh restart 解除。' "$1" "$2")"
  if [ -n "$gid" ] && [ "$HAVE_NODE" = 1 ]; then
    # 带看门狗自身的参与者身份声明(全信模型:只声明不校验;群成员资格
    # 仍由 server 校验,非成员发送会被拒 → 落入 || true 的日志兜底)
    local -a hdrs=(-H 'Content-Type: application/json')
    [ -n "$WATCHDOG_PARTICIPANT_ID" ] && hdrs+=(-H "X-Participant-Id: $WATCHDOG_PARTICIPANT_ID")
    local payload
    payload="$(printf '{"audience":"broadcast","body":"%s"}' "$msg" | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d));
      process.stdin.on("end", () => {
        try { console.log(JSON.stringify(JSON.parse(s))); }
        catch { process.exit(2); }
      });
    ')" || payload=""
    if [ -n "$payload" ]; then
      curl -sf -m 5 -X POST "${hdrs[@]}" "$TASKS_API_URL/groups/$gid/messages" \
        -d "$payload" >/dev/null 2>&1 \
        || echo "$(date '+%F %T') WARN 停滞群消息发送失败(群 $gid,身份 ${WATCHDOG_PARTICIPANT_ID:-<无>}),事实见日志与 /api/system/health staleStall" >> "$WATCHDOG_LOG"
    fi
  fi
}

# ---------- R4 自动重建停用事实(供 /api/system/health 透出) ----------
# 单行 JSON:{"disabled":true,"disabledAt":"ISO","reason":"..."}。
# server 侧只读此文件透传,watchdog 是唯一写者 → 同一事实只有一个判定出处。
rebuild_disable_state() { # $1=原因
  printf '{"disabled":true,"disabledAt":"%s","reason":"%s"}\n' \
    "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$1" > "$AUTO_REBUILD_STATE_FILE"
}
rebuild_clear_state() {
  rm -f "$AUTO_REBUILD_STATE_FILE"
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

  # R1:陈旧路径,按 staleReason 分两支,共用同一套在途保护 + 失败退避守卫。
  #   build/both → restart --build(需要重建);
  #   process    → restart(不重建:entry 比进程启动新,重启即可 —— spec R1)。
  if [ -z "$failed" ] && { [ "$reason" = "build" ] || [ "$reason" = "both" ] || [ "$reason" = "process" ]; }; then
    # R4:在途任务保护(fail-closed)。完整枚举所有群及其任务确认无 running/queued;
    # 任一环节无法确认「无在途」→ 本轮跳过处理。spec R1 明确:不得放松该守卫。
    check_in_flight
    if [ "$TASK_CHECK" != "clear" ]; then
      # R2:连续 N 轮被阻塞 → WARN 升级(群消息 + 日志),不再重复刷 INFO
      local stall_state rounds notified
      stall_state="$(stall_read)"
      if [ -n "$stall_state" ] && [ "$HAVE_NODE" = 1 ]; then
        rounds="$(printf '%s' "$stall_state" | node -e '
          let s = "";
          process.stdin.on("data", (d) => (s += d));
          process.stdin.on("end", () => {
            try { const j = JSON.parse(s); process.stdout.write(String(j.stalledRounds | 0 || 0)); }
            catch { process.stdout.write("0"); }
          });
        ')"
        notified="$(printf '%s' "$stall_state" | node -e '
          let s = "";
          process.stdin.on("data", (d) => (s += d));
          process.stdin.on("end", () => {
            try { process.stdout.write(JSON.parse(s).notified ? "1" : "0"); }
            catch { process.stdout.write("0"); }
          });
        ')"
      else
        rounds=0
        notified=0
      fi
      rounds=$((rounds + 1))
      if [ "$rounds" -ge "$STALE_STALL_MAX_ROUNDS" ]; then
        # 达阈值:首次记 WARN + 群消息(升级只发生一次)。此后每轮不再重复
        # 记录同一行 —— 持续事实由状态文件承载,/api/system/health 的
        # staleStall.stalledRounds 逐轮递增即为可见通道(spec R2)。
        if [ "$notified" != "1" ]; then
          echo "$(date '+%F %T') WARN staleReason=$reason 连续 $rounds 轮无法处理(在途任务阻塞),已升级告警并向任务群通知(此后每轮不再重复记录,持续事实见 /api/system/health staleStall)" >> "$WATCHDOG_LOG"
          stall_notify "$reason" "$rounds"
        fi
        stall_set_rounds "$rounds" 1
      else
        echo "$(date '+%F %T') INFO staleReason=$reason 本轮未处理(连续 $rounds 轮,阈值 $STALE_STALL_MAX_ROUNDS)" >> "$WATCHDOG_LOG"
        stall_set_rounds "$rounds" "$notified"
      fi
      return 0
    fi
    # 在途已清空/本轮可处理:停滞计数清零(陈旧处理不再受阻)
    stall_reset
    # R3:失败退避(滚动时间窗)。窗口内失败达阈值 → 停用自动处理,并显性化(R4);
    # 停用后每次巡检重算窗口,窗口过期自动恢复尝试 —— 无需人工删文件。
    local n
    n="$(stale_fail_count)"
    if [ "$n" -ge "$STALE_MAX_FAILURES" ]; then
      rebuild_disable_state "窗口 ${STALE_FAILURE_WINDOW_SECONDS}s 内失败 $n 次(≥$STALE_MAX_FAILURES)"
      echo "$(date '+%F %T') SKIP 窗口内失败 $n 次(≥$STALE_MAX_FAILURES),自动重建已停用;/api/system/health 可见,窗口过期后自动恢复" >> "$WATCHDOG_LOG"
      return 0
    fi
    local action args_label
    if [ "$reason" = "process" ]; then
      action="restart"
      args_label="restart(不重建,重启即可)"
    else
      action="restart --build"
      args_label="restart --build"
    fi
    echo "$(date '+%F %T') WARN 运行陈旧 (staleReason=$reason),尝试 prod $args_label" >> "$WATCHDOG_LOG"
    # R2:restart 的退出码仅作日志佐证,不作为成功/失败判定依据——
    # 即便退出码非零,只要重启后复核 /api/health 显示 stale=false(fresh)即视为成功。
    # 只有「复核仍陈旧,或健康响应不可验证(unknown)」,才以复核为准累加退避。
    # 这避免了「重建实际成功但脚本退出码非零 → 误累加退避 → 永不归零」的高危闭环。
    local rc=0
    if [ "$reason" = "process" ]; then
      "$PROD_SCRIPT" restart >/dev/null 2>&1 || rc=$?
    else
      "$PROD_SCRIPT" restart --build >/dev/null 2>&1 || rc=$?
    fi
    sleep "$RESTART_SLEEP"
    local post
    post="$(read_runtime)"
    if [ "$post" = "fresh" ]; then
      stale_fail_reset
      rebuild_clear_state
      local note=""
      [ "$rc" != 0 ] && note=" ($action 退出码=$rc,以复核 stale=false 为准)"
      echo "$(date '+%F %T') OK   $action 成功,复核 /api/health stale=false,失败计数已归零,停用状态已清除$note" >> "$WATCHDOG_LOG"
      return 0
    fi
    stale_fail_inc
    local tail=""
    [ "$rc" != 0 ] && tail=" ($action 退出码=$rc)"
    echo "$(date '+%F %T') FAIL 复核 /api/health 仍陈旧或不可验证(stale状态=$post)$tail,计为失败进入退避(窗口内 $(stale_fail_count) 次)" >> "$WATCHDOG_LOG"
    return 1
  fi

  # 原有不健康路径:不带 --build,保持现状(进程挂掉时重新构建只会拖慢恢复)
  if [ -z "$failed" ]; then
    # 运行时健康且新鲜:陈旧已解除(无论本脚本还是人工处理)→ 停滞计数清零,
    # /api/system/health 的 staleStall 随之复位。不清零的后果:陈旧被处理后
    # 停滞计数归零无从谈起,陈旧再次出现时「连续 N 轮」被人工处理的间隙打碎,
    # R2 升级永不触发(2026-09 R2 回归)。
    stall_reset
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
