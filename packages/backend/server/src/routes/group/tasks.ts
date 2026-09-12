import { zValidator } from "@hono/zod-validator";
import {
  normalizeReviewRequestDiffSummary,
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
import {
  applyDiffSummaryPatch,
  createTaskDispatchWarnings,
  deriveCloseGuardResume,
  dispatcherRecipients,
  findTaskDetail,
  inferSupersedesTaskId,
  isExecutorProcessAlive,
  isTerminalTaskStatus,
  mergeDiffSummary,
  mergePlatformTokenFields,
  notifyTaskStatusChanged,
  postStatus,
  readTaskDetail,
  recordCoordinationActivity,
  reviewRequestRecipients,
} from "@server/lib/executor-task";
import {
  type ClaimVerificationMode,
  hasCommitInTaskWindow,
  verifyReportedCommit,
} from "@server/lib/executor-task/claim-verification";
import {
  enterCooldown,
  MIN_EFFECTIVE_COOLDOWN_MS,
  normalizeCooldownEnd,
} from "@server/lib/executor-task/cooldown";
import { EXECUTOR_COOLDOWN_END_MS_FIELD } from "@server/lib/executor-task/cooldown-store";
import {
  liveTaskOutputTail,
  releaseTaskOutput,
} from "@server/lib/executor-task/output-buffer";
import { taskOutputTailLines } from "@server/lib/executor-task/report";
import {
  classifyQuotaFailure,
  formatEta,
  getRateLimitCooldownMs,
} from "@server/lib/executor-task/state";
import { getExecutorTaskLiveness } from "@server/lib/executor-task-liveness";
import {
  findExecutorByKey,
  listPeerExecutorNames,
  parseRateLimitRecoveryMs,
} from "@server/lib/executors";
import { deriveL1Aggregate } from "@server/lib/l1-aggregate";
import { getRuntimeStatus } from "@server/lib/runtime-status";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import {
  assertCoordinationCloseIntegrity,
  resolveTaskRepoRoot,
} from "./coordination-close";
import { assertGroupWritable, assertSupersededTaskInGroup } from "./helpers";
import {
  appendL3ConclusionToOwner,
  deriveL3Answer,
  loadReviewResultIndex,
  markL3MergedInto,
  resolveL3RequestMergeOwner,
  reviewRequestPayloadOf,
  summaryHasReviewRequest,
} from "./l3-answer";

/**
 * 群任务子路由:创建(按 message_id 幂等)/ 列表(分页 + 可选 outputTail)/
 * 详情 / 状态回写(执行器 PATCH)。server 为单一状态源,桥是纯执行器客户端。
 * 挂在 /api/groups 下(路径 /:id/tasks...),与拆分前完全一致。
 */

/** 存活信号(R6,specs/orphan-tasks-only-reconcile-on-restart.md):pid 为 null
 * 时返回 null(无 pid 可核验),否则以 process.kill(pid, 0) 探测进程是否存在。 */
function pidAliveOf(pid: number | null): boolean | null {
  return pid === null ? null : isExecutorProcessAlive(pid);
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
      // L2 重发路径安全网:调用方未显式传 supersedesTaskId 时,平台根据当前
      // 续跑上下文自动指向刚结束/被替代的子任务(首次派发不补、跨父任务不串链)。
      let finalSupersedesTaskId: string | null | undefined = supersedesTaskId;
      if (finalSupersedesTaskId == null) {
        finalSupersedesTaskId = await inferSupersedesTaskId(
          db,
          id,
          callerId,
          executorParticipantId,
        );
      }
      await assertSupersededTaskInGroup(db, id, finalSupersedesTaskId);

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
          supersedesTaskId: finalSupersedesTaskId ?? null,
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
        finalSupersedesTaskId !== existing.supersedesTaskId
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
          // 存活信号(R6,specs/orphan-tasks-only-reconcile-on-restart.md):
          // 列表透出 executorPid,并派生 pidAlive 供看门狗等外部消费方判断。
          executorPid: true,
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
      // 存活信号(R6):列表每行派生 pidAlive(null = 无 pid 可核验,与
      // executorPid 为 null 一一对应);与详情同源,供看门狗等外部消费方判断。
      const withPidAlive = tasks.map((task) => ({
        ...task,
        pidAlive: pidAliveOf(task.executorPid),
      }));
      // 结案守卫等待续跑(R3,specs/detached-close-deadlock-guard-vs-no-poll.md
      // 验收 3):请求批量派生,使「因结案守卫等待续跑」与「普通排队」在列表上
      // 可区分;未登记的任务不输出该字段(不是空对象)。
      const closeGuardByTask = await deriveCloseGuardResume(db, withPidAlive);
      const withCloseGuard = withPidAlive.map((task) => {
        const closeGuardResume = closeGuardByTask.get(task.id);
        return closeGuardResume ? { ...task, closeGuardResume } : task;
      });
      // L3 应答状态与详情端点复用同一派生函数;review_result 先按群批量
      // 建索引,避免列表中的每条任务各自触发一次全表扫描。
      const reviewResults = await loadReviewResultIndex(db, id);
      const withL3 = await Promise.all(
        withCloseGuard.map(async (task) => {
          const l3 = await deriveL3Answer(db, task, reviewResults);
          return l3 ? { ...task, l3 } : task;
        }),
      );
      // 实时进度:includeOutput=1 时给每个任务附 outputTail(running 任务 =
      // 内存缓冲;已完成任务 = diffSummary.outputTail 回填或留空)。
      if (!wantOutput) {
        return c.json(withL3);
      }
      const withOutput = withL3.map((task) => {
        // live 仅 report: running 走 live 缓冲,已完成走持久化 liveOutputTail,永不回落全量 outputTail(保持 WS 一致性)。
        const liveBuffered = liveTaskOutputTail(task.id);
        const summary =
          typeof task.diffSummary === "object" && task.diffSummary !== null
            ? (task.diffSummary as Record<string, unknown>)
            : undefined;
        const persistedLive =
          summary && typeof summary.liveOutputTail === "string"
            ? summary.liveOutputTail
            : undefined;
        const outputTail =
          liveBuffered !== null
            ? liveBuffered
            : persistedLive !== undefined
              ? persistedLive
              : undefined;
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
      const executorLiveness = await getExecutorTaskLiveness(db, task);
      const runtime = getRuntimeStatus();
      // 只返回任务详情约定字段(不泄露 attempts/a2aContextId 等内部列)。
      const detail: Record<string, unknown> = {
        id: task.id,
        groupId: task.groupId,
        parentTaskId: task.parentTaskId ?? null,
        messageId: task.messageId,
        executorParticipantId: task.executorParticipantId,
        executorKey: task.executorKey,
        // 存活信号(R6):详情透出 executorPid 与 pidAlive(null = 无 pid 可核验),
        // 供看门狗等外部消费方判断执行器进程是否仍在运行。
        executorPid: task.executorPid ?? null,
        pidAlive: pidAliveOf(task.executorPid),
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
      const summary =
        typeof task.diffSummary === "object" &&
        task.diffSummary !== null &&
        !Array.isArray(task.diffSummary)
          ? (task.diffSummary as Record<string, unknown>)
          : undefined;
      if (
        task.status === "failed" &&
        typeof summary?.error === "string" &&
        summary.error.trim() !== "" &&
        summary.staleBuildSuspected === true
      ) {
        detail.staleBuildSuspected = true;
      }
      // 实时进度:includeOutput=1 时附 outputTail(running=live 缓冲 report-only,
      // 已完成=diffSummary.liveOutputTail,永不回落全量 outputTail)。
      if (wantOutput) {
        const liveBuffered = liveTaskOutputTail(task.id);
        const summary1 =
          typeof task.diffSummary === "object" && task.diffSummary !== null
            ? (task.diffSummary as Record<string, unknown>)
            : undefined;
        const persistedLive1 =
          summary1 && typeof summary1.liveOutputTail === "string"
            ? summary1.liveOutputTail
            : undefined;
        detail.outputTail =
          liveBuffered !== null
            ? liveBuffered
            : persistedLive1 !== undefined
              ? persistedLive1
              : null;
      }
      // L3 应答状态(R3):协调任务 done + 带 review_request 时派生 l3 字段;
      // 不满足触发条件不输出(不是空对象),其余载荷保持逐字不变。
      const l3 = await deriveL3Answer(db, task);
      if (l3) {
        detail.l3 = l3;
      }
      // 执行器任务存活探测(R1,specs/executor-task-liveness.md):仅对
      // running 且非协调任务派生 liveness 字段(协调任务走既有
      // livenessWarning/lastSignalAt);不满足条件不输出(不是空对象),
      // 判定不修改 task.status。阈值复用 stallTimeoutMinutes,不新增配置。
      if (executorLiveness) {
        detail.liveness = executorLiveness;
      }
      // 结案守卫等待续跑(R3,specs/detached-close-deadlock-guard-vs-no-poll.md):
      // 仅「曾因守卫拒绝而登记待续跑」的任务派生 closeGuardResume(含
      // awaitingResume),未登记不输出(不是空对象),与 l1/l3/liveness 同款约定。
      const closeGuardResume = (await deriveCloseGuardResume(db, [task])).get(
        task.id,
      );
      if (closeGuardResume) {
        detail.closeGuardResume = closeGuardResume;
      }
      // L1 聚合(R1,specs/reviewer-needs-no-executor-visibility.md):目标是协调
      // 任务(isDetachedTask)时派生 l1 字段(子任务数/聚合态/是否全终态),供
      // 检视者验收 L1 层是否发生;不含执行器身份。非协调任务不输出 l1(不是
      // 空对象),其余载荷保持逐字不变。
      if (await isDetachedTask(db, task)) {
        detail.l1 = await deriveL1Aggregate(db, task);
        detail.runtime = runtime;
      }
      return c.json(detail);
    },
  )
  .get(
    "/:id/tasks/:taskId/output",
    describeRoute({
      description:
        "整份任务明细(?detail=1,spec two-tier-output-summary-and-detail R5):返回该任务明细 JSONL 的全部条目,供事后排障按需展开",
      responses: {
        200: {
          description: "Task detail entries",
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
        // 整份明细必须显式带 detail=1(与 includeOutput 同款枚举口径,不放宽)。
        detail: z.enum(["1", "0", "true", "false"]).optional(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const { id, taskId } = c.req.valid("param");
      const { detail } = c.req.valid("query");
      // 群/任务存在性校验与任务详情路由一致(includeOutput 同授权口径,不放宽)。
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
      if (detail !== "1" && detail !== "true") {
        throw new BizError(
          BizCodeEnum.InvalidRequest,
          "整份明细需显式携带 ?detail=1",
        );
      }
      const rows = readTaskDetail(taskId);
      if (rows === null) {
        // R5:404 并说明原因,不得静默返回空。
        throw new BizError(
          BizCodeEnum.TaskNotFound,
          "任务明细文件不存在(可能已被 14 天清理,或该任务无明细记录)",
        );
      }
      return c.json({ taskId, entries: rows });
    },
  )
  .get(
    "/:id/tasks/:taskId/output/:entryId",
    describeRoute({
      description:
        "单条任务明细(spec two-tier-output-summary-and-detail R5):按摘要行 #id 展开完整原文;找不到返回 404 并说明原因",
      responses: {
        200: {
          description: "Single detail entry",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator(
      "param",
      z.object({
        id: z.string().uuid(),
        taskId: z.string().uuid(),
        entryId: z.string(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const { id, taskId, entryId } = c.req.valid("param");
      // 群/任务存在性校验与任务详情路由一致(includeOutput 同授权口径,不放宽)。
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
      const row = findTaskDetail(taskId, entryId);
      if (row === undefined) {
        // R5:明细文件不存在(已被清理 / 任务无明细),404 说明原因。
        throw new BizError(
          BizCodeEnum.TaskNotFound,
          "明细文件不存在(可能已被 14 天清理,或该任务无明细记录)",
        );
      }
      if (row === null) {
        // R5:id 不存在,404 说明原因,不得静默返回空。
        throw new BizError(
          BizCodeEnum.TaskNotFound,
          `条目 ${entryId} 不存在(摘要行里的 #id 无对应明细)`,
        );
      }
      return c.json(row);
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
      // R3:分流权归检视者,下游 PATCH 不得改写已落库 dispatchKind —— 任何携带的
      // dispatchKind 字段静默丢弃,不参与 update(c.req.valid("json") passthrough 亦忽略).
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
      // l1-bypass-must-be-visible R1:failed/cancelled + 零执行子任务时返回
      // l1Bypass 载荷,由平台写入 diffSummary。
      const closeIntegrity = await assertCoordinationCloseIntegrity(
        db,
        task,
        status,
        diffSummary,
      );
      // 汇报 commit 核实(spec verify-agent-claims v1.1):任何写入
      // diffSummary.hash 的入口都要核实——CLI 完成 / detached PATCH / a2a 完成
      // 共用 claim-verification 同一套逻辑。核实是尽力而为:仓库不可达 / 非 git /
      // git 失败 → 跳过(不写核实字段);a2a 执行器本地无仓库 → 留下
      // status=skipped 的「未核实」痕迹。核实失败只标记、绝不把任务判 failed。
      //
      // diffsummary-ownership W2:客户端 patch 经单一合并入口并入既有摘要,
      // 不再整袋替换 + 链式 preserve。
      let summaryToWrite: unknown = task.diffSummary;
      let clientPatch: Record<string, unknown> | undefined;
      if (
        diffSummary !== undefined &&
        typeof normalizedDiffSummary === "object" &&
        normalizedDiffSummary !== null &&
        !Array.isArray(normalizedDiffSummary)
      ) {
        clientPatch = {
          ...(normalizedDiffSummary as Record<string, unknown>),
        };
        // R3: staleBuildSuspected 是平台调度键,剥离客户端自报值。
        delete clientPatch.staleBuildSuspected;
        const reportedHash =
          typeof clientPatch.hash === "string" && clientPatch.hash.trim() !== ""
            ? clientPatch.hash
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
            const repoRoot = await resolveTaskRepoRoot(db, task);
            const verification = await verifyReportedCommit(
              reportedHash,
              repoRoot,
              task.attempts,
              mode,
            );
            if (verification) {
              clientPatch.claimVerification = verification;
            }
          } catch (e) {
            // 核实绝不拖垮完成路径:任何异常都跳过核实,任务照常落终态。
            console.warn(`[tasks] commit 核实跳过(${taskId}): ${e}`);
          }
        }
        summaryToWrite = applyDiffSummaryPatch(task.diffSummary, clientPatch);
      } else if (diffSummary !== undefined) {
        summaryToWrite = normalizedDiffSummary;
      }
      // l1-bypass-must-be-visible R1 + R4(dispatching-should-be-the-default):
      // 平台把 l1Bypass / degradedToTwoParty 分键并入 diffSummary,review 所有者。
      if (
        closeIntegrity &&
        typeof summaryToWrite === "object" &&
        summaryToWrite !== null &&
        !Array.isArray(summaryToWrite)
      ) {
        const reviewPatch: Record<string, unknown> = {
          ...(closeIntegrity.l1Bypass !== undefined
            ? { l1Bypass: closeIntegrity.l1Bypass }
            : {}),
          ...(closeIntegrity.degradedToTwoParty !== undefined
            ? { degradedToTwoParty: closeIntegrity.degradedToTwoParty }
            : {}),
        };
        if (Object.keys(reviewPatch).length > 0) {
          summaryToWrite = mergeDiffSummary(
            summaryToWrite,
            reviewPatch,
            "review",
          );
        }
      }
      // R3: staleBuildSuspected 仅平台在 non-terminal → failed 时写入。
      if (
        diffSummary !== undefined &&
        typeof summaryToWrite === "object" &&
        summaryToWrite !== null &&
        !Array.isArray(summaryToWrite)
      ) {
        const shouldPersistStaleBuildSuspected =
          status === "failed" &&
          status !== task.status &&
          !isTerminalTaskStatus(task.status) &&
          typeof (summaryToWrite as Record<string, unknown>).error ===
            "string" &&
          (
            (summaryToWrite as Record<string, unknown>).error as string
          ).trim() !== "" &&
          getRuntimeStatus().stale;
        if (shouldPersistStaleBuildSuspected) {
          summaryToWrite = mergeDiffSummary(
            summaryToWrite,
            { staleBuildSuspected: true },
            "scheduling",
          );
        }
      }
      // token-fields-clobbered-by-close R1/R2:平台 token 在 PATCH 未带键时保留;
      // 显式带键以调用方为准。merge 入口已保留既有 metrics 键;此处补 attempts
      // 采集回填(既有与 client 皆缺时)。
      if (
        diffSummary !== undefined &&
        typeof summaryToWrite === "object" &&
        summaryToWrite !== null &&
        !Array.isArray(summaryToWrite)
      ) {
        summaryToWrite = mergePlatformTokenFields(
          summaryToWrite as Record<string, unknown>,
          {
            existing: task.diffSummary,
            attempts: Array.isArray(task.attempts) ? task.attempts : [],
          },
        );
      }
      // detached-close-never-backfills-outputtail R1/R2: detached executors close
      // through this PATCH path, so snapshot the same recent 500 lines as the
      // queue completion path before releasing the process-local buffer. An
      // explicit payload outputTail wins; when no buffer exists, persist the
      // reason instead of silently leaving the audit field absent.
      const detachedTerminalPatch =
        status !== undefined &&
        isTerminalTaskStatus(status) &&
        (await isDetachedTask(db, task));
      if (detachedTerminalPatch) {
        const payloadSummary =
          typeof summaryToWrite === "object" &&
          summaryToWrite !== null &&
          !Array.isArray(summaryToWrite)
            ? (summaryToWrite as Record<string, unknown>)
            : undefined;
        const existingSummary =
          typeof task.diffSummary === "object" &&
          task.diffSummary !== null &&
          !Array.isArray(task.diffSummary)
            ? (task.diffSummary as Record<string, unknown>)
            : undefined;
        const summaryForClose = payloadSummary ?? existingSummary ?? {};
        if (!Object.hasOwn(summaryForClose, "outputTail")) {
          const outputTail = taskOutputTailLines(taskId);
          summaryToWrite = mergeDiffSummary(
            summaryForClose,
            outputTail
              ? { outputTail }
              : {
                  outputTailMissing:
                    "PATCH 终态时任务输出缓冲不可用(可能已释放或服务已重启)",
                },
            "metrics",
          );
        } else {
          summaryToWrite = summaryForClose;
        }
      }
      // R1(specs/l3-request-delivery-and-scope.md):完成事件的投递对象由**载荷**
      // 决定,不由下发者决定 —— 终态 diffSummary 带 review_request 时收件人是群内
      // reviewer 成员,其余完成事件仍是下发者。裁定只发生在应用层,trigger 仅搬运
      // task.recipient_participant_ids(它不查 group_members、不理解角色)。
      // 非终态的 PATCH 不裁定:trigger 不会触发,列保持上一次裁定的原值。
      const terminalTransition =
        status !== undefined &&
        isTerminalTaskStatus(status) &&
        !isTerminalTaskStatus(task.status);
      let ownRecipients: string[] | undefined;
      if (status !== undefined && isTerminalTaskStatus(status)) {
        ownRecipients = summaryHasReviewRequest(summaryToWrite)
          ? await reviewRequestRecipients(db, id, task.dispatcherParticipantId)
          : dispatcherRecipients(task.dispatcherParticipantId);
      }
      // L3 请求按 spec 去重(specs/l3-is-per-spec-not-per-task.md R1-R4):
      // 结案 done 且带 review_request 时,同 specRef+specHash 已存在未应答请求
      // 则不新增第二条——新的 L2 结论并入既有请求(追加,先前结论保留),本任务
      // 改挂 platform.l3MergedInto 标记指向属主(R4 裁决对全部并入任务生效);
      // 续跑任务(resumeOf)并入父任务请求,不新起一条(R3)。
      if (
        status === "done" &&
        typeof summaryToWrite === "object" &&
        summaryToWrite !== null &&
        !Array.isArray(summaryToWrite)
      ) {
        const incomingRequest = reviewRequestPayloadOf(summaryToWrite);
        if (incomingRequest) {
          const owner = await resolveL3RequestMergeOwner(
            db,
            id,
            task,
            incomingRequest,
            ownRecipients ?? [],
          );
          if (owner) {
            await appendL3ConclusionToOwner(
              db,
              owner,
              taskId,
              incomingRequest.diffSummary,
            );
            summaryToWrite = markL3MergedInto(
              summaryToWrite as Record<string, unknown>,
              task.diffSummary,
              owner.id,
            );
          }
        }
      }
      // 并入后本任务不再携带 review_request → 收件人回落下发者(R1 缺省语义);
      // 未并入时保留上面按载荷裁定的收件人。仅终态转换写入:trigger 只在这一刻
      // 读 NEW.recipient_participant_ids。
      const recipientsToWrite =
        ownRecipients === undefined
          ? undefined
          : summaryHasReviewRequest(summaryToWrite)
            ? ownRecipients
            : dispatcherRecipients(task.dispatcherParticipantId);
      // Persist the report-only view before terminal PATCH releases its memory
      // buffer, keeping refresh consistent with the live stream.
      if (terminalTransition && liveTaskOutputTail(taskId) !== null) {
        const liveTail = liveTaskOutputTail(taskId);
        if (liveTail) {
          summaryToWrite = mergeDiffSummary(
            summaryToWrite,
            { liveOutputTail: liveTail },
            "metrics",
          );
        }
      }
      // R8(v1.1):PATCH failed 终态时复用 classifyQuotaFailure 判定额度失败,
      // 命中后同口径进入执行器冷却并留痕(与 queue 进程退出/超时/孤儿收敛三条
      // 路径一致)。
      let quotaCooldownEnd: number | undefined;
      let quotaCooldownSource: "parsed" | "fallback" = "fallback";
      let quotaEx: Awaited<ReturnType<typeof findExecutorByKey>> | undefined;
      let quotaErrorText = "";
      if (
        status === "failed" &&
        status !== task.status &&
        typeof summaryToWrite === "object" &&
        summaryToWrite !== null &&
        !Array.isArray(summaryToWrite)
      ) {
        const rawSummary = summaryToWrite as Record<string, unknown>;
        const errorText =
          typeof rawSummary.error === "string" ? rawSummary.error : "";
        if (errorText.trim() !== "") {
          const quotaVerdict = classifyQuotaFailure([errorText], {
            taskBook: task.brief,
            peerExecutorNames: await listPeerExecutorNames(
              db,
              task.executorKey,
            ),
          });
          if (quotaVerdict.isQuota) {
            // R6 主闸(quota-failure-on-clean-exit v1.1):PATCH failed 同样先以
            // 任务窗口内是否产生提交为闸 —— 有提交 → 不判额度、不冷却(有产出即
            // 非耗尽);无提交 → 保留 R8 既有额度语义。探测尽力而为:仓库/git
            // 不可达按「无提交证据」处理,不改变既有判定。
            let commitInWindow: boolean | undefined = false;
            try {
              commitInWindow = await hasCommitInTaskWindow(
                await resolveTaskRepoRoot(db, task),
                task.attempts,
                task.checkpointRef,
              );
            } catch {
              commitInWindow = undefined;
            }
            if (commitInWindow === true) {
              // 匹配到但被提交闸掉:diffSummary 留可读说明,便于事后区分
              // 「没匹配到」与「匹配到但被闸掉」(spec 验收 5/6)。
              summaryToWrite = mergeDiffSummary(
                rawSummary,
                {
                  quotaMatchedButCommitFound: {
                    matchedLine: quotaVerdict.matchedLine,
                    note: "error 命中额度关键词,但任务窗口内存在提交(本次运行有产出),按 quota-failure-on-clean-exit v1.1 R6 不判额度、不进入冷却",
                  },
                },
                "scheduling",
              );
            } else {
              const parsedMs = parseRateLimitRecoveryMs(errorText);
              const cooldownEnd = normalizeCooldownEnd(
                parsedMs ?? Date.now() + getRateLimitCooldownMs(),
              );
              const quotaSource: "parsed" | "fallback" =
                parsedMs !== null &&
                parsedMs > Date.now() + MIN_EFFECTIVE_COOLDOWN_MS
                  ? "parsed"
                  : "fallback";
              const extra: Record<string, unknown> = {
                [EXECUTOR_COOLDOWN_END_MS_FIELD]: cooldownEnd,
                // R3:冷却来源随终态落库(与 queue/孤儿收敛同口径),供
                // restoreExecutorCooldowns 重建与 /api/executors 展示区分
                // 「执行器告知的恢复时刻」与「平台估算」。
                executorCooldownSource: quotaSource,
                ...(quotaVerdict.matchedLine !== null
                  ? { quotaMatchedLine: quotaVerdict.matchedLine }
                  : {}),
              };
              if (
                parsedMs !== null &&
                parsedMs <= Date.now() + MIN_EFFECTIVE_COOLDOWN_MS
              ) {
                extra.cooldownFallbackReason =
                  "解析所得时刻不可用,已回退固定冷却";
                extra.discardedCooldownEndMs = parsedMs;
              }
              summaryToWrite = applyDiffSummaryPatch(rawSummary, extra);
              quotaCooldownEnd = cooldownEnd;
              quotaCooldownSource = quotaSource;
              quotaErrorText = errorText;
              quotaEx = task.executorKey
                ? await findExecutorByKey(db, task.executorKey)
                : undefined;
            }
          }
        }
      }
      const [updated] = await db
        .update(taskTable)
        .set({
          ...(status !== undefined ? { status } : {}),
          ...(diffSummary !== undefined || detachedTerminalPatch
            ? { diffSummary: summaryToWrite }
            : {}),
          ...(checkpointRef !== undefined ? { checkpointRef } : {}),
          ...(brief !== undefined ? { brief } : {}),
          ...(terminalTransition && recipientsToWrite !== undefined
            ? { recipientParticipantIds: recipientsToWrite }
            : {}),
        })
        .where(and(eq(taskTable.id, taskId), eq(taskTable.groupId, id)))
        .returning();
      if (detachedTerminalPatch) {
        releaseTaskOutput(taskId);
      }
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
      // R8(v1.1):额度冷却与群内留痕在落库后触发(与 queue 路径同口径)。
      if (quotaCooldownEnd !== undefined && quotaEx) {
        enterCooldown(quotaEx, quotaCooldownEnd, quotaCooldownSource, {
          db,
          taskId,
        });
        const eta = formatEta(quotaCooldownEnd);
        void postStatus(
          db,
          id,
          task.executorParticipantId,
          quotaEx,
          `❌ [${quotaEx.label}] 任务失败 (执行器额度限制,预计 ${eta} 恢复)\n${quotaErrorText}`,
        );
      }
      return c.json(updated);
    },
  );

export default app;
