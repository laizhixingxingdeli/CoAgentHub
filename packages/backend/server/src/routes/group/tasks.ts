import { zValidator } from "@hono/zod-validator";
import {
  TASK_STATUSES,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import BizError, { BizCodeEnum } from "@laizhixingxingdeli/error/biz";
import type { DataBase } from "@server/lib/database";
import {
  notifyTaskStatusChanged,
  taskOutputTail,
} from "@server/lib/executor-task";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { assertGroupWritable } from "./helpers";

/**
 * 群任务子路由:创建(按 message_id 幂等)/ 列表(分页 + 可选 outputTail)/
 * 详情 / 状态回写(执行器 PATCH)。server 为单一状态源,桥是纯执行器客户端。
 * 挂在 /api/groups 下(路径 /:id/tasks...),与拆分前完全一致。
 */

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
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const callerId = c.get("participantId");
      const { id } = c.req.valid("param");
      const { messageId, executorParticipantId, checkpointRef, specRef, specHash } =
        c.req.valid("json");

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
      // 只返回任务详情约定字段(不泄露 attempts/a2aContextId 等内部列)。
      const detail: Record<string, unknown> = {
        id: task.id,
        groupId: task.groupId,
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
        // 任务下发者信息(Part A):透传给插件(定向通知用);老任务为 null。
        dispatcherParticipantId: task.dispatcherParticipantId ?? null,
        dispatcherSessionId: task.dispatcherSessionId ?? null,
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
      const [updated] = await db
        .update(taskTable)
        .set({
          ...(status !== undefined ? { status } : {}),
          ...(diffSummary !== undefined ? { diffSummary } : {}),
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
      }
      return c.json(updated);
    },
  );

export default app;
