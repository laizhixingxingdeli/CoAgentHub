/**
 * 沟通记录时间线(UI-04b-1):把一条需求下的任务与消息合并成一条按时间正序的
 * 流来渲染 —— 左侧角色色头像 + 右侧白底卡片。
 *
 *  - 消息卡片(本票新增):正文取消息 body,头部显示「发送者 → 定向对象」;
 *    发送者角色读 Member.roles(真实数据),软删除消息渲染为灰色占位。
 *  - 任务卡片(保持现状):正文取执行器结构化汇报(task.diffSummary,运行时
 *    形状 = server 的 TaskReport:summary/hash/tests/todo/tokenUsage,外加
 *    retries/outputTail/error 等);失败任务(status=failed)额外渲染一条
 *    醒目但不喧宾夺主的失败条(颜色走 --status-* token)。
 *
 * 角色判断:优先用成员真实角色 —— 消息卡片按 senderId 找 Member 读 roles;
 * 任务卡片按 executorParticipantId 找 Member 读 roles(该字段是任务执行者的
 * 精确 participantId,比 executorKey 字符串匹配可靠)。关联不上才回落到
 * roleFromExecutorKey 的字符串猜测(刻意保留,有测试覆盖)。
 *
 * 长内容(tests/todo 超过 80 字、或存在 outputTail 实时输出尾、或消息 body
 * 超过 200 字)不默认铺开,收进一个可点击的「展开」入口(受控状态,先不做
 * 动画过渡)。
 */

import { useMemo, useState } from "react";
import { LiveOutput } from "@/components/live-output";
import { lastNonEmptyLine } from "@/lib/output-buffer";
import { formatMessageTime, TASK_STATUS_CLASSES } from "@/pages/app/groups/messages/lib";
import type { TaskItem } from "@/pages/app/groups/messages/TaskPanel";
import { TASK_UNCONFIRMED_CLASSES } from "@/pages/app/groups/messages/TaskPanel";
import {
  FOLD_PREVIEW_LENGTH as MESSAGE_FOLD_PREVIEW_LENGTH,
  FOLD_THRESHOLD as MESSAGE_FOLD_THRESHOLD,
  type Member,
  type MessageItem,
} from "@/pages/app/groups/messages/types";
import {
  mergeRequirementTimeline,
  type TimelineEvent,
} from "./merge-requirement-timeline";

/** 视觉分色用的角色档位(不是后端权威角色,仅用于头像配色)。 */
export type TimelineRole = "coordinator" | "reviewer" | "executor";

/** executorKey 字符串 → 角色档位(大小写不敏感;null/未知按执行者)。
 * 刻意保留的回落实现(有测试覆盖):成员真实角色关联不上时才用它。 */
export function roleFromExecutorKey(executorKey: string | null): TimelineRole {
  const key = (executorKey ?? "").toLowerCase();
  if (key.includes("coordinator")) return "coordinator";
  if (key.includes("reviewer")) return "reviewer";
  return "executor";
}

/** Member.roles → 角色档位(协调者 > 检视者 > 执行者 优先级;都不含 → null,
 * 由调用方决定回落)。human/observer/specialist 等角色不在三档内 → null。 */
export function roleFromMemberRoles(
  roles: string[] | undefined,
): TimelineRole | null {
  if (!roles) {
    return null;
  }
  const lower = roles.map((r) => r.toLowerCase());
  if (lower.includes("coordinator")) return "coordinator";
  if (lower.includes("reviewer")) return "reviewer";
  if (lower.includes("executor")) return "executor";
  return null;
}

/** 头像底色:引用 --role-* token(index.css 已注册),不硬编码十六进制。 */
const ROLE_AVATAR_CLASS: Record<TimelineRole, string> = {
  coordinator: "bg-role-coordinator",
  reviewer: "bg-role-reviewer",
  executor: "bg-role-executor",
};

/** 超过该字数的 tests/todo 视为长内容 → 收进「展开」。 */
const FOLD_THRESHOLD = 80;

/** 从 diffSummary 取非空字符串字段(diffSummary 是 unknown 记录,需运行时判型)。 */
function readText(
  diffSummary: Record<string, unknown> | null,
  key: string,
): string | null {
  if (!diffSummary || typeof diffSummary !== "object") {
    return null;
  }
  const value = diffSummary[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

type RequirementTimelineProps = {
  /** 一个需求下的所有任务(mergeRequirementTimeline 内部按时间排序)。 */
  tasks: TaskItem[];
  /** 该群全部消息;缺省为空 → 只渲染任务(保持旧行为)。 */
  messages?: MessageItem[];
  /** 该群成员(真实角色数据源);缺省为空 → 角色回落字符串猜测。 */
  members?: Member[];
  /** 实时输出缓冲(taskId → 已接收的 WS chunk 拼接)。running 任务折叠态
   * 取最后非空行预览,展开态显示全量输出;缺省为空 → 回落
   * diffSummary.outputTail(与 TaskPanel 的取值优先级一致)。 */
  liveOutputs?: Record<string, string>;
};

export default function RequirementTimeline({
  tasks,
  messages = [],
  members = [],
  liveOutputs = {},
}: RequirementTimelineProps) {
  // 展开的卡片 id 集合(长内容折叠;多张卡片可同时展开)。
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggle = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const events = useMemo(
    () => mergeRequirementTimeline(tasks, messages, members),
    [tasks, messages, members],
  );

  if (events.length === 0) {
    return null;
  }

  const renderMessage = (event: Extract<TimelineEvent, { kind: "message" }>) => {
    const { message, sender, target, softDeleted } = event;
    const role = roleFromMemberRoles(sender?.roles) ?? "executor";
    const longBody = message.body.length > MESSAGE_FOLD_THRESHOLD;
    const preview = longBody
      ? `${message.body.slice(0, MESSAGE_FOLD_PREVIEW_LENGTH)}…`
      : message.body;
    const expanded = expandedIds.has(message.id);
    return (
      <li
        key={message.id}
        data-testid={`requirement-timeline-item-${message.id}`}
        className="flex gap-2"
      >
        <span
          data-testid={`requirement-timeline-avatar-${message.id}`}
          data-role={role}
          aria-hidden="true"
          className={`mt-0.5 size-8 shrink-0 rounded-lg ${ROLE_AVATAR_CLASS[role]}`}
        />
        <div className="min-w-0 flex-1 rounded-xl border bg-card px-3 py-2">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-xs font-medium">
              {/* 发送者名:复用事件已解析的 sender(memberById 查找结果),未
                  命中成员时回落 senderId 前缀(与消息流一致)。 */}
              {sender?.name ?? message.senderId.slice(0, 8)}
            </span>
            {target && (
              <span
                data-testid={`requirement-timeline-target-${message.id}`}
                className="shrink-0 text-xs text-muted-foreground"
              >
                → {target.name}
              </span>
            )}
            <span
              data-testid={`requirement-timeline-time-${message.id}`}
              className="ml-auto shrink-0 text-xs text-muted-foreground"
            >
              {formatMessageTime(message.createdAt)}
            </span>
          </div>
          {softDeleted ? (
            <p
              data-testid={`requirement-timeline-deleted-${message.id}`}
              className="mt-1 text-xs italic text-muted-foreground"
            >
              消息已删除
            </p>
          ) : (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {preview}
            </p>
          )}
          {!softDeleted && longBody && (
            <button
              type="button"
              data-testid={`requirement-timeline-toggle-${message.id}`}
              aria-expanded={expanded}
              onClick={() => toggle(message.id)}
              className="mt-1.5 text-xs font-medium text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              {expanded ? "收起" : "展开"}
            </button>
          )}
          {!softDeleted && longBody && expanded && (
            <div
              data-testid={`requirement-timeline-detail-${message.id}`}
              className="mt-1.5 border-t pt-1.5"
            >
              <p className="whitespace-pre-wrap break-words text-sm">
                {message.body}
              </p>
            </div>
          )}
        </div>
      </li>
    );
  };

  const renderTask = (event: Extract<TimelineEvent, { kind: "task" }>) => {
    const { task } = event;
    // 优先用成员真实角色:executorParticipantId 是任务执行者的精确 participant
    // id,命中即读 Member.roles;关联不上才回落 executorKey 字符串猜测。
    const executorMember =
      members.find((m) => m.participantId === task.executorParticipantId) ??
      null;
    const role =
      roleFromMemberRoles(executorMember?.roles) ??
      roleFromExecutorKey(task.executorKey);
    const summary = readText(task.diffSummary, "summary");
    const hash = readText(task.diffSummary, "hash");
    const tests = readText(task.diffSummary, "tests");
    const todo = readText(task.diffSummary, "todo");
    const outputTail = readText(task.diffSummary, "outputTail");
    const errorText = readText(task.diffSummary, "error");
    // 实时输出:WS 缓冲优先,includeOutput/diffSummary.outputTail 兜底(与
    // TaskPanel.tsx:277 同一优先级);展开态复用共享 LiveOutput 终端块。
    const outputText = liveOutputs[task.id] ?? outputTail ?? "";
    // 折叠态预览:最后一非空行(执行器输出常有空行/纯空白行),无输出则
    // 不显示该行(不留空占位)。仅 running 任务显示 —— done/failed 折叠态
    // 维持汇报摘要/失败原因(设计表),不额外铺输出预览。
    const previewLine =
      task.status === "running" ? lastNonEmptyLine(outputText) : null;
    const testsLong = tests !== null && tests.length > FOLD_THRESHOLD;
    const todoLong = todo !== null && todo.length > FOLD_THRESHOLD;
    const foldable = testsLong || todoLong || outputText.length > 0;
    const expanded = expandedIds.has(task.id);
    // 失败任务:失败条(醒目但不喧宾夺主,颜色走 --status-* token);结果未确认
    // (failed + diffSummary.unconfirmed)用琥珀色,与任务面板的语义一致。
    const failed = task.status === "failed";
    const unconfirmed = task.diffSummary?.unconfirmed === true;
    // 这条「消息」的发生时间:汇报在任务结束时落库,updatedAt 更贴近汇报
    // 时刻;老数据 updatedAt 可能为 null,回退 createdAt。
    const timestamp = task.updatedAt ?? task.createdAt;
    return (
      <li
        key={task.id}
        data-testid={`requirement-timeline-item-${task.id}`}
        className="flex gap-2"
      >
        <span
          data-testid={`requirement-timeline-avatar-${task.id}`}
          data-role={role}
          aria-hidden="true"
          className={`mt-0.5 size-8 shrink-0 rounded-lg ${ROLE_AVATAR_CLASS[role]}`}
        />
        <div className="min-w-0 flex-1 rounded-xl border bg-card px-3 py-2">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-xs font-medium">
              {task.executorKey ?? "—"}
            </span>
            <span
              data-testid={`requirement-timeline-time-${task.id}`}
              className="ml-auto shrink-0 text-xs text-muted-foreground"
            >
              {formatMessageTime(timestamp)}
            </span>
          </div>
          {failed && (
            <p
              data-testid={`requirement-timeline-failed-${task.id}`}
              className={`mt-1.5 rounded-md border px-2 py-1 text-xs ${
                unconfirmed ? TASK_UNCONFIRMED_CLASSES : TASK_STATUS_CLASSES.failed
              }`}
            >
              {unconfirmed ? "结果未确认" : "任务失败"}
              {errorText ? `: ${errorText}` : ""}
            </p>
          )}
          <p className="mt-1 whitespace-pre-wrap break-words text-sm">
            {summary ?? (
              <span className="text-muted-foreground">暂无汇报内容</span>
            )}
          </p>
          {hash && (
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              提交 {hash.slice(0, 12)}
            </p>
          )}
          {tests && (
            <p
              data-testid={`requirement-timeline-tests-${task.id}`}
              className="mt-1 text-xs text-muted-foreground"
            >
              测试{" "}
              {testsLong ? `${tests.slice(0, FOLD_THRESHOLD)}…` : tests}
            </p>
          )}
          {todo && !todoLong && (
            <p className="mt-1 text-xs text-muted-foreground">
              遗留 {todo}
            </p>
          )}
          {/* 折叠态实时输出预览:最后一非空行,单行省略;无输出不占位。 */}
          {previewLine && (
            <p
              data-testid={`requirement-timeline-live-preview-${task.id}`}
              className="mt-1 truncate font-mono text-xs text-muted-foreground"
              title={previewLine}
            >
              {previewLine}
            </p>
          )}
          {foldable && (
            <button
              type="button"
              data-testid={`requirement-timeline-toggle-${task.id}`}
              aria-expanded={expanded}
              onClick={() => toggle(task.id)}
              className="mt-1.5 text-xs font-medium text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              {expanded ? "收起" : "展开"}
            </button>
          )}
          {foldable && expanded && (
            <div
              data-testid={`requirement-timeline-detail-${task.id}`}
              className="mt-1.5 space-y-1.5 border-t pt-1.5"
            >
              {testsLong && tests && (
                <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                  测试 {tests}
                </p>
              )}
              {todoLong && todo && (
                <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                  遗留 {todo}
                </p>
              )}
              {outputText && <LiveOutput text={outputText} />}
            </div>
          )}
        </div>
      </li>
    );
  };

  return (
    <ul data-testid="requirement-timeline" className="flex flex-col gap-3">
      {events.map((event) =>
        event.kind === "message" ? renderMessage(event) : renderTask(event),
      )}
    </ul>
  );
}
