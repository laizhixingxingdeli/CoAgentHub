import { describe, expect, it } from "vitest";
import { createTestApp } from "./app";

/**
 * Group member management (ticket 20): DELETE /:id/members/:participantId removes a
 * non-creator member; PATCH /:id/members/:participantId updates a member's roles
 * with the same dedupe rule as POST /members. The creator (群主) can never be
 * removed.
 */
describe("群组成员管理 API (ticket 20)", () => {
  const app = createTestApp();

  /** Register an participant and return { id, token }. */
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
    return (await res.json()) as {
      id: string;
      title: string;
      status: string;
      createdBy: string;
    };
  }

  /** Add a member to the group (the POST upsert), returning the member row. */
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
    return (await res.json()) as { participantId: string; roles: string[] };
  }

  async function listMemberIds(
    token: string,
    groupId: string,
  ): Promise<string[]> {
    const res = await app.request(`/api/groups/${groupId}/members`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const members = (await res.json()) as Array<{ participantId: string }>;
    return members.map((m) => m.participantId);
  }

  describe("DELETE /api/groups/:id/members/:participantId 移除成员", () => {
    it("移除普通成员成功,移除后 GET members 不含该人", async () => {
      const { id: ownerId, token } = await registerParticipant({
        name: "coord",
      });
      const { id: memberId } = await registerParticipant({
        name: "win-hermes",
      });
      const group = await createGroup(token, "移除任务");
      await addMember(token, group.id, memberId, ["reviewer"]);
      expect(await listMemberIds(token, group.id)).toEqual([ownerId, memberId]);

      const delRes = await app.request(
        `/api/groups/${group.id}/members/${memberId}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(delRes.status).toBe(200);
      expect((await delRes.json()) as { success: boolean }).toEqual({
        success: true,
      });

      // The removed member is gone from the list; the creator stays.
      expect(await listMemberIds(token, group.id)).toEqual([ownerId]);
    });

    it("移除不存在的成员返回 404 MEMBER_NOT_FOUND", async () => {
      const { token } = await registerParticipant({
        name: "coord",
      });
      const { id: outsiderId } = await registerParticipant({
        name: "outsider",
      });
      const group = await createGroup(token, "不存在成员");

      const res = await app.request(
        `/api/groups/${group.id}/members/${outsiderId}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("MEMBER_NOT_FOUND");
    });

    it("群组不存在返回 404 GROUP_NOT_FOUND", async () => {
      const { token } = await registerParticipant({
        name: "coord",
      });
      const res = await app.request(
        "/api/groups/00000000-0000-0000-0000-00000000dead/members/00000000-0000-0000-0000-00000000beef",
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("GROUP_NOT_FOUND");
    });

    it("移除群主返回 400,且群主仍保留在成员列表", async () => {
      const { id: ownerId, token } = await registerParticipant({
        name: "coord",
      });
      const group = await createGroup(token, "群主保护");

      const res = await app.request(
        `/api/groups/${group.id}/members/${ownerId}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(res.status).toBe(400);
      expect((await res.json()).message).toBe("不能移除群主");
      expect(await listMemberIds(token, group.id)).toEqual([ownerId]);
    });
  });

  describe("PATCH /api/groups/:id/members/:participantId 改角色", () => {
    it("改角色成功,更新后 GET 反映新 roles", async () => {
      const { token } = await registerParticipant({
        name: "coord",
      });
      const { id: memberId } = await registerParticipant({
        name: "win-hermes",
      });
      const group = await createGroup(token, "改角色任务");
      await addMember(token, group.id, memberId, ["observer"]);

      const patchRes = await app.request(
        `/api/groups/${group.id}/members/${memberId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ roles: ["reviewer", "executor"] }),
        },
      );
      expect(patchRes.status).toBe(200);
      const updated = (await patchRes.json()) as {
        participantId: string;
        roles: string[];
      };
      expect(updated.participantId).toBe(memberId);
      expect(updated.roles).toEqual(["reviewer", "executor"]);

      const membersRes = await app.request(`/api/groups/${group.id}/members`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const members = (await membersRes.json()) as Array<{
        participantId: string;
        roles: string[];
      }>;
      const member = members.find((m) => m.participantId === memberId);
      expect(member?.roles).toEqual(["reviewer", "executor"]);
    });

    it("重复角色去重(与 POST /members 同规则)", async () => {
      const { token } = await registerParticipant({
        name: "coord",
      });
      const { id: memberId } = await registerParticipant({
        name: "dedupe",
      });
      const group = await createGroup(token, "去重任务");
      await addMember(token, group.id, memberId, ["observer"]);

      const patchRes = await app.request(
        `/api/groups/${group.id}/members/${memberId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ roles: ["executor", "executor", "reviewer"] }),
        },
      );
      expect(patchRes.status).toBe(200);
      expect(((await patchRes.json()) as { roles: string[] }).roles).toEqual([
        "executor",
        "reviewer",
      ]);
    });

    it("roles 空数组返回 400", async () => {
      const { token } = await registerParticipant({
        name: "coord",
      });
      const { id: memberId } = await registerParticipant({
        name: "empty",
      });
      const group = await createGroup(token, "空角色校验");
      await addMember(token, group.id, memberId, ["observer"]);

      const res = await app.request(
        `/api/groups/${group.id}/members/${memberId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ roles: [] }),
        },
      );
      expect(res.status).toBe(400);
    });

    it("roles 含非预设角色返回 400", async () => {
      const { token } = await registerParticipant({
        name: "coord",
      });
      const { id: memberId } = await registerParticipant({
        name: "bogus",
      });
      const group = await createGroup(token, "非法角色校验");
      await addMember(token, group.id, memberId, ["observer"]);

      const res = await app.request(
        `/api/groups/${group.id}/members/${memberId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ roles: ["superadmin"] }),
        },
      );
      expect(res.status).toBe(400);
    });

    it("成员不存在返回 404 MEMBER_NOT_FOUND", async () => {
      const { token } = await registerParticipant({
        name: "coord",
      });
      const { id: outsiderId } = await registerParticipant({
        name: "outsider",
      });
      const group = await createGroup(token, "不存在成员改角色");

      const res = await app.request(
        `/api/groups/${group.id}/members/${outsiderId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
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
      const { token } = await registerParticipant({
        name: "coord-prompt",
      });
      const { id: memberId } = await registerParticipant({
        name: "prompt-participant",
      });
      const group = await createGroup(token, "分工提示词");

      const res = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
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
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json()) as Array<{ participantId: string; prompt: string | null }>;
      const member = members.find((m) => m.participantId === memberId);
      expect(member?.prompt).toBe("负责代码执行与测试跑通");
    });

    it("POST 不带 prompt 不破坏旧行为(prompt 为 null)", async () => {
      const { token } = await registerParticipant({
        name: "coord-noprompt",
      });
      const { id: memberId } = await registerParticipant({
        name: "plain-participant",
      });
      const group = await createGroup(token, "无提示词成员");

      const res = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ participantId: memberId, roles: ["observer"] }),
      });
      expect(res.status).toBe(200);
      expect(
        ((await res.json()) as { prompt: string | null }).prompt,
      ).toBeNull();
    });

    it("幂等 upsert 不带 prompt 保持既有分工提示词", async () => {
      const { token } = await registerParticipant({
        name: "coord-upsert",
      });
      const { id: memberId } = await registerParticipant({
        name: "upsert-participant",
      });
      const group = await createGroup(token, "upsert 提示词");

      const first = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
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
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ participantId: memberId, roles: ["reviewer"] }),
      });
      expect(second.status).toBe(200);
      expect(((await second.json()) as { prompt: string | null }).prompt).toBe(
        "初始分工",
      );
    });

    it("PATCH 只改 prompt:roles 不变", async () => {
      const { token } = await registerParticipant({
        name: "coord-patch-prompt",
      });
      const { id: memberId } = await registerParticipant({
        name: "patch-prompt-participant",
      });
      const group = await createGroup(token, "只改提示词");
      await addMember(token, group.id, memberId, ["reviewer"]);

      const patchRes = await app.request(
        `/api/groups/${group.id}/members/${memberId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
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
      const { token } = await registerParticipant({
        name: "coord-both",
      });
      const { id: memberId } = await registerParticipant({
        name: "both-participant",
      });
      const group = await createGroup(token, "同时更新");
      await addMember(token, group.id, memberId, ["observer"]);

      const patchRes = await app.request(
        `/api/groups/${group.id}/members/${memberId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
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
      const { token } = await registerParticipant({
        name: "coord-empty",
      });
      const { id: memberId } = await registerParticipant({
        name: "empty-patch",
      });
      const group = await createGroup(token, "空 PATCH 校验");
      await addMember(token, group.id, memberId, ["observer"]);

      const res = await app.request(
        `/api/groups/${group.id}/members/${memberId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({}),
        },
      );
      expect(res.status).toBe(400);
    });

    it("prompt 超过 1000 字返回 400", async () => {
      const { token } = await registerParticipant({
        name: "coord-long",
      });
      const { id: memberId } = await registerParticipant({
        name: "long-prompt-participant",
      });
      const group = await createGroup(token, "超长提示词校验");

      const res = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
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
});
