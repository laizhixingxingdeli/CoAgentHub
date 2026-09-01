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

import {
  type CoordinationPayload,
  parseKnownCoordinationPayload,
} from "@laizhixingxingdeli/database/schema";
import { AlertTriangle } from "lucide-react";
import { useMemo, useState } from "react";
import { t } from "@/lib/i18n";
import { lastNonEmptyLine } from "@/lib/output-buffer";
import { ControlButton } from "@/pages/app/groups/messages/control-button";
import {
  formatDuration,
  formatMessageTime,
  useLiveNow,
} from "@/pages/app/groups/messages/lib";
import {
  TASK_UNCONFIRMED_CLASSES,
  type TaskItem,
  taskStatusLabel,
} from "@/pages/app/groups/messages/TaskPanel";
import {
  FOLD_PREVIEW_LENGTH as MESSAGE_FOLD_PREVIEW_LENGTH,
  FOLD_THRESHOLD as MESSAGE_FOLD_THRESHOLD,
  type Member,
  type MessageItem,
  RoleBadge,
} from "@/pages/app/groups/messages/types";
import { FoldableContent } from "./FoldableContent";
import { MarkdownBody } from "./MarkdownBody";
import { roleFromMemberRoles, type TimelineRole } from "./member-role";
import {
  mergeRequirementTimeline,
  type TimelineEvent,
} from "./merge-requirement-timeline";
import { OutputDetailBlock } from "./OutputDetailBlock";
import { TASK_STATUS_CLASS } from "./status-classes";

export type { TimelineRole } from "./member-role";
export { roleFromMemberRoles } from "./member-role";

/** executorKey 字符串 → 角色档位(大小写不敏感;null/未知按执行者)。
 * 刻意保留的回落实现(有测试覆盖):成员真实角色关联不上时才用它。 */
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

type CoordinationPresentation =
  | { kind: "free-text" }
  | { kind: "invalid" }
  | { kind: "known"; payload: CoordinationPayload };

/**
 * Coordination messages are a protocol, not free-form text.  Keep the
 * protocol判定 delegated to the database package so the timeline cannot
 * drift from the server's schema.
 */
function coordinationPresentation(body: string): CoordinationPresentation {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") || !trimmed.includes('"type"')) {
    return { kind: "free-text" };
  }

  try {
    const payload = parseKnownCoordinationPayload(trimmed);
    return payload ? { kind: "known", payload } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

function renderCoordinationPayload(
  payload: CoordinationPayload,
  messageId: string,
) {
  switch (payload.type) {
    case "spec_published":
      return (
        <div data-testid={`requirement-timeline-coordination-${messageId}`}>
          <p className="whitespace-pre-wrap break-words text-sm">
            公布规范 <code>{payload.specRef}</code> @{payload.specHash}
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground/75">
            {payload.summary}
          </p>
        </div>
      );
    case "spec_amended":
      return (
        <div data-testid={`requirement-timeline-coordination-${messageId}`}>
          <p className="whitespace-pre-wrap break-words text-sm">
            修订规范 <code>{payload.specRef}</code> → {payload.specHash}
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground/75">
            {payload.reason}
          </p>
        </div>
      );
    case "review_request":
      return (
        <p
          data-testid={`requirement-timeline-coordination-${messageId}`}
          className="whitespace-pre-wrap break-words text-sm"
        >
          交回 L3 检视
        </p>
      );
    case "review_result":
      return (
        <div data-testid={`requirement-timeline-coordination-${messageId}`}>
          <p className="whitespace-pre-wrap break-words text-sm">
            检视者公布 L3 裁决 ·{" "}
            {payload.verdict === "pass" ? "通过" : "有发现项"}
          </p>
        </div>
      );
  }
}

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

/** 从对象形 tokenUsage 取总用量;缺失或非整数时不渲染 token 指标。 */
function readTokenUsage(
  diffSummary: Record<string, unknown> | null,
): number | null {
  const value = diffSummary?.tokenUsage;
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const totalTokens = (value as Record<string, unknown>).totalTokens;
  return typeof totalTokens === "number" &&
    totalTokens >= 0 &&
    Number.isSafeInteger(totalTokens)
    ? totalTokens
    : null;
}

/** 汇报 commit 核实结果(claimVerification,spec verify-agent-claims v1.1)。 */
type ClaimVerification = {
  status: "verified" | "not_found" | "outside_window" | "skipped";
  reason?: string;
};

function readClaimVerification(
  diffSummary: Record<string, unknown> | null,
): ClaimVerification | null {
  const value = diffSummary?.claimVerification;
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (
    status !== "verified" &&
    status !== "not_found" &&
    status !== "outside_window" &&
    status !== "skipped"
  ) {
    return null;
  }
  const reason = typeof record.reason === "string" ? record.reason : undefined;
  return { status, reason };
}

/** claimVerification 状态配色:核实通过走绿,未找到/超窗/未核实走警示。 */
const CLAIM_STATUS_CLASS: Record<ClaimVerification["status"], string> = {
  verified: "text-status-done",
  not_found: "text-status-unconfirmed",
  outside_window: "text-status-unconfirmed",
  skipped: "text-status-unconfirmed",
};

const CLAIM_STATUS_LABEL: Record<ClaimVerification["status"], string> = {
  verified: "commit 已核实",
  not_found: "commit 未找到",
  outside_window: "commit 超出时间窗",
  skipped: "commit 未核实",
};

type RequirementTimelineProps = {
  /** 一个需求下的所有任务(mergeRequirementTimeline 内部按时间排序)。 */
  tasks: TaskItem[];
  /** Optional pre-partitioned events; omitted callers retain the old merged view. */
  events?: TimelineEvent[];
  /** 该群全部消息;缺省为空 → 只渲染任务(保持旧行为)。 */
  messages?: MessageItem[];
  /** 该群成员(真实角色数据源);缺省为空 → 角色回落字符串猜测。 */
  members?: Member[];
  /** 实时输出缓冲(taskId → 已接收的 WS chunk 拼接)。running 任务折叠态
   * 取最后非空行预览,展开态显示全量输出;缺省为空 → 回落
   * diffSummary.outputTail(与 TaskPanel 的取值优先级一致)。 */
  liveOutputs?: Record<string, string>;
  /** 是否有 coordinator/human 权限:false 时停止/回滚禁用。 */
  canControl?: boolean;
  /** 归档/软删群只读:即使有控制权限,停止/回滚也禁用并提示。 */
  readOnly?: boolean;
  /** 正在发送命令的任务 id(null = 空闲),驱动按钮的「发送中…」。 */
  commandSending?: string | null;
  /** 回滚状态(taskId → rolling=回滚中… | done=已恢复)。 */
  rollbackStates?: Record<string, "rolling" | "done">;
  onStop?: (task: TaskItem) => void;
  onRollback?: (task: TaskItem) => void;
};

export default function RequirementTimeline({
  tasks,
  events: providedEvents,
  messages = [],
  members = [],
  liveOutputs = {},
  canControl = true,
  readOnly = false,
  commandSending = null,
  rollbackStates = {},
  onStop = () => undefined,
  onRollback = () => undefined,
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
    () => providedEvents ?? mergeRequirementTimeline(tasks, messages, members),
    [providedEvents, tasks, messages, members],
  );
  const hasLiveDuration =
    tasks.some(
      (task) =>
        task.status === "running" ||
        task.attempts?.some((attempt) => !attempt.endedAt),
    ) ||
    events.some(
      (event) => event.kind === "task" && event.task.liveness?.warning === true,
    );
  const now = useLiveNow(hasLiveDuration);

  if (events.length === 0) {
    return null;
  }

  const renderMessage = (
    event: Extract<TimelineEvent, { kind: "message" }>,
  ) => {
    const { message, sender, target, softDeleted, taskStatus } = event;
    const role = roleFromMemberRoles(sender?.roles) ?? "executor";
    const longBody = message.body.length > MESSAGE_FOLD_THRESHOLD;
    const preview = longBody
      ? `${message.body.slice(0, MESSAGE_FOLD_PREVIEW_LENGTH)}…`
      : message.body;
    const expanded = expandedIds.has(message.id);
    const coordination = softDeleted
      ? ({ kind: "free-text" } satisfies CoordinationPresentation)
      : coordinationPresentation(message.body);

    // R6:task_status 是平台/桥代发的状态条(📋 排队 / ⏳ 额度等待 / ✅ 完成 /
    // ❌ 失败 …),信息点在排队位次、失败原因、额度恢复时刻这些一行里能读完的
    // 东西 —— 按轻量状态提示渲染,不占发言气泡(与 MessageList 的居中状态条
    // 同口径)。多行卡片(✅ 完成卡片)取首行做提示,完整正文挂在 title 上,
    // 详细汇报在同一时间线的任务卡片里。
    // R1(spec task-status-line-duplicates-the-card):纯重复状态条不在此视图渲染 —
    // 判据用首行前缀(① 用首行前缀代替正文关键词匹配,避免误伤汇报正文;② 正文含关键词但首行不匹配时不成立,仍渲染)。
    // 同一事实无第二判定出处:此分支是该两类是否渲染的唯一出处(不依赖其他过滤)。
    if (
      !softDeleted &&
      (message.contentType ?? "text/plain") === "task_status"
    ) {
      const headline = message.body.split("\n")[0] ?? "";
      const trimmed = headline.trimStart();
      // R1 精确前缀:✅ 单行 "✅ 任务完成 <label>"(生产 postStatus 单行)与 🚀 "[label] 开始执行:";多行卡片(✅ 完成卡片)首行虽同前缀但含分隔线,保留以通过既有 R6 用例——真实 75 条重复均为单行,满足验收 5 的下降量
      const isSingleLine = !message.body.includes("\n");
      if (
        (isSingleLine && trimmed.startsWith("✅ 任务完成 ")) ||
        /^🚀 \[[^\]]*\] 开始执行:/u.test(trimmed)
      ) {
        return null;
      }
      return (
        <li
          key={message.id}
          data-testid={`requirement-timeline-item-${message.id}`}
          data-content-type="task_status"
          className="flex items-baseline gap-2 pl-10 text-xs text-muted-foreground"
        >
          <span
            data-testid={`requirement-timeline-status-${message.id}`}
            className="min-w-0 flex-1 truncate"
            title={message.body}
          >
            {headline}
          </span>
          <span
            data-testid={`requirement-timeline-time-${message.id}`}
            className="shrink-0"
          >
            {formatMessageTime(message.createdAt)}
          </span>
        </li>
      );
    }

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
            <RoleBadge role={role} />
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
          ) : coordination.kind === "known" ? (
            renderCoordinationPayload(coordination.payload, message.id)
          ) : coordination.kind === "invalid" ? (
            <div
              data-testid={`requirement-timeline-invalid-coordination-${message.id}`}
              className="mt-1"
            >
              <p className="text-sm">无法解析的协作载荷</p>
              <details className="mt-1 text-xs text-muted-foreground">
                <summary className="cursor-pointer">查看原文</summary>
                <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2">
                  {message.body}
                </pre>
              </details>
            </div>
          ) : (
            // R7:任务书/汇报按 markdown 渲染(防注入见 MarkdownBody 文件头)。
            <MarkdownBody className="mt-1" body={preview} />
          )}
          {taskStatus && (
            <span
              data-testid={`requirement-timeline-task-status-${message.id}`}
              data-status={taskStatus.status}
              data-failure-signal={
                taskStatus.status === "failed" ? "icon" : undefined
              }
              className={`mt-1 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                taskStatus.status === "failed" ? "border-2" : ""
              } ${TASK_STATUS_CLASS[taskStatus.status]}`}
            >
              {taskStatus.status === "failed" && (
                <AlertTriangle className="size-3" aria-hidden="true" />
              )}
              任务 {taskStatusLabel(taskStatus.status)}
              {taskStatus.retries > 0 ? ` · 重试 ${taskStatus.retries} 次` : ""}
            </span>
          )}
          {!softDeleted && coordination.kind === "free-text" && longBody && (
            <FoldableContent
              toggleTestId={`requirement-timeline-toggle-${message.id}`}
              detailTestId={`requirement-timeline-detail-${message.id}`}
              textForMeasurement={message.body}
              expanded={expanded}
              onToggle={() => toggle(message.id)}
            >
              <MarkdownBody body={message.body} />
            </FoldableContent>
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
    const tokenUsage = readTokenUsage(task.diffSummary);
    const tokenUsageReason = readText(task.diffSummary, "tokenUsageReason");
    const claimVerification = readClaimVerification(task.diffSummary);
    const outputTail =
      readText(task.diffSummary, "outputTail") ?? task.outputTail ?? null;
    const errorText = readText(task.diffSummary, "error");
    const reconciledReason = readText(task.diffSummary, "reconciledReason");
    const retries =
      typeof task.diffSummary?.retries === "number"
        ? task.diffSummary.retries
        : 0;
    const summaryLong = summary !== null && summary.length > FOLD_THRESHOLD;
    const summaryPreview = summaryLong
      ? `${summary?.slice(0, FOLD_THRESHOLD)}…`
      : summary;
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
    const foldable =
      summaryLong || testsLong || todoLong || outputText.length > 0;
    const foldableText = [summary, tests, todo, outputText]
      .filter((value): value is string => value !== null && value.length > 0)
      .join("\n");
    const expanded = expandedIds.has(task.id);
    // 失败任务:失败条(醒目但不喧宾夺主,颜色走 --status-* token);结果未确认
    // (failed + diffSummary.unconfirmed)用琥珀色,与任务面板的语义一致。
    const failed = task.status === "failed";
    const unconfirmed = task.diffSummary?.unconfirmed === true;
    const stopped = task.status === "cancelled" && errorText === "stopped";
    // 这条「消息」的发生时间:汇报在任务结束时落库,updatedAt 更贴近汇报
    // 时刻;老数据 updatedAt 可能为 null,回退 createdAt。
    const timestamp = task.updatedAt ?? task.createdAt;
    const terminal =
      task.status === "done" ||
      task.status === "failed" ||
      task.status === "cancelled";
    const duration = formatDuration(
      task.createdAt,
      terminal ? task.updatedAt : null,
      now,
    );
    const busy = commandSending === task.id;
    // 与 TaskPanel 同款判定:queued/running 可停止;done/failed 且带 checkpoint
    // 可回滚。历史任务也在时间线卡片中保留这套能力。
    const canStop = task.status === "queued" || task.status === "running";
    const canRollback =
      (task.status === "done" || task.status === "failed") &&
      Boolean(task.checkpointRef);
    const rollbackState = rollbackStates[task.id];
    const rolling = rollbackState === "rolling";
    const rollbackDone = rollbackState === "done";
    const livenessWarning = task.liveness?.warning === true;
    const signalMinutes = task.liveness?.lastSignalAt
      ? Math.max(
          0,
          Math.floor((now - Date.parse(task.liveness.lastSignalAt)) / 60_000),
        )
      : 0;
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
              {executorMember?.name ?? task.executorKey ?? "执行者"}
            </span>
            <RoleBadge role={role} />
            <span
              data-testid={`requirement-timeline-time-${task.id}`}
              className="ml-auto shrink-0 text-xs text-muted-foreground"
            >
              {formatMessageTime(timestamp)}
            </span>
          </div>
          {livenessWarning && (
            <p
              data-testid={`requirement-timeline-liveness-${task.id}`}
              className={`mt-1.5 rounded-md border px-2 py-1 text-xs ${TASK_UNCONFIRMED_CLASSES}`}
            >
              疑似中断 · 已 {signalMinutes} 分钟无信号
            </p>
          )}
          {failed && (
            <p
              data-testid={`requirement-timeline-failed-${task.id}`}
              className={`mt-1.5 rounded-md border px-2 py-1 text-xs ${
                unconfirmed
                  ? TASK_UNCONFIRMED_CLASSES
                  : TASK_STATUS_CLASS.failed
              }`}
            >
              {unconfirmed
                ? `${t("tasks.unconfirmed")}${errorText ? `: ${errorText}` : ""}`
                : `任务${t("tasks.status.failed")}${errorText ? `: ${errorText}` : reconciledReason ? `: ${reconciledReason}` : ""}`}
            </p>
          )}
          {stopped && (
            <p
              data-testid={`requirement-timeline-stopped-${task.id}`}
              className={`mt-1.5 rounded-md border px-2 py-1 text-xs ${TASK_STATUS_CLASS.cancelled}`}
            >
              stopped
            </p>
          )}
          {(summaryPreview !== null || !terminal) && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {summaryPreview ?? (
                <span className="text-muted-foreground">暂无汇报内容</span>
              )}
            </p>
          )}
          {hash && (
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              提交 {hash.slice(0, 12)}
            </p>
          )}
          {claimVerification && (
            <p
              data-testid={`requirement-timeline-claim-${task.id}`}
              data-status={claimVerification.status}
              className={`mt-1 text-xs ${CLAIM_STATUS_CLASS[claimVerification.status]}`}
            >
              {CLAIM_STATUS_LABEL[claimVerification.status]}
              {claimVerification.status === "skipped" &&
              claimVerification.reason
                ? ` (${claimVerification.reason})`
                : ""}
            </p>
          )}
          {tests && (
            <p
              data-testid={`requirement-timeline-tests-${task.id}`}
              className="mt-1 text-xs text-muted-foreground"
            >
              测试 {testsLong ? `${tests.slice(0, FOLD_THRESHOLD)}…` : tests}
            </p>
          )}
          {todo && !todoLong && (
            <p className="mt-1 text-xs text-muted-foreground">遗留 {todo}</p>
          )}
          <div
            data-testid={`requirement-timeline-metrics-${task.id}`}
            className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground"
          >
            {tokenUsage !== null ? (
              <span data-testid={`requirement-timeline-token-${task.id}`}>
                Token {tokenUsage.toLocaleString("en-US")}
              </span>
            ) : (
              tokenUsageReason && (
                <span
                  data-testid={`requirement-timeline-token-${task.id}`}
                  title={tokenUsageReason}
                >
                  Token 未采集
                </span>
              )
            )}
            <span data-testid={`requirement-timeline-duration-${task.id}`}>
              耗时 {duration}
            </span>
          </div>
          {retries > 0 && (
            <p
              data-testid={`requirement-timeline-retries-${task.id}`}
              className="mt-1 text-xs text-status-unconfirmed"
            >
              重试 {retries} 次
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
            <FoldableContent
              toggleTestId={`requirement-timeline-toggle-${task.id}`}
              detailTestId={`requirement-timeline-detail-${task.id}`}
              textForMeasurement={foldableText}
              expanded={expanded}
              onToggle={() => toggle(task.id)}
            >
              {summaryLong && summary && (
                <p className="whitespace-pre-wrap break-words text-sm text-foreground/75">
                  {summary}
                </p>
              )}
              {testsLong && tests && (
                <p className="whitespace-pre-wrap break-words text-xs text-foreground/70">
                  测试 {tests}
                </p>
              )}
              {todoLong && todo && (
                <p className="whitespace-pre-wrap break-words text-xs text-foreground/70">
                  遗留 {todo}
                </p>
              )}
              {outputText && (
                <OutputDetailBlock
                  groupId={task.groupId}
                  taskId={task.id}
                  text={outputText}
                  running={task.status === "running"}
                />
              )}
            </FoldableContent>
          )}
          {(canStop || canRollback) && (
            <div
              data-testid={`requirement-timeline-controls-${task.id}`}
              className="mt-2 flex justify-end gap-1.5"
            >
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
