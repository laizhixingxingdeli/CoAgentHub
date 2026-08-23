import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./app";

/**
 * GET /api/skills 的目录解析回归:曾写死「模块路径上溯 5 级 = 仓库根」,
 * 该假设只在源码布局 (src/routes/skills.ts) 成立;打包成 dist/server.mjs 后
 * 深度少两级,上溯 5 级落到仓库父目录 → 找不到 skills/ → 全线 500。
 * 这里断言列表与单个 skill 都能读到,防止解析方式再退回固定层数。
 */
const app = createTestApp();

describe("GET /api/skills 目录解析", () => {
  it("列出四个内置 skill,且带 description", async () => {
    const res = await app.request("/api/skills");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ name: string; description: string; path: string }>;
    };
    expect(body.items.map((i) => i.name).sort()).toEqual([
      "bugfix",
      "coordinator",
      "executor",
      "reviewer",
    ]);
    // description 取自 SKILL.md 的 frontmatter,空串说明读到了文件但解析失败。
    for (const item of body.items) {
      expect(item.description.length).toBeGreaterThan(0);
    }
  });

  it("按名取回单个 skill 的正文", async () => {
    const res = await app.request("/api/skills/executor");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; content: string };
    expect(body.name).toBe("executor");
    expect(body.content).toContain("description:");
  });

  it("未知 skill 返回 404 而不是 500", async () => {
    const res = await app.request("/api/skills/nope");
    expect(res.status).toBe(404);
  });

  it("解析出的 skills 目录真实存在", async () => {
    const { SKILLS_DIR } = await import("../src/routes/skills");
    expect(existsSync(SKILLS_DIR)).toBe(true);
  });
});
