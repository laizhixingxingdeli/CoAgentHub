import {
  type CoordinationActivityAudit,
  type DispatchTargetAudit,
  groupMessage as groupMessageTable,
  participant as participantTable,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import { and, asc, count, eq, gte, lte } from "drizzle-orm";

const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled"]);

/**
 * Record only facts the platform can observe about a coordinator task. The
 * result is nested in the existing dispatch_audit JSON so target auditing and
 * coordination activity remain one task-addressable audit record.
 */
export async function recordCoordinationActivity(
  db: DataBase,
  task: typeof taskTable.$inferSelect,
): Promise<CoordinationActivityAudit | null> {
  const membership = await db.query.groupMember.findFirst({
    where: (t, { and: andFn, eq: eqFn }) =>
      andFn(
        eqFn(t.groupId, task.groupId),
        eqFn(t.participantId, task.executorParticipantId),
      ),
    columns: { roles: true },
  });
  if (!membership?.roles.includes("coordinator")) return null;

  const endedAt = new Date();
  const children = await db
    .select({
      taskId: taskTable.id,
      participantId: taskTable.executorParticipantId,
      participantName: participantTable.name,
    })
    .from(taskTable)
    .innerJoin(
      participantTable,
      eq(participantTable.id, taskTable.executorParticipantId),
    )
    .where(eq(taskTable.parentTaskId, task.id))
    .orderBy(asc(taskTable.createdAt));
  const [messageCountRow] = await db
    .select({ count: count() })
    .from(groupMessageTable)
    .where(
      and(
        eq(groupMessageTable.groupId, task.groupId),
        eq(groupMessageTable.senderId, task.executorParticipantId),
        gte(groupMessageTable.createdAt, task.createdAt),
        lte(groupMessageTable.createdAt, endedAt),
      ),
    );

  const activity: CoordinationActivityAudit = {
    startedAt: task.createdAt.toISOString(),
    endedAt: endedAt.toISOString(),
    childTaskCount: children.length,
    childTaskTargets: children,
    messageCount: Number(messageCountRow?.count ?? 0),
  };
  const dispatchAudit =
    (task.dispatchAudit as DispatchTargetAudit | null) ?? {};
  await db
    .update(taskTable)
    .set({
      dispatchAudit: {
        ...dispatchAudit,
        coordinationActivity: activity,
      } as DispatchTargetAudit,
    })
    .where(and(eq(taskTable.id, task.id), eq(taskTable.groupId, task.groupId)));
  return activity;
}

export function isTerminalTaskStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}
