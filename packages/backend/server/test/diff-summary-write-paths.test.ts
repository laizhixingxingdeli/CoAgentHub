/**
 * diffSummary 写路径改接单一合并入口(spec diffsummary-ownership W2
 * §4 B2–B5 / C1)。每条断言读最终产物(DB 行 / HTTP JSON),不只 helper 返回值。
 *
 * 改前缺陷对照:
 * - notify.markTaskCancelled 只 preserve dispatchKindNote,漏 rollbackSkipped
 *   与 platform.*;
 * - control 回滚整袋写 { error: "rollback" },抹掉 platform.resumeOf 等。
 */
import { randomUUID } from "node:crypto";
import {
  participant as participantTable,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataBase } from "../src/lib/database";
import { maybeHandleControlCommand } from "../src/lib/control";
import {
  __resetExecutorQueueForTests,
  applyDiffSummaryPatch,
  mergeDiffSummary,
  recoverInterruptedTasks,
} from "@server/lib/executor-task";
import { markTaskCancelled } from "../src/lib/executor-task/notify";
import { createTestApp } from "./app";
import { seedBuiltinExecutorConfigs, testDb } from "./db";

const runtimeDb = testDb as unknown as DataBase;

vi.mock("@server/lib/executor-runner", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@server/lib/executor-runner")>();
  return {
    ...actual,
    resetToCheckpoint: vi.fn(async () => ({
      ok: true as const,
      message: "refs/coagenthub-cp/mock",
    })),
  };
});

beforeEach(() => {
  __resetExecutorQueueForTests();
});

const app = createTestApp();

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

async function insertTask(
  groupId: string,
  executorParticipantId: string,
  diffSummary: Record<string, unknown> | null,
  status: "queued" | "running" | "done" | "failed" = "queued",
  extra: Partial<typeof taskTable.$inferInsert> = {},
) {
  const [row] = await testDb
    .insert(taskTable)
    .values({
      groupId,
      messageId: randomUUID(),
      executorParticipantId,
      status,
      diffSummary,
      ...extra,
    })
    .returning({ id: taskTable.id });
  return row.id;
}

async function getTask(taskId: string) {
  const [row] = await testDb
    .select()
    .from(taskTable)
    .where(eq(taskTable.id, taskId));
  return row;
}

async function getTaskHttp(
  groupId: string,
  taskId: string,
  actorId: string,
) {
  const res = await app.request(`/api/groups/${groupId}/tasks/${taskId}`, {
    headers: { "X-Participant-Id": actorId },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    id: string;
    status: string;
    diffSummary: Record<string, unknown> | null;
  };
}

describe("W2 B2: ownerServerPid 经 fail 终态仍在 (HTTP GET)", () => {
  it("先登记 platform.ownerServerPid=P,recoverInterruptedTasks fail 后 GET 仍见 P", async () => {
    const owner = await register(`ds-b2-owner-${Date.now()}`);
    const executor = await register(`ds-b2-exec-${Date.now()}`);
    const group = await createGroup(owner.id, "ds-b2");
    const OWNER_PID = 424242;
    // 制造已退出 pid:spawnSync 立即退出。
    const { spawnSync } = await import("node:child_process");
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
      timeout: 5_000,
    });
    const taskId = await insertTask(
      group.id,
      executor.id,
      { platform: { ownerServerPid: OWNER_PID, resumeOf: "parent-x" } },
      "running",
      { executorPid: dead.pid, executorKey: "codebuddy" },
    );

    await recoverInterruptedTasks(runtimeDb);

    const json = await getTaskHttp(group.id, taskId, owner.id);
    expect(json.status).toBe("failed");
    expect(json.diffSummary?.platform).toMatchObject({
      ownerServerPid: OWNER_PID,
      resumeOf: "parent-x",
    });
    expect(json.diffSummary?.error).toBe("server-restart");
  });
});

describe("W2 B3: markTaskCancelled 保留 dispatchKindNote + rollbackSkipped", () => {
  it("两键仍在且 error 为停止原因 (DB 行)", async () => {
    const owner = await register(`ds-b3-owner-${Date.now()}`);
    const executor = await register(`ds-b3-exec-${Date.now()}`);
    const group = await createGroup(owner.id, "ds-b3");
    const note = "dispatchKind 由 findings 缺省推定为 fix";
    const skipped = {
      reason: "checkpoint 之后存在外来提交,跳过回滚保护共享工作树",
      headAtSkip: "abc",
      checkpoint: "refs/coagenthub-cp/x",
    };
    const taskId = await insertTask(group.id, executor.id, {
      dispatchKindNote: note,
      rollbackSkipped: skipped,
      platform: { resumeOf: "parent-b3" },
      tokenUsage: { input: 1, output: 2 },
    });

    await markTaskCancelled(runtimeDb, taskId, group.id);

    const row = await getTask(taskId);
    expect(row.status).toBe("cancelled");
    const summary = row.diffSummary as Record<string, unknown>;
    expect(summary.error).toBe("stopped");
    expect(summary.dispatchKindNote).toBe(note);
    expect(summary.rollbackSkipped).toEqual(skipped);
    expect(summary.platform).toMatchObject({ resumeOf: "parent-b3" });
    expect(summary.tokenUsage).toEqual({ input: 1, output: 2 });
  });
});

describe("W2 B4: control 回滚写 error:rollback 保留 platform.resumeOf", () => {
  it("maybeHandleControlCommand 回滚后 DB 行仍有 resumeOf", async () => {
    await seedBuiltinExecutorConfigs();
    const owner = await register(`ds-b4-owner-${Date.now()}`);
    // 控制回传需要可用执行器 participant
    const execPart = await register(`ds-b4-exec-${Date.now()}`);
    await testDb
      .update(participantTable)
      .set({ executorKey: "codebuddy" })
      .where(eq(participantTable.id, execPart.id));

    const group = await createGroup(owner.id, "ds-b4");
    const taskId = await insertTask(
      group.id,
      execPart.id,
      {
        platform: { resumeOf: "parent-resume-keep" },
        dispatchKindNote: "keep-me",
        summary: "prior work",
      },
      "done",
      { checkpointRef: "refs/coagenthub-cp/mock-b4" },
    );

    await maybeHandleControlCommand(runtimeDb, {
      groupId: group.id,
      senderRoles: ["coordinator"],
      audience: "broadcast",
      audienceRef: null,
      body: `回滚 ${taskId}`,
    });

    const row = await getTask(taskId);
    expect(row.status).toBe("failed");
    const summary = row.diffSummary as Record<string, unknown>;
    expect(summary.error).toBe("rollback");
    expect(summary.platform).toMatchObject({ resumeOf: "parent-resume-keep" });
    expect(summary.dispatchKindNote).toBe("keep-me");
    expect(summary.summary).toBe("prior work");
  });
});

describe("W2 B5: PATCH done 仅带 summary+review_request 时保留 tokenUsage 与 resumeOf", () => {
  it("结案后 HTTP JSON 二者仍在且 review_request 合法", async () => {
    const owner = await register(`ds-b5-owner-${Date.now()}`);
    const executor = await register(`ds-b5-exec-${Date.now()}`);
    const group = await createGroup(owner.id, "ds-b5");
    // resumeOf 必须是合法 uuid(resolveL3 会按 id 查父任务);父任务不存在即可。
    const resumeOf = randomUUID();
    const taskId = await insertTask(group.id, executor.id, {
      tokenUsage: { input: 11, output: 22 },
      platform: { resumeOf },
      dispatchKindNote: "note-b5",
    });

    const reviewRequest = {
      type: "review_request" as const,
      layer: 3 as const,
      taskId,
      specRef: "specs/diffsummary-ownership.md",
      specHash: "5f81618be636176048a82702c2c3c38a96898ab2",
      diffSummary: "W2 B5 结案交接",
    };
    const patch = await app.request(
      `/api/groups/${group.id}/tasks/${taskId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": executor.id,
        },
        body: JSON.stringify({
          status: "done",
          diffSummary: {
            summary: "ok",
            review_request: reviewRequest,
          },
        }),
      },
    );
    const patchText = await patch.text();
    expect(patch.status, patchText).toBe(200);
    const body = JSON.parse(patchText) as {
      status: string;
      diffSummary: Record<string, unknown>;
    };
    expect(body.status).toBe("done");
    expect(body.diffSummary.summary).toBe("ok");
    expect(body.diffSummary.tokenUsage).toEqual({ input: 11, output: 22 });
    expect(body.diffSummary.platform).toMatchObject({ resumeOf });
    expect(body.diffSummary.dispatchKindNote).toBe("note-b5");
    expect(body.diffSummary.review_request).toMatchObject({
      type: "review_request",
      taskId,
      specRef: "specs/diffsummary-ownership.md",
    });

    // 最终产物再读一次 GET
    const json = await getTaskHttp(group.id, taskId, owner.id);
    expect(json.diffSummary?.tokenUsage).toEqual({ input: 11, output: 22 });
    expect(json.diffSummary?.platform).toMatchObject({ resumeOf });
  });
});

describe("W2 C1: 单一 scheduling 写入后,done/fail/cancel 三路径保留该键", () => {
  it("queuedBlocked 经 apply 写入后,PATCH done / recover fail / cancel 均保留", async () => {
    const owner = await register(`ds-c1-owner-${Date.now()}`);
    const executor = await register(`ds-c1-exec-${Date.now()}`);
    const group = await createGroup(owner.id, "ds-c1");
    const blocked = {
      code: "executor-cooldown",
      reason: "C1 scheduling 键",
      at: new Date().toISOString(),
    };

    // 路径 1: PATCH done
    {
      const taskId = await insertTask(group.id, executor.id, null);
      // 仅一处 scheduling 写入(模拟 reclaim 写入点)
      const withBlocked = mergeDiffSummary(
        null,
        { queuedBlocked: blocked },
        "scheduling",
      );
      await testDb
        .update(taskTable)
        .set({ diffSummary: withBlocked })
        .where(eq(taskTable.id, taskId));

      const patch = await app.request(
        `/api/groups/${group.id}/tasks/${taskId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": executor.id,
          },
          body: JSON.stringify({
            status: "done",
            diffSummary: { summary: "c1-done" },
          }),
        },
      );
      expect(patch.status).toBe(200);
      const row = await getTask(taskId);
      expect((row.diffSummary as Record<string, unknown>).queuedBlocked).toEqual(
        blocked,
      );
      expect((row.diffSummary as Record<string, unknown>).summary).toBe("c1-done");
    }

    // 路径 2: recoverInterruptedTasks → failed
    {
      const { spawnSync } = await import("node:child_process");
      const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
        timeout: 5_000,
      });
      const taskId = await insertTask(
        group.id,
        executor.id,
        { queuedBlocked: blocked },
        "running",
        { executorPid: dead.pid, executorKey: "codebuddy" },
      );
      await recoverInterruptedTasks(runtimeDb);
      const row = await getTask(taskId);
      expect(row.status).toBe("failed");
      expect((row.diffSummary as Record<string, unknown>).queuedBlocked).toEqual(
        blocked,
      );
    }

    // 路径 3: markTaskCancelled
    {
      const taskId = await insertTask(group.id, executor.id, {
        queuedBlocked: blocked,
      });
      await markTaskCancelled(runtimeDb, taskId, group.id);
      const row = await getTask(taskId);
      expect(row.status).toBe("cancelled");
      expect((row.diffSummary as Record<string, unknown>).queuedBlocked).toEqual(
        blocked,
      );
      expect((row.diffSummary as Record<string, unknown>).error).toBe("stopped");
    }
  });
});

describe("W2 applyDiffSummaryPatch 多所有者分桶", () => {
  it("一次混合 patch 保留既有他有键并写入各所有者键", () => {
    const existing = {
      platform: { resumeOf: "p" },
      dispatchKindNote: "n",
      tokenUsage: 9,
    };
    const next = applyDiffSummaryPatch(existing, {
      summary: "x",
      error: "e",
      stallAlerted: true,
    });
    expect(next).toMatchObject({
      summary: "x",
      error: "e",
      stallAlerted: true,
      platform: { resumeOf: "p" },
      dispatchKindNote: "n",
      tokenUsage: 9,
    });
  });
});
