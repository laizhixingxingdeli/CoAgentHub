/**
 * 任务面板(任务控制 UI enhancement):消息页标题栏「任务」按钮展开的可折叠
 * 面板。数据来自 GET /groups/:id/tasks(打开时拉取一次,不轮询);「停止」/
 * 「回滚」通过发一条 broadcast 命令消息(「停止 <taskId>」/「回滚 <taskId>」)
 * 触发服务端 control.ts,与手动输入等效,不新建 API。
 */

import { Button } from "@/components/ui/button";
import { formatMessageTime, TASK_STATUS_CLASSES } from "./lib";
import type { Member, MessageItem } from "./types";

/** 与 GET /groups/:id/tasks 返回行对齐(server task 表行形状)。 */
export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export type TaskItem = {
  id: string;
  groupId: string;
  messageId: string;
  executorAgentId: string;
  executorKey: string | null;
  status: TaskStatus;
  checkpointRef: string | null;
  diffSummary: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string | null;
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  queued: "排队中",
  running: "执行中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

/** queued 在消息状态条(T26)里没有对应色,补中性灰;其余沿用任务状态条配色。 */
export const TASK_PANEL_STATUS_CLASSES: Record<TaskStatus, string> = {
  queued:
    "border-slate-300/60 bg-slate-500/10 text-slate-700 dark:border-slate-700/60 dark:bg-slate-500/15 dark:text-slate-300",
  done: TASK_STATUS_CLASSES.done,
  failed: TASK_STATUS_CLASSES.failed,
  running: TASK_STATUS_CLASSES.running,
  cancelled: TASK_STATUS_CLASSES.cancelled,
};

type TaskPanelProps = {
  tasks: TaskItem[];
  loading: boolean;
  /** 面板级反馈:加载失败 / 命令发送失败 / 无权限提示。 */
  error: string | null;
  /** 正在发送命令的任务 id(null = 空闲),驱动按钮的「发送中…」。 */
  commandSending: string | null;
  messages: MessageItem[];
  members: Member[];
  onStop: (task: TaskItem) => void;
  onRollback: (task: TaskItem) => void;
};

/** 任务消息正文预览(前 40 字);消息不在当前列表时返回 null。 */
function taskMessagePreview(
  task: TaskItem,
  messages: MessageItem[],
): string | null {
  const body = messages.find((m) => m.id === task.messageId)?.body ?? "";
  if (!body) {
    return null;
  }
  return body.length > 40 ? `${body.slice(0, 40)}…` : body;
}

/** diffSummary 带 hash/error 时的小字详情。 */
function diffSummaryDetail(
  diffSummary: Record<string, unknown> | null,
): string | null {
  if (!diffSummary || typeof diffSummary !== "object") {
    return null;
  }
  if (typeof diffSummary.hash === "string") {
    return `hash ${diffSummary.hash.slice(0, 12)}`;
  }
  if (typeof diffSummary.error === "string") {
    return `error: ${diffSummary.error}`;
  }
  return null;
}

export default function TaskPanel({
  tasks,
  loading,
  error,
  commandSending,
  messages,
  members,
  onStop,
  onRollback,
}: TaskPanelProps) {
  return (
    <div data-testid="task-panel" className="shrink-0 border-b px-4 py-3">
      <span className="text-xs font-medium text-muted-foreground">
        任务列表({tasks.length})
      </span>
      <div className="mt-2">
        {error && <p className="mb-2 text-xs text-red-600">{error}</p>}
        {loading ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无任务</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {tasks.map((task) => {
              const executor =
                members.find((m) => m.agentId === task.executorAgentId)?.name ??
                task.executorKey ??
                "—";
              const preview = taskMessagePreview(task, messages);
              const detail = diffSummaryDetail(task.diffSummary);
              const busy = commandSending === task.id;
              const canStop =
                task.status === "queued" || task.status === "running";
              const canRollback =
                (task.status === "done" || task.status === "failed") &&
                Boolean(task.checkpointRef);
              return (
                <li
                  key={task.id}
                  data-testid={`task-row-${task.id}`}
                  className="rounded-md border bg-muted/30 px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span
                      data-testid={`task-status-${task.id}`}
                      data-status={task.status}
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${TASK_PANEL_STATUS_CLASSES[task.status]}`}
                    >
                      {TASK_STATUS_LABELS[task.status]}
                    </span>
                    <span className="text-xs font-medium">{executor}</span>
                    <span
                      data-testid={`task-time-${task.id}`}
                      className="ml-auto shrink-0 text-xs text-muted-foreground"
                    >
                      {formatMessageTime(task.createdAt)}
                    </span>
                    <span className="flex shrink-0 gap-1.5">
                      {canStop && (
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid={`task-stop-${task.id}`}
                          disabled={busy}
                          onClick={() => onStop(task)}
                        >
                          {busy ? "发送中…" : "停止"}
                        </Button>
                      )}
                      {canRollback && (
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid={`task-rollback-${task.id}`}
                          disabled={busy}
                          onClick={() => onRollback(task)}
                        >
                          {busy ? "发送中…" : "回滚"}
                        </Button>
                      )}
                    </span>
                  </div>
                  {preview && (
                    <p className="mt-1 truncate text-sm text-muted-foreground">
                      {preview}
                    </p>
                  )}
                  {detail && (
                    <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                      {detail}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
