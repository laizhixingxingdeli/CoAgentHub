/**
 * 子任务终态时把协调者重新拉起(specs/wake-the-coordinator-on-child-completion.md
 * R1-R4):执行子任务进入终态(done/failed/cancelled)且其父协调任务仍非终态时,
 * 平台为父任务的执行方(协调者)创建一条续跑任务,并由现有队列(enqueueTaskRun)
 * 正常拉起。复用现有 task completion event 消费与任务队列拉起路径,不新写 spawn。
 *
 * 防环(R4):续跑任务由平台写入 `diffSummary.platform.resumeOf` 标记 —— 续跑任务
 * 自身终态时,消费方据此判定「这是续跑任务」而不再触发新的续跑,不依赖任务书文本。
 */

import {
  taskCompletionEvent as taskCompletionEventTable,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import { findExecutorByParticipant } from "@server/lib/executors";
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { isTerminalTaskStatus } from "../coordination-activity";
import { notifyTaskStatusChanged } from "./notify";
import {
  enqueueTaskRun,
  isCoordinatorTask,
  isExecutorProcessAlive,
} from "./queue";
import type { GroupPromptInfo } from "./types";

type Task = typeof taskTable.$inferSelect;

/** 续跑任务平台标记键:diffSummary.platform.resumeOf = 父协调任务 id。 */
const PLATFORM_MARKER_KEY = "resumeOf";

/** 续跑任务是否带平台标记(判定「本任务是一条续跑任务」,R4 防环用)。 */
export function isResumeTask(task: { diffSummary: unknown }): boolean {
  const summary =
    task.diffSummary &&
    typeof task.diffSummary === "object" &&
    !Array.isArray(task.diffSummary)
      ? (task.diffSummary as Record<string, unknown>)
      : undefined;
  const platform =
    summary?.platform &&
    typeof summary.platform === "object" &&
    !Array.isArray(summary.platform)
      ? (summary.platform as Record<string, unknown>)
      : undefined;
  return typeof platform?.[PLATFORM_MARKER_KEY] === "string";
}

/**
 * R1-R4 判定 + 创建续跑任务。子任务进入终态后调用;返回是否创建了续跑任务。
 *
 * - R1:子任务有父任务且父协调任务仍非终态;
 * - R2:父协调任务的 executor_pid 仍存活 → 不创建(协调者自己会消费完成事件);
 * - R3:同一父任务已存在非终态续跑任务 → 不重复创建;
 * - R4:本次终态的子任务本身是续跑任务 → 不触发续跑(防环)。
 */
export async function maybeCreateCoordinatorResumeTask(
  db: DataBase,
  childTask: Task,
): Promise<"created" | "skipped"> {
  // R4:续跑任务自身终态 → 不再触发续跑(防环)。
  if (isResumeTask(childTask)) return "skipped";

  // R1:必须是被派发的子任务(有父任务)。
  if (!childTask.parentTaskId) return "skipped";
  const parent = await db.query.task.findFirst({
    where: eq(taskTable.id, childTask.parentTaskId),
  });
  if (!parent) return "skipped";
  if (isTerminalTaskStatus(parent.status)) return "skipped";

  // 父任务执行方必须是协调者(角色实时判定,与 isCoordinatorTask 同源)。
  if (
    !(await isCoordinatorTask(db, parent.groupId, parent.executorParticipantId))
  ) {
    return "skipped";
  }

  // R2:父协调进程仍存活 → 不创建(协调者会自己消费完成事件)。
  if (
    parent.executorPid !== null &&
    isExecutorProcessAlive(parent.executorPid)
  ) {
    return "skipped";
  }

  // R3:只把平台标记的非终态续跑任务视为重复。父任务下可能同时存在
  // 协调者主动派给自己的普通子任务,它不应阻止平台创建恢复任务。
  const existing = await db.query.task.findMany({
    where: and(
      eq(taskTable.parentTaskId, parent.id),
      eq(taskTable.executorParticipantId, parent.executorParticipantId),
      inArray(taskTable.status, ["queued", "running"]),
    ),
    columns: { id: true, diffSummary: true },
  });
  if (existing.some(isResumeTask)) return "skipped";

  await createCoordinatorResumeTask(db, parent, childTask);
  return "created";
}

/** 构建续跑任务书(R1 要求的全部信息:父任务 id、终态子任务、spec、全部子任务)。 */
function buildResumeBrief(
  parent: Task,
  childTask: Task,
  children: Array<{ id: string; status: string }>,
): string {
  const diffSummary =
    childTask.diffSummary !== null &&
    childTask.diffSummary !== undefined &&
    typeof childTask.diffSummary === "object"
      ? JSON.stringify(childTask.diffSummary)
      : "无";
  const childrenLines = children
    .map((child) => `- ${child.id}: ${child.status}`)
    .join("\n");
  return [
    "# CoAgentHub 续跑任务(协调者被重新拉起)",
    "",
    "你此前派发的子任务已进入终态,而你的协调进程已退出。平台为你创建了本条续跑任务,",
    "请完成 L2 检视并结案父任务。",
    "",
    "## 父协调任务(需要你 PATCH 结案)",
    `- 父任务 id: ${parent.id}`,
    `- 父任务 specRef: ${parent.specRef ?? "无"}`,
    `- 父任务 specHash: ${parent.specHash ?? "无"}`,
    "",
    "## 本次终态子任务",
    `- 子任务 id: ${childTask.id}`,
    `- 状态: ${childTask.status}`,
    `- diffSummary: ${diffSummary}`,
    "",
    "## 全部子任务(id 与当前状态)",
    childrenLines || "- (无)",
    "",
    "## 操作",
    "1. 读取父任务详情与冻结 spec,对本次终态子任务做 L2 检视。",
    "2. 若可结案:PATCH 父任务为 done(附 diffSummary)。",
    "3. 完成后 PATCH 本条续跑任务为 done。",
  ].join("\n");
}

/** 为父协调任务创建续跑任务并复用现有队列路径拉起。 */
async function createCoordinatorResumeTask(
  db: DataBase,
  parent: Task,
  childTask: Task,
): Promise<void> {
  const children = await db.query.task.findMany({
    where: eq(taskTable.parentTaskId, parent.id),
    columns: { id: true, status: true },
    orderBy: (t, { asc: ascFn }) => ascFn(t.createdAt),
  });

  const brief = buildResumeBrief(parent, childTask, children);
  const messageId = uuidv7();

  const [created] = await db
    .insert(taskTable)
    .values({
      groupId: parent.groupId,
      parentTaskId: parent.id,
      messageId,
      executorParticipantId: parent.executorParticipantId,
      executorKey: parent.executorKey,
      status: "queued",
      brief,
      specRef: parent.specRef,
      specHash: parent.specHash,
      dispatchKind: parent.dispatchKind ?? null,
      // 平台标记(R4):续跑任务自身终态时消费方据此防环;不依赖任务书文本。
      diffSummary: { platform: { [PLATFORM_MARKER_KEY]: parent.id } },
      // 完成事件定向给协调者(与父任务同执行方),供其收件箱留存。
      dispatcherParticipantId: parent.executorParticipantId,
    })
    .returning();

  const ex = await findExecutorByParticipant(db, parent);
  if (!ex) {
    console.warn(
      `[executor] 续跑任务 ${created.id} 无法拉起:协调者 ${parent.executorParticipantId} 无执行器配置`,
    );
    return;
  }

  await notifyTaskStatusChanged(
    db,
    created.id,
    parent.groupId,
    "queued",
    created,
  );

  const membership = await db.query.groupMember.findFirst({
    where: (t, { and: andFn, eq: eqFn }) =>
      andFn(
        eqFn(t.groupId, parent.groupId),
        eqFn(t.participantId, parent.executorParticipantId),
      ),
  });
  const groupPrompt: GroupPromptInfo | null = membership
    ? { roles: membership.roles, prompt: membership.prompt }
    : null;

  await enqueueTaskRun(db, created, {
    groupId: parent.groupId,
    messageId,
    participantId: parent.executorParticipantId,
    ex,
    body: brief,
    groupPrompt,
    specRef: parent.specRef,
    specHash: parent.specHash,
  });
}

/**
 * 消费 pending 的 task completion event:对每条事件所属任务执行
 * maybeCreateCoordinatorResumeTask,创建了续跑任务的把事件置为 delivered,
 * 避免重复消费。返回创建的续跑任务数。
 */
export async function consumePendingCompletionEvents(
  db: DataBase,
): Promise<number> {
  const now = new Date();
  const rows = await db
    .select()
    .from(taskCompletionEventTable)
    .where(
      and(
        eq(taskCompletionEventTable.state, "pending"),
        or(
          isNull(taskCompletionEventTable.nextAttemptAt),
          lte(taskCompletionEventTable.nextAttemptAt, now),
        ),
      ),
    )
    .orderBy(asc(taskCompletionEventTable.id));

  let created = 0;
  for (const event of rows) {
    const task = await db.query.task.findFirst({
      where: eq(taskTable.id, event.taskId),
    });
    if (!task) continue;
    const result = await maybeCreateCoordinatorResumeTask(db, task);
    if (result === "created") {
      created += 1;
      await db
        .update(taskCompletionEventTable)
        .set({ state: "delivered", deliveredAt: now, updatedAt: now })
        .where(eq(taskCompletionEventTable.id, event.id));
    }
  }
  return created;
}

/** 周期性消费完成事件(server 启动时注册);返回停止函数(测试用)。 */
export function startCoordinatorResumeConsumer(
  db: DataBase,
  intervalMs = 5_000,
): () => void {
  const timer = setInterval(() => {
    void consumePendingCompletionEvents(db).catch((error) => {
      console.warn(`[executor] 续跑任务消费失败: ${error}`);
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
