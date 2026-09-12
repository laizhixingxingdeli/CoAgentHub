import { task as taskTable } from "@laizhixingxingdeli/database/schema";
import type { ExecutorRunResult } from "@server/lib/executor-runner";
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
import { handleFailure, isTransientQuota } from "./failure";
import { notifyTaskStatusChanged } from "./notify";
import { liveTaskOutputTail, releaseTaskOutput } from "./output-buffer";
import {
  handleConcurrencyConflict,
  handleTransientQuotaBackoff,
  routeQuotaFailure,
} from "./quota-failure";
import { lastLinesOf } from "./report";
import { isConcurrencyConflict } from "./spawn-failure";
import {
  classifyQuotaFailure,
  formatEta,
  getDetachedTimeoutMs,
  getRateLimitCooldownMs,
} from "./state";
import {
  handleDetachedTimeout,
  handleUnconfirmed,
  hasRecentA2AProgress,
} from "./timeout-handlers";
import {
  type QueuedRun,
  sumAttemptTokenUsage,
  sumAttemptTokenUsageReason,
} from "./types";

/**
 * runOne 停止终态(run.stopped)分支体。从 queue.ts 抽出;
 * 调用方必须在 await 后 return。
 */
export async function handleStoppedOutcome(run: QueuedRun): Promise<void> {
  const { db, groupId, taskId } = run;

  console.log(`[executor] 任务已停止: ${taskId}`);
  await endAttempt(run, { status: "cancelled" });
  const liveTail = liveTaskOutputTail(taskId);
  releaseTaskOutput(taskId);
  const tokenUsage = sumAttemptTokenUsage(run.attempts);
  const tokenUsageReason = sumAttemptTokenUsageReason(run.attempts);
  {
    const cur = await db.query.task.findFirst({
      where: and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)),
      columns: { diffSummary: true },
    });
    const nextCancelled = applyDiffSummaryPatch(cur?.diffSummary, {
      error: "stopped",
      ...(tokenUsage !== undefined ? { tokenUsage } : {}),
      ...(tokenUsageReason ? { tokenUsageReason } : {}),
      ...(liveTail ? { liveOutputTail: liveTail } : {}),
    });
    const [cancelled] = await db
      .update(taskTable)
      .set({
        status: "cancelled",
        diffSummary: nextCancelled,
      })
      .where(and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)))
      .returning();
    if (cancelled) {
      await notifyTaskStatusChanged(
        db,
        taskId,
        groupId,
        "cancelled",
        cancelled,
      );
    }
  }
}

/**
 * A2A per-group 记忆回写。不是早退 —— 处理完继续往下走;
 * 调用方不得在 await 后 return。
 */
export async function handleA2aMemoryOutcome(
  run: QueuedRun,
  ctx: { result: ExecutorRunResult },
): Promise<void> {
  const { db, groupId, taskId } = run;
  const { result } = ctx;

  try {
    await db
      .update(taskTable)
      .set({ a2aContextId: result.contextId })
      .where(and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)));
  } catch (e) {
    console.warn(`[executor] 写 a2a_context_id 失败(${taskId}): ${e}`);
  }
}

/**
 * detached 已发送、等待执行器回写终态。调用方必须在 await 后 return。
 */
export async function handleDetachedOutcome(run: QueuedRun): Promise<void> {
  const { taskId } = run;

  console.log(`[executor] detached 任务已发送,等待执行器回写终态: ${taskId}`);
  if (!run.detachedTimer && !run.detachedTimedOut && !run.stopped) {
    run.detachedTimer = setTimeout(
      () => handleDetachedTimeout(run),
      getDetachedTimeoutMs(),
    );
  }
}

/**
 * 静默超时失败。调用方必须在 await 后 return。
 */
export async function handleStalledOutcome(run: QueuedRun): Promise<void> {
  const { taskId, ex } = run;

  console.log(`[executor] 任务已因静默超时失败: ${taskId}`);
  await handleFailure(run, "执行器静默超时", {
    retryable: true,
    message: `❌ [${ex.label}] 任务失败 (执行器静默超时)`,
  });
}

/**
 * A2A 无进展超时失败。调用方必须在 await 后 return。
 */
export async function handleA2aSilencedOutcome(run: QueuedRun): Promise<void> {
  const { taskId, ex } = run;

  console.log(`[executor] 任务已因 A2A 无进展超时失败: ${taskId}`);
  await handleFailure(run, "执行器无进展", {
    retryable: false,
    message: `❌ [${ex.label}] 任务失败 (执行器无进展)`,
  });
}

/**
 * result.timedOut 超时终态。调用方必须在 await 后 return。
 */
export async function handleTimedOutOutcome(
  run: QueuedRun,
  ctx: {
    result: ExecutorRunResult;
    isA2a: boolean;
    getPeerExecutorNames: () => Promise<string[]>;
  },
): Promise<void> {
  const { db, taskId, ex } = run;
  const { result, isA2a, getPeerExecutorNames } = ctx;

  console.error(`[executor] 任务超时: ${taskId}`);
  // 第2层:A2A 请求超时但最近有进展信号 → 执行器可能仍在执行/已完成,
  // 结果无法确认 → 按「结果未确认」处理(不重试,避免重复执行)。
  if (isA2a && hasRecentA2AProgress(run)) {
    await handleUnconfirmed(run);
    return;
  }
  // 超时且已捕获输出(尾部,与失败回传同界)含额度关键词且带正面结构证据
  // (恢复时刻/错误行形状;R1:退出码不是证据)→ 额度失败;R2:点名其它
  // 执行器/引用平台 id 或字段的转述行不算证据。
  const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const timeoutQuota = classifyQuotaFailure([lastLinesOf(out, 20)], {
    taskBook: run.body,
    peerExecutorNames: await getPeerExecutorNames(),
  });
  if (timeoutQuota.isQuota) {
    // 瞬时限流(短相对恢复提示):per-run 退避重试,不进执行器级冷却。
    if (isTransientQuota(timeoutQuota)) {
      await handleTransientQuotaBackoff(
        run,
        "执行超时",
        out,
        timeoutQuota.matchedLine,
      );
      return;
    }
    // 冷却动态化:优先从失败输出解析恢复时间,解析失败回退固定冷却。
    // R7:解析出的时刻不在未来或过于接近当前时,回退到固定冷却兜底。
    const parsedMs = parseRateLimitRecoveryMs(out);
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
      // 与 handleQuotaFailure 出口同口径的额度分级留痕(R4/验收 7)。
      quotaKind: "exhausted",
      quotaMatchedLine: timeoutQuota.matchedLine,
    };
    if (
      parsedMs !== null &&
      parsedMs <= Date.now() + MIN_EFFECTIVE_COOLDOWN_MS
    ) {
      extra.cooldownFallbackReason = "解析所得时刻不可用,已回退固定冷却";
      extra.discardedCooldownEndMs = parsedMs;
    }
    await handleFailure(run, `执行超时(执行器额度限制,预计 ${eta} 恢复)`, {
      retryable: false,
      message: `❌ [${ex.label}] 任务失败 (执行器额度限制,预计 ${eta} 恢复)`,
      extra,
      afterPersisted: () =>
        enterCooldown(
          ex,
          cooldownEnd,
          parsedMs !== null && parsedMs > Date.now() + MIN_EFFECTIVE_COOLDOWN_MS
            ? "parsed"
            : "fallback",
          { db, taskId },
        ),
    });
  } else {
    await handleFailure(run, "执行超时", {
      retryable: true,
      message: `❌ [${ex.label}] 任务失败 (超时)`,
    });
  }
}

/**
 * 非零退出终态(result.code !== 0)分支体。从 queue.ts 抽出;
 * 原分支体末尾无 return(其后 try 结束);内部早退路径自带 return。
 */
export async function handleNonZeroExitOutcome(
  run: QueuedRun,
  ctx: {
    result: ExecutorRunResult;
    output: string;
    isA2a: boolean;
    getPeerExecutorNames: () => Promise<string[]>;
  },
): Promise<void> {
  const { taskId, ex } = run;
  const { result, output, isA2a, getPeerExecutorNames } = ctx;

  // 第2层:无法确认执行结果(gateway「did not reply in time」/ 网络错误 /
  // HTTP 5xx)→ 执行器可能已实际执行,按「结果未确认」处理(不重试、不
  // 回传 ❌)。其余失败保持原重试行为。
  if (result.unconfirmed) {
    console.error(`[executor] 任务结果未确认: ${taskId}`);
    await handleUnconfirmed(run);
    return;
  }
  const tail = lastLinesOf(output, 20).slice(0, 1500);
  console.error(`[executor] 任务失败 exit=${result.code}: ${taskId}`);
  // 执行器并发冲突(设计修正,反应式排队):CLI 返回 `403
  // atomgit_session_concurrency_conflict`(如 AtomCode 的 atomgit session
  // 被其他会话占用)→ 不判失败:任务保持 queued 并重新入队,等既有
  // running 任务终态后自动重试(不消耗重试次数、不回滚工作区)。
  if (!isA2a && isConcurrencyConflict(output)) {
    console.warn(
      `[executor] 执行器并发冲突(403),任务重新排队等待空闲: ${taskId}`,
    );
    await handleConcurrencyConflict(run);
    return;
  }
  // 额度/速率限制失败(票7):失败输出尾部(与失败回传同界)命中额度关键词
  // 且带正面结构证据(R1:恢复时刻/错误行形状,退出码一律不算)→ 归类
  // 「额度失败」,冷却该执行器、不自动重试、❌ 注明预计恢复时间;其余失败
  // 保持原重试行为。限定尾部避免全量输出里的无关 "429/quota" 字样造成误判
  // (误判会停派该执行器整段冷却期);结构证据排除仅回显源码/任务书的伪命中,
  // R2 进一步排除点名其它执行器/平台字段的转述行。
  const failureQuota = classifyQuotaFailure([tail], {
    exitCode: result.code,
    taskBook: run.body,
    peerExecutorNames: await getPeerExecutorNames(),
  });
  if (failureQuota.isQuota) {
    await routeQuotaFailure(run, `exit ${result.code}`, tail, failureQuota);
  } else {
    await handleFailure(run, `exit ${result.code}`, {
      retryable: true,
      message: `❌ [${ex.label}] 任务失败 (exit ${result.code})\n${tail}`,
    });
  }
}
