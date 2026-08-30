import { randomUUID } from "node:crypto";
import { task as taskTable } from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./app";
import { testDb } from "./db";

/**
 * L3 请求按 spec 去重(specs/l3-is-per-spec-not-per-task.md R1-R4):
 *
 * - R1:同 specRef+specHash 已存在未应答请求时,再次结案不新增第二条请求,
 *   新的 L2 结论并入既有请求(属主 review_request.diffSummary 追加文本);
 * - R2:上一条匹配请求已应答 → 允许新建请求;
 * - R3:续跑任务(diffSummary.platform.resumeOf 非空)并入父任务请求,不新起一条;
 * - R4:一次裁决使参与合并的全部任务 l3.answered = true;
 * - R5:§4.1 布尔(shouldWalkL3)与 review_request 载荷结构不变(回归)。
 */

describe("L3 请求按 spec 去重 (R1-R4)", () => {
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
      if (existing) return { id: existing.id };
    }
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
  }

  async function createGroup(coordinatorId: string, title: string) {
    const res = await app.request("/api/groups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinatorId,
      },
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
  }

  async function addMember(
    actorId: string,
    groupId: string,
    participantId: string,
    roles: string[],
  ) {
    const res = await app.request(`/api/groups/${groupId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": actorId,
      },
      body: JSON.stringify({ participantId, roles }),
    });
    expect(res.status).toBe(200);
  }

  async function postMessageRaw(
    actorId: string,
    groupId: string,
    messageBody: string,
  ) {
    return app.request(`/api/groups/${groupId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": actorId,
      },
      body: JSON.stringify({ body: messageBody }),
    });
  }

  async function createTask(
    coordinatorId: string,
    groupId: string,
    messageId: string,
    executorParticipantId: string,
    dispatchKind?: "requirement" | "fix",
  ) {
    const res = await app.request(`/api/groups/${groupId}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinatorId,
      },
      body: JSON.stringify({
        messageId,
        executorParticipantId,
        ...(dispatchKind !== undefined ? { dispatchKind } : {}),
      }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      id: string;
      status: string;
      dispatchKind: "requirement" | "fix" | null;
    };
  }

  async function patchTask(
    participantId: string,
    groupId: string,
    taskId: string,
    body: Record<string, unknown>,
  ) {
    const res = await app.request(`/api/groups/${groupId}/tasks/${taskId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": participantId,
      },
      body: JSON.stringify(body),
    });
    return res;
  }

  async function getTaskDetail(groupId: string, taskId: string) {
    const res = await app.request(`/api/groups/${groupId}/tasks/${taskId}`);
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  async function findTaskRow(taskId: string) {
    return testDb.query.task.findFirst({ where: eq(taskTable.id, taskId) });
  }

  /** 直接插入一条已完成的执行子任务,使协调任务可以合法落 done。 */
  async function addChild(
    groupId: string,
    parentTaskId: string,
    executorParticipantId: string,
  ) {
    await testDb.insert(taskTable).values({
      groupId,
      parentTaskId,
      messageId: uuidv4(),
      executorParticipantId,
      status: "done",
    });
  }

  function reviewRequest(
    taskId: string,
    specRef: string,
    specHash: string,
    conclusion = "测试交接载荷",
  ) {
    return {
      review_request: {
        type: "review_request",
        layer: 3,
        taskId,
        specRef,
        specHash,
        diffSummary: conclusion,
      },
    };
  }

  function reviewResult(taskId: string, verdict: "pass" | "findings") {
    return {
      type: "review_result",
      layer: 3,
      taskId,
      verdict,
      findings: [],
    };
  }

  /** 搭建三方在场(coordinator+reviewer+executor)的群,并落一条 done 的协调任务。 */
  async function setupGroupAndCoordinationTask() {
    const coordinator = await register(`l3-spec-coord-${randomUUID()}`);
    const reviewer = await register(`l3-spec-reviewer-${randomUUID()}`);
    const execA = await register(`l3-spec-exec-${randomUUID()}`);
    const group = await createGroup(coordinator.id, `l3-spec-${randomUUID()}`);
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    return { coordinator, reviewer, execA, group };
  }

  /** 创建一条协调任务(coordinator 自己执行)并落 done + review_request。 */
  async function closeCoordinationTask(
    coordinatorId: string,
    groupId: string,
    execAId: string,
    specRef: string,
    specHash: string,
    conclusion: string,
    dispatchKind: "requirement" | "fix" = "requirement",
  ) {
    const msg = await postMessageRaw(coordinatorId, groupId, "协调任务");
    const messageId = ((await msg.json()) as { id: string }).id;
    const task = await createTask(
      coordinatorId,
      groupId,
      messageId,
      coordinatorId,
      dispatchKind,
    );
    await addChild(groupId, task.id, execAId);
    const patched = await patchTask(coordinatorId, groupId, task.id, {
      status: "done",
      diffSummary: reviewRequest(task.id, specRef, specHash, conclusion),
    });
    expect(patched.status, await patched.text()).toBe(200);
    return task;
  }

  /* ---------------- R1:同 spec 未应答请求去重并入 ---------------- */

  it("R1:同 specRef+specHash 已有未应答请求 → 第二次结案不新增请求,结论并入既有请求", async () => {
    const { coordinator, reviewer, execA, group } =
      await setupGroupAndCoordinationTask();
    const specRef = "specs/l3-per-spec.md";
    const specHash = "abc12345";

    const first = await closeCoordinationTask(
      coordinator.id,
      group.id,
      execA.id,
      specRef,
      specHash,
      "第一次 L2 结论",
    );
    const second = await closeCoordinationTask(
      coordinator.id,
      group.id,
      execA.id,
      specRef,
      specHash,
      "第二次 L2 结论",
    );

    // 第二次结案不产生第二条请求:任务行不再携带 review_request。
    const secondRow = await findTaskRow(second.id);
    expect(secondRow).not.toBeNull();
    expect(secondRow?.diffSummary).not.toHaveProperty("review_request");
    // 改挂 platform.l3MergedInto 指向属主(第一条请求所在任务)。
    expect(secondRow?.diffSummary).toMatchObject({
      platform: { l3MergedInto: first.id },
    });

    // 属主请求保留了先前的 L2 结论,且并入新结论(追加,不覆盖不删除)。
    const firstRow = await findTaskRow(first.id);
    expect(firstRow).not.toBeNull();
    const ownerSummary = firstRow?.diffSummary as
      | Record<string, unknown>
      | undefined;
    expect(ownerSummary).toBeDefined();
    const ownerRequest = (ownerSummary as Record<string, unknown>)
      .review_request as Record<string, unknown>;
    expect(ownerRequest.diffSummary).toContain("第一次 L2 结论");
    expect(ownerRequest.diffSummary).toContain("第二次 L2 结论");
    // 属主请求载荷结构逐字不变(R5:type/layer/taskId/specRef/specHash/diffSummary)。
    expect(Object.keys(ownerRequest).sort()).toEqual(
      ["type", "layer", "taskId", "specRef", "specHash", "diffSummary"].sort(),
    );

    // 检视者就属主请求给出裁决 → 两条任务均 answered=true(R4)。
    const res = await postMessageRaw(
      reviewer.id,
      group.id,
      JSON.stringify(reviewResult(first.id, "pass")),
    );
    expect(res.status).toBe(200);
    expect((await getTaskDetail(group.id, first.id)).l3).toMatchObject({
      answered: true,
      verdict: "pass",
    });
    expect((await getTaskDetail(group.id, second.id)).l3).toMatchObject({
      answered: true,
      verdict: "pass",
    });
  });

  /* ---------------- R2:已应答的 spec 允许再次请求 ---------------- */

  it("R2:上一条匹配请求已应答 → 允许新建请求", async () => {
    const { coordinator, reviewer, execA, group } =
      await setupGroupAndCoordinationTask();
    const specRef = "specs/l3-per-spec.md";
    const specHash = "abc12345";

    const first = await closeCoordinationTask(
      coordinator.id,
      group.id,
      execA.id,
      specRef,
      specHash,
      "第一次 L2 结论",
    );
    // findings 必须定向到 coordinator 并携带 specRef+specHash;pass 无此约束。
    const answered = await postMessageRaw(
      reviewer.id,
      group.id,
      JSON.stringify(reviewResult(first.id, "pass")),
    );
    expect(answered.status).toBe(200);

    const second = await closeCoordinationTask(
      coordinator.id,
      group.id,
      execA.id,
      specRef,
      specHash,
      "重做后的 L2 结论",
    );
    // 已应答 → 第二条任务正常携带自己的 review_request(新建请求)。
    const secondRow = await findTaskRow(second.id);
    expect(secondRow?.diffSummary).toHaveProperty("review_request");
    expect(secondRow?.diffSummary).not.toHaveProperty("platform.l3MergedInto");
  });

  /* ---------------- R3:续跑任务并入父任务请求 ---------------- */

  it("R3:续跑任务(resumeOf 非空)完成 L2 → 并入父任务请求,不新起一条", async () => {
    const { coordinator, reviewer, execA, group } =
      await setupGroupAndCoordinationTask();
    const specRef = "specs/l3-per-spec.md";
    const specHash = "abc12345";

    // 父协调任务先落 done + review_request(请求 #1)。
    const parent = await closeCoordinationTask(
      coordinator.id,
      group.id,
      execA.id,
      specRef,
      specHash,
      "父任务 L2 结论",
    );

    // 平台创建续跑任务:diffSummary.platform.resumeOf = 父任务 id。
    const resumeMsg = await postMessageRaw(
      coordinator.id,
      group.id,
      "续跑任务",
    );
    const resumeMessageId = ((await resumeMsg.json()) as { id: string }).id;
    const resumeTask = await createTask(
      coordinator.id,
      group.id,
      resumeMessageId,
      coordinator.id,
      "requirement",
    );
    await testDb
      .update(taskTable)
      .set({ diffSummary: { platform: { resumeOf: parent.id } } })
      .where(eq(taskTable.id, resumeTask.id));
    await addChild(group.id, resumeTask.id, execA.id);

    // 续跑任务完成 L2 后同样带 review_request 结案。
    const patched = await patchTask(coordinator.id, group.id, resumeTask.id, {
      status: "done",
      diffSummary: reviewRequest(
        resumeTask.id,
        specRef,
        specHash,
        "续跑 L2 结论",
      ),
    });
    expect(patched.status, await patched.text()).toBe(200);

    // 不新起请求:续跑任务不再携带 review_request,改为并入父任务。
    const resumeRow = await findTaskRow(resumeTask.id);
    expect(resumeRow?.diffSummary).not.toHaveProperty("review_request");
    expect(resumeRow?.diffSummary).toMatchObject({
      platform: { l3MergedInto: parent.id },
    });
    // 保留平台 resumeOf 标记(平台自有标记不被结案清掉)。
    expect(resumeRow?.diffSummary).toMatchObject({
      platform: { resumeOf: parent.id },
    });

    // 父任务请求并入续跑结论;一次裁决使两条任务均 answered。
    const parentRow = await findTaskRow(parent.id);
    expect(parentRow).not.toBeNull();
    const parentSummary = parentRow?.diffSummary as
      | Record<string, unknown>
      | undefined;
    expect(parentSummary).toBeDefined();
    const ownerRequest = (parentSummary as Record<string, unknown>)
      .review_request as Record<string, unknown>;
    expect(ownerRequest.diffSummary).toContain("父任务 L2 结论");
    expect(ownerRequest.diffSummary).toContain("续跑 L2 结论");

    const res = await postMessageRaw(
      reviewer.id,
      group.id,
      JSON.stringify(reviewResult(parent.id, "pass")),
    );
    expect(res.status).toBe(200);
    expect((await getTaskDetail(group.id, parent.id)).l3).toMatchObject({
      answered: true,
    });
    expect((await getTaskDetail(group.id, resumeTask.id)).l3).toMatchObject({
      answered: true,
    });
  });

  /* ---------------- 边界:specHash 不同 → 请求独立并存 ---------------- */

  it("不同 specHash(spec 改版)→ 视为不同请求,允许并存", async () => {
    const { coordinator, execA, group } = await setupGroupAndCoordinationTask();
    const specRef = "specs/l3-per-spec.md";

    const first = await closeCoordinationTask(
      coordinator.id,
      group.id,
      execA.id,
      specRef,
      "hash-v1",
      "v1 结论",
    );
    const second = await closeCoordinationTask(
      coordinator.id,
      group.id,
      execA.id,
      specRef,
      "hash-v2",
      "v2 结论",
    );

    const firstRow = await findTaskRow(first.id);
    const secondRow = await findTaskRow(second.id);
    // 两条任务各自携带自己的 review_request(未互相并入)。
    expect(firstRow?.diffSummary).toHaveProperty("review_request");
    expect(secondRow?.diffSummary).toHaveProperty("review_request");
    expect(firstRow?.diffSummary).not.toHaveProperty("platform.l3MergedInto");
    expect(secondRow?.diffSummary).not.toHaveProperty("platform.l3MergedInto");
  });

  /* ---------------- R5 回归:§4.1 布尔与 review_request 载荷不变 ---------------- */

  it("R5 回归:正常结案的 review_request 载荷逐字落库(嵌套形状)", async () => {
    const { coordinator, execA, group } = await setupGroupAndCoordinationTask();
    const specRef = "specs/l3-per-spec.md";
    const specHash = "abc12345";

    const msg = await postMessageRaw(coordinator.id, group.id, "协调任务");
    const messageId = ((await msg.json()) as { id: string }).id;
    const task = await createTask(
      coordinator.id,
      group.id,
      messageId,
      coordinator.id,
      "requirement",
    );
    await addChild(group.id, task.id, execA.id);
    const payload = reviewRequest(task.id, specRef, specHash, "回归结论");
    const patched = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: payload,
    });
    expect(patched.status, await patched.text()).toBe(200);

    const row = await findTaskRow(task.id);
    expect(row?.diffSummary).toEqual(payload);
  });

  it("R5 回归:§4.1 布尔不变——三方在场 + 非 fix + 无 review_request 仍 400", async () => {
    const { coordinator, execA, group } = await setupGroupAndCoordinationTask();
    const msg = await postMessageRaw(coordinator.id, group.id, "协调任务");
    const messageId = ((await msg.json()) as { id: string }).id;
    const task = await createTask(
      coordinator.id,
      group.id,
      messageId,
      coordinator.id,
      "requirement",
    );
    await addChild(group.id, task.id, execA.id);
    const patched = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: { summary: "无 review_request" },
    });
    expect(patched.status).toBe(400);
    expect(((await patched.json()) as { message: string }).message).toContain(
      "review_request",
    );
  });

  it("R5 回归:§4.1 布尔不变——fix 票不强制 review_request(可正常 done)", async () => {
    const { coordinator, execA, group } = await setupGroupAndCoordinationTask();
    const msg = await postMessageRaw(coordinator.id, group.id, "修复票");
    const messageId = ((await msg.json()) as { id: string }).id;
    const task = await createTask(
      coordinator.id,
      group.id,
      messageId,
      coordinator.id,
      "fix",
    );
    await addChild(group.id, task.id, execA.id);
    const patched = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: { summary: "修复完成" },
    });
    expect(patched.status, await patched.text()).toBe(200);
  });

  /* ---------------- R3 反向守卫:不该走 L3 时不得产出 review_request ---------------- */

  it("R3:fix 票终态携带 review_request → 400 且终态不写入", async () => {
    const { coordinator, execA, group } = await setupGroupAndCoordinationTask();
    const msg = await postMessageRaw(coordinator.id, group.id, "fix 带 review");
    const messageId = ((await msg.json()) as { id: string }).id;
    const task = await createTask(
      coordinator.id,
      group.id,
      messageId,
      coordinator.id,
      "fix",
    );
    await addChild(group.id, task.id, execA.id);
    const patched = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: reviewRequest(task.id, "specs/r3-fix.md", "hash1", "fix 结论"),
    });
    expect(patched.status).toBe(400);
    const body = (await patched.json()) as { message: string };
    expect(body.message).toContain("fix 票复用已过 L3 的冻结 spec");

    const row = await findTaskRow(task.id);
    expect(row?.status).not.toBe("done");
  });

  it("R3:群内无 reviewer 时携带 review_request → 400 且终态不写入", async () => {
    const coordinator = await register(`r3-no-reviewer-coord-${randomUUID()}`);
    const execA = await register(`r3-no-reviewer-exec-${randomUUID()}`);
    const group = await createGroup(coordinator.id, `r3-no-reviewer-${randomUUID()}`);
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);

    const msg = await postMessageRaw(coordinator.id, group.id, "无 reviewer");
    const messageId = ((await msg.json()) as { id: string }).id;
    const task = await createTask(
      coordinator.id,
      group.id,
      messageId,
      coordinator.id,
      "requirement",
    );
    await addChild(group.id, task.id, execA.id);
    const patched = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: reviewRequest(task.id, "specs/r3-no-reviewer.md", "hash2", "结论"),
    });
    expect(patched.status).toBe(400);
    const body = (await patched.json()) as { message: string };
    expect(body.message).toContain("群内无 reviewer 成员");

    const row = await findTaskRow(task.id);
    expect(row?.status).not.toBe("done");
  });

  it("R3 回归:dispatchKind=null 历史任务仍允许携带 review_request", async () => {
    const { coordinator, reviewer, execA, group } =
      await setupGroupAndCoordinationTask();
    const msg = await postMessageRaw(coordinator.id, group.id, "历史任务");
    const messageId = ((await msg.json()) as { id: string }).id;
    const task = await createTask(
      coordinator.id,
      group.id,
      messageId,
      coordinator.id,
    );
    expect(task.dispatchKind).toBeNull();
    await addChild(group.id, task.id, execA.id);
    const payload = reviewRequest(task.id, "specs/r3-null.md", "hash3", "历史结论");
    const patched = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: payload,
    });
    expect(patched.status, await patched.text()).toBe(200);

    const row = await findTaskRow(task.id);
    expect(row?.diffSummary).toEqual(payload);
  });

  it("R3 回归:非协调任务不携带 review_request 的普通 PATCH 行为不变", async () => {
    const { coordinator, execA, group } = await setupGroupAndCoordinationTask();
    const msg = await postMessageRaw(coordinator.id, group.id, "普通执行器任务");
    const messageId = ((await msg.json()) as { id: string }).id;
    const task = await createTask(
      coordinator.id,
      group.id,
      messageId,
      execA.id,
      "requirement",
    );
    const patched = await patchTask(execA.id, group.id, task.id, {
      status: "done",
      diffSummary: { summary: "执行器完成" },
    });
    expect(patched.status, await patched.text()).toBe(200);

    const row = await findTaskRow(task.id);
    expect(row?.status).toBe("done");
    expect(row?.diffSummary).toEqual({ summary: "执行器完成" });
  });
});
