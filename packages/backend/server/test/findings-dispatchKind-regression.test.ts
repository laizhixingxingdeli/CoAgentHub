import { task as taskTable } from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./app";
import { seedBuiltinExecutorConfigs, testDb } from "./db";

beforeAll(async () => {
  await seedBuiltinExecutorConfigs();
});

describe("findings 驱动 dispatchKind 裁定回归 (spec findings-ticket-hardcoded-to-fix-bypasses-l3)", () => {
  const app = createTestApp();
  let sharedCoordinator: { id: string };
  beforeAll(async () => {
    sharedCoordinator = await register(`fdk-shared-coord-${Date.now()}`);
    await bindExecutor(sharedCoordinator.id, "executor");
  });

  async function register(name: string) {
    const res = await app.request("/api/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.status === 409) {
      const list = (await (await app.request("/api/participants")).json()) as { id: string; name: string }[];
      const existing = list.find((p) => p.name === name);
      if (existing) return { id: existing.id };
    }
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
  }

  async function createGroup(ownerId: string, title: string) {
    const res = await app.request("/api/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Participant-Id": ownerId },
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
  }

  async function addMember(groupId: string, callerId: string, memberId: string, roles: string[]) {
    const res = await app.request(`/api/groups/${groupId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Participant-Id": callerId },
      body: JSON.stringify({ participantId: memberId, roles }),
    });
    expect(res.status).toBe(200);
  }

  async function bindExecutor(participantId: string, key: string) {
    const { participant: participantTable } = await import("@laizhixingxingdeli/database/schema");
    await testDb.update(participantTable).set({ executorKey: key }).where(eq(participantTable.id, participantId));
  }

  async function postMessage(senderId: string, groupId: string, body: Record<string, unknown>) {
    return app.request(`/api/groups/${groupId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Participant-Id": senderId },
      body: JSON.stringify(body),
    });
  }

  async function waitForTask(messageId: string, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [row] = await testDb.select().from(taskTable).where(eq(taskTable.messageId, messageId));
      if (row) return row;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`task for message ${messageId} not found within ${timeoutMs}ms`);
  }

  // helper to create an anchor task for findings review_result taskId reference
  async function createAnchorTask(groupId: string, messageId: string, executorParticipantId: string) {
    const [row] = await testDb.insert(taskTable).values({ groupId, messageId, executorParticipantId, status: "queued" }).returning({ id: taskTable.id });
    return row;
  }

  it("验收1: findings + 显式 requirement → 落库 requirement", async () => {
    const coordinator = sharedCoordinator;
    const reviewer = await register(`fdk-reviewer-1-${Date.now()}-${Math.random()}`);
    const group = await createGroup(coordinator.id, "fdk-1");
    await addMember(group.id, coordinator.id, reviewer.id, ["reviewer"]);
    const anchorMsg = await postMessage(coordinator.id, group.id, { body: "anchor" });
    const anchor = (await anchorMsg.json()) as { id: string };
    const anchorTask = await createAnchorTask(group.id, anchor.id, coordinator.id);

    const res = await postMessage(reviewer.id, group.id, {
      body: JSON.stringify({ type: "review_result", layer: 3, taskId: anchorTask.id, verdict: "findings", findings: [{ severity: "high", note: "需改 spec" }] }),
      audience: "role",
      audienceRef: "coordinator",
      specRef: "specs/x.md",
      specHash: "abc123",
      dispatchKind: "requirement",
    });
    expect(res.status).toBe(200);
    const msg = (await res.json()) as { id: string };
    const task = await waitForTask(msg.id);
    expect(task.dispatchKind).toBe("requirement");
    // 显式值不应有缺省留痕
    const summary = task.diffSummary as Record<string, unknown> | null;
    expect(summary?.dispatchKindNote).toBeUndefined();
  });

  it("验收2: findings + 不带 dispatchKind → 落库 fix 且有缺省留痕(R2)", async () => {
    const coordinator = sharedCoordinator;
    const reviewer = await register(`fdk-reviewer-2-${Date.now()}-${Math.random()}`);
    const group = await createGroup(coordinator.id, "fdk-2");
    await addMember(group.id, coordinator.id, reviewer.id, ["reviewer"]);
    const anchorMsg = await postMessage(coordinator.id, group.id, { body: "anchor2" });
    const anchor = (await anchorMsg.json()) as { id: string };
    const anchorTask = await createAnchorTask(group.id, anchor.id, coordinator.id);

    const res = await postMessage(reviewer.id, group.id, {
      body: JSON.stringify({ type: "review_result", layer: 3, taskId: anchorTask.id, verdict: "findings", findings: [{ severity: "high", note: "小修" }] }),
      audience: "role",
      audienceRef: "coordinator",
      specRef: "specs/y.md",
      specHash: "def456",
    });
    expect(res.status).toBe(200);
    const msg = (await res.json()) as { id: string };
    const task = await waitForTask(msg.id);
    expect(task.dispatchKind).toBe("fix");
    const summary = task.diffSummary as Record<string, unknown> | null;
    expect(summary?.dispatchKindNote).toBe("dispatchKind 由 findings 缺省推定为 fix,未由检视者显式指定");
  });

  it("验收3: findings + 显式 fix → fix 且无缺省留痕", async () => {
    const coordinator = sharedCoordinator;
    const reviewer = await register(`fdk-reviewer-3-${Date.now()}-${Math.random()}`);
    const group = await createGroup(coordinator.id, "fdk-3");
    await addMember(group.id, coordinator.id, reviewer.id, ["reviewer"]);
    const anchorMsg = await postMessage(coordinator.id, group.id, { body: "anchor3" });
    const anchor = (await anchorMsg.json()) as { id: string };
    const anchorTask = await createAnchorTask(group.id, anchor.id, coordinator.id);

    const res = await postMessage(reviewer.id, group.id, {
      body: JSON.stringify({ type: "review_result", layer: 3, taskId: anchorTask.id, verdict: "findings", findings: [{ severity: "low", note: "小修" }] }),
      audience: "role",
      audienceRef: "coordinator",
      specRef: "specs/z.md",
      specHash: "ghi789",
      dispatchKind: "fix",
    });
    expect(res.status).toBe(200);
    const msg = (await res.json()) as { id: string };
    const task = await waitForTask(msg.id);
    expect(task.dispatchKind).toBe("fix");
    const summary = task.diffSummary as Record<string, unknown> | null;
    expect(summary?.dispatchKindNote).toBeUndefined();
  });

  it("验收4: 非 findings 消息 dispatchKind 逐字不变", async () => {
    const coordinator = sharedCoordinator;
    const reviewer = await register(`fdk-reviewer-4-${Date.now()}-${Math.random()}`);
    const group = await createGroup(coordinator.id, "fdk-4");
    await addMember(group.id, coordinator.id, reviewer.id, ["reviewer"]);

    // 非 findings 但带 requirement → requirement
    const res1 = await postMessage(reviewer.id, group.id, {
      body: "普通需求",
      audience: "participant",
      audienceRef: coordinator.id,
      specRef: "specs/normal.md",
      specHash: "norm1",
      dispatchKind: "requirement",
    });
    expect(res1.status).toBe(200);
    const msg1 = (await res1.json()) as { id: string };
    const task1 = await waitForTask(msg1.id);
    expect(task1.dispatchKind).toBe("requirement");

    // 非 findings 不带 → null
    const res2 = await postMessage(reviewer.id, group.id, {
      body: "普通无指定",
      audience: "participant",
      audienceRef: coordinator.id,
      specRef: "specs/normal2.md",
      specHash: "norm2",
    });
    expect(res2.status).toBe(200);
    const msg2 = (await res2.json()) as { id: string };
    const task2 = await waitForTask(msg2.id);
    expect(task2.dispatchKind).toBeNull();

    // 非 findings 带 fix → fix
    const res3 = await postMessage(reviewer.id, group.id, {
      body: "普通修复",
      audience: "participant",
      audienceRef: coordinator.id,
      dispatchKind: "fix",
    });
    expect(res3.status).toBe(200);
    const msg3 = (await res3.json()) as { id: string };
    const task3 = await waitForTask(msg3.id);
    expect(task3.dispatchKind).toBe("fix");
  });

  it("验收2-生命周期: findings 缺省 fix 进入终态后仍保留 dispatchKindNote", async () => {
    const coordinator = sharedCoordinator;
    const reviewer = await register(`fdk-reviewer-lc-${Date.now()}-${Math.random()}`);
    const group = await createGroup(coordinator.id, "fdk-lc");
    await addMember(group.id, coordinator.id, reviewer.id, ["reviewer"]);
    const anchorMsg = await postMessage(coordinator.id, group.id, { body: "anchor-lc" });
    const anchor = (await anchorMsg.json()) as { id: string };
    const anchorTask = await createAnchorTask(group.id, anchor.id, coordinator.id);

    const res = await postMessage(reviewer.id, group.id, {
      body: JSON.stringify({ type: "review_result", layer: 3, taskId: anchorTask.id, verdict: "findings", findings: [{ severity: "high", note: "小修" }] }),
      audience: "role",
      audienceRef: "coordinator",
      specRef: "specs/lc.md",
      specHash: "lcccc",
    });
    expect(res.status).toBe(200);
    const msg = (await res.json()) as { id: string };
    const task = await waitForTask(msg.id);
    expect(task.dispatchKind).toBe("fix");
    expect((task.diffSummary as Record<string, unknown> | null)?.dispatchKindNote).toBe("dispatchKind 由 findings 缺省推定为 fix,未由检视者显式指定");

    // 推进到终态:executor (coordinator) PATCH 为 failed，需带 error
    const patchRes = await app.request(`/api/groups/${group.id}/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Participant-Id": coordinator.id },
      body: JSON.stringify({ status: "failed", diffSummary: { error: "lifecycle test failure" } }),
    });
    expect(patchRes.status).toBe(200);
    const [after] = await testDb.select().from(taskTable).where(eq(taskTable.id, task.id));
    expect(after.dispatchKind).toBe("fix");
    expect((after.diffSummary as Record<string, unknown> | null)?.dispatchKindNote).toBe("dispatchKind 由 findings 缺省推定为 fix,未由检视者显式指定");
    expect((after.diffSummary as Record<string, unknown> | null)?.error).toBe("lifecycle test failure");
    expect(after.status).toBe("failed");
  });

  it("验收5: PATCH 不能覆盖已落库 dispatchKind(R3)", async () => {
    const coordinator = sharedCoordinator;
    const reviewer = await register(`fdk-reviewer-5-${Date.now()}-${Math.random()}`);
    const group = await createGroup(coordinator.id, "fdk-5");
    await addMember(group.id, coordinator.id, reviewer.id, ["reviewer"]);
    const anchorMsg = await postMessage(coordinator.id, group.id, { body: "anchor5" });
    const anchor = (await anchorMsg.json()) as { id: string };
    const anchorTask = await createAnchorTask(group.id, anchor.id, coordinator.id);

    const res = await postMessage(reviewer.id, group.id, {
      body: JSON.stringify({ type: "review_result", layer: 3, taskId: anchorTask.id, verdict: "findings", findings: [{ severity: "high", note: "需改 spec" }] }),
      audience: "role",
      audienceRef: "coordinator",
      specRef: "specs/w.md",
      specHash: "jkl012",
      dispatchKind: "requirement",
    });
    expect(res.status).toBe(200);
    const msg = (await res.json()) as { id: string };
    const task = await waitForTask(msg.id);
    expect(task.dispatchKind).toBe("requirement");

    // 协调者试图 PATCH 改为 fix，应被忽略
    const patchRes = await app.request(`/api/groups/${group.id}/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Participant-Id": coordinator.id },
      body: JSON.stringify({ brief: "尝试改写", dispatchKind: "fix" }),
    });
    // brief 修改可能成功(若任务仍 queued)或 409，但 dispatchKind 必须不变
    // 若 PATCH 因状态限制失败，仍验证库中值未变
    const [after] = await testDb.select().from(taskTable).where(eq(taskTable.id, task.id));
    expect(after.dispatchKind).toBe("requirement");
  });
});
