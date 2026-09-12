import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  executorConfig as executorConfigTable,
  participant as participantTable,
} from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { seedBuiltinExecutorConfigs, testDb } from "./db";
import { withFakeExecutorArgs } from "./fake-executor-bin";

/**
 * CLI 执行器静默超时(`run.stalled` → handleFailure retryable:true)。
 *
 * 背景:全量套件里 `queue.ts` 的 `if (run.stalled)` 分支命中为 0 —— 既有
 * 可靠性用例走 A2A 的 `a2aSilenced`(retryable:false),CLI stall 缺测。
 * `executor-queue.test.ts` 里有一条 skipIf(win32) 的静默用例,且 pin
 * maxRetries=0,只断言终态文案,不证明可重试语义。
 *
 * 本文件补两条可观察事实:
 *  1. 无输出假 bin 超 stall 阈值 → failed + diffSummary.error=「执行器静默超时」
 *  2. 同失败 retryable:true → 出现 ↻ 自动重试 + retryCount 递增
 *     (与 a2aSilenced 的 retryable:false 语义相反,写反了会红)
 *
 * 工具:
 *  - 假 bin:Node 脚本按 `FAKE_SLEEP_SECS` 静默等待(零 stdout)。
 *    不用 shell+`sleep` 子进程:Windows 上 `handleStall` 的 kill 落不到
 *    sleep 子进程,promise 永不 settle,`if (run.stalled)` 完成路径进不去
 *    (既有 queue 用例因此 skipIf(win32))。Node 单进程可被 child.kill 终止,
 *    跨平台都能走到完成路径。语义仍是「长睡 + 零输出」。
 *  - 阈值:`__setReliabilityTimeoutsForTests(500, …)` 500ms 级
 *  - 全局状态 afterEach 还原(避免污染同轮其它文件)
 */

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-stall-bin-"));
const fakeScript = path.join(fakeDir, "fake-stall.mjs");
writeFileSync(
  fakeScript,
  [
    "// 静默假执行器:按 FAKE_SLEEP_SECS 等待,期间零输出。",
    "// stall kill 后进程退出,走失败路径;正常睡完才打印收尾。",
    "const secs = Number(process.env.FAKE_SLEEP_SECS || '0');",
    "const ms = Number.isFinite(secs) && secs > 0 ? secs * 1000 : 0;",
    "await new Promise((r) => setTimeout(r, ms));",
    'console.log("commit 0123456789abcdef0123456789abcdef01234567");',
    'console.log("汇报:修改完成");',
    "process.exit(0);",
    "",
  ].join("\n"),
);
// bin = 当前 node;args 最前面拼脚本路径(与 fake-executor-bin 的 argsPrefix 同款)。
const fakeBin = process.execPath;
const fakeArgsPrefix = [fakeScript];
process.env.EXECUTOR_BIN_CODEBUDDY = fakeBin;

const repoDir = mkdtempSync(path.join(tmpdir(), "coagenthub-stall-repo-"));
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

const { createTestApp } = await import("./app");
const {
  __resetExecutorQueueForTests,
  __setReliabilityTimeoutsForTests,
  __setMaxRetriesForTests,
} = await import("@server/lib/executor-task");

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

afterAll(() => {
  rmSync(fakeDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

describe("CLI 执行器静默超时(run.stalled)", () => {
  const app = createTestApp();

  afterEach(() => {
    // 进程级状态必须还原:阈值 / maxRetries / FAKE_* 泄漏会污染同轮其它文件
    // (executor-queue.test.ts 注释记过 maxRetries=0 不还原导致 CI 长期红)。
    // __resetExecutorQueueForTests 会把 stall/claim/retryPolicy 一并恢复到 policy。
    __resetExecutorQueueForTests();
    delete process.env.FAKE_SLEEP_SECS;
    delete process.env.FAKE_APPEND;
    delete process.env.FAKE_NO_COMMIT;
  });

  async function registerParticipant(body: Record<string, unknown>) {
    const res = await app.request("/api/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 409) {
      const list = (await (await app.request("/api/participants")).json()) as {
        id: string;
        name: string;
      }[];
      const existing = list.find((p) => p.name === body.name);
      if (existing) {
        if (body.name === "CodeBuddy") {
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
    if (body.name === "CodeBuddy") {
      await testDb
        .update(participantTable)
        .set({ executorKey: "codebuddy" })
        .where(eq(participantTable.id, id));
    }
    return { id };
  }

  async function createGroup(participantId: string, title: string) {
    const res = await app.request("/api/groups", {
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
    participantId: string,
    groupId: string,
    memberParticipantId: string,
    roles: string[],
  ) {
    const res = await app.request(`/api/groups/${groupId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": participantId,
      },
      body: JSON.stringify({ participantId: memberParticipantId, roles }),
    });
    expect(res.status).toBe(200);
  }

  async function postMessage(
    participantId: string,
    groupId: string,
    body: Record<string, unknown>,
  ) {
    const res = await app.request(`/api/groups/${groupId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": participantId,
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
  }

  async function listTasks(participantId: string, groupId: string) {
    const res = await app.request(`/api/groups/${groupId}/tasks`, {
      headers: { "X-Participant-Id": participantId },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Array<{
      id: string;
      messageId: string;
      status: string;
      retryCount: number;
      diffSummary: Record<string, unknown> | null;
    }>;
  }

  async function listMessages(participantId: string, groupId: string) {
    const res = await app.request(`/api/groups/${groupId}/messages`, {
      headers: { "X-Participant-Id": participantId },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Array<{
      id: string;
      body: string;
      contentType: string;
    }>;
  }

  async function waitForTaskStatus(
    participantId: string,
    groupId: string,
    messageId: string,
    status: string,
    timeoutMs = 12_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const tasks = await listTasks(participantId, groupId);
      const t = tasks.find((x) => x.messageId === messageId);
      if (t && t.status === status) return t;
      if (Date.now() > deadline) {
        throw new Error(
          `task(message=${messageId}) 未在 ${timeoutMs}ms 内达到 ${status}` +
            `(当前=${t?.status ?? "无"} error=${JSON.stringify(t?.diffSummary?.error ?? null)} retryCount=${t?.retryCount ?? "无"})`,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function waitForMessage(
    participantId: string,
    groupId: string,
    predicate: (m: { body: string; contentType: string }) => boolean,
    timeoutMs = 12_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const messages = await listMessages(participantId, groupId);
      const hit = messages.find(predicate);
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(`群里未在 ${timeoutMs}ms 内出现预期消息`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function setupGroup() {
    const coordinator = await registerParticipant({
      name: `coord-stall-${Math.random().toString(36).slice(2, 8)}`,
    });
    const codebuddy = await registerParticipant({ name: "CodeBuddy" });
    const group = await createGroup(coordinator.id, "CLI 静默超时测试");
    await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
    return { coordinator, codebuddy, group };
  }

  it("无输出假 bin 超过 stall 阈值 → failed,原因为「执行器静默超时」", async () => {
    // maxRetries=0:只看第一次终态,不连跑多次(阈值 500ms 时 4 次会拖慢)。
    // 可重试语义由下一条用例单独证明。
    process.env.FAKE_SLEEP_SECS = "30";
    __setReliabilityTimeoutsForTests(500, 60_000);
    __setMaxRetriesForTests(0);

    const { coordinator, codebuddy, group } = await setupGroup();
    const msg = await postMessage(coordinator.id, group.id, {
      body: "静默任务(无输出)",
      audience: "participant",
      audienceRef: codebuddy.id,
    });

    const task = await waitForTaskStatus(
      coordinator.id,
      group.id,
      msg.id,
      "failed",
    );
    expect(task.diffSummary?.error).toBe("执行器静默超时");
    expect(task.retryCount).toBe(0);

    await waitForMessage(
      coordinator.id,
      group.id,
      (m) =>
        m.contentType === "task_status" && m.body.includes("执行器静默超时"),
    );
  }, 20_000);

  it("静默超时失败可重试(retryable:true):↻ 回传 + retryCount 递增,最终仍为「执行器静默超时」", async () => {
    // maxRetries=1:第一次 stall → 可重试路径(↻ + 重新入队);第二次 stall →
    // 最终 failed。若生产代码误写成 retryable:false(与 a2aSilenced 混同),
    // 不会出现 ↻,retryCount 保持 0,本用例变红。
    process.env.FAKE_SLEEP_SECS = "30";
    __setReliabilityTimeoutsForTests(500, 60_000);
    __setMaxRetriesForTests(1);

    const { coordinator, codebuddy, group } = await setupGroup();
    const msg = await postMessage(coordinator.id, group.id, {
      body: "静默任务(可重试)",
      audience: "participant",
      audienceRef: codebuddy.id,
    });

    // 可重试路径的可观察信号:首次失败后的 ↻ 自动重试提示。
    // 注意:STATUS_EMOJI_RE 不含 ↻,postStatus 会落成 text/plain(不是 task_status)。
    await waitForMessage(
      coordinator.id,
      group.id,
      (m) => m.body.startsWith("↻") && m.body.includes("自动重试 (第 1 次)"),
    );

    const task = await waitForTaskStatus(
      coordinator.id,
      group.id,
      msg.id,
      "failed",
      15_000,
    );
    expect(task.diffSummary?.error).toBe("执行器静默超时");
    expect(task.retryCount).toBe(1);

    const messages = await listMessages(coordinator.id, group.id);
    expect(
      messages.some(
        (m) =>
          m.contentType === "task_status" && m.body.includes("执行器静默超时"),
      ),
    ).toBe(true);
  }, 25_000);
});
