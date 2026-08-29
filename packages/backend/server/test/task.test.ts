import { execFileSync } from "node:child_process";
import { task as taskTable } from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { describe, expect, it } from "vitest";
import {
  appendTaskOutput,
  releaseTaskOutput,
} from "../src/lib/executor-task/output-buffer";
import {
  configureSourceScanRoots,
  resetSourceScanCache,
} from "../src/lib/runtime-status";
import { createTestApp } from "./app";
import { testDb } from "./db";

/**
 * Task first-class entity (ticket 35): the server is the single source of
 * truth for task lifecycle — the bridge creates a row before spawning its
 * CLI and patches status/diffSummary when the run finishes.
 *
 * Covered here: idempotent creation (the same message_id only ever yields one
 * task), PATCH permission (only the owning executor participant may update; anyone
 * else is 403), and the running -> done / failed / cancelled transitions.
 */
describe("任务实体(server 单一状态源)", () => {
  const app = createTestApp();

  async function registerParticipant(body: Record<string, unknown>) {
    const res = await app.request("/api/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // 名字唯一(0013):同名已注册时服务端返回 409,复用现有 participant(测试内多次 setupGroup)。
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

  type Task = {
    id: string;
    groupId: string;
    messageId: string;
    executorParticipantId: string;
    status: "queued" | "running" | "done" | "failed" | "cancelled";
    checkpointRef: string | null;
    dispatchKind: "requirement" | "fix" | null;
    supersedesTaskId: string | null;
    brief: string | null;
    diffSummary: unknown;
    createdAt: string;
    updatedAt: string | null;
  };

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

  async function withFreshRuntime<T>(callback: () => Promise<T>) {
    configureSourceScanRoots([]);
    resetSourceScanCache();
    try {
      return await callback();
    } finally {
      configureSourceScanRoots(null);
      resetSourceScanCache();
    }
  }

  async function createTask(
    participantId: string,
    groupId: string,
    messageId: string,
    executorParticipantId: string,
    checkpointRef?: string,
    dispatchKind?: "requirement" | "fix",
  ) {
    return app.request(`/api/groups/${groupId}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": participantId,
      },
      body: JSON.stringify({
        messageId,
        executorParticipantId,
        ...(checkpointRef !== undefined ? { checkpointRef } : {}),
        ...(dispatchKind !== undefined ? { dispatchKind } : {}),
      }),
    });
  }

  /** A group with coordinator + two executor participants. */
  async function setupGroup() {
    const coordinator = await registerParticipant({
      name: "coord-mac",
    });
    const execA = await registerParticipant({
      name: "executor-a",
    });
    const execB = await registerParticipant({
      name: "executor-b",
    });
    const group = await createGroup(coordinator.id, "任务实体测试");
    return { coordinator, execA, execB, group };
  }

  it("同 message_id 重复 POST 返回同一任务(幂等创建)", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const messageId = "00000000-0000-7000-8000-000000000001";

    const res1 = await createTask(
      coordinator.id,
      group.id,
      messageId,
      execA.id,
    );
    expect(res1.status).toBe(200);
    const t1 = (await res1.json()) as Task;
    expect(t1.status).toBe("queued");
    expect(t1.executorParticipantId).toBe(execA.id);
    expect(t1.checkpointRef).toBeNull();

    const res2 = await createTask(
      coordinator.id,
      group.id,
      messageId,
      execA.id,
    );
    expect(res2.status).toBe(200);
    const t2 = (await res2.json()) as Task;
    expect(t2.id).toBe(t1.id);
    expect(t2.messageId).toBe(messageId);
  });

  it("同 message_id 携带不同规范字段时返回 409 并列出冲突字段", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const messageId = "00000000-0000-7000-8000-000000000007";

    const first = await app.request(`/api/groups/${group.id}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinator.id,
      },
      body: JSON.stringify({
        messageId,
        executorParticipantId: execA.id,
      }),
    });
    expect(first.status).toBe(200);

    const conflicting = await app.request(`/api/groups/${group.id}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinator.id,
      },
      body: JSON.stringify({
        messageId,
        executorParticipantId: execA.id,
        specRef: "specs/dispatch-fields-silent-loss.md",
        specHash: "987f54a",
        dispatchKind: "requirement",
      }),
    });
    expect(conflicting.status).toBe(409);
    const error = (await conflicting.json()) as { message: string };
    expect(error.message).toContain("specRef");
    expect(error.message).toContain("specHash");
    expect(error.message).toContain("dispatchKind");
  });

  it("同 message_id 携带与既有任务一致的规范字段时仍幂等放行", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const messageId = "00000000-0000-7000-8000-000000000008";
    const fields = {
      messageId,
      executorParticipantId: execA.id,
      specRef: "specs/dispatch-fields-silent-loss.md",
      specHash: "987f54a",
      dispatchKind: "requirement",
    } as const;

    const first = await app.request(`/api/groups/${group.id}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinator.id,
      },
      body: JSON.stringify(fields),
    });
    expect(first.status).toBe(200);
    const original = (await first.json()) as { id: string };

    const repeated = await app.request(`/api/groups/${group.id}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinator.id,
      },
      body: JSON.stringify(fields),
    });
    expect(repeated.status).toBe(200);
    expect(((await repeated.json()) as { id: string }).id).toBe(original.id);
  });

  it("同 message_id 显式传冲突的 supersedesTaskId 时仍返回 409", async () => {
    const { coordinator, execA, group } = await setupGroup();
    // 建两条被替代的任务。
    const target1 = await createTask(
      coordinator.id,
      group.id,
      uuidv4(),
      execA.id,
    );
    const targetTask1 = (await target1.json()) as Task;
    const target2 = await createTask(
      coordinator.id,
      group.id,
      uuidv4(),
      execA.id,
    );
    const targetTask2 = (await target2.json()) as Task;

    const messageId = uuidv4();
    const first = await app.request(`/api/groups/${group.id}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinator.id,
      },
      body: JSON.stringify({
        messageId,
        executorParticipantId: execA.id,
        supersedesTaskId: targetTask1.id,
      }),
    });
    expect(first.status).toBe(200);

    // 重复 POST 但显式传不同的 supersedesTaskId → 409。
    const conflicting = await app.request(`/api/groups/${group.id}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinator.id,
      },
      body: JSON.stringify({
        messageId,
        executorParticipantId: execA.id,
        supersedesTaskId: targetTask2.id,
      }),
    });
    expect(conflicting.status).toBe(409);
    const error = (await conflicting.json()) as { message: string };
    expect(error.message).toContain("supersedesTaskId");
  });

  it("POST 接受 requirement 与 fix 并落库", async () => {
    const { coordinator, execA, group } = await setupGroup();

    const requirement = await createTask(
      coordinator.id,
      group.id,
      "00000000-0000-7000-8000-000000000002",
      execA.id,
      undefined,
      "requirement",
    );
    expect(requirement.status).toBe(200);
    expect(((await requirement.json()) as Task).dispatchKind).toBe(
      "requirement",
    );

    const fix = await createTask(
      coordinator.id,
      group.id,
      "00000000-0000-7000-8000-000000000003",
      execA.id,
      undefined,
      "fix",
    );
    expect(fix.status).toBe(200);
    expect(((await fix.json()) as Task).dispatchKind).toBe("fix");
  });

  it("列表与详情透出 dispatchKind", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const created = await createTask(
      coordinator.id,
      group.id,
      "00000000-0000-7000-8000-000000000004",
      execA.id,
      undefined,
      "requirement",
    );
    const task = (await created.json()) as Task;

    const list = await app.request(`/api/groups/${group.id}/tasks`);
    expect(list.status).toBe(200);
    expect(
      ((await list.json()) as Task[]).find((entry) => entry.id === task.id)
        ?.dispatchKind,
    ).toBe("requirement");

    const detail = await app.request(
      `/api/groups/${group.id}/tasks/${task.id}`,
    );
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as Task).dispatchKind).toBe("requirement");
  });

  it("dispatchKind 非法值返回 400 且不落库", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const messageId = "00000000-0000-7000-8000-000000000005";
    const response = await app.request(`/api/groups/${group.id}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinator.id,
      },
      body: JSON.stringify({
        messageId,
        executorParticipantId: execA.id,
        dispatchKind: "bug",
      }),
    });
    expect(response.status).toBe(400);

    const list = await app.request(`/api/groups/${group.id}/tasks`);
    expect(list.status).toBe(200);
    expect(
      ((await list.json()) as Task[]).some(
        (entry) => entry.messageId === messageId,
      ),
    ).toBe(false);
  });

  it("不传 dispatchKind 时保持 null", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const response = await createTask(
      coordinator.id,
      group.id,
      "00000000-0000-7000-8000-000000000006",
      execA.id,
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as Task).dispatchKind).toBeNull();
  });

  it("POST 接受 supersedesTaskId 并落库,列表与详情透出", async () => {
    const { coordinator, execA, group } = await setupGroup();
    // 先建一条被替代的任务。
    const target = await createTask(
      coordinator.id,
      group.id,
      uuidv4(),
      execA.id,
    );
    const targetTask = (await target.json()) as Task;
    const newMessageId = uuidv4();

    const created = await app.request(`/api/groups/${group.id}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinator.id,
      },
      body: JSON.stringify({
        messageId: newMessageId,
        executorParticipantId: execA.id,
        supersedesTaskId: targetTask.id,
      }),
    });
    expect(created.status).toBe(200);
    const task = (await created.json()) as Task;
    expect(task.supersedesTaskId).toBe(targetTask.id);

    // 列表透出。
    const list = await app.request(`/api/groups/${group.id}/tasks`);
    expect(list.status).toBe(200);
    expect(
      ((await list.json()) as Task[]).find((entry) => entry.id === task.id)
        ?.supersedesTaskId,
    ).toBe(targetTask.id);

    // 详情透出。
    const detail = await app.request(
      `/api/groups/${group.id}/tasks/${task.id}`,
    );
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as Task).supersedesTaskId).toBe(
      targetTask.id,
    );
  });

  it("不传 supersedesTaskId 时保持 null(列表与详情透出 null)", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const response = await createTask(
      coordinator.id,
      group.id,
      uuidv4(),
      execA.id,
    );
    expect(response.status).toBe(200);
    const task = (await response.json()) as Task;
    expect(task.supersedesTaskId).toBeNull();

    const detail = await app.request(
      `/api/groups/${group.id}/tasks/${task.id}`,
    );
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as Task).supersedesTaskId).toBeNull();
  });

  it("指向跨群任务 → 400,不落库", async () => {
    const { coordinator, execA, group } = await setupGroup();
    // 另一个群里的任务。
    const otherGroup = await createGroup(coordinator.id, "跨群任务测试");
    const other = await createTask(
      coordinator.id,
      otherGroup.id,
      uuidv4(),
      execA.id,
    );
    const otherTask = (await other.json()) as Task;
    const newMessageId = uuidv4();

    const response = await app.request(`/api/groups/${group.id}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinator.id,
      },
      body: JSON.stringify({
        messageId: newMessageId,
        executorParticipantId: execA.id,
        supersedesTaskId: otherTask.id,
      }),
    });
    expect(response.status).toBe(400);
    const error = (await response.json()) as { message: string };
    expect(error.message).toContain("supersedesTaskId");

    const list = await app.request(`/api/groups/${group.id}/tasks`);
    expect(list.status).toBe(200);
    expect(
      ((await list.json()) as Task[]).some(
        (entry) => entry.messageId === newMessageId,
      ),
    ).toBe(false);
  });

  it("指向同群仍 running 的任务 → 放行(不校验终态)", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const target = await createTask(
      coordinator.id,
      group.id,
      uuidv4(),
      execA.id,
    );
    const targetTask = (await target.json()) as Task;
    // 用执行器身份 PATCH 到 running(模拟已确认挂死、仍在 running 的原任务)。
    const patch = await patchTask(execA.id, group.id, targetTask.id, {
      status: "running",
    });
    expect(patch.status).toBe(200);

    const created = await app.request(`/api/groups/${group.id}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinator.id,
      },
      body: JSON.stringify({
        messageId: uuidv4(),
        executorParticipantId: execA.id,
        supersedesTaskId: targetTask.id,
      }),
    });
    expect(created.status).toBe(200);
    expect(((await created.json()) as Task).supersedesTaskId).toBe(
      targetTask.id,
    );
  });

  it("不同 message_id 各自建独立任务;列表按创建时间倒序", async () => {
    const { coordinator, execA, group } = await setupGroup();

    const m1 = "00000000-0000-7000-8000-000000000011";
    const m2 = "00000000-0000-7000-8000-000000000012";
    await createTask(coordinator.id, group.id, m1, execA.id);
    await createTask(coordinator.id, group.id, m2, execA.id);

    const res = await app.request(`/api/groups/${group.id}/tasks`, {
      headers: { "X-Participant-Id": coordinator.id },
    });
    expect(res.status).toBe(200);
    const tasks = (await res.json()) as Task[];
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.messageId)).toEqual([m2, m1]); // 新的在前
  });

  it("POST 校验:群不存在 404、执行器不存在 404", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const messageId = "00000000-0000-7000-8000-000000000021";

    const noGroup = await createTask(
      coordinator.id,
      "00000000-0000-7000-8000-0000000000ff",
      messageId,
      execA.id,
    );
    expect(noGroup.status).toBe(404);

    const noParticipant = await createTask(
      coordinator.id,
      group.id,
      messageId,
      "00000000-0000-7000-8000-0000000000ee",
    );
    expect(noParticipant.status).toBe(404);
  });

  it("PATCH 权限:非所属 executor 更新 403,所属 executor 可流转状态", async () => {
    const { coordinator, execA, execB, group } = await setupGroup();
    const messageId = "00000000-0000-7000-8000-000000000031";

    const created = await createTask(
      coordinator.id,
      group.id,
      messageId,
      execA.id,
    );
    const task = (await created.json()) as Task;

    // 其他 participant(execB)无权更新 → 403。
    const forbidden = await app.request(
      `/api/groups/${group.id}/tasks/${task.id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": execB.id,
        },
        body: JSON.stringify({ status: "done" }),
      },
    );
    expect(forbidden.status).toBe(403);

    // 所属 executor(execA)可更新 → done。
    const done = await app.request(`/api/groups/${group.id}/tasks/${task.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": execA.id,
      },
      body: JSON.stringify({ status: "done" }),
    });
    expect(done.status).toBe(200);
    const updated = (await done.json()) as Task;
    expect(updated.status).toBe("done");
  });

  it("状态流转:running → failed / cancelled;终态 PATCH 必须携带原因", async () => {
    const { coordinator, execA, group } = await setupGroup();

    // failed
    const m1 = "00000000-0000-7000-8000-000000000041";
    const t1 = (await (
      await createTask(coordinator.id, group.id, m1, execA.id)
    ).json()) as Task;
    const missingFailureReason = await app.request(
      `/api/groups/${group.id}/tasks/${t1.id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": execA.id,
        },
        body: JSON.stringify({ status: "failed" }),
      },
    );
    expect(missingFailureReason.status).toBe(400);

    await withFreshRuntime(async () => {
      const fail = await app.request(`/api/groups/${group.id}/tasks/${t1.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": execA.id,
        },
        body: JSON.stringify({
          status: "failed",
          diffSummary: { error: "执行器返回非零退出码" },
        }),
      });
      expect(fail.status).toBe(200);
      expect(((await fail.json()) as Task).diffSummary).toEqual({
        error: "执行器返回非零退出码",
      });
    });

    // cancelled + checkpointRef + diffSummary 一起写
    const m2 = "00000000-0000-7000-8000-000000000042";
    const t2 = (await (
      await createTask(coordinator.id, group.id, m2, execA.id)
    ).json()) as Task;
    const missingCancellationReason = await app.request(
      `/api/groups/${group.id}/tasks/${t2.id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": execA.id,
        },
        body: JSON.stringify({ status: "cancelled" }),
      },
    );
    expect(missingCancellationReason.status).toBe(400);

    const patch = await app.request(`/api/groups/${group.id}/tasks/${t2.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": execA.id,
      },
      body: JSON.stringify({
        status: "cancelled",
        checkpointRef: "refs/coagenthub-cp/xyz",
        diffSummary: {
          error: "协调者主动取消",
          hash: "abc123",
          diffStat: "1 file changed",
        },
      }),
    });
    expect(patch.status).toBe(200);
    const updated = (await patch.json()) as Task;
    expect(updated.status).toBe("cancelled");
    expect(updated.checkpointRef).toBe("refs/coagenthub-cp/xyz");
    expect(updated.diffSummary).toEqual({
      error: "协调者主动取消",
      hash: "abc123",
      diffStat: "1 file changed",
    });

    // 空 PATCH(无任何字段)→ 400(校验拒绝)。
    const empty = await app.request(`/api/groups/${group.id}/tasks/${t2.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": execA.id,
      },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);

    // 非法状态 → 400。
    const badStatus = await app.request(
      `/api/groups/${group.id}/tasks/${t2.id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": execA.id,
        },
        body: JSON.stringify({ status: "exploded" }),
      },
    );
    expect(badStatus.status).toBe(400);
  });

  it("PATCH 不存在/其他群的任务 → 404", async () => {
    const { coordinator, execA, group } = await setupGroup();

    const missing = await app.request(
      `/api/groups/${group.id}/tasks/00000000-0000-7000-8000-0000000000dd`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": execA.id,
        },
        body: JSON.stringify({ status: "done" }),
      },
    );
    expect(missing.status).toBe(404);

    // 另一个群的 id 查不到本群任务。
    const other = await createGroup(coordinator.id, "另一个群");
    const cross = await app.request(
      `/api/groups/${other.id}/tasks/00000000-0000-7000-8000-0000000000dd`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": execA.id,
        },
        body: JSON.stringify({ status: "done" }),
      },
    );
    expect(cross.status).toBe(404);
  });

  it("非成员访问任务端点:POST 403、GET 只读放开 200(LAN trust,与 GET /messages 一致)", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const outsider = await registerParticipant({
      name: "outsider",
    });

    // 非成员 POST /tasks → 403(写操作权限不变)。
    const post = await createTask(
      outsider.id,
      group.id,
      "00000000-0000-7000-8000-000000000051",
      execA.id,
    );
    expect(post.status).toBe(403);

    // 非成员 GET /tasks → 200:读任务列表不再要求成员身份(只读放开)。
    const get = await app.request(`/api/groups/${group.id}/tasks`, {
      headers: { "X-Participant-Id": outsider.id },
    });
    expect(get.status).toBe(200);

    // 群不存在 → 404(与 GET /messages 相同的边界)。
    const missing = await app.request(
      `/api/groups/00000000-0000-7000-8000-0000000000ff/tasks`,
      {
        headers: { "X-Participant-Id": outsider.id },
      },
    );
    expect(missing.status).toBe(404);
  });

  /** 发一条真实消息,返回消息 id(供任务书快照测试使用)。 */
  async function postMessage(
    participantId: string,
    groupId: string,
    body: string,
  ) {
    const res = await app.request(`/api/groups/${groupId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": participantId,
      },
      body: JSON.stringify({ body }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
  }

  it("任务书快照:POST /tasks 时 brief=触发消息 body,GET 返回 brief", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const msg = await postMessage(coordinator.id, group.id, "原始任务书正文");

    const created = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      execA.id,
    );
    expect(created.status).toBe(200);
    const task = (await created.json()) as Task;
    expect(task.brief).toBe("原始任务书正文");

    // GET /tasks 列表同样带 brief。
    const list = await app.request(`/api/groups/${group.id}/tasks`, {
      headers: { "X-Participant-Id": coordinator.id },
    });
    expect(list.status).toBe(200);
    const tasks = (await list.json()) as Task[];
    const found = tasks.find((t) => t.id === task.id);
    expect(found?.brief).toBe("原始任务书正文");
  });

  it("任务书快照:消息编辑/软删除后,已建 task 的 brief 保持触发时原文", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const msg = await postMessage(coordinator.id, group.id, "快照原文 A");

    const created = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      execA.id,
    );
    const task = (await created.json()) as Task;
    expect(task.brief).toBe("快照原文 A");

    // 编辑消息正文 → brief 不变。
    const editRes = await app.request(
      `/api/groups/${group.id}/messages/${msg.id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": coordinator.id,
        },
        body: JSON.stringify({ body: "编辑后的新正文" }),
      },
    );
    expect(editRes.status).toBe(200);

    // 软删除消息 → brief 不变。
    const delRes = await app.request(
      `/api/groups/${group.id}/messages/${msg.id}`,
      {
        method: "DELETE",
        headers: { "X-Participant-Id": coordinator.id },
      },
    );
    expect(delRes.status).toBe(200);

    const list = await app.request(`/api/groups/${group.id}/tasks`, {
      headers: { "X-Participant-Id": coordinator.id },
    });
    const tasks = (await list.json()) as Task[];
    const found = tasks.find((t) => t.id === task.id);
    expect(found?.brief).toBe("快照原文 A");
  });

  it("PATCH 任务不接受改 brief(只读字段)→ 400", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const created = await createTask(
      coordinator.id,
      group.id,
      "00000000-0000-7000-8000-000000000061",
      execA.id,
    );
    const task = (await created.json()) as Task;

    const res = await app.request(`/api/groups/${group.id}/tasks/${task.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": execA.id,
      },
      body: JSON.stringify({ status: "done", brief: "篡改任务书" }),
    });
    expect(res.status).toBe(400);

    // brief 未被写入。
    const list = await app.request(`/api/groups/${group.id}/tasks`, {
      headers: { "X-Participant-Id": coordinator.id },
    });
    const tasks = (await list.json()) as Task[];
    const found = tasks.find((t) => t.id === task.id);
    expect(found?.brief).toBeNull();
    expect(found?.status).toBe("queued");
  });

  it("协调者修改 queued 任务 brief 成功,列表/详情返回新 brief", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const created = await createTask(
      coordinator.id,
      group.id,
      "00000000-0000-7000-8000-000000000062",
      execA.id,
    );
    const task = (await created.json()) as Task;

    // 任务创建即为 queued;此处再 PATCH queued 验证执行器可流转状态(幂等)。
    const toQueued = await patchTask(execA.id, group.id, task.id, {
      status: "queued",
    });
    expect(toQueued.status).toBe(200);

    // 协调者(群主)修改 brief → 200,返回最新行且状态未变。
    const res = await patchTask(coordinator.id, group.id, task.id, {
      brief: "更正后的任务书",
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Task;
    expect(updated.brief).toBe("更正后的任务书");
    expect(updated.status).toBe("queued");

    // 列表读到新 brief。
    const list = await app.request(`/api/groups/${group.id}/tasks`, {
      headers: { "X-Participant-Id": coordinator.id },
    });
    const tasks = (await list.json()) as Task[];
    expect(tasks.find((t) => t.id === task.id)?.brief).toBe("更正后的任务书");

    // 详情读到新 brief。
    const detail = await app.request(
      `/api/groups/${group.id}/tasks/${task.id}`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as Task).brief).toBe("更正后的任务书");

    // 执行器原有 PATCH 行为不回归:协调者改完 brief 后执行器仍可流转状态。
    const done = await patchTask(execA.id, group.id, task.id, {
      status: "done",
    });
    expect(done.status).toBe(200);
    expect(((await done.json()) as Task).status).toBe("done");
  });

  it("协调者修改 running/done/failed 任务 brief → 409", async () => {
    const { coordinator, execA, group } = await setupGroup();

    // running:建任务后由执行器 PATCH 置为 running。
    const tRunning = (await (
      await createTask(
        coordinator.id,
        group.id,
        "00000000-0000-7000-8000-000000000063",
        execA.id,
      )
    ).json()) as Task;
    await patchTask(execA.id, group.id, tRunning.id, { status: "running" });
    const r1 = await patchTask(coordinator.id, group.id, tRunning.id, {
      brief: "x",
    });
    expect(r1.status).toBe(409);
    expect(((await r1.json()) as { message: string }).message).toBe(
      "仅排队中的任务可修改任务书",
    );

    // done。
    const tDone = (await (
      await createTask(
        coordinator.id,
        group.id,
        "00000000-0000-7000-8000-000000000064",
        execA.id,
      )
    ).json()) as Task;
    await patchTask(execA.id, group.id, tDone.id, { status: "done" });
    const r2 = await patchTask(coordinator.id, group.id, tDone.id, {
      brief: "x",
    });
    expect(r2.status).toBe(409);

    // failed。
    const tFailed = (await (
      await createTask(
        coordinator.id,
        group.id,
        "00000000-0000-7000-8000-000000000065",
        execA.id,
      )
    ).json()) as Task;
    await patchTask(execA.id, group.id, tFailed.id, {
      status: "failed",
      diffSummary: { error: "执行器失败" },
    });
    const r3 = await patchTask(coordinator.id, group.id, tFailed.id, {
      brief: "x",
    });
    expect(r3.status).toBe(409);
  });

  it("非协调者/非执行器(observer 成员)修改 brief → 403 且不落库", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const observer = await registerParticipant({ name: "observer-1" });
    const addMember = await app.request(`/api/groups/${group.id}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinator.id,
      },
      body: JSON.stringify({ participantId: observer.id, roles: ["observer"] }),
    });
    expect(addMember.status).toBe(200);

    const created = await createTask(
      coordinator.id,
      group.id,
      "00000000-0000-7000-8000-000000000066",
      execA.id,
    );
    const task = (await created.json()) as Task;
    await patchTask(execA.id, group.id, task.id, { status: "queued" });

    // observer 成员既非协调者也非执行器 → 403。
    const res = await patchTask(observer.id, group.id, task.id, {
      brief: "越权改写",
    });
    expect(res.status).toBe(403);

    // brief 未被写入。
    const detail = await app.request(
      `/api/groups/${group.id}/tasks/${task.id}`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    expect(((await detail.json()) as Task).brief).toBeNull();
  });

  it("执行器本人修改 brief 仍被拒绝(只读保留)→ 400 且不落库", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const created = await createTask(
      coordinator.id,
      group.id,
      "00000000-0000-7000-8000-000000000067",
      execA.id,
    );
    const task = (await created.json()) as Task;

    // 执行器单独改 brief → 400(旧 superRefine 行为保留)。
    const res = await patchTask(execA.id, group.id, task.id, {
      brief: "执行器改写",
    });
    expect(res.status).toBe(400);

    // brief 未被写入。
    const list = await app.request(`/api/groups/${group.id}/tasks`, {
      headers: { "X-Participant-Id": coordinator.id },
    });
    const tasks = (await list.json()) as Task[];
    expect(tasks.find((t) => t.id === task.id)?.brief).toBeNull();
  });

  it("GET 单任务:返回任务完整详情(含 brief/checkpointRef/retryCount/diffSummary)", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const msg = await postMessage(coordinator.id, group.id, "单查任务书");
    const created = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      execA.id,
    );
    const task = (await created.json()) as Task;

    const res = await app.request(`/api/groups/${group.id}/tasks/${task.id}`, {
      headers: { "X-Participant-Id": coordinator.id },
    });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as Record<string, unknown>;
    expect(detail.id).toBe(task.id);
    expect(detail.groupId).toBe(group.id);
    expect(detail.messageId).toBe(msg.id);
    expect(detail.executorParticipantId).toBe(execA.id);
    expect(detail.executorKey).toBeNull(); // POST /tasks 未写 executorKey
    expect(detail.brief).toBe("单查任务书");
    expect(detail.status).toBe("queued");
    expect(detail.checkpointRef).toBeNull();
    expect(detail.retryCount).toBe(0);
    expect(detail.diffSummary).toBeNull();
    expect(typeof detail.createdAt).toBe("string");
    expect(typeof detail.updatedAt).toBe("string");
    // 未请求 includeOutput 时不带 outputTail 字段。
    expect("outputTail" in detail).toBe(false);
  });

  it("GET 单任务 includeOutput=1:running 任务附内存 outputTail(有缓冲时)", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const created = await createTask(
      coordinator.id,
      group.id,
      "00000000-0000-7000-8000-000000000071",
      execA.id,
    );
    const task = (await created.json()) as Task;

    // 无缓冲(未 spawn)→ outputTail 为 null 而非缺失。
    const res = await app.request(
      `/api/groups/${group.id}/tasks/${task.id}?includeOutput=1`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    expect(res.status).toBe(200);
    const detail = (await res.json()) as Record<string, unknown>;
    expect(detail.outputTail).toBeNull();

    // 通过 PATCH 写入 diffSummary.outputTail → includeOutput=1 回填返回。
    const patched = await app.request(
      `/api/groups/${group.id}/tasks/${task.id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": execA.id,
        },
        body: JSON.stringify({
          diffSummary: { outputTail: "tail line 1\ntail line 2" },
        }),
      },
    );
    expect(patched.status).toBe(200);

    const res2 = await app.request(
      `/api/groups/${group.id}/tasks/${task.id}?includeOutput=1`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    const detail2 = (await res2.json()) as Record<string, unknown>;
    expect(detail2.outputTail).toBe("tail line 1\ntail line 2");
  });

  it("GET 单任务:detached 超过 30 分钟无信号时标记需要关注", async () => {
    const { coordinator, group } = await setupGroup();
    const message = await postMessage(coordinator.id, group.id, "悬空协调任务");
    const created = await createTask(
      coordinator.id,
      group.id,
      message.id,
      coordinator.id,
    );
    const task = (await created.json()) as Task;
    expect(
      (
        await patchTask(coordinator.id, group.id, task.id, {
          status: "running",
        })
      ).status,
    ).toBe(200);

    const stale = new Date(Date.now() - 30 * 60 * 1000 - 1000);
    await testDb
      .update(taskTable)
      .set({ createdAt: stale, updatedAt: stale })
      .where(eq(taskTable.id, task.id));

    const response = await app.request(
      `/api/groups/${group.id}/tasks/${task.id}`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    const detail = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(detail.status).toBe("running");
    expect(detail.livenessWarning).toBe(true);
    expect(detail.lastSignalAt).toBe(stale.toISOString());
  });

  it("GET 单任务:detached 的 outputTail 更新会刷新存活判定", async () => {
    const { coordinator, group } = await setupGroup();
    const message = await postMessage(
      coordinator.id,
      group.id,
      "输出中的协调任务",
    );
    const created = await createTask(
      coordinator.id,
      group.id,
      message.id,
      coordinator.id,
    );
    const task = (await created.json()) as Task;
    await patchTask(coordinator.id, group.id, task.id, { status: "running" });
    const stale = new Date(Date.now() - 30 * 60 * 1000 - 1000);
    await testDb
      .update(taskTable)
      .set({ createdAt: stale, updatedAt: stale })
      .where(eq(taskTable.id, task.id));
    appendTaskOutput(task.id, "仍在工作");

    try {
      const response = await app.request(
        `/api/groups/${group.id}/tasks/${task.id}`,
        { headers: { "X-Participant-Id": coordinator.id } },
      );
      const detail = (await response.json()) as Record<string, unknown>;
      expect(response.status).toBe(200);
      expect(detail.livenessWarning).toBe(false);
      expect(new Date(String(detail.lastSignalAt)).getTime()).toBeGreaterThan(
        stale.getTime(),
      );
    } finally {
      releaseTaskOutput(task.id);
    }
  });

  it("GET 单任务:detached 新建子任务会刷新存活判定", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const message = await postMessage(
      coordinator.id,
      group.id,
      "派发中的协调任务",
    );
    const created = await createTask(
      coordinator.id,
      group.id,
      message.id,
      coordinator.id,
    );
    const task = (await created.json()) as Task;
    await patchTask(coordinator.id, group.id, task.id, { status: "running" });
    const stale = new Date(Date.now() - 30 * 60 * 1000 - 1000);
    await testDb
      .update(taskTable)
      .set({ createdAt: stale, updatedAt: stale })
      .where(eq(taskTable.id, task.id));

    const childMessage = await postMessage(
      coordinator.id,
      group.id,
      "子任务消息",
    );
    await testDb.insert(taskTable).values({
      groupId: group.id,
      parentTaskId: task.id,
      messageId: childMessage.id,
      executorParticipantId: execA.id,
      status: "queued",
    });

    const response = await app.request(
      `/api/groups/${group.id}/tasks/${task.id}`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    const detail = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(detail.livenessWarning).toBe(false);
    expect(new Date(String(detail.lastSignalAt)).getTime()).toBeGreaterThan(
      stale.getTime(),
    );
  });

  it("GET 单任务:detached 终态不参与存活探测", async () => {
    const { coordinator, group } = await setupGroup();
    const message = await postMessage(
      coordinator.id,
      group.id,
      "已结束协调任务",
    );
    const created = await createTask(
      coordinator.id,
      group.id,
      message.id,
      coordinator.id,
    );
    const task = (await created.json()) as Task;
    const done = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      // 悬空协调任务(本群无 reviewer,不触发 R2);以 noExecutionReason 走 R1 逃生舱。
      diffSummary: {
        noExecutionReason: "测试用悬空协调任务,无需下发执行器",
      },
    });
    expect(done.status).toBe(200);

    const stale = new Date(Date.now() - 30 * 60 * 1000 - 1000);
    await testDb
      .update(taskTable)
      .set({ createdAt: stale, updatedAt: stale })
      .where(eq(taskTable.id, task.id));
    const response = await app.request(
      `/api/groups/${group.id}/tasks/${task.id}`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    const detail = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(detail.status).toBe("done");
    expect(detail.livenessWarning).toBe(false);
    expect(detail.lastSignalAt).toBeNull();
  });

  it("GET 单任务:群不存在 404、任务不存在/属其他群 404", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const created = await createTask(
      coordinator.id,
      group.id,
      "00000000-0000-7000-8000-000000000081",
      execA.id,
    );
    const task = (await created.json()) as Task;

    const noGroup = await app.request(
      `/api/groups/00000000-0000-7000-8000-0000000000ff/tasks/${task.id}`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    expect(noGroup.status).toBe(404);

    const noTask = await app.request(
      `/api/groups/${group.id}/tasks/00000000-0000-7000-8000-0000000000dd`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    expect(noTask.status).toBe(404);

    // 其他群查本群任务 → 404。
    const other = await createGroup(coordinator.id, "另一个群(单查)");
    const cross = await app.request(
      `/api/groups/${other.id}/tasks/${task.id}`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    expect(cross.status).toBe(404);
  });

  it("PATCH 带真实 hash:diffSummary 写入核实结果(verified),任务照常 done", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const created = await createTask(
      coordinator.id,
      group.id,
      "00000000-0000-7000-8000-000000000091",
      execA.id,
    );
    const task = (await created.json()) as Task;
    // 种子 attempts(首次 spawn 窗口起点),使窗口校验有据可依。
    await testDb
      .update(taskTable)
      .set({
        attempts: [
          {
            n: 1,
            startedAt: new Date(0).toISOString(),
            status: "running",
          },
        ],
      })
      .where(eq(taskTable.id, task.id));
    // 测试仓库(setup.ts 的 COAGENTHUB_REPO_ROOT)HEAD 一定落在
    // [startedAt=epoch, now] 窗口内。
    const repoRoot = process.env.COAGENTHUB_REPO_ROOT;
    if (!repoRoot) throw new Error("COAGENTHUB_REPO_ROOT 未设置");
    const hash = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();

    const res = await patchTask(execA.id, group.id, task.id, {
      status: "done",
      diffSummary: { hash, summary: "PATCH 完成" },
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Task;
    expect(updated.status).toBe("done");
    const summary = updated.diffSummary as Record<string, unknown>;
    expect(summary.claimVerification).toMatchObject({
      status: "verified",
      hash,
    });
  });

  it("PATCH 带不存在的 hash:核实标记 not_found,任务仍照常终态不判 failed", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const created = await createTask(
      coordinator.id,
      group.id,
      "00000000-0000-7000-8000-000000000092",
      execA.id,
    );
    const task = (await created.json()) as Task;
    await testDb
      .update(taskTable)
      .set({
        attempts: [
          {
            n: 1,
            startedAt: new Date(0).toISOString(),
            status: "running",
          },
        ],
      })
      .where(eq(taskTable.id, task.id));

    const res = await patchTask(execA.id, group.id, task.id, {
      status: "done",
      diffSummary: { hash: "0123456789abcdef", summary: "PATCH 完成" },
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Task;
    expect(updated.status).toBe("done");
    const summary = updated.diffSummary as Record<string, unknown>;
    expect(summary.claimVerification).toMatchObject({
      status: "not_found",
      hash: "0123456789abcdef",
    });
  });

  it("PATCH 结案:平台已写 tokenUsage,载荷不含该键 → 保留原值", async () => {
    const { coordinator, group } = await setupGroup();
    const message = await postMessage(
      coordinator.id,
      group.id,
      "协调任务(平台 token)",
    );
    const created = await createTask(
      coordinator.id,
      group.id,
      message.id,
      coordinator.id,
    );
    const task = (await created.json()) as Task;
    // 模拟平台完成路径补写(queue.ts 同款语义)。
    await testDb
      .update(taskTable)
      .set({
        diffSummary: { tokenUsage: 279888, tokenUsageReason: "unavailable" },
      })
      .where(eq(taskTable.id, task.id));

    const done = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: {
        summary: "协调者结案",
        noExecutionReason: "无需下发执行器",
      },
    });
    expect(done.status).toBe(200);
    const summary = ((await done.json()) as Task).diffSummary as Record<
      string,
      unknown
    >;
    expect(summary.tokenUsage).toBe(279888);
    expect(summary.tokenUsageReason).toBe("unavailable");
    expect(summary.summary).toBe("协调者结案");
  });

  it("PATCH 结案:平台已写 tokenUsageReason,载荷不含该键 → 保留原值", async () => {
    const { coordinator, group } = await setupGroup();
    const message = await postMessage(
      coordinator.id,
      group.id,
      "协调任务(仅 reason)",
    );
    const created = await createTask(
      coordinator.id,
      group.id,
      message.id,
      coordinator.id,
    );
    const task = (await created.json()) as Task;
    await testDb
      .update(taskTable)
      .set({ diffSummary: { tokenUsageReason: "codex-unavailable" } })
      .where(eq(taskTable.id, task.id));

    const done = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: {
        summary: "结案",
        noExecutionReason: "无需下发执行器",
      },
    });
    expect(done.status).toBe(200);
    const summary = ((await done.json()) as Task).diffSummary as Record<
      string,
      unknown
    >;
    expect(summary.tokenUsageReason).toBe("codex-unavailable");
    expect(Object.hasOwn(summary, "tokenUsage")).toBe(false);
  });

  it("PATCH 结案:载荷显式提供 tokenUsage/tokenUsageReason → 以调用方为准", async () => {
    const { coordinator, group } = await setupGroup();
    const message = await postMessage(
      coordinator.id,
      group.id,
      "协调任务(显式 token)",
    );
    const created = await createTask(
      coordinator.id,
      group.id,
      message.id,
      coordinator.id,
    );
    const task = (await created.json()) as Task;
    await testDb
      .update(taskTable)
      .set({ diffSummary: { tokenUsage: 111, tokenUsageReason: "platform" } })
      .where(eq(taskTable.id, task.id));

    const done = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: {
        summary: "结案",
        noExecutionReason: "无需下发执行器",
        tokenUsage: 222,
        tokenUsageReason: "caller",
      },
    });
    expect(done.status).toBe(200);
    const summary = ((await done.json()) as Task).diffSummary as Record<
      string,
      unknown
    >;
    expect(summary.tokenUsage).toBe(222);
    expect(summary.tokenUsageReason).toBe("caller");
  });

  it("PATCH 结案:载荷显式传 null → 按 null 写入,不被保留逻辑覆盖", async () => {
    const { coordinator, group } = await setupGroup();
    const message = await postMessage(
      coordinator.id,
      group.id,
      "协调任务(显式 null)",
    );
    const created = await createTask(
      coordinator.id,
      group.id,
      message.id,
      coordinator.id,
    );
    const task = (await created.json()) as Task;
    await testDb
      .update(taskTable)
      .set({ diffSummary: { tokenUsage: 111, tokenUsageReason: "platform" } })
      .where(eq(taskTable.id, task.id));

    const done = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: {
        summary: "结案",
        noExecutionReason: "无需下发执行器",
        tokenUsage: null,
        tokenUsageReason: null,
      },
    });
    expect(done.status).toBe(200);
    const summary = ((await done.json()) as Task).diffSummary as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(summary, "tokenUsage")).toBe(true);
    expect(summary.tokenUsage).toBeNull();
    expect(Object.hasOwn(summary, "tokenUsageReason")).toBe(true);
    expect(summary.tokenUsageReason).toBeNull();
  });

  it("PATCH 结案:diffSummary 无 token 字段而 attempts 已采集 → 平台回填", async () => {
    const { coordinator, group } = await setupGroup();
    const message = await postMessage(
      coordinator.id,
      group.id,
      "协调任务(真实 detached 时序)",
    );
    const created = await createTask(
      coordinator.id,
      group.id,
      message.id,
      coordinator.id,
    );
    const task = (await created.json()) as Task;
    // 真实时序:平台只把采集结果写进 attempts,diffSummary 全程由协调者撰写
    // (任务结束即由协调者 PATCH 落终态,平台完成回填从未跑过)。
    await testDb
      .update(taskTable)
      .set({
        attempts: [
          {
            n: 1,
            startedAt: new Date(0).toISOString(),
            status: "done",
            tokenUsage: {
              inputTokens: 545000,
              outputTokens: 875,
              totalTokens: 545875,
              source: "codex-stdout-jsonl",
            },
          },
        ],
      })
      .where(eq(taskTable.id, task.id));

    const done = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: {
        summary: "协调者结案",
        noExecutionReason: "无需下发执行器",
      },
    });
    expect(done.status).toBe(200);
    const summary = ((await done.json()) as Task).diffSummary as Record<
      string,
      unknown
    >;
    // 与 queue.ts 完成回填同款汇总口径(含 cachedInputTokens 归零)。
    expect(summary.tokenUsage).toEqual({
      inputTokens: 545000,
      outputTokens: 875,
      cachedInputTokens: 0,
      totalTokens: 545875,
      source: "codex-stdout-jsonl",
    });
    expect(summary.summary).toBe("协调者结案");
  });

  it("PATCH 结案:attempts 只有 tokenUsageReason → 回填 reason", async () => {
    const { coordinator, group } = await setupGroup();
    const message = await postMessage(
      coordinator.id,
      group.id,
      "协调任务(attempts 仅 reason)",
    );
    const created = await createTask(
      coordinator.id,
      group.id,
      message.id,
      coordinator.id,
    );
    const task = (await created.json()) as Task;
    await testDb
      .update(taskTable)
      .set({
        attempts: [
          {
            n: 1,
            startedAt: new Date(0).toISOString(),
            status: "done",
            tokenUsage: null,
            tokenUsageReason: "unavailable",
          },
        ],
      })
      .where(eq(taskTable.id, task.id));

    const done = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: {
        summary: "结案",
        noExecutionReason: "无需下发执行器",
      },
    });
    expect(done.status).toBe(200);
    const summary = ((await done.json()) as Task).diffSummary as Record<
      string,
      unknown
    >;
    expect(summary.tokenUsageReason).toBe("unavailable");
    expect(summary.tokenUsage).toBeNull();
  });

  it("PATCH 结案:attempts 已采集但载荷显式提供(含 null)→ 调用方优先", async () => {
    const { coordinator, group } = await setupGroup();
    const message = await postMessage(
      coordinator.id,
      group.id,
      "协调任务(attempts 与显式载荷冲突)",
    );
    const created = await createTask(
      coordinator.id,
      group.id,
      message.id,
      coordinator.id,
    );
    const task = (await created.json()) as Task;
    await testDb
      .update(taskTable)
      .set({
        attempts: [
          {
            n: 1,
            startedAt: new Date(0).toISOString(),
            status: "done",
            tokenUsage: {
              inputTokens: 1,
              outputTokens: 2,
              totalTokens: 3,
              source: "attempts",
            },
          },
        ],
      })
      .where(eq(taskTable.id, task.id));

    const done = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: {
        summary: "结案",
        noExecutionReason: "无需下发执行器",
        tokenUsage: null,
        tokenUsageReason: null,
      },
    });
    expect(done.status).toBe(200);
    const summary = ((await done.json()) as Task).diffSummary as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(summary, "tokenUsage")).toBe(true);
    expect(summary.tokenUsage).toBeNull();
    expect(Object.hasOwn(summary, "tokenUsageReason")).toBe(true);
    expect(summary.tokenUsageReason).toBeNull();
  });

  it("PATCH 结案:token 字段保留与 claimVerification 写入并存(回归)", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const created = await createTask(
      coordinator.id,
      group.id,
      "00000000-0000-7000-8000-0000000000a1",
      execA.id,
    );
    const task = (await created.json()) as Task;
    await testDb
      .update(taskTable)
      .set({
        attempts: [
          {
            n: 1,
            startedAt: new Date(0).toISOString(),
            status: "running",
          },
        ],
        diffSummary: { tokenUsage: 777, tokenUsageReason: "platform" },
      })
      .where(eq(taskTable.id, task.id));
    const repoRoot = process.env.COAGENTHUB_REPO_ROOT;
    if (!repoRoot) throw new Error("COAGENTHUB_REPO_ROOT 未设置");
    const hash = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();

    const res = await patchTask(execA.id, group.id, task.id, {
      status: "done",
      diffSummary: { hash, summary: "PATCH 完成" },
    });
    expect(res.status).toBe(200);
    const summary = ((await res.json()) as Task).diffSummary as Record<
      string,
      unknown
    >;
    expect(summary.claimVerification).toMatchObject({
      status: "verified",
      hash,
    });
    expect(summary.tokenUsage).toBe(777);
    expect(summary.tokenUsageReason).toBe("platform");
  });
});
