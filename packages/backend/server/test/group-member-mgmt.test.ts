import { describe, expect, it } from "vitest";
import { groupMessage as groupMessageTable } from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import { createTestApp } from "./app";
import { testDb } from "./db";

/**
 * Group member management (ticket 20): DELETE /:id/members/:participantId removes a
 * non-creator member; PATCH /:id/members/:participantId updates a member's roles
 * with the same dedupe rule as POST /members. The creator (群主) can never be
 * removed.
 */
describe("群组成员管理 API (ticket 20)", () => {
  const app = createTestApp();

  /** Register an participant and return { id }. */
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
    return (await res.json()) as {
      id: string;
      title: string;
      status: string;
      createdBy: string;
    };
  }

  /** Add a member to the group (the POST upsert), returning the member row. */
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
    return (await res.json()) as { participantId: string; roles: string[] };
  }

  async function listMemberIds(
    participantId: string,
    groupId: string,
  ): Promise<string[]> {
    const res = await app.request(`/api/groups/${groupId}/members`, {
      headers: { "X-Participant-Id": participantId },
    });
    expect(res.status).toBe(200);
    const members = (await res.json()) as Array<{ participantId: string }>;
    return members.map((m) => m.participantId);
  }

  describe("DELETE /api/groups/:id/members/:participantId 移除成员", () => {
    it("移除普通成员成功,移除后 GET members 不含该人", async () => {
      const { id: ownerId } = await registerParticipant({
        name: "coord",
      });
      const { id: memberId } = await registerParticipant({
        name: "win-hermes",
      });
      const group = await createGroup(ownerId, "移除任务");
      await addMember(ownerId, group.id, memberId, ["reviewer"]);
      expect(await listMemberIds(ownerId, group.id)).toEqual([
        ownerId,
        memberId,
      ]);

      const delRes = await app.request(
        `/api/groups/${group.id}/members/${memberId}`,
        {
          method: "DELETE",
          headers: { "X-Participant-Id": ownerId },
        },
      );
      expect(delRes.status).toBe(200);
      expect((await delRes.json()) as { success: boolean }).toEqual({
        success: true,
      });

      // The removed member is gone from the list; the creator stays.
      expect(await listMemberIds(ownerId, group.id)).toEqual([ownerId]);
    });

    it("移除不存在的成员返回 404 MEMBER_NOT_FOUND", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const { id: outsiderId } = await registerParticipant({
        name: "outsider",
      });
      const group = await createGroup(id, "不存在成员");

      const res = await app.request(
        `/api/groups/${group.id}/members/${outsiderId}`,
        {
          method: "DELETE",
          headers: { "X-Participant-Id": id },
        },
      );
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("MEMBER_NOT_FOUND");
    });

    it("群组不存在返回 404 GROUP_NOT_FOUND", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const res = await app.request(
        "/api/groups/00000000-0000-0000-0000-00000000dead/members/00000000-0000-0000-0000-00000000beef",
        {
          method: "DELETE",
          headers: { "X-Participant-Id": id },
        },
      );
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("GROUP_NOT_FOUND");
    });

    it("移除群主返回 400,且群主仍保留在成员列表", async () => {
      const { id: ownerId } = await registerParticipant({
        name: "coord",
      });
      const group = await createGroup(ownerId, "群主保护");

      const res = await app.request(
        `/api/groups/${group.id}/members/${ownerId}`,
        {
          method: "DELETE",
          headers: { "X-Participant-Id": ownerId },
        },
      );
      expect(res.status).toBe(400);
      expect((await res.json()).message).toBe("不能移除群主");
      expect(await listMemberIds(ownerId, group.id)).toEqual([ownerId]);
    });
  });

  describe("PATCH /api/groups/:id/members/:participantId 改角色", () => {
    it("多角色更新返回 400,原角色保持不变", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const { id: memberId } = await registerParticipant({
        name: "win-hermes",
      });
      const group = await createGroup(id, "改角色任务");
      await addMember(id, group.id, memberId, ["observer"]);

      const patchRes = await app.request(
        `/api/groups/${group.id}/members/${memberId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": id,
          },
          body: JSON.stringify({ roles: ["reviewer", "executor"] }),
        },
      );
      expect(patchRes.status).toBe(400);
      expect((await patchRes.json()).message).toBe("一个群内只能持有一种角色");

      const membersRes = await app.request(`/api/groups/${group.id}/members`, {
        headers: { "X-Participant-Id": id },
      });
      const members = (await membersRes.json()) as Array<{
        participantId: string;
        roles: string[];
      }>;
      const member = members.find((m) => m.participantId === memberId);
      expect(member?.roles).toEqual(["observer"]);
    });

    it("重复角色去重后长度为 1 放行(与 POST /members 同规则)", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const { id: memberId } = await registerParticipant({
        name: "dedupe",
      });
      const group = await createGroup(id, "去重任务");
      await addMember(id, group.id, memberId, ["observer"]);

      const patchRes = await app.request(
        `/api/groups/${group.id}/members/${memberId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": id,
          },
          body: JSON.stringify({ roles: ["executor", "executor"] }),
        },
      );
      expect(patchRes.status).toBe(200);
      expect(((await patchRes.json()) as { roles: string[] }).roles).toEqual([
        "executor",
      ]);
    });

    it("去重后仍多于一种角色返回 400(单角色约束)", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const { id: memberId } = await registerParticipant({
        name: "dedupe-reject",
      });
      const group = await createGroup(id, "去重拒绝");
      await addMember(id, group.id, memberId, ["observer"]);

      const res = await app.request(
        `/api/groups/${group.id}/members/${memberId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": id,
          },
          body: JSON.stringify({
            roles: ["executor", "executor", "reviewer"],
          }),
        },
      );
      expect(res.status).toBe(400);
      expect((await res.json()).message).toBe("一个群内只能持有一种角色");
    });

    it("roles 空数组返回 400", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const { id: memberId } = await registerParticipant({
        name: "empty",
      });
      const group = await createGroup(id, "空角色校验");
      await addMember(id, group.id, memberId, ["observer"]);

      const res = await app.request(
        `/api/groups/${group.id}/members/${memberId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": id,
          },
          body: JSON.stringify({ roles: [] }),
        },
      );
      expect(res.status).toBe(400);
    });

    it("roles 含非预设角色返回 400", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const { id: memberId } = await registerParticipant({
        name: "bogus",
      });
      const group = await createGroup(id, "非法角色校验");
      await addMember(id, group.id, memberId, ["observer"]);

      const res = await app.request(
        `/api/groups/${group.id}/members/${memberId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": id,
          },
          body: JSON.stringify({ roles: ["superadmin"] }),
        },
      );
      expect(res.status).toBe(400);
    });

    it("成员不存在返回 404 MEMBER_NOT_FOUND", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const { id: outsiderId } = await registerParticipant({
        name: "outsider",
      });
      const group = await createGroup(id, "不存在成员改角色");

      const res = await app.request(
        `/api/groups/${group.id}/members/${outsiderId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": id,
          },
          body: JSON.stringify({ roles: ["reviewer"] }),
        },
      );
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("MEMBER_NOT_FOUND");
    });
  });

  describe("成员 prompt(角色解绑,群内分工说明)", () => {
    it("POST 带 prompt 成功,GET members 返回 prompt", async () => {
      const { id } = await registerParticipant({
        name: "coord-prompt",
      });
      const { id: memberId } = await registerParticipant({
        name: "prompt-participant",
      });
      const group = await createGroup(id, "分工提示词");

      const res = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
        },
        body: JSON.stringify({
          participantId: memberId,
          roles: ["executor"],
          prompt: "负责代码执行与测试跑通",
        }),
      });
      expect(res.status).toBe(200);
      const created = (await res.json()) as {
        participantId: string;
        prompt: string | null;
      };
      expect(created.participantId).toBe(memberId);
      expect(created.prompt).toBe("负责代码执行与测试跑通");

      const members = (await (
        await app.request(`/api/groups/${group.id}/members`, {
          headers: { "X-Participant-Id": id },
        })
      ).json()) as Array<{ participantId: string; prompt: string | null }>;
      const member = members.find((m) => m.participantId === memberId);
      expect(member?.prompt).toBe("负责代码执行与测试跑通");
    });

    it("POST 不带 prompt 不破坏旧行为(prompt 为 null)", async () => {
      const { id } = await registerParticipant({
        name: "coord-noprompt",
      });
      const { id: memberId } = await registerParticipant({
        name: "plain-participant",
      });
      const group = await createGroup(id, "无提示词成员");

      const res = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
        },
        body: JSON.stringify({ participantId: memberId, roles: ["observer"] }),
      });
      expect(res.status).toBe(200);
      expect(
        ((await res.json()) as { prompt: string | null }).prompt,
      ).toBeNull();
    });

    it("幂等 upsert 不带 prompt 保持既有分工提示词", async () => {
      const { id } = await registerParticipant({
        name: "coord-upsert",
      });
      const { id: memberId } = await registerParticipant({
        name: "upsert-participant",
      });
      const group = await createGroup(id, "upsert 提示词");

      const first = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
        },
        body: JSON.stringify({
          participantId: memberId,
          roles: ["executor"],
          prompt: "初始分工",
        }),
      });
      expect(first.status).toBe(200);

      // 再次 POST 不带 prompt:roles 照常 upsert,prompt 保留原值。
      const second = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
        },
        body: JSON.stringify({ participantId: memberId, roles: ["reviewer"] }),
      });
      expect(second.status).toBe(200);
      expect(((await second.json()) as { prompt: string | null }).prompt).toBe(
        "初始分工",
      );
    });

    /**
     * 协助函数:通过执行器 API 新建一个执行器配置(自动注册同名 participant),
     * 返回其 participant id 与 executorConfig.prompt。关联键为
     * participant.name === executor_config.agent_name(服务端按 name 查询)。
     */
    async function createExecutor(
      agentName: string,
      prompt?: string,
    ): Promise<string> {
      const res = await app.request("/api/executors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentName,
          kind: "cli",
          bin: "/usr/bin/true",
          args: [],
          ...(prompt !== undefined ? { prompt } : {}),
        }),
      });
      expect(res.status).toBe(200);
      const [p] = await testDb.query.participant.findMany({
        where: (t, { eq }) => eq(t.name, agentName),
      });
      expect(p).toBeDefined();
      return p.id;
    }

    it("新建成员未传 prompt → 回落到执行器 executor_config.prompt 默认值", async () => {
      const { id } = await registerParticipant({ name: "coord-fallback" });
      const exPid = await createExecutor(
        "fallback-executor",
        "默认负责数据库迁移与评审",
      );
      const group = await createGroup(id, "回落默认值");

      const res = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
        },
        body: JSON.stringify({ participantId: exPid, roles: ["executor"] }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { prompt: string | null }).prompt).toBe(
        "默认负责数据库迁移与评审",
      );
    });

    it("显式传 prompt 以调用方为准,不回落(非空)", async () => {
      const { id } = await registerParticipant({ name: "coord-explicit" });
      const exPid = await createExecutor("explicit-executor", "执行器默认分工");
      const group = await createGroup(id, "显式优先");

      const res = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
        },
        body: JSON.stringify({
          participantId: exPid,
          roles: ["executor"],
          prompt: "调用方自定义分工",
        }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { prompt: string | null }).prompt).toBe(
        "调用方自定义分工",
      );
    });

    it("显式传空串 prompt 以调用方为准,不回落到执行器默认值", async () => {
      const { id } = await registerParticipant({ name: "coord-empty-prompt" });
      const exPid = await createExecutor(
        "empty-prompt-executor",
        "执行器默认分工",
      );
      const group = await createGroup(id, "显式空串");

      const res = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
        },
        body: JSON.stringify({
          participantId: exPid,
          roles: ["executor"],
          prompt: "",
        }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { prompt: string | null }).prompt).toBe("");
    });

    it("已存在成员行未传 prompt → 保持既有分工,不被执行器默认值覆盖", async () => {
      const { id } = await registerParticipant({ name: "coord-keep" });
      // participant 本身就是执行器,且执行器默认 prompt 存在,用来证明 update
      // 分支绝不回落:首建已显式设过分工,二发未传 prompt 必须保留旧值。
      const exPid = await createExecutor(
        "keep-executor",
        "执行器默认分工(不该覆盖)",
      );
      const group = await createGroup(id, "保留既有值");

      const first = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
        },
        body: JSON.stringify({
          participantId: exPid,
          roles: ["executor"],
          prompt: "我针对这群改的分工",
        }),
      });
      expect(first.status).toBe(200);

      const second = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
        },
        body: JSON.stringify({ participantId: exPid, roles: ["reviewer"] }),
      });
      expect(second.status).toBe(200);
      expect(((await second.json()) as { prompt: string | null }).prompt).toBe(
        "我针对这群改的分工",
      );
    });

    it("非执行器 participant 未传 prompt → 行为不变(prompt 为 null)", async () => {
      const { id } = await registerParticipant({ name: "coord-non-exec" });
      const { id: plainId } = await registerParticipant({
        name: "non-exec-participant",
      });
      const group = await createGroup(id, "非执行器");

      const res = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
        },
        body: JSON.stringify({ participantId: plainId, roles: ["observer"] }),
      });
      expect(res.status).toBe(200);
      expect(
        ((await res.json()) as { prompt: string | null }).prompt,
      ).toBeNull();
    });

    it("PATCH 只改 prompt:roles 不变", async () => {
      const { id } = await registerParticipant({
        name: "coord-patch-prompt",
      });
      const { id: memberId } = await registerParticipant({
        name: "patch-prompt-participant",
      });
      const group = await createGroup(id, "只改提示词");
      await addMember(id, group.id, memberId, ["reviewer"]);

      const patchRes = await app.request(
        `/api/groups/${group.id}/members/${memberId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": id,
          },
          body: JSON.stringify({ prompt: "只负责 review" }),
        },
      );
      expect(patchRes.status).toBe(200);
      const updated = (await patchRes.json()) as {
        roles: string[];
        prompt: string | null;
      };
      expect(updated.roles).toEqual(["reviewer"]); // roles 未动
      expect(updated.prompt).toBe("只负责 review");
    });

    it("PATCH roles + prompt 同时更新", async () => {
      const { id } = await registerParticipant({
        name: "coord-both",
      });
      const { id: memberId } = await registerParticipant({
        name: "both-participant",
      });
      const group = await createGroup(id, "同时更新");
      await addMember(id, group.id, memberId, ["observer"]);

      const patchRes = await app.request(
        `/api/groups/${group.id}/members/${memberId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": id,
          },
          body: JSON.stringify({ roles: ["executor"], prompt: "执行 + 汇报" }),
        },
      );
      expect(patchRes.status).toBe(200);
      const updated = (await patchRes.json()) as {
        roles: string[];
        prompt: string | null;
      };
      expect(updated.roles).toEqual(["executor"]);
      expect(updated.prompt).toBe("执行 + 汇报");
    });

    it("PATCH 空 body(roles 与 prompt 都不给)返回 400", async () => {
      const { id } = await registerParticipant({
        name: "coord-empty",
      });
      const { id: memberId } = await registerParticipant({
        name: "empty-patch",
      });
      const group = await createGroup(id, "空 PATCH 校验");
      await addMember(id, group.id, memberId, ["observer"]);

      const res = await app.request(
        `/api/groups/${group.id}/members/${memberId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": id,
          },
          body: JSON.stringify({}),
        },
      );
      expect(res.status).toBe(400);
    });

    it("prompt 超过 1000 字返回 400", async () => {
      const { id } = await registerParticipant({
        name: "coord-long",
      });
      const { id: memberId } = await registerParticipant({
        name: "long-prompt-participant",
      });
      const group = await createGroup(id, "超长提示词校验");

      const res = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
        },
        body: JSON.stringify({
          participantId: memberId,
          roles: ["executor"],
          prompt: "a".repeat(1001),
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("加群 skill 提示 (R3: 不再发引导群消息,改在响应里按能力提示)", () => {
    async function groupSkillMessages(groupId: string): Promise<string[]> {
      const rows = await testDb
        .select({ body: groupMessageTable.body })
        .from(groupMessageTable)
        .where(eq(groupMessageTable.groupId, groupId));
      return rows.map((r) => r.body ?? "");
    }

    it("添加 executor 成员不再产生 skill 安装引导群消息,响应提示未装", async () => {
      const { id } = await registerParticipant({ name: "coord-skill" });
      const { id: executorId } = await registerParticipant({
        name: "skill-executor",
      });
      const group = await createGroup(id, "skill 提示群");

      const res = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
        },
        body: JSON.stringify({
          participantId: executorId,
          roles: ["executor"],
        }),
      });
      expect(res.status).toBe(200);
      const member = (await res.json()) as { capabilityHint: string | null };
      // 该成员 capabilities 未含 coagenthub-executor → 响应带未装提示。
      expect(member.capabilityHint).toContain("coagenthub-executor");
      expect(member.capabilityHint).toContain("未安装");

      // 不产生任何群消息(等待 fire-and-forget 的窗口时间后仍无)。
      await new Promise((r) => setTimeout(r, 50));
      const bodies = await groupSkillMessages(group.id);
      expect(bodies.some((b) => b.includes("请先安装"))).toBe(false);
    });

    it("capabilities 已含对应 skill 时,加群响应无提示(已装不提示)", async () => {
      const { id } = await registerParticipant({ name: "coord-skill5" });
      const { id: executorId } = await registerParticipant({
        name: "skill-executor-installed",
        capabilities: ["coagenthub-executor"],
      });
      const group = await createGroup(id, "已装 skill 群");

      const res = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
        },
        body: JSON.stringify({
          participantId: executorId,
          roles: ["executor"],
        }),
      });
      expect(res.status).toBe(200);
      const member = (await res.json()) as { capabilityHint: string | null };
      expect(member.capabilityHint).toBeNull();

      // 同样不产生群消息。
      await new Promise((r) => setTimeout(r, 50));
      const bodies = await groupSkillMessages(group.id);
      expect(bodies.some((b) => b.includes("请先安装"))).toBe(false);
    });

    it("reviewer 角色缺 skill 时响应提示、不产生群消息;bugfix 非群角色无对应提示", async () => {
      const { id } = await registerParticipant({ name: "coord-skill3" });
      const { id: reviewerId } = await registerParticipant({
        name: "skill-reviewer",
      });
      const group = await createGroup(id, "reviewer 提示群");

      const res = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
        },
        body: JSON.stringify({
          participantId: reviewerId,
          roles: ["reviewer"],
        }),
      });
      expect(res.status).toBe(200);
      const member = (await res.json()) as { capabilityHint: string | null };
      expect(member.capabilityHint).toContain("coagenthub-reviewer");
      expect(member.capabilityHint).toContain("未安装");

      await new Promise((r) => setTimeout(r, 50));
      const rows = await testDb
        .select({ body: groupMessageTable.body })
        .from(groupMessageTable)
        .where(eq(groupMessageTable.groupId, group.id));
      // 无任何「请先安装」引导消息。
      expect(rows.some((r) => (r.body ?? "").includes("请先安装"))).toBe(false);
    });

    it("添加 observer 成员:无群消息,也无 skill 提示(observer 无对应 skill)", async () => {
      const { id } = await registerParticipant({ name: "coord-skill4" });
      const { id: observerId } = await registerParticipant({
        name: "skill-observer",
      });
      const group = await createGroup(id, "observer 无提示");

      const res = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
        },
        body: JSON.stringify({
          participantId: observerId,
          roles: ["observer"],
        }),
      });
      expect(res.status).toBe(200);
      const member = (await res.json()) as { capabilityHint: string | null };
      expect(member.capabilityHint).toBeNull();

      await new Promise((r) => setTimeout(r, 50));
      const bodies = await groupSkillMessages(group.id);
      expect(bodies.some((b) => b.includes("请先安装"))).toBe(false);
    });
  });
});
