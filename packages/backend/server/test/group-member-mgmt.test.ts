import { describe, expect, it } from "vitest";
import { createTestApp } from "./app";

/**
 * Group member management (ticket 20): DELETE /:id/members/:agentId removes a
 * non-creator member; PATCH /:id/members/:agentId updates a member's roles
 * with the same dedupe rule as POST /members. The creator (群主) can never be
 * removed.
 */
describe("群组成员管理 API (ticket 20)", () => {
  const app = createTestApp();

  /** Register an agent and return { id, token }. */
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
    return (await res.json()) as { agentId: string; roles: string[] };
  }

  async function listMemberIds(
    token: string,
    groupId: string,
  ): Promise<string[]> {
    const res = await app.request(`/api/groups/${groupId}/members`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const members = (await res.json()) as Array<{ agentId: string }>;
    return members.map((m) => m.agentId);
  }

  describe("DELETE /api/groups/:id/members/:agentId 移除成员", () => {
    it("移除普通成员成功,移除后 GET members 不含该人", async () => {
      const { id: ownerId, token } = await registerAgent({
        name: "coord",
        type: "hermes",
      });
      const { id: memberId } = await registerAgent({
        name: "win-hermes",
        type: "hermes",
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
      const { token } = await registerAgent({ name: "coord", type: "hermes" });
      const { id: outsiderId } = await registerAgent({
        name: "outsider",
        type: "atomcode",
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
      const { token } = await registerAgent({ name: "coord", type: "hermes" });
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
      const { id: ownerId, token } = await registerAgent({
        name: "coord",
        type: "hermes",
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

  describe("PATCH /api/groups/:id/members/:agentId 改角色", () => {
    it("改角色成功,更新后 GET 反映新 roles", async () => {
      const { token } = await registerAgent({ name: "coord", type: "hermes" });
      const { id: memberId } = await registerAgent({
        name: "win-hermes",
        type: "hermes",
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
        agentId: string;
        roles: string[];
      };
      expect(updated.agentId).toBe(memberId);
      expect(updated.roles).toEqual(["reviewer", "executor"]);

      const membersRes = await app.request(`/api/groups/${group.id}/members`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const members = (await membersRes.json()) as Array<{
        agentId: string;
        roles: string[];
      }>;
      const member = members.find((m) => m.agentId === memberId);
      expect(member?.roles).toEqual(["reviewer", "executor"]);
    });

    it("重复角色去重(与 POST /members 同规则)", async () => {
      const { token } = await registerAgent({ name: "coord", type: "hermes" });
      const { id: memberId } = await registerAgent({
        name: "dedupe",
        type: "atomcode",
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
      const { token } = await registerAgent({ name: "coord", type: "hermes" });
      const { id: memberId } = await registerAgent({
        name: "empty",
        type: "hermes",
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
      const { token } = await registerAgent({ name: "coord", type: "hermes" });
      const { id: memberId } = await registerAgent({
        name: "bogus",
        type: "hermes",
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
      const { token } = await registerAgent({ name: "coord", type: "hermes" });
      const { id: outsiderId } = await registerAgent({
        name: "outsider",
        type: "atomcode",
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
});
