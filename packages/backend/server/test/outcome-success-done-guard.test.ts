/**
 * S1 第 2 阶段第 1 个转换:成功终态 done 的乐观并发守卫。
 *
 * 验收:任务在 handleSuccessOutcome 写 done 之前已被改为 cancelled
 * → 保持 cancelled,且群里不出现 ✅ 完成卡片。
 *
 * 变异:临时去掉 expectedStatuses:["running"] 时本文件必须变红
 * (docs/adr/0011-acceptance-tests-must-be-able-to-fail.md)。
 */
import { randomUUID } from "node:crypto";
import {
  groupMessage as groupMessageTable,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import { findExecutorByKey } from "@server/lib/executors";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { DataBase } from "../src/lib/database";
import { handleSuccessOutcome } from "../src/lib/executor-task/outcome-success";
import type { QueuedRun } from "../src/lib/executor-task/types";
import { createTestApp } from "./app";
import { seedBuiltinExecutorConfigs, testDb } from "./db";

const runtimeDb = testDb as unknown as DataBase;
const app = createTestApp();

const SUCCESS_OUTPUT = [
  "commit 0123456789abcdef0123456789abcdef01234567",
  "测试: ok",
  "汇报: 成功终态守卫竞态测试完成",
  "遗留: 无",
].join("\n");

beforeAll(async () => {
  await seedBuiltinExecutorConfigs();
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
}): QueuedRun {
  const now = Date.now();
  return {
    db: runtimeDb,
    groupId: opts.groupId,
    messageId: opts.messageId,
    taskId: opts.taskId,
    participantId: opts.participantId,
    ex: opts.ex,
    body: "任务:成功终态守卫",
    summary: "成功终态守卫",
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

async function listGroupMessages(groupId: string) {
  return testDb
    .select()
    .from(groupMessageTable)
    .where(eq(groupMessageTable.groupId, groupId));
}

async function getTask(taskId: string) {
  const [row] = await testDb
    .select()
    .from(taskTable)
    .where(eq(taskTable.id, taskId));
  return row;
}

function isDoneCard(body: string): boolean {
  return body.includes("✅") && body.includes("任务完成");
}

describe("成功终态 done 乐观并发守卫 (S1)", () => {
  it("running → done:写 done 并发卡片(正常路径)", async () => {
    const stamp = Date.now();
    const owner = await register(`done-guard-ok-owner-${stamp}`);
    const exec = await register(`done-guard-ok-exec-${stamp}`);
    const group = await createGroup(owner.id, `done-guard-ok-${stamp}`);
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
        diffSummary: null,
      })
      .returning({ id: taskTable.id });

    const run = buildRun({
      groupId: group.id,
      taskId: task.id,
      messageId,
      participantId: exec.id,
      ex,
    });

    await handleSuccessOutcome(run, {
      result: {
        code: 0,
        stdout: SUCCESS_OUTPUT,
        stderr: "",
        timedOut: false,
      },
      output: SUCCESS_OUTPUT,
      isA2a: false,
      repoRoot: "",
      getPeerExecutorNames: async () => [],
    });

    const row = await getTask(task.id);
    expect(row?.status).toBe("done");

    const messages = await listGroupMessages(group.id);
    const doneCards = messages.filter((m) => isDoneCard(m.body));
    expect(doneCards.length).toBeGreaterThanOrEqual(1);
  });

  it("写 done 前已被改为 cancelled → 保持 cancelled,且不发完成卡片", async () => {
    const stamp = Date.now();
    const owner = await register(`done-guard-race-owner-${stamp}`);
    const exec = await register(`done-guard-race-exec-${stamp}`);
    const group = await createGroup(owner.id, `done-guard-race-${stamp}`);
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

    // 模拟停止指令赢了竞态:在成功路径写 done 之前,DB 已是 cancelled。
    await testDb
      .update(taskTable)
      .set({
        status: "cancelled",
        diffSummary: { error: "stopped", summary: "stop won the race" },
      })
      .where(eq(taskTable.id, task.id));

    const before = await listGroupMessages(group.id);
    const beforeDoneCards = before.filter((m) => isDoneCard(m.body)).length;

    const run = buildRun({
      groupId: group.id,
      taskId: task.id,
      messageId,
      participantId: exec.id,
      ex,
    });

    await handleSuccessOutcome(run, {
      result: {
        code: 0,
        stdout: SUCCESS_OUTPUT,
        stderr: "",
        timedOut: false,
      },
      output: SUCCESS_OUTPUT,
      isA2a: false,
      repoRoot: "",
      getPeerExecutorNames: async () => [],
    });

    const row = await getTask(task.id);
    expect(row?.status).toBe("cancelled");
    expect(row?.diffSummary).toMatchObject({
      error: "stopped",
      summary: "stop won the race",
    });

    const after = await listGroupMessages(group.id);
    const afterDoneCards = after.filter((m) => isDoneCard(m.body));
    expect(afterDoneCards.length).toBe(beforeDoneCards);
    expect(afterDoneCards.some((m) => m.body.includes(ex.label))).toBe(false);
  });
});
