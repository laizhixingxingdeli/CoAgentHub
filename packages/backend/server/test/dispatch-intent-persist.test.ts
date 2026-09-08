import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  dispatchIntent as dispatchIntentTable,
  executorConfig as executorConfigTable,
  groupMessage as groupMessageTable,
  participant as participantTable,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import {
  __resetExecutorQueueForTests,
  DISPATCH_INTENT_RECLAIM_GRACE_MS,
  findDispatchIntentByMessage,
  payloadFromDispatchInput,
  reclaimDispatchIntents,
  writeDispatchIntent,
} from "@server/lib/executor-task";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DataBase } from "../src/lib/database";
import { seedBuiltinExecutorConfigs, testDb } from "./db";
import { resolveFakeExecutor, withFakeExecutorArgs } from "./fake-executor-bin";

/**
 * specs/persist-dispatch-intent-with-the-message.md
 *
 * 验收:
 *  1. 消息提交成功 → task 创建之间中断 → 恢复后最终得到 task(改前红)
 *  2. 三种拒绝各有记录且意图不悬着
 *  3. 同一意图恢复两次 → 只有一个 task
 *  4. 恢复过检视者守卫
 *  5. 既有派发路径回归(role await / warning / control skip)由本文件 + 既有套件覆盖
 */

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-dispatch-intent-"));
const fakeScript = path.join(fakeDir, "fake-exec.sh");
writeFileSync(
  fakeScript,
  [
    "#!/bin/sh",
    'echo "commit 0123456789abcdef0123456789abcdef01234567"',
    'echo "汇报:完成"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeScript, 0o755);
const { bin: fakeBin, argsPrefix: fakeArgsPrefix } =
  resolveFakeExecutor(fakeScript);
process.env.EXECUTOR_BIN_CODEBUDDY = fakeBin;

const { createTestApp } = await import("./app");

const db = testDb as unknown as DataBase;

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
});

beforeEach(() => {
  __resetExecutorQueueForTests();
});

describe("persist-dispatch-intent-with-the-message", () => {
  const app = createTestApp();

  async function register(name: string) {
    const res = await app.request("/api/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.status === 409) {
      const list = (await (await app.request("/api/participants")).json()) as {
        id: string;
        name: string;
      }[];
      const existing = list.find((p) => p.name === name);
      if (!existing) throw new Error(`409 but no participant named ${name}`);
      return existing;
    }
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; name: string };
  }

  async function createGroup(ownerId: string, title: string) {
    const res = await app.request("/api/groups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": ownerId,
      },
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
  }

  async function addMember(
    ownerId: string,
    groupId: string,
    memberId: string,
    roles: string[],
  ) {
    const res = await app.request(`/api/groups/${groupId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": ownerId,
      },
      body: JSON.stringify({ participantId: memberId, roles }),
    });
    expect(res.status).toBe(200);
  }

  async function setupExecutorGroup(suffix: string) {
    const coordinator = await register(`di-coord-${suffix}`);
    // executor_key UNIQUE: clear any prior holder then bind one participant.
    await testDb
      .update(participantTable)
      .set({ executorKey: null })
      .where(eq(participantTable.executorKey, "codebuddy"));
    const executor = await register(`di-exec-${suffix}`);
    await testDb
      .update(participantTable)
      .set({ executorKey: "codebuddy" })
      .where(eq(participantTable.id, executor.id));
    const group = await createGroup(coordinator.id, `di-group-${suffix}`);
    await addMember(coordinator.id, group.id, executor.id, ["executor"]);
    return { coordinator, executor, group };
  }

  async function postMessage(
    senderId: string,
    groupId: string,
    body: Record<string, unknown>,
  ) {
    const res = await app.request(`/api/groups/${groupId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": senderId,
      },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      warning: res.headers.get("X-CoAgentHub-Warning"),
      json: (await res.json()) as { id: string },
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
      status: string;
    }>;
  }

  /**
   * 验收1 核心:模拟「消息+意图已提交、task 从未创建」的中断窗口,再跑恢复。
   * 改前:没有意图表 / 恢复扫不到 → task 仍不存在(红)。
   * 改后:reclaimDispatchIntents 补建 task。
   */
  it("验收1:消息已提交、task 未创建 → 恢复后最终得到 task", async () => {
    const { coordinator, executor, group } = await setupExecutorGroup("a1");

    // 手工写入消息 + pending 意图,故意不调用 maybeDispatch —— 等价于
    // participant 定向 fire-and-forget 在响应后、task 创建前进程退出。
    const messageId = uuidv4();
    await testDb.insert(groupMessageTable).values({
      id: messageId,
      groupId: group.id,
      senderId: coordinator.id,
      audience: "participant",
      audienceRef: executor.id,
      body: "请执行:中断窗口恢复测试",
      contentType: "text/plain",
    });
    // closure self-row (list paths may not need it; intent FK only needs message)
    const payload = payloadFromDispatchInput({
      groupId: group.id,
      messageId,
      senderRoles: ["coordinator"],
      audience: "participant",
      audienceRef: executor.id,
      body: "请执行:中断窗口恢复测试",
      dispatcherParticipantId: coordinator.id,
      dispatcherSessionId: null,
      selectionReason: null,
      specRef: null,
      specHash: null,
      dispatchKind: null,
      supersedesTaskId: null,
      callbackRef: null,
      initialDiffSummary: null,
    });
    await writeDispatchIntent(db, {
      groupId: group.id,
      messageId,
      audience: "participant",
      audienceRef: executor.id,
      payload,
    });

    // 改前现象:消息在、task 不在、queued-task-reclaim 只扫 status=queued 的 task 行 → 扫不到。
    const tasksBefore = await testDb
      .select()
      .from(taskTable)
      .where(eq(taskTable.messageId, messageId));
    expect(tasksBefore).toHaveLength(0);
    const msg = await testDb.query.groupMessage.findFirst({
      where: (t, { eq: eqFn }) => eqFn(t.id, messageId),
    });
    expect(msg).toBeTruthy();

    // 把意图造旧一点,越过恢复宽限期。
    const old = new Date(Date.now() - DISPATCH_INTENT_RECLAIM_GRACE_MS - 1_000);
    await testDb
      .update(dispatchIntentTable)
      .set({ createdAt: old })
      .where(eq(dispatchIntentTable.messageId, messageId));

    const result = await reclaimDispatchIntents(db);
    expect(result.recovered).toBeGreaterThanOrEqual(1);

    const tasksAfter = await testDb
      .select()
      .from(taskTable)
      .where(eq(taskTable.messageId, messageId));
    expect(tasksAfter).toHaveLength(1);
    expect(tasksAfter[0].executorParticipantId).toBe(executor.id);

    const intent = await findDispatchIntentByMessage(db, messageId);
    expect(intent?.status).toBe("dispatched");
    expect(intent?.taskId).toBe(tasksAfter[0].id);
  });

  it("验收2a:控制指令跳过 → 意图 rejected=control-command-skipped 且不悬着", async () => {
    const { coordinator, executor, group } = await setupExecutorGroup("cskip");
    // 控制指令定向到非 executor-task-target 时跳过派发;对 role 定向必跳过。
    // 用 role:coordinator 发「停止」→ CONTROL_COMMAND_SKIPPED_DISPATCH。
    const res = await postMessage(coordinator.id, group.id, {
      body: "停止",
      audience: "role",
      audienceRef: "coordinator",
    });
    expect(res.status).toBe(200);
    expect(res.warning ?? "").toContain("CONTROL_COMMAND_SKIPPED_DISPATCH");

    const intent = await findDispatchIntentByMessage(db, res.json.id);
    expect(intent).toBeTruthy();
    expect(intent?.status).toBe("rejected");
    expect(intent?.rejectReason).toBe("control-command-skipped");

    const tasks = await listTasks(coordinator.id, group.id);
    expect(tasks.filter((t) => t.messageId === res.json.id)).toHaveLength(0);
  });

  it("验收2b:检视者目标 → 意图 rejected=reviewer-not-dispatchable 且不悬着", async () => {
    const { coordinator, group } = await setupExecutorGroup("rev");
    const reviewer = await register("di-reviewer-2b");
    // reviewer 可同时绑执行器 key;守卫看的是群内 roles,不是 key。
    // 为避免与 executor 争 UNIQUE,这里用 reasonix key。
    await testDb
      .update(participantTable)
      .set({ executorKey: null })
      .where(eq(participantTable.executorKey, "reasonix"));
    await testDb
      .update(participantTable)
      .set({ executorKey: "reasonix" })
      .where(eq(participantTable.id, reviewer.id));
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);

    const res = await postMessage(coordinator.id, group.id, {
      body: "请检视这段",
      audience: "participant",
      audienceRef: reviewer.id,
    });
    expect(res.status).toBe(200);
    expect(res.warning ?? "").toContain("REVIEWER_TARGET_NOT_DISPATCHABLE");

    const intent = await findDispatchIntentByMessage(db, res.json.id);
    expect(intent?.status).toBe("rejected");
    expect(intent?.rejectReason).toBe("reviewer-not-dispatchable");
    const tasks = await listTasks(coordinator.id, group.id);
    expect(tasks.filter((t) => t.messageId === res.json.id)).toHaveLength(0);
  });

  it("验收2c:角色无匹配 → 意图 rejected=role-unresolved:* 且不悬着", async () => {
    const { coordinator, group } = await setupExecutorGroup("role-miss");
    // 本群没有 observer 角色成员 → role-no-member
    const res = await postMessage(coordinator.id, group.id, {
      body: "请 observer 处理",
      audience: "role",
      audienceRef: "observer",
    });
    expect(res.status).toBe(200);
    expect(res.warning ?? "").toMatch(/ROLE_UNRESOLVED:observer:role-no-member/);

    const intent = await findDispatchIntentByMessage(db, res.json.id);
    expect(intent?.status).toBe("rejected");
    expect(intent?.rejectReason).toBe("role-unresolved:role-no-member");
    const tasks = await listTasks(coordinator.id, group.id);
    expect(tasks.filter((t) => t.messageId === res.json.id)).toHaveLength(0);
  });

  it("验收3:同一意图被恢复器处理两次 → 只有一个 task", async () => {
    const { coordinator, executor, group } = await setupExecutorGroup("idem");
    const messageId = uuidv4();
    await testDb.insert(groupMessageTable).values({
      id: messageId,
      groupId: group.id,
      senderId: coordinator.id,
      audience: "participant",
      audienceRef: executor.id,
      body: "幂等恢复",
      contentType: "text/plain",
    });
    await writeDispatchIntent(db, {
      groupId: group.id,
      messageId,
      audience: "participant",
      audienceRef: executor.id,
      payload: payloadFromDispatchInput({
        groupId: group.id,
        messageId,
        senderRoles: ["coordinator"],
        audience: "participant",
        audienceRef: executor.id,
        body: "幂等恢复",
        dispatcherParticipantId: coordinator.id,
        dispatcherSessionId: null,
        selectionReason: null,
        specRef: null,
        specHash: null,
        dispatchKind: null,
        supersedesTaskId: null,
        callbackRef: null,
        initialDiffSummary: null,
      }),
    });
    const old = new Date(Date.now() - DISPATCH_INTENT_RECLAIM_GRACE_MS - 1_000);
    await testDb
      .update(dispatchIntentTable)
      .set({ createdAt: old })
      .where(eq(dispatchIntentTable.messageId, messageId));

    await reclaimDispatchIntents(db);
    await reclaimDispatchIntents(db);

    const tasks = await testDb
      .select()
      .from(taskTable)
      .where(eq(taskTable.messageId, messageId));
    expect(tasks).toHaveLength(1);
  });

  it("验收4:恢复时目标是 reviewer → 不建 task,意图 rejected", async () => {
    const { coordinator, group } = await setupExecutorGroup("rec-rev");
    const reviewer = await register("di-reviewer-rec");
    // 即便有执行器配置,群内角色含 reviewer → 不可派。
    await testDb
      .update(participantTable)
      .set({ executorKey: null })
      .where(eq(participantTable.executorKey, "reasonix"));
    await testDb
      .update(participantTable)
      .set({ executorKey: "reasonix" })
      .where(eq(participantTable.id, reviewer.id));
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);

    // 模拟「消息层守卫尚未落地时写下的 pending 意图」——恢复必须再过守卫。
    const messageId = uuidv4();
    await testDb.insert(groupMessageTable).values({
      id: messageId,
      groupId: group.id,
      senderId: coordinator.id,
      audience: "participant",
      audienceRef: reviewer.id,
      body: "误派给检视者",
      contentType: "text/plain",
    });
    await writeDispatchIntent(db, {
      groupId: group.id,
      messageId,
      audience: "participant",
      audienceRef: reviewer.id,
      payload: payloadFromDispatchInput({
        groupId: group.id,
        messageId,
        senderRoles: ["coordinator"],
        audience: "participant",
        audienceRef: reviewer.id,
        body: "误派给检视者",
        dispatcherParticipantId: coordinator.id,
        dispatcherSessionId: null,
        selectionReason: null,
        specRef: null,
        specHash: null,
        dispatchKind: null,
        supersedesTaskId: null,
        callbackRef: null,
        initialDiffSummary: null,
      }),
    });
    const old = new Date(Date.now() - DISPATCH_INTENT_RECLAIM_GRACE_MS - 1_000);
    await testDb
      .update(dispatchIntentTable)
      .set({ createdAt: old })
      .where(eq(dispatchIntentTable.messageId, messageId));

    const result = await reclaimDispatchIntents(db);
    expect(result.rejected).toBeGreaterThanOrEqual(1);

    const tasks = await testDb
      .select()
      .from(taskTable)
      .where(eq(taskTable.messageId, messageId));
    expect(tasks).toHaveLength(0);

    const intent = await findDispatchIntentByMessage(db, messageId);
    expect(intent?.status).toBe("rejected");
    expect(intent?.rejectReason).toBe("reviewer-not-dispatchable");
  });

  it("验收5回归:participant 定向成功路径最终 dispatched + 有 task", async () => {
    const { coordinator, executor, group } =
      await setupExecutorGroup("live-ok");
    const res = await postMessage(coordinator.id, group.id, {
      body: "请执行 live 路径",
      audience: "participant",
      audienceRef: executor.id,
    });
    expect(res.status).toBe(200);

    // fire-and-forget:等意图结算
    const deadline = Date.now() + 8_000;
    let intent = await findDispatchIntentByMessage(db, res.json.id);
    while (
      intent &&
      intent.status === "pending" &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 50));
      intent = await findDispatchIntentByMessage(db, res.json.id);
    }
    expect(intent?.status).toBe("dispatched");
    const tasks = await listTasks(coordinator.id, group.id);
    expect(tasks.some((t) => t.messageId === res.json.id)).toBe(true);
  });

  it("live 路径写入意图与消息同在(有意图行)", async () => {
    const { coordinator, executor, group } =
      await setupExecutorGroup("has-intent");
    const res = await postMessage(coordinator.id, group.id, {
      body: "只要有意图",
      audience: "participant",
      audienceRef: executor.id,
    });
    expect(res.status).toBe(200);
    const intent = await findDispatchIntentByMessage(db, res.json.id);
    expect(intent).toBeTruthy();
    expect(intent?.groupId).toBe(group.id);
    expect(["pending", "dispatched", "failed", "rejected"]).toContain(
      intent?.status,
    );
  });
});
