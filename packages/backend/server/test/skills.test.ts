import { describe, expect, it } from "vitest";
import { createTestApp } from "./app";

describe("GET /api/skills", () => {
  const app = createTestApp();

  it("返回 3 个 skill,每个含 name/description/path", async () => {
    const res = await app.request("/api/skills");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(3);
    const names = body.items.map((i: any) => i.name).sort();
    expect(names).toEqual(["bugfix", "coordinator", "executor"]);
    for (const item of body.items) {
      expect(typeof item.name).toBe("string");
      expect(typeof item.description).toBe("string");
      expect(item.path).toMatch(/^skills\/[^/]+\/SKILL\.md$/);
    }
  });
});

describe("GET /api/skills/:name", () => {
  const app = createTestApp();

  it("获取存在的 skill 返回 name + content", async () => {
    const res = await app.request("/api/skills/executor");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("executor");
    expect(typeof body.content).toBe("string");
    expect(body.content).toContain("CoAgentHub Executor");
  });

  it("不存在的 name 返回 404", async () => {
    const res = await app.request("/api/skills/nonexistent");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("路径穿越尝试返回 404(白名单拒绝)", async () => {
    const res = await app.request("/api/skills/..%2f..%2fetc%2fpasswd");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
  });
});
