import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./app";

/**
 * Groups & members API (ticket 02): create group (creator auto-joins as
 * coordinator), list/filter, add members with preset-role validation,
 * idempotent role updates, archive, and error codes for invalid input.
 */
describe("群组与成员 API", () => {
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

  describe("POST /api/groups 建群", () => {
    it("创建成功,创建者自动成为 coordinator 成员", async () => {
      const { id: agentId, token } = await registerAgent({
        name: "hermes-mac",
        type: "hermes",
        device: "mac-mini",
      });

      const group = await createGroup(token, "模型训练任务");
      expect(group.id).toBeTruthy();
      expect(group.title).toBe("模型训练任务");
      expect(group.status).toBe("active");
      expect(group.createdBy).toBe(agentId);

      const membersRes = await app.request(`/api/groups/${group.id}/members`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(membersRes.status).toBe(200);
      const members = (await membersRes.json()) as Array<{
        agentId: string;
        name: string;
        roles: string[];
      }>;
      expect(members).toHaveLength(1);
      expect(members[0].agentId).toBe(agentId);
      expect(members[0].name).toBe("hermes-mac");
      expect(members[0].roles).toEqual(["coordinator"]);
    });

    it("无 token 以本地用户身份建群(200,createdBy=Local User)", async () => {
      const res = await app.request("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      });
      expect(res.status).toBe(200);
      const group = (await res.json()) as { createdBy: string };
      expect(group.createdBy).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("缺 title 返回 400", async () => {
      const { token } = await registerAgent({ name: "a", type: "atomcode" });
      const res = await app.request("/api/groups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/groups 列表与过滤", () => {
    it("返回全部群组并带 status 与成员数", async () => {
      const { token } = await registerAgent({ name: "coord", type: "hermes" });
      const group = await createGroup(token, "任务一");

      const res = await app.request("/api/groups", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const list = (await res.json()) as Array<{
        id: string;
        title: string;
        status: string;
        memberCount: number;
      }>;
      const item = list.find((g) => g.id === group.id);
      expect(item).toBeTruthy();
      expect(item?.status).toBe("active");
      expect(item?.memberCount).toBe(1); // creator only
    });

    it("?status=archived 只返回已归档群组", async () => {
      const { token } = await registerAgent({ name: "c2", type: "hermes" });
      const active = await createGroup(token, "保留");
      const archived = await createGroup(token, "归档");
      await app.request(`/api/groups/${archived.id}/archive`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      const archivedRes = await app.request("/api/groups?status=archived", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const archivedList = (await archivedRes.json()) as Array<{ id: string }>;
      expect(archivedList.some((g) => g.id === archived.id)).toBe(true);
      expect(archivedList.some((g) => g.id === active.id)).toBe(false);

      const activeRes = await app.request("/api/groups?status=active", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const activeList = (await activeRes.json()) as Array<{ id: string }>;
      expect(activeList.some((g) => g.id === active.id)).toBe(true);
      expect(activeList.some((g) => g.id === archived.id)).toBe(false);
    });

    it("非法 status 过滤值返回 400", async () => {
      const { token } = await registerAgent({ name: "c3", type: "hermes" });
      const res = await app.request("/api/groups?status=bogus", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/groups/:id/members 加成员", () => {
    it("添加成员并分配角色,重复添加幂等更新角色", async () => {
      const { token } = await registerAgent({ name: "coord", type: "hermes" });
      const { id: reviewerId } = await registerAgent({
        name: "win-hermes",
        type: "hermes",
        device: "win-pc",
      });
      const group = await createGroup(token, "评审任务");

      const addRes = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ agentId: reviewerId, roles: ["reviewer"] }),
      });
      expect(addRes.status).toBe(200);

      // Idempotent re-add updates roles.
      const updateRes = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          agentId: reviewerId,
          roles: ["reviewer", "executor"],
        }),
      });
      expect(updateRes.status).toBe(200);
      const updated = (await updateRes.json()) as { roles: string[] };
      expect(updated.roles).toEqual(["reviewer", "executor"]);

      const membersRes = await app.request(`/api/groups/${group.id}/members`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const members = (await membersRes.json()) as Array<{
        agentId: string;
        name: string;
        type: string;
        device: string | null;
        roles: string[];
      }>;
      expect(members).toHaveLength(2);
      const reviewer = members.find((m) => m.agentId === reviewerId);
      expect(reviewer?.name).toBe("win-hermes");
      expect(reviewer?.type).toBe("hermes");
      expect(reviewer?.device).toBe("win-pc");
      expect(reviewer?.roles).toEqual(["reviewer", "executor"]);
    });

    it("roles 缺省或为空时默认 ['observer']", async () => {
      const { token } = await registerAgent({ name: "coord", type: "hermes" });
      const { id: watcherId } = await registerAgent({
        name: "watcher",
        type: "atomcode",
      });
      const group = await createGroup(token, "观察任务");

      // Missing roles key.
      const res = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ agentId: watcherId }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { roles: string[] }).roles).toEqual([
        "observer",
      ]);

      // Explicitly empty roles array also defaults to observer (and the
      // idempotent update replaces the previous roles).
      const emptyRes = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ agentId: watcherId, roles: [] }),
      });
      expect(emptyRes.status).toBe(200);
      expect(((await emptyRes.json()) as { roles: string[] }).roles).toEqual([
        "observer",
      ]);
    });

    it("roles 不在预设目录中返回 400", async () => {
      const { token } = await registerAgent({ name: "coord", type: "hermes" });
      const { id: agentId } = await registerAgent({
        name: "x",
        type: "openclaw",
      });
      const group = await createGroup(token, "校验任务");

      const res = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ agentId, roles: ["superadmin"] }),
      });
      expect(res.status).toBe(400);
    });

    it("群组不存在返回 404 GROUP_NOT_FOUND", async () => {
      const { token } = await registerAgent({ name: "coord", type: "hermes" });
      const { id: agentId } = await registerAgent({
        name: "y",
        type: "hermes",
      });
      const res = await app.request(
        "/api/groups/00000000-0000-0000-0000-00000000dead/members",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ agentId, roles: ["observer"] }),
        },
      );
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("GROUP_NOT_FOUND");
    });

    it("agent 不存在返回 404 AGENT_NOT_FOUND", async () => {
      const { token } = await registerAgent({ name: "coord", type: "hermes" });
      const group = await createGroup(token, "校验 agent");
      const res = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          agentId: "00000000-0000-0000-0000-00000000beef",
          roles: ["observer"],
        }),
      });
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("AGENT_NOT_FOUND");
    });

    it("非 UUID groupId/agentId 返回 400", async () => {
      const { token } = await registerAgent({ name: "coord", type: "hermes" });
      const badGroup = await app.request("/api/groups/not-a-uuid/members", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ agentId: "also-not-uuid" }),
      });
      expect(badGroup.status).toBe(400);
    });
  });

  describe("GET /api/groups/:id/members 成员列表", () => {
    it("群组不存在返回 404", async () => {
      const { token } = await registerAgent({ name: "coord", type: "hermes" });
      const res = await app.request(
        "/api/groups/00000000-0000-0000-0000-00000000dead/members",
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("GROUP_NOT_FOUND");
    });
  });

  describe("POST /api/groups/:id/archive 归档", () => {
    it("active -> archived,再次归档返回 404", async () => {
      const { token } = await registerAgent({ name: "coord", type: "hermes" });
      const group = await createGroup(token, "完成后归档");

      const archiveRes = await app.request(`/api/groups/${group.id}/archive`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(archiveRes.status).toBe(200);
      expect(((await archiveRes.json()) as { status: string }).status).toBe(
        "archived",
      );

      const againRes = await app.request(`/api/groups/${group.id}/archive`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(againRes.status).toBe(404);
      expect((await againRes.json()).code).toBe("GROUP_NOT_FOUND");
    });

    it("不存在的群组返回 404", async () => {
      const { token } = await registerAgent({ name: "coord", type: "hermes" });
      const res = await app.request(
        "/api/groups/00000000-0000-0000-0000-00000000dead/archive",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("GROUP_NOT_FOUND");
    });
  });

  describe("归档生命周期闭环 (ticket 16): unarchive / 只读 / GET :id / 软删除", () => {
    it("POST /:id/unarchive:archived -> active,再次 unarchive 返回 404", async () => {
      const { token } = await registerAgent({ name: "coord", type: "hermes" });
      const group = await createGroup(token, "可恢复的归档");

      const archiveRes = await app.request(`/api/groups/${group.id}/archive`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(archiveRes.status).toBe(200);
      expect(((await archiveRes.json()) as { status: string }).status).toBe(
        "archived",
      );

      const unarchiveRes = await app.request(
        `/api/groups/${group.id}/unarchive`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(unarchiveRes.status).toBe(200);
      expect(((await unarchiveRes.json()) as { status: string }).status).toBe(
        "active",
      );

      // Unarchiving an active group is a no-match -> same 404 semantics as
      // archive on a non-active group.
      const againRes = await app.request(`/api/groups/${group.id}/unarchive`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(againRes.status).toBe(404);
      expect((await againRes.json()).code).toBe("GROUP_NOT_FOUND");

      // Round-trip complete: the group is active again and can be archived
      // once more (the lifecycle is not one-way).
      const reArchiveRes = await app.request(
        `/api/groups/${group.id}/archive`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(reArchiveRes.status).toBe(200);
    });

    it("归档群组禁发消息返回 400,读取(messages/members/:id)仍 200", async () => {
      const { id: agentId, token } = await registerAgent({
        name: "coord",
        type: "hermes",
      });
      const group = await createGroup(token, "只读归档");
      await app.request(`/api/groups/${group.id}/archive`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      const postRes = await app.request(`/api/groups/${group.id}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ body: "归档后不应写入" }),
      });
      expect(postRes.status).toBe(400);

      const readRes = await app.request(`/api/groups/${group.id}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(readRes.status).toBe(200);
      expect(await readRes.json()).toEqual([]);

      const membersRes = await app.request(`/api/groups/${group.id}/members`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(membersRes.status).toBe(200);
      const members = (await membersRes.json()) as Array<{ agentId: string }>;
      expect(members).toHaveLength(1);
      expect(members[0].agentId).toBe(agentId);

      const detailRes = await app.request(`/api/groups/${group.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(detailRes.status).toBe(200);
      expect(((await detailRes.json()) as { status: string }).status).toBe(
        "archived",
      );
    });

    it("GET /:id 返回群组详情含 status,不存在的群组 404", async () => {
      const { token } = await registerAgent({ name: "coord", type: "hermes" });
      const group = await createGroup(token, "详情查询");

      const res = await app.request(`/api/groups/${group.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const detail = (await res.json()) as {
        id: string;
        title: string;
        status: string;
        createdBy: string;
      };
      expect(detail.id).toBe(group.id);
      expect(detail.title).toBe("详情查询");
      expect(detail.status).toBe("active");
      expect(detail.createdBy).toBeTruthy();

      const missingRes = await app.request(
        "/api/groups/00000000-0000-0000-0000-00000000dead",
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(missingRes.status).toBe(404);
      expect((await missingRes.json()).code).toBe("GROUP_NOT_FOUND");
    });

    it("软删除:DELETE /:id 后列表不再返回,active/archived 不受影响,重复删除 404", async () => {
      const { token } = await registerAgent({ name: "coord", type: "hermes" });
      const doomed = await createGroup(token, "将被删除");
      const active = await createGroup(token, "保留的进行中");
      const archived = await createGroup(token, "保留的已归档");
      await app.request(`/api/groups/${archived.id}/archive`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      const delRes = await app.request(`/api/groups/${doomed.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(delRes.status).toBe(200);
      expect(((await delRes.json()) as { status: string }).status).toBe(
        "deleted",
      );

      // Unfiltered list excludes the deleted group but keeps both survivors.
      const allRes = await app.request("/api/groups", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(allRes.status).toBe(200);
      const all = (await allRes.json()) as Array<{ id: string }>;
      expect(all.some((g) => g.id === doomed.id)).toBe(false);
      expect(all.some((g) => g.id === active.id)).toBe(true);
      expect(all.some((g) => g.id === archived.id)).toBe(true);

      // ?status=active / ?status=archived are unaffected by the deletion.
      const activeRes = await app.request("/api/groups?status=active", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const activeList = (await activeRes.json()) as Array<{ id: string }>;
      expect(activeList.some((g) => g.id === doomed.id)).toBe(false);
      expect(activeList.some((g) => g.id === active.id)).toBe(true);

      const archivedRes = await app.request("/api/groups?status=archived", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const archivedList = (await archivedRes.json()) as Array<{ id: string }>;
      expect(archivedList.some((g) => g.id === archived.id)).toBe(true);

      // Deleting an already-deleted group is a no-match -> 404.
      const againRes = await app.request(`/api/groups/${doomed.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(againRes.status).toBe(404);
      expect((await againRes.json()).code).toBe("GROUP_NOT_FOUND");
    });

    it("软删除保留数据:历史消息仍可查,成员关系仍在", async () => {
      const { id: agentId, token } = await registerAgent({
        name: "coord",
        type: "hermes",
      });
      const group = await createGroup(token, "删除后仍有历史");

      const postRes = await app.request(`/api/groups/${group.id}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ body: "删除前的消息" }),
      });
      expect(postRes.status).toBe(200);

      const delRes = await app.request(`/api/groups/${group.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(delRes.status).toBe(200);

      // History rows survive: the message list still serves them (GET stays
      // open even for a deleted group — rows are kept, not purged).
      const messagesRes = await app.request(
        `/api/groups/${group.id}/messages`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(messagesRes.status).toBe(200);
      const messages = (await messagesRes.json()) as Array<{ body: string }>;
      expect(messages.map((m) => m.body)).toEqual(["删除前的消息"]);

      const membersRes = await app.request(`/api/groups/${group.id}/members`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(membersRes.status).toBe(200);
      const members = (await membersRes.json()) as Array<{ agentId: string }>;
      expect(members.some((m) => m.agentId === agentId)).toBe(true);
    });
  });

  describe("PATCH /api/groups/:id 绑定项目路径 (projectPath)", () => {
    it("迁移已应用:新建群 GET /:id 返回 projectPath 且初始为 null", async () => {
      const { token } = await registerAgent({ name: "coord", type: "hermes" });
      const group = await createGroup(token, "绑定前");

      const res = await app.request(`/api/groups/${group.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const detail = (await res.json()) as { projectPath: string | null };
      expect(detail.projectPath).toBeNull();
    });

    it("绑定存在的绝对目录成功,GET /:id 返回该 projectPath", async () => {
      const { token } = await registerAgent({ name: "coord", type: "hermes" });
      const group = await createGroup(token, "绑定成功");
      const dir = mkdtempSync(join(tmpdir(), "coagent-group-proj-"));

      const patchRes = await app.request(`/api/groups/${group.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ projectPath: dir }),
      });
      expect(patchRes.status).toBe(200);
      expect(
        ((await patchRes.json()) as { projectPath: string }).projectPath,
      ).toBe(dir);

      const getRes = await app.request(`/api/groups/${group.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(getRes.status).toBe(200);
      expect(
        ((await getRes.json()) as { projectPath: string }).projectPath,
      ).toBe(dir);

      rmSync(dir, { recursive: true, force: true });
    });

    it("null 与空串均清空绑定", async () => {
      const { token } = await registerAgent({ name: "coord", type: "hermes" });
      const group = await createGroup(token, "清空绑定");
      const dir = mkdtempSync(join(tmpdir(), "coagent-group-proj-"));

      const bindRes = await app.request(`/api/groups/${group.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ projectPath: dir }),
      });
      expect(bindRes.status).toBe(200);

      // null 清空
      const clearRes = await app.request(`/api/groups/${group.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ projectPath: null }),
      });
      expect(clearRes.status).toBe(200);
      expect(
        ((await clearRes.json()) as { projectPath: string | null }).projectPath,
      ).toBeNull();

      // 空串清空
      const bindAgainRes = await app.request(`/api/groups/${group.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ projectPath: dir }),
      });
      expect(bindAgainRes.status).toBe(200);
      const emptyRes = await app.request(`/api/groups/${group.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ projectPath: "" }),
      });
      expect(emptyRes.status).toBe(200);
      expect(
        ((await emptyRes.json()) as { projectPath: string | null }).projectPath,
      ).toBeNull();

      rmSync(dir, { recursive: true, force: true });
    });

    it("相对路径 / 不存在路径 / 非目录路径均返回 400", async () => {
      const { token } = await registerAgent({ name: "coord", type: "hermes" });
      const group = await createGroup(token, "非法路径");
      const dir = mkdtempSync(join(tmpdir(), "coagent-group-proj-"));
      const filePath = join(dir, "not-a-dir");
      writeFileSync(filePath, "x");

      const cases = [
        "relative/path", // 相对路径
        join(dir, "no-such-dir"), // 不存在
        filePath, // 存在但是文件
      ];
      for (const projectPath of cases) {
        const res = await app.request(`/api/groups/${group.id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ projectPath }),
        });
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe("INVALID_REQUEST");
      }

      rmSync(dir, { recursive: true, force: true });
    });

    it("群组不存在返回 404 GROUP_NOT_FOUND", async () => {
      const { token } = await registerAgent({ name: "coord", type: "hermes" });
      const dir = mkdtempSync(join(tmpdir(), "coagent-group-proj-"));

      const res = await app.request(
        "/api/groups/00000000-0000-0000-0000-00000000dead",
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ projectPath: dir }),
        },
      );
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("GROUP_NOT_FOUND");

      rmSync(dir, { recursive: true, force: true });
    });
  });
});
