import type { Handler } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
import { createOnError, type OnErrorLogger } from "../src/lib/on-error";
import { createTestApp } from "./app";

/**
 * 请求体解析失败 → 400(specs/json-body-parse-failure-returns-500.md,
 * specHash e21c6f71):`Content-Type: application/json` + 空/非法 body 在全局
 * onError 返回 400(此前被压成 500);**业务层 SyntaxError 仍是 500**(R2
 * 核心防线);该类失败以 warn 留痕、不再以 error 报(R3)。
 *
 * 判据(R2,窄):`err instanceof HTTPException` —— body 解析失败在
 * Hono/`@hono/zod-validator` 的 validator 内已被 catch 并抛成
 * HTTPException(400),错误在进入 onError 前已归因到「本次请求 body 解析」;
 * handler 内 `throw new SyntaxError(...)` 仍是裸 SyntaxError → 落「其它」分支
 * → 500。不做 `instanceof SyntaxError` 一刀切。实现见 lib/on-error.ts。
 *
 * 验收口径:§1.1 四格(400/400/409/400)、§1.2 五路由同手法 400、R2 防线、
 * R3 日志级别。状态码 + 响应体 message 即最终产物,不落库。
 */

const app = createTestApp();

// 合法的 uuid(参数校验只查形状),指向一个不存在的事件/群。
const FAKE_EVENT_ID = "00000000-0000-4000-8000-000000000001";
const FAKE_GROUP_ID = "00000000-0000-4000-8000-000000000002";

async function registerParticipant(): Promise<string> {
  const res = await app.request("/api/participants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `bodyparse-${crypto.randomUUID()}` }),
  });
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  return id;
}

describe("§1.1 claim 路由四种输入:400 / 400 / 409 / 400", () => {
  const claimPath = (pid: string) =>
    `/api/participants/${pid}/task-completion-events/${FAKE_EVENT_ID}/claim`;

  it("完全无 body(无 Content-Type)→ 400(既有行为不变)", async () => {
    const pid = await registerParticipant();
    const res = await app.request(claimPath(pid), {
      method: "POST",
      headers: { "X-Participant-Id": pid },
    });
    expect(res.status).toBe(400);
  });

  it("Content-Type: application/json + 空 body → 400(本票核心:曾为 500)", async () => {
    const pid = await registerParticipant();
    const res = await app.request(claimPath(pid), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Participant-Id": pid },
      body: "",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    // validator 抛出的 HTTPException(400) 的 message 透传(形状稳定,勿改)。
    expect(body.message).toBe("Malformed JSON in request body");
  });

  it("合法 body、事件不存在 → 409(既有行为不变)", async () => {
    const pid = await registerParticipant();
    const res = await app.request(claimPath(pid), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Participant-Id": pid },
      body: JSON.stringify({ consumerId: "bodyparse", leaseMs: 60_000 }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("CONFLICT");
  });

  it("body 字段非法(leaseMs 低于 min)→ 400(既有行为不变)", async () => {
    const pid = await registerParticipant();
    const res = await app.request(claimPath(pid), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Participant-Id": pid },
      body: JSON.stringify({ consumerId: "bodyparse", leaseMs: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it("非法 JSON body(非空)→ 400(与空 body 同一 HTTPException 路径)", async () => {
    const pid = await registerParticipant();
    const res = await app.request(claimPath(pid), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Participant-Id": pid },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("§1.2 五个路由同手法(json header + 空 body)全部 400(全局生效)", () => {
  const targets: Array<{ name: string; path: (pid: string) => string }> = [
    {
      name: "task-completion-events/:eventId/ack",
      path: (pid) =>
        `/api/participants/${pid}/task-completion-events/${FAKE_EVENT_ID}/ack`,
    },
    {
      name: "task-completion-events/:eventId/fail",
      path: (pid) =>
        `/api/participants/${pid}/task-completion-events/${FAKE_EVENT_ID}/fail`,
    },
    {
      name: "groups/:id/messages",
      path: () => `/api/groups/${FAKE_GROUP_ID}/messages`,
    },
    {
      name: "groups/:id/tasks",
      path: () => `/api/groups/${FAKE_GROUP_ID}/tasks`,
    },
    {
      name: "participants",
      path: () => `/api/participants`,
    },
  ];

  for (const target of targets) {
    it(`${target.name} → 400`, async () => {
      const pid = await registerParticipant();
      const res = await app.request(target.path(pid), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": pid,
        },
        body: "",
      });
      expect(res.status).toBe(400);
    });
  }
});

describe("R2 防线:业务层 SyntaxError 仍是 500(核心防线,不可缺)", () => {
  // 仅测试用的路由:handler 内抛裸 SyntaxError —— 它不是 HTTPException,
  // 必须继续走「其它 → 500」,不得被 body 解析判据误伤。
  app.post("/__test__/syntax-boom", () => {
    throw new SyntaxError("business boom");
  });

  it("handler 内 throw SyntaxError → 500(不是一刀切 400)", async () => {
    const res = await app.request("/api/__test__/syntax-boom", {
      method: "POST",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe("Internal Server Error");
  });
});

describe("R3 日志契约:同一 createOnError 实现 + spy logger", () => {
  function makeApp(boom: Handler, logger: OnErrorLogger) {
    const app = new Hono();
    app.onError(createOnError(logger));
    app.post("/boom", boom);
    return app;
  }

  it("body 解析失败(HTTPException 400)→ warn 留痕,不以 error 报", async () => {
    const warn = vi.fn();
    const error = vi.fn();
    const app = makeApp(
      () => {
        throw new HTTPException(400, {
          message: "Malformed JSON in request body",
        });
      },
      { warn, error },
    );
    const res = await app.request("/boom", { method: "POST" });
    expect(res.status).toBe(400);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "request failed (client error)",
      expect.objectContaining({
        status: 400,
        message: "Malformed JSON in request body",
        method: "POST",
        path: "/boom",
      }),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("业务层 SyntaxError → error 级(日志级别不变)", async () => {
    const warn = vi.fn();
    const error = vi.fn();
    const app = makeApp(
      () => {
        throw new SyntaxError("business boom");
      },
      { warn, error },
    );
    const res = await app.request("/boom", { method: "POST" });
    expect(res.status).toBe(500);
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("HTTPException ≥ 500 → 透传 status 且 error 级(不吞服务端故障)", async () => {
    const warn = vi.fn();
    const error = vi.fn();
    const app = makeApp(
      () => {
        throw new HTTPException(503, { message: "downstream unavailable" });
      },
      { warn, error },
    );
    const res = await app.request("/boom", { method: "POST" });
    expect(res.status).toBe(503);
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
