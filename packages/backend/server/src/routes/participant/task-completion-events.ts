import { zValidator } from "@hono/zod-validator";
import {
  taskCompletionEvent as taskCompletionEventTable,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import BizError, { BizCodeEnum } from "@laizhixingxingdeli/error/biz";
import type { DataBase } from "@server/lib/database";
import { participantIdentity } from "@server/middleware/participant-identity";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { v7 as uuidv7 } from "uuid";

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
  return new BizError(BizCodeEnum.TaskNotFound, "task completion event not found");
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
      outputTail: task?.diffSummary && typeof task.diffSummary === "object"
        ? (task.diffSummary as Record<string, unknown> | null)?.outputTail ?? null
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
      if (participantId !== c.get("participantId")) {
        throw new BizError(BizCodeEnum.Forbidden);
      }

      const now = new Date();
      const conditions = [
        eq(taskCompletionEventTable.dispatcherParticipantId, participantId),
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
    zValidator("param", z.object({ id: z.string().uuid(), eventId: z.string().uuid() })),
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
            eq(taskCompletionEventTable.dispatcherParticipantId, participantId),
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
    zValidator("param", z.object({ id: z.string().uuid(), eventId: z.string().uuid() })),
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

      if (participantId !== c.get("participantId")) {
        throw new BizError(BizCodeEnum.Forbidden);
      }

      const now = new Date();
      // Idempotent ack: only the matching leaseToken can ack. If already delivered
      // with the same token, succeed (idempotent).
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
            eq(taskCompletionEventTable.dispatcherParticipantId, participantId),
            eq(taskCompletionEventTable.leaseToken, leaseToken),
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
    zValidator("param", z.object({ id: z.string().uuid(), eventId: z.string().uuid() })),
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

      if (participantId !== c.get("participantId")) {
        throw new BizError(BizCodeEnum.Forbidden);
      }

      const event = await db.query.taskCompletionEvent.findFirst({
        where: and(
          eq(taskCompletionEventTable.id, eventId),
          eq(taskCompletionEventTable.dispatcherParticipantId, participantId),
        ),
      });
      if (!event || event.leaseToken !== leaseToken) {
        throw new BizError(
          BizCodeEnum.Conflict,
          "leaseToken mismatch or event not found",
        );
      }

      const truncatedError = error ? error.slice(0, 2000) : null;
      const newAttempts = event.attempts + 1;
      const isDead = newAttempts >= DEFAULT_MAX_ATTEMPTS;
      const nextAttemptAt = new Date(
        Date.now() + (retryAfterMs ?? DEFAULT_RETRY_AFTER_MS),
      );
      const now = new Date();

      const [updated] = await db
        .update(taskCompletionEventTable)
        .set({
          state: isDead ? "dead" : "pending",
          // 原子自增:并发 fail(如 lease 过期后另一方重领)不丢计数;
          // returning 的 attempts 即真实新值。
          attempts: sql`${taskCompletionEventTable.attempts} + 1`,
          nextAttemptAt,
          lastError: truncatedError,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(taskCompletionEventTable.id, eventId))
        .returning();

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
