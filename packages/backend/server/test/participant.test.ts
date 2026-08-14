import {
  groupMember as groupMemberTable,
  groupMessage as groupMessageTable,
  participant as participantTable,
} from "@laizhixingxingdeli/database/schema";
import BizError from "@laizhixingxingdeli/error/biz";
import type { DataBase } from "@server/lib/database";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { describe, expect, it } from "vitest";
import { participantIdentity } from "../src/middleware/participant-identity";
import { createTestApp } from "./app";
import { testDb } from "./db";

/**
 * Participant registry (ticket 01): registration returns an id (no token —
 * token auth removed in the LAN full-trust model), the list never exposes
 * token hashes, and the identity middleware resolves `X-Participant-Id`
 * claims: an existing id is used as-is, a missing/unknown id falls back to
 * the default Local User (no 401/403).
 */
describe("participant 注册与身份 API", () => {
  const app = createTestApp();

  async function register(body: Record<string, unknown>) {
    return app.request("/api/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** Minimal app exercising participantIdentity: db injected, one protected route. */
  function createProtectedApp() {
    const protectedApp = new Hono<{
      Variables: { db: DataBase; participantId: string };
    }>();
    protectedApp.use(async (c, next) => {
      // PGlite and node-postgres drizzle instances have incompatible driver
      // HKT types; the middleware only uses the shared query API.
      c.set("db", testDb as unknown as DataBase);
      await next();
    });
    protectedApp.use(participantIdentity);
    // Mirror the real app's error handling so BizError maps to its status
    // code instead of Hono's default 500.
    protectedApp.onError((err, c) => {
      if (err instanceof BizError) {
        return c.json(
          { code: err.code, message: err.message },
          err.statusCode as ContentfulStatusCode,
        );
      }
      return c.json({ message: "Internal Server Error" }, 500);
    });
    protectedApp.get("/me", (c) =>
      c.json({ participantId: c.get("participantId") }),
    );
    return protectedApp;
  }

  it("POST /api/participants 注册成功:返回 id,不含 token,库中 token_hash 为占位值", async () => {
    const res = await register({
      name: "hermes-mac",
      device: "mac-mini",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      token?: string;
      tokenHash?: string;
    };
    expect(body.id).toBeTruthy();
    // 全信模型:不再生成 token。
    expect(body.token).toBeUndefined();
    expect(body.tokenHash).toBeUndefined();

    const [row] = await testDb.select().from(participantTable);
    expect(row.id).toBe(body.id);
    // token_hash 列保留(方案 B 再删),插入占位空串满足 NOT NULL。
    expect(row.tokenHash).toBe("");
    expect(row.device).toBe("mac-mini");
  });

  it("GET /api/participants 列表返回全部 participant 且不泄露 tokenHash/token", async () => {
    const created = await register({ name: "atomcode-cli" });
    const { id } = (await created.json()) as { id: string };

    const res = await app.request("/api/participants");
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(list)).toBe(true);
    const item = list.find((a) => a.id === id);
    expect(item).toBeTruthy();
    expect(item).not.toHaveProperty("tokenHash");
    expect(item).not.toHaveProperty("token");
    expect(JSON.stringify(list)).not.toContain("token_hash");
  });

  it("GET /api/agents 历史别名与 /api/participants 同 handler,同样可用", async () => {
    const created = await register({ name: "alias-check" });
    const { id } = (await created.json()) as { id: string };

    // 术语改名前的旧路径(agent 为 participant 的旧名):挂同一 handler,
    // 过渡期兼容旧客户端/旧执行器,不 404。
    const legacy = await app.request("/api/agents");
    expect(legacy.status).toBe(200);
    const legacyText = await legacy.text();
    const legacyList = JSON.parse(legacyText) as Array<{ id: string }>;
    expect(legacyList.some((a) => a.id === id)).toBe(true);

    const current = await app.request("/api/participants");
    expect(current.status).toBe(200);
    expect(await current.text()).toBe(legacyText);
  });

  it("注册带 type 被忽略(participant.type 已移除);不带 type 也能注册", async () => {
    // 外部旧客户端可能仍带 type:zod 默认 strip,接受但忽略,响应不含 type。
    const res = await register({ name: "Alice", type: "human" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("type");

    // 新客户端不带 type 也成功。
    const plain = await register({ name: "Bob" });
    expect(plain.status).toBe(200);
    const plainBody = (await plain.json()) as Record<string, unknown>;
    expect(plainBody).not.toHaveProperty("type");
  });

  it("身份中间件:X-Participant-Id 声称存在 id → 以该身份", async () => {
    const res = await register({ name: "openclaw" });
    const { id } = (await res.json()) as { id: string };

    const meRes = await createProtectedApp().request("/me", {
      headers: { "X-Participant-Id": id },
    });
    expect(meRes.status).toBe(200);
    expect(await meRes.json()).toEqual({ participantId: id });
  });

  it("身份中间件:声称不存在的 id → 回落本地用户(不报错);缺失 header → 本地用户", async () => {
    const protectedApp = createProtectedApp();

    // 全信模型:未知 id 不 401,回落 Local User。
    const unknownRes = await protectedApp.request("/me", {
      headers: {
        "X-Participant-Id": "00000000-0000-4000-8000-0000000000ff",
      },
    });
    expect(unknownRes.status).toBe(200);
    const unknownBody = (await unknownRes.json()) as { participantId: string };
    expect(unknownBody.participantId).toMatch(/^[0-9a-f-]{36}$/);

    // 格式不合法(非 uuid)也不能 500:查库前校验,回落 Local User。
    const malformedRes = await protectedApp.request("/me", {
      headers: { "X-Participant-Id": "not-a-uuid" },
    });
    expect(malformedRes.status).toBe(200);
    const malformedBody = (await malformedRes.json()) as {
      participantId: string;
    };
    expect(malformedBody.participantId).toMatch(/^[0-9a-f-]{36}$/);

    // LAN trust model: no header → the default Local User (human).
    const missingRes = await protectedApp.request("/me");
    expect(missingRes.status).toBe(200);
    const body = (await missingRes.json()) as { participantId: string };
    expect(body.participantId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("全信模型:声称任意存在 id → 以该身份发言(消息 senderId 正确)", async () => {
    const creator = await register({ name: "identity-creator" });
    const { id: creatorId } = (await creator.json()) as { id: string };
    const speaker = await register({ name: "identity-speaker" });
    const { id: speakerId } = (await speaker.json()) as { id: string };

    const groupRes = await app.request("/api/groups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": creatorId,
      },
      body: JSON.stringify({ title: "身份声明测试群" }),
    });
    expect(groupRes.status).toBe(200);
    const { id: groupId } = (await groupRes.json()) as { id: string };

    // 把 speaker 加进群,再以 speaker 身份发消息。
    const memberRes = await app.request(`/api/groups/${groupId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": creatorId,
      },
      body: JSON.stringify({ participantId: speakerId, roles: ["executor"] }),
    });
    expect(memberRes.status).toBe(200);

    const msgRes = await app.request(`/api/groups/${groupId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": speakerId,
      },
      body: JSON.stringify({ body: "以声称身份发言" }),
    });
    expect(msgRes.status).toBe(200);
    const msg = (await msgRes.json()) as { senderId: string };
    expect(msg.senderId).toBe(speakerId);
  });

  it("校验:缺 name 返回 400;仅 name 即可注册(不再要求 type)", async () => {
    const noName = await register({});
    expect(noName.status).toBe(400);

    const nameOnly = await register({ name: "x" });
    expect(nameOnly.status).toBe(200);
  });

  it("DELETE /:id 删除 participant,并清理其群成员关系与消息(ticket 清理旧身份)", async () => {
    // 建群者与被删者分离:旧 bridge 身份不建群,只作为成员/发言者存在。
    const owner = await register({ name: "owner" });
    const { id: ownerId } = (await owner.json()) as { id: string };
    const created = await register({
      name: "executor-bridge",
    });
    const { id } = (await created.json()) as { id: string };

    // 建群(owner 自动成为 coordinator 成员)并让旧身份发言,制造外键依赖。
    const groupRes = await app.request("/api/groups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": ownerId,
      },
      body: JSON.stringify({ title: "清理测试群" }),
    });
    expect(groupRes.status).toBe(200);
    const { id: groupId } = (await groupRes.json()) as { id: string };
    await app.request(`/api/groups/${groupId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": ownerId,
      },
      body: JSON.stringify({ participantId: id, roles: ["executor"] }),
    });
    // 用被删者自己的身份发言:senderId 必须是该 participant,才能覆盖
    // DELETE 中「清理其消息」的分支。
    const msgRes = await app.request(`/api/groups/${groupId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": id,
      },
      body: JSON.stringify({ body: "旧身份的一条消息" }),
    });
    expect(msgRes.status).toBe(200);
    const { id: messageId } = (await msgRes.json()) as { id: string };

    const delRes = await app.request(`/api/participants/${id}`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toMatchObject({
      success: true,
      id,
      name: "executor-bridge",
    });

    // participant 行已不存在;列表也不再包含它。
    const listRes = await app.request("/api/participants");
    const list = (await listRes.json()) as Array<{ id: string }>;
    expect(list.some((a) => a.id === id)).toBe(false);

    // 其成员关系与消息也已随删除清理(直接查库验证外键清理)。
    const [memberRow] = await testDb
      .select()
      .from(groupMemberTable)
      .where(eq(groupMemberTable.participantId, id));
    expect(memberRow).toBeUndefined();
    const [msgRow] = await testDb
      .select()
      .from(groupMessageTable)
      .where(eq(groupMessageTable.id, messageId));
    expect(msgRow).toBeUndefined();
  });

  it("DELETE /:id 建过群的 participant 返回 409 且不删除(ticket 清理旧身份)", async () => {
    const owner = await register({ name: "owner2" });
    const { id: participantId } = (await owner.json()) as { id: string };
    const groupRes = await app.request("/api/groups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": participantId,
      },
      body: JSON.stringify({ title: "待保留群" }),
    });
    expect(groupRes.status).toBe(200);

    const res = await app.request(`/api/participants/${participantId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("CONFLICT");

    // 该 participant 与群都仍然存在。
    const listRes = await app.request("/api/participants");
    const list = (await listRes.json()) as Array<{ id: string }>;
    expect(list.some((a) => a.id === participantId)).toBe(true);
  });

  it("DELETE /:id 不存在的 participant 返回 404", async () => {
    const res = await app.request(
      "/api/participants/00000000-0000-0000-0000-000000000000",
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("PARTICIPANT_NOT_FOUND");
  });

  it("DELETE /:id 无鉴权可访问(与注册一致,局域网信任模型)", async () => {
    const created = await register({ name: "stale-bridge" });
    const { id } = (await created.json()) as { id: string };

    // 不携带任何身份 header,应能直接删除。
    const res = await app.request(`/api/participants/${id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
  });
});
