import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  participant as participantTable,
  type TaskAttempt,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { DataBase } from "../src/lib/database";
import { backfillDetachedClosedTokenFields } from "../src/lib/executor-task";
import { createTestApp } from "./app";
import { testDb } from "./db";

const runtimeDb = testDb as unknown as DataBase;

// fake bin:续跑任务以 detached 方式派发给协调者,进程起来后先睡(给测试留出
// 进程内 PATCH 的窗口),再打印一行通用扫描可识别的 token 账本后退出。
const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-detached-bin-"));
const fakeBin = path.join(fakeDir, "fake-resume-executor.sh");
writeFileSync(
  fakeBin,
  [
    "#!/bin/sh",
    "sleep 1",
    'echo "{\\"usage\\":{\\"input_tokens\\":1200,\\"output_tokens\\":300,\\"total_tokens\\":1500}}"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeBin, 0o755);
// reasonix 无定制采集器 → 走通用 JSONL 扫描,采集结果只由 stdout 决定。
process.env.EXECUTOR_BIN_REASONIX = fakeBin;

// 派发前的 git 快照需要真实仓库(与 executor-queue.test.ts 同款夹具)。
const repoDir = mkdtempSync(path.join(tmpdir(), "coagenthub-detached-repo-"));
execFileSync("git", ["init", "-q"], { cwd: repoDir });
execFileSync("git", ["config", "user.email", "test@coagenthub.local"], {
  cwd: repoDir,
});
execFileSync("git", ["config", "user.name", "coagenthub-test"], {
  cwd: repoDir,
});
writeFileSync(path.join(repoDir, "hello.txt"), "original\n");
execFileSync("git", ["add", "-A"], { cwd: repoDir });
execFileSync("git", ["commit", "-qm", "seed"], { cwd: repoDir });
process.env.COAGENTHUB_REPO_ROOT = repoDir;

/**
 * 续跑任务结案漏回填 token 字段的回归(specs/token-fields-clobbered-by-close.md
 * 续跑分支):协调者在自己的进程内 PATCH 结案,而 tokenUsage 采集只在进程退出后
 * 才发生(collectAttemptTokenUsage)。结案那一刻 attempts 尚无 tokenUsage,PATCH
 * 路由的 R1 回填读不到任何值 → diffSummary 缺字段;进程退出后 attempts 才有值,
 * 但 diffSummary 已定型。修复在队列侧:采集落库后,若任务已被 PATCH 落终态且
 * diffSummary 缺这两个键,以与 PATCH 路由 R1 同口径补写。
 */

async function registerParticipant(name: string) {
  const res = await appRequest("/api/participants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (res.status === 409) {
    const list = (await (await appRequest("/api/participants")).json()) as {
      id: string;
      name: string;
    }[];
    const existing = list.find((p) => p.name === name);
    if (existing) return { id: existing.id };
  }
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string };
}

async function bindExecutorKey(participantId: string, key: string) {
  await testDb
    .update(participantTable)
    .set({ executorKey: null })
    .where(eq(participantTable.executorKey, key));
  await testDb
    .update(participantTable)
    .set({ executorKey: key })
    .where(eq(participantTable.id, participantId));
}

const app = createTestApp();
function appRequest(path: string, init?: RequestInit) {
  return app.request(path, init);
}

async function createGroup(participantId: string, title: string) {
  const res = await appRequest("/api/groups", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Participant-Id": participantId,
    },
    body: JSON.stringify({ title }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string };
}

async function addMember(
  actorId: string,
  groupId: string,
  participantId: string,
  roles: string[],
) {
  const res = await appRequest(`/api/groups/${groupId}/members`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Participant-Id": actorId,
    },
    body: JSON.stringify({ participantId, roles }),
  });
  expect(res.status).toBe(200);
}

async function postMessage(senderId: string, groupId: string, body: string) {
  const res = await appRequest(`/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Participant-Id": senderId,
    },
    body: JSON.stringify({
      body,
      audience: "participant",
      audienceRef: senderId,
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string };
}

async function createTask(
  participantId: string,
  groupId: string,
  messageId: string,
  executorParticipantId: string,
) {
  return appRequest(`/api/groups/${groupId}/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Participant-Id": participantId,
    },
    body: JSON.stringify({ messageId, executorParticipantId }),
  });
}

async function patchTask(
  participantId: string,
  groupId: string,
  taskId: string,
  body: Record<string, unknown>,
) {
  return appRequest(`/api/groups/${groupId}/tasks/${taskId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Participant-Id": participantId,
    },
    body: JSON.stringify(body),
  });
}

async function findTask(id: string) {
  const rows = await testDb
    .select()
    .from(taskTable)
    .where(eq(taskTable.id, id));
  return rows[0];
}

async function setupGroup() {
  const coordinator = await registerParticipant(`coord-${crypto.randomUUID()}`);
  const group = await createGroup(coordinator.id, "detached-token-backfill");
  await addMember(coordinator.id, group.id, coordinator.id, ["coordinator"]);
  return { coordinator, group };
}

/** 轮询直到 fn 返回非 undefined(队列派发/采集落库都是异步的)。 */
async function waitUntil<T>(
  fn: () => Promise<T | undefined>,
  label: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await fn();
    if (hit !== undefined) return hit;
    if (Date.now() > deadline) {
      throw new Error(`${label} 未在 ${timeoutMs}ms 内就绪`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("detached 任务采集落库后补写 diffSummary token 字段", () => {
  it("续跑时序:结案时 attempts 无采集 → 采集落库后补写 diffSummary.tokenUsage 与 reason", async () => {
    const { coordinator, group } = await setupGroup();
    const message = await postMessage(
      coordinator.id,
      group.id,
      "续跑任务(进程内结案)",
    );
    const created = await createTask(
      coordinator.id,
      group.id,
      message.id,
      coordinator.id,
    );
    const task = (await created.json()) as { id: string };

    // 真实时序:协调者在自己的进程内 PATCH 结案,此刻 attempts 尚无 tokenUsage
    // (采集只在进程退出后发生)→ PATCH 路由的 R1 回填读不到 attempts。
    const attemptsAtClose: TaskAttempt[] = [
      {
        n: 1,
        startedAt: new Date(0).toISOString(),
        status: "running",
      },
    ];
    await testDb
      .update(taskTable)
      .set({ attempts: attemptsAtClose })
      .where(eq(taskTable.id, task.id));
    const done = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: {
        summary: "协调者结案",
        noExecutionReason: "无需下发执行器",
      },
    });
    expect(done.status).toBe(200);
    const closedSummary = (
      (await done.json()) as {
        diffSummary: Record<string, unknown>;
      }
    ).diffSummary;
    // 缺陷前提:结案时 diffSummary 缺 token 字段(attempts 当时未采集)。
    expect(Object.hasOwn(closedSummary, "tokenUsage")).toBe(false);
    expect(Object.hasOwn(closedSummary, "tokenUsageReason")).toBe(false);

    // 进程退出后采集落库(collectAttemptTokenUsage 写入 attempts)。
    const collectedAttempts: TaskAttempt[] = [
      {
        n: 1,
        startedAt: new Date(0).toISOString(),
        status: "running",
        tokenUsage: {
          inputTokens: 545000,
          outputTokens: 875,
          totalTokens: 545875,
          source: "codex-stdout-jsonl",
        },
      },
    ];
    await testDb
      .update(taskTable)
      .set({ attempts: collectedAttempts })
      .where(eq(taskTable.id, task.id));

    // 修复:detached 任务采集落库后,若任务已终态且 diffSummary 缺 token 字段 → 补写。
    await backfillDetachedClosedTokenFields(
      runtimeDb,
      task.id,
      group.id,
      collectedAttempts,
    );

    const row = await findTask(task.id);
    const summary = row.diffSummary as Record<string, unknown>;
    expect(summary.tokenUsage).toEqual({
      inputTokens: 545000,
      outputTokens: 875,
      cachedInputTokens: 0,
      totalTokens: 545875,
      source: "codex-stdout-jsonl",
    });
    // 协调者自报字段与平台标记不受影响。
    expect(summary.summary).toBe("协调者结案");
    expect(summary.noExecutionReason).toBe("无需下发执行器");
  });

  it("续跑时序:采集只有 tokenUsageReason → 补写 reason(与 PATCH R1 同口径)", async () => {
    const { coordinator, group } = await setupGroup();
    const message = await postMessage(
      coordinator.id,
      group.id,
      "续跑任务(仅 reason)",
    );
    const created = await createTask(
      coordinator.id,
      group.id,
      message.id,
      coordinator.id,
    );
    const task = (await created.json()) as { id: string };

    // 结案那一刻 attempts 仍未采集(续跑时序的前提)。
    await testDb
      .update(taskTable)
      .set({
        attempts: [
          {
            n: 1,
            startedAt: new Date(0).toISOString(),
            status: "running",
          },
        ],
      })
      .where(eq(taskTable.id, task.id));
    const done = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: { summary: "结案" },
    });
    expect(done.status).toBe(200);
    const closedSummary = (
      (await done.json()) as {
        diffSummary: Record<string, unknown>;
      }
    ).diffSummary;
    expect(Object.hasOwn(closedSummary, "tokenUsageReason")).toBe(false);

    // 进程退出后只采到 reason(采集失败口径:tokenUsage=null + unavailable)。
    const collectedAttempts: TaskAttempt[] = [
      {
        n: 1,
        startedAt: new Date(0).toISOString(),
        status: "running",
        tokenUsage: null,
        tokenUsageReason: "unavailable",
      },
    ];
    await testDb
      .update(taskTable)
      .set({ attempts: collectedAttempts })
      .where(eq(taskTable.id, task.id));

    await backfillDetachedClosedTokenFields(
      runtimeDb,
      task.id,
      group.id,
      collectedAttempts,
    );

    const row = await findTask(task.id);
    const summary = row.diffSummary as Record<string, unknown>;
    expect(summary.tokenUsageReason).toBe("unavailable");
    // 采集口径:tokenUsage 显式为 null(平台采不到,不是没采)。
    expect(summary.tokenUsage).toBeNull();
  });

  it("调用方显式提供(含 null)→ 补写不得覆盖(与 PATCH R2 同口径)", async () => {
    const { coordinator, group } = await setupGroup();
    const message = await postMessage(
      coordinator.id,
      group.id,
      "续跑任务(显式 null)",
    );
    const created = await createTask(
      coordinator.id,
      group.id,
      message.id,
      coordinator.id,
    );
    const task = (await created.json()) as { id: string };

    // 协调者显式写了 tokenUsage: null / tokenUsageReason: null(调用方为准)。
    await testDb
      .update(taskTable)
      .set({
        attempts: [
          {
            n: 1,
            startedAt: new Date(0).toISOString(),
            status: "running",
          },
        ],
      })
      .where(eq(taskTable.id, task.id));
    const done = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: {
        summary: "结案",
        tokenUsage: null,
        tokenUsageReason: null,
      },
    });
    expect(done.status).toBe(200);

    await backfillDetachedClosedTokenFields(runtimeDb, task.id, group.id, [
      {
        n: 1,
        startedAt: new Date(0).toISOString(),
        status: "running",
        tokenUsage: {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          source: "attempts",
        },
      },
    ]);

    const row = await findTask(task.id);
    const summary = row.diffSummary as Record<string, unknown>;
    expect(Object.hasOwn(summary, "tokenUsage")).toBe(true);
    expect(summary.tokenUsage).toBeNull();
    expect(Object.hasOwn(summary, "tokenUsageReason")).toBe(true);
    expect(summary.tokenUsageReason).toBeNull();
  });

  it("任务仍非终态(running)→ 补写跳过,由执行器 PATCH 后 PATCH 路由回填(普通路径回归)", async () => {
    const { coordinator, group } = await setupGroup();
    const message = await postMessage(coordinator.id, group.id, "running 任务");
    const created = await createTask(
      coordinator.id,
      group.id,
      message.id,
      coordinator.id,
    );
    const task = (await created.json()) as { id: string };

    const collectedAttempts: TaskAttempt[] = [
      {
        n: 1,
        startedAt: new Date(0).toISOString(),
        status: "running",
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 1,
          totalTokens: 11,
          source: "codex-stdout-jsonl",
        },
      },
    ];
    await testDb
      .update(taskTable)
      .set({ attempts: collectedAttempts })
      .where(eq(taskTable.id, task.id));

    await backfillDetachedClosedTokenFields(
      runtimeDb,
      task.id,
      group.id,
      collectedAttempts,
    );

    const row = await findTask(task.id);
    const summary = row.diffSummary as Record<string, unknown> | null;
    expect(Object.hasOwn(summary ?? {}, "tokenUsage")).toBe(false);
  });

  it("普通协调任务 PATCH 结案时 attempts 已采集 → 路由回填不变(回归)", async () => {
    const { coordinator, group } = await setupGroup();
    const message = await postMessage(coordinator.id, group.id, "普通协调任务");
    const created = await createTask(
      coordinator.id,
      group.id,
      message.id,
      coordinator.id,
    );
    const task = (await created.json()) as { id: string };

    // 普通路径:进程早已退出,采集已落库,结案时 PATCH 路由直接读 attempts 回填。
    await testDb
      .update(taskTable)
      .set({
        attempts: [
          {
            n: 1,
            startedAt: new Date(0).toISOString(),
            status: "done",
            tokenUsage: {
              inputTokens: 400061,
              outputTokens: 4947,
              totalTokens: 405008,
              source: "codex-stdout-jsonl",
            },
          },
        ],
      })
      .where(eq(taskTable.id, task.id));

    const done = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: { summary: "协调者结案" },
    });
    expect(done.status).toBe(200);
    const summary = (
      (await done.json()) as {
        diffSummary: Record<string, unknown>;
      }
    ).diffSummary;
    expect(summary.tokenUsage).toEqual({
      inputTokens: 400061,
      outputTokens: 4947,
      cachedInputTokens: 0,
      totalTokens: 405008,
      source: "codex-stdout-jsonl",
    });
    expect(summary.summary).toBe("协调者结案");
  });
});

describe.sequential("续跑任务真实派发时序(detached 派发 → 进程内 PATCH → 进程退出后补写)", () => {
  it("协调者进程内 PATCH 结案 → 进程退出采集落库 → diffSummary 补上 tokenUsage", async () => {
    const coordinator = await registerParticipant(
      `resume-coord-${crypto.randomUUID()}`,
    );
    await bindExecutorKey(coordinator.id, "reasonix");
    const group = await createGroup(coordinator.id, "resume-token-backfill");
    await addMember(coordinator.id, group.id, coordinator.id, ["coordinator"]);
    const message = await postMessage(
      coordinator.id,
      group.id,
      "续跑任务:完成 L2 后自行结案",
    );
    const created = await createTask(
      coordinator.id,
      group.id,
      message.id,
      coordinator.id,
    );
    expect(created.status).toBe(200);
    const task = (await created.json()) as { id: string };

    // detached 派发:协调者进程(fake bin)起来后任务保持 running,终态由它自己
    // PATCH 回写。此刻采集尚未发生(采集只在进程退出后)。
    const running = await waitUntil(async () => {
      const rows = await testDb
        .select()
        .from(taskTable)
        .where(eq(taskTable.id, task.id));
      return rows[0]?.status === "running" ? rows[0] : undefined;
    }, `任务 ${task.id} 进入 running`);
    const attemptsAtDispatch = (running.attempts ?? []) as TaskAttempt[];
    expect(attemptsAtDispatch.at(-1)?.tokenUsage).toBeUndefined();

    const done = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: { summary: "续跑任务完成 L2 并结案" },
    });
    expect(done.status).toBe(200);
    const closedSummary = (
      (await done.json()) as {
        diffSummary: Record<string, unknown>;
      }
    ).diffSummary;
    // 缺陷现场:结案那一刻 diffSummary 缺 token 字段(attempts 当时未采集),
    // 修复前这里就是最终落库值 —— 本票要修的正是它。
    expect(Object.hasOwn(closedSummary, "tokenUsage")).toBe(false);

    // 进程退出 → 采集落库 → 队列侧补写。
    const backfilled = await waitUntil(async () => {
      const rows = await testDb
        .select()
        .from(taskTable)
        .where(eq(taskTable.id, task.id));
      const summary = rows[0]?.diffSummary as Record<string, unknown> | null;
      return summary && Object.hasOwn(summary, "tokenUsage")
        ? rows[0]
        : undefined;
    }, `任务 ${task.id} 补写 diffSummary.tokenUsage`);
    const summary = backfilled.diffSummary as Record<string, unknown>;
    expect(summary.tokenUsage).toEqual({
      inputTokens: 1200,
      outputTokens: 300,
      cachedInputTokens: 0,
      totalTokens: 1500,
      source: "generic-jsonl-scan",
    });
    // 协调者自报字段逐字保留(补写只加键,不覆盖)。
    expect(summary.summary).toBe("续跑任务完成 L2 并结案");
    // 回归时若补写被摘掉,失败信息来自 waitUntil 的明确报错而非用例超时。
  }, 30_000);
});
