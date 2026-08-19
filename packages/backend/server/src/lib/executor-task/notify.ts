import {
  type Task,
  type TaskStatus,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import type { ExecutorConfig } from "@server/lib/executors";
import type { GroupMessageFull } from "@server/lib/services/message-service";
import { insertGroupMessage } from "@server/lib/services/message-service";
import { wsHub } from "@server/lib/ws-hub";
import { and, eq } from "drizzle-orm";

/**
 * 任务状态通知(executor-task 拆分):任务状态落库后的 WS 推送
 * (task_status_changed)与以执行器 participant 身份回传群消息(postStatus),
 * 以及停止指令的 cancelled 落库+通知(markTaskCancelled)。
 */

/** 与桥 contentTypeFor 一致:状态类 emoji 前缀 → task_status。 */
const STATUS_EMOJI_RE = /^(?:📋|🚀|✅|❌|🛑|⚠️)/u;

/**
 * 任务状态落库后推 task_status_changed(任务状态实时推送):任务
 * queued/running/done/failed/cancelled 变化时,通过 WS hub 推给该任务所属群
 * 的订阅者(与 task_output 同界,broadcast 可见性),插件/前端免轮询感知任务
 * 生命周期。task 载荷为最新任务行快照(日期转 ISO);失败只告警,不影响任务
 * 主流程(fire-and-forget,与 wsHub 其它广播一致)。路由层(PATCH /tasks)
 * 推进外部执行器客户端的状态时也复用此出口。
 */
export async function notifyTaskStatusChanged(
  db: DataBase,
  taskId: string,
  groupId: string,
  status: TaskStatus,
  row?: Task,
): Promise<void> {
  try {
    const task =
      row ??
      (await db.query.task.findFirst({
        where: and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)),
      }));
    if (!task) return;
    const iso = (d: Date | string): string =>
      d instanceof Date ? d.toISOString() : d;
    const isoOrNull = (d: Date | string | null): string | null =>
      d == null ? null : iso(d);
    await wsHub.broadcastTaskStatusChanged(groupId, taskId, status, {
      id: task.id,
      status: task.status,
      executorParticipantId: task.executorParticipantId,
      executorKey: task.executorKey ?? null,
      brief: task.brief ?? null,
      diffSummary: (task.diffSummary as Record<string, unknown> | null) ?? null,
      // 规范驱动下发:事件透传 specRef/specHash(任务详情同源);老任务为 null。
      specRef: task.specRef ?? null,
      specHash: task.specHash ?? null,
      // 任务下发者信息(Part A):事件透传给插件(定向通知用);老任务为 null。
      dispatcherParticipantId: task.dispatcherParticipantId ?? null,
      dispatcherSessionId: task.dispatcherSessionId ?? null,
      createdAt: iso(task.createdAt),
      updatedAt: isoOrNull(task.updatedAt),
      retryCount: task.retryCount,
    });
    // Durable Task Completion Events:首次进入终态且有 dispatcher 时,
    // DB trigger 已持久化 completion event,此处发轻量 WS 提示(仅低延迟提示,
    // 可靠性来源始终是数据库 inbox)。fire-and-forget,失败不影响主流程。
    if (
      status === "done" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      await wsHub.broadcastTaskCompletionAvailable(
        groupId,
        taskId,
        status,
        task.dispatcherParticipantId ?? null,
      );
    }
  } catch (e) {
    console.warn(`[executor] 推送 task_status_changed 失败(${taskId}): ${e}`);
  }
}

/** 以执行器 participant 身份回传群消息(broadcast + 前缀判定 contentType)。 */
export async function postStatus(
  db: DataBase,
  groupId: string,
  senderId: string,
  ex: ExecutorConfig,
  body: string,
): Promise<void> {
  try {
    const full: GroupMessageFull = await insertGroupMessage(db, {
      groupId,
      senderId,
      parentId: null,
      audience: "broadcast",
      audienceRef: null,
      body,
      contentType: STATUS_EMOJI_RE.test(body) ? "task_status" : "text/plain",
      fileRef: null,
    });
    // 与 POST /messages 一致的火力外扇出:WS,让群里实时可见。
    void wsHub.broadcastGroupMessage(full);
  } catch (e) {
    console.warn(`[executor] 状态回传失败(${ex.label}):`, e);
  }
}

/** 直接落库置 cancelled(停止指令取消排队/已运行任务用)。 */
export async function markTaskCancelled(
  db: DataBase,
  taskId: string,
  groupId: string,
): Promise<unknown> {
  const [updated] = await db
    .update(taskTable)
    .set({ status: "cancelled", diffSummary: { error: "stopped" } })
    .where(and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)))
    .returning();
  if (updated) {
    await notifyTaskStatusChanged(db, taskId, groupId, "cancelled", updated);
  }
  return updated;
}
