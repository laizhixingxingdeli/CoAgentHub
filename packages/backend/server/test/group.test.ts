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

  /** Register an participant and return { id }. */
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
    return (await res.json()) as {
      id: string;
      title: string;
      status: string;
      createdBy: string;
    };
  }

  describe("POST /api/groups 建群", () => {
    it("创建成功,创建者自动成为 coordinator 成员", async () => {
      const { id: participantId } = await registerParticipant({
        name: "hermes-mac",
        device: "mac-mini",
      });

      const group = await createGroup(participantId, "模型训练任务");
      expect(group.id).toBeTruthy();
      expect(group.title).toBe("模型训练任务");
      expect(group.status).toBe("active");
      expect(group.createdBy).toBe(participantId);

      const membersRes = await app.request(`/api/groups/${group.id}/members`, {
        headers: { "X-Participant-Id": participantId },
      });
      expect(membersRes.status).toBe(200);
      const members = (await membersRes.json()) as Array<{
        participantId: string;
        name: string;
        roles: string[];
      }>;
      expect(members).toHaveLength(1);
      expect(members[0].participantId).toBe(participantId);
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
      const { id } = await registerParticipant({
        name: "a",
      });
      const res = await app.request("/api/groups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/groups 列表与过滤", () => {
    it("返回全部群组并带 status 与成员数", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const group = await createGroup(id, "任务一");

      const res = await app.request("/api/groups", {
        headers: { "X-Participant-Id": id },
      });
      expect(res.status).toBe(200);
      const list = (
        (await res.json()) as {
          items: Array<{
            id: string;
            title: string;
            status: string;
            memberCount: number;
          }>;
        }
      ).items;
      const item = list.find((g) => g.id === group.id);
      expect(item).toBeTruthy();
      expect(item?.status).toBe("active");
      expect(item?.memberCount).toBe(1); // creator only
    });

    it("?status=archived 只返回已归档群组", async () => {
      const { id } = await registerParticipant({
        name: "c2",
      });
      const active = await createGroup(id, "保留");
      const archived = await createGroup(id, "归档");
      await app.request(`/api/groups/${archived.id}/archive`, {
        method: "POST",
        headers: { "X-Participant-Id": id },
      });

      const archivedRes = await app.request("/api/groups?status=archived", {
        headers: { "X-Participant-Id": id },
      });
      const archivedList = (
        (await archivedRes.json()) as { items: Array<{ id: string }> }
      ).items;
      expect(archivedList.some((g) => g.id === archived.id)).toBe(true);
      expect(archivedList.some((g) => g.id === active.id)).toBe(false);

      const activeRes = await app.request("/api/groups?status=active", {
        headers: { "X-Participant-Id": id },
      });
      const activeList = (
        (await activeRes.json()) as { items: Array<{ id: string }> }
      ).items;
      expect(activeList.some((g) => g.id === active.id)).toBe(true);
      expect(activeList.some((g) => g.id === archived.id)).toBe(false);
    });

    it("非法 status 过滤值返回 400", async () => {
      const { id } = await registerParticipant({
        name: "c3",
      });
      const res = await app.request("/api/groups?status=bogus", {
        headers: { "X-Participant-Id": id },
      });
      expect(res.status).toBe(400);
    });

    it("?q= 按标题关键词过滤(子串匹配)", async () => {
      const { id } = await registerParticipant({
        name: "c4",
      });
      const match = await createGroup(id, "模型训练任务");
      await createGroup(id, "部署上线");

      const res = await app.request(
        `/api/groups?q=${encodeURIComponent("训练")}`,
        { headers: { "X-Participant-Id": id } },
      );
      expect(res.status).toBe(200);
      const list = (
        (await res.json()) as {
          items: Array<{ id: string; title: string }>;
        }
      ).items;
      expect(list.some((g) => g.id === match.id)).toBe(true);
      expect(list.every((g) => g.title.includes("训练"))).toBe(true);
    });

    it("?q= 对 LIKE 通配符(%、_)按字面转义", async () => {
      const { id } = await registerParticipant({
        name: "c5",
      });
      const withPercent = await createGroup(id, "进度 100% 达成");
      const withUnderscore = await createGroup(id, "任务_甲");
      const noUnderscore = await createGroup(id, "任务甲");

      // % 按字面匹配,不会当任意长度的通配符。
      const percentRes = await app.request(
        `/api/groups?q=${encodeURIComponent("100%")}`,
        { headers: { "X-Participant-Id": id } },
      );
      expect(percentRes.status).toBe(200);
      const percentList = (
        (await percentRes.json()) as { items: Array<{ id: string }> }
      ).items;
      expect(percentList.some((g) => g.id === withPercent.id)).toBe(true);

      // _ 按字面匹配,不会当单字符通配符(否则 "任务甲" 也会命中)。
      const underscoreRes = await app.request(
        `/api/groups?q=${encodeURIComponent("任务_甲")}`,
        { headers: { "X-Participant-Id": id } },
      );
      expect(underscoreRes.status).toBe(200);
      const underscoreList = (
        (await underscoreRes.json()) as {
          items: Array<{ id: string }>;
        }
      ).items;
      expect(underscoreList.some((g) => g.id === withUnderscore.id)).toBe(true);
      expect(underscoreList.some((g) => g.id === noUnderscore.id)).toBe(false);
    });

    it("?q= 与 ?status= 可组合过滤", async () => {
      const { id } = await registerParticipant({
        name: "c6",
      });
      const active = await createGroup(id, "模型评测 A");
      const archived = await createGroup(id, "模型评测 B");
      await app.request(`/api/groups/${archived.id}/archive`, {
        method: "POST",
        headers: { "X-Participant-Id": id },
      });

      const res = await app.request(
        `/api/groups?q=${encodeURIComponent("模型")}&status=archived`,
        { headers: { "X-Participant-Id": id } },
      );
      expect(res.status).toBe(200);
      const list = ((await res.json()) as { items: Array<{ id: string }> })
        .items;
      expect(list.some((g) => g.id === archived.id)).toBe(true);
      expect(list.some((g) => g.id === active.id)).toBe(false);
    });

    it("?q= 空串等价于无搜索(返回全量)", async () => {
      const { id } = await registerParticipant({
        name: "c7",
      });
      const group = await createGroup(id, "任意标题");

      const res = await app.request("/api/groups?q=", {
        headers: { "X-Participant-Id": id },
      });
      expect(res.status).toBe(200);
      const list = ((await res.json()) as { items: Array<{ id: string }> })
        .items;
      expect(list.some((g) => g.id === group.id)).toBe(true);
    });

    it("?q= 超过 100 字符返回 400", async () => {
      const { id } = await registerParticipant({
        name: "c8",
      });
      const res = await app.request(`/api/groups?q=${"x".repeat(101)}`, {
        headers: { "X-Participant-Id": id },
      });
      expect(res.status).toBe(400);
    });

    it("?limit= 分页:返回指定条数并带 total", async () => {
      const { id } = await registerParticipant({
        name: "c9",
      });
      // 同文件用例共享 DB,先取基线 total 再做相对断言,避免被既有群污染。
      const baseline = (await (
        await app.request("/api/groups", {
          headers: { "X-Participant-Id": id },
        })
      ).json()) as { total: number };

      const ids: string[] = [];
      for (let i = 0; i < 7; i++) {
        const g = await createGroup(id, `分页任务 ${i}`);
        ids.push(g.id);
      }

      const res = await app.request("/api/groups?limit=5", {
        headers: { "X-Participant-Id": id },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{ id: string }>;
        total: number;
      };
      expect(body.items).toHaveLength(5);
      expect(body.total).toBe(baseline.total + 7);
    });

    it("?limit=&offset= 翻页:两页互补、不重叠且 total 不变", async () => {
      const { id } = await registerParticipant({
        name: "c10",
      });
      const ids: string[] = [];
      for (let i = 0; i < 7; i++) {
        const g = await createGroup(id, `翻页任务 ${i}`);
        ids.push(g.id);
      }

      const page1Res = await app.request("/api/groups?limit=5", {
        headers: { "X-Participant-Id": id },
      });
      const page1 = (await page1Res.json()) as {
        items: Array<{ id: string }>;
        total: number;
      };
      expect(page1.items).toHaveLength(5);

      const page2Res = await app.request("/api/groups?limit=5&offset=5", {
        headers: { "X-Participant-Id": id },
      });
      const page2 = (await page2Res.json()) as {
        items: Array<{ id: string }>;
        total: number;
      };
      expect(page2.total).toBe(page1.total);
      // 本用例新建的 7 个群是最新的(createdAt 降序),两页共 10 条应全部覆盖,
      // 且两页互不重叠。
      const seen = new Set([...page1.items, ...page2.items].map((g) => g.id));
      expect(seen.size).toBe(page1.items.length + page2.items.length);
      expect(ids.every((id) => seen.has(id))).toBe(true);
    });

    it("不带分页参数时 items 为全量且 total 一致", async () => {
      const { id } = await registerParticipant({
        name: "c11",
      });
      const baseline = (await (
        await app.request("/api/groups", {
          headers: { "X-Participant-Id": id },
        })
      ).json()) as { items: Array<{ id: string }>; total: number };

      const created = [] as string[];
      for (const title of ["全量一", "全量二", "全量三"]) {
        created.push((await createGroup(id, title)).id);
      }

      const res = await app.request("/api/groups", {
        headers: { "X-Participant-Id": id },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{ id: string }>;
        total: number;
      };
      expect(body.total).toBe(baseline.total + 3);
      expect(body.items).toHaveLength(body.total);
      // 新建群都在全量列表中。
      expect(created.every((id) => body.items.some((g) => g.id === id))).toBe(
        true,
      );
    });

    it("?limit= 与 ?q= 组合:total 按过滤条件计,items 只取一页", async () => {
      const { id } = await registerParticipant({
        name: "c12",
      });
      const match = await createGroup(id, "组合匹配甲");
      const match2 = await createGroup(id, "组合匹配乙");
      const other = await createGroup(id, "无关任务");

      const res = await app.request(
        `/api/groups?q=${encodeURIComponent("组合匹配")}&limit=1`,
        { headers: { "X-Participant-Id": id } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{ id: string }>;
        total: number;
      };
      expect(body.items).toHaveLength(1);
      expect(body.total).toBe(2); // 命中 2 个,但只取 1 条
      expect([match.id, match2.id]).toContain(body.items[0].id);
      expect(body.items[0].id).not.toBe(other.id);
    });

    it("非法 limit/offset 回退默认值(仍返回 200)", async () => {
      const { id } = await registerParticipant({
        name: "c13",
      });
      await createGroup(id, "回退一");
      await createGroup(id, "回退二");

      // 用 q 把列表隔离到本用例的 2 个群,再验证非法分页参数的回退行为。
      for (const qs of [
        "?q=回退&limit=abc",
        "?q=回退&limit=0",
        "?q=回退&limit=999",
        "?q=回退&offset=-1",
        "?q=回退&offset=abc",
      ]) {
        const res = await app.request(`/api/groups${qs}`, {
          headers: { "X-Participant-Id": id },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          items: Array<{ id: string }>;
          total: number;
        };
        expect(body.items).toHaveLength(2);
        expect(body.total).toBe(2);
      }
    });
  });

  describe("POST /api/groups/:id/members 加成员", () => {
    it("添加成员并分配角色,重复添加幂等更新角色", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const { id: reviewerId } = await registerParticipant({
        name: "win-hermes",
        device: "win-pc",
      });
      const group = await createGroup(id, "评审任务");

      const addRes = await app.request(`/api/groups/${group.id}/members`, {
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
      expect(addRes.status).toBe(200);

      // Idempotent re-add updates roles.
      const updateRes = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
        },
        body: JSON.stringify({
          participantId: reviewerId,
          roles: ["reviewer", "executor"],
        }),
      });
      expect(updateRes.status).toBe(200);
      const updated = (await updateRes.json()) as { roles: string[] };
      expect(updated.roles).toEqual(["reviewer", "executor"]);

      const membersRes = await app.request(`/api/groups/${group.id}/members`, {
        headers: { "X-Participant-Id": id },
      });
      const members = (await membersRes.json()) as Array<{
        participantId: string;
        name: string;
        type: string;
        device: string | null;
        roles: string[];
      }>;
      expect(members).toHaveLength(2);
      const reviewer = members.find((m) => m.participantId === reviewerId);
      expect(reviewer?.name).toBe("win-hermes");
      expect(reviewer?.device).toBe("win-pc");
      expect(reviewer?.roles).toEqual(["reviewer", "executor"]);
    });

    it("roles 缺省或为空时默认 ['observer']", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const { id: watcherId } = await registerParticipant({
        name: "watcher",
      });
      const group = await createGroup(id, "观察任务");

      // Missing roles key.
      const res = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
        },
        body: JSON.stringify({ participantId: watcherId }),
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
          "X-Participant-Id": id,
        },
        body: JSON.stringify({ participantId: watcherId, roles: [] }),
      });
      expect(emptyRes.status).toBe(200);
      expect(((await emptyRes.json()) as { roles: string[] }).roles).toEqual([
        "observer",
      ]);
    });

    it("roles 不在预设目录中返回 400", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const { id: participantId } = await registerParticipant({
        name: "x",
      });
      const group = await createGroup(id, "校验任务");

      const res = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
        },
        body: JSON.stringify({ participantId, roles: ["superadmin"] }),
      });
      expect(res.status).toBe(400);
    });

    it("群组不存在返回 404 GROUP_NOT_FOUND", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const { id: participantId } = await registerParticipant({
        name: "y",
      });
      const res = await app.request(
        "/api/groups/00000000-0000-0000-0000-00000000dead/members",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": id,
          },
          body: JSON.stringify({ participantId, roles: ["observer"] }),
        },
      );
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("GROUP_NOT_FOUND");
    });

    it("participant 不存在返回 404 PARTICIPANT_NOT_FOUND", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const group = await createGroup(id, "校验 participant");
      const res = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
        },
        body: JSON.stringify({
          participantId: "00000000-0000-0000-0000-00000000beef",
          roles: ["observer"],
        }),
      });
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("PARTICIPANT_NOT_FOUND");
    });

    it("非 UUID groupId/participantId 返回 400", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const badGroup = await app.request("/api/groups/not-a-uuid/members", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
        },
        body: JSON.stringify({ participantId: "also-not-uuid" }),
      });
      expect(badGroup.status).toBe(400);
    });
  });

  describe("GET /api/groups/:id/members 成员列表", () => {
    it("群组不存在返回 404", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const res = await app.request(
        "/api/groups/00000000-0000-0000-0000-00000000dead/members",
        { headers: { "X-Participant-Id": id } },
      );
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("GROUP_NOT_FOUND");
    });
  });

  describe("POST /api/groups/:id/archive 归档", () => {
    it("active -> archived,再次归档返回 404", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const group = await createGroup(id, "完成后归档");

      const archiveRes = await app.request(`/api/groups/${group.id}/archive`, {
        method: "POST",
        headers: { "X-Participant-Id": id },
      });
      expect(archiveRes.status).toBe(200);
      expect(((await archiveRes.json()) as { status: string }).status).toBe(
        "archived",
      );

      const againRes = await app.request(`/api/groups/${group.id}/archive`, {
        method: "POST",
        headers: { "X-Participant-Id": id },
      });
      expect(againRes.status).toBe(404);
      expect((await againRes.json()).code).toBe("GROUP_NOT_FOUND");
    });

    it("不存在的群组返回 404", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const res = await app.request(
        "/api/groups/00000000-0000-0000-0000-00000000dead/archive",
        {
          method: "POST",
          headers: { "X-Participant-Id": id },
        },
      );
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("GROUP_NOT_FOUND");
    });
  });

  describe("归档生命周期闭环 (ticket 16): unarchive / 只读 / GET :id / 软删除", () => {
    it("POST /:id/unarchive:archived -> active,再次 unarchive 返回 404", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const group = await createGroup(id, "可恢复的归档");

      const archiveRes = await app.request(`/api/groups/${group.id}/archive`, {
        method: "POST",
        headers: { "X-Participant-Id": id },
      });
      expect(archiveRes.status).toBe(200);
      expect(((await archiveRes.json()) as { status: string }).status).toBe(
        "archived",
      );

      const unarchiveRes = await app.request(
        `/api/groups/${group.id}/unarchive`,
        {
          method: "POST",
          headers: { "X-Participant-Id": id },
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
        headers: { "X-Participant-Id": id },
      });
      expect(againRes.status).toBe(404);
      expect((await againRes.json()).code).toBe("GROUP_NOT_FOUND");

      // Round-trip complete: the group is active again and can be archived
      // once more (the lifecycle is not one-way).
      const reArchiveRes = await app.request(
        `/api/groups/${group.id}/archive`,
        {
          method: "POST",
          headers: { "X-Participant-Id": id },
        },
      );
      expect(reArchiveRes.status).toBe(200);
    });

    it("归档群组禁发消息返回 403+原因,读取(messages/members/:id)仍 200", async () => {
      const { id: participantId } = await registerParticipant({
        name: "coord",
      });
      const group = await createGroup(participantId, "只读归档");
      await app.request(`/api/groups/${group.id}/archive`, {
        method: "POST",
        headers: { "X-Participant-Id": participantId },
      });

      const postRes = await app.request(`/api/groups/${group.id}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": participantId,
        },
        body: JSON.stringify({ body: "归档后不应写入" }),
      });
      expect(postRes.status).toBe(403);
      expect((await postRes.json()).code).toBe("FORBIDDEN");

      const readRes = await app.request(`/api/groups/${group.id}/messages`, {
        headers: { "X-Participant-Id": participantId },
      });
      expect(readRes.status).toBe(200);
      expect(await readRes.json()).toEqual([]);

      const membersRes = await app.request(`/api/groups/${group.id}/members`, {
        headers: { "X-Participant-Id": participantId },
      });
      expect(membersRes.status).toBe(200);
      const members = (await membersRes.json()) as Array<{
        participantId: string;
      }>;
      expect(members).toHaveLength(1);
      expect(members[0].participantId).toBe(participantId);

      const detailRes = await app.request(`/api/groups/${group.id}`, {
        headers: { "X-Participant-Id": participantId },
      });
      expect(detailRes.status).toBe(200);
      expect(((await detailRes.json()) as { status: string }).status).toBe(
        "archived",
      );
    });

    it("归档群组成员管理只读:POST/PATCH/DELETE 成员 → 403+原因,GET 仍 200", async () => {
      const { id: coordinatorId } = await registerParticipant({
        name: "coord",
      });
      const { id: memberId } = await registerParticipant({
        name: "member-x",
      });
      const group = await createGroup(coordinatorId, "成员只读归档");
      await app.request(`/api/groups/${group.id}/archive`, {
        method: "POST",
        headers: { "X-Participant-Id": coordinatorId },
      });

      // POST 成员 → 403 + FORBIDDEN
      const addRes = await app.request(`/api/groups/${group.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": coordinatorId,
        },
        body: JSON.stringify({ participantId: memberId, roles: ["observer"] }),
      });
      expect(addRes.status).toBe(403);
      expect((await addRes.json()).code).toBe("FORBIDDEN");

      // PATCH 成员 → 403(成员不存在也会先被只读守卫拦截,仍是 403 而非 404)
      const patchRes = await app.request(
        `/api/groups/${group.id}/members/${coordinatorId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": coordinatorId,
          },
          body: JSON.stringify({ roles: ["observer"] }),
        },
      );
      expect(patchRes.status).toBe(403);

      // DELETE 成员 → 403
      const delRes = await app.request(
        `/api/groups/${group.id}/members/${memberId}`,
        {
          method: "DELETE",
          headers: { "X-Participant-Id": coordinatorId },
        },
      );
      expect(delRes.status).toBe(403);

      // GET 成员仍 200,成员列表未因写操作被改动
      const membersRes = await app.request(`/api/groups/${group.id}/members`, {
        headers: { "X-Participant-Id": coordinatorId },
      });
      expect(membersRes.status).toBe(200);
      const members = (await membersRes.json()) as Array<{
        participantId: string;
      }>;
      expect(members).toHaveLength(1);
      expect(members[0].participantId).toBe(coordinatorId);
    });

    it("归档群组任务只读:POST/PATCH 任务 → 403+原因,GET 任务列表仍 200", async () => {
      const { id: coordinatorId } = await registerParticipant({
        name: "coord",
      });
      const { id: execId } = await registerParticipant({
        name: "executor-y",
      });
      const group = await createGroup(coordinatorId, "任务只读归档");
      await app.request(`/api/groups/${group.id}/archive`, {
        method: "POST",
        headers: { "X-Participant-Id": coordinatorId },
      });

      // POST 任务 → 403(发新任务被归档只读拦截)
      const postRes = await app.request(`/api/groups/${group.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": coordinatorId,
        },
        body: JSON.stringify({
          messageId: "00000000-0000-7000-8000-0000000000aa",
          executorParticipantId: execId,
        }),
      });
      expect(postRes.status).toBe(403);
      expect((await postRes.json()).code).toBe("FORBIDDEN");

      // PATCH 任务 → 403(任务不存在也会先被只读守卫拦截,仍是 403 而非 404)
      const patchRes = await app.request(
        `/api/groups/${group.id}/tasks/00000000-0000-7000-8000-0000000000bb`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": coordinatorId,
          },
          body: JSON.stringify({ status: "done" }),
        },
      );
      expect(patchRes.status).toBe(403);

      // GET 任务列表仍 200(只读放开)
      const listRes = await app.request(`/api/groups/${group.id}/tasks`, {
        headers: { "X-Participant-Id": coordinatorId },
      });
      expect(listRes.status).toBe(200);
      expect(await listRes.json()).toEqual([]);

      // unarchive 恢复后可写:POST 任务 → 200
      await app.request(`/api/groups/${group.id}/unarchive`, {
        method: "POST",
        headers: { "X-Participant-Id": coordinatorId },
      });
      const afterUnarchive = await app.request(
        `/api/groups/${group.id}/tasks`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": coordinatorId,
          },
          body: JSON.stringify({
            messageId: "00000000-0000-7000-8000-0000000000cc",
            executorParticipantId: execId,
          }),
        },
      );
      expect(afterUnarchive.status).toBe(200);
    });

    it("GET /:id 返回群组详情含 status,不存在的群组 404", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const group = await createGroup(id, "详情查询");

      const res = await app.request(`/api/groups/${group.id}`, {
        headers: { "X-Participant-Id": id },
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
        { headers: { "X-Participant-Id": id } },
      );
      expect(missingRes.status).toBe(404);
      expect((await missingRes.json()).code).toBe("GROUP_NOT_FOUND");
    });

    it("软删除:DELETE /:id 后列表不再返回,active/archived 不受影响,重复删除 404", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const doomed = await createGroup(id, "将被删除");
      const active = await createGroup(id, "保留的进行中");
      const archived = await createGroup(id, "保留的已归档");
      await app.request(`/api/groups/${archived.id}/archive`, {
        method: "POST",
        headers: { "X-Participant-Id": id },
      });

      const delRes = await app.request(`/api/groups/${doomed.id}`, {
        method: "DELETE",
        headers: { "X-Participant-Id": id },
      });
      expect(delRes.status).toBe(200);
      expect(((await delRes.json()) as { status: string }).status).toBe(
        "deleted",
      );

      // Unfiltered list excludes the deleted group but keeps both survivors.
      const allRes = await app.request("/api/groups", {
        headers: { "X-Participant-Id": id },
      });
      expect(allRes.status).toBe(200);
      const all = ((await allRes.json()) as { items: Array<{ id: string }> })
        .items;
      expect(all.some((g) => g.id === doomed.id)).toBe(false);
      expect(all.some((g) => g.id === active.id)).toBe(true);
      expect(all.some((g) => g.id === archived.id)).toBe(true);

      // ?status=active / ?status=archived are unaffected by the deletion.
      const activeRes = await app.request("/api/groups?status=active", {
        headers: { "X-Participant-Id": id },
      });
      const activeList = (
        (await activeRes.json()) as { items: Array<{ id: string }> }
      ).items;
      expect(activeList.some((g) => g.id === doomed.id)).toBe(false);
      expect(activeList.some((g) => g.id === active.id)).toBe(true);

      const archivedRes = await app.request("/api/groups?status=archived", {
        headers: { "X-Participant-Id": id },
      });
      const archivedList = (
        (await archivedRes.json()) as { items: Array<{ id: string }> }
      ).items;
      expect(archivedList.some((g) => g.id === archived.id)).toBe(true);

      // Deleting an already-deleted group is a no-match -> 404.
      const againRes = await app.request(`/api/groups/${doomed.id}`, {
        method: "DELETE",
        headers: { "X-Participant-Id": id },
      });
      expect(againRes.status).toBe(404);
      expect((await againRes.json()).code).toBe("GROUP_NOT_FOUND");
    });

    it("软删除保留数据:历史消息仍可查,成员关系仍在", async () => {
      const { id: participantId } = await registerParticipant({
        name: "coord",
      });
      const group = await createGroup(participantId, "删除后仍有历史");

      const postRes = await app.request(`/api/groups/${group.id}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": participantId,
        },
        body: JSON.stringify({ body: "删除前的消息" }),
      });
      expect(postRes.status).toBe(200);

      const delRes = await app.request(`/api/groups/${group.id}`, {
        method: "DELETE",
        headers: { "X-Participant-Id": participantId },
      });
      expect(delRes.status).toBe(200);

      // History rows survive: the message list still serves them (GET stays
      // open even for a deleted group — rows are kept, not purged).
      const messagesRes = await app.request(
        `/api/groups/${group.id}/messages`,
        { headers: { "X-Participant-Id": participantId } },
      );
      expect(messagesRes.status).toBe(200);
      const messages = (await messagesRes.json()) as Array<{ body: string }>;
      expect(messages.map((m) => m.body)).toEqual(["删除前的消息"]);

      const membersRes = await app.request(`/api/groups/${group.id}/members`, {
        headers: { "X-Participant-Id": participantId },
      });
      expect(membersRes.status).toBe(200);
      const members = (await membersRes.json()) as Array<{
        participantId: string;
      }>;
      expect(members.some((m) => m.participantId === participantId)).toBe(true);
    });
  });

  describe("PATCH /api/groups/:id 绑定项目路径 (projectPath)", () => {
    it("迁移已应用:新建群 GET /:id 返回 projectPath 且初始为 null", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const group = await createGroup(id, "绑定前");

      const res = await app.request(`/api/groups/${group.id}`, {
        headers: { "X-Participant-Id": id },
      });
      expect(res.status).toBe(200);
      const detail = (await res.json()) as { projectPath: string | null };
      expect(detail.projectPath).toBeNull();
    });

    it("绑定存在的绝对目录成功,GET /:id 返回该 projectPath", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const group = await createGroup(id, "绑定成功");
      const dir = mkdtempSync(join(tmpdir(), "coagent-group-proj-"));

      const patchRes = await app.request(`/api/groups/${group.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
        },
        body: JSON.stringify({ projectPath: dir }),
      });
      expect(patchRes.status).toBe(200);
      expect(
        ((await patchRes.json()) as { projectPath: string }).projectPath,
      ).toBe(dir);

      const getRes = await app.request(`/api/groups/${group.id}`, {
        headers: { "X-Participant-Id": id },
      });
      expect(getRes.status).toBe(200);
      expect(
        ((await getRes.json()) as { projectPath: string }).projectPath,
      ).toBe(dir);

      rmSync(dir, { recursive: true, force: true });
    });

    it("PATCH title 重命名群组;projectPath 不受影响", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const group = await createGroup(id, "旧名字");

      const res = await app.request(`/api/groups/${group.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
        },
        body: JSON.stringify({ title: "新名字" }),
      });
      expect(res.status).toBe(200);
      const updated = (await res.json()) as {
        title: string;
        projectPath: string | null;
      };
      expect(updated.title).toBe("新名字");

      // GET 详情确认已落库。
      const getRes = await app.request(`/api/groups/${group.id}`, {
        headers: { "X-Participant-Id": id },
      });
      expect(getRes.status).toBe(200);
      expect(((await getRes.json()) as { title: string }).title).toBe("新名字");

      // 空 title 拒绝;仅 title 的 PATCH 不影响 projectPath。
      const emptyRes = await app.request(`/api/groups/${group.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
        },
        body: JSON.stringify({ title: "" }),
      });
      expect(emptyRes.status).toBe(400);
    });

    it("null 与空串均清空绑定", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const group = await createGroup(id, "清空绑定");
      const dir = mkdtempSync(join(tmpdir(), "coagent-group-proj-"));

      const bindRes = await app.request(`/api/groups/${group.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
        },
        body: JSON.stringify({ projectPath: dir }),
      });
      expect(bindRes.status).toBe(200);

      // null 清空
      const clearRes = await app.request(`/api/groups/${group.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
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
          "X-Participant-Id": id,
        },
        body: JSON.stringify({ projectPath: dir }),
      });
      expect(bindAgainRes.status).toBe(200);
      const emptyRes = await app.request(`/api/groups/${group.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": id,
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
      const { id } = await registerParticipant({
        name: "coord",
      });
      const group = await createGroup(id, "非法路径");
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
            "X-Participant-Id": id,
          },
          body: JSON.stringify({ projectPath }),
        });
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe("INVALID_REQUEST");
      }

      rmSync(dir, { recursive: true, force: true });
    });

    it("群组不存在返回 404 GROUP_NOT_FOUND", async () => {
      const { id } = await registerParticipant({
        name: "coord",
      });
      const dir = mkdtempSync(join(tmpdir(), "coagent-group-proj-"));

      const res = await app.request(
        "/api/groups/00000000-0000-0000-0000-00000000dead",
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": id,
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
