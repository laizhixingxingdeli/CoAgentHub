/**
 * 任务面板(任务控制 UI enhancement):消息页标题栏「任务」按钮展开的可折叠
 * 面板。数据来自 GET /groups/:id/tasks(打开时拉取一次,不轮询);「停止」/
 * 「回滚」通过发一条 broadcast 命令消息(「停止 <taskId>」/「回滚 <taskId>」)
 * 触发服务端 control.ts,与手动输入等效,不新建 API。
 *
 * 实时进度(批次增强):任务行可展开 — 展开显示「实时输出」区(等宽字体、
 * 深色底、自动滚到底部;running 时由父组件经 WS task_output 事件流式追加,
 * 刷新/断线后通过 includeOutput=1 拉取当前缓冲)+ attempt 时间线(执行历史)。
 * 回滚按钮:点击后进入「回滚中…」禁用态,server 恢复完成(轮询确认)后提示
 * 「已恢复」。
 */

import type { ComponentProps, ReactElement } from "react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { formatMessageTime, TASK_STATUS_CLASSES } from "./lib";
import type { Member, MessageItem } from "./types";

/** 与 GET /groups/:id/tasks 返回行对齐(server task 表行形状)。 */
export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** 单次执行尝试(attempt 时间线,执行历史)。 */
export type TaskAttempt = {
  n: number;
  startedAt: string;
  endedAt?: string;
  status: TaskStatus;
  error?: string;
  summary?: string;
  hash?: string;
};

export type TaskItem = {
  id: string;
  groupId: string;
  messageId: string;
  executorParticipantId: string;
  executorKey: string | null;
  status: TaskStatus;
  checkpointRef: string | null;
  diffSummary: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string | null;
  /** 执行历史(重试 = 多条;旧任务为 [])。 */
  attempts?: TaskAttempt[];
  /** includeOutput=1 时返回的实时输出缓冲(running 任务/完成回填)。 */
  outputTail?: string;
};

export function taskStatusLabel(status: TaskStatus): string {
  return t(`tasks.status.${status}`);
}

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
  /** 是否有 coordinator/human 权限(已绑定 token):false 时停止/回滚禁用。
   * 只读放开(无 token 的 Local User 也能看列表),但控制命令需要身份。 */
  canControl: boolean;
  /** 归档/软删群只读:即使有控制权限,停止/回滚也禁用并提示。 */
  readOnly: boolean;
  messages: MessageItem[];
  members: Member[];
  /** 展开的任务行 id(null = 全部收起);展开显示实时输出区 + attempt 时间线。 */
  expandedTaskId: string | null;
  /** 实时输出缓冲(taskId → 已接收的 WS chunk 拼接;includeOutput 兜底)。 */
  liveOutputs: Record<string, string>;
  /** 回滚状态(taskId → rolling=回滚中… | done=已恢复)。 */
  rollbackStates: Record<string, "rolling" | "done">;
  onToggleExpand: (task: TaskItem) => void;
  onStop: (task: TaskItem) => void;
  onRollback: (task: TaskItem) => void;
};

/** 停止/回滚控制按钮:无权限或归档只读时禁用并给出提示。
 * title 挂在包裹 span 上 —— disabled 按钮自身不触发 title 悬浮提示。 */
function ControlButton({
  canControl,
  readOnly,
  disabled,
  ...props
}: ComponentProps<typeof Button> & {
  canControl: boolean;
  readOnly: boolean;
}): ReactElement {
  const btn = (
    <Button {...props} disabled={disabled || !canControl || readOnly} />
  );
  if (canControl && !readOnly) {
    return btn;
  }
  const hint = readOnly
    ? t("tasks.hint.readOnly")
    : t("tasks.hint.noPermission");
  return (
    <span title={hint} className="inline-flex">
      {btn}
    </span>
  );
}

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

/** attempt 状态小标签:running/done/failed/cancelled 配色。 */
const ATTEMPT_STATUS_CLASSES: Record<TaskStatus, string> = {
  queued: "text-slate-500",
  running: "text-sky-600 dark:text-sky-400",
  done: "text-emerald-700 dark:text-emerald-400",
  failed: "text-red-600 dark:text-red-400",
  cancelled: "text-amber-600 dark:text-amber-400",
};

/** attempt 状态文案(词典 tasks.attempts.*)。 */
function attemptStatusLabel(status: TaskStatus): string {
  return t(`tasks.attempts.${status}`);
}

/** 实时输出区:等宽字体 + 深色底;内容变化时自动滚到底部。 */
function LiveOutput({ text }: { text: string }): ReactElement {
  const ref = useRef<HTMLPreElement>(null);
  // 与 useAutoScroll 同款:内容变化(高度变化)时滚动到底;不用 text 作依赖
  // (text 变化不触发重渲染,hook 依赖 lint 会报多余依赖)。
  const lastContentHeight = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const height = el.scrollHeight;
    if (height !== lastContentHeight.current) {
      lastContentHeight.current = height;
      el.scrollTop = el.scrollHeight;
    }
  });
  return (
    <pre
      ref={ref}
      data-testid="task-live-output"
      className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-slate-950 px-2 py-1.5 font-mono text-xs leading-relaxed text-slate-100"
    >
      {text || (
        <span className="text-slate-500">{t("tasks.output.empty")}</span>
      )}
    </pre>
  );
}

/** attempt 时间线(执行历史):「第 1 次 失败 exit 1 → 第 2 次 成功 abc1234」。 */
function AttemptTimeline({
  attempts,
}: {
  attempts: TaskAttempt[];
}): ReactElement | null {
  if (attempts.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
      <span className="font-medium text-muted-foreground">
        {t("tasks.attempts.title")}:
      </span>
      {attempts.map((a, i) => (
        <span key={a.n} className="flex items-center gap-x-1.5">
          {i > 0 && <span className="text-muted-foreground">→</span>}
          <span className={ATTEMPT_STATUS_CLASSES[a.status]}>
            {t("tasks.attempts.count", { n: a.n })}{" "}
            {attemptStatusLabel(a.status)}
            {a.status === "failed" && a.error ? ` ${a.error}` : ""}
            {a.status === "done" && a.hash ? ` ${a.hash}` : ""}
          </span>
        </span>
      ))}
    </div>
  );
}

export default function TaskPanel({
  tasks,
  loading,
  error,
  commandSending,
  canControl,
  readOnly,
  messages,
  members,
  expandedTaskId,
  liveOutputs,
  rollbackStates,
  onToggleExpand,
  onStop,
  onRollback,
}: TaskPanelProps) {
  return (
    <div data-testid="task-panel" className="shrink-0 border-b px-4 py-3">
      <span className="text-xs font-medium text-muted-foreground">
        {t("tasks.title", { count: tasks.length })}
      </span>
      <div className="mt-2">
        {error && <p className="mb-2 text-xs text-red-600">{error}</p>}
        {loading ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("tasks.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {tasks.map((task) => {
              const executor =
                members.find(
                  (m) => m.participantId === task.executorParticipantId,
                )?.name ??
                task.executorKey ??
                "—";
              const preview = taskMessagePreview(task, messages);
              const detail = diffSummaryDetail(task.diffSummary);
              const busy = commandSending === task.id;
              const expanded = expandedTaskId === task.id;
              const rollbackState = rollbackStates[task.id];
              const rolling = rollbackState === "rolling";
              const rollbackDone = rollbackState === "done";
              const canStop =
                task.status === "queued" || task.status === "running";
              const canRollback =
                (task.status === "done" || task.status === "failed") &&
                Boolean(task.checkpointRef);
              // 实时输出:WS 缓冲优先,includeOutput 兜底(未展开任务无缓冲)。
              const outputText = liveOutputs[task.id] ?? task.outputTail ?? "";
              return (
                <li
                  key={task.id}
                  data-testid={`task-row-${task.id}`}
                  className="rounded-md border bg-muted/30 px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <button
                      type="button"
                      data-testid={`task-expand-${task.id}`}
                      aria-expanded={expanded}
                      onClick={() => onToggleExpand(task)}
                      className="inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      title={expanded ? t("tasks.collapse") : t("tasks.expand")}
                    >
                      {expanded ? "▾" : "▸"}
                    </button>
                    <span
                      data-testid={`task-status-${task.id}`}
                      data-status={task.status}
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${TASK_PANEL_STATUS_CLASSES[task.status]}`}
                    >
                      {taskStatusLabel(task.status)}
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
                        <ControlButton
                          size="sm"
                          variant="outline"
                          data-testid={`task-stop-${task.id}`}
                          disabled={busy}
                          canControl={canControl}
                          readOnly={readOnly}
                          onClick={() => onStop(task)}
                        >
                          {busy ? t("common.sending") : t("tasks.stop")}
                        </ControlButton>
                      )}
                      {canRollback && (
                        <ControlButton
                          size="sm"
                          variant="outline"
                          data-testid={`task-rollback-${task.id}`}
                          disabled={busy || rolling || rollbackDone}
                          canControl={canControl}
                          readOnly={readOnly}
                          onClick={() => onRollback(task)}
                        >
                          {rolling
                            ? t("tasks.rollbacking")
                            : rollbackDone
                              ? t("tasks.rollbackDone")
                              : t("tasks.rollback")}
                        </ControlButton>
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
                  {expanded && (
                    <div className="mt-2 space-y-2">
                      <AttemptTimeline attempts={task.attempts ?? []} />
                      <div>
                        <p className="mb-1 text-xs font-medium text-muted-foreground">
                          {t("tasks.output.title")}
                        </p>
                        <LiveOutput text={outputText} />
                      </div>
                    </div>
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
