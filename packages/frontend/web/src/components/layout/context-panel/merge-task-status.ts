import type { WsTaskStatusChangedEvent } from "@/hooks/use-group-ws";
import type { TaskItem } from "@/pages/app/groups/messages/TaskPanel";

/**
 * 将一条 task_status_changed 增量合并进任务集合。
 *
 * 已有任务按 id 原位替换,新任务追加一次;需求分组与排序继续由
 * groupTasksBySpec 统一处理,因此这里不复制分组排序规则。
 */
export function mergeTaskStatusChanged(
  prev: TaskItem[],
  event: WsTaskStatusChangedEvent,
): TaskItem[] {
  const index = prev.findIndex((task) => task.id === event.taskId);
  const incoming = event.task;

  if (index >= 0) {
    const next = [...prev];
    next[index] = {
      ...prev[index],
      ...(incoming ?? {}),
      id: event.taskId,
      groupId: event.groupId,
      status: event.status,
    };
    return next;
  }

  // A lightweight event has no createdAt/message metadata, so it cannot form
  // a valid new TaskItem. The server's full task event is required for append.
  if (!incoming) {
    return prev;
  }

  const task: TaskItem = {
    id: event.taskId,
    groupId: event.groupId,
    messageId: incoming.messageId ?? "",
    brief: incoming.brief,
    executorParticipantId: incoming.executorParticipantId,
    executorKey: incoming.executorKey,
    status: event.status,
    checkpointRef: incoming.checkpointRef ?? null,
    specRef: incoming.specRef,
    specHash: incoming.specHash,
    parentTaskId: incoming.parentTaskId ?? null,
    diffSummary: incoming.diffSummary,
    createdAt: incoming.createdAt,
    updatedAt: incoming.updatedAt,
    ...(incoming.attempts ? { attempts: incoming.attempts } : {}),
    ...(incoming.outputTail !== undefined
      ? { outputTail: incoming.outputTail }
      : {}),
  };
  return [...prev, task];
}
