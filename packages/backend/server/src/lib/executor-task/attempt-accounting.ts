import {
  type TaskAttempt,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import type { ExecutorRunResult } from "@server/lib/executor-runner";
import { and, eq } from "drizzle-orm";
import { isTerminalTaskStatus } from "../coordination-activity";
import { collectTokenUsage } from "./token-usage";
import {
  asDiffSummaryRecord,
  mergePlatformTokenFields,
  type QueuedRun,
} from "./types";

/* ---------------- 执行历史(attempt 时间线) ---------------- */

/** spawn 执行器前 append 一条 running attempt 并落库(重试 = 多条;不重试也
 *  有一条)。attempts 数组同时保留在 run 上,后续 endAttempt 就地更新。 */
export async function beginAttempt(run: QueuedRun): Promise<void> {
  const attempt: TaskAttempt = {
    n: run.attempts.length + 1,
    startedAt: new Date().toISOString(),
    status: "running",
  };
  run.attempts.push(attempt);
  try {
    await run.db
      .update(taskTable)
      .set({ attempts: run.attempts })
      .where(eq(taskTable.id, run.taskId));
  } catch (e) {
    console.warn(`[executor] 写 attempts 失败(${run.taskId}): ${e}`);
  }
}

export function markAttemptTokenUnavailable(run: QueuedRun): void {
  const last = run.attempts.at(-1);
  if (!last) return;
  last.tokenUsage = null;
  last.tokenUsageReason = "unavailable";
}

export async function collectAttemptTokenUsage(
  run: QueuedRun,
  executorPid: number | undefined,
  cwd: string,
  result: ExecutorRunResult,
): Promise<void> {
  const last = run.attempts.at(-1);
  if (!last) return;
  const collected = await collectTokenUsage({
    executorKey: run.ex.key,
    executorPid,
    taskId: run.taskId,
    cwd,
    startedAt: last.startedAt,
    endedAt: new Date().toISOString(),
    stdout: result.stdout,
  });
  last.tokenUsage = collected.tokenUsage;
  if (collected.reason) last.tokenUsageReason = collected.reason;
  else delete last.tokenUsageReason;
  try {
    await run.db
      .update(taskTable)
      .set({ attempts: run.attempts })
      .where(eq(taskTable.id, run.taskId));
  } catch (e) {
    console.warn(`[executor] 写 token usage 失败(${run.taskId}): ${e}`);
  }
}

/**
 * 续跑任务(及任何由协调者自己在进程内 PATCH 结案的 detached 任务)进程退出后
 * 补写 diffSummary 的 token 字段:结案那一刻 attempts 尚无 tokenUsage(采集只在
 * 进程退出后发生),PATCH 路由的 R1 回填因此落空。进程退出、采集落库后,若任务
 * 已被 PATCH 落终态且 diffSummary 缺这两个键,以与 tasks.ts PATCH R1 同口径补写
 * (mergePlatformTokenFields:undefined 不写;调用方显式提供的键已存在于
 * diffSummary,不覆盖)。
 */
export async function backfillDetachedClosedTokenFields(
  db: DataBase,
  taskId: string,
  groupId: string,
  attempts: readonly TaskAttempt[],
): Promise<void> {
  const row = await db.query.task.findFirst({
    where: (t, { and: andFn, eq: eqFn }) =>
      andFn(eqFn(t.id, taskId), eqFn(t.groupId, groupId)),
    columns: { status: true, diffSummary: true },
  });
  if (!row || !isTerminalTaskStatus(row.status)) return;
  const existing = asDiffSummaryRecord(row.diffSummary);
  if (!existing) return;
  // 引用相等 = 无需补写(键已存在,或 attempts 没采到值)。
  const next = mergePlatformTokenFields(existing, { attempts });
  if (next === existing) return;
  await db
    .update(taskTable)
    .set({ diffSummary: next })
    .where(and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)));
}

/** 任务终态时更新最后一条 attempt(endedAt/status/error/summary/hash/tokenUsage)并落库。 */
export async function endAttempt(
  run: QueuedRun,
  patch: Partial<
    Pick<TaskAttempt, "status" | "error" | "summary" | "hash" | "tokenUsage">
  >,
): Promise<void> {
  const last = run.attempts[run.attempts.length - 1];
  if (!last) return;
  Object.assign(last, patch, { endedAt: new Date().toISOString() });
  try {
    await run.db
      .update(taskTable)
      .set({ attempts: run.attempts })
      .where(eq(taskTable.id, run.taskId));
  } catch (e) {
    console.warn(`[executor] 写 attempts 失败(${run.taskId}): ${e}`);
  }
}
