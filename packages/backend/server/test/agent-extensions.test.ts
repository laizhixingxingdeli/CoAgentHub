import { agent as agentTable } from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./app";
import { testDb } from "./db";

/**
 * T17 agent 自更新与扩展字段 (ticket 17): PATCH /api/agents/:id 自更新、
 * PUT /api/agents/:id/heartbeat 心跳在线、group_message.content_type、
 * agent.capabilities、file_ref.expiresAt 服务端必填(缺省 now + 7d)。
 */
describe("T17 agent 自更新与扩展字段", () => {
  const app = createTestApp();

  async function registerAgent(body: Record<string, unknown>) {
    const res = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      id: string;
      token: string;
      [key: string]: unknown;
    };
    return { id: json.id, token: json.token, body: json };
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
    return app.request(`/api/groups/${groupId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ agentId, roles }),
    });
  }

  async function sendMessage(
    token: string,
    groupId: string,
    payload: Record<string, unknown>,
  ) {
    return app.request(`/api/groups/${groupId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
  }

  async function fetchMessages(token: string, groupId: string) {
    const res = await app.request(`/api/groups/${groupId}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Array<Record<string, unknown>>;
  }

  describe("PATCH /api/agents/:id 自更新", () => {
    it("本人部分更新成功,未更新字段保留,响应不含 token_hash", async () => {
      const { id, token } = await registerAgent({
        name: "hermes-mac",
        type: "hermes",
        device: "mac-mini",
      });

      const res = await app.request(`/api/agents/${id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: "hermes-mac-2", device: "new-laptop" }),
      });
      expect(res.status).toBe(200);
      const updated = (await res.json()) as Record<string, unknown>;
      expect(updated.name).toBe("hermes-mac-2");
      expect(updated.device).toBe("new-laptop");
      expect(updated.type).toBe("hermes"); // 未更新的字段保留
      expect(updated).not.toHaveProperty("tokenHash");
      expect(updated).not.toHaveProperty("token");
      expect(updated.capabilities).toEqual([]);

      // device 与 webhookUrl 一样可用 null 清空。
      const clearDevice = await app.request(`/api/agents/${id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ device: null }),
      });
      expect(clearDevice.status).toBe(200);
      expect(
        ((await clearDevice.json()) as { device: unknown }).device,
      ).toBeNull();
    });

    it("他人 token 更新返回 403 且目标 agent 不变", async () => {
      const a = await registerAgent({ name: "agent-a", type: "hermes" });
      const b = await registerAgent({ name: "agent-b", type: "atomcode" });

      const res = await app.request(`/api/agents/${a.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${b.token}`,
        },
        body: JSON.stringify({ name: "hacked" }),
      });
      expect(res.status).toBe(403);

      const [row] = await testDb
        .select({ name: agentTable.name })
        .from(agentTable)
        .where(eq(agentTable.id, a.id));
      expect(row.name).toBe("agent-a");
    });

    it("无 token 回落本地用户:改他人资料返回 403", async () => {
      const { id } = await registerAgent({ name: "agent-c", type: "hermes" });
      const res = await app.request(`/api/agents/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("FORBIDDEN");
    });

    it("webhookUrl 置空(null)后响应与库中均为 null", async () => {
      const { id, token } = await registerAgent({
        name: "webhook-agent",
        type: "hermes",
        webhookUrl: "https://example.com/hook",
      });

      const res = await app.request(`/api/agents/${id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ webhookUrl: null }),
      });
      expect(res.status).toBe(200);
      const updated = (await res.json()) as Record<string, unknown>;
      expect(updated.webhookUrl).toBeNull();

      const [row] = await testDb
        .select({ webhookUrl: agentTable.webhookUrl })
        .from(agentTable)
        .where(eq(agentTable.id, id));
      expect(row.webhookUrl).toBeNull();
    });

    it("空 body(无任何更新字段)返回 400", async () => {
      const { id, token } = await registerAgent({
        name: "noop",
        type: "hermes",
      });
      const res = await app.request(`/api/agents/${id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("PUT /api/agents/:id/heartbeat 心跳在线", () => {
    it("本人心跳写 last_seen 并返回 lastSeen(时间戳随心跳前进)", async () => {
      const { id, token } = await registerAgent({
        name: "beat",
        type: "hermes",
      });

      const first = await app.request(`/api/agents/${id}/heartbeat`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as { lastSeen: string };
      expect(typeof firstBody.lastSeen).toBe("string");

      const [row] = await testDb
        .select({ lastSeen: agentTable.lastSeen })
        .from(agentTable)
        .where(eq(agentTable.id, id));
      expect(row.lastSeen).toBeInstanceOf(Date);

      // 第二次心跳把 last_seen 往前推(>= 第一次,严格大于在毫秒级不可靠)。
      const second = await app.request(`/api/agents/${id}/heartbeat`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
      });
      const secondBody = (await second.json()) as { lastSeen: string };
      expect(new Date(secondBody.lastSeen).getTime()).toBeGreaterThanOrEqual(
        new Date(firstBody.lastSeen).getTime(),
      );
    });

    it("他人心跳 403、无 token 401", async () => {
      const a = await registerAgent({ name: "beat-a", type: "hermes" });
      const b = await registerAgent({ name: "beat-b", type: "hermes" });

      const forbidden = await app.request(`/api/agents/${a.id}/heartbeat`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${b.token}` },
      });
      expect(forbidden.status).toBe(403);

      const unauthorized = await app.request(`/api/agents/${a.id}/heartbeat`, {
        method: "PUT",
      });
      // LAN trust model: no token → Local User, not the token holder → 403.
      expect(unauthorized.status).toBe(403);
    });
  });

  describe("group_message.content_type", () => {
    async function setup() {
      const coordinator = await registerAgent({
        name: "hermes-mac",
        type: "hermes",
      });
      const group = await createGroup(coordinator.token, "内容类型任务");
      return { coordinator, group };
    }

    it("未传时默认 text/plain,自定义值原样存储,GET round-trip", async () => {
      const { coordinator, group } = await setup();

      const defaultRes = await sendMessage(coordinator.token, group.id, {
        body: "默认内容类型",
      });
      expect(defaultRes.status).toBe(200);
      const defaultMsg = (await defaultRes.json()) as Record<string, unknown>;
      expect(defaultMsg.contentType).toBe("text/plain");

      const customRes = await sendMessage(coordinator.token, group.id, {
        body: '{"k":1}',
        contentType: "application/json",
      });
      expect(customRes.status).toBe(200);
      const customMsg = (await customRes.json()) as Record<string, unknown>;
      expect(customMsg.contentType).toBe("application/json");

      const list = await fetchMessages(coordinator.token, group.id);
      expect(list.find((m) => m.id === defaultMsg.id)?.contentType).toBe(
        "text/plain",
      );
      expect(list.find((m) => m.id === customMsg.id)?.contentType).toBe(
        "application/json",
      );
    });
  });

  describe("agent.capabilities", () => {
    it("注册时声明 capabilities,注册响应与 GET 列表携带,缺省为空数组", async () => {
      const declared = await registerAgent({
        name: "reviewer-bot",
        type: "atomcode",
        capabilities: ["text-generation", "code-review"],
      });
      expect(declared.body.capabilities).toEqual([
        "text-generation",
        "code-review",
      ]);

      const plain = await registerAgent({
        name: "plain-agent",
        type: "hermes",
      });
      expect(plain.body.capabilities).toEqual([]);

      const listRes = await app.request("/api/agents");
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as Array<Record<string, unknown>>;
      expect(list.find((a) => a.id === declared.id)?.capabilities).toEqual([
        "text-generation",
        "code-review",
      ]);
      expect(list.find((a) => a.id === plain.id)?.capabilities).toEqual([]);
    });

    it("PATCH 可更新 capabilities,响应与 GET 列表携带新值", async () => {
      const { id, token } = await registerAgent({
        name: "caps-patch",
        type: "atomcode",
        capabilities: ["old-cap"],
      });

      const res = await app.request(`/api/agents/${id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          capabilities: ["text-generation", "code-review"],
        }),
      });
      expect(res.status).toBe(200);
      const updated = (await res.json()) as { capabilities: string[] };
      expect(updated.capabilities).toEqual(["text-generation", "code-review"]);

      const list = (await (
        await app.request("/api/agents")
      ).json()) as Array<Record<string, unknown>>;
      expect(list.find((a) => a.id === id)?.capabilities).toEqual([
        "text-generation",
        "code-review",
      ]);
    });

    it("仅 PATCH capabilities 也算有效更新(不触发 at least one field 400)", async () => {
      const { id, token } = await registerAgent({
        name: "caps-only",
        type: "atomcode",
      });
      const res = await app.request(`/api/agents/${id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ capabilities: ["code-review"] }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { capabilities: string[] }).capabilities)
        .toEqual(["code-review"]);
    });

    it("加成员时轻量能力提示:已知能力与角色不匹配时给建议,绝不拒绝", async () => {
      const coordinator = await registerAgent({
        name: "hermes-mac",
        type: "hermes",
      });
      const group = await createGroup(coordinator.token, "能力匹配任务");
      const executor = await registerAgent({
        name: "executor-bot",
        type: "atomcode",
        capabilities: ["text-generation"],
      });

      // 分配 observer —— 与 text-generation 建议角色(executor/specialist)
      // 无交集 → 响应带「建议角色」提示,但仍 200。
      const res = await addMember(coordinator.token, group.id, executor.id, [
        "observer",
      ]);
      expect(res.status).toBe(200);
      const member = (await res.json()) as { capabilityHint: string | null };
      expect(member.capabilityHint).toContain("建议角色");
      expect(member.capabilityHint).toContain("executor");

      // 分配 executor —— 与建议角色有交集 → 无匹配提示(null)。
      const matchRes = await addMember(
        coordinator.token,
        group.id,
        executor.id,
        ["executor"],
      );
      expect(matchRes.status).toBe(200);
      const match = (await matchRes.json()) as {
        capabilityHint: string | null;
      };
      expect(match.capabilityHint).toBeNull();
    });

    it("加成员时未知能力标签给提示,未声明能力时提示为 null", async () => {
      const coordinator = await registerAgent({
        name: "hermes-mac",
        type: "hermes",
      });
      const group = await createGroup(coordinator.token, "未知能力任务");
      const weird = await registerAgent({
        name: "weird-bot",
        type: "custom",
        capabilities: ["quantum-alchemy"],
      });
      const quiet = await registerAgent({ name: "quiet-bot", type: "custom" });

      const weirdRes = await addMember(coordinator.token, group.id, weird.id, [
        "executor",
      ]);
      expect(weirdRes.status).toBe(200);
      const weirdMember = (await weirdRes.json()) as {
        capabilityHint: string | null;
      };
      expect(weirdMember.capabilityHint).toContain("未知能力标签");
      expect(weirdMember.capabilityHint).toContain("quantum-alchemy");

      const quietRes = await addMember(coordinator.token, group.id, quiet.id, [
        "observer",
      ]);
      expect(quietRes.status).toBe(200);
      const quietMember = (await quietRes.json()) as {
        capabilityHint: string | null;
      };
      expect(quietMember.capabilityHint).toBeNull();
    });
  });

  describe("file_ref.expiresAt 服务端必填", () => {
    const fileRefBase = {
      name: "model.gguf",
      size: 123456,
      sha256: "a".repeat(64),
      fetchUrl: "http://192.168.1.5:9198/model.gguf",
    };

    it("客户端未传 expiresAt → 服务端默认 now + 7 天", async () => {
      const coordinator = await registerAgent({
        name: "hermes-mac",
        type: "hermes",
      });
      const group = await createGroup(coordinator.token, "文件有效期任务");

      const res = await sendMessage(coordinator.token, group.id, {
        body: "文件就绪",
        fileRef: fileRefBase,
      });
      expect(res.status).toBe(200);
      const msg = (await res.json()) as {
        fileRef: { expiresAt: string } | null;
      };
      expect(msg.fileRef).not.toBeNull();
      expect(msg.fileRef!.expiresAt).toBeTruthy();

      const expires = new Date(msg.fileRef!.expiresAt).getTime();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      // 允许少量时钟/执行偏差(±1 分钟)。
      expect(expires - Date.now()).toBeGreaterThan(sevenDaysMs - 60_000);
      expect(expires - Date.now()).toBeLessThan(sevenDaysMs + 60_000);

      // GET round-trip 仍带同一 expiresAt。
      const [listed] = await fetchMessages(coordinator.token, group.id);
      expect((listed.fileRef as { expiresAt: string } | null)?.expiresAt).toBe(
        msg.fileRef!.expiresAt,
      );
    });

    it("客户端显式传 expiresAt → 原样保留", async () => {
      const coordinator = await registerAgent({
        name: "hermes-mac",
        type: "hermes",
      });
      const group = await createGroup(coordinator.token, "显式有效期任务");
      const explicit = new Date(Date.now() + 3600_000).toISOString();

      const res = await sendMessage(coordinator.token, group.id, {
        body: "文件就绪(显式)",
        fileRef: { ...fileRefBase, expiresAt: explicit },
      });
      expect(res.status).toBe(200);
      const msg = (await res.json()) as {
        fileRef: { expiresAt: string } | null;
      };
      expect(msg.fileRef!.expiresAt).toBe(explicit);
    });
  });
});
