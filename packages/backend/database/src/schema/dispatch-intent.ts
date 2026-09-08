import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { v7 as uuidv7 } from "uuid";
import { timeColumns } from "../utils/columns.js";
import { groupMessage } from "./group-message.js";
import { groups } from "./group.js";
import { participant } from "./participant.js";
import { task } from "./task.js";

/**
 * Dispatch intent — durable "should dispatch" record written in the same
 * transaction as the triggering group message (specs/persist-dispatch-intent-
 * with-the-message.md).
 *
 * Intent ≠ task. This row records that a directed message was accepted for
 * dispatch consideration (or permanently rejected), so a crash between
 * "message committed" and "task row created" is recoverable. Recovery never
 * scans bare history messages to guess whether work was due.
 *
 * Status machine:
 *  - pending   — should create a task; recovery may retry
 *  - dispatched — task exists (or was found); terminal success
 *  - rejected  — permanent no-dispatch with rejectReason; terminal
 *  - failed    — last attempt threw; still recoverable (attemptCount tracked)
 */
export const DISPATCH_INTENT_STATUSES = [
  "pending",
  "dispatched",
  "rejected",
  "failed",
] as const;
export type DispatchIntentStatus = (typeof DISPATCH_INTENT_STATUSES)[number];

/**
 * Snapshot of everything maybeDispatchExecutorTask needs besides groupId /
 * messageId (those live as columns). Kept as jsonb so the reclaim path can
 * rebuild the same DispatchExecutorInput without re-deriving from the message.
 */
export interface DispatchIntentPayload {
  senderRoles: string[];
  audience: "participant" | "role";
  audienceRef: string;
  body: string;
  dispatcherParticipantId: string;
  dispatcherSessionId: string | null;
  selectionReason: string | null;
  specRef: string | null;
  specHash: string | null;
  dispatchKind: "requirement" | "fix" | null;
  supersedesTaskId: string | null;
  callbackRef: {
    platform?: string;
    endpointRef?: string;
    sessionRef?: string;
  } | null;
  initialDiffSummary: Record<string, unknown> | null;
}

/**
 * Canonical reject reasons (terminal). Recovery writes the same codes the
 * message route uses for synchronous skips so one vocabulary covers both paths.
 */
export const DISPATCH_INTENT_REJECT_REASONS = [
  "control-command-skipped",
  "reviewer-not-dispatchable",
  "role-unresolved:role-not-legal",
  "role-unresolved:role-no-member",
  "role-unresolved:role-no-executor",
  "sender-not-authorized",
  "redispatch-stopped",
  "participant-not-found",
  "executor-not-configured",
] as const;
export type DispatchIntentRejectReason =
  (typeof DISPATCH_INTENT_REJECT_REASONS)[number];

export const dispatchIntent = pgTable(
  "dispatch_intent",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id),
    // One intent per message (UNIQUE). The message is the natural key of the
    // "should this directed post become a task" decision.
    messageId: uuid("message_id")
      .notNull()
      .references(() => groupMessage.id)
      .unique(),
    audience: text("audience", {
      enum: ["participant", "role"],
    }).notNull(),
    audienceRef: text("audience_ref").notNull(),
    /** Full dispatch input snapshot (see DispatchIntentPayload). */
    payload: jsonb("payload").$type<DispatchIntentPayload>().notNull(),
    status: text("status", { enum: DISPATCH_INTENT_STATUSES })
      .notNull()
      .default("pending"),
    /** Set when status=rejected; null otherwise. */
    rejectReason: text("reject_reason"),
    /** Participant resolved as the executor target when dispatched. */
    resolvedParticipantId: uuid("resolved_participant_id").references(
      () => participant.id,
    ),
    /** Task created (or found) for this intent; null until dispatched. */
    taskId: uuid("task_id").references(() => task.id),
    /** How many recovery / settle attempts have run (incl. the first live path). */
    attemptCount: integer("attempt_count").notNull().default(0),
    /** Last async failure text; null when clean. */
    lastError: text("last_error"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    /** Stall-style alert already emitted for a stuck pending/failed intent. */
    stallAlerted: integer("stall_alerted").notNull().default(0),
    ...timeColumns("both"),
  },
  (t) => [
    // Reclaim scans open intents by status + age.
    index("dispatch_intent_status_created_at_idx").on(t.status, t.createdAt),
    index("dispatch_intent_group_id_idx").on(t.groupId),
  ],
);

export const DispatchIntent = createSelectSchema(dispatchIntent);
export type DispatchIntent = typeof dispatchIntent.$inferSelect;
export const NewDispatchIntent = createInsertSchema(dispatchIntent);
export type NewDispatchIntent = typeof dispatchIntent.$inferInsert;
