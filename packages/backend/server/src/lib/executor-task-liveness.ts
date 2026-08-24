import type { task as taskTable } from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import { computeLastSignalMs, isDetachedTask } from "./detached-task-liveness";
import { taskOutputUpdatedAt } from "./executor-task/output-buffer";
import { getStallTimeoutMs } from "./executor-task/state";

/** 执行器任务的读时存活判定(specs/executor-task-liveness.md R1)。 */
export interface ExecutorTaskLiveness {
  warning: boolean;
  lastSignalAt: string;
}

type Task = typeof taskTable.$inferSelect;

/**
 * Derive executor-task liveness at read time (specs/executor-task-liveness.md
 * R1/R2/R4/R5): for status=running, non-detached tasks the detail payload
 * carries `liveness` = { warning, lastSignalAt }. The last signal is the max
 * of task.createdAt / task.updatedAt / taskOutputUpdatedAt(task.id) — the same
 * signal-maximum logic as detached tasks, minus the child-task dimension
 * (executor tasks have no children). The threshold reuses stallTimeoutMinutes
 * (no new config); the derivation never mutates task.status and never arms
 * timers, so it survives backend restarts. Returns null when the field must be
 * omitted (non-running or detached task) — mirroring the l1/l3/runtime
 * convention of not emitting empty objects.
 */
export async function getExecutorTaskLiveness(
  db: DataBase,
  task: Task,
  now = new Date(),
): Promise<ExecutorTaskLiveness | null> {
  if (task.status !== "running") return null;
  if (await isDetachedTask(db, task)) return null;

  const lastSignalMs = computeLastSignalMs([
    task.createdAt,
    task.updatedAt,
    taskOutputUpdatedAt(task.id),
  ]);
  return {
    warning: now.getTime() - lastSignalMs > getStallTimeoutMs(),
    lastSignalAt: new Date(lastSignalMs).toISOString(),
  };
}
