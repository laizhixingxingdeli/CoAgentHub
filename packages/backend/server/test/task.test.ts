import { describe, expect, it } from "vitest";
import { createTestApp } from "./app";

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

  async function createTask(
    participantId: string,
    groupId: string,
    messageId: string,
    executorParticipantId: string,
    checkpointRef?: string,
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

  it("状态流转:running → failed / cancelled;diffSummary 可随 PATCH 写入", async () => {
    const { coordinator, execA, group } = await setupGroup();

    // failed
    const m1 = "00000000-0000-7000-8000-000000000041";
    const t1 = (await (
      await createTask(coordinator.id, group.id, m1, execA.id)
    ).json()) as Task;
    const fail = await app.request(`/api/groups/${group.id}/tasks/${t1.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": execA.id,
      },
      body: JSON.stringify({ status: "failed" }),
    });
    expect(fail.status).toBe(200);
    expect(((await fail.json()) as Task).status).toBe("failed");

    // cancelled + checkpointRef + diffSummary 一起写
    const m2 = "00000000-0000-7000-8000-000000000042";
    const t2 = (await (
      await createTask(coordinator.id, group.id, m2, execA.id)
    ).json()) as Task;
    const patch = await app.request(`/api/groups/${group.id}/tasks/${t2.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": execA.id,
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
    await patchTask(execA.id, group.id, tFailed.id, { status: "failed" });
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
});
