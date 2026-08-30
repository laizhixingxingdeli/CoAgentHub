import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedBuiltinExecutorConfigs } from "./db";

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
process.env.EXECUTOR_BIN_EXECUTOR = fakeBin;

// 顶层 await 动态 import:env 设置先于模块求值。
const { createTestApp } = await import("./app");

const app = createTestApp();

afterAll(async () => {
  // 任务创建即返回,spawn/完成在后台异步进行:等待队列清空 + DB 无 queued/
  // running 任务(「已出队未 spawn」窗口的任务 currentRunningTask 捕获不到,
  // 只查内存队列会漏),避免文件结束时残留任务写已关闭的 PGlite / 已删除的
  // 仓库产生未处理拒绝(setup.ts 的 afterAll 在文件级 afterAll 之后才关闭)。
  const { currentRunningTask, queuedExecutorTaskCount } = await import(
    "../src/lib/executor-task"
  );
  const { testDb } = await import("./db");
  const { task: taskTable } = await import(
    "@laizhixingxingdeli/database/schema"
  );
  const { inArray } = await import("drizzle-orm");
  const deadline = Date.now() + 20_000;
  for (;;) {
    const inMemBusy =
      currentRunningTask() !== null || queuedExecutorTaskCount() > 0;
    let dbBusy = 0;
    try {
      const rows = await testDb
        .select({ id: taskTable.id })
        .from(taskTable)
        .where(inArray(taskTable.status, ["queued", "running"]));
      dbBusy = rows.length;
    } catch {
      dbBusy = 0; // DB 已关闭(极端竞态):按无残留处理,避免死等。
    }
    if (!inMemBusy && dbBusy === 0) break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  rmSync(fakeDir, { recursive: true, force: true });
});

beforeAll(async () => {
  await seedBuiltinExecutorConfigs();
});

describe("任务下发者信息(Part A):metadata.dispatcherSessionId 记录与透传", () => {
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

  /** coordinator + CodeBuddy 成员就绪。 */
  async function setupGroup(title: string) {
    const coordinator = await registerParticipant({ name: `coord-${title}` });
    const codebuddy = await registerParticipant({ name: "CodeBuddy" });
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

  it("行为验证 1:coordinator 角色 participant 即便同时命中执行器配置,dispatcher/callback 仍保留(spec R3)", async () => {
    const { coordinator, codebuddy, group } = await setupGroup("下发者 C");
    const atomcode = await registerParticipant({ name: "AtomCode" });
    await addMember(coordinator.id, group.id, atomcode.id, ["executor"]);
    // codebuddy 命中执行器配置,但同时持有 coordinator 角色:下发权只由群内角色
    // 裁定(spec R3 / ADR-0008 第三条),不再被 canDispatch 全局否决——其携带的
    // dispatcher/callback 路由信息保留。
    await addMember(coordinator.id, group.id, codebuddy.id, ["coordinator"]);
    const { res, json } = await postMessage(codebuddy.id, group.id, {
      body: "coordinator 角色执行器 participant 下发",
      audience: "participant",
      audienceRef: atomcode.id,
      metadata: { dispatcherSessionId: "coord-session" },
      callback: { platform: "codex", sessionRef: "coord-session" },
    });
    expect(res.status).toBe(200);
    // 保留:dispatcher/callback 全部写入(不产生剥离警告)。
    const warning = res.headers.get("X-CoAgentHub-Warning");
    expect(warning ?? "").not.toContain("CALLBACK_STRIPPED_NOT_AUTHORIZED");
    const task = await waitForTask(group.id, json.id as string);
    expect(task.dispatcherSessionId).toBe("coord-session");
    expect(task.callbackRef).toEqual({
      platform: "codex",
      sessionRef: "coord-session",
    });
    expect(task.dispatcherParticipantId).toBe(codebuddy.id);
  }, 15_000);

  it("行为验证 2:仅 executor 角色 participant 的 dispatcher/callback 仍剥离,并产生 CALLBACK_STRIPPED_NOT_AUTHORIZED(spec R3)", async () => {
    const { coordinator, codebuddy, group } = await setupGroup("下发者 C2");
    // 目标必须是**非执行器** participant:定向到执行器 participant 的消息会先被
    // 路由层 403 发布门槛拦截(任务发布门槛,非 coordinator/human 直接 403),
    // 剥离逻辑只对能通过门槛的消息生效。
    const peer = await registerParticipant({ name: "C2-peer" });
    await addMember(coordinator.id, group.id, peer.id, ["coordinator"]);
    // codebuddy 仅持 executor 角色(不在 DISPATCH_ALLOWED_ROLES):同类路由信息被剥离。
    const { res, json } = await postMessage(codebuddy.id, group.id, {
      body: "纯执行器下发(应被剥离)",
      audience: "participant",
      audienceRef: peer.id,
      metadata: { dispatcherSessionId: "forged-session" },
      callback: { platform: "codex", sessionRef: "forged-session" },
    });
    expect(res.status).toBe(200);
    // 剥离信号:警告头携带 CALLBACK_STRIPPED_NOT_AUTHORIZED。
    const warning = res.headers.get("X-CoAgentHub-Warning");
    expect(warning ?? "").toContain("CALLBACK_STRIPPED_NOT_AUTHORIZED");
    // 消息本身不含 dispatcherSessionId / metadata(伪造不落库)。
    expect(json.dispatcherSessionId).toBeUndefined();
    expect(json.metadata).toBeUndefined();
    // 无任务:纯执行器发送者无下发权,maybeDispatchExecutorTask 直接跳过。
    await new Promise((r) => setTimeout(r, 500));
    const tasks = await listTasks(group.id);
    expect(tasks.some((t) => t.messageId === json.id)).toBe(false);
  }, 15_000);

  it("reviewer participant(coordinator 角色)可携带 dispatcher/callback(spec R3:下发权由群内角色裁定)", async () => {
    // R3 后 reviewer 不再对应执行器配置(0028 不 seed);其 participant 持
    // coordinator 角色即有权下发并携带 callbackRef——下发权只看群内角色,
    // 不再依赖 canDispatch 全局标记。
    const reviewer = await registerParticipant({ name: "Reviewer" });
    const { coordinator, codebuddy, group } = await setupGroup("下发者 R");
    await addMember(coordinator.id, group.id, reviewer.id, ["coordinator"]);
    const { res, json } = await postMessage(reviewer.id, group.id, {
      body: "检视者下发任务",
      audience: "participant",
      audienceRef: codebuddy.id,
      metadata: { dispatcherSessionId: "reviewer-session" },
      callback: { platform: "codex", sessionRef: "reviewer-session" },
    });
    expect(res.status).toBe(200);
    const task = await waitForTask(group.id, json.id as string);
    expect(task.dispatcherSessionId).toBe("reviewer-session");
    expect(task.callbackRef).toEqual({
      platform: "codex",
      sessionRef: "reviewer-session",
    });
    expect(task.dispatcherParticipantId).toBe(reviewer.id);
  }, 15_000);

  it("行为验证 3:定向 reviewer participant 不创建 task,走普通消息路径(spec R3)", async () => {
    const { coordinator, group } = await setupGroup("下发者 R3");
    const reviewer = await registerParticipant({ name: "R3-reviewer" });
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
    const { res, json } = await postMessage(coordinator.id, group.id, {
      body: "给检视者的普通消息",
      audience: "participant",
      audienceRef: reviewer.id,
    });
    expect(res.status).toBe(200);
    // isExecutorTarget 为假:reviewer 不对应执行器配置 → 不创建 task。
    await new Promise((r) => setTimeout(r, 500));
    const tasks = await listTasks(group.id);
    expect(tasks.some((t) => t.messageId === json.id)).toBe(false);
    // 走普通消息路径:reviewer 可见该定向消息。
    const reviewerSeen = await listMessages(reviewer.id, group.id);
    expect(reviewerSeen.some((m) => m.id === json.id)).toBe(true);
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
