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
 * 阶段2-票2 + 调度并行化(票4):server 按 project_path 分组的执行队列(同组
 * 串行、跨组并行,并行组数 ≤ maxParallelGroups)+ 停止/回滚控制指令 + 重启兜底。
 *
 * 用 fake bin 做集成测试(票面允许):把 EXECUTOR_BIN_CODEBUDDY 指到一个
 * 可配置的临时 shell 脚本(FAKE_SLEEP_SECS 控制时长、FAKE_APPEND 控制是否
 * 修改工作区文件),COAGENTHUB_REPO_ROOT 指到临时 git 仓库(执行前快照/回滚需要)。
 *
 * 覆盖:同组(默认组)两条定向消息只有一条 running、另一条 queued 且完成后
 * 才轮到;不同 project_path 的两个任务可同时 running;同一 project_path 的
 * 两个群任务严格串行;maxParallelGroups=1 时退化为全局串行;默认组(无
 * project_path)任务可与项目组并行;「停止」kill 进程组(task → cancelled +
 * 🛑 回传);「回滚 <taskId>」恢复工作区(task → failed + ✅ 回传);重启兜底
 * queued/running → failed。
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

describe("执行器队列(按项目分组并行)+ 停止/回滚控制指令 + 重启兜底", () => {
  const app = createTestApp();

  async function registerParticipant(body: Record<string, unknown>) {
    const res = await app.request("/api/participants", {
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
    participantId: string,
    roles: string[],
  ) {
    const res = await app.request(`/api/groups/${groupId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ participantId, roles }),
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
    const coordinator = await registerParticipant({
      name: "coord-queue",
    });
    const codebuddy = await registerParticipant({
      name: "CodeBuddy 执行器",
    });
    const group = await createGroup(coordinator.token, "队列控制测试");
    await addMember(coordinator.token, group.id, codebuddy.id, ["executor"]);
    return { coordinator, codebuddy, group };
  }

  /** 建临时 git 仓库(project_path 绑定用;快照/回滚需要真实仓库)。 */
  function makeGitRepo(prefix: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@coagenthub.local"], {
      cwd: dir,
    });
    execFileSync("git", ["config", "user.name", "coagenthub-test"], {
      cwd: dir,
    });
    writeFileSync(path.join(dir, "hello.txt"), "original\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "seed"], { cwd: dir });
    return dir;
  }

  /** PATCH /groups/:id 绑定 project_path(必须是存在的绝对目录)。 */
  async function bindProject(token: string, groupId: string, dir: string) {
    const res = await app.request(`/api/groups/${groupId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ projectPath: dir }),
    });
    expect(res.status).toBe(200);
  }

  afterAll(() => {
    rmSync(fakeDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("组内串行(默认组):同群两条任务只有一条 running,另一条 queued,完成后才轮到", async () => {
    // 默认单测超时 5s,本测试需要跑完真实 sleep + 轮询,显式放宽到 30s。
    // 长 sleep 给并行负载留足余量,避免轮询滞后导致断言误判。
    process.env.FAKE_SLEEP_SECS = "5";
    const { coordinator, codebuddy, group } = await setupGroup();

    const m1 = await postMessage(coordinator.token, group.id, {
      body: "任务一(慢)",
      audience: "participant",
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
      audience: "participant",
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

  it("并行:两个不同 project_path 的任务可同时 running", async () => {
    process.env.FAKE_SLEEP_SECS = "5";
    const { coordinator, codebuddy } = await setupGroup();
    // 两个不同项目的群,分别绑定各自的临时 git 仓库。
    const projA = makeGitRepo("coagenthub-par-a-");
    const projB = makeGitRepo("coagenthub-par-b-");
    const groupA = await createGroup(coordinator.token, "并行群 A");
    await addMember(coordinator.token, groupA.id, codebuddy.id, ["executor"]);
    await bindProject(coordinator.token, groupA.id, projA);
    const groupB = await createGroup(coordinator.token, "并行群 B");
    await addMember(coordinator.token, groupB.id, codebuddy.id, ["executor"]);
    await bindProject(coordinator.token, groupB.id, projB);

    const m1 = await postMessage(coordinator.token, groupA.id, {
      body: "任务一(慢)",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    const t1 = await waitForTaskStatus(
      coordinator.token,
      groupA.id,
      m1.id,
      "running",
    );
    expect(t1.status).toBe("running");

    const m2 = await postMessage(coordinator.token, groupB.id, {
      body: "任务二(慢)",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    // 不同 project_path → 不同组 → 不排队,直接 running(与第一条并行)。
    const t2 = await waitForTaskStatus(
      coordinator.token,
      groupB.id,
      m2.id,
      "running",
    );
    expect(t2.status).toBe("running");

    // 核心不变量:两条任务同时 running(轮询间隙第一条未结束)。
    const againA = await listTasks(coordinator.token, groupA.id);
    const againB = await listTasks(coordinator.token, groupB.id);
    expect(againA.find((x) => x.id === t1.id)?.status).toBe("running");
    expect(againB.find((x) => x.id === t2.id)?.status).toBe("running");

    await waitForTaskStatus(coordinator.token, groupA.id, m1.id, "done");
    await waitForTaskStatus(coordinator.token, groupB.id, m2.id, "done");
  }, 30_000);

  it("串行:同一 project_path 的两个群任务只有一条 running", async () => {
    process.env.FAKE_SLEEP_SECS = "5";
    const { coordinator, codebuddy } = await setupGroup();
    // 两个群绑定同一个 project_path → 归入同一组,组内串行。
    const proj = makeGitRepo("coagenthub-sameproj-");
    const groupA = await createGroup(coordinator.token, "同项目群 A");
    await addMember(coordinator.token, groupA.id, codebuddy.id, ["executor"]);
    await bindProject(coordinator.token, groupA.id, proj);
    const groupB = await createGroup(coordinator.token, "同项目群 B");
    await addMember(coordinator.token, groupB.id, codebuddy.id, ["executor"]);
    await bindProject(coordinator.token, groupB.id, proj);

    const m1 = await postMessage(coordinator.token, groupA.id, {
      body: "任务一(慢)",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    const t1 = await waitForTaskStatus(
      coordinator.token,
      groupA.id,
      m1.id,
      "running",
    );
    expect(t1.status).toBe("running");

    // 同一 project_path → 同组,第二条必须排队,不能并行。
    const m2 = await postMessage(coordinator.token, groupB.id, {
      body: "任务二",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    const t2 = await waitForTaskStatus(
      coordinator.token,
      groupB.id,
      m2.id,
      "queued",
    );
    expect(t2.status).toBe("queued");
    const againB = await listTasks(coordinator.token, groupB.id);
    expect(
      againB
        .filter((x) => x.status === "running")
        .some((x) => x.messageId === m2.id),
    ).toBe(false);

    await waitForTaskStatus(coordinator.token, groupA.id, m1.id, "done");
    await waitForTaskStatus(coordinator.token, groupB.id, m2.id, "done");
  }, 30_000);

  it("退化:maxParallelGroups=1 时不同 project_path 也严格串行(全局串行)", async () => {
    process.env.FAKE_SLEEP_SECS = "5";
    const { __setMaxParallelGroupsForTests } = await import(
      "@server/lib/executor-task"
    );
    __setMaxParallelGroupsForTests(1);
    try {
      const { coordinator, codebuddy } = await setupGroup();
      const projA = makeGitRepo("coagenthub-deg-a-");
      const projB = makeGitRepo("coagenthub-deg-b-");
      const groupA = await createGroup(coordinator.token, "退化群 A");
      await addMember(coordinator.token, groupA.id, codebuddy.id, ["executor"]);
      await bindProject(coordinator.token, groupA.id, projA);
      const groupB = await createGroup(coordinator.token, "退化群 B");
      await addMember(coordinator.token, groupB.id, codebuddy.id, ["executor"]);
      await bindProject(coordinator.token, groupB.id, projB);

      const m1 = await postMessage(coordinator.token, groupA.id, {
        body: "任务一(慢)",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t1 = await waitForTaskStatus(
        coordinator.token,
        groupA.id,
        m1.id,
        "running",
      );
      expect(t1.status).toBe("running");

      // 组槽位只剩 0:不同项目也必须排队,退化为全局串行。
      const m2 = await postMessage(coordinator.token, groupB.id, {
        body: "任务二",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t2 = await waitForTaskStatus(
        coordinator.token,
        groupB.id,
        m2.id,
        "queued",
      );
      expect(t2.status).toBe("queued");

      await waitForTaskStatus(coordinator.token, groupA.id, m1.id, "done");
      await waitForTaskStatus(coordinator.token, groupB.id, m2.id, "done");
    } finally {
      // 恢复默认并行组数,避免影响后续用例。
      const { __setMaxParallelGroupsForTests: restore } = await import(
        "@server/lib/executor-task"
      );
      restore(2);
    }
  }, 30_000);

  it("默认组:无 project_path 的群任务与项目组任务可并行执行", async () => {
    process.env.FAKE_SLEEP_SECS = "5";
    const { coordinator, codebuddy } = await setupGroup();
    // 群 A 不绑项目(默认组),群 B 绑定项目。
    const groupDefault = await createGroup(coordinator.token, "默认组群");
    await addMember(coordinator.token, groupDefault.id, codebuddy.id, [
      "executor",
    ]);
    const proj = makeGitRepo("coagenthub-default-par-");
    const groupProj = await createGroup(coordinator.token, "项目组群");
    await addMember(coordinator.token, groupProj.id, codebuddy.id, [
      "executor",
    ]);
    await bindProject(coordinator.token, groupProj.id, proj);

    const m1 = await postMessage(coordinator.token, groupDefault.id, {
      body: "默认组任务(慢)",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    const t1 = await waitForTaskStatus(
      coordinator.token,
      groupDefault.id,
      m1.id,
      "running",
    );
    expect(t1.status).toBe("running");

    // 默认组是独立组:项目组任务不受默认组阻塞,直接 running。
    const m2 = await postMessage(coordinator.token, groupProj.id, {
      body: "项目组任务(慢)",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    const t2 = await waitForTaskStatus(
      coordinator.token,
      groupProj.id,
      m2.id,
      "running",
    );
    expect(t2.status).toBe("running");

    const again = await listTasks(coordinator.token, groupDefault.id);
    const againProj = await listTasks(coordinator.token, groupProj.id);
    expect(again.find((x) => x.id === t1.id)?.status).toBe("running");
    expect(againProj.find((x) => x.id === t2.id)?.status).toBe("running");

    await waitForTaskStatus(coordinator.token, groupDefault.id, m1.id, "done");
    await waitForTaskStatus(coordinator.token, groupProj.id, m2.id, "done");
  }, 30_000);

  it("「停止」kill 运行中任务的进程组:task → cancelled + 🛑 回传", async () => {
    // 默认单测超时 5s,本测试需要跑完真实 sleep + 轮询,显式放宽到 30s。
    process.env.FAKE_SLEEP_SECS = "60";
    const { coordinator, codebuddy, group } = await setupGroup();

    const msg = await postMessage(coordinator.token, group.id, {
      body: "长跑任务",
      audience: "participant",
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

  it("定向给非执行器 participant 的「停止」仍识别(hermes 特判已移除)", async () => {
    // participant.type 移除后不再有 hermes 特判:定向给非执行器 participant
    // 的消息若匹配停止/回滚指令仍触发(与现状对 non-hermes 非执行器一致)。
    process.env.FAKE_SLEEP_SECS = "";
    const { coordinator, codebuddy, group } = await setupGroup();

    // 定向给 coordinator(非执行器 participant),消息体匹配「停止」。
    await postMessage(coordinator.token, group.id, {
      body: "停止",
      audience: "participant",
      audienceRef: coordinator.id,
    });

    // 无运行中任务 → 以执行器身份回传 ⛔(证明指令被识别而非按讨论跳过;
    // ⛔ 不在 STATUS_EMOJI_RE 内,回传为 text/plain,故只按 body 前缀匹配)。
    await waitForMessage(coordinator.token, group.id, (m) =>
      m.body.startsWith("⛔"),
    );
    // 定向给执行器 participant 的任务消息不触发控制指令(防误伤):消息体匹配
    // 「停止」但受众是执行器 → 走任务而非控制指令,不回传 ⛔。等任务跑完
    // (FAKE_SLEEP_SECS="" 立即结束)再断言,避免遗留进程污染后续测试。
    const msg2 = await postMessage(coordinator.token, group.id, {
      body: "停止",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    await waitForTaskStatus(coordinator.token, group.id, msg2.id, "done");
    const after = await listMessages(coordinator.token, group.id);
    expect(after.filter((m) => m.body.startsWith("⛔"))).toHaveLength(1);
  }, 30_000);

  it("「回滚 <taskId>」恢复工作区到执行前快照:task → failed + ✅ 回传", async () => {
    // 默认单测超时 5s,本测试需要跑完真实 sleep + 轮询,显式放宽到 30s。
    process.env.FAKE_SLEEP_SECS = "";
    process.env.FAKE_APPEND = "1";
    const { coordinator, codebuddy, group } = await setupGroup();

    const msg = await postMessage(coordinator.token, group.id, {
      body: "修改 hello.txt",
      audience: "participant",
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
        executorParticipantId: codebuddy.id,
        executorKey: "codebuddy",
        status: "queued",
      },
      {
        groupId: group.id,
        messageId: mRunning,
        executorParticipantId: codebuddy.id,
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
