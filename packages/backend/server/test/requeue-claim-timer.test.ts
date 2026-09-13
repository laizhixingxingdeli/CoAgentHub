/**
 * 重排队后重 arm 认领超时(specs/transient-requeue-lost-wakeup.md §6.2 / 票 B):
 *  - 两处重排队(瞬时限流 / 403)clearRunTimers 后必须 armClaimTimer;
 *  - 定时器排在 concurrencyRetryAt 之后,退避窗口内不得误杀成「未认领」。
 *
 * B 不修根因:它把「静默挂死」变成「可观测的未认领失败」。
 *
 * 负向对照:去掉 quota-failure 两处 armClaimTimer 调用 → claimTimer 断言变红;
 * 把 armClaimTimer 改成无视 concurrencyRetryAt 只按 claimMs 排 → 退避误杀变红。
 */
import { randomUUID } from "node:crypto";
import { task as taskTable } from "@laizhixingxingdeli/database/schema";
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

const state = await import("../src/lib/executor-task/state");
const { ensureGroupQueue } = await import(
  "../src/lib/executor-task/dispatchability"
);

beforeAll(async () => {
  await seedBuiltinExecutorConfigs();
});

beforeEach(() => {
  state.__resetExecutorQueueForTests();
  // backoff 400ms; claim 80ms —— 若误按 claim 从现在起算,会在窗口内误杀。
  state.__setTransientQuotaForTests(400, 5);
  state.__setReliabilityTimeoutsForTests(60_000, 80);
});

afterEach(() => {
  state.__resetExecutorQueueForTests();
  state.__setTransientQuotaForTests(null, null);
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
    body: `任务:${opts.summary ?? "claim-timer"}`,
    summary: opts.summary ?? "claim-timer",
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

async function seedRunningTask(label: string) {
  const stamp = `${Date.now()}-${label}`;
  const owner = await register(`claim-rearm-owner-${stamp}`);
  const exec = await register(`claim-rearm-exec-${stamp}`);
  const group = await createGroup(owner.id, `claim-rearm-${stamp}`);
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
      diffSummary: { summary: label },
    })
    .returning({ id: taskTable.id });

  ensureGroupQueue(group.id);
  const run = buildRun({
    groupId: group.id,
    taskId: task.id,
    messageId,
    participantId: exec.id,
    ex,
    summary: label,
  });
  return { group, task, run };
}

async function getTask(taskId: string) {
  const [row] = await testDb
    .select()
    .from(taskTable)
    .where(eq(taskTable.id, taskId));
  return row;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("重排队后认领超时(lost-wakeup B)", () => {
  it("瞬时限流重排队后 claimTimer 非空", async () => {
    const { run } = await seedRunningTask("transient-arm");
    // 预置一个会被 clear 的 timer,证明 clear 后仍会重 arm。
    run.claimTimer = setTimeout(() => undefined, 60_000);
    await handleTransientQuotaBackoff(
      run,
      "exit 1",
      "[rate-limited] try again in 1 seconds",
      "[rate-limited] try again in 1 seconds",
    );
    expect(run.claimTimer).not.toBeNull();
    expect(run.concurrencyRetryAt).toBeGreaterThan(Date.now());
  });

  it("403 重排队后 claimTimer 非空", async () => {
    const { run } = await seedRunningTask("concurrency-arm");
    run.claimTimer = setTimeout(() => undefined, 60_000);
    await handleConcurrencyConflict(run);
    expect(run.claimTimer).not.toBeNull();
    expect(run.concurrencyRetryAt).toBeGreaterThan(Date.now());
  });

  it("退避窗口内不因认领超时误杀(瞬时路径)", async () => {
    const { task, run } = await seedRunningTask("transient-no-kill");
    await handleTransientQuotaBackoff(
      run,
      "exit 1",
      "[rate-limited] try again in 1 seconds",
      "[rate-limited] try again in 1 seconds",
    );
    expect(run.claimTimer).not.toBeNull();
    // claim=80ms, backoff=400ms:若只按 claim 排,此处应已「未认领」。
    await sleep(150);
    const mid = await getTask(task.id);
    expect(mid?.status).toBe("queued");
    const diff = mid?.diffSummary as Record<string, unknown> | null;
    expect(diff?.error ?? "").not.toContain("未认领");
  });

  it("丢唤醒时认领超时仍能把任务标 failed(可观测兜底)", async () => {
    // 关掉退避泵:只留 claim 兜底。backoff 极短 + claim 短 → 快速 failed。
    state.__setTransientQuotaForTests(30, 5);
    state.__setReliabilityTimeoutsForTests(60_000, 50);
    const { task, run } = await seedRunningTask("claim-fallback");
    await handleTransientQuotaBackoff(
      run,
      "exit 1",
      "[rate-limited] try again in 1 seconds",
      "[rate-limited] try again in 1 seconds",
    );
    // 取消退避泵定时器,模拟「唤醒丢失」——只靠 claimTimer 兜底。
    state.__cancelScheduledPumpsForTests();
    // 等过 backoff(30) + claim(50) + 余量
    await sleep(250);
    const row = await getTask(task.id);
    expect(row?.status).toBe("failed");
    const diff = row?.diffSummary as Record<string, unknown> | null;
    expect(String(diff?.error ?? "")).toContain("未认领");
  });
});
