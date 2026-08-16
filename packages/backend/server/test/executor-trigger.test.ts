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
    // 弱验收要求工作树干净 + HEAD 有新提交:真正提交一次(显式身份,CI 无全局
    // git config 也能跑)。
    'git add -A && git -c user.name=coagenthub-test -c user.email=coagenthub-test@example.com commit -q --allow-empty -m "fake bin change"',
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
    // 名字唯一(0013):同名已注册时服务端返回 409,复用现有 participant(测试内多次 setupGroup)。
    if (res.status === 409) {
      const list = (await (await app.request("/api/participants")).json()) as {
        id: string;
        name: string;
      }[];
      const existing = list.find((p) => p.name === body.name);
      if (existing) return { id: existing.id };
    }
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
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
    return (await res.json()) as {
      id: string;
      groupId: string;
      senderId: string;
    };
  }

  async function listTasks(participantId: string, groupId: string) {
    const res = await app.request(`/api/groups/${groupId}/tasks`, {
      headers: { "X-Participant-Id": participantId },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Array<{
      id: string;
      messageId: string;
      executorParticipantId: string;
      executorKey: string | null;
      status: string;
      diffSummary: unknown;
      a2aContextId: string | null;
    }>;
  }

  async function listMessages(participantId: string, groupId: string) {
    const res = await app.request(`/api/groups/${groupId}/messages`, {
      headers: { "X-Participant-Id": participantId },
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
    participantId: string,
    groupId: string,
    messageId: string,
    timeoutMs = 10_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const tasks = await listTasks(participantId, groupId);
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
    const group = await createGroup(coordinator.id, "执行器触发测试");
    await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
    return { coordinator, codebuddy, group };
  }

  afterAll(() => {
    rmSync(fakeDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("定向消息命中执行器 → 自动建 task(executor_key=codebuddy)+ spawn 完成 done", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();

    const msg = await postMessage(coordinator.id, group.id, {
      body: "建一个文件 hello.txt",
      audience: "participant",
      audienceRef: codebuddy.id,
    });

    // server 侧异步 spawn;轮询等 done。
    const task = await waitForTask(coordinator.id, group.id, msg.id);
    expect(task.executorParticipantId).toBe(codebuddy.id);
    expect(task.executorKey).toBe("codebuddy");
    expect(task.status).toBe("done");
    const diff = task.diffSummary as Record<string, unknown> | null;
    expect(diff).not.toBeNull();
    expect(diff!.hash).toBe("0123456789ab"); // fake bin 打印的 commit hash
    // 结构化段落解析(票7):「汇报:」段只取段值,不再带关键词前缀。
    expect(String(diff!.summary)).toContain("建文件完成");

    // 状态回传:🚀 开始执行 + ✅ 完成,以执行器身份、contentType=task_status。
    const messages = await listMessages(coordinator.id, group.id);
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
    const group = await createGroup(coordinator.id, "非执行器触发");
    await addMember(coordinator.id, group.id, ordinary.id, ["observer"]);

    await postMessage(coordinator.id, group.id, {
      body: "给普通 participant 的消息",
      audience: "participant",
      audienceRef: ordinary.id,
    });
    // 等一小段,确认没有 task 被创建(spawn 是异步的,给足时间)。
    await new Promise((r) => setTimeout(r, 300));
    const tasks = await listTasks(coordinator.id, group.id);
    expect(tasks).toHaveLength(0);
  });

  it("非协调者定向消息给执行器 → 403,且不产生群消息和任务", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();
    const observer = await registerParticipant({ name: "exec-observer" });
    await addMember(coordinator.id, group.id, observer.id, ["observer"]);

    const res = await app.request(`/api/groups/${group.id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": observer.id,
      },
      body: JSON.stringify({
        body: "非协调者发任务",
        audience: "participant",
        audienceRef: codebuddy.id,
      }),
    });
    // 写入前校验(票:403 替代静默成功):状态码 + 明确错误信息。
    expect(res.status).toBe(403);
    const err = (await res.json()) as { code: string; message: string };
    expect(err.message).toContain("无权限发布任务");

    // 消息未被写入,任务未创建(spawn 是异步的,给足时间确认)。
    const messages = await listMessages(observer.id, group.id);
    expect(messages.some((m) => m.body === "非协调者发任务")).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    const tasks = await listTasks(observer.id, group.id);
    expect(tasks).toHaveLength(0);
  });

  it("非协调者定向消息给普通 participant → 仍成功(不触发 403)", async () => {
    const { coordinator, group } = await setupGroup();
    const ordinary = await registerParticipant({ name: "ordinary-member" });
    await addMember(coordinator.id, group.id, ordinary.id, ["observer"]);
    const observer = await registerParticipant({ name: "plain-observer" });
    await addMember(coordinator.id, group.id, observer.id, ["observer"]);

    const res = await app.request(`/api/groups/${group.id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": observer.id,
      },
      body: JSON.stringify({
        body: "普通定向消息",
        audience: "participant",
        audienceRef: ordinary.id,
      }),
    });
    expect(res.status).toBe(200);
    const msg = (await res.json()) as { id: string };
    const messages = await listMessages(observer.id, group.id);
    expect(
      messages.some((m) => m.id === msg.id && m.body === "普通定向消息"),
    ).toBe(true);
    // 目标非执行器,不建任务(普通定向行为不变)。
    await new Promise((r) => setTimeout(r, 300));
    const tasks = await listTasks(observer.id, group.id);
    expect(tasks).toHaveLength(0);
  });

  it("同一消息重复触发不重复 spawn(已 done 则跳过)", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();
    const msg = await postMessage(coordinator.id, group.id, {
      body: "重复触发测试",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    await waitForTask(coordinator.id, group.id, msg.id);

    const before = await listMessages(coordinator.id, group.id);
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
        // Part A:直接调内部入口时下发者字段按测试语义提供(与消息路由一致)。
        dispatcherParticipantId: coordinator.id,
        dispatcherSessionId: null,
      },
    );
    await new Promise((r) => setTimeout(r, 300));

    const after = await listMessages(coordinator.id, group.id);
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
        "X-Participant-Id": coordinator.id,
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
      const msg = await postMessage(coordinator.id, group.id, {
        body: "建一个文件 hello.txt",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const task = await waitForTask(coordinator.id, group.id, msg.id);
      expect(task.status).toBe("done");
      // 任务书写入发生在 spawn 前,fake bin 已把全文拷到 capture。
      const ticket = readFileSync(capture, "utf8");
      expect(ticket).toContain(
        "本群分工:角色=[executor];提示词=负责代码执行与测试跑通",
      );
      // 固定模板(票7):执行器/任务内容段携带标签与 body 原文。
      expect(ticket).toContain("执行器: codebuddy");
      expect(ticket).toContain("## 任务内容");
      expect(ticket).toContain("建一个文件 hello.txt");
    } finally {
      delete process.env.TICKET_CAPTURE;
    }
  });

  it("不带 prompt 的成员定向调度 → 任务书与解绑前完全一致(零回归)", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();

    const capture = path.join(fakeDir, "ticket-no-prompt.md");
    process.env.TICKET_CAPTURE = capture;
    try {
      const msg = await postMessage(coordinator.id, group.id, {
        body: "建一个文件 hello.txt",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const task = await waitForTask(coordinator.id, group.id, msg.id);
      expect(task.status).toBe("done");
      const ticket = readFileSync(capture, "utf8");
      // 无「本群分工」段;任务书为固定模板(票7):发布时间是动态 ISO,逐行断言
      // 各固定段,不整份等值比较。
      expect(ticket).not.toContain("本群分工");
      expect(ticket).toContain("# CoAgentHub 任务");
      expect(ticket).toContain("执行器: codebuddy");
      expect(ticket).toContain(`项目: ${repoDir}`);
      expect(ticket).toMatch(/发布时间: \d{4}-\d{2}-\d{2}T/);
      expect(ticket).toContain("## 任务内容");
      expect(ticket).toContain("建一个文件 hello.txt");
      expect(ticket).toContain("## 汇报格式要求(stdout 请按此输出)");
      expect(ticket).toContain("提交: <commit hash>");
      expect(ticket).toContain("测试: <测试结果摘要>");
      expect(ticket).toContain("汇报: <做了什么,3-5 句>");
      expect(ticket).toContain('遗留: <未完成事项,无则写"无">');
      expect(ticket).toContain(
        "默认约束(除非消息里明确说明):不动 schema/迁移/scripts/ 下其他脚本、不删数据;测试全绿后提交,commit message 按功能写。",
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
      const group = await createGroup(coordinator.id, "a2a 触发测试");
      await addMember(coordinator.id, group.id, winHermes.id, ["executor"]);

      const msg = await postMessage(coordinator.id, group.id, {
        body: "回复 ACAT-WIN-OK",
        audience: "participant",
        audienceRef: winHermes.id,
      });

      const task = await waitForTask(coordinator.id, group.id, msg.id);
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
      const messages = await listMessages(coordinator.id, group.id);
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

  it("a2a 上下文延续:首次任务返回 contextId 落库,第二次任务调用携带", async () => {
    // 假 gateway:第一次调用返回 contextId=ctx-1;第二次调用断言 params 携带
    // ctx-1(上一任务返回的),再返回新 contextId=ctx-2。
    const calls: Array<{ params: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (_input: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        params: Record<string, unknown>;
      };
      calls.push(body);
      const isSecond = calls.length === 2;
      const result: Record<string, unknown> = {
        message: {
          role: "participant",
          parts: [{ kind: "text", text: "ACAT-WIN-OK" }],
        },
        state: { state: "completed" },
        contextId: isSecond ? "ctx-2" : "ctx-1",
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "1.0", id: "1", result }),
        text: async () => "",
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const coordinator = await registerParticipant({
        name: "coord-a2a-ctx",
      });
      const winHermes = await registerParticipant({
        name: "Win Hermes", // executors.ts 的 agentName
      });
      const group = await createGroup(coordinator.id, "a2a 上下文延续");
      await addMember(coordinator.id, group.id, winHermes.id, ["executor"]);

      // 第一次任务:不带 contextId(无历史),gateway 返回 ctx-1 → 落库。
      const msg1 = await postMessage(coordinator.id, group.id, {
        body: "任务一:记住上下文",
        audience: "participant",
        audienceRef: winHermes.id,
      });
      const task1 = await waitForTask(coordinator.id, group.id, msg1.id);
      expect(task1.status).toBe("done");
      expect(task1.a2aContextId).toBe("ctx-1");
      expect(calls[0]?.params.contextId).toBeUndefined();

      // 第二次任务:调用携带上一任务的 ctx-1;gateway 返回 ctx-2 → 落库。
      const msg2 = await postMessage(coordinator.id, group.id, {
        body: "任务二:继续上下文",
        audience: "participant",
        audienceRef: winHermes.id,
      });
      const task2 = await waitForTask(coordinator.id, group.id, msg2.id);
      expect(task2.status).toBe("done");
      expect(calls).toHaveLength(2);
      expect(calls[1]?.params.contextId).toBe("ctx-1");
      expect(task2.a2aContextId).toBe("ctx-2");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a2a 上下文按群隔离:同执行器不同群互不串", async () => {
    // win-hermes(memory=per-group)同时加入两个群;群 A 返回 ctx-a,群 B 的
    // 首次任务不应携带 ctx-a(按群隔离),群 A 的下一次任务仍携带 ctx-a。
    const calls: Array<{ params: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (_input: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        params: {
          message: { parts: Array<{ kind: string; text: string }> };
        };
      };
      calls.push(body);
      const result: Record<string, unknown> = {
        message: {
          role: "participant",
          parts: [{ kind: "text", text: "ACAT-WIN-OK" }],
        },
        state: { state: "completed" },
        contextId: body.params.message.parts[0].text.includes("群B")
          ? "ctx-b"
          : "ctx-a",
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "1.0", id: "1", result }),
        text: async () => "",
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const coordinator = await registerParticipant({
        name: "coord-a2a-iso",
      });
      const winHermes = await registerParticipant({
        name: "Win Hermes",
      });
      const groupA = await createGroup(coordinator.id, "a2a 群A");
      const groupB = await createGroup(coordinator.id, "a2a 群B");
      await addMember(coordinator.id, groupA.id, winHermes.id, ["executor"]);
      await addMember(coordinator.id, groupB.id, winHermes.id, ["executor"]);

      // 群 A 任务一:无历史 → 不带 contextId,返回 ctx-a → 落库。
      const a1 = await postMessage(coordinator.id, groupA.id, {
        body: "群A任务一",
        audience: "participant",
        audienceRef: winHermes.id,
      });
      const taskA1 = await waitForTask(coordinator.id, groupA.id, a1.id);
      expect(taskA1.status).toBe("done");
      expect(taskA1.a2aContextId).toBe("ctx-a");
      expect(calls[0]?.params.contextId).toBeUndefined();

      // 群 B 任务一:虽同执行器,但群 A 的 ctx-a 不应串过来 → 无 contextId。
      const b1 = await postMessage(coordinator.id, groupB.id, {
        body: "群B任务一",
        audience: "participant",
        audienceRef: winHermes.id,
      });
      const taskB1 = await waitForTask(coordinator.id, groupB.id, b1.id);
      expect(taskB1.status).toBe("done");
      expect(taskB1.a2aContextId).toBe("ctx-b");
      expect(calls).toHaveLength(2);
      expect(calls[1]?.params.contextId).toBeUndefined();

      // 群 A 任务二:本群延续,携带 ctx-a。
      const a2 = await postMessage(coordinator.id, groupA.id, {
        body: "群A任务二",
        audience: "participant",
        audienceRef: winHermes.id,
      });
      const taskA2 = await waitForTask(coordinator.id, groupA.id, a2.id);
      expect(taskA2.status).toBe("done");
      expect(calls).toHaveLength(3);
      expect(calls[2]?.params.contextId).toBe("ctx-a");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a2a 无 memory 标记的执行器:从不携带/回写 contextId", async () => {
    // 通过 API 新增一个 kind=a2a、不带 memory 的普通执行器,连续两次任务
    // 都不应携带 contextId,返回的 contextId 也不落库(任务书自包含)。
    const createRes = await app.request("/api/executors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentName: "Plain A2A",
        kind: "a2a",
        url: "http://127.0.0.1:9911/",
        bin: "plain-a2a",
      }),
    });
    expect(createRes.status).toBe(200);

    const calls: Array<{ params: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (_input: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        params: Record<string, unknown>;
      };
      calls.push(body);
      const result: Record<string, unknown> = {
        message: {
          role: "participant",
          parts: [{ kind: "text", text: "ACAT-WIN-OK" }],
        },
        state: { state: "completed" },
        contextId: "ctx-plain",
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "1.0", id: "1", result }),
        text: async () => "",
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const coordinator = await registerParticipant({
        name: "coord-a2a-plain",
      });
      const plain = await registerParticipant({
        name: "Plain A2A",
      });
      const group = await createGroup(coordinator.id, "a2a 普通执行器");
      await addMember(coordinator.id, group.id, plain.id, ["executor"]);

      const m1 = await postMessage(coordinator.id, group.id, {
        body: "任务一",
        audience: "participant",
        audienceRef: plain.id,
      });
      const task1 = await waitForTask(coordinator.id, group.id, m1.id);
      expect(task1.status).toBe("done");
      expect(task1.a2aContextId).toBeNull(); // gateway 返回了 ctx,但无 memory 不回写
      expect(calls[0]?.params.contextId).toBeUndefined();

      // 第二次任务:上一任务已有 a2aContextId?没有 —— 但即使 gateway 返回过,
      // 未落库,所以查不到;且无 memory 标记不查。断言第二次也不带。
      const m2 = await postMessage(coordinator.id, group.id, {
        body: "任务二",
        audience: "participant",
        audienceRef: plain.id,
      });
      const task2 = await waitForTask(coordinator.id, group.id, m2.id);
      expect(task2.status).toBe("done");
      expect(task2.a2aContextId).toBeNull();
      expect(calls).toHaveLength(2);
      expect(calls[1]?.params.contextId).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
