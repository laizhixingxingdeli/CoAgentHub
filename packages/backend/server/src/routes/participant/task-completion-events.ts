import { zValidator } from "@hono/zod-validator";
import {
  taskCompletionEvent as taskCompletionEventTable,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import BizError, { BizCodeEnum } from "@laizhixingxingdeli/error/biz";
import type { DataBase } from "@server/lib/database";
import { assertPathParticipantExists } from "@server/lib/unknown-participant";
import { participantIdentity } from "@server/middleware/participant-identity";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";

/**
 * Task Completion Events inbox + lease API.
 *
 * Participant-scoped: a consumer reads pending/retriable/expired events for its
 * participant, claims one (lease), then ack/fail. WS only delivers a lightweight
 * `task_completion_available` hint; the database inbox is the reliable source.
 */
const app = new Hono<{ Variables: { db: DataBase; participantId: string } }>();

app.use(participantIdentity);

const MAX_LIMIT = 100;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_RETRY_AFTER_MS = 60_000;
const MAX_LEASE_MS = 3600_000;

function eventNotFound() {
  return new BizError(
    BizCodeEnum.TaskNotFound,
    "task completion event not found",
  );
}

/**
 * fail 命中 0 行后的原因分类(只读,不产生任何写入)。
 *
 * 判据:以「当前行的 state」代替「UPDATE 为何没命中」——UPDATE 只回答命中了几行,
 * 不回答原因。这不成立的场景:UPDATE 与本查询之间行被再次改动(例如另一个消费者
 * 恰好在这一瞬重领),此时分类会偏旧。后果仅限文案:响应码恒为 409 且已确认没有
 * 写入,消费者据此不会误判为需要重试,因此接受这个偏差。
 */
async function failConflictReason(
  db: DataBase,
  eventId: string,
  participantId: string,
): Promise<string> {
  const current = await db.query.taskCompletionEvent.findFirst({
    where: and(
      eq(taskCompletionEventTable.id, eventId),
      eq(taskCompletionEventTable.recipientParticipantId, participantId),
    ),
    columns: { state: true },
  });
  if (!current) {
    return "task completion event not found or not addressed to this participant";
  }
  if (current.state === "delivered") {
    return "event already delivered; fail is no longer effective (no retry needed)";
  }
  if (current.state === "dead") {
    return "event is dead (max attempts exceeded); fail is no longer effective (no retry needed)";
  }
  return "leaseToken is invalid or the lease has expired (event re-claimed or already failed); claim it again before failing";
}

/**
 * Build the standard completion-event envelope (schemaVersion=1).
 * Reads the current task row so diffSummary/outputTail are always fresh.
 */
async function buildEnvelope(
  db: DataBase,
  event: typeof taskCompletionEventTable.$inferSelect,
) {
  const task = await db.query.task.findFirst({
    where: eq(taskTable.id, event.taskId),
  });
  return {
    schemaVersion: 1,
    type: "coagenthub.task.completed",
    eventId: event.id,
    dispatcherParticipantId: event.dispatcherParticipantId,
    dispatcherSessionId: event.dispatcherSessionId,
    callbackRef: event.callbackRef,
    task: {
      groupId: task?.groupId ?? event.groupId,
      taskId: event.taskId,
      status: task?.status ?? null,
      specRef: task?.specRef ?? null,
      specHash: task?.specHash ?? null,
      diffSummary: task?.diffSummary ?? null,
      outputTail:
        task?.diffSummary && typeof task.diffSummary === "object"
          ? ((task.diffSummary as Record<string, unknown> | null)?.outputTail ??
            null)
          : null,
    },
  };
}

app
  .get(
    "/:id/task-completion-events",
    describeRoute({
      description:
        "List task completion events for a participant (pending / retriable / lease expired). Supports ?after=<eventId> cursor and ?limit=<n> (max 100).",
      responses: {
        200: {
          description: "List of completion events",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator("param", z.object({ id: z.string().uuid() })),
    zValidator(
      "query",
      z.object({
        after: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const { id: participantId } = c.req.valid("param");
      const { after, limit } = c.req.valid("query");

      // Only the owning participant may read its inbox.
      // 路径 participant 不存在 → 404(身份问题,含修复建议);存在但调用者
      // 不符 → 403(措辞逐字不变,回归必测)。
      await assertPathParticipantExists(db, participantId);
      if (participantId !== c.get("participantId")) {
        throw new BizError(BizCodeEnum.Forbidden);
      }

      const now = new Date();
      const conditions = [
        // R2(specs/l3-request-delivery-and-scope.md):inbox 归属按**收件人**
        // —— 带 review_request 的事件投给群内 reviewer,其余仍投给下发者。
        eq(taskCompletionEventTable.recipientParticipantId, participantId),
        // 只列可认领事件:pending 且重试时间已到(nextAttemptAt 为 null = 从未
        // fail;≤ now = 重试窗口已到),或 lease 已过期(leased 但 leaseExpiresAt
        // ≤ now)。delivered/dead 不列出。
        or(
          and(
            eq(taskCompletionEventTable.state, "pending"),
            or(
              isNull(taskCompletionEventTable.nextAttemptAt),
              lte(taskCompletionEventTable.nextAttemptAt, now),
            ),
          ),
          and(
            eq(taskCompletionEventTable.state, "leased"),
            lte(taskCompletionEventTable.leaseExpiresAt, now),
          ),
        ),
      ];
      if (after) {
        conditions.push(sql`${taskCompletionEventTable.id} > ${after}`);
      }

      const rows = await db
        .select()
        .from(taskCompletionEventTable)
        .where(and(...conditions))
        .orderBy(asc(taskCompletionEventTable.id))
        .limit(limit ?? MAX_LIMIT);

      // 每条返回标准信封 + 交付状态(delivery state 属于 event row,inbox 消费
      // 方需要知道可认领性;信封本体保持 schemaVersion=1 标准形状)。
      const events = await Promise.all(
        rows.map(async (e) => ({
          ...(await buildEnvelope(db, e)),
          state: e.state,
          attempts: e.attempts,
          nextAttemptAt: e.nextAttemptAt,
        })),
      );
      return c.json({ events });
    },
  )
  .post(
    "/:id/task-completion-events/:eventId/claim",
    describeRoute({
      description:
        "Atomically claim a task completion event (lease). Body: { consumerId, leaseMs }. Returns leaseToken + event envelope.",
      responses: {
        200: {
          description: "Event claimed",
          content: { "application/json": {} },
        },
        409: {
          description: "Event already leased or state conflict",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator(
      "param",
      z.object({ id: z.string().uuid(), eventId: z.string().uuid() }),
    ),
    zValidator(
      "json",
      z.object({
        consumerId: z.string().min(1).max(200),
        leaseMs: z.number().int().min(1000).max(MAX_LEASE_MS),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const { id: participantId, eventId } = c.req.valid("param");
      const { consumerId, leaseMs } = c.req.valid("json");

      // 路径 participant 不存在 → 404(身份问题,含修复建议);存在但调用者
      // 不符 → 403(措辞逐字不变,回归必测)。
      await assertPathParticipantExists(db, participantId);
      if (participantId !== c.get("participantId")) {
        throw new BizError(BizCodeEnum.Forbidden);
      }

      const leaseToken = uuidv7();
      const leaseExpiresAt = new Date(Date.now() + leaseMs);
      const now = new Date();

      // Atomic claim: only succeeds if the event is pending with its retry
      // window open (nextAttemptAt null or already passed), or leased but
      // expired — one statement, no read-then-write race.
      const [claimed] = await db
        .update(taskCompletionEventTable)
        .set({
          state: "leased",
          leaseToken,
          leaseExpiresAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(taskCompletionEventTable.id, eventId),
            eq(taskCompletionEventTable.recipientParticipantId, participantId),
            or(
              and(
                eq(taskCompletionEventTable.state, "pending"),
                or(
                  isNull(taskCompletionEventTable.nextAttemptAt),
                  lte(taskCompletionEventTable.nextAttemptAt, now),
                ),
              ),
              and(
                eq(taskCompletionEventTable.state, "leased"),
                lte(taskCompletionEventTable.leaseExpiresAt, now),
              ),
            ),
          ),
        )
        .returning();

      if (!claimed) {
        throw new BizError(
          BizCodeEnum.Conflict,
          "event is not claimable (already leased, delivered, or not found)",
        );
      }

      const envelope = await buildEnvelope(db, claimed);
      return c.json({ leaseToken, event: envelope });
    },
  )
  .post(
    "/:id/task-completion-events/:eventId/ack",
    describeRoute({
      description:
        "Acknowledge a claimed event as delivered. Idempotent for the same leaseToken.",
      responses: {
        200: {
          description: "Event acknowledged",
          content: { "application/json": {} },
        },
        409: {
          description: "leaseToken mismatch",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator(
      "param",
      z.object({ id: z.string().uuid(), eventId: z.string().uuid() }),
    ),
    zValidator(
      "json",
      z.object({
        leaseToken: z.string().uuid(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const { id: participantId, eventId } = c.req.valid("param");
      const { leaseToken } = c.req.valid("json");

      // 路径 participant 不存在 → 404(身份问题,含修复建议);存在但调用者
      // 不符 → 403(措辞逐字不变,回归必测)。
      await assertPathParticipantExists(db, participantId);
      if (participantId !== c.get("participantId")) {
        throw new BizError(BizCodeEnum.Forbidden);
      }

      const now = new Date();
      // Idempotent ack: only the matching leaseToken can ack, and only from a
      // leased (or already delivered — repeat ack) row. `pending`/`dead` rows are
      // no longer promotable to delivered by a leftover token.
      // leaseToken is deliberately NOT cleared here: clearing it would break the
      // repeat-ack idempotency contract (2nd ack → 409); the fail endpoint's
      // `state='leased'` guard is what prevents delivered → pending instead.
      const [acked] = await db
        .update(taskCompletionEventTable)
        .set({
          state: "delivered",
          deliveredAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(taskCompletionEventTable.id, eventId),
            eq(taskCompletionEventTable.recipientParticipantId, participantId),
            eq(taskCompletionEventTable.leaseToken, leaseToken),
            inArray(taskCompletionEventTable.state, ["leased", "delivered"]),
          ),
        )
        .returning();

      if (!acked) {
        throw new BizError(
          BizCodeEnum.Conflict,
          "leaseToken mismatch or event not found",
        );
      }

      return c.json({ success: true, eventId });
    },
  )
  .post(
    "/:id/task-completion-events/:eventId/fail",
    describeRoute({
      description:
        "Record a delivery failure. Increments attempts, sets retryAfterMs; exceeds max attempts → dead.",
      responses: {
        200: {
          description: "Failure recorded",
          content: { "application/json": {} },
        },
        409: {
          description: "leaseToken mismatch",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator(
      "param",
      z.object({ id: z.string().uuid(), eventId: z.string().uuid() }),
    ),
    zValidator(
      "json",
      z.object({
        leaseToken: z.string().uuid(),
        error: z.string().max(2000).optional(),
        retryAfterMs: z.number().int().min(0).optional(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const { id: participantId, eventId } = c.req.valid("param");
      const { leaseToken, error, retryAfterMs } = c.req.valid("json");

      // 路径 participant 不存在 → 404(身份问题,含修复建议);存在但调用者
      // 不符 → 403(措辞逐字不变,回归必测)。
      await assertPathParticipantExists(db, participantId);
      if (participantId !== c.get("participantId")) {
        throw new BizError(BizCodeEnum.Forbidden);
      }

      const truncatedError = error ? error.slice(0, 2000) : null;
      const nextAttemptAt = new Date(
        Date.now() + (retryAfterMs ?? DEFAULT_RETRY_AFTER_MS),
      );
      const now = new Date();

      // 单条原子 fail(spec completion-event-fail-atomic-lease-guard R1/R2):
      // WHERE 覆盖 eventId + 收件人 + leaseToken + state='leased' —— 读与写之间
      // 不存在窗口,过期 lease、重复 fail、ack 之后的迟到 fail 一律命中 0 行。
      // state 与 attempts 在同一条 UPDATE 内按同一个行版本计算(CASE 表达式读的
      // 是更新前的 attempts),因此 returning 出的两者必然自洽。
      const [updated] = await db
        .update(taskCompletionEventTable)
        .set({
          state: sql`CASE WHEN ${taskCompletionEventTable.attempts} + 1 >= ${DEFAULT_MAX_ATTEMPTS} THEN 'dead' ELSE 'pending' END`,
          // 原子自增:并发 fail(如 lease 过期后另一方重领)不丢计数;
          // returning 的 attempts 即真实新值。
          attempts: sql`${taskCompletionEventTable.attempts} + 1`,
          nextAttemptAt,
          lastError: truncatedError,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(taskCompletionEventTable.id, eventId),
            eq(taskCompletionEventTable.recipientParticipantId, participantId),
            eq(taskCompletionEventTable.leaseToken, leaseToken),
            eq(taskCompletionEventTable.state, "leased"),
          ),
        )
        .returning();

      // 0 行命中:不做任何写入,只读回当前行把原因分类(消费者是 LLM 或脚本,
      // 文案就是它的修复指引)。
      if (!updated) {
        throw new BizError(
          BizCodeEnum.Conflict,
          await failConflictReason(db, eventId, participantId),
        );
      }

      return c.json({
        success: true,
        eventId,
        attempts: updated?.attempts,
        state: updated?.state,
        nextAttemptAt: updated?.nextAttemptAt,
      });
    },
  );

export default app;
