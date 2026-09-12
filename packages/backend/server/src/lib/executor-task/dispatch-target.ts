import {
  type DispatchTargetAudit,
  GROUP_ROLES,
  type GroupMember,
  taskDispatchWarning as taskDispatchWarningTable,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import {
  type ExecutorConfig,
  findExecutorByParticipant,
} from "@server/lib/executors";
import { wsHub } from "@server/lib/ws-hub";
import { and, arrayContains, eq } from "drizzle-orm";
import { applyDiffSummaryPatch } from "./diff-summary";
import { postStatus } from "./notify";
import {
  getRedispatchFailureLimit,
  isInCooldown,
  runningExecutorCount,
} from "./state";

/** 角色定向(R1)选出的目标成员及其执行器配置。 */
interface ResolvedRoleTarget {
  participant: { id: string; executorKey: string | null };
  ex: ExecutorConfig;
  membership: GroupMember;
}

/**
 * 协调任务的职责跨越一次 CLI 进程生命周期:目标 participant 在本群持有
 * coordinator 角色时,进程退出只代表协调者 runtime 暂时离开,不代表 task
 * 完成。角色来自 group_members 的实时关系,因此无需新增 task 字段或模式配置。
 */
export async function isCoordinatorTask(
  db: DataBase,
  groupId: string,
  participantId: string,
): Promise<boolean> {
  const membership = await db.query.groupMember.findFirst({
    where: (t, { and: andFn, eq: eqFn }) =>
      andFn(eqFn(t.groupId, groupId), eqFn(t.participantId, participantId)),
    columns: { roles: true },
  });
  return membership?.roles.includes("coordinator") ?? false;
}

/**
 * 目标不可被派发的守卫(specs/dispatch-must-not-spawn-the-reviewer.md R1–R3):
 *  - audience=role 且 audienceRef=reviewer → 整类目标不可派;
 *  - audience=participant 且该成员在本群 roles 含 reviewer → 不可派
 *    (即便同时持有 executor / 即便有执行器配置)。
 * 判据唯一出处:group_members.roles(不是执行器配置、不是名字)。
 */
export async function isReviewerNotDispatchableTarget(
  db: DataBase,
  groupId: string,
  audience: "participant" | "role",
  audienceRef: string,
): Promise<boolean> {
  if (audience === "role") {
    return audienceRef === "reviewer";
  }
  const membership = await db.query.groupMember.findFirst({
    where: (t, { and: andFn, eq: eqFn }) =>
      andFn(eqFn(t.groupId, groupId), eqFn(t.participantId, audienceRef)),
    columns: { roles: true },
  });
  return membership?.roles.includes("reviewer") ?? false;
}

/**
 * R2:角色定向(R1)的目标成员选取 —— 全部复用既有可用性判定,不另写一套调度
 * (另写一份必然与主路径漂移,isDetachedTask 先例):按顺序排除
 *  1. 不在执行器配置中的(findExecutorByParticipant 返回空)
 *  2. 处于限额冷却的(isInCooldown)
 *  3. 已达并发上限的(runningExecutorCount vs maxConcurrency,同 isRunDispatchable)
 * 余下取第一个;都不可用则回退到第一个持有执行器配置的成员,由现有排队机制
 * (isRunDispatchable / pumpQueue)等其可用后再派发 —— 不报错、不跳过。
 * 失败返回明确原因(R3):角色非法 / 本群无成员持有该角色 / 无成员在执行器配置中。
 */
export async function resolveRoleTarget(
  db: DataBase,
  groupId: string,
  role: string,
): Promise<
  | ({ status: "ok" } & ResolvedRoleTarget)
  | {
      status: "error";
      reason: "role-not-legal" | "role-no-member" | "role-no-executor";
      role: string;
    }
> {
  // R3:非法角色名 → 明确失败,不静默跳过(消息层校验之外的第二道闸)。
  if (!(GROUP_ROLES as readonly string[]).includes(role)) {
    return { status: "error", reason: "role-not-legal", role };
  }
  const members = await db.query.groupMember.findMany({
    where: (t, { and: andFn, eq: eqFn }) =>
      andFn(eqFn(t.groupId, groupId), arrayContains(t.roles, [role])),
  });
  // R3:本群无成员持有该角色 → 明确失败。
  if (members.length === 0) {
    return { status: "error", reason: "role-no-member", role };
  }
  let fallback: ResolvedRoleTarget | null = null;
  for (const membership of members) {
    // 多角色组合:roles 含 reviewer 即以不可派发为准
    // (dispatch-must-not-spawn-the-reviewer R3),宁可少派一次。
    if (membership.roles.includes("reviewer")) continue;
    const participant = await db.query.participant.findFirst({
      where: (t, { eq: eqFn }) => eqFn(t.id, membership.participantId),
    });
    if (!participant) continue;
    const ex = await findExecutorByParticipant(db, participant);
    if (!ex) continue; // R2-1:不在执行器配置中,排除
    if (!fallback) fallback = { participant, ex, membership };
    if (isInCooldown(ex)) continue; // R2-2:冷却中,排除
    const cap = ex.maxConcurrency ?? Number.POSITIVE_INFINITY;
    if (runningExecutorCount(ex.key) >= cap) continue; // R2-3:并发已满,排除
    return { status: "ok", participant, ex, membership };
  }
  if (fallback) {
    // 可用候选都被冷却/并发排除 → 交给现有排队机制等其可用(不报错、不跳过)。
    return { status: "ok", ...fallback };
  }
  // 成员都在执行器配置之外 → 无目标可派发,明确失败。
  return { status: "error", reason: "role-no-executor", role };
}

/** 与 coordinator-resume.isResumeTask 同源判定(diffSummary.platform.resumeOf);
 *  queue.ts 内联避免与 coordinator-resume 的循环依赖。 */
function isPlatformResumeTaskLike(task: { diffSummary: unknown }): boolean {
  const summary =
    task.diffSummary && typeof task.diffSummary === "object"
      ? (task.diffSummary as Record<string, unknown>)
      : undefined;
  const platform =
    summary?.platform && typeof summary.platform === "object"
      ? (summary.platform as Record<string, unknown>)
      : undefined;
  return typeof platform?.["resumeOf"] === "string";
}

/**
 * 同一父任务名下「连续失败」执行子任务数(R4 熔断口径):按 createdAt 升序,从
 * 最新往回数连续 failed 的子任务。平台续跑任务不计入 —— 它是平台拉起协调者的
 * 任务,不是协调者派发的执行子任务,其成败都不应打断「子任务连续失败」的计数。
 */
export async function countConsecutiveFailedChildren(
  db: DataBase,
  parentTaskId: string,
): Promise<number> {
  const children = await db.query.task.findMany({
    where: (t, { eq: eqFn }) => eqFn(t.parentTaskId, parentTaskId),
    columns: { id: true, status: true, diffSummary: true },
    orderBy: (t, { asc: ascFn }) => ascFn(t.createdAt),
  });
  let n = 0;
  for (let i = children.length - 1; i >= 0; i--) {
    if (isPlatformResumeTaskLike(children[i])) continue;
    if (children[i].status !== "failed") break;
    n += 1;
  }
  return n;
}

/** R4/R5 留痕:父任务 diffSummary 写入熔断记录 + 群内发一条可读消息(等待人工介入)。 */
export async function recordRedispatchStopped(
  db: DataBase,
  parent: {
    id: string;
    groupId: string;
    executorKey: string | null;
    executorParticipantId: string | null;
    diffSummary: unknown;
  },
  consecutive: number,
): Promise<void> {
  const limit = getRedispatchFailureLimit();
  const next = applyDiffSummaryPatch(parent.diffSummary, {
    redispatchStopped: {
      at: new Date().toISOString(),
      consecutiveFailures: consecutive,
      limit,
      reason: `子任务连续失败达 ${consecutive} 次(阈值 ${limit}),平台已停止重派,等待人工介入`,
    },
  });
  try {
    await db
      .update(taskTable)
      .set({ diffSummary: next })
      .where(
        and(eq(taskTable.id, parent.id), eq(taskTable.groupId, parent.groupId)),
      );
  } catch (e) {
    console.warn(`[executor] 写重派熔断留痕失败(${parent.id}): ${e}`);
  }
  if (parent.executorParticipantId) {
    const coordinatorEx = await findExecutorByParticipant(db, parent);
    if (coordinatorEx) {
      await postStatus(
        db,
        parent.groupId,
        parent.executorParticipantId,
        coordinatorEx,
        `🛑 [${coordinatorEx.label}] 已停止重派:父任务子任务连续失败达 ${consecutive} 次(阈值 ${limit}),等待人工介入`,
      );
    }
  }
}

/**
 * Capture the server-observable target choice at dispatch time. Candidate
 * means a different group member with executor role and a configured executor;
 * the caller's reasoning is intentionally never inferred from message text.
 */
export async function buildDispatchTargetAudit(
  db: DataBase,
  groupId: string,
  dispatcherParticipantId: string,
  target: { id: string; name: string },
  selectionReason: string | null,
): Promise<DispatchTargetAudit> {
  const members = await db.query.groupMember.findMany({
    where: (t, { eq: eqFn }) => eqFn(t.groupId, groupId),
  });
  const candidateMemberIds = members
    .filter(
      (member) =>
        member.participantId !== dispatcherParticipantId &&
        member.roles.includes("executor"),
    )
    .map((member) => member.participantId);
  const participants = candidateMemberIds.length
    ? await db.query.participant.findMany({
        where: (t, { inArray: inArrayFn }) =>
          inArrayFn(t.id, candidateMemberIds),
      })
    : [];
  const configuredCandidates = (
    await Promise.all(
      participants.map(async (participant) => ({
        participant,
        executor: await findExecutorByParticipant(db, participant),
      })),
    )
  )
    .filter(
      (
        entry,
      ): entry is {
        participant: (typeof participants)[number];
        executor: ExecutorConfig;
      } => entry.executor !== undefined,
    )
    .map((entry) => entry.participant)
    .sort((a, b) => a.name.localeCompare(b.name));
  const candidateIds = configuredCandidates.map(
    (participant) => participant.id,
  );
  const candidateTasks = candidateIds.length
    ? await db.query.task.findMany({
        where: (t, { and: andFn, eq: eqFn, inArray: inArrayFn }) =>
          andFn(
            eqFn(t.groupId, groupId),
            inArrayFn(t.executorParticipantId, candidateIds),
          ),
        columns: {
          executorParticipantId: true,
          status: true,
          updatedAt: true,
        },
        orderBy: (t, { desc: descFn }) => [descFn(t.updatedAt)],
      })
    : [];
  const tasksByCandidate = new Map<string, typeof candidateTasks>();
  for (const task of candidateTasks) {
    const tasks = tasksByCandidate.get(task.executorParticipantId) ?? [];
    tasks.push(task);
    tasksByCandidate.set(task.executorParticipantId, tasks);
  }

  return {
    dispatcherParticipantId,
    triggerSource: members.some(
      (member) =>
        member.participantId === dispatcherParticipantId &&
        member.roles.includes("human"),
    )
      ? "human"
      : "participant",
    targetParticipantId: target.id,
    targetParticipantName: target.name,
    selfDispatch: dispatcherParticipantId === target.id,
    candidates: configuredCandidates.map((participant) => {
      const tasks = tasksByCandidate.get(participant.id) ?? [];
      const latest = tasks[0];
      return {
        participantId: participant.id,
        participantName: participant.name,
        status: tasks.some((task) => task.status === "running")
          ? "running"
          : latest?.status === "failed"
            ? "recently_failed"
            : "available",
      };
    }),
    selectionReason,
  };
}

/** Persist and announce a dispatch audit warning without changing dispatch. */
export async function createTaskDispatchWarnings(
  db: DataBase,
  groupId: string,
  taskId: string,
  dispatcherParticipantId: string,
): Promise<void> {
  const members = await db.query.groupMember.findMany({
    where: (t, { eq: eqFn }) => eqFn(t.groupId, groupId),
    columns: { participantId: true, roles: true },
  });
  const reviewers = members
    .filter((member) => member.roles.includes("reviewer"))
    .map((member) => member.participantId);
  // Two-layer groups have no reviewer; retain a warning in the dispatcher’s
  // own inbox so the audit remains visible instead of silently disappearing.
  const recipients =
    reviewers.length > 0 ? reviewers : [dispatcherParticipantId];
  await db
    .insert(taskDispatchWarningTable)
    .values(
      recipients.map((recipientParticipantId) => ({
        taskId,
        groupId,
        recipientParticipantId,
      })),
    )
    .onConflictDoNothing();
  await wsHub.broadcastTaskDispatchWarningAvailable(
    groupId,
    taskId,
    recipients,
  );
}
