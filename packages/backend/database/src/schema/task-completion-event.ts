import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createSelectSchema } from "drizzle-zod";
import { v7 as uuidv7 } from "uuid";
import { timeColumns } from "../utils/columns.js";
import { task } from "./task.js";

/**
 * Durable Task Completion Event — platform-agnostic completion event persisted
 * the first time a task enters a terminal state (done/failed/cancelled) when a
 * dispatcherParticipantId is present. Core persists ONLY opaque routing
 * (`callbackRef`) + delivery state; the latest task content is read by joining
 * `task` at read/claim time so the envelope always carries the final
 * diffSummary/outputTail.
 *
 * Delivery target (specs/l3-request-delivery-and-scope.md R1): the **recipient**
 * is adjudicated by the application layer at the terminal transition and carried
 * into this table by the trigger (which never inspects `group_members`). Default
 * is the dispatcher; a completion carrying `review_request` is addressed to the
 * group's reviewer members instead.
 *
 * The (task_id, recipient_participant_id) UNIQUE constraint guarantees one event
 * per task per recipient — a group with several reviewers yields one row each;
 * the `trg_task_completion_event` trigger fires on every status UPDATE so
 * scheduler, PATCH, stop, and recovery paths all produce an event exactly once.
 */
export const TASK_COMPLETION_EVENT_STATES = [
  "pending",
  "leased",
  "delivered",
  "dead",
] as const;
export type TaskCompletionEventState =
  (typeof TASK_COMPLETION_EVENT_STATES)[number];

export const taskCompletionEvent = pgTable(
  "task_completion_event",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    taskId: uuid("task_id")
      .notNull()
      .references(() => task.id, { onDelete: "cascade" }),
    groupId: uuid("group_id").notNull(),
    // 投递对象(R1):应用层裁定的收件人;缺省 = 下发者。inbox 的列举/认领
    // 一律按此列归属(R2),dispatcher 列仅作为审计事实保留。
    recipientParticipantId: text("recipient_participant_id"),
    dispatcherParticipantId: text("dispatcher_participant_id"),
    dispatcherSessionId: text("dispatcher_session_id"),
    // Opaque callback routing: ONLY { platform?, endpointRef?, sessionRef? },
    // short strings — no URL, command, token, or secret.
    callbackRef: jsonb("callback_ref"),
    state: text("state", { enum: TASK_COMPLETION_EVENT_STATES })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...timeColumns("both"),
  },
  (t) => [
    index().on(t.state),
    index().on(t.recipientParticipantId),
    index().on(t.dispatcherParticipantId),
    index().on(t.nextAttemptAt),
    uniqueIndex(
      "task_completion_event_task_id_recipient_participant_id_unique",
    ).on(t.taskId, t.recipientParticipantId),
  ],
);

export const TaskCompletionEvent = createSelectSchema(taskCompletionEvent);
export type TaskCompletionEvent = typeof taskCompletionEvent.$inferSelect;
