/**
 * 沟通记录时间线(UI-04b-1):把一条需求下的任务(已按 createdAt 升序)渲染成
 * 一列消息卡片 —— 左侧角色色头像 + 右侧白底卡片,卡片正文取执行器结构化汇报
 * (task.diffSummary,运行时形状 = server 的 TaskReport:summary/hash/tests/
 * todo/tokenUsage,外加 retries/outputTail/error 等)。
 *
 * 角色判断是刻意的简化:任务行(TaskItem)没有「角色」字段,这里用 executorKey
 * 的字符串做映射(含 coordinator → 协调者色,含 reviewer → 检视者色,其余按
 * 执行者色),颜色全部走 index.css 已注册的 --role-* token。为了「完美角色识别」
 * 去改后端不在本票范围内。
 *
 * 长内容(tests/todo 超过 80 字、或存在 outputTail 实时输出尾)不默认铺开,
 * 收进一个可点击的「展开」入口(受控状态,先不做动画过渡)。
 */

import { useState } from "react";
import { formatMessageTime } from "@/pages/app/groups/messages/lib";
import type { TaskItem } from "@/pages/app/groups/messages/TaskPanel";

/** 视觉分色用的角色档位(不是后端权威角色,仅用于头像配色)。 */
export type TimelineRole = "coordinator" | "reviewer" | "executor";

/** executorKey 字符串 → 角色档位(大小写不敏感;null/未知按执行者)。 */
export function roleFromExecutorKey(executorKey: string | null): TimelineRole {
  const key = (executorKey ?? "").toLowerCase();
  if (key.includes("coordinator")) return "coordinator";
  if (key.includes("reviewer")) return "reviewer";
  return "executor";
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
  /** 一个需求下的所有任务,已按 createdAt 升序(Requirement.tasks 的约定)。 */
  tasks: TaskItem[];
};

export default function RequirementTimeline({
  tasks,
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

  if (tasks.length === 0) {
    return null;
  }

  return (
    <ul data-testid="requirement-timeline" className="flex flex-col gap-3">
      {tasks.map((task) => {
        const role = roleFromExecutorKey(task.executorKey);
        const summary = readText(task.diffSummary, "summary");
        const hash = readText(task.diffSummary, "hash");
        const tests = readText(task.diffSummary, "tests");
        const todo = readText(task.diffSummary, "todo");
        const outputTail = readText(task.diffSummary, "outputTail");
        const testsLong = tests !== null && tests.length > FOLD_THRESHOLD;
        const todoLong = todo !== null && todo.length > FOLD_THRESHOLD;
        const foldable = testsLong || todoLong || outputTail !== null;
        const expanded = expandedIds.has(task.id);
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
                  {outputTail && (
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted px-2 py-1.5 font-mono text-xs leading-relaxed">
                      {outputTail}
                    </pre>
                  )}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
