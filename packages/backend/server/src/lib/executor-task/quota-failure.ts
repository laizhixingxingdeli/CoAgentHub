import { task as taskTable } from "@laizhixingxingdeli/database/schema";
import { parseRateLimitRecoveryMs } from "@server/lib/executors";
import { and, eq } from "drizzle-orm";
import { endAttempt } from "./attempt-accounting";
import {
  enterCooldown,
  MIN_EFFECTIVE_COOLDOWN_MS,
  normalizeCooldownEnd,
} from "./cooldown";
import { EXECUTOR_COOLDOWN_END_MS_FIELD } from "./cooldown-store";
import { applyDiffSummaryPatch } from "./diff-summary";
import { failTask, handleFailure, isTransientQuota } from "./failure";
import { postStatus } from "./notify";
import { requestPump } from "./pump-signal";
import {
  clearRunTimers,
  formatEta,
  getRateLimitCooldownMs,
  getTransientQuotaPolicy,
  groupQueues,
  type QuotaFailureVerdict,
  trackScheduledPumpTimer,
  untrackScheduledPumpTimer,
} from "./state";
import { writeTaskStatus } from "./task-transitions";
import type { QueuedRun } from "./types";

/** 403 后重试最小退避(ms):无既有 running 任务(外部会话占用)时防空转热循环。 */
const CONCURRENCY_RETRY_BACKOFF_MS = 3_000;

/**
 * 额度失败分流(spec transient-ratelimit-escalated-to-long-cooldown R2):
 *  - `transient` → per-run 退避重排队(不进执行器级冷却,任务不判 failed);
 *  - `exhausted`(或未启用瞬时处置)→ 既有额度失败出口(逐字不变)。
 *
 * 进程退出(exit≠0)与成功尾部(exit 0)两处共用本出口;超时分支单独保留
 * 全量输出解析(历史行为,不在本 spec 改动范围),但共享 isTransientQuota 判定,
 * 三处口径一致(验收 7)。
 */
export async function routeQuotaFailure(
  run: QueuedRun,
  reasonLabel: string,
  tail: string,
  verdict: QuotaFailureVerdict,
): Promise<void> {
  if (isTransientQuota(verdict)) {
    await handleTransientQuotaBackoff(
      run,
      reasonLabel,
      tail,
      verdict.matchedLine,
    );
    return;
  }
  await handleQuotaFailure(run, reasonLabel, tail, verdict.matchedLine);
}

/**
 * 瞬时限流的 per-run 退避处置(spec R2):供应方只要求短暂退避,执行器没坏,
 * 因此**不调 enterCooldown**(`isInCooldown` 保持「额度耗尽」单一语义,R2 豁免
 * 判据 mayQueuedChildExecutorStart 因此不必改动),任务也不判 failed ——
 * 回写 queued 并重新入队,退避窗口过后由定时器泵送自动重试(不消耗重试次数)。
 *
 * 连续瞬时限流达上限 → 升级为 exhausted 处理(防退避死循环);配置不可用
 * (fail-safe)→ 同样走 exhausted。
 */
export async function handleTransientQuotaBackoff(
  run: QueuedRun,
  reasonLabel: string,
  tail: string,
  matchedLine: string | null,
): Promise<void> {
  const policy = getTransientQuotaPolicy();
  if (!policy) {
    await handleQuotaFailure(run, reasonLabel, tail, matchedLine);
    return;
  }
  run.transientQuotaCount += 1;
  if (run.transientQuotaCount >= policy.escalationLimit) {
    console.warn(
      `[executor] 连续瞬时限流达 ${run.transientQuotaCount} 次(上限 ${policy.escalationLimit}),升级为额度耗尽处理: ${run.taskId}`,
    );
    await handleQuotaFailure(
      run,
      `${reasonLabel}(连续瞬时限流 ${run.transientQuotaCount} 次,按额度耗尽处理)`,
      tail,
      matchedLine,
    );
    return;
  }
  const seconds = Math.max(1, Math.round(policy.backoffMs / 1_000));
  // 先落退避窗口:退避从「判定那一刻」起算,不被随后的 DB 回写延迟吞掉。
  const retryAt = Date.now() + policy.backoffMs;
  run.concurrencyRetryAt = retryAt;
  await endAttempt(run, {
    status: "failed",
    error: `瞬时限流,${seconds}s 后退避重试`,
  });

  // 运行状态回到 queued(运行中曾置 running):任务不判 failed,退避后重试。
  // requeueRaceLost:writeTaskStatus 返回 null(竞态)与 catch 异常分开处理。
  let requeueRaceLost = false;
  try {
    const curTransient = await run.db.query.task.findFirst({
      where: and(
        eq(taskTable.id, run.taskId),
        eq(taskTable.groupId, run.groupId),
      ),
      columns: { diffSummary: true },
    });
    const transientNext = applyDiffSummaryPatch(curTransient?.diffSummary, {
      waiting: `执行器瞬时限流,${seconds}s 后退避重试`,
      // R4 留痕:与 quotaMatchedLine 并列,事后可审计分级准确性。
      quotaKind: "transient",
      ...(matchedLine !== null ? { quotaMatchedLine: matchedLine } : {}),
    });
    // 原路径 where 含 groupId;notify 默认 true。
    // 合法前置只有 running(S1 第 2 阶段):停止/超时/孤儿若已先落终态,
    // 不得把任务复活回 queued,也不重新入队或发退避消息。
    const requeued = await writeTaskStatus(run.db, {
      taskId: run.taskId,
      groupId: run.groupId,
      status: "queued",
      diffSummary: transientNext,
      expectedStatuses: ["running"],
    });
    if (!requeued) {
      requeueRaceLost = true;
    }
  } catch (e) {
    // DB 异常 ≠ 竞态 null:异常保持既有 warn 后继续入队;null 走下方跳过。
    console.warn(`[executor] 瞬时限流回写 queued 失败(${run.taskId}): ${e}`);
  }

  // 不置 concurrencyBlocked —— 那是 403 并发冲突标记,会额外等待同执行器的
  // 其他 running 任务清空,与「退避到点即重试」的语义不同。
  run.stalled = false;
  run.a2aSilenced = false;
  run.runningAt = null;
  run.lastOutputAt = 0;
  run.lastActivityAt = 0;
  run.kill = null;
  clearRunTimers(run);
  const group = groupQueues.get(run.groupKey);
  if (!group) {
    // 组已被清空(测试重置等异常)→ 无法退避重试,按最终失败处理。
    await failTask(
      run.db,
      run.taskId,
      "执行器瞬时限流,但组队列已不可用",
      0,
      { quotaKind: "transient" },
      run.attempts,
    );
    return;
  }
  if (requeueRaceLost) {
    console.log(`[executor] 任务 ${run.taskId} 已被并发改为终态,跳过重排队`);
    return;
  }
  group.queue.push(run);
  await postStatus(
    run.db,
    run.groupId,
    run.participantId,
    run.ex,
    `⏳ [${run.ex.label}] 执行器瞬时限流,任务保持排队,${seconds}s 后自动重试: ${run.summary}`,
  );
  // 退避到期主动泵送(与 403 反应式排队同款兜底):此时 run 已在队首等待。
  // 句柄入 scheduledPumpTimers,测试 teardown 可取消(T3),生产路径语义不变。
  const delay = Math.max(1, retryAt - Date.now());
  const timer = setTimeout(() => {
    untrackScheduledPumpTimer(timer);
    requestPump();
  }, delay);
  trackScheduledPumpTimer(timer);
}

/**
 * 额度/速率限制失败统一出口(票7 + quota-failure-on-clean-exit 规范):冷却该
 * 执行器、不自动重试、❌ 回传注明预计恢复时间。tail 为命中检测与恢复时间解析
 * 所用的输出尾部(与失败回传同界:`lastLinesOf(out, 20)`),reasonLabel 为失败
 * 原因前缀(如 "exit 0" / "exit 2" / "执行超时")。
 *
 * 失败分支(1365)/ 成功路径(本规范)共用本出口,保证额度处理逐条一致;超时分支
 * (1261)单独保留全量输出解析(历史行为,不在本规范改动范围)。
 */
async function handleQuotaFailure(
  run: QueuedRun,
  reasonLabel: string,
  tail: string,
  matchedLine: string | null,
): Promise<void> {
  // 冷却动态化:优先从失败输出解析恢复时间,解析失败回退固定冷却。
  // R7:解析出的时刻不在未来或过于接近当前时,回退到固定冷却兜底。
  const parsedMs = parseRateLimitRecoveryMs(tail);
  const cooldownEnd = normalizeCooldownEnd(
    parsedMs ?? Date.now() + getRateLimitCooldownMs(),
  );
  const eta = formatEta(cooldownEnd);
  const extra: Record<string, unknown> = {
    [EXECUTOR_COOLDOWN_END_MS_FIELD]: cooldownEnd,
    executorCooldownSource:
      parsedMs !== null && parsedMs > Date.now() + MIN_EFFECTIVE_COOLDOWN_MS
        ? "parsed"
        : "fallback",
    // 额度分级留痕(spec transient-ratelimit-… R4):本出口只处理 exhausted,
    // 与 transient 的 per-run 退避留痕并列,事后可审计分级准确性。
    quotaKind: "exhausted",
    // 伪额度回显修复 R5:记录命中的原始行(截断),便于人判断是真实额度还是
    // 源码/任务书回显造成的伪命中。
    ...(matchedLine !== null ? { quotaMatchedLine: matchedLine } : {}),
  };
  if (parsedMs !== null && parsedMs <= Date.now() + MIN_EFFECTIVE_COOLDOWN_MS) {
    extra.cooldownFallbackReason = "解析所得时刻不可用,已回退固定冷却";
    extra.discardedCooldownEndMs = parsedMs;
  }
  await handleFailure(run, `${reasonLabel}(执行器额度限制,预计 ${eta} 恢复)`, {
    retryable: false,
    message: `❌ [${run.ex.label}] 任务失败 (执行器额度限制,预计 ${eta} 恢复)\n${tail}`,
    extra,
    afterPersisted: () =>
      enterCooldown(
        run.ex,
        cooldownEnd,
        parsedMs !== null && parsedMs > Date.now() + MIN_EFFECTIVE_COOLDOWN_MS
          ? "parsed"
          : "fallback",
        { db: run.db, taskId: run.taskId },
      ),
  });
}

/**
 * 反应式排队(403 后排队,设计修正):执行器返回 `403
 * atomgit_session_concurrency_conflict` → 不判任务失败:
 *  - 本次 attempt 结束(原因记 concurrency-conflict,不计入 retry_count,
 *    不触发失败重试的回滚/❌/↻ 流程);
 *  - DB 状态回写 queued(运行中曾置 running)+ WS 推送;
 *  - 重置运行态并重新入队(队尾,FIFO 不变),置 concurrencyBlocked:泵送在
 *    既有同执行器 running 任务终态前不再派发本任务;
 *  - 无既有 running 任务(外部会话占用)→ 退避窗口(concurrencyRetryAt)后由
 *    定时器泵送重试,防空转热循环。
 * 可并发执行器(无 maxConcurrency)首次尝试即可能触发本路径;显式 maxConcurrency
 * 的执行器由 isRunDispatchable 直接排队,正常情况下不会收到 403。
 */
export async function handleConcurrencyConflict(run: QueuedRun): Promise<void> {
  const { db, groupId, taskId, ex } = run;
  // 本次 attempt 结束(重试会由下一次 spawn 的 beginAttempt 续新条)。
  await endAttempt(run, { status: "failed", error: "concurrency-conflict" });

  // 保持 queued:回写 DB 状态(运行中曾置 running),并 WS 推送状态变化。
  // 原路径 where 含 groupId;notify 默认 true。
  // 合法前置只有 running(S1 第 2 阶段):终态不得被 403 路径复活回 queued。
  let requeueRaceLost = false;
  try {
    const requeued = await writeTaskStatus(db, {
      taskId,
      groupId,
      status: "queued",
      expectedStatuses: ["running"],
    });
    if (!requeued) {
      requeueRaceLost = true;
    }
  } catch (e) {
    // DB 异常 ≠ 竞态 null:异常保持既有 warn 后继续入队;null 走下方跳过。
    console.warn(`[executor] 403 后回写 queued 失败(${taskId}): ${e}`);
  }

  // 重置运行态并重新入队(队尾);不释放输出缓冲(保留冲突现场供排查)。
  run.concurrencyBlocked = true;
  run.concurrencyRetryAt = Date.now() + CONCURRENCY_RETRY_BACKOFF_MS;
  run.stalled = false;
  run.a2aSilenced = false;
  run.runningAt = null;
  run.lastOutputAt = 0;
  run.lastActivityAt = 0;
  run.kill = null;
  clearRunTimers(run);
  const group = groupQueues.get(run.groupKey);
  if (!group) {
    // 组已被清空(测试重置等异常)→ 无法重排,按最终失败处理(尽力而为)。
    await failTask(
      db,
      taskId,
      "执行器并发冲突(403),且组队列已不可用",
      0,
      undefined,
      run.attempts,
    );
    return;
  }
  if (requeueRaceLost) {
    console.log(`[executor] 任务 ${taskId} 已被并发改为终态,跳过重排队`);
    return;
  }
  group.queue.push(run);
  await postStatus(
    db,
    groupId,
    run.participantId,
    ex,
    `📋 [${ex.label}] 执行器忙(403 并发冲突),任务保持排队,空闲后自动重试: ${run.summary}`,
  );
  // 退避定时器:无既有 running 任务(外部会话占用)时,退避到期主动泵送重试;
  // 有既有任务时由它们的完成路径(finally → 泵送信号)触发,本定时器仅兜底。
  // 句柄入 scheduledPumpTimers,测试 teardown 可取消(T3),生产路径语义不变。
  const timer = setTimeout(() => {
    untrackScheduledPumpTimer(timer);
    requestPump();
  }, CONCURRENCY_RETRY_BACKOFF_MS);
  trackScheduledPumpTimer(timer);
}
