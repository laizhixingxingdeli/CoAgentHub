import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type RawData, WebSocket } from "ws";
import { wsHub } from "../src/lib/ws-hub";

/**
 * Durable Task Completion Events (specs/durable-task-completion-events.md):
 * - callback metadata 校验(正常 / 兼容 / 冲突 / 超长 / 未知字段 / 越权伪造 / 非法内容)
 * - completion event 持久化(trigger 在 task 终态时创建,一个 task 仅一个)
 * - inbox + claim/lease/ack/fail API(list / claim / 重复 claim / lease 过期重领 /
 *   ack 幂等 / 错误 token / fail 重试 / dead-letter)
 * - 事件信封符合 schemaVersion=1(nested task{groupId,taskId,status,specRef,
 *   specHash,diffSummary,outputTail})
 * - 四类终态路径(scheduler 成功 / 最终失败 / 取消 / task PATCH)各生成一个 event
 * - callback 投递状态变化不修改 task 终态或 diffSummary
 * - WS 发轻量 task_completion_available 帧(低延迟提示;可靠性来源仍是 inbox)
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
    // 失败模式:FAKE_ALWAYS_FAIL 时直接 exit 1(最终失败路径测试用)。
    'if [ -n "$FAKE_ALWAYS_FAIL" ]; then echo "always-fail"; exit 1; fi',
    // 长跑模式:FAKE_SLEEP_SECS 时 sleep(停止指令/取消路径测试用)。
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

const app2 = createTestApp();
let server: Server;
let port: number;
const openClients = new Set<WebSocket>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(20);
  }
  throw new Error("condition not met in time");
}

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

/** 标准事件信封(claim/list 返回)的 TS 形状。 */
interface CompletionEventEnvelope {
  schemaVersion: number;
  type: string;
  eventId: string;
  dispatcherParticipantId: string | null;
  dispatcherSessionId: string | null;
  callbackRef: Record<string, unknown> | null;
  task: {
    groupId: string;
    taskId: string;
    status: string | null;
    specRef: string | null;
    specHash: string | null;
    diffSummary: unknown;
    outputTail: unknown;
  };
}

/** inbox 列表项 = 标准信封 + 交付状态。 */
interface InboxEventItem extends CompletionEventEnvelope {
  state: string;
  attempts: number;
}

describe("Durable Task Completion Events", () => {
  beforeEach(() => {
    __resetExecutorQueueForTests();
    delete process.env.FAKE_ALWAYS_FAIL;
    delete process.env.FAKE_SLEEP_SECS;
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

  async function inboxList(participantId: string) {
    const res = await app.request(
      `/api/participants/${participantId}/task-completion-events`,
      { headers: { "X-Participant-Id": participantId } },
    );
    expect(res.status).toBe(200);
    return (await res.json()) as { events: InboxEventItem[] };
  }

  async function claimEvent(
    participantId: string,
    eventId: string,
    consumerId = "test-consumer",
    leaseMs = 60_000,
  ) {
    const res = await app.request(
      `/api/participants/${participantId}/task-completion-events/${eventId}/claim`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": participantId,
        },
        body: JSON.stringify({ consumerId, leaseMs }),
      },
    );
    return {
      res,
      json: (await res.json()) as {
        leaseToken: string;
        event: CompletionEventEnvelope;
      },
    };
  }

  async function ackEvent(
    participantId: string,
    eventId: string,
    leaseToken: string,
  ) {
    const res = await app.request(
      `/api/participants/${participantId}/task-completion-events/${eventId}/ack`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": participantId,
        },
        body: JSON.stringify({ leaseToken }),
      },
    );
    return { res, json: (await res.json()) as Record<string, unknown> };
  }

  async function failEvent(
    participantId: string,
    eventId: string,
    leaseToken: string,
    error?: string,
    retryAfterMs?: number,
  ) {
    const res = await app.request(
      `/api/participants/${participantId}/task-completion-events/${eventId}/fail`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": participantId,
        },
        body: JSON.stringify({
          leaseToken,
          ...(error !== undefined ? { error } : {}),
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        }),
      },
    );
    return { res, json: (await res.json()) as Record<string, unknown> };
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

  /** 轮询直到 taskId 对应的任务进入指定状态。 */
  async function waitForTaskStatus(
    groupId: string,
    taskId: string,
    status: string,
    timeoutMs = 15_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const detail = await getTaskDetail(groupId, taskId);
      if (detail.status === status) return detail;
      if (Date.now() > deadline) {
        throw new Error(
          `task ${taskId} 未在 ${timeoutMs}ms 内进入 ${status}(当前: ${detail.status})`,
        );
      }
      await new Promise((r) => setTimeout(r, 200));
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

  /** 轮询直到 participant 的 inbox 中出现可认领 event(按 task.taskId 匹配)。 */
  async function waitForPendingEvent(
    participantId: string,
    taskId: string,
    timeoutMs = 15_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { events } = await inboxList(participantId);
      const ev = events.find((e) => e.task?.taskId === taskId);
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
      // 兼容字段:同时提供 dispatcherSessionId 与 callback.sessionRef 相等时,
      // sessionRef 同步写入 dispatcherSessionId。
      expect(task.dispatcherSessionId).toBe("opaque-session-123");
    }, 15_000);

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
    }, 15_000);

    it("冲突:同时提供 dispatcherSessionId 和 callback.sessionRef 且不等 → 400", async () => {
      const { coordinator, codebuddy, group } = await setupGroup("cb-conflict");
      const { res, json } = await postMessage(coordinator.id, group.id, {
        body: "冲突测试",
        audience: "participant",
        audienceRef: codebuddy.id,
        metadata: { dispatcherSessionId: "session-A" },
        callback: { sessionRef: "session-B" },
      });
      expect(res.status).toBe(400);
      const body = json as { message?: string };
      expect(body.message).toContain("冲突");
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

    it("未知字段:callback 含未知字段 → 400(拒绝旁路夹带)", async () => {
      const { coordinator, codebuddy, group } = await setupGroup("cb-unknown");
      const { res } = await postMessage(coordinator.id, group.id, {
        body: "未知字段",
        audience: "participant",
        audienceRef: codebuddy.id,
        callback: { platform: "codex", webhookUrl: "https://evil.example.com" },
      });
      expect(res.status).toBe(400);
    });

    it("非法内容:callback 字段含 URL/命令/凭据/空白 → 400", async () => {
      const { coordinator, codebuddy, group } = await setupGroup("cb-forbidden");
      for (const bad of [
        { platform: "https://example.com/webhook" },
        { endpointRef: "ssh://user@host" },
        { sessionRef: "cmd $(whoami)" },
        { sessionRef: "foo bar" },
        // 凭据:赋值形态 / 凭据关键词。
        { platform: "token=abc123" },
        { endpointRef: "secret-token" },
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
      // 给执行器 participant 加 coordinator 角色:角色门槛放行,但「执行器发送的
      // callback 即使携带也忽略」仍必须拦截(与 dispatcherSessionId 伪造同规则)。
      await addMember(coordinator.id, group.id, codebuddy.id, [
        "coordinator",
        "executor",
      ]);
      const { res, json: msg } = await postMessage(codebuddy.id, group.id, {
        body: "执行器伪造 callback",
        audience: "participant",
        audienceRef: codebuddy.id,
        callback: { platform: "codex", sessionRef: "forged-session" },
      });
      expect(res.status).toBe(200);
      const task = await waitForTask(group.id, msg.id as string);
      expect(task.callbackRef).toBeNull();
      expect(task.dispatcherSessionId).toBeNull();
    }, 15_000);

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
    }, 15_000);
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
      expect(ev.attempts).toBe(0);
      // dispatcher 指向 coordinator(任务下发者)
      expect(ev.dispatcherParticipantId).toBe(coordinator.id);
      // callback_ref 透传
      expect(ev.callbackRef).toEqual({
        platform: "codex",
        sessionRef: "ce-session-1",
      });
      // session 兼容字段
      expect(ev.dispatcherSessionId).toBe("ce-session-1");
    }, 30_000);

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
      const { events } = await inboxList(coordinator.id);
      const forTask = events.filter((e) => e.task?.taskId === taskId);
      expect(forTask.length).toBe(1);
    }, 30_000);

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
      const claim = await claimEvent(coordinator.id, ev.eventId);
      expect(claim.res.status).toBe(200);
      expect(claim.json.leaseToken).toBeDefined();
      const envelope = claim.json.event;
      // 标准信封:嵌套 task{groupId,taskId,status,specRef,specHash,...}
      expect(envelope.schemaVersion).toBe(1);
      expect(envelope.type).toBe("coagenthub.task.completed");
      expect(envelope.eventId).toBe(ev.eventId);
      expect(envelope.dispatcherParticipantId).toBe(coordinator.id);
      expect(envelope.callbackRef).toEqual({ platform: "codex" });
      expect(envelope.task.taskId).toBe(taskId);
      expect(envelope.task.status).toBe("done");
      expect(envelope.task.groupId).toBe(group.id);
      expect(envelope.task.specRef).toBe(
        "specs/durable-task-completion-events.md",
      );
      expect(envelope.task.specHash).toBe("abc123");
      expect(envelope.task.diffSummary).toBeDefined();
    }, 30_000);

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
      // limit 超过 100 → 400(严格校验;spec: limit<=100)
      const resAll = await app.request(
        `/api/participants/${coordinator.id}/task-completion-events?limit=500`,
        { headers: { "X-Participant-Id": coordinator.id } },
      );
      expect(resAll.status).toBe(400);
      // limit=100 正常返回
      const resLimit = await app.request(
        `/api/participants/${coordinator.id}/task-completion-events?limit=100`,
        { headers: { "X-Participant-Id": coordinator.id } },
      );
      expect(resLimit.status).toBe(200);
      const { events } = (await resLimit.json()) as {
        events: Array<Record<string, unknown>>;
      };
      expect(events.length).toBeLessThanOrEqual(100);
      // after 游标:传入第一个 eventId 后不再返回它
      const ev = await waitForPendingEvent(coordinator.id, task.id as string);
      const resAfter = await app.request(
        `/api/participants/${coordinator.id}/task-completion-events?after=${ev.eventId}`,
        { headers: { "X-Participant-Id": coordinator.id } },
      );
      expect(resAfter.status).toBe(200);
      const afterBody = (await resAfter.json()) as { events: InboxEventItem[] };
      expect(
        afterBody.events.some((e) => e.eventId === ev.eventId),
      ).toBe(false);
    }, 30_000);

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
      const claim1 = await claimEvent(
        coordinator.id,
        ev.eventId,
        "consumer-1",
        60_000,
      );
      expect(claim1.res.status).toBe(200);
      expect(claim1.json.leaseToken).toBeDefined();
      // 第二次 claim(仍 leased)→ 409
      const claim2 = await claimEvent(
        coordinator.id,
        ev.eventId,
        "consumer-2",
        60_000,
      );
      expect(claim2.res.status).toBe(409);
    }, 30_000);

    it("lease 过期后可重新 claim(重领)", async () => {
      const { coordinator, codebuddy, group } = await setupGroup("ce-reclaim");
      const { res, json: msg } = await postMessage(coordinator.id, group.id, {
        body: "重领测试",
        audience: "participant",
        audienceRef: codebuddy.id,
        callback: { sessionRef: "reclaim-session" },
      });
      expect(res.status).toBe(200);
      const task = await waitForTask(group.id, msg.id as string);
      await waitForTaskTerminal(group.id, task.id as string);
      const ev = await waitForPendingEvent(coordinator.id, task.id as string);
      // 第一次 claim
      const claim1 = await claimEvent(coordinator.id, ev.eventId);
      expect(claim1.res.status).toBe(200);
      // 把 lease 改成已过期(模拟消费方崩溃后 lease 自然到期)
      const { testDb } = await import("./db");
      const { taskCompletionEvent: tce } = await import(
        "@laizhixingxingdeli/database/schema"
      );
      const { eq } = await import("drizzle-orm");
      await testDb
        .update(tce)
        .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
        .where(eq(tce.id, ev.eventId));
      // 过期后可重新 claim(新 token)
      const claim2 = await claimEvent(coordinator.id, ev.eventId, "consumer-2");
      expect(claim2.res.status).toBe(200);
      expect(claim2.json.leaseToken).not.toBe(claim1.json.leaseToken);
    }, 30_000);

    it("ack:使用 leaseToken 标记 delivered;相同 token 重复 ack 幂等;错误 token 409", async () => {
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
      const claim = await claimEvent(coordinator.id, ev.eventId, "ack-consumer");
      const { leaseToken } = claim.json;
      // 第一次 ack
      const ack1 = await ackEvent(coordinator.id, ev.eventId, leaseToken);
      expect(ack1.res.status).toBe(200);
      // 第二次 ack(相同 token)→ 幂等
      const ack2 = await ackEvent(coordinator.id, ev.eventId, leaseToken);
      expect(ack2.res.status).toBe(200);
      // 错误 token → 409
      const badAck = await ackEvent(
        coordinator.id,
        ev.eventId,
        "00000000-0000-0000-0000-000000000000",
      );
      expect(badAck.res.status).toBe(409);
      // delivered 后 inbox 不再列出(已交付)
      const { events } = await inboxList(coordinator.id);
      expect(events.some((e) => e.eventId === ev.eventId)).toBe(false);
    }, 30_000);

    it("fail:记录错误 + 增加 attempts,重试回到 pending;错误 token 409", async () => {
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
      const claim = await claimEvent(coordinator.id, ev.eventId, "fail-consumer");
      const { leaseToken } = claim.json;
      // fail 一次:attempts → 1, state → pending
      const fail1 = await failEvent(
        coordinator.id,
        ev.eventId,
        leaseToken,
        "connection refused",
        100,
      );
      expect(fail1.res.status).toBe(200);
      expect(fail1.json.attempts).toBe(1);
      expect(fail1.json.state).toBe("pending");
      // 错误 token(合法 uuid 但不匹配)→ 409
      const badFail = await failEvent(
        coordinator.id,
        ev.eventId,
        "00000000-0000-0000-0000-000000000000",
        "x",
      );
      expect(badFail.res.status).toBe(409);
    }, 30_000);

    it("fail 超过 10 次进入 dead-letter;dead 后不再可列/可领", async () => {
      const { coordinator, codebuddy, group } = await setupGroup("ce-dead");
      const { res, json: msg } = await postMessage(coordinator.id, group.id, {
        body: "dead-letter 测试",
        audience: "participant",
        audienceRef: codebuddy.id,
        callback: { sessionRef: "dead-session" },
      });
      expect(res.status).toBe(200);
      const task = await waitForTask(group.id, msg.id as string);
      const taskId = task.id as string;
      await waitForTaskTerminal(group.id, taskId);
      const ev = await waitForPendingEvent(coordinator.id, taskId);
      // 10 次 claim → fail(retryAfterMs=0 使事件立即可重试)
      for (let i = 0; i < 10; i++) {
        const claim = await claimEvent(coordinator.id, ev.eventId, `dead-${i}`);
        expect(claim.res.status).toBe(200);
        const fail = await failEvent(
          coordinator.id,
          ev.eventId,
          claim.json.leaseToken,
          `delivery-error-${i}`,
          0,
        );
        expect(fail.res.status).toBe(200);
        expect(fail.json.attempts).toBe(i + 1);
        expect(fail.json.state).toBe(i === 9 ? "dead" : "pending");
      }
      // dead 后 inbox 不再列出
      const { events } = await inboxList(coordinator.id);
      expect(events.some((e) => e.task?.taskId === taskId)).toBe(false);
      // dead 后 claim → 409
      const deadClaim = await claimEvent(coordinator.id, ev.eventId, "dead-again");
      expect(deadClaim.res.status).toBe(409);
    }, 30_000);

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
      const ev = await waitForPendingEvent(coordinator.id, taskId);
      // claim + ack(改变 completion event 状态)
      const claim = await claimEvent(coordinator.id, ev.eventId, "status-consumer");
      const ack = await ackEvent(coordinator.id, ev.eventId, claim.json.leaseToken);
      expect(ack.res.status).toBe(200);
      // task 终态与 diffSummary 不变
      const after = await getTaskDetail(group.id, taskId);
      expect(after.status).toBe(before.status);
      expect(after.diffSummary).toEqual(before.diffSummary);
    }, 30_000);
  });

  // ── 四类终态路径均生成一个 event ──

  describe("四类终态路径均生成一个且仅一个 completion event", () => {
    it("scheduler 成功(done):一个 event(已由上文覆盖,此处断言状态为 done)", async () => {
      const { coordinator, codebuddy, group } = await setupGroup("path-done");
      const { res, json: msg } = await postMessage(coordinator.id, group.id, {
        body: "scheduler 成功路径",
        audience: "participant",
        audienceRef: codebuddy.id,
        callback: { sessionRef: "path-done-session" },
      });
      expect(res.status).toBe(200);
      const task = await waitForTask(group.id, msg.id as string);
      const taskId = task.id as string;
      const terminal = await waitForTaskTerminal(group.id, taskId);
      expect(terminal.status).toBe("done");
      const ev = await waitForPendingEvent(coordinator.id, taskId);
      expect(ev.task.status).toBe("done");
    }, 30_000);

    it("scheduler 最终失败(failed,自动重试后仍失败):一个 event", async () => {
      const { coordinator, codebuddy, group } = await setupGroup("path-failed");
      // 失败模式:FAKE_ALWAYS_FAIL=1 时 fake bin 直接 exit 1;重试(maxRetries=1)
      // 期间仍置位 → 最终 failed(retryCount=1)。
      process.env.FAKE_ALWAYS_FAIL = "1";
      const { res, json: msg } = await postMessage(coordinator.id, group.id, {
        body: "最终失败路径",
        audience: "participant",
        audienceRef: codebuddy.id,
        callback: { sessionRef: "path-failed-session" },
      });
      expect(res.status).toBe(200);
      const task = await waitForTask(group.id, msg.id as string);
      const taskId = task.id as string;
      // 等最终失败(重试计数已用尽):status=failed 且 retryCount=1
      const deadline = Date.now() + 20_000;
      let final: Record<string, unknown> | undefined;
      for (;;) {
        const detail = await getTaskDetail(group.id, taskId);
        if (detail.status === "failed" && detail.retryCount === 1) {
          final = detail;
          break;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `task ${taskId} 未在预期时间内最终失败(当前: ${JSON.stringify(detail.status)}/${detail.retryCount})`,
          );
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      process.env.FAKE_ALWAYS_FAIL = "0";
      expect(final.status).toBe("failed");
      // 首次 queued→failed 即生成 event;重试的重复终态写不产生第二个。
      const ev = await waitForPendingEvent(coordinator.id, taskId);
      expect(ev.task.status).toBe("failed");
      const { events } = await inboxList(coordinator.id);
      expect(events.filter((e) => e.task?.taskId === taskId).length).toBe(1);
    }, 30_000);

    it("取消(停止指令 → cancelled):一个 event", async () => {
      const { coordinator, codebuddy, group } = await setupGroup("path-cancel");
      // 长跑:让任务停留在 running,便于停止指令命中。
      process.env.FAKE_SLEEP_SECS = "20";
      const { res, json: msg } = await postMessage(coordinator.id, group.id, {
        body: "取消路径",
        audience: "participant",
        audienceRef: codebuddy.id,
        callback: { sessionRef: "path-cancel-session" },
      });
      expect(res.status).toBe(200);
      const task = await waitForTask(group.id, msg.id as string);
      const taskId = task.id as string;
      await waitForTaskStatus(group.id, taskId, "running");
      // 协调者发「停止」控制指令 → 运行中任务被置 cancelled。
      const stop = await postMessage(coordinator.id, group.id, {
        body: "停止",
        audience: "broadcast",
      });
      expect(stop.res.status).toBe(200);
      const terminal = await waitForTaskTerminal(group.id, taskId);
      expect(terminal.status).toBe("cancelled");
      const ev = await waitForPendingEvent(coordinator.id, taskId);
      expect(ev.task.status).toBe("cancelled");
      const { events } = await inboxList(coordinator.id);
      expect(events.filter((e) => e.task?.taskId === taskId).length).toBe(1);
    }, 30_000);

    it("task PATCH 回写终态(done):一个 event", async () => {
      const { coordinator, codebuddy, group } = await setupGroup("path-patch");
      // 直接落库一个 queued 任务(dispatcher 存在),由执行器通过 REST PATCH
      // 推进到 done —— 覆盖外部执行器客户端回写终态的路径。
      const { testDb } = await import("./db");
      const { task: taskTable } = await import(
        "@laizhixingxingdeli/database/schema"
      );
      const [created] = await testDb
        .insert(taskTable)
        .values({
          groupId: group.id,
          messageId: crypto.randomUUID(),
          executorParticipantId: codebuddy.id,
          executorKey: "codebuddy",
          status: "queued",
          dispatcherParticipantId: coordinator.id,
          dispatcherSessionId: "patch-session",
          callbackRef: { platform: "codex" },
        })
        .returning();
      const taskId = created.id as string;
      const patch = await app.request(
        `/api/groups/${group.id}/tasks/${taskId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": codebuddy.id,
          },
          body: JSON.stringify({
            status: "done",
            diffSummary: { summary: "PATCH 回写完成", hash: "abc123" },
          }),
        },
      );
      expect(patch.status).toBe(200);
      const ev = await waitForPendingEvent(coordinator.id, taskId);
      expect(ev.task.status).toBe("done");
      expect(ev.task.diffSummary).toEqual({
        summary: "PATCH 回写完成",
        hash: "abc123",
      });
      const { events } = await inboxList(coordinator.id);
      expect(events.filter((e) => e.task?.taskId === taskId).length).toBe(1);
    }, 20_000);
  });

  // ── WS 轻量提示 ──

  describe("WS task_completion_available 帧(仅低延迟提示)", () => {
    beforeAll(async () => {
      server = createServer(app2.fetch as unknown as RequestListener);
      wsHub.handleUpgrade(server);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      for (const ws of openClients) ws.terminate();
      openClients.clear();
      wsHub.closeAll();
      await new Promise<void>((r) => server.close(() => r()));
    });

    async function connectWs(
      participantId: string,
    ): Promise<[WebSocket, Array<Record<string, unknown>>]> {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/api/ws?participantId=${participantId}`,
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("ws open timeout")),
          2000,
        );
        ws.on("open", () => {
          clearTimeout(timer);
          openClients.add(ws);
          resolve();
        });
        ws.on("error", reject);
      });
      const frames: Array<Record<string, unknown>> = [];
      ws.on("message", (data: RawData) => {
        frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
      });
      return [ws, frames];
    }

    it("task 完成且存在 dispatcher 时推送 task_completion_available 帧", async () => {
      const { coordinator, codebuddy, group } = await setupGroup("ws-ce");
      const [, frames] = await connectWs(coordinator.id);
      const { res, json: msg } = await postMessage(coordinator.id, group.id, {
        body: "WS 完成帧测试",
        audience: "participant",
        audienceRef: codebuddy.id,
        callback: { sessionRef: "ws-session" },
      });
      expect(res.status).toBe(200);
      const task = await waitForTask(group.id, msg.id as string);
      const taskId = task.id as string;
      await waitForTaskTerminal(group.id, taskId);
      await waitForPendingEvent(coordinator.id, taskId);
      await waitFor(() =>
        frames.some(
          (f) =>
            f.type === "task_completion_available" && f.taskId === taskId,
        ),
      );
      const frame = frames.find(
        (f) => f.type === "task_completion_available" && f.taskId === taskId,
      );
      expect(frame).toBeDefined();
      expect(frame?.groupId).toBe(group.id);
      expect(frame?.status).toBe("done");
      expect(frame?.dispatcherParticipantId).toBe(coordinator.id);
    }, 30_000);
  });
});
