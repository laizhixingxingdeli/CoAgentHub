import { existsSync } from "node:fs";
import { zValidator } from "@hono/zod-validator";
import {
  type CoordinationPayload,
  normalizeReviewRequestDiffSummary,
  parseKnownCoordinationPayload,
  REVIEW_REQUEST_EXAMPLE,
  TASK_STATUSES,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import BizError, { BizCodeEnum } from "@laizhixingxingdeli/error/biz";
import type { DataBase } from "@server/lib/database";
import {
  getDetachedTaskLiveness,
  isDetachedTask,
} from "@server/lib/detached-task-liveness";
import { findRepoRoot } from "@server/lib/executor-runner";
import {
  createTaskDispatchWarnings,
  getL3ResponseMinutesMs,
  isTerminalTaskStatus,
  notifyTaskStatusChanged,
  recordCoordinationActivity,
  resolveTaskRepo,
  taskOutputTail,
} from "@server/lib/executor-task";
import {
  type ClaimVerificationMode,
  verifyReportedCommit,
} from "@server/lib/executor-task/claim-verification";
import { findExecutorByKey } from "@server/lib/executors";
import { deriveL1Aggregate } from "@server/lib/l1-aggregate";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { assertGroupWritable, assertSupersededTaskInGroup } from "./helpers";

/**
 * 群任务子路由:创建(按 message_id 幂等)/ 列表(分页 + 可选 outputTail)/
 * 详情 / 状态回写(执行器 PATCH)。server 为单一状态源,桥是纯执行器客户端。
 * 挂在 /api/groups 下(路径 /:id/tasks...),与拆分前完全一致。
 */

type TaskRow = typeof taskTable.$inferSelect;

/** diffSummary 是否携带 review_request 交接载荷(顶层 type 或嵌套键两种形式)。 */
function summaryHasReviewRequest(diffSummary: unknown): boolean {
  const summary =
    typeof diffSummary === "object" &&
    diffSummary !== null &&
    !Array.isArray(diffSummary)
      ? (diffSummary as Record<string, unknown>)
      : undefined;
  return (
    summary !== undefined &&
    (summary.type === "review_request" ||
      Object.hasOwn(summary, "review_request"))
  );
}

/**
 * 需表态的提交核实结论集合(specs/l2-must-read-claim-verification.md R1)。
 * - not_found / outside_window → 必须显式表态
 * - verified / skipped → 无需表态(skipped 为环境限制,非执行器过错)
 */
const NEEDS_CLAIM_ADJUDICATION = new Set<string>([
  "not_found",
  "outside_window",
]);

/** 从子任务自身的 diffSummary 提取 claimVerification.status(读子任务,不读协调任务)。 */
function childClaimVerificationStatus(raw: unknown): string | undefined {
  const summary =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  const cv = summary?.claimVerification;
  if (typeof cv !== "object" || cv === null || Array.isArray(cv)) {
    return undefined;
  }
  const status = (cv as Record<string, unknown>).status;
  return typeof status === "string" ? status : undefined;
}

/**
 * 协调任务落终态的完整性校验(R1/R2,见 specs/coordination-close-integrity.md)。
 * 仅当目标状态为 done 且任务为协调任务(detached)时生效;failed/cancelled 不触发(R3)。
 * 协调任务判定必须复用 lib/detached-task-liveness 的 isDetachedTask(),不另写一套。
 */
async function assertCoordinationCloseIntegrity(
  db: DataBase,
  task: TaskRow,
  targetStatus: string | undefined,
  diffSummary: unknown,
): Promise<void> {
  // R3:只管 done,不管 failed/cancelled。
  if (targetStatus !== "done") return;
  // 协调任务判定复用 isDetachedTask()(显式 ReplyMode 或目标含 coordinator 角色)。
  if (!(await isDetachedTask(db, task))) return;

  const summary =
    typeof diffSummary === "object" &&
    diffSummary !== null &&
    !Array.isArray(diffSummary)
      ? (diffSummary as Record<string, unknown>)
      : undefined;

  // R1:done 的协调任务必须有执行子任务(L1 层发生过),否则 400 且点明 L1 层未发生。
  const hasExecutionChild = await db.query.task.findFirst({
    where: (t, { eq }) => eq(t.parentTaskId, task.id),
    columns: { id: true },
  });
  if (!hasExecutionChild) {
    // R4:逃生舱 —— 显式声明非空 noExecutionReason 放行(空串/纯空白仍拒绝)。
    const noExecutionReason =
      typeof summary?.noExecutionReason === "string"
        ? summary.noExecutionReason
        : "";
    if (noExecutionReason.trim() === "") {
      throw new BizError(
        BizCodeEnum.InvalidRequest,
        "L1 层未发生:本协调任务没有任何执行子任务。若确实无需下发执行器,请在 diffSummary.noExecutionReason 中写明原因。",
      );
    }
  }

  // R2:应走 L3(三方在场且 dispatchKind 非 fix)时,review_request 不得缺失。
  if (await shouldWalkL3(db, task)) {
    if (!summaryHasReviewRequest(diffSummary)) {
      throw new BizError(
        BizCodeEnum.InvalidRequest,
        "本协调任务应走 L3 三方检视,但 diffSummary 缺少 review_request 交接载荷(群内 reviewer 与 coordinator 同时在场且非 fix 票)。",
      );
    }
  }

  // L2 必须直面提交核实结论(specs/l2-must-read-claim-verification.md):
  // 任一执行子任务的 claimVerification.status 属需表态集合(not_found /
  // outside_window)时,协调任务 diffSummary.claimAdjudication[childTaskId]
  // 必须提供 accepted(布尔)与非空 reason,否则 400 且点明子任务与其核实结论。
  // claimVerification 读自子任务自身 diffSummary,而非协调任务的。
  const children = await db.query.task.findMany({
    where: (t, { eq }) => eq(t.parentTaskId, task.id),
    columns: { id: true, diffSummary: true },
  });
  const adjudication =
    summary !== undefined &&
    typeof summary.claimAdjudication === "object" &&
    summary.claimAdjudication !== null &&
    !Array.isArray(summary.claimAdjudication)
      ? (summary.claimAdjudication as Record<string, unknown>)
      : undefined;
  for (const child of children) {
    const status = childClaimVerificationStatus(child.diffSummary);
    if (status === undefined || !NEEDS_CLAIM_ADJUDICATION.has(status)) {
      continue;
    }
    const entry = adjudication?.[child.id];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new BizError(
        BizCodeEnum.InvalidRequest,
        `子任务 ${child.id} 的提交核实结论为 ${status},必须在 diffSummary.claimAdjudication["${child.id}"] 中显式表态(accepted 布尔 + 非空 reason)。`,
      );
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.accepted !== "boolean") {
      throw new BizError(
        BizCodeEnum.InvalidRequest,
        `子任务 ${child.id} 的 claimAdjudication.accepted 缺失或非布尔,必须显式给出 true 或 false。`,
      );
    }
    const reason = typeof e.reason === "string" ? e.reason : "";
    if (reason.trim() === "") {
      throw new BizError(
        BizCodeEnum.InvalidRequest,
        `子任务 ${child.id} 的 claimAdjudication.reason 为空,必须填写非空理由。`,
      );
    }
  }
}

/**
 * 应走 L3 ⟺ 群内 reviewer 与 coordinator 同时在场 AND 本票 dispatchKind != 'fix'。
 * dispatchKind 为 null(历史/未走新字段)按 requirement 处理,保守要求 review_request。
 */
async function shouldWalkL3(db: DataBase, task: TaskRow): Promise<boolean> {
  if (task.dispatchKind === "fix") return false;
  const members = await db.query.groupMember.findMany({
    where: (t, { eq }) => eq(t.groupId, task.groupId),
    columns: { roles: true },
  });
  const presentRoles = new Set<string>(members.flatMap((m) => m.roles));
  return presentRoles.has("reviewer") && presentRoles.has("coordinator");
}

/**
 * L3 应答状态派生(R3,specs/l3-verdict-observability.md):仅对「协调任务 +
 * 已落 done + 带 review_request」的任务输出 l3 字段;不满足触发条件返回
 * undefined(调用方不输出 l3,保持载荷逐字不变)。
 *
 * awaitingSince = 落 done 的时刻:优先取 dispatchAudit.coordinationActivity
 * .endedAt(终态审计时刻),老任务/未记录时兜底 updatedAt。overdue = 超过
 * l3ResponseMinutes 且未应答(只观测不强制,不拒绝任何终态)。
 */
async function deriveL3Answer(
  db: DataBase,
  task: TaskRow,
): Promise<
  | {
      answered: boolean;
      verdict: "pass" | "findings" | null;
      awaitingSince: string;
      overdue: boolean;
    }
  | undefined
> {
  if (task.status !== "done") return undefined;
  if (!(await isDetachedTask(db, task))) return undefined;
  const summary =
    typeof task.diffSummary === "object" && task.diffSummary !== null
      ? (task.diffSummary as Record<string, unknown>)
      : undefined;
  const hasReviewRequest =
    summary !== undefined &&
    (summary.type === "review_request" ||
      Object.hasOwn(summary, "review_request"));
  if (!hasReviewRequest) return undefined;

  const audit = task.dispatchAudit ?? null;
  // updatedAt 可空(旧库行):null 时退回 createdAt,保证 awaitingSince 恒有值。
  const awaitingSince =
    audit?.coordinationActivity?.endedAt ??
    (task.updatedAt ?? task.createdAt).toISOString();

  // 在本群消息中找 taskId 指向本任务的 review_result 载荷。历史消息在 R1 校验
  // 落地前未校验形状,解析失败的行跳过(不影响 answered 判定)。
  let answered = false;
  let verdict: "pass" | "findings" | null = null;
  const candidates = await db.query.groupMessage.findMany({
    where: (t, { and: andFn, eq: eqFn, ilike: ilikeFn }) =>
      andFn(
        eqFn(t.groupId, task.groupId),
        ilikeFn(t.body, "%review_result%"),
      ),
    columns: { body: true },
  });
  for (const message of candidates) {
    let parsed: CoordinationPayload | undefined;
    try {
      parsed = parseKnownCoordinationPayload(message.body);
    } catch {
      continue;
    }
    if (parsed?.type === "review_result" && parsed.taskId === task.id) {
      answered = true;
      verdict = parsed.verdict;
      break;
    }
  }
  const overdue =
    !answered &&
    Date.now() - Date.parse(awaitingSince) > getL3ResponseMinutesMs();
  return { answered, verdict, awaitingSince, overdue };
}

const app = new Hono<{ Variables: { db: DataBase; participantId: string } }>();

app
  .post(
    "/:id/tasks",
    describeRoute({
      description:
        "Create a task for the group (idempotent by message_id — the same message only ever creates one task; duplicates return the existing row)",
      responses: {
        200: {
          description: "Task created or existing task returned",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator("param", z.object({ id: z.string().uuid() })),
    zValidator(
      "json",
      z.object({
        messageId: z.string().uuid(),
        executorParticipantId: z.string().uuid(),
        checkpointRef: z.string().optional(),
        // 规范驱动下发 (Spec-Driven Task Dispatch):可选字段,任务行写入
        // specRef/specHash(详情/WS 事件透传);不传 = 指令驱动任务。
        specRef: z.string().max(500).optional(),
        specHash: z.string().max(64).optional(),
        dispatchKind: z.enum(["requirement", "fix"]).optional(),
        // 替代关系(executor-switch-task-identity R2):本任务替代
        // supersedesTaskId 所指的那次尝试(同一工作项的先后尝试);指向的任务
        // 必须属于同一群组(否则 400,见 assertSupersededTaskInGroup),不校验
        // 其是否已终态。不传 = null。
        supersedesTaskId: z.string().uuid().optional(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const callerId = c.get("participantId");
      const { id } = c.req.valid("param");
      const {
        messageId,
        executorParticipantId,
        checkpointRef,
        specRef,
        specHash,
        dispatchKind,
        supersedesTaskId,
      } = c.req.valid("json");

      // 归档/软删群组只读:不能发新任务(与消息/成员同款守卫)。
      await assertGroupWritable(db, id);
      // 与其它群路由一致的边界:调用者必须是群成员(participant 注册是公开的,
      // 不校验会泄漏任意群的任务数据)。
      const membership = await db.query.groupMember.findFirst({
        where: (t, { and, eq }) =>
          and(eq(t.groupId, id), eq(t.participantId, callerId)),
      });
      if (!membership) {
        throw new BizError(BizCodeEnum.Forbidden);
      }
      const executor = await db.query.participant.findFirst({
        where: (t, { eq }) => eq(t.id, executorParticipantId),
      });
      if (!executor) {
        throw new BizError(BizCodeEnum.ParticipantNotFound);
      }
      // 替代关系(R2):被替代的任务必须属于同一群组,否则 400;不校验其终态。
      await assertSupersededTaskInGroup(db, id, supersedesTaskId);

      // 任务书快照:从触发消息取 body 原文写入 brief(消息后续编辑/软删除
      // 不影响已触发任务语义);消息不存在时留空(可空列)。
      const triggerMessage = await db.query.groupMessage.findFirst({
        where: (t, { eq }) => eq(t.id, messageId),
      });

      // Idempotent create: message_id is UNIQUE, so a repeated POST with the
      // same message id returns the existing task instead of a duplicate.
      // ON CONFLICT DO NOTHING keeps the check race-free (concurrent duplicate
      // deliveries fall back to re-reading the winning row, never a 500).
      const [created] = await db
        .insert(taskTable)
        .values({
          groupId: id,
          messageId,
          executorParticipantId,
          checkpointRef: checkpointRef ?? null,
          // 规范驱动下发:task 行写入 specRef/specHash(null = 指令驱动任务)。
          specRef: specRef ?? null,
          specHash: specHash ?? null,
          dispatchKind: dispatchKind ?? null,
          // 替代关系(R2):本任务替代 supersedesTaskId 所指的那次尝试;不传为 null。
          supersedesTaskId: supersedesTaskId ?? null,
          brief: triggerMessage?.body ?? null,
          // 显式置 queued:不依赖 DB 默认值(旧库默认值可能仍是 running)。
          status: "queued",
        })
        .onConflictDoNothing({ target: taskTable.messageId })
        .returning();
      if (created) {
        return c.json(created);
      }
      const existing = await db.query.task.findFirst({
        where: (t, { eq }) => eq(t.messageId, messageId),
      });
      if (!existing) {
        throw new BizError(
          BizCodeEnum.Conflict,
          "Task for messageId already exists but could not be reloaded",
        );
      }
      const conflicts = [
        specRef !== undefined && specRef !== existing.specRef
          ? "specRef"
          : null,
        specHash !== undefined && specHash !== existing.specHash
          ? "specHash"
          : null,
        dispatchKind !== undefined && dispatchKind !== existing.dispatchKind
          ? "dispatchKind"
          : null,
        supersedesTaskId !== undefined &&
        supersedesTaskId !== existing.supersedesTaskId
          ? "supersedesTaskId"
          : null,
      ].filter((field): field is string => field !== null);
      if (conflicts.length > 0) {
        throw new BizError(
          BizCodeEnum.Conflict,
          `Task for messageId already exists with conflicting fields: ${conflicts.join(", ")}`,
        );
      }
      return c.json(existing);
    },
  )
  .get(
    "/:id/tasks",
    describeRoute({
      description: "List the group's tasks, newest first (createdAt desc)",
      responses: {
        200: {
          description: "Task list",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator("param", z.object({ id: z.string().uuid() })),
    zValidator(
      "query",
      z.object({
        // 实时输出:仅 includeOutput=1 时返回 outputTail(控制响应大小)。
        includeOutput: z.enum(["1", "0", "true", "false"]).optional(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      const { includeOutput } = c.req.valid("query");
      const rawLimit = c.req.query("limit");
      const rawOffset = c.req.query("offset");
      const limit =
        rawLimit === undefined
          ? 50
          : Math.min(Math.max(Number(rawLimit) || 50, 1), 100);
      const offset =
        rawOffset === undefined ? 0 : Math.max(Number(rawOffset) || 0, 0);
      const wantOutput = includeOutput === "1" || includeOutput === "true";

      const group = await db.query.groups.findFirst({
        where: (t, { eq }) => eq(t.id, id),
      });
      if (!group) {
        throw new BizError(BizCodeEnum.GroupNotFound);
      }
      // LAN trust model(与 GET /messages 一致):读任务列表不需要成员身份,
      // 仅要求群存在;写操作(POST/PATCH)仍走各自权限边界。
      const tasks = await db.query.task.findMany({
        where: (t, { eq }) => eq(t.groupId, id),
        columns: {
          id: true,
          groupId: true,
          parentTaskId: true,
          messageId: true,
          executorParticipantId: true,
          executorKey: true,
          brief: true,
          status: true,
          checkpointRef: true,
          retryCount: true,
          diffSummary: true,
          attempts: true,
          // A2A 上下文延续依赖读取上一任务的 contextId,列表必须返回该列。
          a2aContextId: true,
          // 任务下发者信息(Part A):透传给插件(定向通知用);老任务为 null。
          dispatcherParticipantId: true,
          dispatcherSessionId: true,
          // callback 路由信息(Part B):透传 opaque 路由 { platform?,
          // endpointRef?, sessionRef? };老任务为 null。
          callbackRef: true,
          // 下发目标审计:按 task 可回查下发者、目标、候选状态与可选理由。
          dispatchAudit: true,
          // 规范驱动下发:列表透出 specRef/specHash,UI 按 specRef 分组任务需要该
          // 字段(老任务为 null)。
          specRef: true,
          specHash: true,
          dispatchKind: true,
          // 替代关系(R3):列表透出 supersedesTaskId(老任务为 null)。
          supersedesTaskId: true,
          createdAt: true,
          updatedAt: true,
        },
        limit: limit ?? 50,
        offset: offset ?? 0,
        orderBy: (t, { desc }) => desc(t.createdAt),
      });
      // 实时进度:includeOutput=1 时给每个任务附 outputTail(running 任务 =
      // 内存缓冲;已完成任务 = diffSummary.outputTail 回填或留空)。
      if (!wantOutput) {
        return c.json(tasks);
      }
      const withOutput = tasks.map((task) => {
        const buffered = taskOutputTail(task.id);
        const summary =
          typeof task.diffSummary === "object" && task.diffSummary !== null
            ? (task.diffSummary as Record<string, unknown>)
            : undefined;
        const backfilled =
          summary && typeof summary.outputTail === "string"
            ? summary.outputTail
            : undefined;
        const outputTail = buffered ?? backfilled ?? undefined;
        return outputTail === undefined ? task : { ...task, outputTail };
      });
      return c.json(withOutput);
    },
  )
  .get(
    "/:id/tasks/:taskId",
    describeRoute({
      description:
        "Get a single task's full details (optionally with outputTail via ?includeOutput=1)",
      responses: {
        200: {
          description: "Task details",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator(
      "param",
      z.object({ id: z.string().uuid(), taskId: z.string().uuid() }),
    ),
    zValidator(
      "query",
      z.object({
        // 实时输出:仅 includeOutput=1 时返回 outputTail(控制响应大小)。
        includeOutput: z.enum(["1", "0", "true", "false"]).optional(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const { id, taskId } = c.req.valid("param");
      const { includeOutput } = c.req.valid("query");
      const wantOutput = includeOutput === "1" || includeOutput === "true";

      const group = await db.query.groups.findFirst({
        where: (t, { eq }) => eq(t.id, id),
      });
      if (!group) {
        throw new BizError(BizCodeEnum.GroupNotFound);
      }
      const task = await db.query.task.findFirst({
        where: (t, { and, eq }) => and(eq(t.id, taskId), eq(t.groupId, id)),
      });
      if (!task) {
        throw new BizError(BizCodeEnum.TaskNotFound);
      }
      const liveness = await getDetachedTaskLiveness(db, task);
      // 只返回任务详情约定字段(不泄露 attempts/a2aContextId 等内部列)。
      const detail: Record<string, unknown> = {
        id: task.id,
        groupId: task.groupId,
        parentTaskId: task.parentTaskId ?? null,
        messageId: task.messageId,
        executorParticipantId: task.executorParticipantId,
        executorKey: task.executorKey,
        brief: task.brief,
        status: task.status,
        checkpointRef: task.checkpointRef,
        retryCount: task.retryCount,
        diffSummary: task.diffSummary,
        // 规范驱动下发:详情透出 specRef/specHash(老任务为 null)。
        specRef: task.specRef ?? null,
        specHash: task.specHash ?? null,
        dispatchKind: task.dispatchKind ?? null,
        // 替代关系(R3):详情透出 supersedesTaskId(老任务为 null)。
        supersedesTaskId: task.supersedesTaskId ?? null,
        // 任务下发者信息(Part A):透传给插件(定向通知用);老任务为 null。
        dispatcherParticipantId: task.dispatcherParticipantId ?? null,
        dispatcherSessionId: task.dispatcherSessionId ?? null,
        // callback 路由信息(Part B):透传 opaque 路由 { platform?,
        // endpointRef?, sessionRef? };老任务为 null。
        callbackRef: task.callbackRef ?? null,
        dispatchAudit: task.dispatchAudit ?? null,
        livenessWarning: liveness.livenessWarning,
        lastSignalAt: liveness.lastSignalAt,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      };
      // 实时进度:includeOutput=1 时附 outputTail(running 任务 = 内存缓冲;
      // 已完成任务 = diffSummary.outputTail 回填或留空)。
      if (wantOutput) {
        const buffered = taskOutputTail(task.id);
        const summary =
          typeof task.diffSummary === "object" && task.diffSummary !== null
            ? (task.diffSummary as Record<string, unknown>)
            : undefined;
        const backfilled =
          summary && typeof summary.outputTail === "string"
            ? summary.outputTail
            : undefined;
        detail.outputTail = buffered ?? backfilled ?? null;
      }
      // L3 应答状态(R3):协调任务 done + 带 review_request 时派生 l3 字段;
      // 不满足触发条件不输出(不是空对象),其余载荷保持逐字不变。
      const l3 = await deriveL3Answer(db, task);
      if (l3) {
        detail.l3 = l3;
      }
      // L1 聚合(R1,specs/reviewer-needs-no-executor-visibility.md):目标是协调
      // 任务(isDetachedTask)时派生 l1 字段(子任务数/聚合态/是否全终态),供
      // 检视者验收 L1 层是否发生;不含执行器身份。非协调任务不输出 l1(不是
      // 空对象),其余载荷保持逐字不变。
      if (await isDetachedTask(db, task)) {
        detail.l1 = await deriveL1Aggregate(db, task);
      }
      return c.json(detail);
    },
  )
  .patch(
    "/:id/tasks/:taskId",
    describeRoute({
      description:
        "Update a task (status/diffSummary by the owning executor; brief by the group's coordinator/human while the task is queued)",
      responses: {
        200: {
          description: "Task updated",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator(
      "param",
      z.object({ id: z.string().uuid(), taskId: z.string().uuid() }),
    ),
    zValidator(
      "json",
      z
        .object({
          status: z.enum(TASK_STATUSES).optional(),
          diffSummary: z.unknown().optional(),
          checkpointRef: z.string().optional(),
          // 任务书快照:仅群 coordinator/human 可在任务 queued 时修改
          // (角色/状态判断在 handler,此处只做格式约束;执行器本人保持只读)。
          brief: z.string().min(1).max(4000).optional(),
        })
        .passthrough()
        .refine(
          (v) =>
            v.status !== undefined ||
            v.diffSummary !== undefined ||
            v.checkpointRef !== undefined ||
            v.brief !== undefined,
          {
            message:
              "至少提供 status / diffSummary / checkpointRef / brief 之一",
          },
        ),
    ),
    async (c) => {
      const db = c.get("db");
      const participantId = c.get("participantId");
      const { id, taskId } = c.req.valid("param");
      const { status, diffSummary, checkpointRef, brief } = c.req.valid("json");
      let normalizedDiffSummary = diffSummary;
      if (
        typeof diffSummary === "object" &&
        diffSummary !== null &&
        !Array.isArray(diffSummary) &&
        ((diffSummary as Record<string, unknown>).type === "review_request" ||
          Object.hasOwn(diffSummary, "review_request"))
      ) {
        try {
          normalizedDiffSummary =
            normalizeReviewRequestDiffSummary(diffSummary);
        } catch (error) {
          const detail =
            error instanceof z.ZodError ? error.message : String(error);
          throw new BizError(
            BizCodeEnum.InvalidRequest,
            `diffSummary.review_request 形状无效: ${detail}。期望示例: ${JSON.stringify(REVIEW_REQUEST_EXAMPLE)}`,
          );
        }
      }

      // 归档/软删群组只读:不能改任务状态(与 POST /tasks 同款守卫)。
      await assertGroupWritable(db, id);
      const task = await db.query.task.findFirst({
        where: (t, { and, eq }) => and(eq(t.id, taskId), eq(t.groupId, id)),
      });
      if (!task) {
        throw new BizError(BizCodeEnum.TaskNotFound);
      }
      const isExecutor = task.executorParticipantId === participantId;
      const wantsBrief = brief !== undefined;
      const wantsLifecycle =
        status !== undefined ||
        diffSummary !== undefined ||
        checkpointRef !== undefined;

      if (wantsBrief) {
        // 任务书快照对执行器本人保持只读(与旧 superRefine 行为一致)。
        if (isExecutor) {
          throw new BizError(
            BizCodeEnum.InvalidRequest,
            "brief 为只读字段,不可通过 PATCH 修改",
          );
        }
        // 仅群 coordinator/human 可在任务排队中修改任务书。
        const membership = await db.query.groupMember.findFirst({
          where: (t, { and, eq }) =>
            and(eq(t.groupId, id), eq(t.participantId, participantId)),
        });
        const roles = membership?.roles ?? [];
        if (!roles.includes("coordinator") && !roles.includes("human")) {
          throw new BizError(BizCodeEnum.Forbidden);
        }
        if (task.status !== "queued") {
          throw new BizError(
            BizCodeEnum.Conflict,
            "仅排队中的任务可修改任务书",
          );
        }
      }
      // 生命周期字段(status/diffSummary/checkpointRef)仍仅执行器本人可改。
      if (wantsLifecycle && !isExecutor) {
        throw new BizError(BizCodeEnum.Forbidden);
      }
      // Terminal state changes are an audited interruption of the task
      // lifecycle. Require the caller to persist the explanation in the
      // existing diffSummary.error field so a failed/cancelled task never
      // becomes an unexplained terminal event. Internal server paths write
      // directly to the database and already provide their own reasons.
      if (
        status !== undefined &&
        status !== task.status &&
        (status === "failed" || status === "cancelled")
      ) {
        const summary =
          typeof normalizedDiffSummary === "object" &&
          normalizedDiffSummary !== null &&
          !Array.isArray(normalizedDiffSummary)
            ? (normalizedDiffSummary as Record<string, unknown>)
            : undefined;
        if (typeof summary?.error !== "string" || summary.error.trim() === "") {
          throw new BizError(
            BizCodeEnum.InvalidRequest,
            `status=${status} 必须在 diffSummary.error 中提供失败原因`,
          );
        }
      }
      // 协调任务落终态的完整性校验(R1/R2):仅 done + 协调任务触发;
      // 复用 isDetachedTask() 判定协调任务,不另写一套。
      await assertCoordinationCloseIntegrity(db, task, status, diffSummary);
      // 汇报 commit 核实(spec verify-agent-claims v1.1):任何写入
      // diffSummary.hash 的入口都要核实——CLI 完成 / detached PATCH / a2a 完成
      // 共用 claim-verification 同一套逻辑。核实是尽力而为:仓库不可达 / 非 git /
      // git 失败 → 跳过(不写核实字段);a2a 执行器本地无仓库 → 留下
      // status=skipped 的「未核实」痕迹。核实失败只标记、绝不把任务判 failed。
      let summaryToWrite = normalizedDiffSummary;
      if (
        diffSummary !== undefined &&
        typeof normalizedDiffSummary === "object" &&
        normalizedDiffSummary !== null &&
        !Array.isArray(normalizedDiffSummary)
      ) {
        const raw = normalizedDiffSummary as Record<string, unknown>;
        const reportedHash =
          typeof raw.hash === "string" && raw.hash.trim() !== ""
            ? raw.hash
            : undefined;
        if (reportedHash) {
          try {
            const executorConfig = task.executorKey
              ? await findExecutorByKey(db, task.executorKey)
              : undefined;
            const mode: ClaimVerificationMode =
              executorConfig?.kind === "a2a" ? "a2a" : "cli";
            // 与派发时 spawn cwd 同源的仓库:任务书声明 → 群 project_path →
            // findRepoRoot 兜底(与 queue.ts 派发路径一致)。
            const group = await db.query.groups.findFirst({
              where: (g, { eq }) => eq(g.id, id),
            });
            const declaredRoot = resolveTaskRepo(
              task.brief ?? "",
              group?.projectPath ?? null,
            );
            const repoRoot =
              declaredRoot && existsSync(declaredRoot)
                ? declaredRoot
                : findRepoRoot();
            const verification = await verifyReportedCommit(
              reportedHash,
              repoRoot,
              task.attempts,
              mode,
            );
            if (verification) {
              summaryToWrite = { ...raw, claimVerification: verification };
            }
          } catch (e) {
            // 核实绝不拖垮完成路径:任何异常都跳过核实,任务照常落终态。
            console.warn(`[tasks] commit 核实跳过(${taskId}): ${e}`);
          }
        }
      }
      const [updated] = await db
        .update(taskTable)
        .set({
          ...(status !== undefined ? { status } : {}),
          ...(diffSummary !== undefined ? { diffSummary: summaryToWrite } : {}),
          ...(checkpointRef !== undefined ? { checkpointRef } : {}),
          ...(brief !== undefined ? { brief } : {}),
        })
        .where(and(eq(taskTable.id, taskId), eq(taskTable.groupId, id)))
        .returning();
      // 外部执行器客户端通过 PATCH 推进状态 → 同样推送 task_status_changed
      // (仅当 status 实际变更时;否则订阅者会收到无变化的重复事件)。
      if (updated && status !== undefined && updated.status !== task.status) {
        await notifyTaskStatusChanged(
          db,
          updated.id,
          updated.groupId,
          status,
          updated,
        );
        if (isTerminalTaskStatus(status)) {
          try {
            const activity = await recordCoordinationActivity(db, updated);
            if (activity?.childTaskCount === 0) {
              await createTaskDispatchWarnings(
                db,
                updated.groupId,
                updated.id,
                updated.executorParticipantId,
              );
            }
          } catch (error) {
            console.warn(
              `[coordination] activity audit failed (${updated.id}), task remains terminal:`,
              error,
            );
          }
        }
      }
      return c.json(updated);
    },
  );

export default app;
