/**
 * S1 第 2 阶段第 3 个转换:置 running 的乐观并发守卫。
 *
 * 验收:
 *  - 置 running 前 DB 已是 cancelled → 保持 cancelled,假 bin 哨兵不存在(未 spawn);
 *  - queued → running 正常路径照常执行(哨兵出现 + 终态 done)。
 *
 * 变异:临时去掉 expectedStatuses:["queued","running"] 时竞态用例必须变红
 * (docs/adr/0011-acceptance-tests-must-be-able-to-fail.md)。
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  executorConfig as executorConfigTable,
  groups as groupsTable,
  participant as participantTable,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import { findExecutorByKey } from "@server/lib/executors";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DataBase } from "../src/lib/database";
import { enqueueTaskRun } from "../src/lib/executor-task/queue";
import { activeRuns, groupQueues } from "../src/lib/executor-task/state";
import { createTestApp } from "./app";
import { seedBuiltinExecutorConfigs, testDb } from "./db";
import { resolveFakeExecutor, withFakeExecutorArgs } from "./fake-executor-bin";

const fakeDir = mkdtempSync(
  path.join(tmpdir(), "coagenthub-running-start-guard-bin-"),
);
const fakeScript = path.join(fakeDir, "fake-running-start-guard.sh");
writeFileSync(
  fakeScript,
  [
    "#!/bin/sh",
    // 一被 spawn 就写哨兵 —— 「有没有真的跑」的可观察判据。
    'if [ -n "$FAKE_SPAWN_SENTINEL" ]; then touch "$FAKE_SPAWN_SENTINEL"; fi',
    'if [ -z "$FAKE_NO_COMMIT" ]; then',
    '  git add -A && git -c user.name=coagenthub-test -c user.email=coagenthub-test@example.com commit -q --allow-empty -m "fake bin change" || true',
    "fi",
    'echo "commit 0123456789abcdef0123456789abcdef01234567"',
    'echo "测试: ok"',
    'echo "汇报:running-start-guard"',
    'echo "遗留: 无"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeScript, 0o755);
const { bin: fakeBin, argsPrefix: fakeArgsPrefix } =
  resolveFakeExecutor(fakeScript);
process.env.EXECUTOR_BIN_CODEBUDDY = fakeBin;

const repoDir = mkdtempSync(
  path.join(tmpdir(), "coagenthub-running-start-guard-repo-"),
);
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

const runtimeDb = testDb as unknown as DataBase;
const app = createTestApp();

const { __resetExecutorQueueForTests } = await import(
  "@server/lib/executor-task"
);

beforeAll(async () => {
  await seedBuiltinExecutorConfigs();
  if (fakeArgsPrefix.length > 0) {
    const [row] = await testDb
      .select()
      .from(executorConfigTable)
      .where(eq(executorConfigTable.key, "codebuddy"));
    if (row) {
      await testDb
        .update(executorConfigTable)
        .set({ args: withFakeExecutorArgs(fakeArgsPrefix, row.args ?? []) })
        .where(eq(executorConfigTable.key, "codebuddy"));
    }
  }
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
    if (existing) {
      if (name === "CodeBuddy") {
        await testDb
          .update(participantTable)
          .set({ executorKey: "codebuddy" })
          .where(eq(participantTable.id, existing.id));
      }
      return { id: existing.id };
    }
  }
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  if (name === "CodeBuddy") {
    await testDb
      .update(participantTable)
      .set({ executorKey: "codebuddy" })
      .where(eq(participantTable.id, id));
  }
  return { id };
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

async function getTask(taskId: string) {
  const [row] = await testDb
    .select()
    .from(taskTable)
    .where(eq(taskTable.id, taskId));
  return row;
}

async function waitUntilIdle(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const busy =
      activeRuns.size > 0 ||
      [...groupQueues.values()].some(
        (g) => g.queue.length > 0 || g.running.length > 0,
      );
    if (!busy) return;
    if (Date.now() > deadline) {
      throw new Error(
        `executor queue 未在 ${timeoutMs}ms 内空闲(active=${activeRuns.size})`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function waitForTaskStatus(
  taskId: string,
  status: string,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await getTask(taskId);
    if (row?.status === status) return row;
    if (Date.now() > deadline) {
      throw new Error(
        `task ${taskId} 未在 ${timeoutMs}ms 内达到 ${status}(当前=${row?.status ?? "无"})`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function seedQueuedTask(label: string) {
  const stamp = Date.now();
  const owner = await register(`running-guard-${label}-owner-${stamp}`);
  const exec = await register("CodeBuddy");
  const group = await createGroup(owner.id, `running-guard-${label}-${stamp}`);
  await addMember(owner.id, group.id, exec.id, ["executor"]);
  await testDb
    .update(groupsTable)
    .set({ projectPath: repoDir })
    .where(eq(groupsTable.id, group.id));

  const ex = await findExecutorByKey(runtimeDb, "codebuddy");
  expect(ex).toBeTruthy();
  if (!ex) throw new Error("codebuddy fixture missing");

  const messageId = randomUUID();
  const body = `任务:running-start-guard-${label}\n仓库:${repoDir}`;
  const [task] = await testDb
    .insert(taskTable)
    .values({
      groupId: group.id,
      messageId,
      executorParticipantId: exec.id,
      executorKey: "codebuddy",
      status: "queued",
      brief: body,
      diffSummary: null,
    })
    .returning();

  return { group, task, ex, exec, body, messageId };
}

describe("置 running 乐观并发守卫 (S1)", () => {
  beforeEach(() => {
    __resetExecutorQueueForTests();
    delete process.env.FAKE_SPAWN_SENTINEL;
    delete process.env.FAKE_NO_COMMIT;
  });

  afterEach(() => {
    __resetExecutorQueueForTests();
    delete process.env.FAKE_SPAWN_SENTINEL;
    delete process.env.FAKE_NO_COMMIT;
  });

  it("queued → running:照常 spawn 并完成(正常路径)", async () => {
    const sentinel = path.join(
      fakeDir,
      `ok-sentinel-${Date.now()}-${Math.random().toString(36).slice(2)}.flag`,
    );
    process.env.FAKE_SPAWN_SENTINEL = sentinel;
    process.env.FAKE_NO_COMMIT = "1";

    const { group, task, ex, exec, body, messageId } =
      await seedQueuedTask("ok");
    const row = await getTask(task.id);
    expect(row).toBeTruthy();
    if (!row) throw new Error("task missing");

    await enqueueTaskRun(runtimeDb, row, {
      groupId: group.id,
      messageId,
      participantId: exec.id,
      ex,
      body,
      groupPrompt: null,
      specRef: null,
      specHash: null,
    });

    await waitForTaskStatus(task.id, "done");
    await waitUntilIdle();

    expect(existsSync(sentinel)).toBe(true);
    expect((await getTask(task.id))?.status).toBe("done");
  }, 30_000);

  it("置 running 前已被改为 cancelled → 保持 cancelled,且假 bin 未 spawn", async () => {
    const sentinel = path.join(
      fakeDir,
      `race-sentinel-${Date.now()}-${Math.random().toString(36).slice(2)}.flag`,
    );
    process.env.FAKE_SPAWN_SENTINEL = sentinel;
    process.env.FAKE_NO_COMMIT = "1";

    const { group, task, ex, exec, body, messageId } =
      await seedQueuedTask("race");

    // 模拟停止指令/超时/孤儿收敛赢了竞态:内存 run 仍会出队,但 DB 已是终态。
    await testDb
      .update(taskTable)
      .set({
        status: "cancelled",
        diffSummary: { error: "stopped", summary: "stop won the race" },
      })
      .where(eq(taskTable.id, task.id));

    const row = await getTask(task.id);
    expect(row?.status).toBe("cancelled");
    if (!row) throw new Error("task missing");

    await enqueueTaskRun(runtimeDb, row, {
      groupId: group.id,
      messageId,
      participantId: exec.id,
      ex,
      body,
      groupPrompt: null,
      specRef: null,
      specHash: null,
    });

    await waitUntilIdle();

    const after = await getTask(task.id);
    expect(after?.status).toBe("cancelled");
    expect(after?.diffSummary).toMatchObject({
      error: "stopped",
      summary: "stop won the race",
    });

    // 可观察事实:假 bin 从未被调用 —— 只断言 status 不够。
    expect(existsSync(sentinel)).toBe(false);
  }, 30_000);
});
