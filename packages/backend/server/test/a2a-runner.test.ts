import { runA2AExecutor } from "@server/lib/a2a-runner";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A2A 上下文延续(票:A2A 上下文延续)——runA2AExecutor 的 contextId 行为:
 *  - 入参带 contextId → 请求体 params.contextId 原样携带(mock gateway 断言);
 *  - 响应 result 含 contextId → 原样返回给调用方;
 *  - 响应无 contextId → contextId 缺省(undefined);
 *  - 非完成状态(失败)但 result 含 contextId → 失败 code + contextId 仍返回
 *    (executor-task 在 failed 路径同样落库,供下一任务延续)。
 *
 * 纯 fetch 单元测试,不碰 DB:stub 全局 fetch,验证请求/响应契约。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 构造一个 gateway 响应(带可选 contextId / 状态)。 */
function okResponse(opts: { contextId?: string; state?: string }) {
  const result: Record<string, unknown> = {
    message: {
      role: "participant",
      parts: [{ kind: "text", text: "ACAT-WIN-OK" }],
    },
    state: { state: opts.state ?? "completed" },
  };
  if (opts.contextId) result.contextId = opts.contextId;
  return {
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: "1.0", id: "1", result }),
    text: async () => "",
  };
}

describe("runA2AExecutor contextId", () => {
  it("入参带 contextId → 请求体 params.contextId 携带(仅存在时)", async () => {
    const bodies: Array<{ params: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (_input: string, init: RequestInit) => {
      bodies.push(
        JSON.parse(String(init.body)) as { params: Record<string, unknown> },
      );
      return okResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runA2AExecutor({
      url: "http://gw/",
      token: "t",
      prompt: "hello",
      contextId: "ctx-123",
    });

    expect(bodies[0]?.params.contextId).toBe("ctx-123");
    expect(bodies[0]?.params.message).toMatchObject({
      role: "user",
      parts: [{ kind: "text", text: "hello" }],
    });
    expect(result).toMatchObject({ code: 0, stdout: "ACAT-WIN-OK" });
  });

  it("入参不带 contextId → 请求体 params 无 contextId 字段", async () => {
    const bodies: Array<{ params: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (_input: string, init: RequestInit) => {
      bodies.push(
        JSON.parse(String(init.body)) as { params: Record<string, unknown> },
      );
      return okResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    await runA2AExecutor({ url: "http://gw/", token: "t", prompt: "hello" });

    expect(bodies[0]?.params.contextId).toBeUndefined();
  });

  it("响应 result 含 contextId → 返回给调用方", async () => {
    const fetchMock = vi.fn(async () => okResponse({ contextId: "ctx-456" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runA2AExecutor({
      url: "http://gw/",
      token: "t",
      prompt: "hello",
    });

    expect(result.contextId).toBe("ctx-456");
    expect(result).toMatchObject({ code: 0, stdout: "ACAT-WIN-OK" });
  });

  it("响应无 contextId → contextId 缺省(undefined)", async () => {
    const fetchMock = vi.fn(async () => okResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runA2AExecutor({
      url: "http://gw/",
      token: "t",
      prompt: "hello",
    });

    expect(result.contextId).toBeUndefined();
    expect(result).toMatchObject({ code: 0, stdout: "ACAT-WIN-OK" });
  });

  it("非完成状态但 result 含 contextId → 失败 code + contextId 仍返回", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({ contextId: "ctx-failed", state: "failed" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runA2AExecutor({
      url: "http://gw/",
      token: "t",
      prompt: "hello",
    });

    expect(result.code).toBe(1);
    expect(result.contextId).toBe("ctx-failed");
  });
});

describe("runA2AExecutor 结果未确认(第2层)", () => {
  /** 构造 HTTP 响应(默认 200 + JSON-RPC result/error)。 */
  function httpResponse(opts: {
    status?: number;
    payload?: Record<string, unknown> | null;
  }): Response {
    const { status = 200, payload } = opts;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => "",
    } as unknown as Response;
  }

  it("JSON-RPC error「agent did not reply in time」→ unconfirmed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        httpResponse({
          payload: {
            jsonrpc: "1.0",
            id: "1",
            error: { code: -32000, message: "agent did not reply in time" },
          },
        }),
      ),
    );
    const result = await runA2AExecutor({
      url: "http://gw/",
      token: "t",
      prompt: "hello",
    });
    expect(result.code).toBe(1);
    expect(result.unconfirmed).toBe(true);
  });

  it("FAILED 状态但回复是「agent did not reply in time」→ unconfirmed", async () => {
    const fetchMock = vi.fn(async () => okResponse({ state: "failed" }));
    // okResponse 的回复是 "ACAT-WIN-OK";构造一个回复含未回复文案的响应。
    const didNotReply = {
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: "1.0",
        id: "1",
        result: {
          message: {
            role: "participant",
            parts: [{ kind: "text", text: "[agent did not reply in time]" }],
          },
          state: { state: "failed" },
        },
      }),
      text: async () => "",
    };
    fetchMock.mockResolvedValueOnce(didNotReply);
    vi.stubGlobal("fetch", fetchMock);

    const result = await runA2AExecutor({
      url: "http://gw/",
      token: "t",
      prompt: "hello",
    });
    expect(result.code).toBe(1);
    expect(result.unconfirmed).toBe(true);
  });

  it("HTTP 5xx → unconfirmed;HTTP 4xx 不标记", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => httpResponse({ status: 500, payload: null })),
    );
    const five = await runA2AExecutor({
      url: "http://gw/",
      token: "t",
      prompt: "hello",
    });
    expect(five.code).toBe(500);
    expect(five.unconfirmed).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => httpResponse({ status: 400, payload: null })),
    );
    const four = await runA2AExecutor({
      url: "http://gw/",
      token: "t",
      prompt: "hello",
    });
    expect(four.code).toBe(400);
    expect(four.unconfirmed).toBeUndefined();
  });

  it("网络错误(fetch 抛非 abort 异常)→ unconfirmed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 192.168.31.180:9900");
      }),
    );
    const result = await runA2AExecutor({
      url: "http://gw/",
      token: "t",
      prompt: "hello",
    });
    expect(result.code).toBe(1);
    expect(result.unconfirmed).toBe(true);
  });

  it("外部 signal 中止 → timedOut(与内部超时取并集)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      ),
    );
    const controller = new AbortController();
    const promise = runA2AExecutor({
      url: "http://gw/",
      token: "t",
      prompt: "hello",
      signal: controller.signal,
    });
    controller.abort();
    const result = await promise;
    expect(result.timedOut).toBe(true);
  });
});
