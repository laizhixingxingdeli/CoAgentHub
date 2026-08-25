import {
  type TaskStatus,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import {
  aggregateTaskStatuses,
  deriveL1Aggregate,
} from "@server/lib/l1-aggregate";
import { v4 as uuidv4 } from "uuid";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./app";
import { testDb } from "./db";

/**
 * specs/reviewer-needs-no-executor-visibility.md (specHash d1c11837) R1-R4:
 * 协调任务详情透出 l1 聚合 { childCount, status, allTerminal },聚合口径与前端
 * group-tasks-by-spec.ts 的 L1 步一致(同输入同结论,测试对照);l1 不含执行器
 * 身份;非协调任务不输出 l1(回归);协调任务判定复用 isDetachedTask()。
 */

describe("l1 聚合函数(口径与前端 group-tasks-by-spec.ts L1 步一致)", () => {
  it("空列表 → pending(零子任务口径)", () => {
    expect(aggregateTaskStatuses([])).toBe("pending");
  });

  it("有 running → running(无论其它状态)", () => {
    expect(aggregateTaskStatuses(["running"])).toBe("running");
    expect(aggregateTaskStatuses(["queued", "running", "done"])).toBe(
      "running",
    );
  });

  it("全部 done → done", () => {
    expect(aggregateTaskStatuses(["done", "done"])).toBe("done");
  });

  it("存在 failed 且无后续成功 → failed", () => {
    expect(aggregateTaskStatuses(["failed"])).toBe("failed");
    expect(aggregateTaskStatuses(["done", "failed"])).toBe("failed");
    expect(aggregateTaskStatuses(["failed", "queued", "failed"])).toBe(
      "failed",
    );
  });

  it("failed 之后有 done(成功重试)→ pending,不是 failed", () => {
    expect(aggregateTaskStatuses(["failed", "done"])).toBe("pending");
    expect(aggregateTaskStatuses(["done", "failed", "done"])).toBe("pending");
  });

  it("既非 running/全 done/带失败 → pending(queued/cancelled 等)", () => {
    expect(aggregateTaskStatuses(["queued"])).toBe("pending");
    expect(aggregateTaskStatuses(["cancelled"])).toBe("pending");
    expect(aggregateTaskStatuses(["queued", "cancelled", "done"])).toBe(
      "pending",
    );
  });
});

describe("对照:后端聚合与前端 group-tasks-by-spec.ts 的 aggregateTaskStatuses 同输入同结论", () => {
  it("0-4 长度的全组合下两者结论一致(测试对照)", async () => {
    const specUrl = new URL(
      "../../../frontend/web/src/components/layout/context-panel/group-tasks-by-spec.ts",
      import.meta.url,
    );
    // 运行时动态引用前端聚合函数(仅测试对照用,避免 tsc 解析前端别名)。
    const frontend = (await import(specUrl.href)) as {
      aggregateTaskStatuses: (statuses: string[]) => string;
    };

    const alphabet: TaskStatus[] = [
      "queued",
      "running",
      "done",
      "failed",
      "cancelled",
    ];
    const sequences: string[][] = [[]];
    for (let length = 1; length <= 4; length += 1) {
      for (const prefix of [...sequences].filter(
        (seq) => seq.length === length - 1,
      )) {
        for (const status of alphabet) {
          sequences.push([...prefix, status]);
        }
      }
    }
    expect(sequences.length).toBe(1 + 5 + 25 + 125 + 625); // 781 组输入
    for (const seq of sequences) {
      expect(aggregateTaskStatuses(seq as TaskStatus[])).toBe(
        frontend.aggregateTaskStatuses(seq),
      );
    }
  });
});

describe("协调任务详情透出 l1 聚合 (R1)", () => {
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
  ) {
    const res = await app.request(`/api/groups/${groupId}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinatorId,
      },
      body: JSON.stringify({ messageId, executorParticipantId }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
  }

  async function getDetail(groupId: string, taskId: string) {
    const res = await app.request(`/api/groups/${groupId}/tasks/${taskId}`);
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  /** 直接插一条指向 parentTaskId 的子任务,status/createdAt 可控(聚合只读状态)。 */
  async function addChild(
    groupId: string,
    parentTaskId: string,
    executorParticipantId: string,
    status: TaskStatus,
    createdAt: Date,
    supersedesTaskId?: string,
  ) {
    await testDb.insert(taskTable).values({
      groupId,
      parentTaskId,
      messageId: uuidv4(),
      executorParticipantId,
      status,
      createdAt,
      ...(supersedesTaskId !== undefined ? { supersedesTaskId } : {}),
    });
  }

  /** 同 addChild,但返回新建子任务的 id(供后续任务以 supersedesTaskId 指向它)。 */
  async function addChildReturningId(
    groupId: string,
    parentTaskId: string,
    executorParticipantId: string,
    status: TaskStatus,
    createdAt: Date,
    supersedesTaskId?: string,
  ) {
    const [row] = await testDb
      .insert(taskTable)
      .values({
        groupId,
        parentTaskId,
        messageId: uuidv4(),
        executorParticipantId,
        status,
        createdAt,
        ...(supersedesTaskId !== undefined ? { supersedesTaskId } : {}),
      })
      .returning({ id: taskTable.id });
    if (!row) throw new Error("addChildReturningId 未返回行");
    return row.id;
  }

  it("协调任务零子任务 → l1 { childCount: 0, status: 'pending' }", async () => {
    const coordinator = await register("l1-empty-coord");
    const group = await createGroup(coordinator.id, "l1-empty");
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    // 执行人 = coordinator → isDetachedTask 命中 coordinator 角色分支。
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const detail = await getDetail(group.id, task.id);
    expect(detail.l1).toEqual({
      childCount: 0,
      supersededCount: 0,
      status: "pending",
      allTerminal: false,
    });
    expect(typeof (detail.runtime as { stale: unknown }).stale).toBe("boolean");
    expect(typeof (detail.runtime as { startedAt: string }).startedAt).toBe(
      "string",
    );
  });

  it("子任务全部 done → status done, allTerminal true", async () => {
    const coordinator = await register("l1-done-coord");
    const execA = await register("l1-done-exec");
    const group = await createGroup(coordinator.id, "l1-done");
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    await addChild(
      group.id,
      task.id,
      execA.id,
      "done",
      new Date("2026-08-01T00:00:00Z"),
    );
    await addChild(
      group.id,
      task.id,
      execA.id,
      "done",
      new Date("2026-08-01T01:00:00Z"),
    );
    const detail = await getDetail(group.id, task.id);
    expect(detail.l1).toEqual({
      childCount: 2,
      supersededCount: 0,
      status: "done",
      allTerminal: true,
    });
  });

  it("存在 running 子任务 → status running, allTerminal false", async () => {
    const coordinator = await register("l1-run-coord");
    const execA = await register("l1-run-exec");
    const group = await createGroup(coordinator.id, "l1-run");
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    await addChild(
      group.id,
      task.id,
      execA.id,
      "done",
      new Date("2026-08-01T00:00:00Z"),
    );
    await addChild(
      group.id,
      task.id,
      execA.id,
      "running",
      new Date("2026-08-01T01:00:00Z"),
    );
    const detail = await getDetail(group.id, task.id);
    expect(detail.l1).toEqual({
      childCount: 2,
      supersededCount: 0,
      status: "running",
      allTerminal: false,
    });
  });

  it("failed 无后续成功 → status failed;failed 后有 done → pending", async () => {
    const coordinator = await register("l1-fail-coord");
    const execA = await register("l1-fail-exec");
    const group = await createGroup(coordinator.id, "l1-fail");
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    await addChild(
      group.id,
      task.id,
      execA.id,
      "done",
      new Date("2026-08-01T00:00:00Z"),
    );
    await addChild(
      group.id,
      task.id,
      execA.id,
      "failed",
      new Date("2026-08-01T01:00:00Z"),
    );
    const detail = await getDetail(group.id, task.id);
    expect(detail.l1).toEqual({
      childCount: 2,
      supersededCount: 0,
      status: "failed",
      allTerminal: true,
    });

    // 同组第二条协调任务:failed 之后有 done → pending(成功重试)。
    const msg2 = await postMessage(coordinator.id, group.id, "协调任务2");
    const task2 = await createTask(
      coordinator.id,
      group.id,
      msg2.id,
      coordinator.id,
    );
    await addChild(
      group.id,
      task2.id,
      execA.id,
      "failed",
      new Date("2026-08-02T00:00:00Z"),
    );
    await addChild(
      group.id,
      task2.id,
      execA.id,
      "done",
      new Date("2026-08-02T01:00:00Z"),
    );
    const detail2 = await getDetail(group.id, task2.id);
    expect(detail2.l1).toEqual({
      childCount: 2,
      supersededCount: 0,
      status: "pending",
      allTerminal: true,
    });
  });

  it("l1 只含 childCount/supersededCount/status/allTerminal,不含任何执行器身份字段", async () => {
    const coordinator = await register("l1-id-coord");
    const execA = await register("l1-id-exec");
    const group = await createGroup(coordinator.id, "l1-id");
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    await addChild(
      group.id,
      task.id,
      execA.id,
      "done",
      new Date("2026-08-01T00:00:00Z"),
    );
    const detail = await getDetail(group.id, task.id);
    const l1 = detail.l1 as Record<string, unknown>;
    expect(Object.keys(l1).sort()).toEqual([
      "allTerminal",
      "childCount",
      "status",
      "supersededCount",
    ]);
    expect(l1).not.toHaveProperty("executorParticipantId");
    expect(l1).not.toHaveProperty("executorKey");
    expect(l1).not.toHaveProperty("executorName");
  });

  it("被替代的子任务不计入 childCount,supersededCount 如实计数", async () => {
    const coordinator = await register("l1-sup-coord");
    const execA = await register("l1-sup-exec");
    const group = await createGroup(coordinator.id, "l1-sup");
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    // A 被 B 替代(A 是较早的一次尝试,B 是换执行器后的替代)。
    const childA = await addChildReturningId(
      group.id,
      task.id,
      execA.id,
      "failed",
      new Date("2026-08-01T00:00:00Z"),
    );
    await addChild(
      group.id,
      task.id,
      execA.id,
      "done",
      new Date("2026-08-01T01:00:00Z"),
      childA,
    );
    const detail = await getDetail(group.id, task.id);
    expect(detail.l1).toEqual({
      childCount: 1,
      supersededCount: 1,
      status: "done",
      allTerminal: true,
    });
  });

  it("连续替代(换两次执行器)→ childCount 只留最后一次,supersededCount=2", async () => {
    const coordinator = await register("l1-sup2-coord");
    const execA = await register("l1-sup2-exec");
    const group = await createGroup(coordinator.id, "l1-sup2");
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const childA = await addChildReturningId(
      group.id,
      task.id,
      execA.id,
      "failed",
      new Date("2026-08-01T00:00:00Z"),
    );
    const childB = await addChildReturningId(
      group.id,
      task.id,
      execA.id,
      "failed",
      new Date("2026-08-01T01:00:00Z"),
      childA,
    );
    await addChild(
      group.id,
      task.id,
      execA.id,
      "done",
      new Date("2026-08-01T02:00:00Z"),
      childB,
    );
    const detail = await getDetail(group.id, task.id);
    expect(detail.l1).toEqual({
      childCount: 1,
      supersededCount: 2,
      status: "done",
      allTerminal: true,
    });
  });

  it("协调任务判定复用 isDetachedTask():brief 含 ReplyMode: detached 也透出 l1", async () => {
    const coordinator = await register("l1-rm-coord");
    const execA = await register("l1-rm-exec");
    const group = await createGroup(coordinator.id, "l1-rm");
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    // 执行人是普通 executor(无 coordinator 角色),靠 brief 标记命中 isDetachedTask。
    const msg = await postMessage(
      coordinator.id,
      group.id,
      "## ReplyMode: detached\n协调任务",
    );
    const task = await createTask(coordinator.id, group.id, msg.id, execA.id);
    await addChild(
      group.id,
      task.id,
      execA.id,
      "done",
      new Date("2026-08-01T00:00:00Z"),
    );
    const detail = await getDetail(group.id, task.id);
    expect(detail.l1).toEqual({
      childCount: 1,
      supersededCount: 0,
      status: "done",
      allTerminal: true,
    });
  });
});

describe("非协调任务详情回归(R1:不输出 l1,载荷逐字不变)", () => {
  const app = createTestApp();

  it("普通执行任务详情不含 l1 字段,字段集合与改动前逐字一致", async () => {
    const coordinator = await register("l1-reg-coord");
    const execA = await register("l1-reg-exec");
    const group = await createGroup(coordinator.id, "l1-reg");
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "执行任务");
    const res = await app.request(`/api/groups/${group.id}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinator.id,
      },
      body: JSON.stringify({
        messageId: msg.id,
        executorParticipantId: execA.id,
      }),
    });
    expect(res.status).toBe(200);
    const task = (await res.json()) as { id: string };

    const detail = await app.request(
      `/api/groups/${group.id}/tasks/${task.id}`,
    );
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as Record<string, unknown>;
    // 执行人无 coordinator 角色且 brief 无 ReplyMode → 非协调任务。
    expect(body).not.toHaveProperty("l1");
    expect(body).not.toHaveProperty("runtime");
    expect(Object.keys(body).sort()).toEqual([
      "brief",
      "callbackRef",
      "checkpointRef",
      "createdAt",
      "diffSummary",
      "dispatchAudit",
      "dispatchKind",
      "dispatcherParticipantId",
      "dispatcherSessionId",
      "executorKey",
      "executorParticipantId",
      "groupId",
      "id",
      "lastSignalAt",
      "livenessWarning",
      "messageId",
      "parentTaskId",
      "retryCount",
      "specHash",
      "specRef",
      "status",
      "supersedesTaskId",
      "updatedAt",
    ]);
  });

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
});

// deriveL1Aggregate 的模块级导出存在性锚点(与前端口径同源的实现入口)。
describe("deriveL1Aggregate 导出", () => {
  it("导出签名可用(供路由复用,不另写一套)", () => {
    expect(typeof deriveL1Aggregate).toBe("function");
  });
});
