import {
  groupMessageClosure as closureTable,
  groupMessage as groupMessageTable,
} from "@laizhixingxingdeli/database/schema";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./app";
import { testDb } from "./db";

/**
 * Group message tree & audience routing (ticket 03): POST/GET messages with
 * sender + parentId + audience (broadcast|role|agent), visibility filtering
 * (human sees everything), incremental pull via ?after=, and closure-table
 * tree materialization.
 */
describe("群组消息树与受众路由", () => {
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

  async function addMember(
    token: string,
    groupId: string,
    agentId: string,
    roles: string[],
  ) {
    const res = await app.request(`/api/groups/${groupId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ agentId, roles }),
    });
    expect(res.status).toBe(200);
  }

  async function sendMessage(
    token: string,
    groupId: string,
    body: Record<string, unknown>,
  ) {
    return app.request(`/api/groups/${groupId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  }

  type MessageItem = {
    id: string;
    groupId: string;
    senderId: string;
    parentId: string | null;
    audience: "broadcast" | "role" | "agent";
    audienceRef: string | null;
    body: string;
    depth: number;
    createdAt: string;
  };

  async function fetchMessages(token: string, groupId: string, after?: string) {
    const res = await app.request(
      `/api/groups/${groupId}/messages${after ? `?after=${after}` : ""}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(200);
    return (await res.json()) as MessageItem[];
  }

  /** A ready-made cast: coordinator + reviewer + executor + human members. */
  async function setupGroup() {
    const coordinator = await registerAgent({
      name: "hermes-mac",
      type: "hermes",
      device: "mac-mini",
    });
    const reviewer = await registerAgent({
      name: "win-hermes",
      type: "hermes",
      device: "win-pc",
    });
    const executor = await registerAgent({
      name: "atomcode-cli",
      type: "atomcode",
    });
    const human = await registerAgent({
      name: "alice",
      type: "human",
      device: "macbook",
    });
    const group = await createGroup(coordinator.token, "模型训练任务");
    await addMember(coordinator.token, group.id, reviewer.id, ["reviewer"]);
    await addMember(coordinator.token, group.id, executor.id, ["executor"]);
    await addMember(coordinator.token, group.id, human.id, ["human"]);
    return { group, coordinator, reviewer, executor, human };
  }

  describe("POST /api/groups/:id/messages 发消息", () => {
    it("成员发送广播消息成功,返回完整消息(含树关系字段)", async () => {
      const { group, coordinator } = await setupGroup();
      const res = await sendMessage(coordinator.token, group.id, {
        body: "全体注意,任务开始",
      });
      expect(res.status).toBe(200);
      const msg = (await res.json()) as MessageItem;
      expect(msg.id).toBeTruthy();
      expect(msg.groupId).toBe(group.id);
      expect(msg.senderId).toBe(coordinator.id);
      expect(msg.parentId).toBeNull();
      expect(msg.audience).toBe("broadcast");
      expect(msg.audienceRef).toBeNull();
      expect(msg.body).toBe("全体注意,任务开始");
      expect(msg.depth).toBe(0);
      expect(msg.createdAt).toBeTruthy();
    });

    it("未认证(无 token)返回 401,非成员发送返回 403", async () => {
      const { group } = await setupGroup();
      const outsider = await registerAgent({
        name: "stranger",
        type: "openclaw",
      });

      const noToken = await app.request(`/api/groups/${group.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "x" }),
      });
      expect(noToken.status).toBe(401);

      const forbidden = await sendMessage(outsider.token, group.id, {
        body: "我不在群里",
      });
      expect(forbidden.status).toBe(403);
      expect((await forbidden.json()).code).toBe("FORBIDDEN");
    });

    it("不存在的群组返回 404", async () => {
      const { coordinator } = await setupGroup();
      const res = await sendMessage(
        coordinator.token,
        "00000000-0000-4000-8000-0000000000ff",
        {
          body: "x",
        },
      );
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("GROUP_NOT_FOUND");
    });

    it("parentId 不属于同一群组(或不存在)返回 400", async () => {
      const { group, coordinator, reviewer } = await setupGroup();
      const otherGroup = await createGroup(coordinator.token, "另一个任务");
      // 群外群组里的消息不能作为 parentId
      const foreign = await sendMessage(coordinator.token, otherGroup.id, {
        body: "群外消息",
      });
      const foreignMsg = (await foreign.json()) as MessageItem;

      const res = await sendMessage(reviewer.token, group.id, {
        body: "回复",
        parentId: foreignMsg.id,
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("INVALID_REQUEST");

      // 不存在的 parentId
      const missing = await sendMessage(reviewer.token, group.id, {
        body: "回复",
        parentId: "00000000-0000-4000-8000-0000000000ee",
      });
      expect(missing.status).toBe(400);
    });

    it("audience=role 校验:缺 audienceRef 或非法角色名返回 400", async () => {
      const { group, reviewer } = await setupGroup();
      const missingRef = await sendMessage(reviewer.token, group.id, {
        body: "评审稿",
        audience: "role",
      });
      expect(missingRef.status).toBe(400);

      const badRole = await sendMessage(reviewer.token, group.id, {
        body: "评审稿",
        audience: "role",
        audienceRef: "管理员",
      });
      expect(badRole.status).toBe(400);
    });

    it("audience=agent 校验:目标必须是本群成员,否则 400", async () => {
      const { group, reviewer, executor } = await setupGroup();
      const outsider = await registerAgent({
        name: "stranger",
        type: "atomcode",
      });
      const notMember = await sendMessage(reviewer.token, group.id, {
        body: "给你",
        audience: "agent",
        audienceRef: outsider.id,
      });
      expect(notMember.status).toBe(400);
      expect((await notMember.json()).code).toBe("INVALID_REQUEST");

      // 其他群组里的成员也不算本群成员
      const otherGroup = await registerAgent({
        name: "other-exec",
        type: "atomcode",
        device: "vm",
      });
      const crossGroup = await sendMessage(reviewer.token, group.id, {
        body: "给别的组的执行者",
        audience: "agent",
        audienceRef: otherGroup.id,
      });
      expect(crossGroup.status).toBe(400);

      // 本群成员则成功
      const ok = await sendMessage(reviewer.token, group.id, {
        body: "给本组执行者",
        audience: "agent",
        audienceRef: executor.id,
      });
      expect(ok.status).toBe(200);
    });

    it("audience=broadcast 携带 audienceRef 返回 400", async () => {
      const { group, coordinator, executor } = await setupGroup();
      const res = await sendMessage(coordinator.token, group.id, {
        body: "广播",
        audience: "broadcast",
        audienceRef: executor.id,
      });
      expect(res.status).toBe(400);
    });

    it("回复消息:parentId 生效且闭包正确(自引用 + 祖先链)", async () => {
      const { group, coordinator, reviewer } = await setupGroup();
      const root = (await (
        await sendMessage(coordinator.token, group.id, { body: "任务草稿" })
      ).json()) as MessageItem;

      const childRes = await sendMessage(reviewer.token, group.id, {
        body: "修正意见",
        parentId: root.id,
      });
      expect(childRes.status).toBe(200);
      const child = (await childRes.json()) as MessageItem;
      expect(child.parentId).toBe(root.id);
      expect(child.depth).toBe(1);

      const grandRes = await sendMessage(coordinator.token, group.id, {
        body: "采纳修正",
        parentId: child.id,
      });
      expect(grandRes.status).toBe(200);
      const grand = (await grandRes.json()) as MessageItem;
      expect(grand.depth).toBe(2);

      // 闭包表:每个消息有自引用行;孙消息有 (root, grand, 2) 与 (child, grand, 1)
      const rows = await testDb
        .select({
          ancestorId: closureTable.ancestorId,
          descendantId: closureTable.descendantId,
          depth: closureTable.depth,
        })
        .from(closureTable)
        .where(
          and(
            eq(closureTable.groupId, group.id),
            eq(closureTable.descendantId, grand.id),
          ),
        )
        .orderBy(closureTable.depth);
      expect(rows).toEqual(
        expect.arrayContaining([
          { ancestorId: grand.id, descendantId: grand.id, depth: 0 },
          { ancestorId: child.id, descendantId: grand.id, depth: 1 },
          { ancestorId: root.id, descendantId: grand.id, depth: 2 },
        ]),
      );

      const selfRows = await testDb
        .select({ ancestorId: closureTable.ancestorId })
        .from(closureTable)
        .where(
          and(
            eq(closureTable.groupId, group.id),
            eq(closureTable.descendantId, root.id),
          ),
        );
      expect(selfRows).toEqual([{ ancestorId: root.id }]);
    });

    it("深度上限 64:64 层可回复,65 层 400 且无部分闭包行写入 (ticket 15)", async () => {
      const { group, coordinator } = await setupGroup();
      const root = (await (
        await sendMessage(coordinator.token, group.id, { body: "深度 0" })
      ).json()) as MessageItem;
      expect(root.depth).toBe(0);

      // 沿链逐层回复到 depth 64:每一层都应挂载成功
      let parentId = root.id;
      for (let depth = 1; depth <= 64; depth += 1) {
        const res = await sendMessage(coordinator.token, group.id, {
          body: `深度 ${depth}`,
          parentId,
        });
        expect(res.status).toBe(200);
        const msg = (await res.json()) as MessageItem;
        expect(msg.depth).toBe(depth);
        parentId = msg.id;
      }

      // 基线行数(闭包表 + 消息表),用于断言 65 层失败后无残留
      const closureBefore = await testDb
        .select({ id: closureTable.descendantId })
        .from(closureTable)
        .where(eq(closureTable.groupId, group.id));

      // depth 65:parentDepth=64 -> 64+1 > 64,拒绝挂载
      const over = await sendMessage(coordinator.token, group.id, {
        body: "深度 65",
        parentId,
      });
      expect(over.status).toBe(400);
      const overBody = (await over.json()) as { code: string; message: string };
      expect(overBody.code).toBe("INVALID_REQUEST");
      expect(overBody.message).toContain("超过最大回复深度");

      // 无部分闭包行写入:失败后闭包表行数与消息行数均未增长
      const closureAfter = await testDb
        .select({ id: closureTable.descendantId })
        .from(closureTable)
        .where(eq(closureTable.groupId, group.id));
      expect(closureAfter).toHaveLength(closureBefore.length);
      const msgRows = await testDb
        .select({ id: groupMessageTable.id })
        .from(groupMessageTable)
        .where(eq(groupMessageTable.groupId, group.id));
      expect(msgRows).toHaveLength(65);
    });
  });

  describe("GET /api/groups/:id/messages 可见性与增量拉取", () => {
    it("广播消息所有群组成员可见,非成员 403", async () => {
      const { group, coordinator, reviewer, executor } = await setupGroup();
      await sendMessage(coordinator.token, group.id, { body: "广播消息" });

      for (const member of [coordinator, reviewer, executor]) {
        const list = await fetchMessages(member.token, group.id);
        expect(list.map((m) => m.body)).toContain("广播消息");
      }

      const outsider = await registerAgent({
        name: "stranger",
        type: "openclaw",
      });
      const res = await app.request(`/api/groups/${group.id}/messages`, {
        headers: { Authorization: `Bearer ${outsider.token}` },
      });
      expect(res.status).toBe(403);
    });

    it("role 受众仅持该角色的成员可见", async () => {
      const { group, coordinator, reviewer, executor } = await setupGroup();
      await sendMessage(coordinator.token, group.id, {
        body: "草稿,请评审",
        audience: "role",
        audienceRef: "reviewer",
      });

      const reviewerList = await fetchMessages(reviewer.token, group.id);
      expect(reviewerList.map((m) => m.body)).toContain("草稿,请评审");

      const executorList = await fetchMessages(executor.token, group.id);
      expect(executorList.map((m) => m.body)).not.toContain("草稿,请评审");
    });

    it("agent 受众仅目标成员可见", async () => {
      const { group, coordinator, reviewer, executor } = await setupGroup();
      await sendMessage(coordinator.token, group.id, {
        body: "执行最终版",
        audience: "agent",
        audienceRef: executor.id,
      });

      const executorList = await fetchMessages(executor.token, group.id);
      expect(executorList.map((m) => m.body)).toContain("执行最终版");

      const reviewerList = await fetchMessages(reviewer.token, group.id);
      expect(reviewerList.map((m) => m.body)).not.toContain("执行最终版");
    });

    it("human 成员全可见(能看到 role/agent 定向消息)", async () => {
      const { group, coordinator, reviewer, executor, human } =
        await setupGroup();
      await sendMessage(coordinator.token, group.id, {
        body: "请评审",
        audience: "role",
        audienceRef: "reviewer",
      });
      await sendMessage(coordinator.token, group.id, {
        body: "请执行",
        audience: "agent",
        audienceRef: executor.id,
      });

      const humanList = await fetchMessages(human.token, group.id);
      const bodies = humanList.map((m) => m.body);
      expect(bodies).toContain("请评审");
      expect(bodies).toContain("请执行");
    });

    it("发送者始终能看到自己发的定向消息", async () => {
      const { group, coordinator, reviewer, executor } = await setupGroup();
      await sendMessage(coordinator.token, group.id, {
        body: "只给执行者",
        audience: "agent",
        audienceRef: executor.id,
      });
      // 发送者(coordinator)可见自己的定向消息;非目标(reviewer)不可见
      const myList = await fetchMessages(coordinator.token, group.id);
      expect(myList.map((m) => m.body)).toContain("只给执行者");
      const reviewerList = await fetchMessages(reviewer.token, group.id);
      expect(reviewerList.map((m) => m.body)).not.toContain("只给执行者");
    });

    it("?after= 增量语义:只返回 id 更大的消息,按创建时间排序", async () => {
      const { group, coordinator, reviewer } = await setupGroup();
      const first = (await (
        await sendMessage(coordinator.token, group.id, { body: "第一条" })
      ).json()) as MessageItem;
      await sendMessage(coordinator.token, group.id, { body: "第二条" });
      const third = (await (
        await sendMessage(reviewer.token, group.id, { body: "第三条" })
      ).json()) as MessageItem;

      const inc = await fetchMessages(coordinator.token, group.id, first.id);
      expect(inc.map((m) => m.body)).toEqual(["第二条", "第三条"]);
      expect(inc.map((m) => m.id)).toEqual([expect.anything(), third.id]);
      // 创建时间升序
      const times = inc.map((m) => new Date(m.createdAt).getTime());
      expect(times[1]).toBeGreaterThanOrEqual(times[0]);
    });

    it("树关系:响应带 parentId 与 depth", async () => {
      const { group, coordinator, reviewer } = await setupGroup();
      const root = (await (
        await sendMessage(coordinator.token, group.id, { body: "根" })
      ).json()) as MessageItem;
      await sendMessage(reviewer.token, group.id, {
        body: "子",
        parentId: root.id,
      });

      const list = await fetchMessages(coordinator.token, group.id);
      expect(list).toHaveLength(2);
      const child = list.find((m) => m.body === "子");
      expect(child?.parentId).toBe(root.id);
      expect(child?.depth).toBe(1);
      const rootMsg = list.find((m) => m.body === "根");
      expect(rootMsg?.parentId).toBeNull();
      expect(rootMsg?.depth).toBe(0);
    });
  });

  describe("PATCH /:id/messages/:messageId 编辑消息 (ticket 22)", () => {
    async function patchMessage(
      token: string,
      groupId: string,
      messageId: string,
      body: Record<string, unknown>,
    ) {
      return app.request(`/api/groups/${groupId}/messages/${messageId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    }

    it("本人编辑正文成功:body/updatedAt 更新,parentId/audience/depth 不变", async () => {
      const { group, coordinator } = await setupGroup();
      const msg = (await (
        await sendMessage(coordinator.token, group.id, { body: "原始内容" })
      ).json()) as MessageItem;

      const res = await patchMessage(coordinator.token, group.id, msg.id, {
        body: "编辑后的内容",
      });
      expect(res.status).toBe(200);
      const updated = (await res.json()) as MessageItem & {
        updatedAt: string;
        contentType?: string;
      };
      expect(updated.id).toBe(msg.id);
      expect(updated.body).toBe("编辑后的内容");
      expect(updated.parentId).toBe(msg.parentId);
      expect(updated.audience).toBe(msg.audience);
      expect(updated.depth).toBe(msg.depth);
      expect(updated.contentType).toBe("text/plain");
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(msg.createdAt).getTime(),
      );

      // GET 反映编辑结果
      const list = await fetchMessages(coordinator.token, group.id);
      expect(list.find((m) => m.id === msg.id)?.body).toBe("编辑后的内容");
    });

    it("非本人编辑返回 403", async () => {
      const { group, coordinator, reviewer } = await setupGroup();
      const msg = (await (
        await sendMessage(coordinator.token, group.id, { body: "我的消息" })
      ).json()) as MessageItem;

      const res = await patchMessage(reviewer.token, group.id, msg.id, {
        body: "篡改内容",
      });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("FORBIDDEN");
    });

    it("消息不存在(或不属于该群)返回 404,群不存在返回 404", async () => {
      const { group, coordinator, reviewer } = await setupGroup();
      const missing = await patchMessage(
        coordinator.token,
        group.id,
        "00000000-0000-4000-8000-0000000000dd",
        { body: "x" },
      );
      expect(missing.status).toBe(404);
      expect((await missing.json()).code).toBe("MESSAGE_NOT_FOUND");

      // 其他群里的消息不属于本群 → 404
      const otherGroup = await createGroup(coordinator.token, "别的群");
      const foreign = (await (
        await sendMessage(coordinator.token, otherGroup.id, { body: "群外" })
      ).json()) as MessageItem;
      const crossGroup = await patchMessage(
        coordinator.token,
        group.id,
        foreign.id,
        {
          body: "x",
        },
      );
      expect(crossGroup.status).toBe(404);

      const noGroup = await patchMessage(
        coordinator.token,
        "00000000-0000-4000-8000-0000000000ff",
        "00000000-0000-4000-8000-0000000000dd",
        { body: "x" },
      );
      expect(noGroup.status).toBe(404);
      expect((await noGroup.json()).code).toBe("GROUP_NOT_FOUND");
    });

    it("body 为空或超长返回 400", async () => {
      const { group, coordinator } = await setupGroup();
      const msg = (await (
        await sendMessage(coordinator.token, group.id, { body: "内容" })
      ).json()) as MessageItem;

      const empty = await patchMessage(coordinator.token, group.id, msg.id, {
        body: "",
      });
      expect(empty.status).toBe(400);

      const tooLong = await patchMessage(coordinator.token, group.id, msg.id, {
        body: "x".repeat(4001),
      });
      expect(tooLong.status).toBe(400);
    });
  });

  describe("DELETE /:id/messages/:messageId 软删除 (ticket 22)", () => {
    async function deleteMessage(
      token: string,
      groupId: string,
      messageId: string,
    ) {
      return app.request(`/api/groups/${groupId}/messages/${messageId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    }

    it("本人删除:body 变占位、行保留(闭包树完整),返回 success", async () => {
      const { group, coordinator, reviewer } = await setupGroup();
      const root = (await (
        await sendMessage(coordinator.token, group.id, { body: "根消息" })
      ).json()) as MessageItem;
      const child = (await (
        await sendMessage(reviewer.token, group.id, {
          body: "回复",
          parentId: root.id,
        })
      ).json()) as MessageItem;

      const res = await deleteMessage(coordinator.token, group.id, root.id);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });

      // 行保留:body 变占位,闭包树(children 的 depth)不变
      const rows = await testDb
        .select({ id: groupMessageTable.id, body: groupMessageTable.body })
        .from(groupMessageTable)
        .where(eq(groupMessageTable.groupId, group.id));
      expect(rows).toHaveLength(2);
      const rootRow = rows.find((r) => r.id === root.id);
      expect(rootRow?.body).toBe("[消息已删除]");
      const childRow = rows.find((r) => r.id === child.id);
      expect(childRow?.body).toBe("回复");

      const closureRows = await testDb
        .select({ depth: closureTable.depth })
        .from(closureTable)
        .where(
          and(
            eq(closureTable.groupId, group.id),
            eq(closureTable.descendantId, child.id),
          ),
        );
      expect(closureRows).toEqual(
        expect.arrayContaining([{ depth: 0 }, { depth: 1 }]),
      );

      // GET 仍返回该行,body 为占位
      const list = await fetchMessages(coordinator.token, group.id);
      expect(list.find((m) => m.id === root.id)?.body).toBe("[消息已删除]");
    });

    it("非本人删除返回 403", async () => {
      const { group, coordinator, reviewer } = await setupGroup();
      const msg = (await (
        await sendMessage(coordinator.token, group.id, { body: "我的消息" })
      ).json()) as MessageItem;

      const res = await deleteMessage(reviewer.token, group.id, msg.id);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("FORBIDDEN");
    });

    it("幂等:重复删除仍 200,body 保持占位", async () => {
      const { group, coordinator } = await setupGroup();
      const msg = (await (
        await sendMessage(coordinator.token, group.id, { body: "待删" })
      ).json()) as MessageItem;

      const first = await deleteMessage(coordinator.token, group.id, msg.id);
      expect(first.status).toBe(200);
      const second = await deleteMessage(coordinator.token, group.id, msg.id);
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ success: true });

      const rows = await testDb
        .select({ body: groupMessageTable.body })
        .from(groupMessageTable)
        .where(eq(groupMessageTable.id, msg.id));
      expect(rows[0]?.body).toBe("[消息已删除]");
    });

    it("消息不存在返回 404", async () => {
      const { group, coordinator } = await setupGroup();
      const res = await deleteMessage(
        coordinator.token,
        group.id,
        "00000000-0000-4000-8000-0000000000dd",
      );
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("MESSAGE_NOT_FOUND");
    });
  });
});
