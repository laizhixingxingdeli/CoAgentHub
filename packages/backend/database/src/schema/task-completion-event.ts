import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
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
 * The task_id UNIQUE constraint guarantees one event per task; the
 * `trg_task_completion_event` trigger fires on every status UPDATE so scheduler,
 * PATCH, stop, and recovery paths all produce an event exactly once.
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
      .unique()
      .references(() => task.id, { onDelete: "cascade" }),
    groupId: uuid("group_id").notNull(),
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
    index().on(t.dispatcherParticipantId),
    index().on(t.nextAttemptAt),
  ],
);

export const TaskCompletionEvent = createSelectSchema(taskCompletionEvent);
export type TaskCompletionEvent = typeof taskCompletionEvent.$inferSelect;
