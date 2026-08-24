import { describe, expect, it } from "vitest";
import { createTestApp } from "./app";

describe("GET /api/system/health", () => {
  const app = createTestApp();

  it("返回纯文本 ok(默认 Accept)", async () => {
    const res = await app.request("/api/system/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("Accept: application/json 时返回 JSON", async () => {
    const res = await app.request("/api/system/health", {
      headers: { Accept: "application/json" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("/api/health 返回运行时新鲜度字段", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      startedAt: string;
      entryMtime: string | null;
      stale: boolean;
    };
    expect(typeof body.startedAt).toBe("string");
    expect(typeof body.entryMtime).toBe("string");
    expect(body.stale).toBe(false);
  });
});
