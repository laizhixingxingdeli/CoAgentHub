import { describe, expect, it } from "vitest";
import { createTestApp } from "./app";

/**
 * Task first-class entity (ticket 35): the server is the single source of
 * truth for task lifecycle — the bridge creates a row before spawning its
 * CLI and patches status/diffSummary when the run finishes.
 *
 * Covered here: idempotent creation (the same message_id only ever yields one
 * task), PATCH permission (only the owning executor agent may update; anyone
 * else is 403), and the running -> done / failed / cancelled transitions.
 */
describe("任务实体(server 单一状态源)", () => {
  const app = createTestApp();

  async function registerAgent(body: Record<string, unknown>) {
    const res = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const { id, token } = (await res.json()) as { id: string; token: string };
    return { id, token };
  }

  async function createGroup(token: string, title: string) {
    const res = await app.request("/api/groups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
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
    executorAgentId: string;
    status: "running" | "done" | "failed" | "cancelled";
    checkpointRef: string | null;
    diffSummary: unknown;
    createdAt: string;
    updatedAt: string | null;
  };

  async function createTask(
    token: string,
    groupId: string,
    messageId: string,
    executorAgentId: string,
    checkpointRef?: string,
  ) {
    return app.request(`/api/groups/${groupId}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messageId,
        executorAgentId,
        ...(checkpointRef !== undefined ? { checkpointRef } : {}),
      }),
    });
  }

  /** A group with coordinator + two executor agents. */
  async function setupGroup() {
    const coordinator = await registerAgent({
      name: "coord-mac",
      type: "hermes",
    });
    const execA = await registerAgent({ name: "executor-a", type: "atomcode" });
    const execB = await registerAgent({ name: "executor-b", type: "atomcode" });
    const group = await createGroup(coordinator.token, "任务实体测试");
    return { coordinator, execA, execB, group };
  }

  it("同 message_id 重复 POST 返回同一任务(幂等创建)", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const messageId = "00000000-0000-7000-8000-000000000001";

    const res1 = await createTask(
      coordinator.token,
      group.id,
      messageId,
      execA.id,
    );
    expect(res1.status).toBe(200);
    const t1 = (await res1.json()) as Task;
    expect(t1.status).toBe("running");
    expect(t1.executorAgentId).toBe(execA.id);
    expect(t1.checkpointRef).toBeNull();

    const res2 = await createTask(
      coordinator.token,
      group.id,
      messageId,
      execA.id,
    );
    expect(res2.status).toBe(200);
    const t2 = (await res2.json()) as Task;
    expect(t2.id).toBe(t1.id);
    expect(t2.messageId).toBe(messageId);
  });

  it("不同 message_id 各自建独立任务;列表按创建时间倒序", async () => {
    const { coordinator, execA, group } = await setupGroup();

    const m1 = "00000000-0000-7000-8000-000000000011";
    const m2 = "00000000-0000-7000-8000-000000000012";
    await createTask(coordinator.token, group.id, m1, execA.id);
    await createTask(coordinator.token, group.id, m2, execA.id);

    const res = await app.request(`/api/groups/${group.id}/tasks`, {
      headers: { Authorization: `Bearer ${coordinator.token}` },
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
      coordinator.token,
      "00000000-0000-7000-8000-0000000000ff",
      messageId,
      execA.id,
    );
    expect(noGroup.status).toBe(404);

    const noAgent = await createTask(
      coordinator.token,
      group.id,
      messageId,
      "00000000-0000-7000-8000-0000000000ee",
    );
    expect(noAgent.status).toBe(404);
  });

  it("PATCH 权限:非所属 executor 更新 403,所属 executor 可流转状态", async () => {
    const { coordinator, execA, execB, group } = await setupGroup();
    const messageId = "00000000-0000-7000-8000-000000000031";

    const created = await createTask(
      coordinator.token,
      group.id,
      messageId,
      execA.id,
    );
    const task = (await created.json()) as Task;

    // 其他 agent(execB)无权更新 → 403。
    const forbidden = await app.request(
      `/api/groups/${group.id}/tasks/${task.id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${execB.token}`,
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
        Authorization: `Bearer ${execA.token}`,
      },
      body: JSON.stringify({ status: "done" }),
    });
    expect(done.status).toBe(200);
    const updated = (await done.json()) as Task;
    expect(updated.status).toBe("done");
  });

  it("状态流转:running → failed / cancelled;diffSummary 可随 PATCH 写入", async () => {
    const { coordinator, execA, group } = await setupGroup();

    // failed
    const m1 = "00000000-0000-7000-8000-000000000041";
    const t1 = (await (
      await createTask(coordinator.token, group.id, m1, execA.id)
    ).json()) as Task;
    const fail = await app.request(`/api/groups/${group.id}/tasks/${t1.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${execA.token}`,
      },
      body: JSON.stringify({ status: "failed" }),
    });
    expect(fail.status).toBe(200);
    expect(((await fail.json()) as Task).status).toBe("failed");

    // cancelled + checkpointRef + diffSummary 一起写
    const m2 = "00000000-0000-7000-8000-000000000042";
    const t2 = (await (
      await createTask(coordinator.token, group.id, m2, execA.id)
    ).json()) as Task;
    const patch = await app.request(`/api/groups/${group.id}/tasks/${t2.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${execA.token}`,
      },
      body: JSON.stringify({
        status: "cancelled",
        checkpointRef: "refs/coagenthub-cp/xyz",
        diffSummary: { hash: "abc123", diffStat: "1 file changed" },
      }),
    });
    expect(patch.status).toBe(200);
    const updated = (await patch.json()) as Task;
    expect(updated.status).toBe("cancelled");
    expect(updated.checkpointRef).toBe("refs/coagenthub-cp/xyz");
    expect(updated.diffSummary).toEqual({
      hash: "abc123",
      diffStat: "1 file changed",
    });

    // 空 PATCH(无任何字段)→ 400(校验拒绝)。
    const empty = await app.request(`/api/groups/${group.id}/tasks/${t2.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${execA.token}`,
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
          Authorization: `Bearer ${execA.token}`,
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
          Authorization: `Bearer ${execA.token}`,
        },
        body: JSON.stringify({ status: "done" }),
      },
    );
    expect(missing.status).toBe(404);

    // 另一个群的 id 查不到本群任务。
    const other = await createGroup(coordinator.token, "另一个群");
    const cross = await app.request(
      `/api/groups/${other.id}/tasks/00000000-0000-7000-8000-0000000000dd`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${execA.token}`,
        },
        body: JSON.stringify({ status: "done" }),
      },
    );
    expect(cross.status).toBe(404);
  });

  it("非成员访问任务端点:POST 403、GET 只读放开 200(LAN trust,与 GET /messages 一致)", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const outsider = await registerAgent({ name: "outsider", type: "custom" });

    // 非成员 POST /tasks → 403(写操作权限不变)。
    const post = await createTask(
      outsider.token,
      group.id,
      "00000000-0000-7000-8000-000000000051",
      execA.id,
    );
    expect(post.status).toBe(403);

    // 非成员 GET /tasks → 200:读任务列表不再要求成员身份(只读放开)。
    const get = await app.request(`/api/groups/${group.id}/tasks`, {
      headers: { Authorization: `Bearer ${outsider.token}` },
    });
    expect(get.status).toBe(200);

    // 群不存在 → 404(与 GET /messages 相同的边界)。
    const missing = await app.request(
      `/api/groups/00000000-0000-7000-8000-0000000000ff/tasks`,
      {
        headers: { Authorization: `Bearer ${outsider.token}` },
      },
    );
    expect(missing.status).toBe(404);
  });
});
