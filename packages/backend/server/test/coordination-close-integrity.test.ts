import { task as taskTable } from "@laizhixingxingdeli/database/schema";
import { v4 as uuidv4 } from "uuid";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./app";
import { testDb } from "./db";

/**
 * 协调任务落终态的完整性校验(R1-R5,specs/coordination-close-integrity.md)。
 *
 * 校验点在 routes/group/tasks.ts 的 PATCH 终态处,仅对「协调任务 + 目标状态 done」
 * 生效;通过复用 lib/detached-task-liveness 的 isDetachedTask() 判定协调任务。
 * 覆盖 spec 验收标准逐条用例 + 普通任务/failed 的回归 + 形状校验不变。
 */

type Task = {
  id: string;
  status: string;
  executorParticipantId: string;
  dispatchKind: "requirement" | "fix" | null;
  diffSummary: unknown;
};

describe("协调任务落终态完整性校验 (R1-R5)", () => {
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

  async function postMessage(actorId: string, groupId: string, body: string) {
    const res = await app.request(`/api/groups/${groupId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": actorId,
      },
      body: JSON.stringify({ body }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
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
    return (await res.json()) as Task;
  }

  async function patchTask(
    participantId: string,
    groupId: string,
    taskId: string,
    body: Record<string, unknown>,
  ) {
    return app.request(`/api/groups/${groupId}/tasks/${taskId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": participantId,
      },
      body: JSON.stringify(body),
    });
  }

  /** 直接插一条指向 parentTaskId 的执行子任务,使 R1 放行。 */
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
      status: "queued",
    });
  }

  function reviewRequest(taskId: string) {
    return {
      review_request: {
        type: "review_request",
        layer: 3,
        taskId,
        specRef: "specs/coordination-close-integrity.md",
        specHash: "449e4a1e",
        diffSummary: "测试交接载荷",
      },
    };
  }

  it("R1:协调任务零子任务 PATCH done → 400,且点明 L1 层未发生", async () => {
    const coordinator = await register("ci-coord-1");
    const group = await createGroup(coordinator.id, "ci-1");
    // 两方(无 reviewer)隔离 R2;detached 经 coordinator 角色判定。
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("L1 层未发生");
  });

  it("R1:带非空 noExecutionReason → 放行", async () => {
    const coordinator = await register("ci-coord-2");
    const group = await createGroup(coordinator.id, "ci-2");
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: {
        noExecutionReason: "该需求判定无需改动,无需下发执行器",
      },
    });
    expect(res.status).toBe(200);
  });

  it("R1:noExecutionReason 空串/纯空白 → 仍 400", async () => {
    const coordinator = await register("ci-coord-3");
    const group = await createGroup(coordinator.id, "ci-3");
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    for (const reason of ["", "   ", "\t\n"]) {
      const res = await patchTask(coordinator.id, group.id, task.id, {
        status: "done",
        diffSummary: { noExecutionReason: reason },
      });
      expect(res.status).toBe(400);
    }
  });

  it("R2:三方在场 + dispatchKind 非 fix + 无 review_request → 400", async () => {
    const coordinator = await register("ci-coord-4");
    const reviewer = await register("ci-reviewer-4");
    const execA = await register("ci-exec-4");
    const group = await createGroup(coordinator.id, "ci-4");
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
      "requirement",
    );
    await addChild(group.id, task.id, execA.id); // R1 放行
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("review_request");
  });

  it("R2:三方在场 + dispatchKind='fix' + 无 review_request → 放行", async () => {
    const coordinator = await register("ci-coord-5");
    const reviewer = await register("ci-reviewer-5");
    const execA = await register("ci-exec-5");
    const group = await createGroup(coordinator.id, "ci-5");
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
      "fix",
    );
    await addChild(group.id, task.id, execA.id);
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
    });
    expect(res.status).toBe(200);
  });

  it("R2:两方在场(无 reviewer)+ 无 review_request → 放行", async () => {
    const coordinator = await register("ci-coord-6");
    const execA = await register("ci-exec-6");
    const group = await createGroup(coordinator.id, "ci-6");
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
      "requirement",
    );
    await addChild(group.id, task.id, execA.id);
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
    });
    expect(res.status).toBe(200);
  });

  it("R2:dispatchKind 为 null + 三方在场 + 无 review_request → 400(保守)", async () => {
    const coordinator = await register("ci-coord-7");
    const reviewer = await register("ci-reviewer-7");
    const execA = await register("ci-exec-7");
    const group = await createGroup(coordinator.id, "ci-7");
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    ); // 无 dispatchKind → null,按 requirement 处理
    await addChild(group.id, task.id, execA.id);
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
    });
    expect(res.status).toBe(400);
  });

  it("R3:PATCH failed 时两条规则均不生效", async () => {
    const coordinator = await register("ci-coord-8");
    const reviewer = await register("ci-reviewer-8");
    const execA = await register("ci-exec-8");
    const group = await createGroup(coordinator.id, "ci-8");
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    // 零子任务 + 三方 + null dispatchKind:若是 done 会被 R1/R2 双拒。
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "failed",
      diffSummary: { error: "诚实的失败上报" },
    });
    expect(res.status).toBe(200);
  });

  it("R5:非协调任务(普通执行任务)PATCH done 行为完全不变", async () => {
    const coordinator = await register("ci-coord-9");
    const reviewer = await register("ci-reviewer-9");
    const execA = await register("ci-exec-9");
    const group = await createGroup(coordinator.id, "ci-9");
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "执行任务");
    // executor 为 execA(无 coordinator 角色)→ 非 detached,不受 R1/R2 约束。
    const task = await createTask(coordinator.id, group.id, msg.id, execA.id);
    const res = await patchTask(execA.id, group.id, task.id, {
      status: "done",
    });
    expect(res.status).toBe(200);
  });

  it("复用 isDetachedTask():brief 含 ## ReplyMode: detached 即判定协调任务", async () => {
    const coordinator = await register("ci-coord-10");
    const execA = await register("ci-exec-10");
    const group = await createGroup(coordinator.id, "ci-10");
    // executor 非 coordinator,靠 brief 标记被 isDetachedTask 判定为协调任务。
    const msg = await postMessage(
      coordinator.id,
      group.id,
      "## ReplyMode: detached\n普通正文",
    );
    const task = await createTask(coordinator.id, group.id, msg.id, execA.id);
    // 零子任务 done → R1 经 isDetachedTask 的 brief 分支命中 → 400。
    const res = await patchTask(execA.id, group.id, task.id, {
      status: "done",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("L1 层未发生");
  });

  it("R5:既有 review_request 形状校验不变(缺字段 → 400 形状错误)", async () => {
    const coordinator = await register("ci-coord-11");
    const execA = await register("ci-exec-11");
    const group = await createGroup(coordinator.id, "ci-11");
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    await addChild(group.id, task.id, execA.id);
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: { review_request: { type: "review_request" } },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("形状无效");
  });

  it("完整放行:三方在场 + requirement + 有子任务 + 合法 review_request → 200", async () => {
    const coordinator = await register("ci-coord-12");
    const reviewer = await register("ci-reviewer-12");
    const execA = await register("ci-exec-12");
    const group = await createGroup(coordinator.id, "ci-12");
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
      "requirement",
    );
    await addChild(group.id, task.id, execA.id);
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: reviewRequest(task.id),
    });
    expect(res.status).toBe(200);
  });

  it("review_request 以顶层 {type:'review_request'} 形式也可放行", async () => {
    const coordinator = await register("ci-coord-13");
    const reviewer = await register("ci-reviewer-13");
    const execA = await register("ci-exec-13");
    const group = await createGroup(coordinator.id, "ci-13");
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
      "requirement",
    );
    await addChild(group.id, task.id, execA.id);
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: {
        type: "review_request",
        layer: 3,
        taskId: task.id,
        specRef: "specs/coordination-close-integrity.md",
        specHash: "449e4a1e",
        diffSummary: "测试交接载荷",
      },
    });
    expect(res.status).toBe(200);
  });
});
