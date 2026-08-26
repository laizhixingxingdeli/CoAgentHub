import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./app";

describe("协作载荷 API 契约", () => {
  const app = createTestApp();

  async function register(name: string) {
    const response = await app.request("/api/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (response.status === 409) {
      const listResponse = await app.request("/api/participants");
      const list = (await listResponse.json()) as Array<{
        id: string;
        name: string;
      }>;
      const existing = list.find((participant) => participant.name === name);
      if (existing) return { id: existing.id };
    }
    expect(response.status).toBe(200);
    return (await response.json()) as { id: string };
  }

  async function setup() {
    const coordinator = await register(`payload-coordinator-${randomUUID()}`);
    const executor = await register(`payload-executor-${randomUUID()}`);
    const groupResponse = await app.request("/api/groups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinator.id,
      },
      body: JSON.stringify({ title: "协作载荷契约" }),
    });
    expect(groupResponse.status).toBe(200);
    return {
      coordinator,
      executor,
      group: (await groupResponse.json()) as { id: string },
    };
  }

  it("下发缺 specHash/剥离 callback 时用响应头发出可见信号", async () => {
    const owner = await register(`warning-owner-${randomUUID()}`);
    const sender = await register("AtomCode");
    const target = await register("CodeBuddy");
    const groupResponse = await app.request("/api/groups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": owner.id,
      },
      body: JSON.stringify({ title: "静默降级信号" }),
    });
    const group = (await groupResponse.json()) as { id: string };
    const add = (participantId: string, roles: string[]) =>
      app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": owner.id,
        },
        body: JSON.stringify({ participantId, roles }),
      });
    expect((await add(sender.id, ["reviewer"])).status).toBe(200);
    expect((await add(target.id, ["executor"])).status).toBe(200);
    const response = await app.request(`/api/groups/${group.id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": sender.id,
      },
      body: JSON.stringify({
        body: "下发",
        audience: "participant",
        audienceRef: target.id,
        callback: { sessionRef: "session-1" },
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-CoAgentHub-Warning")).toBe(
      "CALLBACK_STRIPPED_NOT_AUTHORIZED,SPEC_HASH_MISSING",
    );
    // The warning is synchronous, but task creation/spawn is intentionally
    // fire-and-forget. Drain the short-lived fake executor before PGlite closes.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const tasksResponse = await app.request(`/api/groups/${group.id}/tasks`);
      const tasks = (await tasksResponse.json()) as Array<{ status: string }>;
      if (
        tasks.some((task) =>
          ["done", "failed", "cancelled"].includes(task.status),
        )
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });

  it("两方与三方编制都提示缺 specHash,未传 callback 不产生剥离提示", async () => {
    const owner = await register(`warning-scope-owner-${randomUUID()}`);
    const target = await register("CodeBuddy");
    const reviewer = await register(`warning-scope-reviewer-${randomUUID()}`);

    const createGroup = (title: string) =>
      app.request("/api/groups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": owner.id,
        },
        body: JSON.stringify({ title }),
      });
    const addMember = (
      groupId: string,
      participantId: string,
      roles: string[],
    ) =>
      app.request(`/api/groups/${groupId}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": owner.id,
        },
        body: JSON.stringify({ participantId, roles }),
      });
    const postTask = (groupId: string) =>
      app.request(`/api/groups/${groupId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": owner.id,
        },
        body: JSON.stringify({
          body: "没有 callback 的指令驱动任务",
          audience: "participant",
          audienceRef: target.id,
        }),
      });

    const noReviewerGroup = (await (
      await createGroup("无 reviewer 信号范围")
    ).json()) as {
      id: string;
    };
    expect(
      (await addMember(noReviewerGroup.id, target.id, ["executor"])).status,
    ).toBe(200);
    const noReviewerResponse = await postTask(noReviewerGroup.id);
    expect(noReviewerResponse.status).toBe(200);
    expect(noReviewerResponse.headers.get("X-CoAgentHub-Warning")).toBe(
      "SPEC_HASH_MISSING",
    );

    const reviewerGroup = (await (
      await createGroup("有 reviewer 信号范围")
    ).json()) as {
      id: string;
    };
    expect(
      (await addMember(reviewerGroup.id, target.id, ["executor"])).status,
    ).toBe(200);
    expect(
      (await addMember(reviewerGroup.id, reviewer.id, ["reviewer"])).status,
    ).toBe(200);
    const reviewerResponse = await postTask(reviewerGroup.id);
    expect(reviewerResponse.status).toBe(200);
    expect(reviewerResponse.headers.get("X-CoAgentHub-Warning")).toBe(
      "SPEC_HASH_MISSING",
    );
  });

  it("消息自动派发路径落库 dispatchKind 与规范字段", async () => {
    const owner = await register(`dispatch-kind-owner-${randomUUID()}`);
    const target = await register("CodeBuddy");
    const groupResponse = await app.request("/api/groups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": owner.id,
      },
      body: JSON.stringify({ title: "消息自动派发规范字段" }),
    });
    const group = (await groupResponse.json()) as { id: string };
    const add = await app.request(`/api/groups/${group.id}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": owner.id,
      },
      body: JSON.stringify({ participantId: target.id, roles: ["executor"] }),
    });
    expect(add.status).toBe(200);

    const message = await app.request(`/api/groups/${group.id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": owner.id,
      },
      body: JSON.stringify({
        body: "带规范字段的自动派发",
        audience: "participant",
        audienceRef: target.id,
        specRef: "specs/dispatch-fields-silent-loss.md",
        specHash: "987f54a",
        dispatchKind: "requirement",
      }),
    });
    expect(message.status).toBe(200);
    const { id: messageId } = (await message.json()) as { id: string };

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const tasksResponse = await app.request(`/api/groups/${group.id}/tasks`);
      const tasks = (await tasksResponse.json()) as Array<{
        messageId: string;
        specRef: string | null;
        specHash: string | null;
        dispatchKind: string | null;
      }>;
      const task = tasks.find((entry) => entry.messageId === messageId);
      if (task) {
        expect(task.specRef).toBe("specs/dispatch-fields-silent-loss.md");
        expect(task.specHash).toBe("987f54a");
        expect(task.dispatchKind).toBe("requirement");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("消息自动派发任务未在预期时间内创建");
  });

  it("R5:自动派发已建空字段任务后显式补字段返回 409", async () => {
    const owner = await register(`silent-loss-owner-${randomUUID()}`);
    const target = await register("CodeBuddy");
    const groupResponse = await app.request("/api/groups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": owner.id,
      },
      body: JSON.stringify({ title: "验收钉子冲突" }),
    });
    const group = (await groupResponse.json()) as { id: string };
    const add = await app.request(`/api/groups/${group.id}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": owner.id,
      },
      body: JSON.stringify({ participantId: target.id, roles: ["executor"] }),
    });
    expect(add.status).toBe(200);

    const message = await app.request(`/api/groups/${group.id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": owner.id,
      },
      body: JSON.stringify({
        body: "先发消息再补任务字段",
        audience: "participant",
        audienceRef: target.id,
      }),
    });
    expect(message.status).toBe(200);
    const { id: messageId } = (await message.json()) as { id: string };

    let taskCreated = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const tasksResponse = await app.request(`/api/groups/${group.id}/tasks`);
      const tasks = (await tasksResponse.json()) as Array<{
        messageId: string;
      }>;
      if (tasks.some((task) => task.messageId === messageId)) {
        taskCreated = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(taskCreated).toBe(true);

    const explicit = await app.request(`/api/groups/${group.id}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": owner.id,
      },
      body: JSON.stringify({
        messageId,
        executorParticipantId: target.id,
        specRef: "specs/dispatch-fields-silent-loss.md",
        specHash: "987f54a",
        dispatchKind: "requirement",
      }),
    });
    expect(explicit.status).toBe(409);
    const error = (await explicit.json()) as { message: string };
    expect(error.message).toContain("specRef");
    expect(error.message).toContain("specHash");
    expect(error.message).toContain("dispatchKind");
  });

  it("群消息校验已知 type,但放行自由文本与未知 type", async () => {
    const { coordinator, group } = await setup();
    const post = (body: string) =>
      app.request(`/api/groups/${group.id}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": coordinator.id,
        },
        body: JSON.stringify({ body, contentType: "application/json" }),
      });

    const malformed = await post(JSON.stringify({ type: "spec_published" }));
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).message).toContain("specRef");
    expect((await post("not json")).status).toBe(200);
    expect(
      (await post(JSON.stringify({ type: "future_payload", value: 1 }))).status,
    ).toBe(200);
  });

  it("PATCH review_request 接受顶层/嵌套并统一落库形状", async () => {
    const { coordinator, executor, group } = await setup();
    const create = await app.request(`/api/groups/${group.id}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinator.id,
      },
      body: JSON.stringify({
        messageId: randomUUID(),
        executorParticipantId: executor.id,
      }),
    });
    expect(create.status).toBe(200);
    const task = (await create.json()) as { id: string };
    const request = {
      type: "review_request",
      layer: 3,
      taskId: task.id,
      specRef: "specs/x.md",
      specHash: "abc1234",
      diffSummary: "changed files",
    };
    const patch = (diffSummary: unknown) =>
      app.request(`/api/groups/${group.id}/tasks/${task.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": executor.id,
        },
        body: JSON.stringify({ diffSummary }),
      });

    const top = await patch(request);
    expect(top.status).toBe(200);
    expect((await top.json()).diffSummary).toEqual({ review_request: request });
    const nested = await patch({ review_request: request });
    expect(nested.status).toBe(200);
    expect((await nested.json()).diffSummary).toEqual({
      review_request: request,
    });
  });
});
