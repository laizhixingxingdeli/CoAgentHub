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
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * 阶段2-票1:server 内嵌执行器触发链路。
 *
 * 用 fake bin 做集成测试(票面允许):把 EXECUTOR_BIN_CODEBUDDY 指到一个
 * 临时 shell 脚本(打印「汇报」+ commit hash 后 exit 0),再向 CodeBuddy
 * 执行器 participant 发定向消息 → 断言 server 自动建 task(executor_key=codebuddy)、
 * spawn 完成后 status=done + diffSummary,且群里出现 🚀/✅ 状态回传。
 *
 * 票2 起 server 在 spawn 前打 git 快照(refs/coagenthub-cp/<taskId>),必须把
 * COAGENTHUB_REPO_ROOT 指到一个临时 git 仓库,避免在真实仓库上跑 git add/commit。
 *
 * A2A 用例:win-hermes 是 kind=a2a 的远端执行器,不发 ticket/spawn,直接经
 * A2A gateway 调用。COAGENTHUB_WIN_A2A_URL 指向不可达地址即可——fetch 被 mock,
 * 验证 token 从 env 读、URL 可配。
 *
 * 注意:executors.ts 的 EXECUTORS 在模块加载时求值(读 env),所以 env 必须
 * 在 import app 之前设置 —— 本文件用顶层 await 动态 import。
 */

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-exec-bin-"));
const fakeBin = path.join(fakeDir, "fake-codebuddy.sh");
writeFileSync(
  fakeBin,
  [
    "#!/bin/sh",
    // 捕获任务书内容供断言($3 = {ticket} 路径);TICKET_CAPTURE 未设时不动作。
    'if [ -n "$TICKET_CAPTURE" ]; then cp "$3" "$TICKET_CAPTURE"; fi',
    'echo "commit 0123456789abcdef0123456789abcdef01234567"',
    'echo "汇报:建文件完成"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeBin, 0o755);
process.env.EXECUTOR_BIN_CODEBUDDY = fakeBin;

// A2A 用例:token 必须从 env 读(不硬编码);URL 用 env 覆盖为不可达地址,
// fetch 会被 mock,不真正联网。
process.env.COAGENTHUB_WIN_A2A_TOKEN = "test-a2a-token";
process.env.COAGENTHUB_WIN_A2A_URL = "http://127.0.0.1:9911/";

// 票2:执行前快照需要真实 git 仓库,CoAgentHub_REPO_ROOT 覆盖 findRepoRoot。
const repoDir = mkdtempSync(path.join(tmpdir(), "coagenthub-exec-repo-"));
execFileSync("git", ["init", "-q"], { cwd: repoDir });
execFileSync("git", ["config", "user.email", "test@coagenthub.local"], {
  cwd: repoDir,
});
execFileSync("git", ["config", "user.name", "coagenthub-test"], {
  cwd: repoDir,
});
writeFileSync(path.join(repoDir, "seed.txt"), "seed\n");
execFileSync("git", ["add", "-A"], { cwd: repoDir });
execFileSync("git", ["commit", "-qm", "seed"], { cwd: repoDir });
process.env.COAGENTHUB_REPO_ROOT = repoDir;

// 顶层 await 动态 import:env 设置先于模块求值。
const { createTestApp } = await import("./app");

describe("server 内嵌执行器触发链路(票1)", () => {
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
      executorParticipantId: string;
      executorKey: string | null;
      status: string;
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
      senderId: string;
      body: string;
      contentType: string;
    }>;
  }

  /** 轮询任务直到终态(异步 spawn 完成),超时抛错。票2 起任务会先经过
   *  queued 状态,所以等终态(done/failed/cancelled),不等「非 running」。 */
  async function waitForTask(
    token: string,
    groupId: string,
    messageId: string,
    timeoutMs = 10_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const tasks = await listTasks(token, groupId);
      const t = tasks.find((x) => x.messageId === messageId);
      if (t && ["done", "failed", "cancelled"].includes(t.status)) return t;
      if (Date.now() > deadline) {
        throw new Error(`task 未在 ${timeoutMs}ms 内达到终态`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** 群主的 coordinator + CodeBuddy 执行器成员就绪。 */
  async function setupGroup() {
    const coordinator = await registerParticipant({
      name: "coord-exec",
    });
    const codebuddy = await registerParticipant({
      name: "CodeBuddy 执行器", // executors.ts 的 agentName,触发匹配靠它
    });
    const group = await createGroup(coordinator.token, "执行器触发测试");
    await addMember(coordinator.token, group.id, codebuddy.id, ["executor"]);
    return { coordinator, codebuddy, group };
  }

  afterAll(() => {
    rmSync(fakeDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("定向消息命中执行器 → 自动建 task(executor_key=codebuddy)+ spawn 完成 done", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();

    const msg = await postMessage(coordinator.token, group.id, {
      body: "建一个文件 hello.txt",
      audience: "participant",
      audienceRef: codebuddy.id,
    });

    // server 侧异步 spawn;轮询等 done。
    const task = await waitForTask(coordinator.token, group.id, msg.id);
    expect(task.executorParticipantId).toBe(codebuddy.id);
    expect(task.executorKey).toBe("codebuddy");
    expect(task.status).toBe("done");
    const diff = task.diffSummary as Record<string, unknown> | null;
    expect(diff).not.toBeNull();
    expect(diff!.hash).toBe("0123456789ab"); // fake bin 打印的 commit hash
    expect(String(diff!.summary)).toContain("汇报");

    // 状态回传:🚀 开始执行 + ✅ 完成,以执行器身份、contentType=task_status。
    const messages = await listMessages(coordinator.token, group.id);
    const statusMsgs = messages.filter((m) => m.contentType === "task_status");
    expect(statusMsgs.some((m) => m.body.startsWith("🚀"))).toBe(true);
    expect(statusMsgs.some((m) => m.body.startsWith("✅"))).toBe(true);
    expect(statusMsgs.every((m) => m.senderId === codebuddy.id)).toBe(true);
  });

  it("定向到非执行器 participant 的消息不建 task", async () => {
    const coordinator = await registerParticipant({
      name: "coord-plain",
    });
    const ordinary = await registerParticipant({
      name: "ordinary-participant",
    });
    const group = await createGroup(coordinator.token, "非执行器触发");
    await addMember(coordinator.token, group.id, ordinary.id, ["observer"]);

    await postMessage(coordinator.token, group.id, {
      body: "给普通 participant 的消息",
      audience: "participant",
      audienceRef: ordinary.id,
    });
    // 等一小段,确认没有 task 被创建(spawn 是异步的,给足时间)。
    await new Promise((r) => setTimeout(r, 300));
    const tasks = await listTasks(coordinator.token, group.id);
    expect(tasks).toHaveLength(0);
  });

  it("同一消息重复触发不重复 spawn(已 done 则跳过)", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();
    const msg = await postMessage(coordinator.token, group.id, {
      body: "重复触发测试",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    await waitForTask(coordinator.token, group.id, msg.id);

    const before = await listMessages(coordinator.token, group.id);
    const doneMsgsBefore = before.filter(
      (m) => m.contentType === "task_status" && m.body.startsWith("✅"),
    ).length;

    // 模拟桥/重复投递:再次以同一消息触发(直接调内部入口)。
    const { maybeDispatchExecutorTask } = await import(
      "@server/lib/executor-task"
    );
    const { testDb } = await import("./db");
    await maybeDispatchExecutorTask(
      testDb as unknown as Parameters<typeof maybeDispatchExecutorTask>[0],
      {
        groupId: group.id,
        messageId: msg.id,
        senderRoles: ["coordinator"],
        audienceRef: codebuddy.id,
        body: "重复触发测试",
      },
    );
    await new Promise((r) => setTimeout(r, 300));

    const after = await listMessages(coordinator.token, group.id);
    const doneMsgsAfter = after.filter(
      (m) => m.contentType === "task_status" && m.body.startsWith("✅"),
    ).length;
    expect(doneMsgsAfter).toBe(doneMsgsBefore); // 未重复执行
  });

  it("带 prompt 的成员定向调度 → 任务书含「本群分工」段", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();
    // 角色解绑后:给执行器成员配群内分工提示词(POST upsert 带上 prompt)。
    const addRes = await app.request(`/api/groups/${group.id}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${coordinator.token}`,
      },
      body: JSON.stringify({
        participantId: codebuddy.id,
        roles: ["executor"],
        prompt: "负责代码执行与测试跑通",
      }),
    });
    expect(addRes.status).toBe(200);

    const capture = path.join(fakeDir, "ticket-with-prompt.md");
    process.env.TICKET_CAPTURE = capture;
    try {
      const msg = await postMessage(coordinator.token, group.id, {
        body: "建一个文件 hello.txt",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const task = await waitForTask(coordinator.token, group.id, msg.id);
      expect(task.status).toBe("done");
      // 任务书写入发生在 spawn 前,fake bin 已把全文拷到 capture。
      const ticket = readFileSync(capture, "utf8");
      expect(ticket).toContain(
        "本群分工:角色=[executor];提示词=负责代码执行与测试跑通",
      );
      expect(ticket).toContain("你是 codebuddy。任务:建一个文件 hello.txt");
    } finally {
      delete process.env.TICKET_CAPTURE;
    }
  });

  it("不带 prompt 的成员定向调度 → 任务书与解绑前完全一致(零回归)", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();

    const capture = path.join(fakeDir, "ticket-no-prompt.md");
    process.env.TICKET_CAPTURE = capture;
    try {
      const msg = await postMessage(coordinator.token, group.id, {
        body: "建一个文件 hello.txt",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const task = await waitForTask(coordinator.token, group.id, msg.id);
      expect(task.status).toBe("done");
      const ticket = readFileSync(capture, "utf8");
      // 无「本群分工」段,且整份任务书与既有格式逐字一致(仓库行用本测试的 repoDir)。
      expect(ticket).not.toContain("本群分工");
      expect(ticket).toBe(
        [
          "# CoAgentHub 任务(网页 @executor 发布)",
          "",
          "你是 codebuddy。任务:建一个文件 hello.txt",
          `仓库:${repoDir}(分支 main)`,
          "默认约束(除非消息里明确说明):不动 schema/迁移/scripts/ 下其他脚本、不删数据;测试全绿后提交,commit message 按功能写。",
          "汇报:中文,做了什么/测试结果/commit hash。",
        ].join("\n"),
      );
    } finally {
      delete process.env.TICKET_CAPTURE;
    }
  });

  it("a2a 执行器(win-hermes):定向消息 → task → gateway 调用 → 完成回传", async () => {
    // mock 全局 fetch:捕获调用并返回「TASK_STATE_COMPLETED + 回复文本」。
    const fetchMock = vi.fn(async (input: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        method: string;
        params: { message: { parts: Array<{ kind: string; text: string }> } };
      };
      expect(body.method).toBe("message/send");
      expect(body.params.message.parts[0]).toMatchObject({
        kind: "text",
        text: "回复 ACAT-WIN-OK",
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: "1.0",
          id: "1",
          result: {
            message: {
              role: "participant",
              parts: [{ kind: "text", text: "ACAT-WIN-OK" }],
            },
            state: { state: "completed" },
          },
        }),
        text: async () => "",
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const coordinator = await registerParticipant({
        name: "coord-a2a",
      });
      const winHermes = await registerParticipant({
        name: "Win Hermes", // executors.ts 的 agentName
      });
      const group = await createGroup(coordinator.token, "a2a 触发测试");
      await addMember(coordinator.token, group.id, winHermes.id, ["executor"]);

      const msg = await postMessage(coordinator.token, group.id, {
        body: "回复 ACAT-WIN-OK",
        audience: "participant",
        audienceRef: winHermes.id,
      });

      const task = await waitForTask(coordinator.token, group.id, msg.id);
      expect(task.executorParticipantId).toBe(winHermes.id);
      expect(task.executorKey).toBe("win-hermes");
      expect(task.status).toBe("done");

      // gateway 调用:URL 用 COAGENTHUB_WIN_A2A_URL,Authorization 用 env token。
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [callUrl, callInit] = fetchMock.mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(callUrl).toBe("http://127.0.0.1:9911/");
      expect((callInit.headers as Record<string, string>).Authorization).toBe(
        "Bearer test-a2a-token",
      );

      // 完成回传:🚀 + ✅(含远端回复文本),以 win-hermes 身份。
      const messages = await listMessages(coordinator.token, group.id);
      const statusMsgs = messages.filter(
        (m) => m.contentType === "task_status",
      );
      expect(statusMsgs.some((m) => m.body.startsWith("🚀"))).toBe(true);
      const doneMsg = statusMsgs.find((m) => m.body.startsWith("✅"));
      expect(doneMsg).toBeDefined();
      expect(doneMsg!.body).toContain("ACAT-WIN-OK");
      expect(statusMsgs.every((m) => m.senderId === winHermes.id)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
