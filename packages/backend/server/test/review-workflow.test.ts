import { describe, expect, it } from "vitest";
import { createTestApp } from "./app";

/**
 * Review workflow protocol (ticket 04): an acceptance script that walks the
 * whole review flow over the public API with four identities — coordinator
 * (hermes on mac), reviewer (hermes on win), executor (atomcode), and a human
 * observer. It proves the protocol convention, not a workflow engine:
 *
 *   draft          = audience role:reviewer        (coordinator → reviewer)
 *   review opinion = child message of the draft    (reviewer → coordinator)
 *   final version  = audience role:executor        (coordinator → executor)
 *   execution      = broadcast                     (executor → everyone)
 *
 * Acceptance core: the executor never sees the draft or the review opinion
 * (only the final version), the review opinion hangs off the draft as a child
 * message (parentId), and the human member sees the entire thread.
 */
describe("检视流程协议(ticket 04)", () => {
  const app = createTestApp();

  async function registerParticipant(body: Record<string, unknown>) {
    const res = await app.request("/api/participants", {
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

  async function addMember(
    token: string,
    groupId: string,
    participantId: string,
    roles: string[],
  ) {
    const res = await app.request(`/api/groups/${groupId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ participantId, roles }),
    });
    expect(res.status).toBe(200);
  }

  async function sendMessage(
    token: string,
    groupId: string,
    body: Record<string, unknown>,
  ) {
    const res = await app.request(`/api/groups/${groupId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as MessageItem;
  }

  type MessageItem = {
    id: string;
    groupId: string;
    senderId: string;
    parentId: string | null;
    audience: "broadcast" | "role" | "participant";
    audienceRef: string | null;
    body: string;
    depth: number;
    createdAt: string;
  };

  /** Incremental pull: no cursor returns the caller's full visible history. */
  async function fetchMessages(token: string, groupId: string, after?: string) {
    const res = await app.request(
      `/api/groups/${groupId}/messages${after ? `?after=${after}` : ""}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(200);
    return (await res.json()) as MessageItem[];
  }

  it("完整流程:草稿→检视意见→最终版→执行结果,executor 只见最终版,human 全可见", async () => {
    // 演员表:coordinator(hermes/mac)、reviewer(hermes/win)、executor(atomcode)、human 观察者
    const coordinator = await registerParticipant({
      name: "hermes",
      device: "mac",
    });
    const reviewer = await registerParticipant({
      name: "hermes",
      device: "win",
    });
    const executor = await registerParticipant({
      name: "atomcode",
    });
    const human = await registerParticipant({ name: "alice" });

    // 建群:coordinator 自动成为 coordinator 成员;再添加 reviewer/executor/human
    const group = await createGroup(coordinator.token, "模型训练任务");
    await addMember(coordinator.token, group.id, reviewer.id, ["reviewer"]);
    await addMember(coordinator.token, group.id, executor.id, ["executor"]);
    await addMember(coordinator.token, group.id, human.id, ["human"]);

    // a. coordinator 发草稿,audience=role:reviewer
    const draft = await sendMessage(coordinator.token, group.id, {
      body: "草稿:训练一个 7B 模型,请评审",
      audience: "role",
      audienceRef: "reviewer",
    });
    expect(draft.audience).toBe("role");
    expect(draft.audienceRef).toBe("reviewer");
    expect(draft.parentId).toBeNull();
    expect(draft.depth).toBe(0);

    // b. reviewer 拉取:只见草稿;以草稿为父发检视意见,回给 coordinator
    const reviewerSeen = await fetchMessages(reviewer.token, group.id);
    expect(reviewerSeen.map((m) => m.body)).toEqual([draft.body]);

    const review = await sendMessage(reviewer.token, group.id, {
      body: "检视意见:数据增强部分需要补充清洗步骤",
      parentId: draft.id,
      audience: "role",
      audienceRef: "coordinator",
    });
    // 验收:检视意见是草稿的子消息(树关系正确)
    expect(review.parentId).toBe(draft.id);
    expect(review.depth).toBe(1);

    // c. coordinator 拉取:可见草稿+检视意见;采纳后发最终版,audience=role:executor
    const coordSeen = await fetchMessages(coordinator.token, group.id);
    expect(coordSeen.map((m) => m.body)).toEqual([draft.body, review.body]);

    const final = await sendMessage(coordinator.token, group.id, {
      body: "最终版:训练 7B 模型(含数据清洗)",
      audience: "role",
      audienceRef: "executor",
    });
    expect(final.audience).toBe("role");
    expect(final.audienceRef).toBe("executor");

    // d. executor 增量拉取(无游标=拉取全部可见历史):从未见过草稿与检视意见,只见最终版
    const executorSeen = await fetchMessages(executor.token, group.id);
    const executorBodies = executorSeen.map((m) => m.body);
    // 验收核心:草稿与检视意见不在 executor 的可见消息集合中
    expect(executorBodies).not.toContain(draft.body);
    expect(executorBodies).not.toContain(review.body);
    expect(executorBodies).toEqual([final.body]);
    // 增量语义:以最终版为游标继续拉,没有新消息
    const afterFinal = await fetchMessages(executor.token, group.id, final.id);
    expect(afterFinal).toEqual([]);

    // e. executor 发执行结果(broadcast)
    const result = await sendMessage(executor.token, group.id, {
      body: "执行完成,loss 0.02,模型已保存",
      audience: "broadcast",
    });
    expect(result.audience).toBe("broadcast");
    expect(result.parentId).toBeNull();

    // f. human 拉取:可见全部 4 条(草稿/检视意见/最终版/执行结果)——用户要看全过程
    const humanSeen = await fetchMessages(human.token, group.id);
    const humanBodies = humanSeen.map((m) => m.body);
    expect(humanBodies).toHaveLength(4);
    expect(humanBodies).toEqual([
      draft.body,
      review.body,
      final.body,
      result.body,
    ]);
  });
});
