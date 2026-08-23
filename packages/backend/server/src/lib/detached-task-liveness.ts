import type { task as taskTable } from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import { taskOutputUpdatedAt } from "./executor-task/output-buffer";

/** Detached tasks get an early warning well before the 24-hour timeout. */
export const DETACHED_LIVENESS_THRESHOLD_MS = 30 * 60 * 1000;

const DETACHED_REPLY_MODE_RE = /^\s*##\s*replymode\s*:\s*detached\s*$/im;

export interface DetachedTaskLiveness {
  livenessWarning: boolean;
  lastSignalAt: string | null;
}

type Task = typeof taskTable.$inferSelect;

/**
 * Detached is a task property derived from the same two rules used by the
 * executor queue: an explicit ReplyMode marker or a coordinator target.
 */
export async function isDetachedTask(
  db: DataBase,
  task: Task,
): Promise<boolean> {
  if (task.brief && DETACHED_REPLY_MODE_RE.test(task.brief)) return true;

  const membership = await db.query.groupMember.findFirst({
    where: (t, { and: andFn, eq: eqFn }) =>
      andFn(
        eqFn(t.groupId, task.groupId),
        eqFn(t.participantId, task.executorParticipantId),
      ),
    columns: { roles: true },
  });
  return membership?.roles.includes("coordinator") ?? false;
}

/**
 * Derive detached liveness at read time. The database remains the source of
 * durable signals; output timestamps are process-local because outputTail is
 * process-local as well.
 */
export async function getDetachedTaskLiveness(
  db: DataBase,
  task: Task,
  now = new Date(),
): Promise<DetachedTaskLiveness> {
  if (task.status !== "running" || !(await isDetachedTask(db, task))) {
    return { livenessWarning: false, lastSignalAt: null };
  }

  const latestChild = await db.query.task.findFirst({
    where: (t, { eq: eqFn }) => eqFn(t.parentTaskId, task.id),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    columns: { createdAt: true },
  });
  const signalTimes = [
    task.createdAt,
    task.updatedAt,
    latestChild?.createdAt ?? null,
    taskOutputUpdatedAt(task.id),
  ]
    .filter((value): value is Date | number => value !== null)
    .map((value) => (typeof value === "number" ? value : value.getTime()));
  const lastSignalMs = Math.max(...signalTimes);

  return {
    livenessWarning:
      now.getTime() - lastSignalMs > DETACHED_LIVENESS_THRESHOLD_MS,
    lastSignalAt: new Date(lastSignalMs).toISOString(),
  };
}
