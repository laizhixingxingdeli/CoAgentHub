/**
 * S1 第 2 阶段第 2 个转换:quota-failure 两处回写 queued 的乐观并发守卫。
 *
 * 验收(两处各一条):
 *  - 瞬时限流退避重排队:写 queued 前已被改为 cancelled
 *    → 保持 cancelled,且不重新入队;
 *  - 403 并发冲突重排队:同上。
 *
 * 变异:分别临时去掉两处 expectedStatuses:["running"] 时对应用例必须变红
 * (docs/adr/0011-acceptance-tests-must-be-able-to-fail.md)。
 */
import { randomUUID } from "node:crypto";
import {
  groupMessage as groupMessageTable,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import { findExecutorByKey } from "@server/lib/executors";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DataBase } from "../src/lib/database";
import {
  handleConcurrencyConflict,
  handleTransientQuotaBackoff,
} from "../src/lib/executor-task/quota-failure";
import type { QueuedRun } from "../src/lib/executor-task/types";
import { createTestApp } from "./app";
import { seedBuiltinExecutorConfigs, testDb } from "./db";

const runtimeDb = testDb as unknown as DataBase;
const app = createTestApp();

const {
  __resetExecutorQueueForTests,
  __setTransientQuotaForTests,
  groupQueues,
} = await import("../src/lib/executor-task/state");
const { queuedExecutorTaskCount, ensureGroupQueue } = await import(
  "../src/lib/executor-task/dispatchability"
);

beforeAll(async () => {
  await seedBuiltinExecutorConfigs();
});

beforeEach(() => {
  __resetExecutorQueueForTests();
  // 启用瞬时限流处置,避免 fail-safe 走 exhausted。
  __setTransientQuotaForTests(2_000, 3);
});

afterEach(() => {
  __resetExecutorQueueForTests();
  __setTransientQuotaForTests(null, null);
});

async function register(name: string) {
  const res = await app.request("/api/participants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (res.status === 409) {
    const list = (await (await app.request("/api/participants")).json()) as {
      id: string;
      name: string;
    }[];
    const existing = list.find((p) => p.name === name);
    if (existing) return { id: existing.id };
  }
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string };
}

async function createGroup(coordinatorId: string, title: string) {
  const res = await app.request("/api/groups", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Participant-Id": coordinatorId,
    },
    body: JSON.stringify({ title }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string };
}

async function addMember(
  actorId: string,
  groupId: string,
  memberId: string,
  roles: string[],
) {
  const res = await app.request(`/api/groups/${groupId}/members`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Participant-Id": actorId,
    },
    body: JSON.stringify({ participantId: memberId, roles }),
  });
  expect(res.status).toBe(200);
}

function buildRun(opts: {
  groupId: string;
  taskId: string;
  messageId: string;
  participantId: string;
  ex: NonNullable<Awaited<ReturnType<typeof findExecutorByKey>>>;
  summary?: string;
}): QueuedRun {
  const now = Date.now();
  return {
    db: runtimeDb,
    groupId: opts.groupId,
    messageId: opts.messageId,
    taskId: opts.taskId,
    participantId: opts.participantId,
    ex: opts.ex,
    body: `任务:${opts.summary ?? "重排队守卫"}`,
    summary: opts.summary ?? "重排队守卫",
    groupPrompt: null,
    groupKey: opts.groupId,
    projectPath: null,
    kill: null,
    stopped: false,
    createdAt: now,
    runningAt: now,
    lastOutputAt: now,
    lastActivityAt: now,
    claimTimer: null,
    stallTimer: null,
    stallAlertTimer: null,
    a2aSilenceTimer: null,
    detachedTimer: null,
    stalled: false,
    stallAlerted: false,
    a2aSilenced: false,
    detached: false,
    detachedTimedOut: false,
    retryCount: 0,
    checkpointRef: null,
    specRef: null,
    specHash: null,
    dispatchKind: null,
    concurrencyBlocked: false,
    concurrencyRetryAt: 0,
    transientQuotaCount: 0,
    attempts: [
      {
        n: 1,
        startedAt: new Date(now).toISOString(),
        status: "running",
      },
    ],
  };
}

async function getTask(taskId: string) {
  const [row] = await testDb
    .select()
    .from(taskTable)
    .where(eq(taskTable.id, taskId));
  return row;
}

async function listGroupMessages(groupId: string) {
  return testDb
    .select()
    .from(groupMessageTable)
    .where(eq(groupMessageTable.groupId, groupId));
}

function isTransientRetryCard(body: string): boolean {
  return body.includes("⏳") && body.includes("瞬时限流");
}

function isConcurrencyRetryCard(body: string): boolean {
  return body.includes("📋") && body.includes("403 并发冲突");
}

async function seedRunningTask(label: string) {
  const stamp = Date.now();
  const owner = await register(`requeue-guard-${label}-owner-${stamp}`);
  const exec = await register(`requeue-guard-${label}-exec-${stamp}`);
  const group = await createGroup(owner.id, `requeue-guard-${label}-${stamp}`);
  await addMember(owner.id, group.id, exec.id, ["executor"]);

  const ex = await findExecutorByKey(runtimeDb, "codebuddy");
  expect(ex).toBeTruthy();
  if (!ex) throw new Error("codebuddy fixture missing");

  const messageId = randomUUID();
  const [task] = await testDb
    .insert(taskTable)
    .values({
      groupId: group.id,
      messageId,
      executorParticipantId: exec.id,
      executorKey: "codebuddy",
      status: "running",
      diffSummary: { summary: "still running" },
    })
    .returning({ id: taskTable.id });

  // 组队列必须存在,否则走 failTask 兜底(本票不改那条分支)。
  ensureGroupQueue(group.id);

  const run = buildRun({
    groupId: group.id,
    taskId: task.id,
    messageId,
    participantId: exec.id,
    ex,
    summary: label,
  });

  return { group, task, run, ex };
}

describe("quota-failure 回写 queued 乐观并发守卫 (S1)", () => {
  it("瞬时限流:running → queued 并重新入队(正常路径)", async () => {
    const { group, task, run } = await seedRunningTask("transient-ok");
    const beforeCount = queuedExecutorTaskCount(group.id);

    await handleTransientQuotaBackoff(
      run,
      "exit 1",
      "[rate-limited] try again in 5 seconds",
      "[rate-limited] try again in 5 seconds",
    );

    const row = await getTask(task.id);
    expect(row?.status).toBe("queued");
    expect(queuedExecutorTaskCount(group.id)).toBe(beforeCount + 1);
    expect(
      groupQueues.get(group.id)?.queue.some((r) => r.taskId === task.id),
    ).toBe(true);

    const messages = await listGroupMessages(group.id);
    expect(messages.some((m) => isTransientRetryCard(m.body))).toBe(true);
  });

  it("瞬时限流:写 queued 前已被改为 cancelled → 保持 cancelled,且不重新入队", async () => {
    const { group, task, run } = await seedRunningTask("transient-race");

    await testDb
      .update(taskTable)
      .set({
        status: "cancelled",
        diffSummary: { error: "stopped", summary: "stop won the race" },
      })
      .where(eq(taskTable.id, task.id));

    const beforeCount = queuedExecutorTaskCount(group.id);
    const beforeMessages = await listGroupMessages(group.id);
    const beforeCards = beforeMessages.filter((m) =>
      isTransientRetryCard(m.body),
    ).length;

    await handleTransientQuotaBackoff(
      run,
      "exit 1",
      "[rate-limited] try again in 5 seconds",
      "[rate-limited] try again in 5 seconds",
    );

    const row = await getTask(task.id);
    expect(row?.status).toBe("cancelled");
    expect(row?.diffSummary).toMatchObject({
      error: "stopped",
      summary: "stop won the race",
    });
    expect(queuedExecutorTaskCount(group.id)).toBe(beforeCount);
    expect(
      groupQueues.get(group.id)?.queue.some((r) => r.taskId === task.id),
    ).toBe(false);

    const afterMessages = await listGroupMessages(group.id);
    const afterCards = afterMessages.filter((m) =>
      isTransientRetryCard(m.body),
    );
    expect(afterCards.length).toBe(beforeCards);
  });

  it("403 并发冲突:running → queued 并重新入队(正常路径)", async () => {
    const { group, task, run } = await seedRunningTask("concurrency-ok");
    const beforeCount = queuedExecutorTaskCount(group.id);

    await handleConcurrencyConflict(run);

    const row = await getTask(task.id);
    expect(row?.status).toBe("queued");
    expect(queuedExecutorTaskCount(group.id)).toBe(beforeCount + 1);
    expect(
      groupQueues.get(group.id)?.queue.some((r) => r.taskId === task.id),
    ).toBe(true);
    expect(run.concurrencyBlocked).toBe(true);

    const messages = await listGroupMessages(group.id);
    expect(messages.some((m) => isConcurrencyRetryCard(m.body))).toBe(true);
  });

  it("403 并发冲突:写 queued 前已被改为 cancelled → 保持 cancelled,且不重新入队", async () => {
    const { group, task, run } = await seedRunningTask("concurrency-race");

    await testDb
      .update(taskTable)
      .set({
        status: "cancelled",
        diffSummary: { error: "stopped", summary: "stop won the race" },
      })
      .where(eq(taskTable.id, task.id));

    const beforeCount = queuedExecutorTaskCount(group.id);
    const beforeMessages = await listGroupMessages(group.id);
    const beforeCards = beforeMessages.filter((m) =>
      isConcurrencyRetryCard(m.body),
    ).length;

    await handleConcurrencyConflict(run);

    const row = await getTask(task.id);
    expect(row?.status).toBe("cancelled");
    expect(row?.diffSummary).toMatchObject({
      error: "stopped",
      summary: "stop won the race",
    });
    expect(queuedExecutorTaskCount(group.id)).toBe(beforeCount);
    expect(
      groupQueues.get(group.id)?.queue.some((r) => r.taskId === task.id),
    ).toBe(false);

    const afterMessages = await listGroupMessages(group.id);
    const afterCards = afterMessages.filter((m) =>
      isConcurrencyRetryCard(m.body),
    );
    expect(afterCards.length).toBe(beforeCards);
  });
});
