import type { task as taskTable } from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import { findExecutorByParticipant } from "@server/lib/executors";
import { and, arrayContains, desc, eq } from "drizzle-orm";
import { getExecutorTaskLiveness } from "./executor-task-liveness";
import { cooldownEndMs, formatEta, isInCooldown } from "./executor-task/state";

/** degradedToTwoParty.executors 的单个条目:候选执行器名字 + 不可用原因。 */
export interface DegradedExecutorEntry {
  name: string;
  reason: string;
}

/** R4 平台留痕载荷(specs/dispatching-should-be-the-default.md v1.1)。 */
export interface TwoPartyDegradation {
  /** 平台判定降级并留痕的时刻(ISO)。 */
  at: string;
  /** 当时每个候选执行器的实际状态(name + 不可用原因)。 */
  executors: DegradedExecutorEntry[];
}

type Task = typeof taskTable.$inferSelect;

/**
 * R4 平台判定(specs/dispatching-should-be-the-default.md v1.1):协调任务落终态
 * 且零执行子任务时,协调者相当于兼任执行(降级为两方)。可用性由平台给出——
 * 复用 `executors.ts` 的额度冷却状态与 `executor-task-liveness.ts` 的存活判定,
 * **不采信协调者的断言**(协调者自述「无人可派」不足以触发)。
 *
 * 候选 = 本群 roles 含 `executor` 的成员(排除协调者自己)。任一候选可用
 * (不在冷却、无 running 任务或任务未失联)→ 返回 null(不降级);全部候选不可用
 * → 返回平台写入的 `degradedToTwoParty` 载荷(降级时刻 + 每个候选的 name/reason)。
 */
export async function judgeTwoPartyDegradation(
  db: DataBase,
  task: Task,
  now = new Date(),
): Promise<TwoPartyDegradation | null> {
  const members = await db.query.groupMember.findMany({
    where: (t, { and: andFn, eq: eqFn }) =>
      andFn(
        eqFn(t.groupId, task.groupId),
        arrayContains(t.roles, ["executor"]),
      ),
    columns: { participantId: true },
  });

  const entries: DegradedExecutorEntry[] = [];
  let anyAvailable = false;

  for (const member of members) {
    // 协调者自己不是候选执行器(兼任执行的是它)。
    if (member.participantId === task.executorParticipantId) continue;
    const participant = await db.query.participant.findFirst({
      where: (t, { eq: eqFn }) => eqFn(t.id, member.participantId),
      columns: { name: true, executorKey: true },
    });
    if (!participant) continue;
    const ex = await findExecutorByParticipant(db, participant);
    if (!ex) {
      // 挂了 executor 角色但没有执行器配置 → 收不到下发任务,视为不可用。
      entries.push({ name: participant.name, reason: "未配置执行器" });
      continue;
    }
    if (isInCooldown(ex)) {
      entries.push({
        name: participant.name,
        reason: `额度冷却至 ${formatEta(cooldownEndMs(ex))}`,
      });
      continue;
    }
    const running = await db.query.task.findFirst({
      where: (t, { and: andFn, eq: eqFn }) =>
        andFn(
          eqFn(t.groupId, task.groupId),
          eqFn(t.executorParticipantId, member.participantId),
          eqFn(t.status, "running"),
        ),
      orderBy: (t, { desc: descFn }) => [descFn(t.updatedAt)],
    });
    if (running) {
      const liveness = await getExecutorTaskLiveness(db, running, now);
      entries.push({
        name: participant.name,
        reason: liveness?.warning
          ? "任务失联(静默超时警告)"
          : "正在运行任务",
      });
      continue;
    }
    // 健康、空闲、非自身 → 有可用执行器,不降级。
    anyAvailable = true;
  }

  if (anyAvailable) return null;
  return {
    at: now.toISOString(),
    executors: entries.filter((entry) => entry.reason !== ""),
  };
}
