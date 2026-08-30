import type { task as taskTable } from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import { findExecutorByParticipant } from "@server/lib/executors";
import { and, arrayContains, desc, eq } from "drizzle-orm";
import {
  cooldownEndMs,
  formatEta,
  isInCooldown,
  runningExecutorCount,
} from "./executor-task/state";
import { getExecutorTaskLiveness } from "./executor-task-liveness";

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

/** R1 单条执行器权威可用性的返回形状(GET /api/executors 每条恒含三字段)。 */
export interface ExecutorAvailability {
  available: boolean;
  unavailableReason: string | null;
  cooldownEndMs: number | null;
}

/** 冷却不可用文案(单一权威出处:judgeTwoPartyDegradation 与 executorAvailability 共用)。 */
function cooldownUnavailableReason(ex: { key: string }): string {
  return `额度冷却至 ${formatEta(cooldownEndMs(ex))}`;
}

/** running 占用不可用文案(单一权威出处:并发饱和与既有 running 判定共用)。 */
const RUNNING_TASK_UNAVAILABLE_REASON = "正在运行任务";

/**
 * R1(specs/executor-availability-visibility-and-queued-child-pinning.md):
 * 单条执行器的权威可用性。冷却中 → false / 冷却文案 / cooldownEndMs;并发饱和
 * (runningExecutorCount >= maxConcurrency,与 pumpQueue 的 isRunDispatchable
 * 前两条同口径)→ false / 「正在运行任务」/ null;否则 true / null / null。
 * GET /api/executors 只消费本导出,不在路由里另写判定或文案。
 */
export function executorAvailability(ex: {
  key: string;
  maxConcurrency?: number | null;
}): ExecutorAvailability {
  if (isInCooldown(ex)) {
    return {
      available: false,
      unavailableReason: cooldownUnavailableReason(ex),
      cooldownEndMs: cooldownEndMs(ex),
    };
  }
  const cap = ex.maxConcurrency ?? Number.POSITIVE_INFINITY;
  if (runningExecutorCount(ex.key) >= cap) {
    return {
      available: false,
      unavailableReason: RUNNING_TASK_UNAVAILABLE_REASON,
      cooldownEndMs: null,
    };
  }
  return { available: true, unavailableReason: null, cooldownEndMs: null };
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
        reason: cooldownUnavailableReason(ex),
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
          : RUNNING_TASK_UNAVAILABLE_REASON,
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
