import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A2A 协议可靠性(第1-3层):进度/心跳、结果未确认、ReplyMode: detached。
 *
 * 覆盖:
 *  - 第2层:gateway「agent did not reply in time」(无进展)→ 结果未确认
 *    (status=failed + diffSummary.unconfirmed=true + ⚠️ 回传,不回传 ❌);
 *  - 第2层:A2A 请求超时(EXECUTOR_TIMEOUT_MS)但最近有进展 → 结果未确认;
 *  - 第1层:执行器 participant 的群消息刷新最近活跃时间,顺延无进展超时;
 *    停止发进度后超过 a2aSilenceTimeoutMinutes → 无进展失败(❌,非结果未确认);
 *  - 第3层:ReplyMode: detached → A2A 返回后任务保持 running,执行器 PATCH
 *    回写 done 后正确终态;
 *  - 第3层:detached 超时(detachedTimeoutMinutes)未回写 → 结果未确认。
 *
 * 用内置 win-hermes(kind=a2a)执行器做集成测试:全局 fetch 被 mock(指向假
 * gateway),COAGENTHUB_WIN_A2A_URL/TOKEN 按既有 executor-trigger 用例设置。
 * 阈值经 __setReliabilityTimeoutsForTests 调小到 100ms 级,避免拖慢测试。
 */

// env 覆盖先于 app 动态 import(与 executor-trigger.test.ts 同款)。
process.env.COAGENTHUB_WIN_A2A_URL = "http://127.0.0.1:9911/";
process.env.COAGENTHUB_WIN_A2A_TOKEN = "test-a2a-token";

const { createTestApp } = await import("./app");
const {
  __resetExecutorQueueForTests,
  __setReliabilityTimeoutsForTests,
} = await import("@server/lib/executor-task");

describe("A2A 协议可靠性(进度/结果未确认/detached)", () => {
  const app = createTestApp();

  async function registerParticipant(body: Record<string, unknown>) {
    const res = await app.request("/api/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
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
      executorParticipantId: string;
      executorKey: string | null;
      status: string;
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
      senderId: string;
      body: string;
      contentType: string;
    }>;
  }

  /** 轮询任务直到终态(done/failed/cancelled),超时抛错。 */
  async function waitForTask(
    participantId: string,
    groupId: string,
    messageId: string,
    timeoutMs = 4_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const tasks = await listTasks(participantId, groupId);
      const t = tasks.find((x) => x.messageId === messageId);
      if (t && ["done", "failed", "cancelled"].includes(t.status)) return t;
      if (Date.now() > deadline) {
        throw new Error(`task 未在 ${timeoutMs}ms 内达到终态`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** 轮询任务直到指定状态(detached 保持 running 用)。 */
  async function waitForTaskState(
    participantId: string,
    groupId: string,
    messageId: string,
    status: string,
    timeoutMs = 4_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const tasks = await listTasks(participantId, groupId);
      const t = tasks.find((x) => x.messageId === messageId);
      if (t && t.status === status) return t;
      if (Date.now() > deadline) {
        throw new Error(`task 未在 ${timeoutMs}ms 内到达 ${status}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** 假 gateway:立即返回 COMPLETED + 回复文本。 */
  function okResponse(reply: string) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: "1.0",
        id: "1",
        result: {
          message: {
            role: "participant",
            parts: [{ kind: "text", text: reply }],
          },
          state: { state: "completed" },
        },
      }),
      text: async () => "",
    };
  }

  /** 假 gateway:挂起直到请求被 abort(模拟执行器一直不回复)。 */
  function hangFetch() {
    return vi.fn(
      (_input: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
  }

  /** 群主 coordinator + win-hermes(a2a 执行器)成员就绪。 */
  async function setupGroup() {
    const coordinator = await registerParticipant({
      name: `coord-a2a-${Math.random().toString(36).slice(2, 8)}`,
    });
    const winHermes = await registerParticipant({
      name: "Win Hermes", // executors.ts 内置 a2a 执行器的 agentName
    });
    const group = await createGroup(coordinator.id, "a2a 可靠性测试");
    await addMember(coordinator.id, group.id, winHermes.id, ["executor"]);
    return { coordinator, winHermes, group };
  }

  /** 发一条定向给 win-hermes 的 A2A 任务消息。 */
  async function postA2ATask(
    coordinatorId: string,
    groupId: string,
    winHermesId: string,
    body: string,
  ) {
    return postMessage(coordinatorId, groupId, {
      body,
      audience: "participant",
      audienceRef: winHermesId,
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetExecutorQueueForTests();
    delete process.env.EXECUTOR_TIMEOUT_MS;
  });

  it("gateway「agent did not reply in time」(无进展)→ 结果未确认,不回传 ❌", async () => {
    __setReliabilityTimeoutsForTests(500, 500, undefined, 5_000, 60_000);
    // 假 gateway:JSON-RPC error 明确「未收到执行器回复」(如执行器重启后断线)。
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: "1.0",
        id: "1",
        error: { code: -32000, message: "agent did not reply in time" },
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { coordinator, winHermes, group } = await setupGroup();

    const msg = await postA2ATask(
      coordinator.id,
      group.id,
      winHermes.id,
      "回复 ACAT-WIN-OK",
    );

    const task = await waitForTask(coordinator.id, group.id, msg.id);
    // status 保持 failed(不新增状态),diffSummary 加 unconfirmed 标记。
    expect(task.status).toBe("failed");
    expect(task.diffSummary).toMatchObject({
      error: "执行器未按协议回复，结果未确认",
      unconfirmed: true,
    });

    // 群消息回传 ⚠️ 结果未确认,而非 ❌ 任务失败。
    const messages = await listMessages(coordinator.id, group.id);
    const warn = messages.find((m) => m.body.startsWith("⚠️ 任务结果未确认"));
    expect(warn).toBeDefined();
    expect(
      messages.some((m) => m.body.startsWith("❌ 任务失败")),
    ).toBe(false);
  });

  it("A2A 请求超时但最近有进展 → 结果未确认", async () => {
    __setReliabilityTimeoutsForTests(500, 500, undefined, 5_000, 60_000);
    process.env.EXECUTOR_TIMEOUT_MS = "800";
    vi.stubGlobal("fetch", hangFetch());
    const { coordinator, winHermes, group } = await setupGroup();

    const msg = await postA2ATask(
      coordinator.id,
      group.id,
      winHermes.id,
      "回复 ACAT-WIN-OK",
    );
    await waitForTaskState(coordinator.id, group.id, msg.id, "running");

    // 执行器 participant 在群里发普通广播消息 → 进度信号,刷新最近活跃时间。
    await postMessage(winHermes.id, group.id, {
      body: "进度:正在处理中,稍后回复",
      audience: "broadcast",
    });

    // 请求超时(800ms)但最近有进展 → 结果未确认而非失败。
    const task = await waitForTask(coordinator.id, group.id, msg.id);
    expect(task.status).toBe("failed");
    expect(task.diffSummary).toMatchObject({
      unconfirmed: true,
      error: "执行器未按协议回复，结果未确认",
    });
    const messages = await listMessages(coordinator.id, group.id);
    expect(
      messages.some((m) => m.body.startsWith("⚠️ 任务结果未确认")),
    ).toBe(true);
    expect(messages.some((m) => m.body.startsWith("❌ 任务失败"))).toBe(false);
  });

  it("A2A 有进度消息时无进展计时顺延;停止发进度后无进展失败", async () => {
    // 无进展阈值 300ms:进度消息(每 ~150ms 一条)持续刷新则任务保持 running;
    // 停发后超过阈值 → 无进展失败(❌,非结果未确认)。
    __setReliabilityTimeoutsForTests(500, 500, undefined, 300, 60_000);
    vi.stubGlobal("fetch", hangFetch());
    const { coordinator, winHermes, group } = await setupGroup();

    const msg = await postA2ATask(
      coordinator.id,
      group.id,
      winHermes.id,
      "回复 ACAT-WIN-OK",
    );
    await waitForTaskState(coordinator.id, group.id, msg.id, "running");

    // 持续发进度消息(间隔 < 无进展阈值)→ 任务保持 running。
    for (let i = 0; i < 4; i += 1) {
      await postMessage(winHermes.id, group.id, {
        body: `进度 ${i}: 处理中`,
        audience: "broadcast",
      });
      await new Promise((r) => setTimeout(r, 150));
    }
    const still = await listTasks(coordinator.id, group.id);
    expect(still.find((x) => x.messageId === msg.id)?.status).toBe("running");

    // 停发进度 → 超过阈值 → 无进展失败(不是结果未确认)。
    const task = await waitForTask(coordinator.id, group.id, msg.id);
    expect(task.status).toBe("failed");
    expect(task.diffSummary?.error).toBe("执行器无进展");
    expect(task.diffSummary?.unconfirmed).not.toBe(true);
    const messages = await listMessages(coordinator.id, group.id);
    expect(
      messages.some((m) => m.body.includes("执行器无进展")),
    ).toBe(true);
  });

  it("detached:A2A 返回后任务保持 running;执行器 PATCH 回写 done → 正确终态", async () => {
    __setReliabilityTimeoutsForTests(500, 500, undefined, 5_000, 60_000);
    vi.stubGlobal("fetch", vi.fn(async () => okResponse("ACAT-WIN-OK")));
    const { coordinator, winHermes, group } = await setupGroup();

    const msg = await postA2ATask(
      coordinator.id,
      group.id,
      winHermes.id,
      "重启 dsh web 并等待恢复\n## ReplyMode: detached",
    );
    await waitForTaskState(coordinator.id, group.id, msg.id, "running");

    // A2A 已返回(COMPLETED),但 detached 模式不按最终回复定终态 → 仍 running,
    // 且无 ✅/❌/⚠️ 终态回传。
    await new Promise((r) => setTimeout(r, 300));
    let tasks = await listTasks(coordinator.id, group.id);
    const t = tasks.find((x) => x.messageId === msg.id);
    expect(t?.status).toBe("running");
    const before = await listMessages(coordinator.id, group.id);
    expect(before.some((m) => m.body.startsWith("✅"))).toBe(false);
    expect(before.some((m) => m.body.startsWith("❌"))).toBe(false);
    expect(before.some((m) => m.body.startsWith("⚠️ 任务结果未确认"))).toBe(
      false,
    );

    // 执行器恢复后 PATCH 回写终态(该端点已存在,仅执行器 participant 可改)。
    const patch = await app.request(
      `/api/groups/${group.id}/tasks/${t!.id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": winHermes.id,
        },
        body: JSON.stringify({
          status: "done",
          diffSummary: { summary: "dsh web 已重启" },
        }),
      },
    );
    expect(patch.status).toBe(200);

    tasks = await listTasks(coordinator.id, group.id);
    expect(tasks.find((x) => x.messageId === msg.id)?.status).toBe("done");
  });

  it("detached 超时未回写终态 → 结果未确认", async () => {
    __setReliabilityTimeoutsForTests(500, 500, undefined, 5_000, 300);
    vi.stubGlobal("fetch", vi.fn(async () => okResponse("ACAT-WIN-OK")));
    const { coordinator, winHermes, group } = await setupGroup();

    const msg = await postA2ATask(
      coordinator.id,
      group.id,
      winHermes.id,
      "重启 dsh web 并等待恢复\n## ReplyMode: detached",
    );

    // 300ms 后 detached 超时(执行器未 PATCH)→ 结果未确认。
    const task = await waitForTask(coordinator.id, group.id, msg.id);
    expect(task.status).toBe("failed");
    expect(task.diffSummary).toMatchObject({
      unconfirmed: true,
      error: "执行器未按协议回复，结果未确认",
    });
    const messages = await listMessages(coordinator.id, group.id);
    expect(
      messages.some((m) => m.body.startsWith("⚠️ 任务结果未确认")),
    ).toBe(true);
  });
});
