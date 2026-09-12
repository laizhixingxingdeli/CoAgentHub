import { existsSync } from "node:fs";
import {
  type TaskAttempt,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import {
  findRepoRoot,
  gitExec,
  resetToCheckpoint,
} from "@server/lib/executor-runner";
import { eq } from "drizzle-orm";
import { endAttempt } from "./attempt-accounting";
import { applyDiffSummaryPatch, mergeDiffSummary } from "./diff-summary";
import { postStatus } from "./notify";
import { liveTaskOutputTail, releaseTaskOutput } from "./output-buffer";
import { taskOutputTailLines } from "./report";
import {
  getRetryPolicy,
  getTransientQuotaPolicy,
  groupQueues,
  type QuotaFailureVerdict,
} from "./state";
import { countCommitsAfterCheckpoint, resolveTaskRepo } from "./task-repo";
import { writeTaskStatus } from "./task-transitions";
import {
  type QueuedRun,
  sumAttemptTokenUsage,
  sumAttemptTokenUsageReason,
} from "./types";

/** 直接落库置 failed(server 是状态源;PATCH 端点是给外部执行器客户端的)。
 *  retries > 0 时把重试次数写进 diffSummary(审计/汇报用);extra 合并进
 *  diffSummary(结果未确认等附加标记,如 { unconfirmed: true })。running 任务
 *  存在输出缓冲时,把最近 500 行写进 diffSummary.outputTail(完成回填,之后
 *  不依赖内存也能看;无缓冲(未 spawn 的失败)则不加)。 */
export async function failTask(
  db: DataBase,
  taskId: string,
  reason: string,
  retries = 0,
  extra?: Record<string, unknown>,
  attempts?: TaskAttempt[],
): Promise<void> {
  const patch: Record<string, unknown> = { error: reason, ...extra };
  if (retries > 0) patch.retries = retries;
  const tokenUsage = attempts ? sumAttemptTokenUsage(attempts) : undefined;
  if (tokenUsage !== undefined) patch.tokenUsage = tokenUsage;
  const tokenUsageReason = attempts
    ? sumAttemptTokenUsageReason(attempts)
    : undefined;
  if (tokenUsageReason) patch.tokenUsageReason = tokenUsageReason;
  const tail = taskOutputTailLines(taskId);
  if (tail) patch.outputTail = tail;
  const liveTail = liveTaskOutputTail(taskId);
  if (liveTail) patch.liveOutputTail = liveTail;
  const cur = await db.query.task.findFirst({
    where: eq(taskTable.id, taskId),
    columns: { diffSummary: true },
  });
  const diffSummary = applyDiffSummaryPatch(cur?.diffSummary, patch);
  // 原路径 where 仅 id(无 groupId);notify 默认 true。
  await writeTaskStatus(db, {
    taskId,
    status: "failed",
    diffSummary,
  });
}

/**
 * 是否走瞬时限流处置:分级由 classifyQuotaFailure 单点给出,这里只判「是否
 * 启用」—— 未配置瞬时退避时回落 exhausted 语义(fail-safe:宁可长冷却也不要
 * 无限退避)。三处额度调用点共用本判定。
 */
export function isTransientQuota(verdict: QuotaFailureVerdict): boolean {
  return verdict.kind === "transient" && getTransientQuotaPolicy() !== null;
}

/**
 * 失败统一出口(重试判定):任务失败(exit≠0 / 超时 / 静默)且 retryCount <
 * maxRetries 且可重试时 → 回滚 checkpoint(resetWorkspace)→ retry_count+1 →
 * 回传 ❌(首次失败)+ ↻ 重试提示 → 重新入队重跑;否则按最终失败处理(标
 * failed + ❌ 回传)。认领超时 / 手动停止 / 验收失败不重试(调用方传
 * retryable=false 或直接走各自分支)。
 */
export async function handleFailure(
  run: QueuedRun,
  reason: string,
  opts: {
    retryable: boolean;
    message: string;
    extra?: Record<string, unknown>;
    afterPersisted?: () => void;
  },
): Promise<void> {
  const { db, taskId } = run;
  // 非瞬时限流的失败出口:连续瞬时限流计数归零(「连续」而非「累计」)。
  run.transientQuotaCount = 0;
  // 本次 attempt 结束(重试会由下一次 spawn 的 beginAttempt 续新条)。
  await endAttempt(run, { status: "failed", error: reason });
  const canRetry =
    opts.retryable &&
    !run.stopped &&
    run.retryCount < getRetryPolicy().maxRetries;

  if (!canRetry) {
    // 注意顺序:failTask 会回填 outputTail(最近 50 行),必须先取后释放。
    await failTask(
      db,
      taskId,
      reason,
      run.retryCount,
      opts.extra,
      run.attempts,
    );
    opts.afterPersisted?.();
    releaseTaskOutput(taskId);
    await postStatus(db, run.groupId, run.participantId, run.ex, opts.message);
    return;
  }

  // 重试前回滚 checkpoint(resetWorkspace=true 且存在快照):恢复工作树到任务前
  // 状态,避免重试带着首次失败留下的脏改动重跑。a2a 无本地快照直接跳过。回滚
  // 必须在执行前快照所用的仓库(任务书声明的仓库)上进行,与原执行一致。
  // 外来提交防护(spec retry-rollback-must-not-destroy-foreign-commits R1/R2):
  // 硬 reset 前检查 checkpoint 之后是否存在提交;存在 → 跳过回滚但继续重试
  // (降级),留痕并群内说明;干净(0)照常硬 reset;无法判定(null)走既有
  // 「回滚失败 → 终止重试」语义,不静默跳过。
  if (getRetryPolicy().resetWorkspace && run.checkpointRef) {
    const declaredRoot = resolveTaskRepo(run.body, run.projectPath);
    const repoRoot =
      declaredRoot && existsSync(declaredRoot) ? declaredRoot : findRepoRoot();
    const foreignCount = await countCommitsAfterCheckpoint(
      run.checkpointRef,
      repoRoot,
    );
    if (foreignCount !== null && foreignCount > 0) {
      const headRes = await gitExec(["rev-parse", "HEAD"], repoRoot);
      const headAtSkip =
        headRes.status === 0 ? (headRes.stdout ?? "").trim() : "unknown";
      const rollbackSkipped = {
        reason: "checkpoint 之后存在外来提交,跳过回滚保护共享工作树",
        headAtSkip,
        checkpoint: run.checkpointRef,
      };
      try {
        const cur = await db.query.task.findFirst({
          where: eq(taskTable.id, taskId),
          columns: { diffSummary: true },
        });
        const next = mergeDiffSummary(
          cur?.diffSummary,
          { rollbackSkipped },
          "audit",
        );
        await db
          .update(taskTable)
          .set({ diffSummary: next })
          .where(eq(taskTable.id, taskId));
      } catch (e) {
        console.warn(`[executor] 写 rollbackSkipped 留痕失败(${taskId}): ${e}`);
      }
      console.log(
        `[executor] 检测到检查点之后存在外来提交(${foreignCount} 个),跳过回滚保护共享工作树: ${taskId} HEAD=${headAtSkip.slice(0, 12)} checkpoint=${run.checkpointRef}`,
      );
      await postStatus(
        db,
        run.groupId,
        run.participantId,
        run.ex,
        `⚠️ [${run.ex.label}] 检测到检查点之后存在外来提交,已跳过回滚保护共享工作树(HEAD=${headAtSkip.slice(0, 12)} checkpoint=${run.checkpointRef}),将在当前工作树状态上直接重试`,
      );
    } else {
      const res = await resetToCheckpoint(run.checkpointRef, repoRoot);
      if (!res.ok) {
        // 快照回滚失败 → 终止重试,按最终失败处理(保留原始失败原因)。
        const msg = `${reason};回滚失败,终止重试: ${res.message}`;
        console.error(`[executor] 重试前回滚失败(${taskId}): ${res.message}`);
        await failTask(
          db,
          taskId,
          msg,
          run.retryCount,
          undefined,
          run.attempts,
        );
        await postStatus(
          db,
          run.groupId,
          run.participantId,
          run.ex,
          `❌ [${run.ex.label}] 任务失败: ${msg}`,
        );
        return;
      }
      console.log(
        `[executor] 重试前已回滚工作区到 ${run.checkpointRef}(${taskId})`,
      );
    }
  }

  // retry_count+1 并持久化(最终结果仍由重试后的完成路径回传)。
  run.retryCount += 1;
  try {
    await db
      .update(taskTable)
      .set({ retryCount: run.retryCount })
      .where(eq(taskTable.id, taskId));
  } catch (e) {
    console.warn(`[executor] 写 retry_count 失败(${taskId}): ${e}`);
  }

  // 首次失败 ❌ + 补发 ↻ 重试提示;最终 ✅/❌ 由重试的完成路径照常回传。
  await postStatus(db, run.groupId, run.participantId, run.ex, opts.message);
  await postStatus(
    db,
    run.groupId,
    run.participantId,
    run.ex,
    `↻ [${run.ex.label}] 自动重试 (第 ${run.retryCount} 次)`,
  );

  // 重置运行态并重新入队(同组串行,槽位由 runOne 的 finally 释放后 pump 取走;
  // 任务已被认领过,不再设认领超时)。
  run.stalled = false;
  run.runningAt = null;
  run.lastOutputAt = 0;
  run.kill = null;
  const group = groupQueues.get(run.groupKey);
  if (!group) {
    // 组已被清空(测试重置等异常)→ 无法重试,按最终失败处理。
    await failTask(db, taskId, reason, run.retryCount, undefined, run.attempts);
    await postStatus(db, run.groupId, run.participantId, run.ex, opts.message);
    return;
  }
  group.queue.push(run);
}
