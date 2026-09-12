/**
 * S1 第 2 阶段收尾:终态写入乐观并发守卫。
 *
 * 统一判据:只有「活着的」任务能被写成终态
 *   expectedStatuses: ["queued", "running", <目标状态自身>]
 * 目标状态自身是为了保住幂等重写。
 *
 * 验收:
 *  - 写 failed 前任务已是 done → 保持 done,且不发失败消息;
 *  - 写 cancelled 前任务已是 done → 保持 done,且不发取消消息;
 *  - failed → failed(带新 diffSummary)幂等重写仍成功。
 *
 * 变异:临时去掉 expectedStatuses 时两条竞态用例必须变红
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
import { failTask, handleFailure } from "../src/lib/executor-task/failure";
import { markTaskCancelled } from "../src/lib/executor-task/notify";
import type { QueuedRun } from "../src/lib/executor-task/types";
import { createTestApp } from "./app";
import { seedBuiltinExecutorConfigs, testDb } from "./db";

const runtimeDb = testDb as unknown as DataBase;
const app = createTestApp();

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
    body: "任务:终态写入守卫",
    summary: "终态写入守卫",
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

function isFailureMessage(body: string): boolean {
  return body.includes("❌") && body.includes("任务失败");
}

function isCancelMessage(body: string): boolean {
  return (
    body.includes("🛑") ||
    body.includes("已停止") ||
    body.includes("已取消") ||
    (body.includes("cancelled") && body.includes("stop"))
  );
}

describe("终态写入乐观并发守卫 (S1 收尾)", () => {
  it("写 failed 前已被改为 done → 保持 done,且不发失败消息", async () => {
    const stamp = Date.now();
    const owner = await register(`term-fail-race-owner-${stamp}`);
    const exec = await register(`term-fail-race-exec-${stamp}`);
    const group = await createGroup(owner.id, `term-fail-race-${stamp}`);
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
        status: "done",
        diffSummary: { summary: "already done won the race" },
      })
      .returning({ id: taskTable.id });

    const before = await listGroupMessages(group.id);
    const beforeFail = before.filter((m) => isFailureMessage(m.body)).length;

    const run = buildRun({
      groupId: group.id,
      taskId: task.id,
      messageId,
      participantId: exec.id,
      ex,
    });

    await handleFailure(run, "执行超时", {
      retryable: false,
      message: `❌ [${ex.label}] 任务失败 (超时)`,
    });

    const row = await getTask(task.id);
    expect(row?.status).toBe("done");
    expect(row?.diffSummary).toMatchObject({
      summary: "already done won the race",
    });

    const after = await listGroupMessages(group.id);
    const afterFail = after.filter((m) => isFailureMessage(m.body));
    expect(afterFail.length).toBe(beforeFail);
    expect(afterFail.some((m) => m.body.includes(ex.label))).toBe(false);
  });

  it("写 cancelled 前已被改为 done → 保持 done,且不发取消消息", async () => {
    const stamp = Date.now();
    const owner = await register(`term-cancel-race-owner-${stamp}`);
    const exec = await register(`term-cancel-race-exec-${stamp}`);
    const group = await createGroup(owner.id, `term-cancel-race-${stamp}`);
    await addMember(owner.id, group.id, exec.id, ["executor"]);

    const messageId = randomUUID();
    const [task] = await testDb
      .insert(taskTable)
      .values({
        groupId: group.id,
        messageId,
        executorParticipantId: exec.id,
        executorKey: "codebuddy",
        status: "done",
        diffSummary: { summary: "done before cancel" },
      })
      .returning({ id: taskTable.id });

    const before = await listGroupMessages(group.id);
    const beforeCancel = before.filter((m) => isCancelMessage(m.body)).length;
    const beforeCount = before.length;

    const result = await markTaskCancelled(runtimeDb, task.id, group.id);

    expect(result).toBeNull();
    const row = await getTask(task.id);
    expect(row?.status).toBe("done");
    expect(row?.diffSummary).toMatchObject({
      summary: "done before cancel",
    });

    const after = await listGroupMessages(group.id);
    expect(after.length).toBe(beforeCount);
    const afterCancel = after.filter((m) => isCancelMessage(m.body));
    expect(afterCancel.length).toBe(beforeCancel);
  });

  it("failed → failed 幂等重写(带新 diffSummary)仍成功", async () => {
    const stamp = Date.now();
    const owner = await register(`term-fail-idemp-owner-${stamp}`);
    const exec = await register(`term-fail-idemp-exec-${stamp}`);
    const group = await createGroup(owner.id, `term-fail-idemp-${stamp}`);
    await addMember(owner.id, group.id, exec.id, ["executor"]);

    const messageId = randomUUID();
    const [task] = await testDb
      .insert(taskTable)
      .values({
        groupId: group.id,
        messageId,
        executorParticipantId: exec.id,
        executorKey: "codebuddy",
        status: "failed",
        diffSummary: { error: "first failure", summary: "keep-me" },
      })
      .returning({ id: taskTable.id });

    const rewritten = await failTask(
      runtimeDb,
      task.id,
      "more detailed failure reason",
    );

    expect(rewritten).not.toBeNull();
    expect(rewritten?.status).toBe("failed");

    const row = await getTask(task.id);
    expect(row?.status).toBe("failed");
    expect(row?.diffSummary).toMatchObject({
      error: "more detailed failure reason",
      summary: "keep-me",
    });
  });
});
