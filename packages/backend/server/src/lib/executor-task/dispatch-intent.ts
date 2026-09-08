/**
 * Durable dispatch intent (specs/persist-dispatch-intent-with-the-message.md).
 *
 * Intent ≠ task. Written in the same transaction as the group message so a
 * crash between "message committed" and "task created" leaves a recoverable
 * record. Recovery rebuilds the same DispatchExecutorInput and calls
 * maybeDispatchExecutorTask — one dispatch decision source (ADR-0009 / S3).
 */

import {
  type DispatchIntentPayload,
  type DispatchIntentRejectReason,
  dispatchIntent as dispatchIntentTable,
} from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import { insertGroupMessage } from "@server/lib/services/message-service";
import { wsHub } from "@server/lib/ws-hub";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { postStatus } from "./notify";
import { maybeDispatchExecutorTask } from "./queue";
import { getStallAlertMs } from "./state";
import type { DispatchExecutorInput, DispatchOutcome } from "./types";

/** Open intents older than this may be recovered (avoids racing the live path). */
export const DISPATCH_INTENT_RECLAIM_GRACE_MS = 5_000;

type IntentRow = typeof dispatchIntentTable.$inferSelect;

/** DB handle that can insert inside an outer transaction (or top-level db). */
export type IntentDb = Pick<DataBase, "insert" | "update" | "query" | "select">;

export interface WriteDispatchIntentInput {
  groupId: string;
  messageId: string;
  audience: "participant" | "role";
  audienceRef: string;
  payload: DispatchIntentPayload;
  /** When set, row is written as rejected (terminal) in the same transaction. */
  rejectReason?: DispatchIntentRejectReason;
}

/** Persist intent row (call inside the message write transaction). */
export async function writeDispatchIntent(
  db: IntentDb,
  input: WriteDispatchIntentInput,
): Promise<void> {
  const rejected = input.rejectReason !== undefined;
  await db.insert(dispatchIntentTable).values({
    groupId: input.groupId,
    messageId: input.messageId,
    audience: input.audience,
    audienceRef: input.audienceRef,
    payload: input.payload,
    status: rejected ? "rejected" : "pending",
    rejectReason: input.rejectReason ?? null,
  });
}

export function payloadFromDispatchInput(
  input: DispatchExecutorInput,
): DispatchIntentPayload {
  return {
    senderRoles: input.senderRoles,
    audience: input.audience ?? "participant",
    audienceRef: input.audienceRef,
    body: input.body,
    dispatcherParticipantId: input.dispatcherParticipantId,
    dispatcherSessionId: input.dispatcherSessionId,
    selectionReason: input.selectionReason ?? null,
    specRef: input.specRef,
    specHash: input.specHash,
    dispatchKind: input.dispatchKind,
    supersedesTaskId: input.supersedesTaskId,
    callbackRef: input.callbackRef,
    initialDiffSummary: input.initialDiffSummary ?? null,
  };
}

export function dispatchInputFromIntent(row: IntentRow): DispatchExecutorInput {
  const p = row.payload;
  return {
    groupId: row.groupId,
    messageId: row.messageId,
    senderRoles: p.senderRoles,
    audience: p.audience,
    audienceRef: p.audienceRef,
    body: p.body,
    dispatcherParticipantId: p.dispatcherParticipantId,
    dispatcherSessionId: p.dispatcherSessionId,
    selectionReason: p.selectionReason,
    specRef: p.specRef,
    specHash: p.specHash,
    dispatchKind: p.dispatchKind,
    supersedesTaskId: p.supersedesTaskId,
    callbackRef: p.callbackRef,
    initialDiffSummary: p.initialDiffSummary,
  };
}

/**
 * After a live or recovery dispatch attempt: mark the intent terminal based on
 * outcome + whether a task row exists for messageId (idempotent).
 */
export async function settleDispatchIntentAfterAttempt(
  db: DataBase,
  messageId: string,
  outcome: DispatchOutcome | undefined,
): Promise<void> {
  const intent = await db.query.dispatchIntent.findFirst({
    where: (t, { eq: eqFn }) => eqFn(t.messageId, messageId),
  });
  if (!intent) return;
  if (intent.status === "dispatched" || intent.status === "rejected") return;

  const task = await db.query.task.findFirst({
    where: (t, { eq: eqFn }) => eqFn(t.messageId, messageId),
    columns: { id: true, executorParticipantId: true },
  });
  if (task) {
    await markDispatched(db, intent.id, task.id, task.executorParticipantId);
    return;
  }

  const reject = rejectReasonFromOutcome(outcome);
  if (reject) {
    await markRejected(db, intent.id, reject);
    return;
  }

  // No task and no clear reject → record a soft failure; recovery may retry.
  await markFailed(
    db,
    intent.id,
    outcome
      ? `unsettled outcome: ${outcome.status}`
      : "dispatch returned without task",
  );
}

export async function recordDispatchIntentFailure(
  db: DataBase,
  messageId: string,
  error: unknown,
): Promise<void> {
  const intent = await db.query.dispatchIntent.findFirst({
    where: (t, { eq: eqFn }) => eqFn(t.messageId, messageId),
    columns: { id: true, status: true },
  });
  if (!intent) return;
  if (intent.status === "dispatched" || intent.status === "rejected") return;
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error);
  await markFailed(db, intent.id, text.slice(0, 2000));
}

/**
 * Live-path wrapper: run maybeDispatchExecutorTask then settle the intent.
 * Keeps participant fire-and-forget / role await semantics at the call site.
 */
export async function dispatchAndSettleIntent(
  db: DataBase,
  input: DispatchExecutorInput,
): Promise<DispatchOutcome | undefined> {
  try {
    const outcome = await maybeDispatchExecutorTask(db, input);
    await settleDispatchIntentAfterAttempt(db, input.messageId, outcome);
    return outcome;
  } catch (err) {
    await recordDispatchIntentFailure(db, input.messageId, err);
    throw err;
  }
}

/** Single-round recovery: open intents with no task → same dispatch path. */
export interface IntentReclaimResult {
  recovered: number;
  rejected: number;
  failed: number;
  stalled: number;
}

export async function reclaimDispatchIntents(
  db: DataBase,
  now = new Date(),
): Promise<IntentReclaimResult> {
  const cutoff = new Date(now.getTime() - DISPATCH_INTENT_RECLAIM_GRACE_MS);
  const open = await db.query.dispatchIntent.findMany({
    where: and(
      inArray(dispatchIntentTable.status, ["pending", "failed"]),
      lt(dispatchIntentTable.createdAt, cutoff),
    ),
    orderBy: (t, { asc: ascFn }) => [ascFn(t.createdAt)],
  });

  let recovered = 0;
  let rejected = 0;
  let failed = 0;

  for (const intent of open) {
    const result = await recoverOneIntent(db, intent);
    if (result === "dispatched") recovered += 1;
    else if (result === "rejected") rejected += 1;
    else if (result === "failed") failed += 1;
  }

  let stalled = 0;
  for (const intent of open) {
    if (await alertStuckIntent(db, intent, now)) stalled += 1;
  }

  return { recovered, rejected, failed, stalled };
}

async function recoverOneIntent(
  db: DataBase,
  intent: IntentRow,
): Promise<"dispatched" | "rejected" | "failed" | "noop"> {
  if (intent.status === "dispatched" || intent.status === "rejected") {
    return "noop";
  }

  // Idempotency first: task may already exist (message_id UNIQUE / prior attempt).
  const existing = await db.query.task.findFirst({
    where: (t, { eq: eqFn }) => eqFn(t.messageId, intent.messageId),
    columns: { id: true, executorParticipantId: true },
  });
  if (existing) {
    await markDispatched(
      db,
      intent.id,
      existing.id,
      existing.executorParticipantId,
    );
    return "dispatched";
  }

  try {
    const outcome = await maybeDispatchExecutorTask(
      db,
      dispatchInputFromIntent(intent),
    );
    await settleDispatchIntentAfterAttempt(db, intent.messageId, outcome);
    const after = await db.query.dispatchIntent.findFirst({
      where: (t, { eq: eqFn }) => eqFn(t.id, intent.id),
      columns: { status: true },
    });
    if (after?.status === "dispatched") return "dispatched";
    if (after?.status === "rejected") return "rejected";
    return "failed";
  } catch (err) {
    await recordDispatchIntentFailure(db, intent.messageId, err);
    return "failed";
  }
}

/**
 * Stuck open intent past stall threshold → same visibility path as queued
 * stall (group ⚠️ + hand back to coordinator). Does not invent a task row.
 */
async function alertStuckIntent(
  db: DataBase,
  intent: IntentRow,
  now: Date,
): Promise<boolean> {
  const fresh = await db.query.dispatchIntent.findFirst({
    where: (t, { eq: eqFn }) => eqFn(t.id, intent.id),
  });
  if (!fresh) return false;
  if (fresh.status !== "pending" && fresh.status !== "failed") return false;
  if (fresh.stallAlerted) return false;
  if (now.getTime() - fresh.createdAt.getTime() < getStallAlertMs()) {
    return false;
  }

  await db
    .update(dispatchIntentTable)
    .set({ stallAlerted: 1, updatedAt: now })
    .where(
      and(
        eq(dispatchIntentTable.id, fresh.id),
        inArray(dispatchIntentTable.status, ["pending", "failed"]),
        eq(dispatchIntentTable.stallAlerted, 0),
      ),
    );

  const minutes = Math.max(1, Math.round(getStallAlertMs() / 60_000));
  const detail =
    fresh.lastError?.trim() ||
    fresh.rejectReason ||
    "意图已持久化但尚未建成 task";
  const sender = fresh.payload.dispatcherParticipantId;
  if (sender) {
    await postStatus(
      db,
      fresh.groupId,
      sender,
      { label: "平台调度意图兜底" },
      `⚠️ 消息 ${fresh.messageId} 的调度意图已超过 ${minutes} 分钟仍未建成 task(${detail}),请协调者介入`,
    );
    await handBackStuckIntent(
      db,
      fresh.groupId,
      sender,
      fresh.messageId,
      minutes,
      detail,
    );
  }
  return true;
}

async function handBackStuckIntent(
  db: DataBase,
  groupId: string,
  senderId: string,
  messageId: string,
  minutes: number,
  reasonText: string,
): Promise<void> {
  const members = await db.query.groupMember.findMany({
    where: (t, { eq: eqFn }) => eqFn(t.groupId, groupId),
    columns: { roles: true },
  });
  if (!members.some((m) => m.roles.includes("coordinator"))) return;
  try {
    const full = await insertGroupMessage(db, {
      groupId,
      senderId,
      parentId: null,
      audience: "role",
      audienceRef: "coordinator",
      body: `⚠️ 调度意图兜底:消息 ${messageId} 已超过 ${minutes} 分钟仍未建成 task(${reasonText}),请协调者决定重派或取消。`,
      contentType: "task_status",
      fileRef: null,
    });
    void wsHub.broadcastGroupMessage(full);
  } catch (e) {
    console.warn(`[dispatch-intent] 交回协调者失败(${messageId}): ${e}`);
  }
}

function rejectReasonFromOutcome(
  outcome: DispatchOutcome | undefined,
): DispatchIntentRejectReason | null {
  if (!outcome) return null;
  if (outcome.status === "reviewer-not-dispatchable") {
    return "reviewer-not-dispatchable";
  }
  if (outcome.status === "role-unresolved") {
    return `role-unresolved:${outcome.reason}` as DispatchIntentRejectReason;
  }
  if (outcome.status === "redispatch-stopped") {
    return "redispatch-stopped";
  }
  if (outcome.status === "skipped") {
    return outcome.reason;
  }
  return null;
}

async function markDispatched(
  db: DataBase,
  intentId: string,
  taskId: string,
  resolvedParticipantId: string,
): Promise<void> {
  await db
    .update(dispatchIntentTable)
    .set({
      status: "dispatched",
      taskId,
      resolvedParticipantId,
      lastError: null,
      lastAttemptAt: new Date(),
      attemptCount: sql`${dispatchIntentTable.attemptCount} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(dispatchIntentTable.id, intentId),
        inArray(dispatchIntentTable.status, ["pending", "failed"]),
      ),
    );
}

async function markRejected(
  db: DataBase,
  intentId: string,
  reason: DispatchIntentRejectReason,
): Promise<void> {
  await db
    .update(dispatchIntentTable)
    .set({
      status: "rejected",
      rejectReason: reason,
      lastAttemptAt: new Date(),
      attemptCount: sql`${dispatchIntentTable.attemptCount} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(dispatchIntentTable.id, intentId),
        inArray(dispatchIntentTable.status, ["pending", "failed"]),
      ),
    );
}

async function markFailed(
  db: DataBase,
  intentId: string,
  error: string,
): Promise<void> {
  await db
    .update(dispatchIntentTable)
    .set({
      status: "failed",
      lastError: error,
      lastAttemptAt: new Date(),
      attemptCount: sql`${dispatchIntentTable.attemptCount} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(dispatchIntentTable.id, intentId),
        inArray(dispatchIntentTable.status, ["pending", "failed"]),
      ),
    );
}

/** Test helper: load intent by message id. */
export async function findDispatchIntentByMessage(
  db: DataBase,
  messageId: string,
): Promise<IntentRow | undefined> {
  return db.query.dispatchIntent.findFirst({
    where: (t, { eq: eqFn }) => eqFn(t.messageId, messageId),
  });
}
