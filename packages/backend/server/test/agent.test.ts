import {
  agent as agentTable,
  groupMember as groupMemberTable,
  groupMessage as groupMessageTable,
} from "@laizhixingxingdeli/database/schema";
import BizError from "@laizhixingxingdeli/error/biz";
import type { DataBase } from "@server/lib/database";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { describe, expect, it } from "vitest";
import { hashAgentToken } from "../src/lib/agent-token";
import { agentAuth } from "../src/middleware/agent-auth";
import { createTestApp } from "./app";
import { testDb } from "./db";

/**
 * Agent registry (ticket 01): registration returns a one-time plaintext
 * token (only the SHA-256 hash is stored), the list never exposes token
 * hashes, human type is supported, and the bearer-token middleware resolves
 * agent identity for valid tokens and rejects invalid ones.
 */
describe("agent 注册与身份 API", () => {
  const app = createTestApp();

  async function register(body: Record<string, unknown>) {
    return app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** Minimal app exercising agentAuth: db injected, one protected route. */
  function createProtectedApp() {
    const protectedApp = new Hono<{
      Variables: { db: DataBase; agentId: string };
    }>();
    protectedApp.use(async (c, next) => {
      // PGlite and node-postgres drizzle instances have incompatible driver
      // HKT types; the middleware only uses the shared query API.
      c.set("db", testDb as unknown as DataBase);
      await next();
    });
    protectedApp.use(agentAuth);
    // Mirror the real app's error handling so BizError (401 from agentAuth)
    // maps to its status code instead of Hono's default 500.
    protectedApp.onError((err, c) => {
      if (err instanceof BizError) {
        return c.json(
          { code: err.code, message: err.message },
          err.statusCode as ContentfulStatusCode,
        );
      }
      return c.json({ message: "Internal Server Error" }, 500);
    });
    protectedApp.get("/me", (c) => c.json({ agentId: c.get("agentId") }));
    return protectedApp;
  }

  it("POST /api/agents 注册成功,返回 token(仅此一次)且库中只存哈希", async () => {
    const res = await register({
      name: "hermes-mac",
      type: "hermes",
      device: "mac-mini",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      token: string;
      tokenHash?: string;
    };
    expect(body.id).toBeTruthy();
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    // The plaintext hash must never be echoed back.
    expect(body.tokenHash).toBeUndefined();

    const [row] = await testDb.select().from(agentTable);
    expect(row.id).toBe(body.id);
    expect(row.tokenHash).toBe(hashAgentToken(body.token));
    expect(row.tokenHash).not.toBe(body.token);
    expect(row.device).toBe("mac-mini");
  });

  it("GET /api/agents 列表返回全部 agent 且不泄露 tokenHash/token", async () => {
    const created = await register({ name: "atomcode-cli", type: "atomcode" });
    const { id, token } = (await created.json()) as {
      id: string;
      token: string;
    };

    const res = await app.request("/api/agents");
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(list)).toBe(true);
    const item = list.find((a) => a.id === id);
    expect(item).toBeTruthy();
    expect(item).not.toHaveProperty("tokenHash");
    expect(item).not.toHaveProperty("token");
    expect(JSON.stringify(list)).not.toContain(token);
  });

  it("支持注册 human 类型", async () => {
    const res = await register({ name: "Alice", type: "human" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { type: string };
    expect(body.type).toBe("human");

    const listRes = await app.request("/api/agents");
    const list = (await listRes.json()) as Array<{ type: string }>;
    expect(list.some((a) => a.type === "human")).toBe(true);
  });

  it("中间件:合法 Bearer token 识别出 agent 身份", async () => {
    const res = await register({ name: "openclaw", type: "openclaw" });
    const { id, token } = (await res.json()) as { id: string; token: string };

    const meRes = await createProtectedApp().request("/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(meRes.status).toBe(200);
    expect(await meRes.json()).toEqual({ agentId: id });
  });

  it("中间件:非法/缺失 token 拒绝(401)", async () => {
    const protectedApp = createProtectedApp();

    const badRes = await protectedApp.request("/me", {
      headers: { Authorization: "Bearer deadbeef" },
    });
    expect(badRes.status).toBe(401);

    const missingRes = await protectedApp.request("/me");
    expect(missingRes.status).toBe(401);
  });

  it("校验:缺 name/type 或非法 webhookUrl 返回 400", async () => {
    const noName = await register({ type: "hermes" });
    expect(noName.status).toBe(400);

    const noType = await register({ name: "x" });
    expect(noType.status).toBe(400);

    const badUrl = await register({
      name: "x",
      type: "hermes",
      webhookUrl: "not-a-url",
    });
    expect(badUrl.status).toBe(400);
  });

  it("POST /:id/reset-token 重置成功:返回新明文、库中存新哈希、旧 token 失效(ticket 29)", async () => {
    const created = await register({ name: "hermes-mac", type: "hermes" });
    const { id, token: oldToken } = (await created.json()) as {
      id: string;
      token: string;
    };

    const res = await app.request(`/api/agents/${id}/reset-token`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      name: string;
      token: string;
      tokenHash?: string;
    };
    expect(body.id).toBe(id);
    expect(body.name).toBe("hermes-mac");
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    // 明文 hash 永不回显;库中只存新 token 的 SHA-256。
    expect(body.tokenHash).toBeUndefined();
    const [row] = await testDb
      .select()
      .from(agentTable)
      .where(eq(agentTable.id, id));
    expect(row.tokenHash).toBe(hashAgentToken(body.token));
    expect(row.tokenHash).not.toBe(hashAgentToken(oldToken));

    // 旧 token 立即失效(401),新 token 可识别身份。
    const protectedApp = createProtectedApp();
    const oldRes = await protectedApp.request("/me", {
      headers: { Authorization: `Bearer ${oldToken}` },
    });
    expect(oldRes.status).toBe(401);
    const newRes = await protectedApp.request("/me", {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(newRes.status).toBe(200);
    expect(await newRes.json()).toEqual({ agentId: id });
  });

  it("POST /:id/reset-token 不存在的 agent 返回 404", async () => {
    const res = await app.request(
      "/api/agents/00000000-0000-0000-0000-000000000000/reset-token",
      { method: "POST" },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("AGENT_NOT_FOUND");
  });

  it("POST /:id/reset-token 无鉴权可访问(与注册一致,局域网信任模型)", async () => {
    const created = await register({ name: "openclaw", type: "openclaw" });
    const { id } = (await created.json()) as { id: string };

    // 不携带任何 Authorization header,应能直接取回 token。
    const res = await app.request(`/api/agents/${id}/reset-token`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("DELETE /:id 删除 agent,并清理其群成员关系与消息(ticket 清理旧身份)", async () => {
    // 建群者与被删者分离:旧 bridge 身份不建群,只作为成员/发言者存在。
    const owner = await register({ name: "owner", type: "hermes" });
    const { token } = (await owner.json()) as { token: string };
    const created = await register({
      name: "executor-bridge",
      type: "atomcode",
    });
    const { id, token: agentToken } = (await created.json()) as {
      id: string;
      token: string;
    };

    // 建群(owner 自动成为 coordinator 成员)并让旧身份发言,制造外键依赖。
    const groupRes = await app.request("/api/groups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ title: "清理测试群" }),
    });
    expect(groupRes.status).toBe(200);
    const { id: groupId } = (await groupRes.json()) as { id: string };
    await app.request(`/api/groups/${groupId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ agentId: id, roles: ["executor"] }),
    });
    // 用被删者自己的 token 发言:senderId 必须是该 agent,才能覆盖
    // DELETE 中「清理其消息」的分支。
    const msgRes = await app.request(`/api/groups/${groupId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentToken}`,
      },
      body: JSON.stringify({ body: "旧身份的一条消息" }),
    });
    expect(msgRes.status).toBe(200);
    const { id: messageId } = (await msgRes.json()) as { id: string };

    const delRes = await app.request(`/api/agents/${id}`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toMatchObject({
      success: true,
      id,
      name: "executor-bridge",
    });

    // agent 行已不存在;列表也不再包含它。
    const listRes = await app.request("/api/agents");
    const list = (await listRes.json()) as Array<{ id: string }>;
    expect(list.some((a) => a.id === id)).toBe(false);

    // 其成员关系与消息也已随删除清理(直接查库验证外键清理)。
    const [memberRow] = await testDb
      .select()
      .from(groupMemberTable)
      .where(eq(groupMemberTable.agentId, id));
    expect(memberRow).toBeUndefined();
    const [msgRow] = await testDb
      .select()
      .from(groupMessageTable)
      .where(eq(groupMessageTable.id, messageId));
    expect(msgRow).toBeUndefined();
  });

  it("DELETE /:id 建过群的 agent 返回 409 且不删除(ticket 清理旧身份)", async () => {
    const owner = await register({ name: "owner2", type: "hermes" });
    const { token, id: agentId } = (await owner.json()) as {
      token: string;
      id: string;
    };
    const groupRes = await app.request("/api/groups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ title: "待保留群" }),
    });
    expect(groupRes.status).toBe(200);

    const res = await app.request(`/api/agents/${agentId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("CONFLICT");

    // 该 agent 与群都仍然存在。
    const listRes = await app.request("/api/agents");
    const list = (await listRes.json()) as Array<{ id: string }>;
    expect(list.some((a) => a.id === agentId)).toBe(true);
  });

  it("DELETE /:id 不存在的 agent 返回 404", async () => {
    const res = await app.request(
      "/api/agents/00000000-0000-0000-0000-000000000000",
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("AGENT_NOT_FOUND");
  });

  it("DELETE /:id 无鉴权可访问(与注册一致,局域网信任模型)", async () => {
    const created = await register({ name: "stale-bridge", type: "atomcode" });
    const { id } = (await created.json()) as { id: string };

    // 不携带任何 Authorization header,应能直接删除。
    const res = await app.request(`/api/agents/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
  });
});
