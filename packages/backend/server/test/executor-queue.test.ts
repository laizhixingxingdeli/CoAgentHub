import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * 阶段2-票2:server 全局串行队列 + 停止/回滚控制指令 + 重启兜底。
 *
 * 用 fake bin 做集成测试(票面允许):把 EXECUTOR_BIN_CODEBUDDY 指到一个
 * 可配置的临时 shell 脚本(FAKE_SLEEP_SECS 控制时长、FAKE_APPEND 控制是否
 * 修改工作区文件),COAGENTHUB_REPO_ROOT 指到临时 git 仓库(执行前快照/回滚需要)。
 *
 * 覆盖:并发两条定向消息只有一条 running、另一条 queued 且完成后才轮到;
 * 「停止」kill 进程组(task → cancelled + 🛑 回传);「回滚 <taskId>」恢复
 * 工作区(task → failed + ✅ 回传);重启兜底 queued/running → failed。
 */

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-queue-bin-"));
const fakeBin = path.join(fakeDir, "fake-codebuddy.sh");
writeFileSync(
  fakeBin,
  [
    "#!/bin/sh",
    'if [ -n "$FAKE_SLEEP_SECS" ]; then sleep "$FAKE_SLEEP_SECS"; fi',
    'if [ -n "$FAKE_APPEND" ]; then echo "task-modified" >> "$COAGENTHUB_REPO_ROOT/hello.txt"; fi',
    'echo "commit 0123456789abcdef0123456789abcdef01234567"',
    'echo "汇报:修改完成"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeBin, 0o755);
process.env.EXECUTOR_BIN_CODEBUDDY = fakeBin;

// 执行前快照/回滚需要真实 git 仓库;CoAgentHub_REPO_ROOT 覆盖 findRepoRoot。
const repoDir = mkdtempSync(path.join(tmpdir(), "coagenthub-queue-repo-"));
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

// 顶层 await 动态 import:env 设置先于模块求值。
const { createTestApp } = await import("./app");

describe("票2 串行队列 + 停止/回滚控制指令 + 重启兜底", () => {
  const app = createTestApp();

  async function registerAgent(body: Record<string, unknown>) {
    const res = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const { id, token } = (await res.json()) as { id: string; token: string };
    return { id, token };
  }

  async function createGroup(token: string, title: string) {
    const res = await app.request("/api/groups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
  }

  async function addMember(
    token: string,
    groupId: string,
    agentId: string,
    roles: string[],
  ) {
    const res = await app.request(`/api/groups/${groupId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ agentId, roles }),
    });
    expect(res.status).toBe(200);
  }

  async function postMessage(
    token: string,
    groupId: string,
    body: Record<string, unknown>,
  ) {
    const res = await app.request(`/api/groups/${groupId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      id: string;
      groupId: string;
      senderId: string;
    };
  }

  async function listTasks(token: string, groupId: string) {
    const res = await app.request(`/api/groups/${groupId}/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Array<{
      id: string;
      messageId: string;
      status: string;
      checkpointRef: string | null;
      diffSummary: unknown;
    }>;
  }

  async function listMessages(token: string, groupId: string) {
    const res = await app.request(`/api/groups/${groupId}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Array<{
      id: string;
      body: string;
      contentType: string;
      senderId: string;
    }>;
  }

  /** 轮询直到 task 达到指定状态;超时抛错。 */
  async function waitForTaskStatus(
    token: string,
    groupId: string,
    messageId: string,
    status: string,
    timeoutMs = 15_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const tasks = await listTasks(token, groupId);
      const t = tasks.find((x) => x.messageId === messageId);
      if (t && t.status === status) return t;
      if (Date.now() > deadline) {
        throw new Error(
          `task(message=${messageId}) 未在 ${timeoutMs}ms 内达到 ${status}(当前=${
            tasks.find((x) => x.messageId === messageId)?.status ?? "无"
          })`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** 轮询直到群里出现满足谓词的消息;超时抛错。 */
  async function waitForMessage(
    token: string,
    groupId: string,
    predicate: (m: { body: string; contentType: string }) => boolean,
    timeoutMs = 15_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const messages = await listMessages(token, groupId);
      const hit = messages.find(predicate);
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(`群里未在 ${timeoutMs}ms 内出现预期消息`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** 群主的 coordinator + CodeBuddy 执行器成员就绪。 */
  async function setupGroup() {
    const coordinator = await registerAgent({
      name: "coord-queue",
      type: "hermes",
    });
    const codebuddy = await registerAgent({
      name: "CodeBuddy 执行器",
      type: "agent",
    });
    const group = await createGroup(coordinator.token, "队列控制测试");
    await addMember(coordinator.token, group.id, codebuddy.id, ["executor"]);
    return { coordinator, codebuddy, group };
  }

  afterAll(() => {
    rmSync(fakeDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("队列串行性:两条定向消息只有一条 running,另一条 queued,完成后才轮到", async () => {
    // 默认单测超时 5s,本测试需要跑完真实 sleep + 轮询,显式放宽到 30s。
    // 长 sleep 给并行负载留足余量,避免轮询滞后导致断言误判。
    process.env.FAKE_SLEEP_SECS = "5";
    const { coordinator, codebuddy, group } = await setupGroup();

    const m1 = await postMessage(coordinator.token, group.id, {
      body: "任务一(慢)",
      audience: "agent",
      audienceRef: codebuddy.id,
    });
    // 等第一条真正进入 running(保证第二条一定排到它后面)。
    const t1 = await waitForTaskStatus(
      coordinator.token,
      group.id,
      m1.id,
      "running",
    );
    expect(t1.status).toBe("running");

    const m2 = await postMessage(coordinator.token, group.id, {
      body: "任务二",
      audience: "agent",
      audienceRef: codebuddy.id,
    });
    // 第一条还在跑(2s),第二条应稳定停留在 queued。
    const t2 = await waitForTaskStatus(
      coordinator.token,
      group.id,
      m2.id,
      "queued",
    );
    expect(t2.status).toBe("queued");
    // 核心不变量:绝不同时存在两个 running 任务。若第一条尚未结束,唯一在跑的
    // 必须是 m1;即使它在轮询间隙恰好完成,m2 也必须是 queued(排队而非并发)。
    const again = await listTasks(coordinator.token, group.id);
    const running = again.filter((t) => t.status === "running");
    expect(running.some((t) => t.messageId === m2.id)).toBe(false);
    if (running.length > 0) {
      expect(running.map((t) => t.messageId)).toEqual([m1.id]);
    }

    // 第一条 done 后,第二条才轮到并完成。
    await waitForTaskStatus(coordinator.token, group.id, m1.id, "done");
    await waitForTaskStatus(coordinator.token, group.id, m2.id, "done");

    // 状态回传:第一条 🚀 先到,第二条 📋 排队 + 🚀 随后。
    const messages = await listMessages(coordinator.token, group.id);
    const taskStatus = messages.filter((m) => m.contentType === "task_status");
    expect(taskStatus.some((m) => m.body.startsWith("🚀"))).toBe(true);
    expect(taskStatus.some((m) => m.body.startsWith("📋"))).toBe(true);
  }, 30_000);

  it("「停止」kill 运行中任务的进程组:task → cancelled + 🛑 回传", async () => {
    // 默认单测超时 5s,本测试需要跑完真实 sleep + 轮询,显式放宽到 30s。
    process.env.FAKE_SLEEP_SECS = "60";
    const { coordinator, codebuddy, group } = await setupGroup();

    const msg = await postMessage(coordinator.token, group.id, {
      body: "长跑任务",
      audience: "agent",
      audienceRef: codebuddy.id,
    });
    const t = await waitForTaskStatus(
      coordinator.token,
      group.id,
      msg.id,
      "running",
    );

    // 广播「停止」→ server 终止运行中任务的进程组。
    await postMessage(coordinator.token, group.id, {
      body: "停止",
      audience: "broadcast",
    });

    // 任务被 kill → 完成回调置 cancelled(不再 ❌)。
    const stopped = await waitForTaskStatus(
      coordinator.token,
      group.id,
      msg.id,
      "cancelled",
    );
    expect(stopped.id).toBe(t.id);
    // 群里出现 🛑 回传(以执行器身份)。
    await waitForMessage(
      coordinator.token,
      group.id,
      (m) => m.contentType === "task_status" && m.body.startsWith("🛑"),
    );
  }, 30_000);

  it("「回滚 <taskId>」恢复工作区到执行前快照:task → failed + ✅ 回传", async () => {
    // 默认单测超时 5s,本测试需要跑完真实 sleep + 轮询,显式放宽到 30s。
    process.env.FAKE_SLEEP_SECS = "";
    process.env.FAKE_APPEND = "1";
    const { coordinator, codebuddy, group } = await setupGroup();

    const msg = await postMessage(coordinator.token, group.id, {
      body: "修改 hello.txt",
      audience: "agent",
      audienceRef: codebuddy.id,
    });
    const t = await waitForTaskStatus(
      coordinator.token,
      group.id,
      msg.id,
      "done",
    );
    // 任务执行前快照已写回 checkpoint_ref。
    expect(t.checkpointRef).toBeTruthy();
    // fake bin 修改了工作区。
    expect(readFileSync(path.join(repoDir, "hello.txt"), "utf8")).toContain(
      "task-modified",
    );

    // 广播「回滚 <taskId>」。
    await postMessage(coordinator.token, group.id, {
      body: `回滚 ${t.id}`,
      audience: "broadcast",
    });

    // 工作区恢复 + 群里 ✅ 回传。
    await waitForMessage(
      coordinator.token,
      group.id,
      (m) => m.contentType === "task_status" && m.body.startsWith("✅ 已回滚"),
    );
    expect(readFileSync(path.join(repoDir, "hello.txt"), "utf8")).not.toContain(
      "task-modified",
    );
    // 对应任务置 failed。
    const after = await listTasks(coordinator.token, group.id);
    const rolled = after.find((x) => x.id === t.id);
    expect(rolled?.status).toBe("failed");
  }, 30_000);

  it("重启兜底:queued/running 任务自动恢复为 failed(server-restart)", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();
    const { testDb } = await import("./db");
    const { task: taskTable } = await import(
      "@laizhixingxingdeli/database/schema"
    );
    const { recoverInterruptedTasks } = await import(
      "@server/lib/executor-task"
    );

    // 直接落库两条遗留任务:一条 queued、一条 running(模拟重启瞬间)。
    const mQueued = "00000000-0000-7000-8000-0000000000a1";
    const mRunning = "00000000-0000-7000-8000-0000000000a2";
    await testDb.insert(taskTable).values([
      {
        groupId: group.id,
        messageId: mQueued,
        executorAgentId: codebuddy.id,
        executorKey: "codebuddy",
        status: "queued",
      },
      {
        groupId: group.id,
        messageId: mRunning,
        executorAgentId: codebuddy.id,
        executorKey: "codebuddy",
        status: "running",
      },
    ]);

    const affected = await recoverInterruptedTasks(
      testDb as unknown as Parameters<typeof recoverInterruptedTasks>[0],
    );
    expect(affected).toBe(2);

    const tasks = await listTasks(coordinator.token, group.id);
    for (const m of [mQueued, mRunning]) {
      const t = tasks.find((x) => x.messageId === m);
      expect(t?.status).toBe("failed");
      const diff = t?.diffSummary as Record<string, unknown> | null;
      expect(diff?.error).toBe("server-restart");
    }
  }, 30_000);
});
