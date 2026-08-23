import { zValidator } from "@hono/zod-validator";
import {
  taskDispatchWarning as taskDispatchWarningTable,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import BizError, { BizCodeEnum } from "@laizhixingxingdeli/error/biz";
import type { DataBase } from "@server/lib/database";
import { participantIdentity } from "@server/middleware/participant-identity";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";

/**
 * Durable inbox for warnings raised when a dispatcher targets itself. It is
 * independent from completion events: a warning arrives at creation time and
 * must not consume the task's one terminal completion event.
 */
const app = new Hono<{ Variables: { db: DataBase; participantId: string } }>();

app.use(participantIdentity);

app.get(
  "/:id/task-dispatch-warnings",
  describeRoute({
    description:
      "List durable self-dispatch warnings addressed to a participant. WebSocket task_dispatch_warning_available is only a low-latency hint.",
    responses: {
      200: {
        description: "Self-dispatch warning inbox",
        content: { "application/json": {} },
      },
    },
  }),
  zValidator("param", z.object({ id: z.string().uuid() })),
  async (c) => {
    const db = c.get("db");
    const { id: participantId } = c.req.valid("param");
    if (participantId !== c.get("participantId")) {
      throw new BizError(BizCodeEnum.Forbidden);
    }
    const warnings = await db
      .select({
        id: taskDispatchWarningTable.id,
        taskId: taskDispatchWarningTable.taskId,
        groupId: taskDispatchWarningTable.groupId,
        createdAt: taskDispatchWarningTable.createdAt,
        dispatchAudit: taskTable.dispatchAudit,
      })
      .from(taskDispatchWarningTable)
      .innerJoin(taskTable, eq(taskTable.id, taskDispatchWarningTable.taskId))
      .where(eq(taskDispatchWarningTable.recipientParticipantId, participantId))
      .orderBy(asc(taskDispatchWarningTable.createdAt));
    return c.json({ warnings });
  },
);

export default app;
