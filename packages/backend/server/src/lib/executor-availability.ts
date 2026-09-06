import type { task as taskTable } from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import { findExecutorByParticipant } from "@server/lib/executors";
import { arrayContains } from "drizzle-orm";
import {
  cooldownEndMs,
  executorCooldownRecords,
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

/**
 * R1 单条执行器权威可用性的返回形状(GET /api/executors 每条恒含四字段)。
 * R3(specs/quota-misclassified-from-coordinator-narration.md)新增 cooldownSource:
 * 冷却中恒为 "parsed"(恢复时刻来自提供方输出解析)或 "fallback"(平台估算
 * 固定冷却);非冷却恒为 null —— 调用方可用它区分「执行器告知的恢复时刻」
 * 与「平台估算」,不再从 unavailableReason 文案里猜。
 */
export interface ExecutorAvailability {
  available: boolean;
  unavailableReason: string | null;
  cooldownEndMs: number | null;
  cooldownSource: "parsed" | "fallback" | null;
}

/**
 * 冷却不可用文案(单一权威出处:judgeTwoPartyDegradation 与 executorAvailability
 * 共用)。R3:按冷却来源区分 —— parsed=执行器告知(提供方输出的可解析恢复
 * 时刻),fallback=平台估算(未解析到恢复时刻)。来源判定唯一出处是
 * executorCooldownRecords(enterCooldown 写入);无记录(测试直接登记内存表)
 * 按 fallback 处理。
 */
function cooldownUnavailableReason(ex: { key: string }): string {
  const eta = formatEta(cooldownEndMs(ex));
  return executorCooldownRecords.get(ex.key)?.source === "parsed"
    ? `额度冷却至 ${eta}(执行器告知的恢复时刻)`
    : `额度冷却至 ${eta}(平台估算,未解析到恢复时刻)`;
}

/** running 占用不可用文案(单一权威出处:并发饱和与既有 running 判定共用)。 */
const RUNNING_TASK_UNAVAILABLE_REASON = "正在运行任务";

const consecutiveZeroOutput = new Map<string, number>();
const ZERO_OUTPUT_UNAVAILABLE_REASON = "连续零产出,疑似 provider 拒绝";

/** Record the single executor-level fact used by both the queue and GET /executors. */
export function recordExecutorOutput(key: string, zeroOutput: boolean): number {
  const next = zeroOutput ? (consecutiveZeroOutput.get(key) ?? 0) + 1 : 0;
  if (next === 0) consecutiveZeroOutput.delete(key);
  else consecutiveZeroOutput.set(key, next);
  return next;
}

/** Test/process reset; the durable task diffSummary remains the audit trail. */
export function resetExecutorOutputRecords(): void {
  consecutiveZeroOutput.clear();
}

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
  zeroOutputCount?: number;
}): ExecutorAvailability {
  if (isInCooldown(ex)) {
    return {
      available: false,
      unavailableReason: cooldownUnavailableReason(ex),
      cooldownEndMs: cooldownEndMs(ex),
      cooldownSource: executorCooldownRecords.get(ex.key)?.source ?? "fallback",
    };
  }
  const cap = ex.maxConcurrency ?? Number.POSITIVE_INFINITY;
  if (runningExecutorCount(ex.key) >= cap) {
    return {
      available: false,
      unavailableReason: RUNNING_TASK_UNAVAILABLE_REASON,
      cooldownEndMs: null,
      cooldownSource: null,
    };
  }
  if (
    Math.max(consecutiveZeroOutput.get(ex.key) ?? 0, ex.zeroOutputCount ?? 0) >=
    2
  ) {
    return {
      available: true,
      unavailableReason: ZERO_OUTPUT_UNAVAILABLE_REASON,
      cooldownEndMs: null,
      cooldownSource: null,
    };
  }
  return {
    available: true,
    unavailableReason: null,
    cooldownEndMs: null,
    cooldownSource: null,
  };
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
