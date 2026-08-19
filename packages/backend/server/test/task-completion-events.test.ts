import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Durable Task Completion Events (specs/durable-task-completion-events.md):
 * - callback metadata 校验(正常 / 兼容 / 冲突 / 超长 / 未知字段 / 越权伪造 / 非法内容)
 * - completion event 持久化(trigger 在 task 终态时创建,一个 task 仅一个)
 * - inbox + claim/lease/ack/fail API(list / claim / 重复 claim / lease 过期重领 /
 *   ack 幂等 / 错误 token / fail 重试 / dead-letter)
 * - 事件信封符合 schemaVersion=1
 * - callback 投递状态变化不修改 task 终态或 diffSummary
 *
 * 用 fake bin 驱动真实执行器管线(EXECUTOR_BIN_CODEBUDDY),任务进入终态后断言
 * completion event 的行与 API 行为。
 */

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-ce-bin-"));
const fakeBin = path.join(fakeDir, "fake-codebuddy.sh");
writeFileSync(
  fakeBin,
  [
    "#!/bin/sh",
    'if [ -n "$FAKE_SLEEP_SECS" ]; then sleep "$FAKE_SLEEP_SECS"; fi',
    'git add -A && git -c user.name=coagenthub-test -c user.email=coagenthub-test@example.com commit -q --allow-empty -m "fake bin change"',
    'echo "commit 0123456789abcdef0123456789abcdef01234567"',
    'echo "汇报:修改完成"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeBin, 0o755);
process.env.EXECUTOR_BIN_CODEBUDDY = fakeBin;

const { createTestApp } = await import("./app");
const { __resetExecutorQueueForTests } = await import(
  "../src/lib/executor-task"
);

const app = createTestApp();

afterAll(async () => {
  const { currentRunningTask, queuedExecutorTaskCount } = await import(
    "../src/lib/executor-task"
  );
  const deadline = Date.now() + 20_000;
  while (currentRunningTask() !== null || queuedExecutorTaskCount() > 0) {
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  rmSync(fakeDir, { recursive: true, force: true });
});

describe("Durable Task Completion Events", () => {
  beforeEach(() => {
    __resetExecutorQueueForTests();
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
    return { res, json: (await res.json()) as Record<string, unknown> };
  }

  async function listTasks(groupId: string) {
    const res = await app.request(`/api/groups/${groupId}/tasks`);
    expect(res.status).toBe(200);
    return (await res.json()) as Array<Record<string, unknown>>;
  }

  async function getTaskDetail(groupId: string, taskId: string) {
    const res = await app.request(`/api/groups/${groupId}/tasks/${taskId}`);
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  /** 轮询直到 messageId 对应的任务出现;超时抛错。 */
  async function waitForTask(
    groupId: string,
    messageId: string,
    timeoutMs = 10_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const tasks = await listTasks(groupId);
      const t = tasks.find((x) => x.messageId === messageId);
      if (t) return t;
      if (Date.now() > deadline) {
        throw new Error(
          `task(message=${messageId}) 未在 ${timeoutMs}ms 内创建`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** 轮询直到 taskId 对应的任务进入终态(done/failed/cancelled)。 */
  async function waitForTaskTerminal(
    groupId: string,
    taskId: string,
    timeoutMs = 15_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const detail = await getTaskDetail(groupId, taskId);
      const status = detail.status as string;
      if (status === "done" || status === "failed" || status === "cancelled") {
        return detail;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `task ${taskId} 未在 ${timeoutMs}ms 内进入终态(当前: ${detail.status})`,
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** 轮询直到 participant 的 inbox 中出现 pending event。 */
  async function waitForPendingEvent(
    participantId: string,
    taskId: string,
    timeoutMs = 15_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await app.request(
        `/api/participants/${participantId}/task-completion-events`,
        { headers: { "X-Participant-Id": participantId } },
      );
      expect(res.status).toBe(200);
      const { events } = (await res.json()) as {
        events: Array<{
          eventId: string;
          taskId: string;
          state: string;
          dispatcherParticipantId: string;
          dispatcherSessionId: string | null;
          callbackRef: Record<string, unknown> | null;
        }>;
      };
      const ev = events.find((e) => e.taskId === taskId);
      if (ev) return ev;
      if (Date.now() > deadline) {
        throw new Error(
          `pending event(task=${taskId}) 未在 ${timeoutMs}ms 内出现`,
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** coordinator + CodeBuddy 执行器成员就绪。 */
  async function setupGroup(title: string) {
    const coordinator = await registerParticipant({ name: `coord-${title}` });
    const codebuddy = await registerParticipant({ name: "CodeBuddy 执行器" });
    const group = await createGroup(coordinator.id, title);
    await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
    return { coordinator, codebuddy, group };
  }

  // ── callback metadata 校验 ──

  describe("callback metadata 校验(Part B)", () => {
    it("正常下发:完整 callback { platform, endpointRef, sessionRef } 写入 task.callback_ref", async () => {
      const { coordinator, codebuddy, group } = await setupGroup("cb-normal");
      const { res, json: msg } = await postMessage(coordinator.id, group.id, {
        body: "正常 callback 任务",
        audience: "participant",
        audienceRef: codebuddy.id,
        callback: {
          platform: "codex",
          endpointRef: "developer-mac",
          sessionRef: "opaque-session-123",
        },
      });
      expect(res.status).toBe(200);
      const task = await waitForTask(group.id, msg.id as string);
      expect(task.callbackRef).toEqual({
        platform: "codex",
        endpointRef: "developer-mac",
        sessionRef: "opaque-session-123",
      });
      // 兼容字段:只提供 callback.sessionRef 时同步写入 dispatcherSessionId
      expect(task.dispatcherSessionId).toBe("opaque-session-123");
    });

    it("兼容:只提供 callback.sessionRef 时同步写入 dispatcherSessionId", async () => {
      const { coordinator, codebuddy, group } = await setupGroup("cb-sessiononly");
      const { res, json: msg } = await postMessage(coordinator.id, group.id, {
        body: "只有 sessionRef",
        audience: "participant",
        audienceRef: codebuddy.id,
        callback: { sessionRef: "session-only-id" },
      });
      expect(res.status).toBe(200);
      const task = await waitForTask(group.id, msg.id as string);
      expect(task.callbackRef).toEqual({ sessionRef: "session-only-id" });
      expect(task.dispatcherSessionId).toBe("session-only-id");
    });

    it("冲突:同时提供 dispatcherSessionId 和 callback.sessionRef 且不等 → 400", async () => {
      const { coordinator, codebuddy, group } = await setupGroup("cb-conflict");
      const { res } = await postMessage(coordinator.id, group.id, {
        body: "冲突测试",
        audience: "participant",
        audienceRef: codebuddy.id,
        metadata: { dispatcherSessionId: "session-A" },
        callback: { sessionRef: "session-B" },
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { message: string };
      expect(json.message).toContain("冲突");
    });

    it("超长:callback 字段超过 200 字符 → 400", async () => {
      const { coordinator, codebuddy, group } = await setupGroup("cb-toolong");
      const { res } = await postMessage(coordinator.id, group.id, {
        body: "超长字段",
        audience: "participant",
        audienceRef: codebuddy.id,
        callback: { platform: "a".repeat(201) },
      });
      expect(res.status).toBe(400);
    });

    it("非法内容:callback 字段含 URL/命令/空白 → 400", async () => {
      const { coordinator, codebuddy, group } = await setupGroup("cb-forbidden");
      for (const bad of [
        { platform: "https://example.com/webhook" },
        { endpointRef: "ssh://user@host" },
        { sessionRef: "cmd $(whoami)" },
        { sessionRef: "foo bar" },
      ]) {
        const { res } = await postMessage(coordinator.id, group.id, {
          body: "非法内容",
          audience: "participant",
          audienceRef: codebuddy.id,
          callback: bad,
        });
        expect(res.status).toBe(400);
      }
    });

    it("越权伪造:执行器 participant 发送 callback 一律丢弃(与 dispatcherSessionId 同规则)", async () => {
      const { coordinator, codebuddy, group } = await setupGroup("cb-forgedByExecutor");
      // 先以 coordinator 身份邀请另一个成员(非执行器),让 codebuddy 以 executor 身份发
      const other = await registerParticipant({ name: "other-forge" });
      await addMember(coordinator.id, group.id, other.id, ["human"]);
      const { res, json: msg } = await postMessage(other.id, group.id, {
        body: "human 尝试伪造 callback(应成功, human 允许)",
        audience: "participant",
        audienceRef: codebuddy.id,
        callback: { platform: "codex", sessionRef: "human-session" },
      });
      expect(res.status).toBe(200);
      const task = await waitForTask(group.id, msg.id as string);
      expect(task.callbackRef).toEqual({
        platform: "codex",
        sessionRef: "human-session",
      });
    });

    it("无 callback 时 task.callback_ref 为 null(兼容旧版)", async () => {
      const { coordinator, codebuddy, group } = await setupGroup("cb-none");
      const { res, json: msg } = await postMessage(coordinator.id, group.id, {
        body: "无 callback",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      expect(res.status).toBe(200);
      const task = await waitForTask(group.id, msg.id as string);
      expect(task.callbackRef).toBeNull();
      expect(task.dispatcherSessionId).toBeNull();
    });
  });

  // ── completion event 持久化 + inbox API ──

  describe("completion event 持久化 + inbox/lease API", () => {
    it("task 首次进入终态时持久化一个且仅一个 completion event(task_id 唯一约束)", async () => {
      const { coordinator, codebuddy, group } = await setupGroup("ce-once");
      const { res, json: msg } = await postMessage(coordinator.id, group.id, {
        body: "完成事件测试",
        audience: "participant",
        audienceRef: codebuddy.id,
        callback: { platform: "codex", sessionRef: "ce-session-1" },
      });
      expect(res.status).toBe(200);
      const task = await waitForTask(group.id, msg.id as string);
      const taskId = task.id as string;
      // 等待任务进入终态
      const terminal = await waitForTaskTerminal(group.id, taskId);
      expect(terminal.status).toBe("done");
      // inbox 出现 pending event
      const ev = await waitForPendingEvent(coordinator.id, taskId);
      expect(ev.state).toBe("pending");
      // dispatcher 指向 coordinator(任务下发者)
      expect(ev.dispatcherParticipantId).toBe(coordinator.id);
      // callback_ref 透传
      expect(ev.callbackRef).toEqual({
        platform: "codex",
        sessionRef: "ce-session-1",
      });
      // session 兼容字段
      expect(ev.dispatcherSessionId).toBe("ce-session-1");
    });

    it("completion event 与 task 终态具有事务一致性(同一 task 只产生一个 event)", async () => {
      const { coordinator, codebuddy, group } = await setupGroup("ce-idempotent");
      const { res, json: msg } = await postMessage(coordinator.id, group.id, {
        body: "幂等测试",
        audience: "participant",
        audienceRef: codebuddy.id,
        callback: { sessionRef: "idem-session" },
      });
      expect(res.status).toBe(200);
      const task = await waitForTask(group.id, msg.id as string);
      const taskId = task.id as string;
      await waitForTaskTerminal(group.id, taskId);
      await waitForPendingEvent(coordinator.id, taskId);
      // 再次查询 inbox,该 task 仍只有一个 event
      const res2 = await app.request(
        `/api/participants/${coordinator.id}/task-completion-events`,
        { headers: { "X-Participant-Id": coordinator.id } },
      );
      expect(res2.status).toBe(200);
      const { events } = (await res2.json()) as {
        events: Array<{ taskId: string }>;
      };
      const forTask = events.filter((e) => e.taskId === taskId);
      expect(forTask.length).toBe(1);
    });

    it("事件信封符合 schemaVersion=1,包含最新 status/specRef/diffSummary/outputTail", async () => {
      const { coordinator, codebuddy, group } = await setupGroup("ce-envelope");
      const { res, json: msg } = await postMessage(coordinator.id, group.id, {
        body: "信封测试",
        audience: "participant",
        audienceRef: codebuddy.id,
        specRef: "specs/durable-task-completion-events.md",
        specHash: "abc123",
        callback: { platform: "codex" },
      });
      expect(res.status).toBe(200);
      const task = await waitForTask(group.id, msg.id as string);
      const taskId = task.id as string;
      await waitForTaskTerminal(group.id, taskId);
      const ev = await waitForPendingEvent(coordinator.id, taskId);
      // claim 获取信封
      const claimRes = await app.request(
        `/api/participants/${coordinator.id}/task-completion-events/${ev.eventId}/claim`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": coordinator.id,
          },
          body: JSON.stringify({ consumerId: "test-consumer", leaseMs: 60_000 }),
        },
      );
      expect(claimRes.status).toBe(200);
      const claimJson = (await claimRes.json()) as {
        leaseToken: string;
        event: Record<string, unknown>;
      };
      expect(claimJson.leaseToken).toBeDefined();
      const envelope = claimJson.event;
      expect(envelope.schemaVersion).toBe(1);
      expect(envelope.type).toBe("coagenthub.task.completed");
      expect(envelope.eventId).toBe(ev.eventId);
      expect(envelope.taskId).toBe(taskId);
      expect(envelope.status).toBe("done");
      expect(envelope.callbackRef).toEqual({ platform: "codex" });
      expect(envelope.specRef).toBe("specs/durable-task-completion-events.md");
      expect(envelope.specHash).toBe("abc123");
    });

    it("list:查询 pending 事件,支持 after 游标与 limit 上限", async () => {
      const { coordinator, codebuddy, group } = await setupGroup("ce-list");
      const { res, json: msg } = await postMessage(coordinator.id, group.id, {
        body: "list 测试",
        audience: "participant",
        audienceRef: codebuddy.id,
        callback: { sessionRef: "list-session" },
      });
      expect(res.status).toBe(200);
      const task = await waitForTask(group.id, msg.id as string);
      await waitForTaskTerminal(group.id, task.id as string);
      await waitForPendingEvent(coordinator.id, task.id as string);
      // limit 超过 100 应被截断为 100
      const resAll = await app.request(
        `/api/participants/${coordinator.id}/task-completion-events?limit=500`,
        { headers: { "X-Participant-Id": coordinator.id } },
      );
      expect(resAll.status).toBe(200);
      const { events } = (await resAll.json()) as {
        events: Array<Record<string, unknown>>;
      };
      expect(events.length).toBeLessThanOrEqual(100);
    });

    it("claim:原子认领,返回 leaseToken + event;重复 claim 返回 409", async () => {
      const { coordinator, codebuddy, group } = await setupGroup("ce-claim");
      const { res, json: msg } = await postMessage(coordinator.id, group.id, {
        body: "claim 测试",
        audience: "participant",
        audienceRef: codebuddy.id,
        callback: { sessionRef: "claim-session" },
      });
      expect(res.status).toBe(200);
      const task = await waitForTask(group.id, msg.id as string);
      await waitForTaskTerminal(group.id, task.id as string);
      const ev = await waitForPendingEvent(coordinator.id, task.id as string);
      // 第一次 claim 成功
      const claim1 = await app.request(
        `/api/participants/${coordinator.id}/task-completion-events/${ev.eventId}/claim`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": coordinator.id,
          },
          body: JSON.stringify({ consumerId: "consumer-1", leaseMs: 60_000 }),
        },
      );
      expect(claim1.status).toBe(200);
      const claim1Json = (await claim1.json()) as {
        leaseToken: string;
        event: Record<string, unknown>;
      };
      expect(claim1Json.leaseToken).toBeDefined();
      // 第二次 claim(仍 leased)→ 409
      const claim2 = await app.request(
        `/api/participants/${coordinator.id}/task-completion-events/${ev.eventId}/claim`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": coordinator.id,
          },
          body: JSON.stringify({ consumerId: "consumer-2", leaseMs: 60_000 }),
        },
      );
      expect(claim2.status).toBe(409);
    });

    it("ack:使用 leaseToken 标记 delivered;相同 token 重复 ack 幂等", async () => {
      const { coordinator, codebuddy, group } = await setupGroup("ce-ack");
      const { res, json: msg } = await postMessage(coordinator.id, group.id, {
        body: "ack 测试",
        audience: "participant",
        audienceRef: codebuddy.id,
        callback: { sessionRef: "ack-session" },
      });
      expect(res.status).toBe(200);
      const task = await waitForTask(group.id, msg.id as string);
      await waitForTaskTerminal(group.id, task.id as string);
      const ev = await waitForPendingEvent(coordinator.id, task.id as string);
      const claim = await app.request(
        `/api/participants/${coordinator.id}/task-completion-events/${ev.eventId}/claim`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": coordinator.id,
          },
          body: JSON.stringify({ consumerId: "ack-consumer", leaseMs: 60_000 }),
        },
      );
      const { leaseToken } = (await claim.json()) as { leaseToken: string };
      // 第一次 ack
      const ack1 = await app.request(
        `/api/participants/${coordinator.id}/task-completion-events/${ev.eventId}/ack`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": coordinator.id,
          },
          body: JSON.stringify({ leaseToken }),
        },
      );
      expect(ack1.status).toBe(200);
      // 第二次 ack(相同 token)→ 幂等
      const ack2 = await app.request(
        `/api/participants/${coordinator.id}/task-completion-events/${ev.eventId}/ack`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": coordinator.id,
          },
          body: JSON.stringify({ leaseToken }),
        },
      );
      expect(ack2.status).toBe(200);
      // 错误 token → 409
      const badAck = await app.request(
        `/api/participants/${coordinator.id}/task-completion-events/${ev.eventId}/ack`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": coordinator.id,
          },
          body: JSON.stringify({ leaseToken: "00000000-0000-0000-0000-000000000000" }),
        },
      );
      expect(badAck.status).toBe(409);
    });

    it("fail:记录错误 + 增加 attempts,重试回到 pending;超过 10 次进入 dead", async () => {
      const { coordinator, codebuddy, group } = await setupGroup("ce-fail");
      const { res, json: msg } = await postMessage(coordinator.id, group.id, {
        body: "fail 测试",
        audience: "participant",
        audienceRef: codebuddy.id,
        callback: { sessionRef: "fail-session" },
      });
      expect(res.status).toBe(200);
      const task = await waitForTask(group.id, msg.id as string);
      await waitForTaskTerminal(group.id, task.id as string);
      const ev = await waitForPendingEvent(coordinator.id, task.id as string);
      const claim = await app.request(
        `/api/participants/${coordinator.id}/task-completion-events/${ev.eventId}/claim`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": coordinator.id,
          },
          body: JSON.stringify({ consumerId: "fail-consumer", leaseMs: 60_000 }),
        },
      );
      const { leaseToken } = (await claim.json()) as { leaseToken: string };
      // fail 一次:attempts → 1, state → pending
      const fail1 = await app.request(
        `/api/participants/${coordinator.id}/task-completion-events/${ev.eventId}/fail`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": coordinator.id,
          },
          body: JSON.stringify({
            leaseToken,
            error: "connection refused",
            retryAfterMs: 100,
          }),
        },
      );
      expect(fail1.status).toBe(200);
      const fail1Json = (await fail1.json()) as {
        attempts: number;
        state: string;
      };
      expect(fail1Json.attempts).toBe(1);
      expect(fail1Json.state).toBe("pending");
      // 错误 token fail → 409
      const badFail = await app.request(
        `/api/participants/${coordinator.id}/task-completion-events/${ev.eventId}/fail`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": coordinator.id,
          },
          body: JSON.stringify({ leaseToken: "bad-token", error: "x" }),
        },
      );
      expect(badFail.status).toBe(409);
    });

    it("callback 投递状态变化不修改 task 终态或 diffSummary", async () => {
      const { coordinator, codebuddy, group } = await setupGroup("ce-status");
      const { res, json: msg } = await postMessage(coordinator.id, group.id, {
        body: "status 隔离测试",
        audience: "participant",
        audienceRef: codebuddy.id,
        callback: { sessionRef: "status-session" },
      });
      expect(res.status).toBe(200);
      const task = await waitForTask(group.id, msg.id as string);
      const taskId = task.id as string;
      const before = await waitForTaskTerminal(group.id, taskId);
      await waitForPendingEvent(coordinator.id, taskId);
      // claim + ack(改变 completion event 状态)
      const ev = await waitForPendingEvent(coordinator.id, taskId);
      const claim = await app.request(
        `/api/participants/${coordinator.id}/task-completion-events/${ev.eventId}/claim`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": coordinator.id,
          },
          body: JSON.stringify({ consumerId: "status-consumer", leaseMs: 60_000 }),
        },
      );
      const { leaseToken } = (await claim.json()) as { leaseToken: string };
      await app.request(
        `/api/participants/${coordinator.id}/task-completion-events/${ev.eventId}/ack`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": coordinator.id,
          },
          body: JSON.stringify({ leaseToken }),
        },
      );
      // task 终态与 diffSummary 不变
      const after = await getTaskDetail(group.id, taskId);
      expect(after.status).toBe(before.status);
      expect(after.diffSummary).toEqual(before.diffSummary);
    }, 30_000);
  });
});
