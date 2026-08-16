import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Part A(任务下发者信息记录与透传):POST /groups/:id/messages 接受
 * metadata.dispatcherSessionId(仅 coordinator/human 且非执行器 participant 可
 * 携带),随「消息 → task」链路写入 task.dispatcher_participant_id /
 * dispatcher_session_id,REST 任务列表/详情透传;消息本体与任务书 body 绝不暴露
 * session 元数据。
 *
 * 覆盖:正常下发 / 不传 metadata / 执行器伪造 metadata / 非 coordinator 发送者
 * 携带 metadata / 超长拒绝(400) / 不依赖 body 解析 / 任务书干净 / 老任务
 * 字段为 null / 消息持久化不暴露。
 *
 * 用 fake bin 驱动真实执行器管线(EXECUTOR_BIN_CODEBUDDY),任务行创建即
 * 断言 dispatcher 字段,不依赖任务完成。
 */

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-dispatch-bin-"));
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

// 顶层 await 动态 import:env 设置先于模块求值。
const { createTestApp } = await import("./app");
const { __resetExecutorQueueForTests } = await import(
  "../src/lib/executor-task"
);

const app = createTestApp();

afterAll(async () => {
  // 任务创建即返回,spawn/完成在后台异步进行:等待队列清空(所有后台任务已
  // 落定、完成路径的 DB 写已结束),避免文件结束时残留任务写已关闭的 PGlite
  // 产生未处理拒绝(setup.ts 的 afterAll 在文件级 afterAll 之后才关闭连接)。
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

describe("任务下发者信息(Part A):metadata.dispatcherSessionId 记录与透传", () => {
  beforeEach(() => {
    // 清空模块级队列,避免上一个用例残留的 running/queued 影响后续断言。
    __resetExecutorQueueForTests();
  });
  async function registerParticipant(body: Record<string, unknown>) {
    const res = await app.request("/api/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // 名字唯一(0013):同名已注册时服务端返回 409,复用现有 participant。
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

  async function listMessages(participantId: string, groupId: string) {
    const res = await app.request(`/api/groups/${groupId}/messages`, {
      headers: { "X-Participant-Id": participantId },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Array<Record<string, unknown>>;
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

  /** coordinator + CodeBuddy 执行器成员就绪。 */
  async function setupGroup(title: string) {
    const coordinator = await registerParticipant({ name: `coord-${title}` });
    const codebuddy = await registerParticipant({ name: "CodeBuddy 执行器" });
    const group = await createGroup(coordinator.id, title);
    await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
    return { coordinator, codebuddy, group };
  }

  it("正常下发:metadata.dispatcherSessionId 写入 task,participant 从 sender 写入", async () => {
    const { coordinator, codebuddy, group } = await setupGroup("下发者 A");
    const { res, json } = await postMessage(coordinator.id, group.id, {
      body: "带下发者信息的任务",
      audience: "participant",
      audienceRef: codebuddy.id,
      metadata: { dispatcherSessionId: "session-abc" },
    });
    expect(res.status).toBe(200);
    const task = await waitForTask(group.id, json.id as string);
    expect(task.dispatcherParticipantId).toBe(coordinator.id);
    expect(task.dispatcherSessionId).toBe("session-abc");
    // 任务书 body 保持干净:不含任何 session 元数据(注入断言)。
    expect(task.brief).toBe("带下发者信息的任务");
  }, 15_000);

  it("不传 metadata:dispatcher_session_id 为 null;participant 仍从 sender 记录", async () => {
    const { coordinator, codebuddy, group } = await setupGroup("下发者 B");
    const { res, json } = await postMessage(coordinator.id, group.id, {
      body: "无 metadata 的任务",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    expect(res.status).toBe(200);
    const task = await waitForTask(group.id, json.id as string);
    // 数据流固定:dispatcher_participant_id = sender(服务端识别);未带 metadata
    // 时 dispatcher_session_id 为 null(老客户端/未携带兼容)。
    expect(task.dispatcherParticipantId).toBe(coordinator.id);
    expect(task.dispatcherSessionId).toBeNull();
  }, 15_000);

  it("执行器伪造 metadata:不写入(即便执行器持有 coordinator 角色)", async () => {
    const { coordinator, codebuddy, group } = await setupGroup("下发者 C");
    // 给执行器 participant 加 coordinator 角色:角色门槛放行,但「执行器发送的
    // 消息即使带 metadata 也忽略」仍必须拦截。
    await addMember(coordinator.id, group.id, codebuddy.id, [
      "coordinator",
      "executor",
    ]);
    const { res, json } = await postMessage(codebuddy.id, group.id, {
      body: "执行器伪造 metadata",
      audience: "participant",
      audienceRef: codebuddy.id,
      metadata: { dispatcherSessionId: "forged-session" },
    });
    expect(res.status).toBe(200);
    const task = await waitForTask(group.id, json.id as string);
    // 不写入:sessionId 为 null(伪造被忽略);participant 仍是服务端识别的
    // sender(执行器自己),不会被请求体伪造。
    expect(task.dispatcherSessionId).toBeNull();
    expect(task.dispatcherParticipantId).toBe(codebuddy.id);
  }, 15_000);

  it("coordinator/human 之外的发送者带 metadata:忽略(消息正常,不暴露)", async () => {
    const { coordinator, group } = await setupGroup("下发者 D");
    // 普通成员(observer):广播消息带 metadata → 消息创建成功,metadata 被忽略。
    const observer = await registerParticipant({ name: "observer-dispatch" });
    await addMember(coordinator.id, group.id, observer.id, ["observer"]);
    const { res, json } = await postMessage(observer.id, group.id, {
      body: "普通成员的广播",
      audience: "broadcast",
      metadata: { dispatcherSessionId: "observer-session" },
    });
    expect(res.status).toBe(200);
    // 消息响应/持久化均不含 dispatcherSessionId。
    expect(json.dispatcherSessionId).toBeUndefined();
    expect(json.metadata).toBeUndefined();
    const messages = await listMessages(observer.id, group.id);
    const stored = messages.find((m) => m.id === json.id);
    expect(stored).toBeDefined();
    expect(stored?.dispatcherSessionId).toBeUndefined();
    expect(stored?.metadata).toBeUndefined();
  }, 15_000);

  it("dispatcherSessionId 超过 200 字符:拒绝(400)", async () => {
    const { coordinator, codebuddy, group } = await setupGroup("下发者 E");
    const { res } = await postMessage(coordinator.id, group.id, {
      body: "超长 sessionId",
      audience: "participant",
      audienceRef: codebuddy.id,
      metadata: { dispatcherSessionId: "x".repeat(201) },
    });
    expect(res.status).toBe(400);
  }, 15_000);

  it("消息 → task 链路:metadata 不丢失且不依赖 body 解析", async () => {
    const { coordinator, codebuddy, group } = await setupGroup("下发者 F");
    // body 里出现 session 字样,但真正来源是 metadata(禁止从 body 解析)。
    const { res, json } = await postMessage(coordinator.id, group.id, {
      body: "任务书正文提到 dispatcherSessionId=session-from-body,但应忽略",
      audience: "participant",
      audienceRef: codebuddy.id,
      metadata: { dispatcherSessionId: "session-from-metadata" },
    });
    expect(res.status).toBe(200);
    const task = await waitForTask(group.id, json.id as string);
    expect(task.dispatcherSessionId).toBe("session-from-metadata");
    // 任务书 = body 原文(服务端不注入任何 session 元数据)。
    expect(task.brief).toBe(
      "任务书正文提到 dispatcherSessionId=session-from-body,但应忽略",
    );
  }, 15_000);

  it("REST 任务列表/详情返回两个字段;老任务(直接落库)两个字段为 null", async () => {
    const { coordinator, codebuddy, group } = await setupGroup("下发者 G");
    // 新任务:带 metadata。
    const { json } = await postMessage(coordinator.id, group.id, {
      body: "REST 透传任务",
      audience: "participant",
      audienceRef: codebuddy.id,
      metadata: { dispatcherSessionId: "session-rest" },
    });
    const task = await waitForTask(group.id, json.id as string);
    // 列表返回两个字段。
    const tasks = await listTasks(group.id);
    const listed = tasks.find((t) => t.id === task.id);
    expect(listed?.dispatcherParticipantId).toBe(coordinator.id);
    expect(listed?.dispatcherSessionId).toBe("session-rest");
    // 详情返回两个字段。
    const detail = await getTaskDetail(group.id, task.id as string);
    expect(detail.dispatcherParticipantId).toBe(coordinator.id);
    expect(detail.dispatcherSessionId).toBe("session-rest");

    // 老任务(直接落库,无 dispatcher 列值):列表/详情两个字段为 null。
    const { testDb } = await import("./db");
    const { task: taskTable } = await import(
      "@laizhixingxingdeli/database/schema"
    );
    const oldMessageId = "00000000-0000-7000-8000-0000000000b1";
    await testDb.insert(taskTable).values({
      groupId: group.id,
      messageId: oldMessageId,
      executorParticipantId: codebuddy.id,
      executorKey: "codebuddy",
      status: "done",
      brief: "老任务",
    });
    const oldTasks = await listTasks(group.id);
    const old = oldTasks.find((t) => t.messageId === oldMessageId);
    expect(old).toBeDefined();
    expect(old?.dispatcherParticipantId).toBeNull();
    expect(old?.dispatcherSessionId).toBeNull();
    const oldDetail = await getTaskDetail(group.id, old?.id as string);
    expect(oldDetail.dispatcherParticipantId).toBeNull();
    expect(oldDetail.dispatcherSessionId).toBeNull();
  }, 15_000);
});
