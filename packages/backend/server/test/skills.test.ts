import { describe, expect, it } from "vitest";
import { createTestApp } from "./app";

describe("GET /api/skills", () => {
  const app = createTestApp();

  it("返回 4 个 skill,每个含 name/description/path,reviewer 带非空描述", async () => {
    const res = await app.request("/api/skills");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(4);
    const names = body.items.map((i: any) => i.name).sort();
    expect(names).toEqual(["bugfix", "coordinator", "executor", "reviewer"]);
    for (const item of body.items) {
      expect(typeof item.name).toBe("string");
      expect(typeof item.description).toBe("string");
      expect(item.path).toMatch(/^skills\/[^/]+\/SKILL\.md$/);
    }
    const reviewer = body.items.find((i: any) => i.name === "reviewer");
    expect(reviewer.description.length).toBeGreaterThan(0);
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

  it("获取 reviewer skill 返回 200 且 content 非空", async () => {
    const res = await app.request("/api/skills/reviewer");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("reviewer");
    expect(typeof body.content).toBe("string");
    expect(body.content.length).toBeGreaterThan(0);
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
