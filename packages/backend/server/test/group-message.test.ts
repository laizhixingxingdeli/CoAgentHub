import {
  groupMessageClosure as closureTable,
  groupMember as groupMemberTable,
  groupMessage as groupMessageTable,
} from "@laizhixingxingdeli/database/schema";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./app";
import { testDb } from "./db";

/**
 * Group message tree & audience routing (ticket 03): POST/GET messages with
 * sender + parentId + audience (broadcast|role|participant), visibility filtering
 * (human sees everything), incremental pull via ?after=, and closure-table
 * tree materialization.
 */
describe("群组消息树与受众路由", () => {
  const app = createTestApp();

  async function registerParticipant(body: Record<string, unknown>) {
    const res = await app.request("/api/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // 名字唯一(0013):同名已注册时服务端返回 409,复用现有 participant(测试内多次 setupGroup)。
    if (res.status === 409) {
      const list = (await (
        await app.request("/api/participants")
      ).json()) as { id: string; name: string }[];
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

  async function addMember(
    participantId: string,
    groupId: string,
    memberId: string,
    roles: string[],
  ) {
    const res = await app.request(`/api/groups/${groupId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": participantId,
      },
      body: JSON.stringify({ participantId: memberId, roles }),
    });
    expect(res.status).toBe(200);
  }

  async function sendMessage(
    participantId: string,
    groupId: string,
    body: Record<string, unknown>,
  ) {
    return app.request(`/api/groups/${groupId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": participantId,
      },
      body: JSON.stringify(body),
    });
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

  async function fetchMessages(
    participantId: string,
    groupId: string,
    after?: string,
    q?: string,
  ) {
    const params = new URLSearchParams();
    if (after) {
      params.set("after", after);
    }
    if (q !== undefined) {
      params.set("q", q);
    }
    const qs = params.toString();
    const res = await app.request(
      `/api/groups/${groupId}/messages${qs ? `?${qs}` : ""}`,
      { headers: { "X-Participant-Id": participantId } },
    );
    expect(res.status).toBe(200);
    return (await res.json()) as MessageItem[];
  }

  /** A ready-made cast: coordinator + reviewer + executor + human members. */
  async function setupGroup() {
    const coordinator = await registerParticipant({
      name: "hermes-mac",
      device: "mac-mini",
    });
    const reviewer = await registerParticipant({
      name: "win-hermes",
      device: "win-pc",
    });
    const executor = await registerParticipant({
      name: "atomcode-cli",
    });
    const human = await registerParticipant({
      name: "alice",
      device: "macbook",
    });
    const group = await createGroup(coordinator.id, "模型训练任务");
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
    await addMember(coordinator.id, group.id, executor.id, ["executor"]);
    await addMember(coordinator.id, group.id, human.id, ["human"]);
    return { group, coordinator, reviewer, executor, human };
  }

  describe("POST /api/groups/:id/messages 发消息", () => {
    it("成员发送广播消息成功,返回完整消息(含树关系字段)", async () => {
      const { group, coordinator } = await setupGroup();
      const res = await sendMessage(coordinator.id, group.id, {
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

    it("无 token 回落本地用户,非成员发送返回 403", async () => {
      const { group } = await setupGroup();
      const outsider = await registerParticipant({
        name: "stranger",
      });

      // LAN trust model: no token → Local User, who is not a group member.
      const noToken = await app.request(`/api/groups/${group.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "x" }),
      });
      expect(noToken.status).toBe(403);
      expect((await noToken.json()).code).toBe("FORBIDDEN");

      const forbidden = await sendMessage(outsider.id, group.id, {
        body: "我不在群里",
      });
      expect(forbidden.status).toBe(403);
      expect((await forbidden.json()).code).toBe("FORBIDDEN");
    });

    it("不存在的群组返回 404", async () => {
      const { coordinator } = await setupGroup();
      const res = await sendMessage(
        coordinator.id,
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
      const otherGroup = await createGroup(coordinator.id, "另一个任务");
      // 群外群组里的消息不能作为 parentId
      const foreign = await sendMessage(coordinator.id, otherGroup.id, {
        body: "群外消息",
      });
      const foreignMsg = (await foreign.json()) as MessageItem;

      const res = await sendMessage(reviewer.id, group.id, {
        body: "回复",
        parentId: foreignMsg.id,
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("INVALID_REQUEST");

      // 不存在的 parentId
      const missing = await sendMessage(reviewer.id, group.id, {
        body: "回复",
        parentId: "00000000-0000-4000-8000-0000000000ee",
      });
      expect(missing.status).toBe(400);
    });

    it("body 超 8000 字符返回 400,恰好 8000 照常通过", async () => {
      const { group, coordinator } = await setupGroup();
      const tooLong = await sendMessage(coordinator.id, group.id, {
        body: "x".repeat(8001),
      });
      expect(tooLong.status).toBe(400);

      const boundary = await sendMessage(coordinator.id, group.id, {
        body: "x".repeat(8000),
      });
      expect(boundary.status).toBe(200);
    });

    it("fileRef.name 超 255 / fetchUrl 超 2048 返回 400", async () => {
      const { group, coordinator } = await setupGroup();
      const validFileRef = {
        size: 2048,
        sha256: "a".repeat(64),
        fetchUrl: "http://192.168.1.10:8080/f/trained-model.bin",
      };
      const longName = await sendMessage(coordinator.id, group.id, {
        fileRef: { ...validFileRef, name: "x".repeat(256) },
      });
      expect(longName.status).toBe(400);

      const longUrl = await sendMessage(coordinator.id, group.id, {
        fileRef: {
          ...validFileRef,
          name: "trained-model.bin",
          fetchUrl: `http://192.168.1.10:8080/f/${"x".repeat(2048)}`,
        },
      });
      expect(longUrl.status).toBe(400);
    });

    it("audience=role 校验:缺 audienceRef 或非法角色名返回 400", async () => {
      const { group, reviewer } = await setupGroup();
      const missingRef = await sendMessage(reviewer.id, group.id, {
        body: "评审稿",
        audience: "role",
      });
      expect(missingRef.status).toBe(400);

      const badRole = await sendMessage(reviewer.id, group.id, {
        body: "评审稿",
        audience: "role",
        audienceRef: "管理员",
      });
      expect(badRole.status).toBe(400);
    });

    it("audience=participant 校验:目标必须是本群成员,否则 400", async () => {
      const { group, reviewer, executor } = await setupGroup();
      const outsider = await registerParticipant({
        name: "stranger",
      });
      const notMember = await sendMessage(reviewer.id, group.id, {
        body: "给你",
        audience: "participant",
        audienceRef: outsider.id,
      });
      expect(notMember.status).toBe(400);
      expect((await notMember.json()).code).toBe("INVALID_REQUEST");

      // 其他群组里的成员也不算本群成员
      const otherGroup = await registerParticipant({
        name: "other-exec",
        device: "vm",
      });
      const crossGroup = await sendMessage(reviewer.id, group.id, {
        body: "给别的组的执行者",
        audience: "participant",
        audienceRef: otherGroup.id,
      });
      expect(crossGroup.status).toBe(400);

      // 本群成员则成功
      const ok = await sendMessage(reviewer.id, group.id, {
        body: "给本组执行者",
        audience: "participant",
        audienceRef: executor.id,
      });
      expect(ok.status).toBe(200);
    });

    it('兼容旧值:audience="agent" 定向消息 200,落库归一为 participant', async () => {
      const { group, coordinator, executor } = await setupGroup();

      // 术语改名前的外部执行器 CLI 可能仍发 audience:"agent"(agent 为
      // participant 的旧名):服务端接受并归一为 participant 存储,接收方可见。
      const res = await sendMessage(coordinator.id, group.id, {
        body: "给执行者的旧格式定向消息",
        audience: "agent",
        audienceRef: executor.id,
      });
      expect(res.status).toBe(200);
      const msg = (await res.json()) as MessageItem;
      expect(msg.audience).toBe("participant");
      expect(msg.audienceRef).toBe(executor.id);

      // 落库值也是 participant(库中永远只存新值)。
      const [row] = await testDb
        .select({ audience: groupMessageTable.audience })
        .from(groupMessageTable)
        .where(eq(groupMessageTable.id, msg.id));
      expect(row.audience).toBe("participant");

      // 接收方(executor 视角)可见这条消息。
      const visible = await fetchMessages(executor.id, group.id);
      expect(visible.some((m) => m.id === msg.id)).toBe(true);
    });

    it("audience=broadcast 携带 audienceRef 返回 400", async () => {
      const { group, coordinator, executor } = await setupGroup();
      const res = await sendMessage(coordinator.id, group.id, {
        body: "广播",
        audience: "broadcast",
        audienceRef: executor.id,
      });
      expect(res.status).toBe(400);
    });

    it("回复消息:parentId 生效且闭包正确(自引用 + 祖先链)", async () => {
      const { group, coordinator, reviewer } = await setupGroup();
      const root = (await (
        await sendMessage(coordinator.id, group.id, { body: "任务草稿" })
      ).json()) as MessageItem;

      const childRes = await sendMessage(reviewer.id, group.id, {
        body: "修正意见",
        parentId: root.id,
      });
      expect(childRes.status).toBe(200);
      const child = (await childRes.json()) as MessageItem;
      expect(child.parentId).toBe(root.id);
      expect(child.depth).toBe(1);

      const grandRes = await sendMessage(coordinator.id, group.id, {
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
        await sendMessage(coordinator.id, group.id, { body: "深度 0" })
      ).json()) as MessageItem;
      expect(root.depth).toBe(0);

      // 沿链逐层回复到 depth 64:每一层都应挂载成功
      let parentId = root.id;
      for (let depth = 1; depth <= 64; depth += 1) {
        const res = await sendMessage(coordinator.id, group.id, {
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
      const over = await sendMessage(coordinator.id, group.id, {
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
    it("广播消息所有群组成员可见;非成员只读得到广播(不再 403)", async () => {
      const { group, coordinator, reviewer, executor } = await setupGroup();
      await sendMessage(coordinator.id, group.id, { body: "广播消息" });

      for (const member of [coordinator, reviewer, executor]) {
        const list = await fetchMessages(member.id, group.id);
        expect(list.map((m) => m.body)).toContain("广播消息");
      }

      // LAN trust model:GET 不要求成员资格,非成员可见自己的消息+广播。
      const outsider = await registerParticipant({
        name: "stranger",
      });
      const res = await app.request(`/api/groups/${group.id}/messages`, {
        headers: { "X-Participant-Id": outsider.id },
      });
      expect(res.status).toBe(200);
      const list = (await res.json()) as MessageItem[];
      expect(list.map((m) => m.body)).toContain("广播消息");
    });

    it("无 token 回落本地用户:全可见,含定向消息", async () => {
      const { group, coordinator } = await setupGroup();
      await sendMessage(coordinator.id, group.id, { body: "广播消息" });
      await sendMessage(coordinator.id, group.id, {
        body: "仅给协调员",
        audience: "participant",
        audienceRef: coordinator.id,
      });

      // 不带 Authorization → Local User(human 角色),可读全部消息。
      const res = await app.request(`/api/groups/${group.id}/messages`);
      expect(res.status).toBe(200);
      const list = (await res.json()) as MessageItem[];
      const bodies = list.map((m) => m.body);
      expect(bodies).toContain("广播消息");
      expect(bodies).toContain("仅给协调员");
    });

    it("本地用户已是成员(非 human 角色)仍全可见:含定向消息", async () => {
      // 无 token 建群 → Local User 自动成为 coordinator 成员(成员身份存在)。
      const created = await app.request("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "本地用户建的群" }),
      });
      expect(created.status).toBe(200);
      const localGroup = (await created.json()) as {
        id: string;
        createdBy: string;
      };

      // 另两个 participant 入群(成员表直插,避免依赖加成员接口的调用方守卫)。
      const member = await registerParticipant({
        name: "member-a",
      });
      const target = await registerParticipant({
        name: "target-b",
      });
      await testDb.insert(groupMemberTable).values({
        groupId: localGroup.id,
        participantId: member.id,
        roles: ["executor"],
      });
      await testDb.insert(groupMemberTable).values({
        groupId: localGroup.id,
        participantId: target.id,
        roles: ["reviewer"],
      });
      await sendMessage(member.id, localGroup.id, { body: "广播消息" });
      await sendMessage(member.id, localGroup.id, {
        body: "定向给 target",
        audience: "participant",
        audienceRef: target.id,
      });

      // 无 token 读:Local User 虽是成员(coordinator),human 角色必须保留,
      // 定向消息同样可见 —— 否则与 WS fan-out 的"无条件投递给 Local User"分叉。
      const res = await app.request(`/api/groups/${localGroup.id}/messages`);
      expect(res.status).toBe(200);
      const list = (await res.json()) as MessageItem[];
      const bodies = list.map((m) => m.body);
      expect(bodies).toContain("广播消息");
      expect(bodies).toContain("定向给 target");
    });

    it("role 受众仅持该角色的成员可见", async () => {
      const { group, coordinator, reviewer, executor } = await setupGroup();
      await sendMessage(coordinator.id, group.id, {
        body: "草稿,请评审",
        audience: "role",
        audienceRef: "reviewer",
      });

      const reviewerList = await fetchMessages(reviewer.id, group.id);
      expect(reviewerList.map((m) => m.body)).toContain("草稿,请评审");

      const executorList = await fetchMessages(executor.id, group.id);
      expect(executorList.map((m) => m.body)).not.toContain("草稿,请评审");
    });

    it("participant 受众仅目标成员可见", async () => {
      const { group, coordinator, reviewer, executor } = await setupGroup();
      await sendMessage(coordinator.id, group.id, {
        body: "执行最终版",
        audience: "participant",
        audienceRef: executor.id,
      });

      const executorList = await fetchMessages(executor.id, group.id);
      expect(executorList.map((m) => m.body)).toContain("执行最终版");

      const reviewerList = await fetchMessages(reviewer.id, group.id);
      expect(reviewerList.map((m) => m.body)).not.toContain("执行最终版");
    });

    it("human 成员全可见(能看到 role/participant 定向消息)", async () => {
      const { group, coordinator, reviewer, executor, human } =
        await setupGroup();
      await sendMessage(coordinator.id, group.id, {
        body: "请评审",
        audience: "role",
        audienceRef: "reviewer",
      });
      await sendMessage(coordinator.id, group.id, {
        body: "请执行",
        audience: "participant",
        audienceRef: executor.id,
      });

      const humanList = await fetchMessages(human.id, group.id);
      const bodies = humanList.map((m) => m.body);
      expect(bodies).toContain("请评审");
      expect(bodies).toContain("请执行");
    });

    it("发送者始终能看到自己发的定向消息", async () => {
      const { group, coordinator, reviewer, executor } = await setupGroup();
      await sendMessage(coordinator.id, group.id, {
        body: "只给执行者",
        audience: "participant",
        audienceRef: executor.id,
      });
      // 发送者(coordinator)可见自己的定向消息;非目标(reviewer)不可见
      const myList = await fetchMessages(coordinator.id, group.id);
      expect(myList.map((m) => m.body)).toContain("只给执行者");
      const reviewerList = await fetchMessages(reviewer.id, group.id);
      expect(reviewerList.map((m) => m.body)).not.toContain("只给执行者");
    });

    it("?after= 增量语义:只返回 id 更大的消息,按创建时间排序", async () => {
      const { group, coordinator, reviewer } = await setupGroup();
      const first = (await (
        await sendMessage(coordinator.id, group.id, { body: "第一条" })
      ).json()) as MessageItem;
      await sendMessage(coordinator.id, group.id, { body: "第二条" });
      const third = (await (
        await sendMessage(reviewer.id, group.id, { body: "第三条" })
      ).json()) as MessageItem;

      const inc = await fetchMessages(coordinator.id, group.id, first.id);
      expect(inc.map((m) => m.body)).toEqual(["第二条", "第三条"]);
      expect(inc.map((m) => m.id)).toEqual([expect.anything(), third.id]);
      // 创建时间升序
      const times = inc.map((m) => new Date(m.createdAt).getTime());
      expect(times[1]).toBeGreaterThanOrEqual(times[0]);
    });

    it("?q= 搜索:按正文关键词过滤,保留可见性过滤", async () => {
      const { group, coordinator, reviewer, executor } = await setupGroup();
      await sendMessage(coordinator.id, group.id, { body: "任务开始执行" });
      await sendMessage(coordinator.id, group.id, { body: "今天的日报" });
      // 定向给 executor 的消息也含关键词 —— 非目标(reviewer)不可见。
      await sendMessage(coordinator.id, group.id, {
        body: "只给执行者",
        audience: "participant",
        audienceRef: executor.id,
      });

      // reviewer 搜 "执行":只匹配到广播消息,定向消息被可见性过滤掉。
      const reviewerList = await fetchMessages(
        reviewer.id,
        group.id,
        undefined,
        "执行",
      );
      expect(reviewerList.map((m) => m.body)).toEqual(["任务开始执行"]);
      // 行形状不变:仍带 depth 字段。
      expect(reviewerList[0]?.depth).toBe(0);

      // executor(目标)搜 "执行":广播 + 自己的定向消息都可见。
      const executorList = await fetchMessages(
        executor.id,
        group.id,
        undefined,
        "执行",
      );
      expect(executorList.map((m) => m.body).sort()).toEqual([
        "任务开始执行",
        "只给执行者",
      ]);

      // 无匹配关键词 → 空结果。
      const none = await fetchMessages(
        reviewer.id,
        group.id,
        undefined,
        "不存在",
      );
      expect(none).toEqual([]);
    });

    it("?q= 转义 % 与 _:搜 100% 不匹配任意串", async () => {
      const { group, coordinator } = await setupGroup();
      await sendMessage(coordinator.id, group.id, {
        body: "达标率 100% 完成",
      });
      await sendMessage(coordinator.id, group.id, { body: "数值 1000 天" });
      await sendMessage(coordinator.id, group.id, { body: "文件 abc_def" });
      await sendMessage(coordinator.id, group.id, { body: "文件 abcxdef" });

      // 未转义时 %100%% 会匹配 "数值 1000 天";转义后只匹配字面 "100%"。
      const pct = await fetchMessages(
        coordinator.id,
        group.id,
        undefined,
        "100%",
      );
      expect(pct.map((m) => m.body)).toEqual(["达标率 100% 完成"]);

      // 未转义时 abc_def 的 _ 是通配,会匹配 abcxdef;转义后只匹配字面下划线。
      const us = await fetchMessages(
        coordinator.id,
        group.id,
        undefined,
        "abc_def",
      );
      expect(us.map((m) => m.body)).toEqual(["文件 abc_def"]);
    });

    it("?q= 与 ?after= 组合:先按游标再按关键词", async () => {
      const { group, coordinator } = await setupGroup();
      await sendMessage(coordinator.id, group.id, { body: "苹果" });
      const second = (await (
        await sendMessage(coordinator.id, group.id, { body: "香蕉" })
      ).json()) as MessageItem;
      await sendMessage(coordinator.id, group.id, { body: "苹果派" });

      // q=苹果 本应命中两条,after=second 把更早的 "苹果" 排除,只剩 "苹果派"。
      const list = await fetchMessages(
        coordinator.id,
        group.id,
        second.id,
        "苹果",
      );
      expect(list.map((m) => m.body)).toEqual(["苹果派"]);
      // 仍按 id 升序。
      expect(list.map((m) => m.id)).toEqual([expect.anything()]);
    });

    it("?q= 空串等价现状:返回全部可见消息", async () => {
      const { group, coordinator, reviewer } = await setupGroup();
      await sendMessage(coordinator.id, group.id, { body: "第一条" });
      await sendMessage(reviewer.id, group.id, { body: "第二条" });

      const withEmpty = await fetchMessages(
        coordinator.id,
        group.id,
        undefined,
        "",
      );
      const without = await fetchMessages(coordinator.id, group.id);
      expect(withEmpty.map((m) => m.body)).toEqual(without.map((m) => m.body));
      expect(withEmpty.map((m) => m.body)).toEqual(["第一条", "第二条"]);
    });

    it("?q= 超过 200 字符返回 400", async () => {
      const { group, coordinator } = await setupGroup();
      const res = await app.request(
        `/api/groups/${group.id}/messages?q=${"a".repeat(201)}`,
        { headers: { "X-Participant-Id": coordinator.id } },
      );
      expect(res.status).toBe(400);
    });

    it("树关系:响应带 parentId 与 depth", async () => {
      const { group, coordinator, reviewer } = await setupGroup();
      const root = (await (
        await sendMessage(coordinator.id, group.id, { body: "根" })
      ).json()) as MessageItem;
      await sendMessage(reviewer.id, group.id, {
        body: "子",
        parentId: root.id,
      });

      const list = await fetchMessages(coordinator.id, group.id);
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
      participantId: string,
      groupId: string,
      messageId: string,
      body: Record<string, unknown>,
    ) {
      return app.request(`/api/groups/${groupId}/messages/${messageId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": participantId,
        },
        body: JSON.stringify(body),
      });
    }

    it("本人编辑正文成功:body/updatedAt 更新,parentId/audience/depth 不变", async () => {
      const { group, coordinator } = await setupGroup();
      const msg = (await (
        await sendMessage(coordinator.id, group.id, { body: "原始内容" })
      ).json()) as MessageItem;

      const res = await patchMessage(coordinator.id, group.id, msg.id, {
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
      const list = await fetchMessages(coordinator.id, group.id);
      expect(list.find((m) => m.id === msg.id)?.body).toBe("编辑后的内容");
    });

    it("非本人编辑返回 403", async () => {
      const { group, coordinator, reviewer } = await setupGroup();
      const msg = (await (
        await sendMessage(coordinator.id, group.id, { body: "我的消息" })
      ).json()) as MessageItem;

      const res = await patchMessage(reviewer.id, group.id, msg.id, {
        body: "篡改内容",
      });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("FORBIDDEN");
    });

    it("消息不存在(或不属于该群)返回 404,群不存在返回 404", async () => {
      const { group, coordinator, reviewer } = await setupGroup();
      const missing = await patchMessage(
        coordinator.id,
        group.id,
        "00000000-0000-4000-8000-0000000000dd",
        { body: "x" },
      );
      expect(missing.status).toBe(404);
      expect((await missing.json()).code).toBe("MESSAGE_NOT_FOUND");

      // 其他群里的消息不属于本群 → 404
      const otherGroup = await createGroup(coordinator.id, "别的群");
      const foreign = (await (
        await sendMessage(coordinator.id, otherGroup.id, { body: "群外" })
      ).json()) as MessageItem;
      const crossGroup = await patchMessage(
        coordinator.id,
        group.id,
        foreign.id,
        {
          body: "x",
        },
      );
      expect(crossGroup.status).toBe(404);

      const noGroup = await patchMessage(
        coordinator.id,
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
        await sendMessage(coordinator.id, group.id, { body: "内容" })
      ).json()) as MessageItem;

      const empty = await patchMessage(coordinator.id, group.id, msg.id, {
        body: "",
      });
      expect(empty.status).toBe(400);

      const tooLong = await patchMessage(coordinator.id, group.id, msg.id, {
        body: "x".repeat(4001),
      });
      expect(tooLong.status).toBe(400);
    });
  });

  describe("DELETE /:id/messages/:messageId 软删除 (ticket 22)", () => {
    async function deleteMessage(
      participantId: string,
      groupId: string,
      messageId: string,
    ) {
      return app.request(`/api/groups/${groupId}/messages/${messageId}`, {
        method: "DELETE",
        headers: { "X-Participant-Id": participantId },
      });
    }

    it("本人删除:body 变占位、行保留(闭包树完整),返回 success", async () => {
      const { group, coordinator, reviewer } = await setupGroup();
      const root = (await (
        await sendMessage(coordinator.id, group.id, { body: "根消息" })
      ).json()) as MessageItem;
      const child = (await (
        await sendMessage(reviewer.id, group.id, {
          body: "回复",
          parentId: root.id,
        })
      ).json()) as MessageItem;

      const res = await deleteMessage(coordinator.id, group.id, root.id);
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
      const list = await fetchMessages(coordinator.id, group.id);
      expect(list.find((m) => m.id === root.id)?.body).toBe("[消息已删除]");
    });

    it("非本人删除返回 403", async () => {
      const { group, coordinator, reviewer } = await setupGroup();
      const msg = (await (
        await sendMessage(coordinator.id, group.id, { body: "我的消息" })
      ).json()) as MessageItem;

      const res = await deleteMessage(reviewer.id, group.id, msg.id);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("FORBIDDEN");
    });

    it("幂等:重复删除仍 200,body 保持占位", async () => {
      const { group, coordinator } = await setupGroup();
      const msg = (await (
        await sendMessage(coordinator.id, group.id, { body: "待删" })
      ).json()) as MessageItem;

      const first = await deleteMessage(coordinator.id, group.id, msg.id);
      expect(first.status).toBe(200);
      const second = await deleteMessage(coordinator.id, group.id, msg.id);
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
        coordinator.id,
        group.id,
        "00000000-0000-4000-8000-0000000000dd",
      );
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("MESSAGE_NOT_FOUND");
    });
  });
});
