import {
  type CoordinationPayload,
  groupMember as groupMemberTable,
  normalizeReviewRequestDiffSummary,
  parseKnownCoordinationPayload,
  participant as participantTable,
} from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import { isDetachedTask } from "@server/lib/detached-task-liveness";
import { getL3ResponseMinutesMs, postStatus } from "@server/lib/executor-task";
import { eq } from "drizzle-orm";

/** L3 逾期扫描周期。阈值仍由 l3ResponseMinutes 决定,这里只决定提醒延迟。 */
export const L3_OVERDUE_REMINDER_INTERVAL_MS = 60_000;

/** task id = 一条 review_request;进程内去重,与 unknown-participant 告警同口径。 */
const remindedRequestIds = new Set<string>();

interface ReminderSweepOptions {
  /** 启动时只登记已经逾期的历史请求,不擅自补发历史提醒。 */
  suppressExistingOverdue?: boolean;
}

function reviewRequestOf(
  diffSummary: unknown,
): Extract<CoordinationPayload, { type: "review_request" }> | undefined {
  try {
    const normalized = normalizeReviewRequestDiffSummary(diffSummary);
    return normalized?.review_request as
      | Extract<CoordinationPayload, { type: "review_request" }>
      | undefined;
  } catch {
    // 历史坏载荷不应打断整轮平台扫描。
    return undefined;
  }
}

/** 本群是否已有指向该任务的 review_result 裁决消息(R2「已应答」判据)。 */
export async function hasReviewResult(
  db: DataBase,
  groupId: string,
  taskId: string,
): Promise<boolean> {
  const candidates = await db.query.groupMessage.findMany({
    where: (t, { and: andFn, eq: eqFn, ilike: ilikeFn }) =>
      andFn(eqFn(t.groupId, groupId), ilikeFn(t.body, "%review_result%")),
    columns: { body: true },
  });
  for (const message of candidates) {
    try {
      const parsed = parseKnownCoordinationPayload(message.body);
      if (parsed?.type === "review_result" && parsed.taskId === taskId) {
        return true;
      }
    } catch {
      // 与任务详情派生一致:历史坏载荷跳过。
    }
  }
  return false;
}

async function reviewerLabel(db: DataBase, groupId: string): Promise<string> {
  const members = await db
    .select({
      participantId: participantTable.id,
      name: participantTable.name,
      roles: groupMemberTable.roles,
    })
    .from(groupMemberTable)
    .innerJoin(
      participantTable,
      eq(participantTable.id, groupMemberTable.participantId),
    )
    .where(eq(groupMemberTable.groupId, groupId));
  const reviewers = members
    .filter((member) => member.roles.includes("reviewer"))
    .map((member) => `${member.name}(${member.participantId})`);
  return reviewers.length > 0
    ? reviewers.join("、")
    : "群内 reviewer（当前未找到）";
}

/**
 * 扫描并提醒本轮新逾期的 L3 请求。只写群消息,不修改 task 状态或裁决载荷。
 * 返回成功写入的提醒数。
 */
export async function remindOverdueL3Requests(
  db: DataBase,
  now = new Date(),
  options: ReminderSweepOptions = {},
): Promise<number> {
  const tasks = await db.query.task.findMany({
    where: (t, { eq: eqFn }) => eqFn(t.status, "done"),
  });
  let sentCount = 0;

  for (const task of tasks) {
    const request = reviewRequestOf(task.diffSummary);
    if (!request || !(await isDetachedTask(db, task))) continue;

    if (await hasReviewResult(db, task.groupId, task.id)) {
      // R3:裁决后释放该请求的去重标记;后续新请求有自己的 task id。
      remindedRequestIds.delete(task.id);
      continue;
    }

    const awaitingSince =
      task.dispatchAudit?.coordinationActivity?.endedAt ??
      (task.updatedAt ?? task.createdAt).toISOString();
    const waitedMs = now.getTime() - Date.parse(awaitingSince);
    if (waitedMs <= getL3ResponseMinutesMs()) continue;
    if (remindedRequestIds.has(task.id)) continue;

    // 先占位防止两轮异步扫描重叠;写失败时释放,允许下一轮重试。
    remindedRequestIds.add(task.id);
    if (options.suppressExistingOverdue) continue;

    const reviewer = await reviewerLabel(db, task.groupId);
    const waitedMinutes = Math.max(1, Math.floor(waitedMs / 60_000));
    const sent = await postStatus(
      db,
      task.groupId,
      task.executorParticipantId,
      { label: "平台 L3 逾期提醒" },
      `⚠️ L3 逾期提醒（平台自动）：specRef=${request.specRef}；已等待 ${waitedMinutes} 分钟；应裁决方=${reviewer}。`,
    );
    if (sent) sentCount += 1;
    else remindedRequestIds.delete(task.id);
  }

  return sentCount;
}

/** 启动平台扫描;先登记历史已逾期请求,避免部署时擅自补发。 */
export async function startL3OverdueReminder(
  db: DataBase,
  intervalMs = L3_OVERDUE_REMINDER_INTERVAL_MS,
  options: { enabled?: boolean } = {},
): Promise<() => void> {
  if (options.enabled === false) return () => {};
  await remindOverdueL3Requests(db, new Date(), {
    suppressExistingOverdue: true,
  });
  const timer = setInterval(() => {
    void remindOverdueL3Requests(db).catch((error) => {
      console.warn(`[l3-reminder] L3 逾期扫描失败: ${error}`);
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** 测试专用:清空进程内去重状态。 */
export function resetL3OverdueReminderStateForTests(): void {
  remindedRequestIds.clear();
}
