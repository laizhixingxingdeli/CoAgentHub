import { task as taskTable } from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import { eq } from "drizzle-orm";

export const EXECUTOR_COOLDOWN_END_MS_FIELD = "executorCooldownEndMs";

type Task = typeof taskTable.$inferSelect;

export interface PersistedExecutorCooldown {
  taskId: string;
  executorKey: string;
  endMs: number;
}

function asDiffSummary(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Read task-backed cooldown records newest first. A quota-failed task is the
 * existing durable record for the event, so no executor configuration field or
 * additional table is needed.
 */
export async function listPersistedExecutorCooldowns(
  db: DataBase,
): Promise<PersistedExecutorCooldown[]> {
  const rows = await db.query.task.findMany({
    where: (task, { isNotNull }) => isNotNull(task.diffSummary),
    columns: {
      id: true,
      executorKey: true,
      diffSummary: true,
    },
    orderBy: (task, { desc }) => [desc(task.createdAt)],
  });

  const records: PersistedExecutorCooldown[] = [];
  for (const row of rows) {
    if (!row.executorKey) continue;
    const diffSummary = asDiffSummary(row.diffSummary);
    if (!diffSummary) continue;
    const endMs = diffSummary[EXECUTOR_COOLDOWN_END_MS_FIELD];
    if (typeof endMs !== "number" || !Number.isFinite(endMs)) continue;
    records.push({ taskId: row.id, executorKey: row.executorKey, endMs });
  }
  return records;
}

/** Remove only the operational cooldown marker; preserve the task's report. */
export async function clearPersistedExecutorCooldown(
  db: DataBase,
  taskId: Task["id"],
): Promise<void> {
  const row = await db.query.task.findFirst({
    where: (task, { eq }) => eq(task.id, taskId),
    columns: { diffSummary: true },
  });
  const diffSummary = asDiffSummary(row?.diffSummary);
  if (!diffSummary || !(EXECUTOR_COOLDOWN_END_MS_FIELD in diffSummary)) return;

  const remaining = { ...diffSummary };
  delete remaining[EXECUTOR_COOLDOWN_END_MS_FIELD];
  await db
    .update(taskTable)
    .set({ diffSummary: remaining })
    .where(eq(taskTable.id, taskId));
}
